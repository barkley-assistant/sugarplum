/** Pure display helpers for the SPA. Money is exchanged as decimal strings
 *  ("24.99"); the DB stores integer cents. No floats, ever. */

/** Formats a decimal price string with the item's currency via
 *  Intl.NumberFormat (correct symbols + grouping for any ISO code).
 *  - cents null → "" (no price)
 *  - currency missing → the raw decimal string (nothing to format with)
 *  - unknown/invalid currency code → "<amount> <CODE>" fallback shape
 */
export function formatPrice(cents: string | null, currency: string | null): string {
  if (cents === null) return "";
  const code = (currency ?? "").trim().toUpperCase();
  if (!code) return cents;

  const amount = Number(cents);
  if (!Number.isFinite(amount)) return cents;

  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Spec-compliant runtimes throw RangeError on an unknown currency code.
    return `${cents} ${code}`;
  }

  // Bun tolerates unknown codes instead of throwing and renders the code
  // literally ("XYZ 24.99", with a (non-breaking) space). Detect that and
  // use the same fallback shape.
  const sep = formatted[code.length] ?? "";
  if (formatted.startsWith(code) && (sep === " " || sep === "\u00a0")) {
    return `${cents} ${code}`;
  }
  return formatted;
}

/** Compact relative time ("just now", "5m ago", "2h ago", "3d ago").
 *  Future timestamps clamp to "just now". */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface ShareTargetValues {
  url: string;
  title: string;
}

/** Parses the Web Share Target query params (D8): title falls back to the
 *  first line of `text` when absent; url falls back to the first http(s)
 *  token in `text` (some share sources put the URL in text only). When the
 *  text-derived title is the URL itself, it is left empty so the server
 *  auto-fills a readable hostname title. */
export function parseShareTarget(params: URLSearchParams): ShareTargetValues {
  const text = params.get("text") ?? "";
  const urlParam = (params.get("url") ?? "").trim();
  const titleParam = (params.get("title") ?? "").trim();

  const url = urlParam || firstUrlToken(text);

  let title = titleParam;
  if (!title) {
    const line = firstLine(text);
    title = line === url ? "" : line;
  }
  return { url, title };
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line;
}

function firstUrlToken(text: string): string {
  const match = /\bhttps?:\/\/[^\s]+/.exec(text);
  if (!match) return "";
  return match[0].replace(/[),.;]+$/, "");
}