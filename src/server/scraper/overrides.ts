/**
 * Site-override registry: per-hostname strategy chains + optional per-site
 * header overrides. Adding a bot-walled shop = one reviewed entry here; no
 * core-scraper edits. See .hermes/plans/wave13-overrides.md for the design
 * and docs/research/stealth-browser-proof.md for the Incapsula evidence.
 *
 * Matching is EXACT hostname, lowercased, with leading "www." stripped.
 * blog.example.com must never inherit example.com's chain — suffix matching
 * is intentionally not implemented. Regional variants get explicit keys.
 */

export type ScrapeStrategyName = "plain" | "custom-headers" | "stealth-browser";

export interface SiteOverride {
  /** Tried in order until one returns ok. First entry is the primary. */
  strategies: ScrapeStrategyName[];
  /** Merged over fetchPage's default headers (custom-headers strategy). */
  headers?: Record<string, string>;
  /** Why this override exists — keep the evidence link. */
  notes: string;
}

/** Amazon regional storefronts. The served HTML carries NO og:*, NO JSON-LD
 *  and NO microdata on ANY transport (plain or stealth), so price/image come
 *  from the extractor's generic DOM tier (parse.ts); this entry only decides
 *  how the page is fetched. Measured 2026-09-15: a plain fetch from a
 *  residential IP passes Amazon's wall on both an available and a no-featured-
 *  offer ASIN, and stealth costs a browser launch (~2-6s, ~250-400MB) — so
 *  stealth is the fallback. If Amazon tightens, flip the order in one line. */
const AMAZON_OVERRIDE: SiteOverride = {
  strategies: ["plain", "stealth-browser"],
  notes:
    "No og:/JSON-LD/microdata in served HTML — extraction via the generic DOM " +
    "tier. Plain fetch passes from a residential IP (2026-09-15); stealth " +
    "fallback if that changes. Evidence: docs/research/product-scraping.md " +
    "§2026-09-15 Amazon ground truth",
};

/** key = exact hostname, lowercase, no leading "www.". */
export const SITE_OVERRIDES: Record<string, SiteOverride> = {
  "smythstoys.com": {
    strategies: ["stealth-browser", "plain"],
    notes:
      "Imperva Incapsula JS challenge + fingerprinting; plain fetch gets " +
      "403 / 1KB interstitial. Proof: docs/research/stealth-browser-proof.md",
  },
  "amazon.co.uk": AMAZON_OVERRIDE,
  "amazon.com": AMAZON_OVERRIDE,
  "amazon.de": AMAZON_OVERRIDE,
};

/** hostname("https://WWW.SmythsToys.com/x") → "smythstoys.com" or null. */
export function normalizeHostname(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** undefined = no override (default chain ["plain"]). */
export function resolveOverride(url: string): SiteOverride | undefined {
  const host = normalizeHostname(url);
  if (host === null) return undefined;
  return SITE_OVERRIDES[host];
}
