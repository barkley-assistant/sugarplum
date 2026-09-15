/**
 * Pure HTMLRewriter-based product extraction. Zero dependencies: meta tags,
 * JSON-LD, favicon, and <title> are read straight out of the served HTML.
 *
 * Precedence is locked to the research report (§RECOMMENDATION steps 2-4):
 *   title    = og:title → twitter:title → JSON-LD name → <title>
 *   price    = og:price:amount → product:price:amount → JSON-LD offers.price
 *              → DOM fallback tier (see below)
 *   currency = og:price:currency → product:price:currency → JSON-LD offers.priceCurrency
 *              → DOM fallback tier
 *   image    = og:image → JSON-LD image → twitter:image → DOM fallback tier → favicon
 *   siteName = og:site_name → hostname sans www.
 *
 * DOM fallback tier (wave 12): shops that ship NO structured metadata at all
 * (Amazon serves zero og:*, zero JSON-LD, zero microdata) still carry product
 * data in id-anchored DOM blocks. The tier is deliberately SITE-AGNOSTIC —
 * plain HTML selectors, no hostname checks anywhere in this file — and it only
 * ever fills values the metadata tiers left null:
 *   price = #aod-ingress-link .a-price (offer floor) → div[id^=corePrice] .a-price
 *   image = img#landingImage[data-old-hires] → img#landingImage[data-a-dynamic-image] first key
 * Anchoring to those ids is the invariant that keeps OTHER-ASIN carousel
 * prices/images out of the result: a bare `.a-price` scan picks a neighbour
 * product's price. See tests/fixtures/amazon-dp*.html and
 * docs/research/product-scraping.md §"2026-09-15 Amazon ground truth".
 */

export interface ParsedProduct {
  title: string | null;
  priceCents: number | null;
  currency: string | null;
  image: string | null; // absolute URL, protocol-relative fixed
  siteName: string | null;
}

interface FoundProduct {
  name: unknown;
  offersPrice: unknown;
  offersCurrency: unknown;
  image: unknown;
}

const PRICE_RE = /^\d{1,7}([.,]\d{1,2})?$/;
const MAX_CENTS = 1_000_000_00; // 1,000,000.00 sanity cap

/** Currency symbol → ISO code. Shared with searxng.ts (single table, no drift). */
export const SYMBOL_CURRENCY: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR" };

/** Symbol-anchored price ("£19.00", "24,88 €") → cents + currency.
 *  DOM price nodes carry the symbol, which is also the only currency evidence
 *  on pages without metadata — `parsePriceToCents` deliberately rejects these
 *  strings, so tier 2 has its own parser. Separators: the LAST one is the
 *  decimal point when 1-2 digits follow it, every other separator is a
 *  thousands separator ("£1,200.50" → 120050). Garbage → null, never NaN. */
export function parseSymbolPriceToCents(
  raw: unknown,
): { cents: number; currency: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  let currency: string | null = null;
  let numeric = text;
  for (const [symbol, code] of Object.entries(SYMBOL_CURRENCY)) {
    if (!text.includes(symbol)) continue;
    currency = code;
    numeric = text.replace(symbol, " ");
    break;
  }
  if (currency === null) return null;

  numeric = numeric.replace(/\s/g, "");
  const match = /^(\d[\d.,]*?)(?:([.,])(\d{1,2}))?$/.exec(numeric);
  if (!match) return null;
  const whole = match[1].replace(/[.,]/g, "");
  const frac = match[3] ?? "";
  if (!/^\d{1,10}$/.test(whole)) return null;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isFinite(cents) || cents > MAX_CENTS) return null;
  return { cents, currency };
}

/** "25.00" | 19.99 → 2500 | 1999. Garbage → null (never NaN, never negative). */
export function parsePriceToCents(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    const cents = Math.round(raw * 100);
    if (cents > MAX_CENTS) return null;
    return cents;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!PRICE_RE.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  if (cents > MAX_CENTS) return null;
  return cents;
}

/** "//cdn/x.jpg" → https://cdn/x.jpg; relative → resolved against pageUrl;
 *  anything non-http(s) → null. */
export function normalizeImageUrl(raw: unknown, pageUrl: string): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  const withScheme = value.startsWith("//") ? `https:${value}` : value;
  let parsed: URL;
  try {
    parsed = new URL(withScheme, pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text === "undefined" || text === "null") return null;
  return text;
}

function cleanCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toUpperCase();
  return text ? text : null;
}

/** Depth-first walk over one parsed JSON-LD block (objects + arrays, so
 *  @graph nesting is covered) returning the FIRST Product/ProductGroup node.
 *  For ProductGroup the effective product data comes from hasVariant[0]. */
function findProductNode(node: unknown): FoundProduct | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductNode(item);
      if (found) return found;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  const type = obj["@type"];
  const types = Array.isArray(type) ? type.map(String) : type !== undefined ? [String(type)] : [];
  const isGroup = types.includes("ProductGroup");
  if (types.includes("Product") || isGroup) {
    const variant =
      isGroup && Array.isArray(obj["hasVariant"]) && obj["hasVariant"].length > 0
        ? (obj["hasVariant"][0] as Record<string, unknown>)
        : null;
    const offers =
      isGroup && variant ? variant["offers"] : (obj["offers"] as Record<string, unknown> | undefined);
    const offersObj = offers && typeof offers === "object" ? (offers as Record<string, unknown>) : null;
    return {
      name: obj["name"],
      offersPrice: offersObj?.["price"],
      offersCurrency: offersObj?.["priceCurrency"],
      image: isGroup && variant ? variant["image"] : obj["image"],
    };
  }

  for (const key of Object.keys(obj)) {
    const found = findProductNode(obj[key]);
    if (found) return found;
  }
  return null;
}

export async function extractProduct(html: string, pageUrl: string): Promise<ParsedProduct> {
  const og: Record<string, string> = {};
  const product: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let favicon: string | null = null;
  let titleTag: string | null = null;
  let capturingTitle = false;
  const jsonld: unknown[] = [];
  let ldBuffer: string[] = [];

  // DOM fallback tier state (see the file header). Kept in locals, updated in
  // document order: an #aod-ingress-link / div[id^=corePrice] open tag arms the
  // capture, the first .a-offscreen text inside it becomes the price string.
  let inIngress = false;
  let inCorePrice = false;
  let capturingPrice: "ingress" | "core" | null = null;
  let ingressPriceText: string | null = null;
  let corePriceText: string | null = null;
  let landingHires: string | null = null;
  let landingDynamic: string | null = null;

  await new HTMLRewriter()
    .on('meta[property^="og:"]', {
      element(el) {
        const prop = el.getAttribute("property");
        const content = el.getAttribute("content");
        if (prop && content !== null) og[prop] = content;
      },
    })
    .on('meta[property^="product:"]', {
      element(el) {
        const prop = el.getAttribute("property");
        const content = el.getAttribute("content");
        if (prop && content !== null) product[prop] = content;
      },
    })
    .on('meta[name^="twitter:"]', {
      element(el) {
        const name = el.getAttribute("name");
        const content = el.getAttribute("content");
        if (name && content !== null) twitter[name] = content;
      },
    })
    .on('link[rel~="icon"]', {
      // Word-match selector: catches rel="shortcut icon" too. First match wins.
      element(el) {
        if (favicon === null) favicon = el.getAttribute("href");
      },
    })
    .on("title", {
      element() {
        if (titleTag === null) capturingTitle = true;
      },
      text(t) {
        if (!capturingTitle) return;
        titleTag = (titleTag ?? "") + t.text;
        if (t.lastInTextNode) capturingTitle = false;
      },
    })
    .on('script[type="application/ld+json"]', {
      element() {
        ldBuffer = [];
      },
      text(t) {
        ldBuffer.push(t.text);
        if (t.lastInTextNode) {
          const raw = ldBuffer.join("");
          ldBuffer = [];
          try {
            jsonld.push(JSON.parse(raw) as unknown);
          } catch {
            // Malformed block — skip it; other blocks still accumulate.
          }
        }
      },
    })
    .on("a#aod-ingress-link", {
      element() {
        inIngress = true;
      },
    })
    .on('div[id^="corePrice"]', {
      element() {
        inCorePrice = true;
      },
    })
    .on(".a-offscreen", {
      element() {
        if (capturingPrice !== null) return;
        if (inIngress && ingressPriceText === null) capturingPrice = "ingress";
        else if (inCorePrice && corePriceText === null) capturingPrice = "core";
      },
      text(t) {
        if (capturingPrice === null) return;
        if (capturingPrice === "ingress") ingressPriceText = (ingressPriceText ?? "") + t.text;
        else corePriceText = (corePriceText ?? "") + t.text;
        if (t.lastInTextNode) capturingPrice = null;
      },
    })
    .on("img#landingImage", {
      element(el) {
        landingHires ??= el.getAttribute("data-old-hires");
        landingDynamic ??= el.getAttribute("data-a-dynamic-image");
      },
    })
    .transform(new Response(html))
    .text();

  const ldNode = jsonld.length > 0 ? findProductNode(jsonld) : null;
  // Offer floor first (the only price that exists on some ASINs), apex/core
  // price block second. Both id-anchored — never a bare .a-price.
  const domPrice = parseSymbolPriceToCents(ingressPriceText ?? corePriceText);
  const domImage = landingHires ?? firstDynamicImageKey(landingDynamic);

  return {
    title:
      cleanTitle(og["og:title"]) ??
      cleanTitle(twitter["twitter:title"]) ??
      cleanTitle(ldNode?.name) ??
      cleanTitle(titleTag),
    priceCents:
      parsePriceToCents(og["og:price:amount"]) ??
      parsePriceToCents(product["product:price:amount"]) ??
      parsePriceToCents(ldNode?.offersPrice) ??
      domPrice?.cents ??
      null,
    currency:
      cleanCurrency(og["og:price:currency"]) ??
      cleanCurrency(product["product:price:currency"]) ??
      cleanCurrency(ldNode?.offersCurrency) ??
      domPrice?.currency ??
      null,
    image:
      normalizeImageUrl(og["og:image"], pageUrl) ??
      normalizeImageUrl(ldNode?.image, pageUrl) ??
      normalizeImageUrl(twitter["twitter:image"], pageUrl) ??
      // A real product-gallery image outranks the site favicon — the favicon
      // is the last resort, not a tier-1 value tier 2 must defer to.
      normalizeImageUrl(domImage, pageUrl) ??
      normalizeImageUrl(favicon, pageUrl),
    siteName: cleanTitle(og["og:site_name"]) ?? pageHostname(pageUrl),
  };
}

/** data-a-dynamic-image is an escaped JSON map of the gallery variants
 *  ({"https…":[w,h],…}) — the first key is the smallest variant. Unescaping is
 *  defensive: HTMLRewriter already decodes entities in some runtimes. */
function firstDynamicImageKey(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (key.startsWith("http")) return key;
  }
  return null;
}

function pageHostname(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}