import { BaseAPI, route } from "../base";

/** A Bluetooth printer shared by another browser in the same group. */
export type SharedPrinter = {
  id: string;
  name: string;
  sharedBy: string;
  connectedAt: string;
};

export type LabelPrintJob = {
  kind: "label";
  labelType: "item" | "location" | "asset";
  id: string;
};

/**
 * A pre-rendered 1-bit bitmap (rgbaToBits output: LSB-first, 1 = black),
 * base64 encoded. width must be a multiple of 8 and at most 384.
 */
export type BitmapPrintJob = {
  kind: "bitmap";
  width: number;
  height: number;
  data: string;
};

export type PrintJob = LabelPrintJob | BitmapPrintJob;

export type PrintResult = {
  ok?: boolean;
  error?: string;
};

// Keep String.fromCharCode argument lists well below engine stack limits.
const BASE64_CHUNK = 0x8000;

/** Base64-encode bytes without spreading the whole array into one call. */
export function bitmapToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + BASE64_CHUNK)));
  }
  return btoa(binary);
}

export class PrintersApi extends BaseAPI {
  list() {
    return this.http.get<SharedPrinter[]>({ url: route("/printers") });
  }

  print(id: string, job: PrintJob) {
    return this.http.post<PrintJob, PrintResult>({ url: route(`/printers/${id}/print`), body: job });
  }
}
