/**
 * Local product-image download + serving. Sniff order: the Content-Type
 * header first, magic bytes as the arbiter — a lying header (image/png over a
 * captcha HTML body) must never get saved, so the body is always consulted.
 * 5MB cap, graceful null on any failure (never throws).
 */

import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isPrivateLiteralUrl, finalUrlIsPrivate } from "./net/private-ip";
import type { SearxngFetch as FetchLike } from "./searxng";

export interface ImageDeps {
  imagesDir: string;
  fetchImpl?: FetchLike;
  maxBytes?: number;
  timeoutMs?: number;
  /** Explicit opt-in to allow private/loopback targets (tests use local
   *  Bun.serve servers on 127.0.0.1). Never a silent global. */
  allowPrivate?: boolean;
}

const MAX_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function matchesMagic(ext: string, bytes: Uint8Array): boolean {
  switch (ext) {
    case "png":
      return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case "jpg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "webp":
      return (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && // R
        bytes[1] === 0x49 && // I
        bytes[2] === 0x46 && // F
        bytes[3] === 0x46 && // F
        bytes[8] === 0x57 && // W
        bytes[9] === 0x45 && // E
        bytes[10] === 0x42 && // B
        bytes[11] === 0x50 // P
      );
    case "gif":
      return bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
    default:
      return false;
  }
}

function sniffMagic(bytes: Uint8Array): string | null {
  for (const ext of Object.keys(EXT_CONTENT_TYPE)) {
    if (matchesMagic(ext, bytes)) return ext;
  }
  return null;
}

/** Downloads an image, sniffs it, and stores it as "<itemId>.<ext>" inside
 *  imagesDir. Returns the stored filename or null — never throws. */
export async function downloadImage(url: string, itemId: string, deps: ImageDeps): Promise<string | null> {
  const imagesDir = deps.imagesDir;
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // SSRF guard: same private/loopback rule as the scraper. Literal private
  // host → null before any network I/O; after the fetch the FINAL url is
  // re-checked (redirect targets). Skipped only by the explicit allowPrivate
  // opt-in. downloadImage never throws — private targets are just null.
  if (!deps.allowPrivate && isPrivateLiteralUrl(url)) return null;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  if (!deps.allowPrivate && (await finalUrlIsPrivate(res.url || url))) return null;

  const declared = CONTENT_TYPE_EXT[(res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()];
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;

  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res, maxBytes);
  } catch {
    return null;
  }
  if (bytes === null) return null;

  const ext = declared && matchesMagic(declared, bytes) ? declared : sniffMagic(bytes);
  if (!ext) return null;

  mkdirSync(imagesDir, { recursive: true });
  const filename = `${itemId}.${ext}`;
  await Bun.write(join(imagesDir, filename), bytes);
  return filename;
}

/** Reads the response body up to maxBytes+1; null when the cap is exceeded. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Serves the item's stored image. The filename comes from the DB row, never
 *  the request URL — traversal-proof by construction (both paths resolved so
 *  the guard also holds for relative imagesDir values like the default). */
export async function serveItemImage(db: Database, imagesDir: string, id: string): Promise<Response> {
  const row = db
    .query("SELECT image_path FROM wishlist_items WHERE id = ?")
    .get(id) as { image_path: string | null } | undefined;
  if (!row || !row.image_path) return new Response("Not found", { status: 404 });

  const root = resolve(imagesDir);
  const filePath = resolve(imagesDir, row.image_path);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  const ext = row.image_path.split(".").pop() ?? "";
  const contentType = EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";
  return new Response(file, {
    headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=86400" },
  });
}

/** Best-effort unlink of a stored image (item DELETE cleanup). Never throws —
 *  an orphaned file is harmless, and wishlist.ts stays free of fs imports. */
export function deleteItemFile(imagesDir: string, imagePath: string | null): void {
  if (!imagePath) return;
  try {
    unlinkSync(resolve(imagesDir, imagePath));
  } catch {
    // ignore — file may already be gone
  }
}