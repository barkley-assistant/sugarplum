/**
 * Tracking-parameter strip for stored product URLs (2026-11-13, Etsy add).
 *
 * A pasted product link carries two kinds of query params, and the tracker
 * needs them treated differently:
 *
 *  - SELECTION params (`variation0` on Etsy, `variant` on Shopify, `psc`/`th`
 *    on Amazon, …) change what the shopper pays. Measured: Etsy server-renders
 *    the selected variation's price into its JSON-LD — a /uk/ listing served
 *    offers [7.55, 9.44] GBP bare and [12.73] GBP with variation0 set — so
 *    dropping these would silently track the wrong size's price.
 *  - TRACKING params (`utm_*`, `ref`, Etsy's `ga_*`/`logging_key`/…, ad-click
 *    ids) are pure noise: they break dedup, bloat the stored URL, and can
 *    decay (short-lived tokens).
 *
 * The strip is therefore a DENYLIST: known-tracking names (plus the `utm_`
 * prefix family) are removed; everything unknown is PRESERVED. An allowlist
 * can never enumerate every shop's selection param, so the burden of proof
 * sits on "this param is tracking", never on "this param is meaningful".
 *
 * Only the query string is rewritten — path, fragment (some shops route
 * products through `#/…`) and everything else pass through untouched. A URL
 * this function cannot parse is returned as-is: validation lives upstream
 * (parseUrlInput), and this must never turn a stored URL into garbage.
 */

/** Exact param names measured or documented as tracking-only. */
const TRACKING_PARAMS = new Set([
  // Click-trackers / ad attributions (every shop family).
  "gclid",
  "fbclid",
  "msclkid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "twclid",
  "ttclid",
  "igshid",
  "spm",
  // Etsy listing-URL noise (measured on a /uk/ search-result paste,
  // 2026-11-13): search-session refs + share/logging tokens.
  "ref",
  "ref_ctx",
  "ls",
  "pro",
  "objs",
  "epro",
  "external",
  "from_marker",
  "uts",
  "urn",
  "ga_order",
  "ga_search_type",
  "ga_view_type",
  "ga_search_query",
  "ga_search_field",
  "ga_per_page",
  "ga_tot_searchs",
  "ga_total_searches",
  "organic_search_click",
  "logging_key",
  "content_source",
  "rec_type",
  "rec_id",
  "pla",
]);

/** Param-name prefixes that are tracking by convention. */
const TRACKING_PREFIXES = ["utm_"];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  return TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

export function cleanProductUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!parsed.search) return raw;

  const kept = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) {
    if (!isTrackingParam(name)) kept.append(name, value);
  }
  const search = kept.toString();
  const query = search ? `?${search}` : "";
  return `${parsed.origin}${parsed.pathname}${query}${parsed.hash}`;
}
