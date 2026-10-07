import { describe, expect, test, vi } from "vitest";
import type { Requests } from "../../requests";
import { bitmapToBase64, PrintersApi, type PrintJob } from "./printers";

function mockRequests() {
  const ok = { status: 200, error: false, data: {}, response: {} };
  const http = {
    get: vi.fn().mockResolvedValue(ok),
    post: vi.fn().mockResolvedValue(ok),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { http, api: new PrintersApi(http as unknown as Requests) };
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

describe("PrintersApi", () => {
  test("list issues GET /printers", async () => {
    const { http, api } = mockRequests();
    await api.list();
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith({ url: "/api/v1/printers" });
    expect(http.post).not.toHaveBeenCalled();
  });

  test("print posts a label job to /printers/{id}/print", async () => {
    const { http, api } = mockRequests();
    const job: PrintJob = { kind: "label", labelType: "item", id: "11111111-2222-3333-4444-555555555555" };
    await api.print("abc-123", job);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledWith({ url: "/api/v1/printers/abc-123/print", body: job });
    expect(http.get).not.toHaveBeenCalled();
  });

  test("print posts a bitmap job body unchanged", async () => {
    const { http, api } = mockRequests();
    const job: PrintJob = { kind: "bitmap", width: 384, height: 2, data: bitmapToBase64(new Uint8Array(96)) };
    await api.print("p1", job);
    expect(http.post).toHaveBeenCalledWith({ url: "/api/v1/printers/p1/print", body: job });
  });
});

describe("bitmapToBase64", () => {
  test("encodes the empty array", () => {
    expect(bitmapToBase64(new Uint8Array(0))).toBe("");
  });

  test("matches known encoding", () => {
    expect(bitmapToBase64(new Uint8Array([0, 1, 2, 255]))).toBe("AAEC/w==");
  });

  test("round-trips every byte value", () => {
    const input = new Uint8Array(256 * 3);
    for (let i = 0; i < input.length; i++) {
      input[i] = i % 256;
    }
    expect(decodeBase64(bitmapToBase64(input))).toEqual(input);
  });

  test("handles large bitmaps without overflowing the stack", () => {
    const input = new Uint8Array((384 * 4000) / 8);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 31 + 7) & 0xff;
    }
    const encoded = bitmapToBase64(input);
    expect(encoded.length).toBe(Math.ceil(input.length / 3) * 4);
    expect(decodeBase64(encoded)).toEqual(input);
  });

  test("decoded length equals width*height/8 for a rendered-size bitmap", () => {
    // Same shape as the cat-printer page: 384 wide, padding 20, 3 lines of 48px * 1.2.
    const width = 384;
    const height = Math.ceil(20 * 2 + 3 * 48 * 1.2);
    const bits = new Uint8Array(Math.ceil((width * height) / 8));
    bits.fill(0xaa);
    const decoded = decodeBase64(bitmapToBase64(bits));
    expect(decoded.length).toBe((width * height) / 8);
  });
});
