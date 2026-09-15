import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** e2e boots the REAL server on a temp DB + random port over plain http on
 *  127.0.0.1. The web bundle is built in PROD mode so the service worker
 *  registers (spec 11); the SERVER process runs in dev mode so the session
 *  cookie drops the Secure flag (plain-http login would silently fail
 *  otherwise — config.ts cookieSecure: !dev). Local scrape fixtures need the
 *  explicit private-fetch escape hatch. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // Build with PROD baked in: existing env wins over the repo .env.
  await run("bun", ["run", "build:web"], { SUGARPLUM_DEV: "0" });

  const dir = mkdtempSync(join(tmpdir(), "sugarplum-e2e-"));
  const port = await freePort();
  const server = spawn("bun", ["src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      SUGARPLUM_DEV: "1",
      SUGARPLUM_PORT: String(port),
      SUGARPLUM_DB_PATH: join(dir, "db.sqlite"),
      SUGARPLUM_IMAGES_DIR: join(dir, "images"),
      SUGARPLUM_ADMIN_USERNAME: "admin",
      SUGARPLUM_ADMIN_PASSWORD: "admin-password",
      SUGARPLUM_ADMIN_DISPLAY_NAME: "Admin",
      SUGARPLUM_ENRICH_CONCURRENCY: "1",
      SUGARPLUM_ALLOW_PRIVATE_FETCH: "1",
    },
    stdio: "pipe",
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/api/health`);
  process.env.E2E_BASE_URL = baseUrl;

  return async () => {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      server.on("exit", () => {
        clearTimeout(t);
        resolve(null);
      });
    });
    rmSync(dir, { recursive: true, force: true });
  };
}

async function run(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))));
  });
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not become healthy`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}