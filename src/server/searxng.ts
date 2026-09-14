/**
 * Best-effort SearXNG price-hint fallback (research §83-95). Deliberately
 * weak: one snippet regex over title+content, first result with a parseable
 * price wins, no result-page fetching, NEVER throws. Hints are owner-only
 * display data — they never overwrite a direct scrape.
 */

export interface PriceHint {
  priceCents: number;
  currency: string;
  sourceUrl: string;
  title: string;
}

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

const SYMBOL_CURRENCY: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR" };
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

    const content = typeof result.content === "string" ? result.content : "";
    const source = `${result.title} ${content}`;
    const match = PRICE_RE.exec(source);
    if (!match) continue;
    const parsed = parseSnippetPrice(source, match);
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