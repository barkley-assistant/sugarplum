/**
 * Daily price-tracking scheduler (wave 25). An in-process chained-`setTimeout`
 * loop that, once per pass, walks tracked items and enqueues each into the
 * EXISTING enrichment queue with a stagger. It NEVER scrapes directly —
 * `queue.enqueue` is the only scrape trigger, so the strategy chain, the
 * stealth mutex, the price_history write, and the failure backstop are all
 * reused untouched (zero scrape-logic duplication).
 *
 * Stealth budget: one enqueue per `staggerMs` on top of the enrichment
 * queue's own `maxConcurrent` cap and the process-wide Firefox mutex. No
 * second concurrency knob lives here.
 */

import type { Database } from "bun:sqlite";

/** The only queue surface the tracker needs (subset of EnrichmentQueue). */
export interface TrackQueue {
  enqueue(itemId: string): void;
}

/** Timer seam: production passes the globals; tests inject a fake clock. */
export interface TrackTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TrackDeps {
  db: Database;
  queue: TrackQueue;
  intervalMs: number;
  initialDelayMs: number;
  staggerMs: number;
  /** Re-check cadence for an item that failed its last fetch (48h). */
  failedMs: number;
  /** Re-check cadence for an item whose price moved inside movedWindowMs (12h). */
  activeMs: number;
  /** Re-check cadence for everything else (usually == intervalMs). */
  stableMs: number;
  /** How recent a price observation marks an item "recently moved" (7d). */
  movedWindowMs: number;
  /** Test seam: inject a clock. Default: wall time. */
  now?: () => Date;
  /** Test seam: inject timers. Default: the globals. */
  timers?: TrackTimers;
}

export interface Tracker {
  stop(): void;
}

/** The per-row inputs the tier rule needs. */
interface CandidateRow {
  id: string;
  fetch_state: string;
  last_tracked_at: string | null;
  /** Latest price observation, or null when the item has no history. */
  last_price_at: string | null;
}

/** The four ISO cutoffs, recomputed per pass because `now` moves. */
interface Cutoffs {
  stable: string;
  active: string;
  failed: string;
  moved: string;
}

/**
 * Per-item due rule, most-urgent tier first:
 *  - never tracked → due (unchanged: a missed item catches up first).
 *  - last fetch FAILED → due after failedMs. A failure wins over the
 *    recently-moved tier below, so a dead host is retried at the slowest
 *    cadence rather than every activeMs.
 *  - price observed inside the moved window → due after activeMs.
 *  - otherwise → due after stableMs.
 */
function isDue(row: CandidateRow, cutoffs: Cutoffs): boolean {
  if (row.last_tracked_at === null) return true;
  // A failure wins over the recently-moved tier: a dead host is retried at
  // the slowest cadence, not every activeMs.
  if (row.fetch_state === "failed") return row.last_tracked_at < cutoffs.failed;
  if (row.last_price_at !== null && row.last_price_at >= cutoffs.moved) {
    return row.last_tracked_at < cutoffs.active;
  }
  return row.last_tracked_at < cutoffs.stable;
}

export function createTracker(deps: TrackDeps): Tracker {
  const nowFn = deps.now ?? (() => new Date());
  const timers: TrackTimers = deps.timers ?? { setTimeout, clearTimeout };
  let stopped = false;
  // Every pending handle: the next-pass timer plus all in-flight stagger
  // timers. stop() clears them all; the stopped flag guards callbacks that
  // already fired.
  const pending = new Set<unknown>();

  function later(fn: () => void, ms: number): void {
    const handle = timers.setTimeout(() => {
      pending.delete(handle);
      if (!stopped) fn();
    }, ms);
    pending.add(handle);
  }

  function pass(): void {
    if (stopped) return;
    const now = nowFn();
    const isoAgo = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const cutoffs: Cutoffs = {
      stable: isoAgo(deps.stableMs),
      active: isoAgo(deps.activeMs),
      failed: isoAgo(deps.failedMs),
      moved: isoAgo(deps.movedWindowMs),
    };
    // Prefilter on the LOOSEST tier (the smallest ms value ⇒ the earliest
    // date): a row is due when it is OLDER than its own tier's cutoff, so a
    // tighter prefilter would drop rows the tier filter below wants. The
    // per-item rule is applied in TypeScript, where it is readable and
    // testable; the SQL predicate only trims obviously-stale rows.
    const prefilterCutoff = isoAgo(Math.min(deps.stableMs, deps.activeMs, deps.failedMs));
    // Never-tracked rows sort first: SQLite orders NULLs before values in
    // ASC, so a missed day catches up before recently tracked items.
    const rows = deps.db
      .query(
        `SELECT i.id AS id,
                i.fetch_state AS fetch_state,
                i.last_tracked_at AS last_tracked_at,
                (SELECT MAX(ph.observed_at) FROM price_history ph
                  WHERE ph.item_id = i.id) AS last_price_at
         FROM wishlist_items i JOIN users u ON u.id = i.user_id
         WHERE i.url IS NOT NULL
           AND i.fetch_state != 'pending'
           AND u.price_tracking_enabled = 1
           AND u.is_active = 1
           AND (i.last_tracked_at IS NULL OR i.last_tracked_at < ?)
         ORDER BY i.last_tracked_at ASC, i.created_at ASC`,
      )
      .all(prefilterCutoff) as CandidateRow[];

    const candidates = rows.filter((row) => isDue(row, cutoffs));

    candidates.forEach((candidate, i) => {
      later(() => enqueueOne(candidate.id, now), i * deps.staggerMs);
    });

    // The next pass chains from the end of THIS pass's scheduling (not from
    // boot), so a slow pass with many staggered items never overlaps.
    later(pass, deps.intervalMs);
  }

  function enqueueOne(itemId: string, passNow: Date): void {
    if (stopped) return;
    // Re-read: the row may have changed since the pass query (deleted,
    // opted out, or picked up by a user-triggered re-check).
    const row = deps.db
      .query(
        `SELECT i.id AS id, i.url AS url, i.fetch_state AS fetch_state,
                u.price_tracking_enabled AS price_tracking_enabled,
                u.is_active AS is_active
         FROM wishlist_items i JOIN users u ON u.id = i.user_id
         WHERE i.id = ?`,
      )
      .get(itemId) as
      | {
          id: string;
          url: string | null;
          fetch_state: string;
          price_tracking_enabled: number;
          is_active: number;
        }
      | undefined;
    if (!row) return;
    if (!row.url) return;
    if (row.fetch_state === "pending") return;
    if (row.price_tracking_enabled !== 1) return;
    if (row.is_active !== 1) return;

    // Mirror the owner refresh route: mark pending (so the enrichment
    // worker's double-enqueue guard and the boot crash sweep both apply)
    // and stamp the scheduler-only dedupe timestamp.
    const stamp = passNow.toISOString();
    deps.db.run(
      `UPDATE wishlist_items
       SET fetch_state = 'pending', last_fetch_error = NULL,
           last_tracked_at = ?, updated_at = ?
       WHERE id = ?`,
      [stamp, stamp, itemId],
    );
    deps.queue.enqueue(itemId);
  }

  later(pass, deps.initialDelayMs);

  return {
    stop() {
      stopped = true;
      for (const handle of pending) timers.clearTimeout(handle);
      pending.clear();
    },
  };
}
