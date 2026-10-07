import { route } from "../lib/api/base";
import { BLACK_THRESHOLD, PRINTER_WIDTH, QUIET_ZONE_ROWS, rgbaToBits, type LabelBitmap } from "./use-cat-printer";

export type LabelType = "item" | "location" | "asset";

export const LABEL_TYPES: readonly LabelType[] = ["item", "location", "asset"];

export function isLabelType(v: unknown): v is LabelType {
  return typeof v === "string" && (LABEL_TYPES as readonly string[]).includes(v);
}

// Same URL LabelMaker uses for its Bluetooth path (getLabelUrl(false)).
export function labelUrl(labelType: LabelType, id: string): string {
  if (!isLabelType(labelType)) {
    throw new Error(`Unexpected labelmaker type ${labelType}`);
  }
  return route(`/labelmaker/${labelType}/${encodeURIComponent(id)}`, { print: false });
}

// Render the label PNG into a 1-bit bitmap sized exactly for the print head.
export async function labelToBitmap(labelType: LabelType, id: string): Promise<LabelBitmap> {
  // Fetch through the app origin so the session cookie authenticates the request.
  // The SDK loads images with crossOrigin="anonymous", which strips that cookie.
  const res = await fetch(labelUrl(labelType, id), { credentials: "include" });
  if (!res.ok) {
    throw new Error(`failed to load label: ${res.status}`);
  }

  const objectUrl = URL.createObjectURL(await res.blob());
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("failed to decode label image"));
      img.src = objectUrl;
    });

    // Never upscale past the head width, and never resample a label that already
    // fits: resampling blurs the QR module edges and the threshold pass then eats them.
    const scale = Math.min(1, PRINTER_WIDTH / img.width);
    const drawWidth = Math.round(img.width * scale);
    const drawHeight = Math.round(img.height * scale);
    const height = drawHeight + QUIET_ZONE_ROWS * 2;

    const canvas = document.createElement("canvas");
    canvas.width = PRINTER_WIDTH;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas 2d context unavailable");
    }

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Inset vertically so the QR code keeps the quiet zone a scanner needs.
    ctx.drawImage(img, 0, QUIET_ZONE_ROWS, drawWidth, drawHeight);

    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height,
      data: rgbaToBits(new Uint32Array(rgba.data.buffer), BLACK_THRESHOLD),
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
