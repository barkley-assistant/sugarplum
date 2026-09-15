/**
 * The scrape pipeline entry point (research §113-144): fetch → parse, with
 * a per-site strategy chain (wave 13). Registry in `./overrides` resolves
 * a chain per hostname; default `["plain"]` (byte-identical to pre-wave-13
 * behaviour for unregistered hosts). Partial results are success — title-only
 * extraction is a usable item.
 */

import { extractProduct, type ParsedProduct } from "./parse";
import { fetchPage, detectBotWall, type FetchFailure } from "./fetch";
import type { SearxngFetch as FetchLike } from "../searxng";
import { resolveOverride, type ScrapeStrategyName } from "./overrides";
export type { ScrapeStrategyName } from "./overrides";
import { stealthFetch, type StealthDeps } from "./stealth";

export type ScrapeResult =
  | { ok: true; product: ParsedProduct; finalUrl: string; strategy: ScrapeStrategyName }
  | (FetchFailure & { strategy: ScrapeStrategyName });

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
}

/** Resolve the chain to actually try for this URL on this run. Unregistered
 *  hosts get `["plain"]` strictly; registered hosts honor their registry
 *  list, dropping `stealth-browser` when the capability isn't wired. */
function resolveChain(url: string, deps: ScrapeDeps): ScrapeStrategyName[] {
  const reg = resolveOverride(url);
  const list: ScrapeStrategyName[] = reg ? [...reg.strategies] : ["plain"];
  if (deps.stealth === undefined) {
    return list.filter((s) => s !== "stealth-browser");
  }
  return list;
}

/** Common finish path: botwall check → extract → empty gate. Used by both
 *  the plain and stealth-browser strategies so a challenged page coming
 *  back through the browser classifies honestly as `botwall`. */
async function finishFromHtml(
  html: string,
  finalUrl: string,
  strategy: ScrapeStrategyName,
): Promise<ScrapeResult> {
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
): Promise<ScrapeResult> {
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
  let lastFailure: ScrapeResult | undefined;
  for (const strategy of chain) {
    const outcome = await runStrategy(url, strategy, deps);
    if (outcome.ok) return outcome;
    lastFailure = outcome;
  }
  // Unreachable when the chain is non-empty (default chain is ["plain"]);
  // the type system needs an explicit return.
  return (
    lastFailure ?? { ok: false, reason: "network", heuristic: "empty-chain", strategy: "plain" }
  );
}
