/**
 * Pure HTMLRewriter-based product extraction. Zero dependencies: meta tags,
 * JSON-LD, favicon, and <title> are read straight out of the served HTML.
 *
 * Precedence is locked to the research report (§RECOMMENDATION steps 2-4):
 *   title    = og:title → twitter:title → JSON-LD name → <title>
 *   price    = og:price:amount → product:price:amount → JSON-LD offers.price
 *   currency = og:price:currency → product:price:currency → JSON-LD offers.priceCurrency
 *   image    = og:image → JSON-LD image → twitter:image → favicon
 *   siteName = og:site_name → hostname sans www.
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
    .transform(new Response(html))
    .text();

  const ldNode = jsonld.length > 0 ? findProductNode(jsonld) : null;

  return {
    title:
      cleanTitle(og["og:title"]) ??
      cleanTitle(twitter["twitter:title"]) ??
      cleanTitle(ldNode?.name) ??
      cleanTitle(titleTag),
    priceCents:
      parsePriceToCents(og["og:price:amount"]) ??
      parsePriceToCents(product["product:price:amount"]) ??
      parsePriceToCents(ldNode?.offersPrice),
    currency:
      cleanCurrency(og["og:price:currency"]) ??
      cleanCurrency(product["product:price:currency"]) ??
      cleanCurrency(ldNode?.offersCurrency),
    image:
      normalizeImageUrl(og["og:image"], pageUrl) ??
      normalizeImageUrl(ldNode?.image, pageUrl) ??
      normalizeImageUrl(twitter["twitter:image"], pageUrl) ??
      normalizeImageUrl(favicon, pageUrl),
    siteName: cleanTitle(og["og:site_name"]) ?? pageHostname(pageUrl),
  };
}

function pageHostname(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}