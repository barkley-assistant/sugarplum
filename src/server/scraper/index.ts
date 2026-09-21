/**
 * The scrape pipeline entry point (research §113-144): fetch → parse, with
 * a per-site strategy chain (wave 13). Registry in `./overrides` resolves
 * a chain per hostname; an unregistered host gets `["plain","stealth-browser"]`
 * (auto-escalation, #103) which drops stealth when the capability is unwired
 * (byte-identical to pre-wave-13 behaviour in that case). A non-escalatable
 * plain failure (network/private-ip) ends the default chain instead of
 * launching a browser. Partial results are success — title-only extraction is
 * a usable item.
 */

import type { Database } from "bun:sqlite";
import { extractProduct, type ParsedProduct } from "./parse";
import { fetchPage, detectBotWall, type FetchFailure } from "./fetch";
import type { SearxngFetch as FetchLike } from "../searxng";
import { resolveOverride, type ScrapeStrategyName } from "./overrides";
export type { ScrapeStrategyName } from "./overrides";
import { stealthFetch, type StealthDeps } from "./stealth";
import { ESCALATABLE_FAILURES, readLearned, type ScrapeStep } from "./learned";
export type { ScrapeStep } from "./learned";

/** One strategy's verdict. `finishFromHtml`/`runStrategy` return this; the
 *  pipeline wraps it in a `ScrapeResult` with the chain trace attached. */
type ScrapeVerdict =
  | { ok: true; product: ParsedProduct; finalUrl: string; strategy: ScrapeStrategyName }
  | (FetchFailure & { strategy: ScrapeStrategyName });

export type ScrapeResult = ScrapeVerdict & {
  /** Every strategy tried on this fetch, in order. One entry = the first (and
   *  only) attempt succeeded; the successful one is always the last. */
  steps: ScrapeStep[];
};

export interface ScrapeDeps {
  userAgent: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Explicit opt-in to allow private/loopback targets (tests use local
   *  Bun.serve servers on 127.0.0.1). Never a silent global. */
  allowPrivate?: boolean;
  /** Optional: enables the `stealth-browser` strategy on registered hosts.
   *  When undefined the chain filters that strategy out — graceful skip. */
  stealth?: StealthDeps;
  /** Optional: the deployment db, so learned overrides (#103) can be
   *  consulted. Absent → registry + default chain only. */
  learnedDb?: Database;
}

/** Chain actually tried for this URL on this run, plus whether it is the
 *  auto-escalation default (see `gateOnEscalatable`). */
interface ResolvedChain {
  strategies: ScrapeStrategyName[];
  /** Default chains only: a plain failure that is NOT escalatable (
   *  network/private-ip) ends the chain rather than launching a browser. A
   *  registry chain keeps wave-13 semantics — every entry tried in order. */
  gateOnEscalatable: boolean;
}

/** The unregistered-host default (#103 tier 1): plain first (no browser
 *  launch when it works — zero cost regression), escalate on failure. */
const DEFAULT_CHAIN: ScrapeStrategyName[] = ["plain", "stealth-browser"];

function filterStealth(list: readonly ScrapeStrategyName[], deps: ScrapeDeps): ScrapeStrategyName[] {
  const chain = [...list];
  return deps.stealth === undefined ? chain.filter((s) => s !== "stealth-browser") : chain;
}

/** Resolve the chain to actually try for this URL on this run. Precedence is
 *  registry > learned > default; the registry is the committed source of
 *  per-site ordering/headers and always wins. */
function resolveChain(url: string, deps: ScrapeDeps): ResolvedChain {
  const reg = resolveOverride(url);
  if (reg) {
    return { strategies: filterStealth(reg.strategies, deps), gateOnEscalatable: false };
  }
  if (deps.learnedDb !== undefined) {
    const learned = readLearned(deps.learnedDb, url);
    // A promoted override in force: straight to its chain, no plain attempt.
    if (learned && !learned.dueForRevalidation) {
      return { strategies: filterStealth(learned.strategies, deps), gateOnEscalatable: false };
    }
    // Lease spent (D6) → this ONE fetch is a plain-first revalidation probe;
    // `recordScrapeOutcome` renews or demotes the row from its outcome.
  }
  return { strategies: filterStealth(DEFAULT_CHAIN, deps), gateOnEscalatable: true };
}


/** Common finish path: botwall check → extract → empty gate. Used by both
 *  the plain and stealth-browser strategies so a challenged page coming
 *  back through the browser classifies honestly as `botwall`. */
async function finishFromHtml(
  html: string,
  finalUrl: string,
  strategy: ScrapeStrategyName,
): Promise<ScrapeVerdict> {
  const wall = detectBotWall(html);
  if (wall) {
    return {
      ok: false,
      reason: "botwall",
      heuristic: wall,
      strategy,
    };
  }
  const product = await extractProduct(html, finalUrl);
  if (product.title === null && product.image === null) {
    return { ok: false, reason: "empty", strategy };
  }
  return { ok: true, product, finalUrl, strategy };
}

/** Run a single strategy. Returns the chain's contribution (success or its
 *  own failure verdict — the chain wraps it; the pipeline chooses whether to
 *  fall through). */
async function runStrategy(
  url: string,
  strategy: ScrapeStrategyName,
  deps: ScrapeDeps,
): Promise<ScrapeVerdict> {
  if (strategy === "stealth-browser") {
    if (deps.stealth === undefined) {
      // Should be filtered out by resolveChain; defensive no-op.
      return { ok: false, reason: "network", heuristic: "stealth-unavailable", strategy };
    }
    const result = await stealthFetch(url, deps.stealth);
    if (!result.ok) {
      return { ...result, strategy };
    }
    return finishFromHtml(result.html, result.finalUrl, strategy);
  }

  // plain + custom-headers share the fetchPage path. custom-headers only
  // contributes merged headers; the registry's `headers` field is the
  // single place that ever defines them.
  const reg = resolveOverride(url);
  const extraHeaders =
    strategy === "custom-headers" && reg?.headers ? reg.headers : undefined;

  const page = await fetchPage(url, { ...deps, extraHeaders });
  if (!page.ok) {
    return { ...page, strategy };
  }
  return finishFromHtml(page.html, page.finalUrl, strategy);
}

export async function scrapeProduct(url: string, deps: ScrapeDeps): Promise<ScrapeResult> {
  const chain = resolveChain(url, deps);
  const steps: ScrapeStep[] = [];
  let lastFailure: ScrapeVerdict | undefined;
  for (const strategy of chain.strategies) {
    const outcome = await runStrategy(url, strategy, deps);
    steps.push(
      outcome.ok
        ? { strategy, ok: true }
        : { strategy, ok: false, reason: outcome.reason, heuristic: outcome.heuristic },
    );
    if (outcome.ok) return { ...outcome, steps };
    lastFailure = outcome;
    // Auto-escalation is only worth a browser launch when the plain verdict is
    // content-related or an HTTP wall (D1): a host the network cannot reach is
    // not a host a browser can reach.
    if (chain.gateOnEscalatable && !ESCALATABLE_FAILURES.has(outcome.reason)) break;
  }
  // Unreachable when the chain is non-empty (every chain includes "plain");
  // the type system needs an explicit return.
  if (lastFailure === undefined) {
    return { ok: false, reason: "network", heuristic: "empty-chain", strategy: "plain", steps };
  }
  return { ...lastFailure, steps };
}
