import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();
const OUT_DIR = join(ROOT, "dist", "public");

async function buildWeb() {
  await mkdir(OUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "web", "index.html"), join(ROOT, "src", "web", "login.html")],
    outdir: OUT_DIR,
    minify: false,
    sourcemap: "none",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bun build failed");
  }

  // Brand assets are referenced statically (favicon); ship them with the bundle.
  await cp(join(ROOT, "assets", "brand"), join(OUT_DIR, "assets", "brand"), { recursive: true });

  console.log(`Built web bundle -> ${OUT_DIR}`);
}

await buildWeb();