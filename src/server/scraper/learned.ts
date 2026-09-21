/**
 * Learned scrape overrides (#103) — tier 2 of the auto-escalation feature.
 *
 * A host that repeatedly needs the stealth browser to get past a wall is
 * PROMOTED to a local `["stealth-browser","plain"]` override, so later fetches
 * skip the doomed plain attempt. Promotion happens on the 3rd qualifying
 * escalation (plain failed with an escalatable reason AND the escalated
 * stealth attempt succeeded); the entry is not permanent — see
 * `dueForRevalidation` and `recordScrapeOutcome` for the decay rules.
 *
 * Storage is the deployment's own sqlite db (`scrape_learned_overrides`,
 * migration v9): local, persistent, never committed and never projected to the
 * client. Precedence is registry > learned > default — a host in
 * `SITE_OVERRIDES` never learns anything, so the committed registry stays the
 * single place that asserts special ordering/headers.
 *
 * Every function here is best-effort: a db hiccup must never break a scrape or
 * an enrichment, so reads degrade to `null` (default chain) and writes are
 * swallowed with a warning.
 */

import type { Database } from "bun:sqlite";
import { normalizeHostname, resolveOverride, type ScrapeStrategyName } from "./overrides";
import type { FetchFailure } from "./fetch";

/** Plain verdicts worth a browser retry: content failures (a browser sees a
 *  different page) and any >=400 (eBay's hard 403 with a non-challenge body).
 *  `network` does not escalate — a browser cannot reach a host the network
 *  cannot — and `private-ip` is the SSRF guard rejecting before any I/O. */
export const ESCALATABLE_FAILURES: ReadonlySet<FetchFailure["reason"]> = new Set<
  FetchFailure["reason"]
>(["botwall", "empty", "http"]);

/** Qualifying escalations before a host is promoted to stealth-first. */
export const LEARNED_PROMOTION_THRESHOLD = 3;
/** A promoted entry is probed with plain again this many days after its lease
 *  was stamped. */
export const LEARNED_REVALIDATE_DAYS = 7;
/** ...or after this many successful stealth-first fetches, whichever is first. */
export const LEARNED_REVALIDATE_FETCHES = 10;
/** The chain a learned (promoted) host runs. */
export const LEARNED_CHAIN: readonly ScrapeStrategyName[] = ["stealth-browser", "plain"];

/** What each strategy in the chain did on one fetch. Carried on the result so
 *  the caller can record the outcome without re-deriving the chain. */
export interface ScrapeStep {
  strategy: ScrapeStrategyName;
  ok: boolean;
  /** Set on a failed step — that strategy's own verdict. */
  reason?: FetchFailure["reason"];
  /** Set on a failed step — the matched (or synthetic) heuristic name, e.g.
   *  "captcha" or "stealth-timeout". Never page content. */
  heuristic?: string;
}

export interface LearnedOverride {
  hostname: string;
  strategies: ScrapeStrategyName[];
  /** True once the entry's lease is spent: THIS fetch probes plain first
   *  (the default chain), and the outcome either renews or demotes the row. */
  dueForRevalidation: boolean;
}

interface LearnedRow {
  hostname: string;
  strategies: string | null;
  escalation_count: number;
  learned_at: string | null;
  last_escalated_at: string;
  last_demoted_at: string | null;
  successful_stealth_fetches: number;
}

const SELECT_ROW = `
  SELECT hostname, strategies, escalation_count, learned_at, last_escalated_at,
         last_demoted_at, successful_stealth_fetches
  FROM scrape_learned_overrides
  WHERE hostname = ?
`;

/** One row, or null (missing row, malformed db). Reads are never fatal. */
function selectRow(db: Database, hostname: string): LearnedRow | null {
  try {
    return (db.query(SELECT_ROW).get(hostname) as LearnedRow | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The promoted override for this URL, or null when the host has none. Returns
 *  null for a candidate row (strategies NULL) — candidates record evidence
 *  without changing behaviour. */
export function readLearned(db: Database, url: string): LearnedOverride | null {
  const hostname = normalizeHostname(url);
  if (hostname === null) return null;

  const row = selectRow(db, hostname);
  if (!row || row.strategies === null) return null;
  const strategies = parseStrategies(row.strategies);
  if (!strategies) return null;

  return { hostname, strategies, dueForRevalidation: isDue(row, Date.now()) };
}

function parseStrategies(raw: string): ScrapeStrategyName[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const known = parsed.filter(
      (s): s is ScrapeStrategyName =>
        s === "plain" || s === "custom-headers" || s === "stealth-browser",
    );
    return known.length === parsed.length ? known : null;
  } catch {
    return null;
  }
}

/** Decay trigger: time since promotion OR stealth-first successes, whichever
 *  budget is spent first. An unreadable stamp counts as due — the worst case
 *  is one extra plain attempt, and a probe is how the row gets corrected. */
function isDue(row: LearnedRow, nowMs: number): boolean {
  if (row.successful_stealth_fetches >= LEARNED_REVALIDATE_FETCHES) return true;
  if (row.learned_at === null) return true;
  const learnedMs = Date.parse(row.learned_at);
  if (Number.isNaN(learnedMs)) return true;
  return nowMs - learnedMs >= LEARNED_REVALIDATE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Record what one fetch did for this host. Called by the enrichment worker
 * after `scrapeProduct` returns, BEFORE the item is written — so a learning
 * failure can never block the item's own update. Never throws.
 */
export function recordScrapeOutcome(db: Database, url: string, steps: ScrapeStep[]): void {
  try {
    applyOutcome(db, url, steps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[learned] outcome not recorded for %s: %s", url, message);
  }
}

function applyOutcome(db: Database, url: string, steps: ScrapeStep[]): void {
  const hostname = normalizeHostname(url);
  if (hostname === null) return;
  // Registry hosts never learn (D2): the committed chain is authoritative.
  if (resolveOverride(url) !== undefined) return;
  if (steps.length === 0) return;

  const now = new Date().toISOString();
  const row = selectRow(db, hostname);
  const plain = steps.find((s) => s.strategy === "plain");
  const stealth = steps.find((s) => s.strategy === "stealth-browser");
  const plainFailedEscalatable =
    plain !== undefined &&
    !plain.ok &&
    plain.reason !== undefined &&
    ESCALATABLE_FAILURES.has(plain.reason);
  const stealthOk = stealth?.ok === true;
  const plainFirst = steps[0].strategy !== "stealth-browser";

  if (row && row.strategies !== null) {
    // Promoted: the entry is in force, so there are only two shapes to expect.
    if (plainFirst && plain) {
      // Revalidation probe (the chain was swapped to plain-first for this
      // fetch). Plain works again → the host no longer needs the override.
      if (plain.ok) return demote(db, hostname, now);
      if (plainFailedEscalatable && stealthOk) return refresh(db, hostname, now);
      return; // inconclusive — keep the entry, the next fetch is stealth-first
    }
    if (stealth) {
      if (stealthOk) {
        // Count-based decay budget: one step closer to the next probe.
        db.run(
          `UPDATE scrape_learned_overrides
           SET successful_stealth_fetches = successful_stealth_fetches + 1
           WHERE hostname = ?`,
          [hostname],
        );
        return;
      }
      // Stealth failed but plain succeeded: plain is back, so the override is
      // no longer earning its browser launch.
      if (plain?.ok) return demote(db, hostname, now);
    }
    return;
  }

  // Not promoted: either the first sighting or a candidate row accruing
  // evidence. Only a full escalation (plain-failed-escalatable → stealth-ok)
  // counts toward promotion.
  if (plainFailedEscalatable && stealthOk) {
    const count = recordEscalation(db, hostname, now);
    if (count >= LEARNED_PROMOTION_THRESHOLD) promote(db, hostname, now);
    return;
  }
  if (plain?.ok && row) {
    // Housekeeping: plain works today, so stale escalation evidence (a
    // candidate that never reached the threshold) is no longer current.
    db.run(
      "UPDATE scrape_learned_overrides SET escalation_count = 0 WHERE hostname = ?",
      [hostname],
    );
  }
}

/** Atomic upsert: the increment happens in SQL so two concurrent scrapes of
 *  the same host cannot lose an escalation. Returns the resulting count. */
function recordEscalation(db: Database, hostname: string, now: string): number {
  db.run(
    `INSERT INTO scrape_learned_overrides (hostname, escalation_count, last_escalated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(hostname) DO UPDATE SET
       escalation_count  = escalation_count + 1,
       last_escalated_at = excluded.last_escalated_at`,
    [hostname, now],
  );
  return selectRow(db, hostname)?.escalation_count ?? 0;
}

/** Stamp a promoted entry (candidate → stealth-first). A row that is already
 *  promoted keeps its existing lease; promotion is not a re-stamp. */
function promote(db: Database, hostname: string, now: string): void {
  db.run(
    `UPDATE scrape_learned_overrides
     SET strategies = ?, learned_at = ?, successful_stealth_fetches = 0
     WHERE hostname = ? AND strategies IS NULL`,
    [JSON.stringify(LEARNED_CHAIN), now, hostname],
  );
}

/** Revalidation probe passed: renew the lease and reset both decay budgets so
 *  the next probe is a full window away. */
function refresh(db: Database, hostname: string, now: string): void {
  db.run(
    `UPDATE scrape_learned_overrides
     SET learned_at = ?, last_escalated_at = ?,
         escalation_count = escalation_count + 1, successful_stealth_fetches = 0
     WHERE hostname = ?`,
    [now, now, hostname],
  );
}

/** Plain works again (probe or stealth-first fallback): drop the override, and
 *  keep the row as a zeroed candidate so the host's history stays visible. */
function demote(db: Database, hostname: string, now: string): void {
  db.run(
    `UPDATE scrape_learned_overrides
     SET strategies = NULL, learned_at = NULL, last_demoted_at = ?,
         escalation_count = 0, successful_stealth_fetches = 0
     WHERE hostname = ?`,
    [now, hostname],
  );
}
