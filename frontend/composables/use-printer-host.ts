import { effectScope, reactive, readonly, watch } from "vue";
import { PRINTER_WIDTH, useCatPrinter, type LabelBitmap } from "./use-cat-printer";
import { isLabelType, labelToBitmap, type LabelType } from "./use-label-bitmap";

// ---------------------------------------------------------------------------
// Protocol (shared with the backend relay at GET /api/v1/ws/printers)
// ---------------------------------------------------------------------------

export type LabelPrintJob = { kind: "label"; labelType: LabelType; id: string };
export type BitmapPrintJob = { kind: "bitmap"; width: number; height: number; data: string };
export type PrintJob = LabelPrintJob | BitmapPrintJob;

export type HostToServerMessage =
  | { type: "register"; name: string }
  | { type: "unregister" }
  | { type: "result"; jobId: string; ok: boolean; error?: string };

export type ServerToHostMessage =
  | { type: "registered"; printerId: string }
  | { type: "job"; jobId: string; job: unknown }
  | { type: "ping" };

/** Parse a raw server frame. Returns null for anything malformed or unknown. */
export function parseServerMessage(raw: unknown): ServerToHostMessage | null {
  if (typeof raw !== "string") return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "registered":
      return typeof m.printerId === "string" ? { type: "registered", printerId: m.printerId } : null;
    case "job":
      return typeof m.jobId === "string" && m.jobId !== "" ? { type: "job", jobId: m.jobId, job: m.job } : null;
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error("bitmap data is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Validate a bitmap job and decode its base64 payload (rgbaToBits format). */
export function decodeBitmapJob(job: { width?: unknown; height?: unknown; data?: unknown }): LabelBitmap {
  const { width, height, data } = job;
  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0 || width % 8 !== 0 || width > PRINTER_WIDTH) {
    throw new Error(
      `invalid bitmap width: ${String(width)} (must be a positive multiple of 8, at most ${PRINTER_WIDTH})`
    );
  }
  if (typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
    throw new Error(`invalid bitmap height: ${String(height)}`);
  }
  if (typeof data !== "string") {
    throw new TypeError("bitmap data must be a base64 string");
  }
  const bytes = base64ToBytes(data);
  const expected = (width * height) / 8;
  if (bytes.length !== expected) {
    throw new Error(
      `bitmap data length ${bytes.length} does not match ${width}x${height} (expected ${expected} bytes)`
    );
  }
  return { width, height, data: bytes };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "unknown error";
}

// ---------------------------------------------------------------------------
// Pure host core: socket lifecycle + strictly sequential job queue.
// No BLE / browser globals here so it can be unit tested.
// ---------------------------------------------------------------------------

/** Minimal subset of WebSocket used by the host. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
}

const SOCKET_OPEN = 1;

export const CONNECTION_LOST_ERROR = "Connection to server lost; reconnecting";

export type PrinterHostStatus = {
  sharing: boolean;
  connected: boolean;
  printerId: string | null;
  printerName: string | null;
  jobsPrinted: number;
  jobsFailed: number;
  busy: boolean;
  lastError: string | null;
};

export type PrinterHostDeps = {
  createSocket: () => SocketLike;
  printBitmap: (bitmap: LabelBitmap) => Promise<void>;
  renderLabel: (labelType: LabelType, id: string) => Promise<LabelBitmap>;
  reconnectDelayMs?: number;
  onStatus?: (status: PrinterHostStatus) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: any) => void;
};

export class PrinterHost {
  private socket: SocketLike | null = null;
  private reconnectTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  // Bumped on every start/stop so stale sockets, timers and queued jobs are ignored.
  private generation = 0;
  private readonly status: PrinterHostStatus = {
    sharing: false,
    connected: false,
    printerId: null,
    printerName: null,
    jobsPrinted: 0,
    jobsFailed: 0,
    busy: false,
    lastError: null,
  };

  private readonly deps: PrinterHostDeps;

  constructor(deps: PrinterHostDeps) {
    this.deps = deps;
  }

  getStatus(): PrinterHostStatus {
    return { ...this.status };
  }

  /** Resolves once every job queued so far has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  start(name: string): void {
    this.stop();
    this.generation++;
    this.status.sharing = true;
    this.status.printerName = name;
    this.status.lastError = null;
    this.emit();
    this.connect(this.generation);
  }

  /** Stop sharing: unregister, close the socket and drop pending jobs. */
  stop(error?: string): void {
    const wasSharing = this.status.sharing;
    this.generation++;
    this.clearReconnect();
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      if (ws.readyState === SOCKET_OPEN) {
        this.rawSend(ws, { type: "unregister" });
      }
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.status.sharing = false;
    this.status.connected = false;
    this.status.printerId = null;
    if (error !== undefined) {
      this.status.lastError = error;
    }
    if (wasSharing || error !== undefined) {
      this.emit();
    }
  }

  private connect(gen: number): void {
    let ws: SocketLike;
    try {
      ws = this.deps.createSocket();
    } catch (err) {
      this.status.lastError = errorMessage(err);
      this.emit();
      this.scheduleReconnect(gen);
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      if (gen !== this.generation) return;
      this.status.connected = true;
      this.emit();
      this.rawSend(ws, { type: "register", name: this.status.printerName ?? "" });
    };

    ws.onclose = () => {
      if (gen !== this.generation) return;
      this.socket = null;
      this.status.connected = false;
      this.status.printerId = null;
      this.status.lastError = CONNECTION_LOST_ERROR;
      this.emit();
      this.scheduleReconnect(gen);
    };

    ws.onerror = err => {
      console.error("printer host websocket error", err);
    };

    ws.onmessage = ev => {
      if (gen !== this.generation || ws !== this.socket) return;
      this.handleMessage(ws, ev.data);
    };
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation) return;
    this.clearReconnect();
    const set = this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.reconnectTimer = set(() => {
      this.reconnectTimer = null;
      if (gen !== this.generation || !this.status.sharing) return;
      this.connect(gen);
    }, this.deps.reconnectDelayMs ?? 3000);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      const clear = this.deps.clearTimeout ?? ((h: any) => clearTimeout(h));
      clear(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleMessage(ws: SocketLike, raw: unknown): void {
    const msg = parseServerMessage(raw);
    if (!msg) {
      console.warn("printer host: ignoring unrecognised message", raw);
      return;
    }
    switch (msg.type) {
      case "ping":
        return;
      case "registered":
        this.status.printerId = msg.printerId;
        if (this.status.lastError === CONNECTION_LOST_ERROR) {
          this.status.lastError = null;
        }
        this.emit();
        return;
      case "job":
        this.enqueue(ws, msg.jobId, msg.job);
    }
  }

  // Jobs are bound to the socket they arrived on: the result can only be
  // reported there, so a job whose socket died (stop, restart or reconnect)
  // before it started is dropped rather than printed with nowhere to report.
  private enqueue(ws: SocketLike, jobId: string, job: unknown): void {
    this.queue = this.queue.then(() => this.runJob(ws, jobId, job));
  }

  private async runJob(ws: SocketLike, jobId: string, job: unknown): Promise<void> {
    if (ws !== this.socket) return;

    this.status.busy = true;
    this.emit();
    let result: HostToServerMessage;
    try {
      const bitmap = await this.resolveBitmap(job);
      await this.deps.printBitmap(bitmap);
      this.status.jobsPrinted++;
      result = { type: "result", jobId, ok: true };
    } catch (err) {
      const message = errorMessage(err);
      console.error("printer host: job failed", jobId, err);
      this.status.jobsFailed++;
      this.status.lastError = message;
      result = { type: "result", jobId, ok: false, error: message };
    } finally {
      this.status.busy = false;
    }
    this.send(ws, result);
    this.emit();
  }

  private resolveBitmap(job: unknown): Promise<LabelBitmap> {
    if (!job || typeof job !== "object") {
      return Promise.reject(new Error("missing print job"));
    }
    const j = job as Record<string, unknown>;
    switch (j.kind) {
      case "label":
        if (!isLabelType(j.labelType)) {
          return Promise.reject(new Error(`unknown label type: ${String(j.labelType)}`));
        }
        if (typeof j.id !== "string" || j.id === "") {
          return Promise.reject(new Error("label job is missing an id"));
        }
        return this.deps.renderLabel(j.labelType, j.id);
      case "bitmap":
        return Promise.resolve().then(() => decodeBitmapJob(j));
      default:
        return Promise.reject(new Error(`unknown job kind: ${String(j.kind)}`));
    }
  }

  private send(ws: SocketLike, msg: HostToServerMessage): void {
    if (ws !== this.socket || ws.readyState !== SOCKET_OPEN) {
      console.warn("printer host: job socket closed, dropping message", msg);
      return;
    }
    this.rawSend(ws, msg);
  }

  private rawSend(ws: SocketLike, msg: HostToServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("printer host: send failed", err);
    }
  }

  private emit(): void {
    this.deps.onStatus?.(this.getStatus());
  }
}

// ---------------------------------------------------------------------------
// Browser singleton: survives page navigation for the life of the tab.
// ---------------------------------------------------------------------------

export function printerSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = import.meta.dev ? window.location.host.replace("3000", "7745") : window.location.host;
  return `${protocol}://${host}/api/v1/ws/printers`;
}

type HostSingleton = {
  host: PrinterHost;
  status: PrinterHostStatus;
  cat: ReturnType<typeof useCatPrinter>;
};

let singleton: HostSingleton | null = null;

function getSingleton(): HostSingleton {
  if (singleton) return singleton;

  const cat = useCatPrinter();
  const status = reactive<PrinterHostStatus>({
    sharing: false,
    connected: false,
    printerId: null,
    printerName: null,
    jobsPrinted: 0,
    jobsFailed: 0,
    busy: false,
    lastError: null,
  });

  const host = new PrinterHost({
    createSocket: () => new WebSocket(printerSocketUrl()),
    // Fail fast instead of letting connectPrinter() open the device picker,
    // which needs a user gesture and would throw an opaque SecurityError.
    printBitmap: bitmap => {
      if (!cat.printer.value) {
        return Promise.reject(new Error("Printer not connected"));
      }
      return cat.printJobBitmap(bitmap);
    },
    renderLabel: labelToBitmap,
    onStatus: s => Object.assign(status, s),
  });

  // If the BLE link drops, the host can no longer print; stop advertising it.
  // Detached scope so the watcher outlives whichever component first used the host.
  effectScope(true).run(() => {
    watch(
      () => cat.printer.value,
      p => {
        if (p === null && status.sharing) {
          host.stop("Printer disconnected");
        }
      }
    );
  });

  singleton = { host, status, cat };
  return singleton;
}

export function usePrinterHost() {
  const s = getSingleton();

  /** Connect the BLE printer (needs a user gesture) and start sharing it. */
  async function startSharing(): Promise<void> {
    const printer = await s.cat.connectPrinter();
    s.host.start(printer.model || "Cat printer");
  }

  function stopSharing(): void {
    s.host.stop();
  }

  return {
    status: readonly(s.status),
    startSharing,
    stopSharing,
  };
}
