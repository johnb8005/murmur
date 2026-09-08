// Cloudflare R2 (S3 API) holds the preview images. Turso keeps the row, R2 keeps
// the bytes: libsql rows are a poor place for a few hundred KB of jpeg each.
//
// The bucket stays private. Images are served back through /previews/<hash>.jpg
// by the server, so nothing depends on the bucket having a public domain.

import { S3Client } from "bun";

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;

/** null when R2 is not configured, e.g. local dev — callers fall back to Turso blobs. */
export const r2 =
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET
    ? new S3Client({
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
        bucket: R2_BUCKET,
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      })
    : null;

export const r2Enabled = () => r2 !== null;

/** Store bytes, returning the key, or null if R2 is off or the write failed. */
export const putImage = async (key: string, bytes: Uint8Array, type: string): Promise<string | null> => {
  if (!r2) return null;
  try {
    await r2.write(key, bytes, { type });
    return key;
  } catch (e) {
    console.error(`r2 put ${key} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
};

export const getImage = async (key: string): Promise<{ bytes: Uint8Array; type: string } | null> => {
  if (!r2) return null;
  try {
    const f = r2.file(key);
    const buf = await f.arrayBuffer();
    return { bytes: new Uint8Array(buf), type: f.type || "image/jpeg" };
  } catch {
    return null;
  }
};

export const deleteImage = async (key: string): Promise<void> => {
  if (!r2) return;
  await r2.delete(key).catch(() => {});
};
