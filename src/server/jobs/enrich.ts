/**
 * In-process async enrichment worker. FIFO queue with a concurrency cap,
 * no DB job table: the boot sweep in createApp marks stranded 'pending'
 * rows 'failed', and the owner refresh route re-drives them.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { scrapeProduct, type ScrapeStrategyName } from "../scraper";
import { buildSearchQuery, searchImageHint, searchPriceHint, type PriceHint } from "../searxng";
import { downloadImage } from "../images";
import type { StealthDeps } from "../scraper/stealth";

export interface EnrichmentDeps {
  db: Database;
  imagesDir: string;
  userAgent: string;
  searxngUrl?: string;
  maxConcurrent: number;
  fetchImpl?: typeof fetch; // test injection (scraper + searxng + image all honor it)
  /** Explicit opt-in to allow private/loopback targets (the test app targets
   *  local Bun.serve servers on 127.0.0.1). Never a silent global. */
  allowPrivate?: boolean;
  /** Optional: enables the `stealth-browser` strategy on registered hosts. */
  stealth?: StealthDeps;
}

export interface EnrichmentQueue {
  enqueue(itemId: string): void;
  stop(): void;
}

interface ItemRowForEnrich {
  id: string;
  url: string | null;
  title: string;
  price_cents: number | null;
  currency: string | null;
  site_name: string | null;
  fetch_state: string;
  image_path: string | null;
}

export function createEnrichmentQueue(deps: EnrichmentDeps): EnrichmentQueue {
  const queue: string[] = [];
  let inFlight = 0;
  let stopped = false;

  function pump(): void {
    if (stopped) return;
    while (inFlight < deps.maxConcurrent && queue.length > 0) {
      const itemId = queue.shift() as string;
      inFlight++;
      void runItem(itemId)
        .catch((err) => {
          // A write after app shutdown (crash-sweep scenario) is by design;
          // anything else is a real worker failure worth logging.
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("Database has closed")) {
            console.error("enrichment worker error:", err);
          }
        })
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }

  async function runItem(itemId: string): Promise<void> {
    const row = deps.db
      .query(
        `SELECT id, url, title, price_cents, currency, site_name, fetch_state, image_path
         FROM wishlist_items WHERE id = ?`,
      )
      .get(itemId) as ItemRowForEnrich | undefined;

    // Double-enqueue idempotence: skip rows that are gone or no longer pending.
    if (!row || row.fetch_state !== "pending" || !row.url) return;

    const result = await scrapeProduct(row.url, {
      userAgent: deps.userAgent,
      fetchImpl: deps.fetchImpl,
      allowPrivate: deps.allowPrivate,
      stealth: deps.stealth,
    });

    const strategy: ScrapeStrategyName = result.strategy ?? "plain";
    console.info(
      "[enrich] item %s: strategy=%s → %s",
      itemId,
      strategy,
      result.ok ? "ok" : result.reason,
    );

    if (result.ok) {
      await applyScrape(deps, row, result.product);
      return;
    }
    await applyFailure(deps, row, result);
  }

  return {
    enqueue(itemId: string) {
      if (stopped) return;
      queue.push(itemId);
      pump();
    },
    stop() {
      stopped = true;
    },
  };
}

interface ParsedLike {
  title: string | null;
  priceCents: number | null;
  currency: string | null;
  image: string | null;
  siteName: string | null;
}

/** Fill-nulls/sentinel rules: title is overwritten only when it still IS the
 *  provisional hostname sentinel; price/currency/site_name fill NULLs only.
 *  A user who typed a title or price never gets clobbered. */
async function applyScrape(
  deps: EnrichmentDeps,
  row: ItemRowForEnrich,
  product: ParsedLike,
): Promise<void> {
  const sentinel = provisionalTitle(row.url as string);
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if (row.title === sentinel && product.title) {
    sets.push("title = ?");
    values.push(product.title);
  }
  if (row.price_cents === null && product.priceCents !== null) {
    sets.push("price_cents = ?");
    values.push(product.priceCents);
  }
  if (row.currency === null && product.currency !== null) {
    sets.push("currency = ?");
    values.push(product.currency);
  }
  if (row.site_name === null && product.siteName !== null) {
    sets.push("site_name = ?");
    values.push(product.siteName);
  }
  sets.push("fetch_state = 'complete'");
  sets.push("last_fetch_error = NULL");
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());

  deps.db.run(`UPDATE wishlist_items SET ${sets.join(", ")} WHERE id = ?`, [...values, row.id]);

  if (product.priceCents !== null) {
    deps.db.run(
      `INSERT INTO price_history (id, item_id, price_cents, currency, source, observed_at)
       VALUES (?, ?, ?, ?, 'scrape', ?)`,
      [randomUUID(), row.id, product.priceCents, product.currency, new Date().toISOString()],
    );
  }

  // Image download happens AFTER the row update; failure leaves the item
  // 'complete' with image_path NULL (graceful). image_source records where the
  // picture came from: 'direct' here, 'search' for the labelled fallback below.
  let storedImage = false;
  if (product.image) {
    const filename = await downloadImage(product.image, row.id, {
      imagesDir: deps.imagesDir,
      fetchImpl: deps.fetchImpl,
      allowPrivate: deps.allowPrivate,
    });
    if (filename) {
      deps.db.run("UPDATE wishlist_items SET image_path = ?, image_source = 'direct' WHERE id = ?", [
        filename,
        row.id,
      ]);
      storedImage = true;
    }
  }

  // Partial-ok backstop: the scrape succeeded but left the price and/or the
  // image empty — the item is STILL a success (a title alone is usable), so
  // fetch_state stays 'complete'. searxng gets one chance to attach LABELLED
  // hint data (hint_* columns / image_source='search'); it never writes to the
  // direct price_cents or overwrites a direct image.
  const searxngUrl = deps.searxngUrl;
  if (!searxngUrl || !row.url) return;
  const query = buildSearchQuery(row.url);

  if (row.price_cents === null && product.priceCents === null) {
    const hint = await searchPriceHint(query, { baseUrl: searxngUrl, fetchImpl: deps.fetchImpl });
    if (hint) persistPriceHint(deps, row.id, hint);
  }

  if (!storedImage && row.image_path === null) {
    const imageUrl = await searchImageHint(query, { baseUrl: searxngUrl, fetchImpl: deps.fetchImpl });
    if (!imageUrl) return;
    const filename = await downloadImage(imageUrl, row.id, {
      imagesDir: deps.imagesDir,
      fetchImpl: deps.fetchImpl,
      allowPrivate: deps.allowPrivate,
    });
    if (filename) {
      deps.db.run("UPDATE wishlist_items SET image_path = ?, image_source = 'search' WHERE id = ?", [
        filename,
        row.id,
      ]);
    }
  }
}

/** hint_* columns + their price_history row. Shared by the failure path and
 *  the partial-ok path so both keep identical hint semantics; callers own
 *  fetch_state. */
function persistPriceHint(deps: EnrichmentDeps, itemId: string, hint: PriceHint): void {
  deps.db.run(
    `UPDATE wishlist_items
     SET hint_price_cents = ?, hint_currency = ?, hint_source_url = ?, updated_at = ?
     WHERE id = ?`,
    [hint.priceCents, hint.currency, hint.sourceUrl, new Date().toISOString(), itemId],
  );
  deps.db.run(
    `INSERT INTO price_history (id, item_id, price_cents, currency, source, observed_at)
     VALUES (?, ?, ?, ?, 'searxng-hint', ?)`,
    [randomUUID(), itemId, hint.priceCents, hint.currency, new Date().toISOString()],
  );
}

/** Direct scrape failed: optional SearXNG hint makes the item usable
 *  ('complete' + hint_*); otherwise it degrades to 'failed'. */
async function applyFailure(
  deps: EnrichmentDeps,
  row: ItemRowForEnrich,
  failure: { reason: string; heuristic?: string },
): Promise<void> {
  if (deps.searxngUrl && row.url) {
    const hint = await searchPriceHint(buildSearchQuery(row.url), {
      baseUrl: deps.searxngUrl,
      fetchImpl: deps.fetchImpl,
    });
    if (hint) {
      deps.db.run(
        `UPDATE wishlist_items
         SET fetch_state = 'complete', last_fetch_error = NULL, updated_at = ?
         WHERE id = ?`,
        [new Date().toISOString(), row.id],
      );
      persistPriceHint(deps, row.id, hint);
      return;
    }
  }

  const reason = `${failure.reason}${failure.heuristic ? ` (${failure.heuristic})` : ""}`;
  deps.db.run(
    `UPDATE wishlist_items SET fetch_state = 'failed', last_fetch_error = ?, updated_at = ?
     WHERE id = ?`,
    [reason.slice(0, 300), new Date().toISOString(), row.id],
  );
}

function provisionalTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}