import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LabelBitmap } from "./use-cat-printer";
import {
  CONNECTION_LOST_ERROR,
  decodeBitmapJob,
  parseServerMessage,
  PrinterHost,
  type SocketLike,
} from "./use-printer-host";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: any[] = [];
  closed = false;
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }

  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function deferred<T = void>() {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>(resolve => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

const fakeBitmap: LabelBitmap = { width: 8, height: 1, data: new Uint8Array([0xff]) };

function setup(overrides: Partial<ConstructorParameters<typeof PrinterHost>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const printBitmap = vi.fn<[LabelBitmap], Promise<void>>(() => Promise.resolve());
  const renderLabel = vi.fn<[string, string], Promise<LabelBitmap>>(() => Promise.resolve(fakeBitmap));
  const host = new PrinterHost({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    printBitmap,
    renderLabel,
    reconnectDelayMs: 3000,
    ...overrides,
  });
  return { host, sockets, printBitmap, renderLabel };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parseServerMessage", () => {
  test("parses known messages", () => {
    expect(parseServerMessage('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseServerMessage('{"type":"registered","printerId":"p1"}')).toEqual({
      type: "registered",
      printerId: "p1",
    });
    expect(parseServerMessage('{"type":"job","jobId":"j1","job":{"kind":"label"}}')).toEqual({
      type: "job",
      jobId: "j1",
      job: { kind: "label" },
    });
  });

  test("rejects malformed input", () => {
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
    expect(parseServerMessage('{"type":"weird"}')).toBeNull();
    expect(parseServerMessage('{"type":"job"}')).toBeNull();
    expect(parseServerMessage('{"type":"registered"}')).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });
});

describe("decodeBitmapJob", () => {
  test("decodes valid base64 payload", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const bm = decodeBitmapJob({ width: 16, height: 2, data: b64(data) });
    expect(bm.width).toBe(16);
    expect(bm.height).toBe(2);
    expect(Array.from(bm.data)).toEqual([1, 2, 3, 4]);
  });

  test("validates width, height and length", () => {
    const four = b64(new Uint8Array(4));
    expect(() => decodeBitmapJob({ width: 12, height: 2, data: four })).toThrow(/width/);
    expect(() => decodeBitmapJob({ width: 392, height: 1, data: four })).toThrow(/width/);
    expect(() => decodeBitmapJob({ width: 0, height: 1, data: four })).toThrow(/width/);
    expect(() => decodeBitmapJob({ width: 16, height: 0, data: four })).toThrow(/height/);
    expect(() => decodeBitmapJob({ width: 16, height: 1.5, data: four })).toThrow(/height/);
    expect(() => decodeBitmapJob({ width: 16, height: 3, data: four })).toThrow(/length/);
    expect(() => decodeBitmapJob({ width: 16, height: 2, data: "!!!" })).toThrow(/base64/);
    expect(() => decodeBitmapJob({ width: 16, height: 2 })).toThrow(/base64/);
    expect(decodeBitmapJob({ width: 384, height: 1, data: b64(new Uint8Array(48)) }).data.length).toBe(48);
  });
});

describe("PrinterHost", () => {
  test("registers on open and records printer id; ping ignored", () => {
    const { host, sockets, printBitmap } = setup();
    host.start("MX06");
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(sockets[0].sent).toEqual([{ type: "register", name: "MX06" }]);

    sockets[0].receive({ type: "registered", printerId: "p-1" });
    expect(host.getStatus()).toMatchObject({ sharing: true, connected: true, printerId: "p-1" });

    sockets[0].receive({ type: "ping" });
    sockets[0].receive("garbage");
    expect(sockets[0].sent).toHaveLength(1);
    expect(printBitmap).not.toHaveBeenCalled();
  });

  test("label job is rendered, printed and reported ok", async () => {
    const { host, sockets, printBitmap, renderLabel } = setup();
    host.start("MX06");
    sockets[0].open();
    sockets[0].receive({ type: "job", jobId: "j1", job: { kind: "label", labelType: "item", id: "abc" } });
    await host.idle();

    expect(renderLabel).toHaveBeenCalledWith("item", "abc");
    expect(printBitmap).toHaveBeenCalledWith(fakeBitmap);
    expect(sockets[0].sent[1]).toEqual({ type: "result", jobId: "j1", ok: true });
    expect(host.getStatus().jobsPrinted).toBe(1);
  });

  test("bitmap job is decoded and printed", async () => {
    const { host, sockets, printBitmap } = setup();
    host.start("MX06");
    sockets[0].open();
    sockets[0].receive({
      type: "job",
      jobId: "j1",
      job: { kind: "bitmap", width: 8, height: 2, data: b64(new Uint8Array([0x0f, 0xf0])) },
    });
    await host.idle();

    expect(printBitmap).toHaveBeenCalledTimes(1);
    const bm = printBitmap.mock.calls[0][0];
    expect(bm).toMatchObject({ width: 8, height: 2 });
    expect(Array.from(bm.data)).toEqual([0x0f, 0xf0]);
    expect(sockets[0].sent[1]).toEqual({ type: "result", jobId: "j1", ok: true });
  });

  test("failures always produce ok:false results", async () => {
    const { host, sockets, printBitmap } = setup();
    printBitmap.mockRejectedValueOnce(new Error("out of paper"));
    host.start("MX06");
    sockets[0].open();
    const s = sockets[0];
    s.receive({ type: "job", jobId: "j1", job: { kind: "label", labelType: "item", id: "abc" } });
    s.receive({ type: "job", jobId: "j2", job: { kind: "sticker" } });
    s.receive({ type: "job", jobId: "j3", job: { kind: "bitmap", width: 8, height: 4, data: b64(new Uint8Array(1)) } });
    s.receive({ type: "job", jobId: "j4", job: { kind: "label", labelType: "box", id: "abc" } });
    s.receive({ type: "job", jobId: "j5" });
    await host.idle();

    const results = s.sent.slice(1);
    expect(results).toEqual([
      { type: "result", jobId: "j1", ok: false, error: "out of paper" },
      { type: "result", jobId: "j2", ok: false, error: "unknown job kind: sticker" },
      { type: "result", jobId: "j3", ok: false, error: expect.stringMatching(/length/) },
      { type: "result", jobId: "j4", ok: false, error: "unknown label type: box" },
      { type: "result", jobId: "j5", ok: false, error: "missing print job" },
    ]);
    expect(printBitmap).toHaveBeenCalledTimes(1);
    expect(host.getStatus()).toMatchObject({ jobsPrinted: 0, jobsFailed: 5, lastError: "missing print job" });
  });

  test("jobs run strictly one at a time", async () => {
    const first = deferred();
    const order: string[] = [];
    const { host, sockets, printBitmap } = setup();
    printBitmap
      .mockImplementationOnce(async () => {
        order.push("start1");
        await first.promise;
        order.push("end1");
      })
      .mockImplementationOnce(() => {
        order.push("start2");
        return Promise.resolve();
      });

    host.start("MX06");
    sockets[0].open();
    const job = { kind: "label", labelType: "item", id: "x" };
    sockets[0].receive({ type: "job", jobId: "j1", job });
    sockets[0].receive({ type: "job", jobId: "j2", job });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(["start1"]);
    expect(host.getStatus().busy).toBe(true);
    expect(sockets[0].sent).toHaveLength(1);

    first.resolve();
    await host.idle();
    expect(order).toEqual(["start1", "end1", "start2"]);
    expect(sockets[0].sent.slice(1).map(m => m.jobId)).toEqual(["j1", "j2"]);
    expect(host.getStatus().busy).toBe(false);
  });

  test("reconnects after 3s and re-registers", () => {
    vi.useFakeTimers();
    const { host, sockets } = setup();
    host.start("MX06");
    sockets[0].open();
    sockets[0].receive({ type: "registered", printerId: "p-1" });

    sockets[0].serverClose();
    expect(host.getStatus()).toMatchObject({ sharing: true, connected: false, printerId: null });

    vi.advanceTimersByTime(2999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    expect(sockets[1].sent).toEqual([{ type: "register", name: "MX06" }]);
    expect(host.getStatus().lastError).toBe(CONNECTION_LOST_ERROR);
    sockets[1].receive({ type: "registered", printerId: "p-2" });
    expect(host.getStatus()).toMatchObject({ printerId: "p-2", lastError: null });
  });

  test("jobs from a dead socket are not printed or reported on the new one", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const { host, sockets, printBitmap } = setup();
    printBitmap.mockImplementationOnce(() => first.promise);
    host.start("MX06");
    sockets[0].open();
    const job = { kind: "label", labelType: "item", id: "x" };
    sockets[0].receive({ type: "job", jobId: "j1", job });
    sockets[0].receive({ type: "job", jobId: "j2", job });
    await vi.advanceTimersByTimeAsync(0);

    sockets[0].serverClose();
    await vi.advanceTimersByTimeAsync(3000);
    sockets[1].open();

    first.resolve();
    await host.idle();
    expect(printBitmap).toHaveBeenCalledTimes(1);
    expect(sockets[1].sent).toEqual([{ type: "register", name: "MX06" }]);

    sockets[1].receive({ type: "job", jobId: "j3", job });
    await host.idle();
    expect(sockets[1].sent[1]).toEqual({ type: "result", jobId: "j3", ok: true });
  });

  test("stop unregisters, closes and does not reconnect", () => {
    vi.useFakeTimers();
    const { host, sockets } = setup();
    host.start("MX06");
    sockets[0].open();
    host.stop();

    expect(sockets[0].sent).toEqual([{ type: "register", name: "MX06" }, { type: "unregister" }]);
    expect(sockets[0].closed).toBe(true);
    expect(host.getStatus()).toMatchObject({ sharing: false, connected: false });

    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
  });

  test("stop with error surfaces it", () => {
    const onStatus = vi.fn();
    const { host } = setup({ onStatus });
    host.start("MX06");
    host.stop("Printer disconnected");
    expect(host.getStatus()).toMatchObject({ sharing: false, lastError: "Printer disconnected" });
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ lastError: "Printer disconnected" }));
  });

  test("queued jobs are dropped after stop", async () => {
    const first = deferred();
    const { host, sockets, printBitmap } = setup();
    printBitmap.mockImplementationOnce(() => first.promise);
    host.start("MX06");
    sockets[0].open();
    const job = { kind: "label", labelType: "item", id: "x" };
    sockets[0].receive({ type: "job", jobId: "j1", job });
    sockets[0].receive({ type: "job", jobId: "j2", job });
    await new Promise(resolve => setTimeout(resolve, 0));
    host.stop();
    first.resolve();
    await host.idle();
    expect(printBitmap).toHaveBeenCalledTimes(1);
  });
});
