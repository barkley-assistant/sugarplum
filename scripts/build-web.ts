import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
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

  // PWA manifest: the bundler hashes any link it resolves, but the manifest
  // must live at the STABLE URL /manifest.webmanifest (share-target install
  // contract). Copy it verbatim and rewrite the built HTML link back to the
  // canonical absolute path.
  await cp(join(ROOT, "public", "manifest.webmanifest"), join(OUT_DIR, "manifest.webmanifest"));
  for (const page of ["index.html", "login.html"]) {
    const path = join(OUT_DIR, page);
    const html = await readFile(path, "utf8");
    const fixed = html.replace(/\.\/manifest-[a-z0-9]+\.webmanifest/g, "/manifest.webmanifest");
    if (fixed !== html) await writeFile(path, fixed);
  }

  console.log(`Built web bundle -> ${OUT_DIR}`);
}

await buildWeb();