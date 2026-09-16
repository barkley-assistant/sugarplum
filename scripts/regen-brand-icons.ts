// Regenerate the PWA icon family from assets/brand/sugarplum-icon.png.
// Run: `bun run scripts/regen-brand-icons.ts`
// Requires: ImageMagick 7 (`convert`) on PATH.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();
const SRC = join(ROOT, "assets", "brand", "sugarplum-icon.png");
const OUT = join(ROOT, "assets", "brand", "pwa");

async function run(args: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd: ["convert", ...args], stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`convert failed (${code}): ${err}`);
}

async function resize(out: string, size: number): Promise<void> {
  // Lanczos downscale; the source is 1254x1254 so this is always a downscale.
  await run([SRC, "-resize", `${size}x${size}`, "-filter", "Lanczos", out]);
}

async function maskable(out: string, size: number): Promise<void> {
  // Maskable safe zone: content within central ~80%. The source icon already
  // fills ~50% of the frame (plum centred on solid bg), so we scale to 80%
  // and pad with the source's own background colour (#151021) to the full size.
  const inner = Math.round(size * 0.8);
  await run([
    SRC, "-resize", `${inner}x${inner}`, "-filter", "Lanczos",
    "-background", "#151021", "-gravity", "center", "-extent", `${size}x${size}`,
    out,
  ]);
}

async function appleTouch(out: string, size: number): Promise<void> {
  // iOS applies its own rounded-corner mask; ship a clean square. No rounded
  // corners, no alpha — flatten onto the source background so the PNG is
  // opaque RGB (some iOS versions render alpha edges oddly).
  await run([
    SRC, "-resize", `${size}x${size}`, "-filter", "Lanczos",
    "-background", "#151021", "-alpha", "remove", out,
  ]);
}

await mkdir(OUT, { recursive: true });
await resize(join(OUT, "favicon-16.png"), 16);
await resize(join(OUT, "favicon-32.png"), 32);
await resize(join(OUT, "icon-192.png"), 192);
await resize(join(OUT, "icon-512.png"), 512);
await maskable(join(OUT, "icon-maskable-512.png"), 512);
await appleTouch(join(OUT, "apple-touch-icon.png"), 180);
console.log("Regenerated PWA icons in", OUT);
