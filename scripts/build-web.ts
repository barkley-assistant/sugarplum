import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateServiceWorker } from "./generate-sw";

const ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();
const OUT_DIR = join(ROOT, "dist", "public");

// Production builds register the service worker; dev (SUGARPLUM_DEV=1, set by
// scripts/dev.ts) must not, so a dev session never fights a stale shell.
const isProd = process.env.SUGARPLUM_DEV !== "1";

async function buildWeb() {
  await mkdir(OUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "web", "index.html")],
    outdir: OUT_DIR,
    minify: false,
    sourcemap: "none",
    // Bun's bundler does not inline import.meta.env on its own; define it so
    // the SPA can gate service-worker registration on production.
    define: { "import.meta.env.PROD": isProd ? "true" : "false" },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bun build failed");
  }

  // Brand assets are referenced statically (favicon); ship them with the bundle.
  await cp(join(ROOT, "assets", "brand"), join(OUT_DIR, "assets", "brand"), { recursive: true });

  // PWA manifest: the bundler hashes any link it resolves, but the manifest
  // must live at the STABLE URL /manifest.webmanifest (share-target install
  // contract). Copy the canonical source verbatim and rewrite the built HTML
  // link back to the absolute path.
  await cp(join(ROOT, "src", "web", "manifest.webmanifest"), join(OUT_DIR, "manifest.webmanifest"));
  for (const page of ["index.html"]) {
    const path = join(OUT_DIR, page);
    const html = await readFile(path, "utf8");
    const fixed = html.replace(/\.\/manifest-[a-z0-9]+\.webmanifest/g, "/manifest.webmanifest");
    if (fixed !== html) await writeFile(path, fixed);
  }

  // One HTML entry now serves every route (the SPA router renders them), so a
  // reused dist must never keep serving the retired login document.
  await rm(join(OUT_DIR, "login.html"), { force: true });

  // Service worker precache must reflect the ACTUAL hashed outputs.
  await generateServiceWorker(OUT_DIR);

  console.log(`Built web bundle -> ${OUT_DIR}`);
}

await buildWeb();