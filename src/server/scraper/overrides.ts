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

/** key = exact hostname, lowercase, no leading "www.". */
export const SITE_OVERRIDES: Record<string, SiteOverride> = {
  "smythstoys.com": {
    strategies: ["stealth-browser", "plain"],
    notes:
      "Imperva Incapsula JS challenge + fingerprinting; plain fetch gets " +
      "403 / 1KB interstitial. Proof: docs/research/stealth-browser-proof.md",
  },
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
