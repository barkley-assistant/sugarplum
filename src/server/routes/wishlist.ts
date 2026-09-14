import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { jsonError, jsonOk, requireSession, type RouteRequest } from "../auth/middleware";
import { deleteItemFile } from "../images";
import type { EnrichmentQueue } from "../jobs/enrich";
import type { CommonItem, OwnedItem, PublicItem, WishlistSummaryRow } from "../../shared/types";

interface ItemRow {
  id: string;
  user_id: string;
  title: string;
  url: string | null;
  image_path: string | null;
  price_cents: number | null;
  currency: string | null;
  notes: string | null;
  tags: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  fetch_state: "pending" | "complete" | "failed";
  last_fetch_error: string | null;
  site_name: string | null;
  hint_price_cents: number | null;
  hint_currency: string | null;
  hint_source_url: string | null;
}

interface SummaryRow {
  user_id: string;
  display_name: string;
  item_count: number;
  claimed_count: number;
}

/** Decimal string ("24.99") → integer cents (2499). Rejects negatives and
 *  anything that is not a whole or 1-2 decimal place number. */
export function parsePriceInput(value: unknown): { ok: true; cents: number } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false };
  const [whole, frac = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return { ok: true, cents };
}

export function formatPrice(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function commonItem(row: ItemRow): CommonItem {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    imagePath: row.image_path,
    priceCents: row.price_cents === null ? null : formatPrice(row.price_cents),
    currency: row.currency,
    notes: row.notes,
    tags: parseTags(row.tags),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    fetchState: row.fetch_state,
    siteName: row.site_name,
  };
}

/** Owner view: NO claim fields, ever. Hint fields are owner data. */
function toOwnedItem(row: ItemRow): OwnedItem {
  return {
    ...commonItem(row),
    updatedAt: row.updated_at,
    hintPriceCents: row.hint_price_cents === null ? null : formatPrice(row.hint_price_cents),
    hintCurrency: row.hint_currency,
    hintSourceUrl: row.hint_source_url,
  };
}

/** Non-owner view: booleans only; claimant identity is never exposed. */
function toPublicItem(row: ItemRow, viewerId: string): PublicItem {
  return {
    ...commonItem(row),
    claimed: row.claimed_by !== null,
    claimedByYou: row.claimed_by === viewerId,
  };
}

const ITEM_SELECT = `
  SELECT id, user_id, title, url, image_path, price_cents, currency, notes, tags,
         sort_order, created_at, updated_at, claimed_by, claimed_at,
         fetch_state, last_fetch_error, site_name, hint_price_cents, hint_currency, hint_source_url
  FROM wishlist_items`;

function getItem(db: Database, id: string): ItemRow | undefined {
  return db.query(`${ITEM_SELECT} WHERE id = ?`).get(id) as ItemRow | undefined;
}

function parseTagsInput(value: unknown): { ok: true; tags: string[] } | { ok: false } {
  if (value === undefined) return { ok: true, tags: [] };
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string")) return { ok: false };
  return { ok: true, tags: value };
}

export function wishlistRoutes(db: Database, imagesDir: string, queue: EnrichmentQueue) {
  return {
    "/api/users/:id/wishlist": {
      GET: requireSession(db, (req, viewer) => {
        const owner = db
          .query("SELECT id, display_name FROM users WHERE id = ?")
          .get(req.params.id) as { id: string; display_name: string } | undefined;
        if (!owner) return jsonError(404, "User not found");

        const rows = db
          .query(`${ITEM_SELECT} WHERE user_id = ? ORDER BY sort_order, created_at`)
          .all(req.params.id) as ItemRow[];

        // The invariant: when the viewer IS the owner, claim fields are
        // projected OUT (OwnedItem has no claim fields at all).
        if (viewer.id === req.params.id) {
          return jsonOk(rows.map(toOwnedItem));
        }
        return jsonOk(rows.map((row) => toPublicItem(row, viewer.id)));
      }),
    },
    "/api/wishlist/items": {
      POST: requireSession(db, async (req, viewer) => {
        const parsed = await parseItemBody(req);
        if (!parsed.ok) return parsed.error;

        const id = randomUUID();
        db.run(
          `INSERT INTO wishlist_items
             (id, user_id, title, url, price_cents, currency, notes, tags, fetch_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            viewer.id,
            parsed.title,
            parsed.url,
            parsed.priceCents,
            parsed.currency,
            parsed.notes,
            parsed.tags.length ? JSON.stringify(parsed.tags) : null,
            parsed.hasUrl ? "pending" : "complete",
          ],
        );
        if (parsed.hasUrl) queue.enqueue(id);
        return jsonOk(toOwnedItem(getItem(db, id) as ItemRow), 201);
      }),
    },
    "/api/wishlist/items/:id": {
      PATCH: requireSession(db, async (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id !== viewer.id) return jsonError(403, "Only the owner can edit this item");

        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonError(400, "Invalid JSON body");
        }

        const sets: string[] = [];
        const values: (string | number | null)[] = [];

        if (body.title !== undefined) {
          if (typeof body.title !== "string" || !body.title.trim()) {
            return jsonError(400, "title must be a non-empty string");
          }
          sets.push("title = ?");
          values.push(body.title.trim());
        }
        if (body.url !== undefined) {
          if (body.url !== null && typeof body.url !== "string") {
            return jsonError(400, "url must be a string or null");
          }
          sets.push("url = ?");
          values.push(body.url);
        }
        if (body.priceCents !== undefined) {
          const parsed = parsePriceInput(body.priceCents);
          if (!parsed.ok) return jsonError(400, "priceCents must be a decimal string like \"24.99\"");
          sets.push("price_cents = ?");
          values.push(parsed.cents);
        }
        if (body.currency !== undefined) {
          if (body.currency !== null && (typeof body.currency !== "string" || !body.currency.trim())) {
            return jsonError(400, "currency must be a string or null");
          }
          sets.push("currency = ?");
          values.push(body.currency === null ? null : body.currency.trim().toUpperCase());
        }
        if (body.notes !== undefined) {
          if (body.notes !== null && typeof body.notes !== "string") {
            return jsonError(400, "notes must be a string or null");
          }
          sets.push("notes = ?");
          values.push(body.notes);
        }
        if (body.tags !== undefined) {
          const parsed = parseTagsInput(body.tags);
          if (!parsed.ok) return jsonError(400, "tags must be an array of strings");
          sets.push("tags = ?");
          values.push(parsed.tags.length ? JSON.stringify(parsed.tags) : null);
        }
        if (body.sortOrder !== undefined) {
          if (typeof body.sortOrder !== "number" || !Number.isInteger(body.sortOrder)) {
            return jsonError(400, "sortOrder must be an integer");
          }
          sets.push("sort_order = ?");
          values.push(body.sortOrder);
        }

        if (sets.length > 0) {
          sets.push("updated_at = ?");
          values.push(new Date().toISOString());
          db.run(`UPDATE wishlist_items SET ${sets.join(", ")} WHERE id = ?`, [...values, item.id]);
        }
        return jsonOk(toOwnedItem(getItem(db, item.id) as ItemRow));
      }),
      DELETE: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id !== viewer.id) return jsonError(403, "Only the owner can delete this item");
        deleteItemFile(imagesDir, item.image_path);
        db.run("DELETE FROM wishlist_items WHERE id = ?", [item.id]);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/wishlist/items/:id/refresh": {
      POST: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id !== viewer.id) return jsonError(403, "Only the owner can refresh this item");
        if (!item.url) return jsonError(400, "This item has no link to fetch");
        // Hints are kept until new evidence replaces them.
        db.run(
          `UPDATE wishlist_items SET fetch_state = 'pending', last_fetch_error = NULL, updated_at = ?
           WHERE id = ?`,
          [new Date().toISOString(), item.id],
        );
        queue.enqueue(item.id);
        return jsonOk(toOwnedItem(getItem(db, item.id) as ItemRow), 202);
      }),
    },
    "/api/wishlist/items/:id/claim": {
      POST: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id === viewer.id) return jsonError(400, "Cannot claim your own item");
        if (item.claimed_by !== null) {
          if (item.claimed_by === viewer.id) return jsonOk(toPublicItem(item, viewer.id));
          return jsonError(409, "Item is already claimed");
        }
        db.run("UPDATE wishlist_items SET claimed_by = ?, claimed_at = ? WHERE id = ?", [
          viewer.id,
          new Date().toISOString(),
          item.id,
        ]);
        return jsonOk(toPublicItem(getItem(db, item.id) as ItemRow, viewer.id));
      }),
    },
    "/api/wishlist/items/:id/unclaim": {
      POST: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.claimed_by === null) return jsonOk(toPublicItem(item, viewer.id));
        if (item.claimed_by !== viewer.id) return jsonError(403, "Only the claimant can unclaim");
        db.run("UPDATE wishlist_items SET claimed_by = NULL, claimed_at = NULL WHERE id = ?", [item.id]);
        return jsonOk(toPublicItem(getItem(db, item.id) as ItemRow, viewer.id));
      }),
    },
    "/api/wishlist/summary": {
      GET: requireSession(db, (_req) => {
        const rows = db
          .query(
            `SELECT u.id AS user_id, u.display_name AS display_name,
                    COUNT(i.id) AS item_count,
                    SUM(CASE WHEN i.claimed_by IS NOT NULL THEN 1 ELSE 0 END) AS claimed_count
             FROM users u
             LEFT JOIN wishlist_items i ON i.user_id = u.id
             GROUP BY u.id
             ORDER BY u.username`,
          )
          .all() as SummaryRow[];
        const summary: WishlistSummaryRow[] = rows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          itemCount: Number(row.item_count),
          claimedCount: Number(row.claimed_count ?? 0),
        }));
        return jsonOk(summary);
      }),
    },
  };
}

async function parseItemBody(
  req: RouteRequest,
): Promise<
  | { ok: true; title: string; url: string | null; hasUrl: boolean; priceCents: number | null; currency: string | null; notes: string | null; tags: string[] }
  | { ok: false; error: Response }
> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: jsonError(400, "Invalid JSON body") };
  }

  const urlParsed = parseUrlInput(body.url);
  if (!urlParsed.ok) return urlParsed;
  const url = urlParsed.url;
  const hasUrl = url !== null;

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    if (!hasUrl) return { ok: false, error: jsonError(400, "title or a valid url is required") };
    // Provisional title sentinel: hostname sans www. Enrichment overwrites it
    // only when the current value still equals this sentinel.
    return finalizeItemBody(body, provisionalTitle(url as string), url, true);
  }
  return finalizeItemBody(body, title, url, hasUrl);
}

function parseUrlInput(value: unknown): { ok: true; url: string | null } | { ok: false; error: Response } {
  if (value === undefined || value === null) return { ok: true, url: null };
  if (typeof value !== "string") return { ok: false, error: jsonError(400, "url must be a string or null") };
  const url = value.trim();
  if (!url) return { ok: true, url: null };
  if (url.length > 2048) return { ok: false, error: jsonError(400, "url is too long (max 2048 characters)") };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: jsonError(400, "url must be a valid http(s) URL") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: jsonError(400, "url must be http(s)") };
  }
  if (!parsed.hostname.includes(".")) {
    return { ok: false, error: jsonError(400, "url must have a valid hostname") };
  }
  return { ok: true, url };
}

function provisionalTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url; // unreachable — parseUrlInput already validated the URL
  }
}

function finalizeItemBody(
  body: Record<string, unknown>,
  title: string,
  url: string | null,
  hasUrl: boolean,
):
  | { ok: true; title: string; url: string | null; hasUrl: boolean; priceCents: number | null; currency: string | null; notes: string | null; tags: string[] }
  | { ok: false; error: Response } {
  let priceCents: number | null = null;
  if (body.priceCents !== undefined && body.priceCents !== null) {
    const parsed = parsePriceInput(body.priceCents);
    if (!parsed.ok) {
      return { ok: false, error: jsonError(400, "priceCents must be a decimal string like \"24.99\"") };
    }
    priceCents = parsed.cents;
  }

  if (body.currency !== undefined && body.currency !== null) {
    if (typeof body.currency !== "string" || !body.currency.trim()) {
      return { ok: false, error: jsonError(400, "currency must be a string or null") };
    }
  }
  const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : null;

  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
    return { ok: false, error: jsonError(400, "notes must be a string or null") };
  }
  const notes = typeof body.notes === "string" ? body.notes : null;

  const tagsParsed = parseTagsInput(body.tags);
  if (!tagsParsed.ok) return { ok: false, error: jsonError(400, "tags must be an array of strings") };

  return { ok: true, title, url, hasUrl, priceCents, currency, notes, tags: tagsParsed.tags };
}