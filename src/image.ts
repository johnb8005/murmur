// Pictures attached to a murmur are shrunk in the browser before upload: phones hand over 3 to 12 MB
// photos, the card shows them at 600 px wide. The long side is capped, JPEG for photos; PNG stays
// PNG when small enough (screenshots of text look better that way); GIFs pass through untouched.

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_SIDE = 2000;
const PNG_KEEP_BYTES = 2 * 1024 * 1024;

export interface PreparedImage {
  file: File;
  width: number;
  height: number;
  /** object URL for a thumbnail; revoke it when done */
  previewUrl: string;
}

const decode = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("that file is not a picture this browser can read"));
    };
    img.src = url;
  });

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the picture"))), type, quality));

export const prepareImage = async (file: File): Promise<PreparedImage> => {
  if (file.type === "image/gif") {
    if (file.size > IMAGE_MAX_BYTES) throw new Error("that GIF is over 10 MB");
    const img = await decode(file);
    return { file, width: img.naturalWidth, height: img.naturalHeight, previewUrl: URL.createObjectURL(file) };
  }
  const img = await decode(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const keepPng = file.type === "image/png" && scale === 1 && file.size <= PNG_KEEP_BYTES;
  if (keepPng || (file.type === "image/jpeg" && scale === 1 && file.size <= 600 * 1024)) {
    return { file, width, height, previewUrl: URL.createObjectURL(file) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(img, 0, 0, width, height);
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  let blob = await encode(canvas, type, 0.86);
  if (type === "image/png" && blob.size > PNG_KEEP_BYTES) blob = await encode(canvas, "image/jpeg", 0.86);
  const ext = blob.type === "image/png" ? "png" : "jpg";
  const out = new File([blob], file.name.replace(/\.[^.]+$/, "") + "." + ext, { type: blob.type });
  return { file: out, width, height, previewUrl: URL.createObjectURL(out) };
};
