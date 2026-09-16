/**
 * Best-effort SearXNG price-hint fallback (research §83-95). Deliberately
 * weak: one snippet regex over title+content, first result with a parseable
 * price wins, no result-page fetching, NEVER throws. Hints are owner-only
 * display data — they never overwrite a direct scrape.
 */

import { SYMBOL_CURRENCY } from "./scraper/parse";

export interface PriceHint {
  priceCents: number;
  currency: string;
  sourceUrl: string;
  title: string;
}

/** One "prices seen elsewhere" candidate. Display-only: a snippet price is
 *  NOT a verified comparison (research §Q2c), so nothing here may be
 *  persisted as truth. */
export interface PriceCandidate {
  priceCents: number;
  currency: string;
  sourceUrl: string;
  sourceTitle: string;
}

/** Hard cap on the candidates returned for one lookup. */
export const PRICE_CANDIDATE_LIMIT = 3;

export interface SearxngDeps {
  baseUrl: string;
  fetchImpl?: SearxngFetch;
  timeoutMs?: number;
}

/** Structural fetch type (Bun's `typeof fetch` has extra static members that
 *  make test stubs awkward). The global `fetch` is assignable to it. */
export type SearxngFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const PRICE_RE = /([$£€])\s?(\d{1,4}(?:[.,]\d{1,2})?)/;
const NOISE_TERMS = new Set(["products", "dp", "itm", "ip", "p", "ref", "gp"]);

/** "https://www.coolshop.co.uk/products/fresh-kiss-trio?ref=x" →
 *  "coolshop.co.uk fresh kiss trio buy" (≤ 6 terms, ≤ 120 chars). */
export function buildSearchQuery(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const pathTokens = parsed.pathname
    .split(/[/-]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !NOISE_TERMS.has(t.toLowerCase()));
  const joined = [host, ...pathTokens, "buy"].slice(0, 6).join(" ");
  return joined.length > 120 ? joined.slice(0, 120) : joined;
}

/** Title-derived query for the on-demand candidates lookup: the scraped
 *  title's terms (deduped, ≤ 6) plus "buy", capped like buildSearchQuery. */
export function buildTitleQuery(title: string): string {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of title.split(/\s+/)) {
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 6) break;
  }
  if (terms.length === 0) return "";
  const joined = [...terms, "buy"].join(" ");
  return joined.length > 120 ? joined.slice(0, 120) : joined;
}

export async function searchPriceHint(query: string, deps: SearxngDeps): Promise<PriceHint | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const own = ownHost(query);

  let res: Response;
  try {
    res = await fetchImpl(`${deps.baseUrl}/search?q=${encodeURIComponent(query)}&format=json`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let payload: { results?: unknown[] };
  try {
    payload = (await res.json()) as { results?: unknown[] };
  } catch {
    return null;
  }
  if (!Array.isArray(payload.results)) return null;

  for (const raw of payload.results) {
    if (typeof raw !== "object" || raw === null) continue;
    const result = raw as Record<string, unknown>;
    if (typeof result.url !== "string" || typeof result.title !== "string") continue;

    // A result on the item's own domain adds nothing — not a "hint".
    const resultHost = hostOf(result.url);
    if (resultHost && own && resultHost === own) continue;

    const parsed = priceFromResult(result);
    if (!parsed) continue;

    return {
      priceCents: parsed.cents,
      currency: parsed.currency,
      sourceUrl: result.url,
      title: result.title,
    };
  }
  return null;
}

/** On-demand "prices seen elsewhere": up to PRICE_CANDIDATE_LIMIT snippet
 *  prices for a title, same wire contract as searchPriceHint (one request,
 *  never throws, [] on any failure). Results on `excludeHost` (the item's own
 *  shop) are skipped, as are duplicate URLs. Nothing is persisted. */
export async function searchPriceCandidates(
  title: string,
  excludeHost: string | null,
  deps: SearxngDeps,
): Promise<PriceCandidate[]> {
  const query = buildTitleQuery(title);
  if (!query) return [];

  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${deps.baseUrl}/search?q=${encodeURIComponent(query)}&format=json`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  let payload: { results?: unknown[] };
  try {
    payload = (await res.json()) as { results?: unknown[] };
  } catch {
    return [];
  }
  if (!Array.isArray(payload.results)) return [];

  const candidates: PriceCandidate[] = [];
  const seenUrls = new Set<string>();
  for (const raw of payload.results) {
    if (candidates.length >= PRICE_CANDIDATE_LIMIT) break;
    if (typeof raw !== "object" || raw === null) continue;
    const result = raw as Record<string, unknown>;
    if (typeof result.url !== "string" || typeof result.title !== "string") continue;
    if (seenUrls.has(result.url)) continue;

    const resultHost = hostOf(result.url);
    if (resultHost && excludeHost && resultHost === excludeHost.toLowerCase()) continue;

    const parsed = priceFromResult(result);
    if (!parsed) continue;

    seenUrls.add(result.url);
    candidates.push({
      priceCents: parsed.cents,
      currency: parsed.currency,
      sourceUrl: result.url,
      sourceTitle: result.title,
    });
  }
  return candidates;
}

/** The shared snippet rule for both hint shapes: one PRICE_RE hit over
 *  title + content, parsed with its comma guards. */
function priceFromResult(result: Record<string, unknown>): { cents: number; currency: string } | null {
  const content = typeof result.content === "string" ? result.content : "";
  const title = typeof result.title === "string" ? result.title : "";
  const match = PRICE_RE.exec(`${title} ${content}`);
  if (!match) return null;
  return parseSnippetPrice(`${title} ${content}`, match);
}

/** Best-effort SearXNG image fallback (issue #12 "image via search"). Same
 *  contract as the price hint: one request, never throws, null when nothing
 *  usable comes back. `categories=images` is what makes a SearXNG instance
 *  populate `img_src` at all — general results carry an EMPTY img_src string
 *  (verified against the household instance 2026-09-15), so an empty/absent
 *  field just means "try the next result". */
export async function searchImageHint(query: string, deps: SearxngDeps): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(
      `${deps.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=images`,
      { signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let payload: { results?: unknown[] };
  try {
    payload = (await res.json()) as { results?: unknown[] };
  } catch {
    return null;
  }
  if (!Array.isArray(payload.results)) return null;

  for (const raw of payload.results) {
    if (typeof raw !== "object" || raw === null) continue;
    const result = raw as Record<string, unknown>;
    const img = typeof result.img_src === "string" ? result.img_src.trim() : "";
    if (/^https?:\/\//i.test(img)) return img;
  }
  return null;
}

/** The item's own hostname slug — buildSearchQuery always puts it first. */
function ownHost(query: string): string {
  const first = query.split(/\s+/)[0] ?? "";
  return first.toLowerCase();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Symbol → currency; comma-decimal tolerated ("3,25" → 3.25); comma-thousands
 *  guard: "1,200" (a digit follows the 2-digit group) becomes "1200". */
function parseSnippetPrice(
  source: string,
  match: RegExpExecArray,
): { cents: number; currency: string } | null {
  const symbol = match[1];
  const currency = SYMBOL_CURRENCY[symbol];
  if (!currency) return null;

  let group = match[2];
  if (group.includes(",")) {
    const after = source.slice(match.index + match[0].length);
    if (/^\d/.test(after)) {
      // Thousands separator: the regex captured only the first two digits
      // after the comma; re-attach the third from what follows the match.
      group = group.replace(",", "") + after[0];
    } else {
      // Decimal separator (UK/EU "£3,25"): swap to "." so Number() works.
      group = group.replace(",", ".");
    }
  }
  const amount = Number(group);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { cents: Math.round(amount * 100), currency };
}