import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { ShareItem, ShareView } from "../../shared/types";
import {
  jsonError,
  jsonOk,
  parseCookies,
  requireSession,
  type RouteRequest,
} from "../auth/middleware";
import { RateLimiter } from "../auth/rate-limit";
import { SESSION_COOKIE, getSessionUser, type SessionUser } from "../auth/sessions";
import { formatPrice, parseTags } from "./wishlist";

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

interface ShareItemRow {
  id: string;
  title: string;
  url: string | null;
  image_path: string | null;
  price_cents: number | null;
  currency: string | null;
  notes: string | null;
  tags: string | null;
  site_name: string | null;
  purchased: number;
  sort_order: number;
  created_at: string;
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

/** Active-token → owner row. Unknown, revoked, and deactivated-owner are all
 *  undefined — callers translate that to an identical 404 (no status oracle). */
export function shareOwner(db: Database, token: string): { user_id: string } | undefined {
  return db
    .query(
      `SELECT st.user_id AS user_id
         FROM share_tokens st JOIN users u ON u.id = st.user_id
        WHERE st.token = ? AND st.revoked_at IS NULL AND u.is_active = 1`,
    )
    .get(token) as { user_id: string } | undefined;
}

/** Optional session: the anonymous routes must never 401, but they must
 *  recognize the OWNER (the Lax cookie rides along on same-site requests) so
 *  the purchased flag can be projected out. Null for missing/expired/
 *  deactivated — exactly requireSession's lookup, minus the rejection. */
function optionalSessionUser(db: Database, req: RouteRequest): SessionUser | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];
  return token ? getSessionUser(db, token) : null;
}

/** The share surface transmits no claim, hint, provenance or internal
 *  fields — only the columns below are ever read. */
const SHARE_ITEM_SELECT = `
  SELECT id, title, url, image_path, price_cents, currency, notes, tags, site_name,
         purchased, sort_order, created_at
    FROM wishlist_items`;

function toShareItem(row: ShareItemRow, hidePurchased: boolean): ShareItem {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    priceCents: row.price_cents === null ? null : formatPrice(row.price_cents),
    currency: row.currency,
    notes: row.notes,
    tags: parseTags(row.tags),
    siteName: row.site_name,
    hasImage: row.image_path !== null,
    // THE INVARIANT: the owner's copy of the share view carries purchased:
    // false even when the row says 1. Server-side projection, not client
    // hiding — and `purchased_at` is never serialized anywhere.
    purchased: hidePurchased ? false : row.purchased === 1,
  };
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

    // --- anonymous (public) routes: no requireSession ---
    "/api/share/:token": {
      GET: (req: RouteRequest) => {
        const owner = shareOwner(db, req.params.token);
        if (!owner) return jsonError(404, "Share link not found");

        const user = db
          .query("SELECT display_name FROM users WHERE id = ?")
          .get(owner.user_id) as { display_name: string };
        const rows = db
          .query(`${SHARE_ITEM_SELECT} WHERE user_id = ? ORDER BY sort_order, created_at`)
          .all(owner.user_id) as ShareItemRow[];

        const viewer = optionalSessionUser(db, req);
        const viewerIsOwner = viewer?.id === owner.user_id;
        return jsonOk({
          ownerDisplayName: user.display_name,
          viewerIsOwner,
          items: rows.map((row) => toShareItem(row, viewerIsOwner)),
        } satisfies ShareView);
      },
    },
  };
}
