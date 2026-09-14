import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();
const PORT = process.env.SUGARPLUM_PORT ?? "3499";
const HOST = process.env.SUGARPLUM_HOST ?? "127.0.0.1";

// Plain-HTTP LAN dev (phone testing) needs the Secure cookie flag stripped.
const devEnv: Record<string, string | undefined> = {
  ...process.env,
  SUGARPLUM_DEV: process.env.SUGARPLUM_DEV ?? "1",
};

// The server, watched by bun --watch (restarts on server-module changes).
const server = spawn("bun", ["--watch", "src/server/index.ts"], {
  cwd: ROOT,
  env: devEnv,
  stdio: "inherit",
});

// The web bundle is NOT watched by bun --watch; rebuild it when src/web files
// change (debounced so a burst of saves triggers one build).
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let building = false;

function rebuildWeb() {
  if (building) return;
  building = true;
  const child = spawn("bun", ["run", "scripts/build-web.ts"], {
    cwd: ROOT,
    env: devEnv,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    building = false;
    if (code !== 0) console.error("web rebuild failed");
  });
}

watch(join(ROOT, "src", "web"), { recursive: true }, (_event, _filename) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rebuildWeb, 300);
});

console.log(`sugarplum dev: http://${HOST}:${PORT} (Ctrl+C to stop)`);

function shutdown(signal: "SIGINT" | "SIGTERM") {
  console.log(`\nreceived ${signal}, stopping dev server`);
  server.kill(signal);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));