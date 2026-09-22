import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { jsonError, jsonOk, requireSession, type RouteRequest } from "../auth/middleware";
import { deleteItemFile } from "../images";
import type { EnrichmentQueue } from "../jobs/enrich";
import { deriveTrend } from "../price/trend";
import { searchPriceCandidates } from "../searxng";
import type {
  CommonItem,
  OwnedItem,
  PriceHintsResponse,
  PricePoint,
  PriceStats,
  PriceTrend,
  PublicItem,
  WishlistSummaryRow,
} from "../../shared/types";

interface ItemRow {
  id: string;
  user_id: string;
  title: string;
  url: string | null;
  image_path: string | null;
  image_source: string | null;
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
  price_source: string | null;
  cheaper_url: string | null;
  owner_purchased: number;
  owner_purchased_at: string | null;
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

export function parseTags(value: string | null): string[] {
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
    imageSource: row.image_source,
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
function toOwnedItem(db: Database, row: ItemRow, seriesCap: number): OwnedItem {
  return {
    ...commonItem(row),
    updatedAt: row.updated_at,
    ownerPurchased: row.owner_purchased === 1,
    hintPriceCents: row.hint_price_cents === null ? null : formatPrice(row.hint_price_cents),
    hintCurrency: row.hint_currency,
    hintSourceUrl: row.hint_source_url,
    priceSource: row.price_source,
    cheaperUrl: row.cheaper_url,
    priceStats: priceStatsFor(db, row.id, seriesCap),
  };
}

/** Default cap for the 90-day series when the route is constructed without
 *  one (matches the production config default). */
export const DEFAULT_SERIES_CAP = 90;

/** Lowest + earliest price observation for one item, plus the capped 90-day
 *  series and the server-derived trend. Three tiny indexed reads per item:
 *  the ledger is append-only and per-item rows are few. Null when the item
 *  has no history at all (a freshly added manual item with no price). */
export function priceStatsFor(db: Database, itemId: string, seriesCap: number = DEFAULT_SERIES_CAP): PriceStats | null {
  const lowest = db
    .query(
      `SELECT price_cents, currency, observed_at FROM price_history WHERE item_id = ?
       ORDER BY price_cents ASC, observed_at ASC, rowid ASC LIMIT 1`,
    )
    .get(itemId) as { price_cents: number; currency: string | null; observed_at: string } | undefined;
  if (!lowest) return null;

  const earliest = db
    .query(
      `SELECT price_cents, currency FROM price_history WHERE item_id = ?
       ORDER BY observed_at ASC, rowid ASC LIMIT 1`,
    )
    .get(itemId) as { price_cents: number; currency: string | null } | undefined;

  const since90d = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const rows = db
    .query(
      `SELECT observed_at, price_cents, currency FROM price_history
       WHERE item_id = ? AND observed_at >= ?
       ORDER BY observed_at ASC, rowid ASC LIMIT ?`,
    )
    .all(itemId, since90d, Math.max(1, Math.floor(seriesCap))) as {
    observed_at: string;
    price_cents: number;
    currency: string | null;
  }[];

  const series: PricePoint[] = rows.map((r) => ({
    observedAt: r.observed_at,
    priceCents: formatPrice(r.price_cents),
    currency: r.currency,
  }));

  // A mixed-currency series is not a comparable series: return the history
  // shape but no signal (same rule as priceDelta on the client).
  // deltaFromAvgCents stays server-side: the client renders the advice
  // label, not the number.
  const currencies = new Set(rows.map((r) => (r.currency ?? "").trim().toUpperCase()));
  const derived =
    currencies.size > 1
      ? null
      : deriveTrend(
          rows.map((r) => ({ observedAt: r.observed_at, priceCents: r.price_cents })),
          new Date(),
        );
  const trend: PriceTrend | null = derived
    ? { direction: derived.direction, advice: derived.advice, daysSinceDrop: derived.daysSinceDrop }
    : null;

  return {
    lowestCents: formatPrice(lowest.price_cents),
    lowestCurrency: lowest.currency,
    lowestSeenAt: lowest.observed_at,
    atAddCents: earliest ? formatPrice(earliest.price_cents) : null,
    atAddCurrency: earliest?.currency ?? null,
    series,
    trend,
  };
}

/** A user-entered price is recorded twice: as the item's provenance
 *  ('manual') and as an append-only history observation. Manual prices are
 *  never overwritten by a re-check (enrich.ts owns that rule). */
function recordManualPrice(db: Database, itemId: string, cents: number, currency: string | null): void {
  db.run("UPDATE wishlist_items SET price_source = 'manual' WHERE id = ?", [itemId]);
  db.run(
    `INSERT INTO price_history (id, item_id, price_cents, currency, source, observed_at)
     VALUES (?, ?, ?, ?, 'manual', ?)`,
    [randomUUID(), itemId, cents, currency, new Date().toISOString()],
  );
}

/** Hostname slug used to skip a candidate on the item's own site (the
 *  searxng module's exclusion rule, mirrored for the route's input). */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The viewer's honesty gate (users.hints_enabled). Missing row/value = on. */
function hintsDisabledFor(db: Database, userId: string): boolean {
  const row = db.query("SELECT hints_enabled FROM users WHERE id = ?").get(userId) as
    | { hints_enabled: number }
    | undefined;
  return row ? row.hints_enabled === 0 : false;
}

/** Non-owner view: booleans only; claimant identity is never exposed. The
 *  price ledger summary (#130) is a product fact, not owner data — the
 *  anonymous share DTO already ships it, and the two feeds must agree. */
function toPublicItem(db: Database, row: ItemRow, viewerId: string): PublicItem {
  return {
    ...commonItem(row),
    claimed: row.claimed_by !== null,
    claimedByYou: row.claimed_by === viewerId,
    priceStats: priceStatsFor(db, row.id),
  };
}

const ITEM_SELECT = `
  SELECT id, user_id, title, url, image_path, image_source, price_cents, currency, notes, tags,
         sort_order, created_at, updated_at, claimed_by, claimed_at,
         fetch_state, last_fetch_error, site_name, hint_price_cents, hint_currency, hint_source_url,
         price_source, cheaper_url, owner_purchased, owner_purchased_at
  FROM wishlist_items`;

function getItem(db: Database, id: string): ItemRow | undefined {
  return db.query(`${ITEM_SELECT} WHERE id = ?`).get(id) as ItemRow | undefined;
}

function parseTagsInput(value: unknown): { ok: true; tags: string[] } | { ok: false } {
  if (value === undefined) return { ok: true, tags: [] };
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string")) return { ok: false };
  return { ok: true, tags: value };
}

export interface PriceHintsConfig {
  /** SearXNG base URL; unset → the on-demand candidates route reports 503. */
  searxngUrl?: string;
  /** Max observations in the 90-day series on the owned item; default 90. */
  seriesCap?: number;
}

export function wishlistRoutes(
  db: Database,
  imagesDir: string,
  queue: EnrichmentQueue,
  hints: PriceHintsConfig = {},
) {
  const seriesCap = hints.seriesCap ?? DEFAULT_SERIES_CAP;
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
        // projected OUT (OwnedItem has no claim fields at all). Price history
        // stats and the cheaper link are owner data too.
        if (viewer.id === req.params.id) {
          return jsonOk(rows.map((row) => toOwnedItem(db, row, seriesCap)));
        }
        return jsonOk(rows.map((row) => toPublicItem(db, row, viewer.id)));
      }),
    },
    "/api/wishlist/items": {
      POST: requireSession(db, async (req, viewer) => {
        const parsed = await parseItemBody(req);
        if (!parsed.ok) return parsed.error;

        const id = randomUUID();
        // D17: new items append to the BOTTOM of the list. The max+10 is
        // computed inside the INSERT so two rapid adds can't race to the
        // same value under WAL.
        db.run(
          `INSERT INTO wishlist_items
             (id, user_id, title, url, price_cents, currency, cheaper_url, notes, tags, fetch_state, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM wishlist_items WHERE user_id = ?))`,
          [
            id,
            viewer.id,
            parsed.title,
            parsed.url,
            parsed.priceCents,
            parsed.currency,
            parsed.cheaperUrl,
            parsed.notes,
            parsed.tags.length ? JSON.stringify(parsed.tags) : null,
            parsed.hasUrl ? "pending" : "complete",
            viewer.id,
          ],
        );
        // A price the user typed is a 'manual' observation: it is snapshotted
        // and never overwritten by a re-check.
        if (parsed.priceCents !== null) {
          recordManualPrice(db, id, parsed.priceCents, parsed.currency);
        }
        if (parsed.hasUrl) queue.enqueue(id);
        return jsonOk(toOwnedItem(db, getItem(db, id) as ItemRow, seriesCap), 201);
      }),
    },
    "/api/wishlist/order": {
      PUT: requireSession(db, async (req, viewer) => {
        let body: { itemIds?: unknown };
        try {
          body = (await req.json()) as { itemIds?: unknown };
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        const itemIds = body.itemIds;
        if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === "string" && id.length > 0)) {
          return jsonError(400, "itemIds must be an array of strings");
        }
        if (new Set(itemIds).size !== itemIds.length) {
          return jsonError(400, "itemIds must not contain duplicates");
        }

        // Strict full-list match: catches stale clients, foreign ids, and
        // mid-flight deletes. An empty list is a valid no-op for an empty
        // wishlist.
        const ownedIds = (
          db.query("SELECT id FROM wishlist_items WHERE user_id = ?").all(viewer.id) as { id: string }[]
        ).map((row) => row.id);
        if (itemIds.length !== ownedIds.length) {
          return jsonError(400, "item list does not match your wishlist");
        }
        const ownedSet = new Set(ownedIds);
        if (itemIds.some((id) => !ownedSet.has(id))) {
          return jsonError(400, "item list does not match your wishlist");
        }

        // Single transaction: reassign spacing 10, 20, 30… in the submitted
        // order. The AND user_id is belt-and-braces.
        db.transaction(() => {
          const update = db.query(
            "UPDATE wishlist_items SET sort_order = ? WHERE id = ? AND user_id = ?",
          );
          itemIds.forEach((id, i) => {
            update.run((i + 1) * 10, id, viewer.id);
          });
        })();

        return jsonOk({ ok: true });
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
        if (body.cheaperUrl !== undefined) {
          if (body.cheaperUrl !== null && typeof body.cheaperUrl !== "string") {
            return jsonError(400, "cheaperUrl must be a string or null");
          }
          const parsedCheaper =
            body.cheaperUrl === null ? { ok: true as const, url: null } : parseUrlInput(body.cheaperUrl, "cheaperUrl");
          if (!parsedCheaper.ok) return parsedCheaper.error;
          sets.push("cheaper_url = ?");
          values.push(parsedCheaper.url);
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
        // A PATCHed price is a new manual observation: snapshot it (with the
        // currency the row now carries — the ledger must match the item).
        const updated = getItem(db, item.id) as ItemRow;
        if (body.priceCents !== undefined && updated.price_cents !== null) {
          recordManualPrice(db, item.id, updated.price_cents, updated.currency);
        }
        return jsonOk(toOwnedItem(db, getItem(db, item.id) as ItemRow, seriesCap));
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
    "/api/wishlist/items/:id/purchased": {
      /** Owner-only blind reset of the share-link purchased mark. The route
       *  requires ownership, but 204 with NO body on success: it must never
       *  reveal whether the item was marked, when, or by whom (marking is
       *  anonymous by design — only the boolean + timestamp are stored). */
      DELETE: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id !== viewer.id) {
          return jsonError(403, "Only the owner can reset this item");
        }
        db.run("UPDATE wishlist_items SET purchased = 0, purchased_at = NULL WHERE id = ?", [
          item.id,
        ]);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/wishlist/items/:id/owner-purchased": {
      /** #76: the owner's OWN mark — the mirror of the blind reset above, but
       *  NOT blind: the owner sees their own state through OwnedItem
       *  (ownerPurchased). Like the blind reset it is owner-only and 204 on
       *  clear; PUT returns the full updated OwnedItem so the client can
       *  re-render without a second read. The anonymous share-link flag is
       *  NEVER touched here. */
      PUT: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id !== viewer.id) {
          return jsonError(403, "Only the owner can mark this item");
        }
        // Idempotent: re-PUT on an already-marked row keeps the original
        // owner_purchased_at (mirrors the share route's idempotent re-mark).
        if (item.owner_purchased === 0) {
          db.run(
            "UPDATE wishlist_items SET owner_purchased = 1, owner_purchased_at = ? WHERE id = ? AND owner_purchased = 0",
            [new Date().toISOString(), item.id],
          );
        }
        return jsonOk(toOwnedItem(db, getItem(db, item.id) as ItemRow, seriesCap));
      }),
      DELETE: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id !== viewer.id) {
          return jsonError(403, "Only the owner can unmark this item");
        }
        db.run(
          "UPDATE wishlist_items SET owner_purchased = 0, owner_purchased_at = NULL WHERE id = ?",
          [item.id],
        );
        // 204 mirrors the blind reset's clear semantics (no body needed:
        // the client refreshes from the list read, which carries ownerPurchased).
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
        return jsonOk(toOwnedItem(db, getItem(db, item.id) as ItemRow, seriesCap), 202);
      }),
    },
    "/api/wishlist/items/:id/hints": {
      /** On-demand, owner-only, display-only: up to 3 title-derived price
       *  candidates from SearXNG. Nothing is persisted and nothing here is
       *  verified — the UI labels every row as unverified. */
      POST: requireSession(db, async (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id !== viewer.id) return jsonError(403, "Only the owner can check prices");

        const disabled = hintsDisabledFor(db, viewer.id);
        if (!hints.searxngUrl) {
          if (disabled) return jsonOk({ hints: [], disabled: true } satisfies PriceHintsResponse);
          return jsonError(503, "Price search is not configured");
        }
        if (disabled) return jsonOk({ hints: [], disabled: true } satisfies PriceHintsResponse);

        const candidates = await searchPriceCandidates(item.title, hostOf(item.url), {
          baseUrl: hints.searxngUrl,
        });
        const body: PriceHintsResponse = {
          hints: candidates.map((c) => ({
            priceCents: formatPrice(c.priceCents),
            currency: c.currency,
            sourceUrl: c.sourceUrl,
            sourceTitle: c.sourceTitle,
          })),
          disabled: false,
        };
        return jsonOk(body);
      }),
    },
    "/api/wishlist/items/:id/claim": {
      POST: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.user_id === viewer.id) return jsonError(400, "Cannot claim your own item");
        if (item.claimed_by !== null) {
          if (item.claimed_by === viewer.id) return jsonOk(toPublicItem(db, item, viewer.id));
          return jsonError(409, "Item is already claimed");
        }
        db.run("UPDATE wishlist_items SET claimed_by = ?, claimed_at = ? WHERE id = ?", [
          viewer.id,
          new Date().toISOString(),
          item.id,
        ]);
        return jsonOk(toPublicItem(db, getItem(db, item.id) as ItemRow, viewer.id));
      }),
    },
    "/api/wishlist/items/:id/unclaim": {
      POST: requireSession(db, (req, viewer) => {
        const item = getItem(db, req.params.id);
        if (!item) return jsonError(404, "Item not found");
        if (item.claimed_by === null) return jsonOk(toPublicItem(db, item, viewer.id));
        if (item.claimed_by !== viewer.id) return jsonError(403, "Only the claimant can unclaim");
        db.run("UPDATE wishlist_items SET claimed_by = NULL, claimed_at = NULL WHERE id = ?", [item.id]);
        return jsonOk(toPublicItem(db, getItem(db, item.id) as ItemRow, viewer.id));
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
  | { ok: true; title: string; url: string | null; hasUrl: boolean; priceCents: number | null; currency: string | null; cheaperUrl: string | null; notes: string | null; tags: string[] }
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

function parseUrlInput(
  value: unknown,
  field = "url",
): { ok: true; url: string | null } | { ok: false; error: Response } {
  if (value === undefined || value === null) return { ok: true, url: null };
  if (typeof value !== "string") {
    return { ok: false, error: jsonError(400, `${field} must be a string or null`) };
  }
  const url = value.trim();
  if (!url) return { ok: true, url: null };
  if (url.length > 2048) {
    return { ok: false, error: jsonError(400, `${field} is too long (max 2048 characters)`) };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: jsonError(400, `${field} must be a valid http(s) URL`) };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: jsonError(400, `${field} must be http(s)`) };
  }
  if (!parsed.hostname.includes(".")) {
    return { ok: false, error: jsonError(400, `${field} must have a valid hostname`) };
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
  | { ok: true; title: string; url: string | null; hasUrl: boolean; priceCents: number | null; currency: string | null; cheaperUrl: string | null; notes: string | null; tags: string[] }
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

  // Same validation as the item's own link: http(s), dotted hostname, ≤2048.
  const cheaperParsed = parseUrlInput(body.cheaperUrl, "cheaperUrl");
  if (!cheaperParsed.ok) return cheaperParsed;

  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
    return { ok: false, error: jsonError(400, "notes must be a string or null") };
  }
  const notes = typeof body.notes === "string" ? body.notes : null;

  const tagsParsed = parseTagsInput(body.tags);
  if (!tagsParsed.ok) return { ok: false, error: jsonError(400, "tags must be an array of strings") };

  return {
    ok: true,
    title,
    url,
    hasUrl,
    priceCents,
    currency,
    cheaperUrl: cheaperParsed.url,
    notes,
    tags: tagsParsed.tags,
  };
}