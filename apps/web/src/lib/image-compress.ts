"use client";

/** What gets uploaded for a picked file: the file itself, plus an image's pixel size and whether it is the HD original. */
export type PreparedUpload = { file: File; width?: number; height?: number; hd?: true };

// Standard quality fits a photo inside 1080p, either way round: at most 1920 px on the long side and 1080 px on the short one.
const LONG_SIDE = 1920;
const SHORT_SIDE = 1080;
const QUALITY = 0.8;
// Smaller than this and already within 1080p: not worth re-encoding.
const SMALL_ENOUGH = 200 * 1024;

export const isCompressibleImage = (type: string) => /^image\/(png|jpeg|webp)$/.test(type);

/** An animated PNG has an acTL chunk before its image data; an animated WebP sets the animation flag in its VP8X header. */
async function animated(file: File): Promise<boolean> {
  if (file.type !== "image/png" && file.type !== "image/webp") return false;
  const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  if (file.type === "image/webp") return text.slice(12, 16) === "VP8X" && (bytes[20]! & 0x02) !== 0;
  const control = text.indexOf("acTL");
  return control !== -1 && (text.indexOf("IDAT") === -1 || control < text.indexOf("IDAT"));
}

async function decode(file: File): Promise<ImageBitmap | null> {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    try { return await createImageBitmap(file); } catch { return null; }
  }
}

const encode = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, QUALITY));
const renamed = (name: string, extension: string) => `${name.replace(/\.[^./\\]+$/, "") || "image"}.${extension}`;

/**
 * Like WhatsApp: by default a photo shrinks to fit 1080p and becomes WebP (JPEG where the browser can't write WebP), which
 * also drops its location and other metadata. HD sends the original untouched. Animations (GIF, animated PNG or WebP) are kept, and anything
 * that wouldn't come out meaningfully smaller is sent as it is.
 */
export async function prepareUpload(file: File, { hd }: { hd: boolean }): Promise<PreparedUpload> {
  if (!file.type.startsWith("image/")) return { file };
  const bitmap = await decode(file);
  if (!bitmap) return { file };
  const { width, height } = bitmap;
  const original: PreparedUpload = { file, width, height, ...(hd && isCompressibleImage(file.type) ? { hd: true as const } : {}) };
  const scale = Math.min(1, LONG_SIDE / Math.max(width, height), SHORT_SIDE / Math.min(width, height));
  if (hd || !isCompressibleImage(file.type) || (scale === 1 && file.size <= SMALL_ENOUGH) || await animated(file)) { bitmap.close(); return original; }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) { bitmap.close(); return original; }
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob = await encode(canvas, "image/webp");
  if (blob?.type !== "image/webp") {
    // This browser can't write WebP (Safari). Photos become JPEG; a PNG or WebP may be transparent, so it stays as it is.
    if (file.type !== "image/jpeg") return original;
    blob = await encode(canvas, "image/jpeg");
  }
  if (!blob || blob.size >= file.size * 0.9) return original;
  const type = blob.type === "image/webp" ? "image/webp" : "image/jpeg";
  return { file: new File([blob], renamed(file.name, type === "image/webp" ? "webp" : "jpg"), { type, lastModified: file.lastModified }), width: canvas.width, height: canvas.height };
}
