import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { jsonOk, requireSession, type RouteRequest } from "../auth/middleware";
import { RateLimiter } from "../auth/rate-limit";

/**
 * Public share links (wave 10).
 *
 * Owner-only token management lives in this module too, but the anonymous
 * routes (view / purchase / token-scoped image) are the app's only public
 * surface besides login and health — they are deliberately NOT wrapped in
 * requireSession. The owner is still recognized on those routes through an
 * opportunistic session lookup, because the `purchased` flag must be
 * projected OUT of every response the owner can see (the surprise invariant).
 */

export interface ShareRoutesConfig {
  imagesDir: string;
}

/** 32-byte hex, the same entropy class as session tokens. */
function newShareToken(): string {
  return randomBytes(32).toString("hex");
}

/** The share path the client prefixes with its own origin (the server cannot
 *  know its public URL behind the tunnel). */
function sharePath(token: string): string {
  return `/share/${token}`;
}

export function shareRoutes(db: Database, limiter: RateLimiter, _cfg: ShareRoutesConfig) {
  return {
    // --- owner-only token management ---
    "/api/share": {
      GET: requireSession(db, (_req: RouteRequest, viewer) => {
        const row = db
          .query(
            `SELECT token FROM share_tokens WHERE user_id = ? AND revoked_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(viewer.id) as { token: string } | undefined;
        return jsonOk(
          row ? { token: row.token, path: sharePath(row.token) } : { token: null, path: null },
        );
      }),
      POST: requireSession(db, (_req: RouteRequest, viewer) => {
        const now = new Date().toISOString();
        // Rotation, atomically: kill the old link in the same transaction that
        // mints the new one — no window where two links work at once.
        db.transaction(() => {
          db.run(`UPDATE share_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [
            now,
            viewer.id,
          ]);
          db.run(`INSERT INTO share_tokens (token, user_id) VALUES (?, ?)`, [
            newShareToken(),
            viewer.id,
          ]);
        })();
        const row = db
          .query(
            `SELECT token FROM share_tokens WHERE user_id = ? AND revoked_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(viewer.id) as { token: string };
        return jsonOk({ token: row.token, path: sharePath(row.token) }, 201);
      }),
      DELETE: requireSession(db, (_req: RouteRequest, viewer) => {
        db.run(`UPDATE share_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [
          new Date().toISOString(),
          viewer.id,
        ]);
        return new Response(null, { status: 204 });
      }),
    },
  };
}
