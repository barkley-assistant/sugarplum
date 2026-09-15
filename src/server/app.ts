import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join, normalize } from "node:path";
import { hashPassword } from "./auth/passwords";
import { RateLimiter } from "./auth/rate-limit";
import { sweepExpiredSessions } from "./auth/sessions";
import type { Config } from "./config";
import { openDatabase } from "./db/db";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { imageRoutes } from "./routes/images";
import { userRoutes } from "./routes/users";
import { wishlistRoutes } from "./routes/wishlist";
import { createEnrichmentQueue } from "./jobs/enrich";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "dist", "public");

export interface App {
  server: ReturnType<typeof Bun.serve>;
  db: Database;
  config: Config;
  stop: () => Promise<void>;
}

export function createApp(config: Config): App {
  const db = openDatabase(config.dbPath);
  ensureBootstrapAdmin(db, config);
  sweepExpiredSessions(db);

  // Crash sweep: anything left 'pending' by a previous process (kill -9,
  // reboot mid-enrichment) degrades to 'failed' so it is visibly incomplete
  // rather than stuck; the owner refresh route re-drives it.
  db.run(
    `UPDATE wishlist_items SET fetch_state = 'failed',
            last_fetch_error = 'Interrupted by restart' WHERE fetch_state = 'pending'`,
  );

  const limiter = new RateLimiter();
  const queue = createEnrichmentQueue({
    db,
    imagesDir: config.imagesDir,
    userAgent: config.scraperUserAgent,
    searxngUrl: config.searxngUrl,
    maxConcurrent: config.maxEnrichConcurrency,
    // SSRF guard: production readConfig never sets allowPrivateFetch, so the
    // default is guarded; only an explicit test/operator opt-in disables it.
    allowPrivate: config.allowPrivateFetch ?? false,
  });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    routes: {
      ...authRoutes(db, config, limiter),
      ...userRoutes(db),
      ...wishlistRoutes(db, config.imagesDir, queue),
      ...imageRoutes(db, config.imagesDir),
      ...healthRoutes(),
    },
    fetch: (req) => handleNonApiRequest(req),
  });

  return {
    server,
    db,
    config,
    async stop() {
      queue.stop();
      await server.stop(true);
      db.close();
    },
  };
}

/** Idempotent first-boot seed: creates the env-configured admin when the
 *  users table has no admin at all. Never overwrites an existing user. */
function ensureBootstrapAdmin(db: Database, config: Config): void {
  const adminCount = db.query("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get() as {
    n: number;
  };
  if (adminCount.n > 0) return;

  const existing = db
    .query("SELECT id, is_admin FROM users WHERE username = ?")
    .get(config.adminUsername) as { id: string; is_admin: number } | undefined;
  if (existing) {
    console.warn(
      `SUGARPLUM_ADMIN_USERNAME "${config.adminUsername}" exists but is not an admin; ` +
        "skipping bootstrap (user management is in-app).",
    );
    return;
  }

  db.run(
    `INSERT INTO users (id, username, display_name, password_hash, is_admin)
     VALUES (?, ?, ?, ?, 1)`,
    [randomUUID(), config.adminUsername, config.adminDisplayName, hashPassword(config.adminPassword)],
  );
}

/** Serves the built SPA from dist/public. Unknown /api/* paths get a JSON
 *  404; anything else that isn't a known static file is a plain 404. */
async function handleNonApiRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Explicit static map. /add is the wave-3 Web Share Target seam: it only
  // renders the shell; the app then requires login as usual and prefills the
  // add-item form from ?url= / ?title=.
  let relative: string;
  if (url.pathname === "/") relative = "index.html";
  else if (url.pathname === "/login") relative = "login.html";
  else if (url.pathname === "/add") relative = "index.html";
  else relative = url.pathname.slice(1);

  if (!relative || relative.includes("..")) {
    return new Response("Not found", { status: 404 });
  }

  const resolved = normalize(join(PUBLIC_DIR, relative));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file);
}