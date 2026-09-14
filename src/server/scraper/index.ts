/**
 * The scrape pipeline entry point (research §113-144): fetch → parse.
 * Partial results are success — title-only extraction is a usable item.
 */

import { extractProduct, type ParsedProduct } from "./parse";
import { fetchPage, type FetchFailure } from "./fetch";

export type ScrapeResult =
  | { ok: true; product: ParsedProduct; finalUrl: string }
  | FetchFailure;

export interface ScrapeDeps {
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function scrapeProduct(url: string, deps: ScrapeDeps): Promise<ScrapeResult> {
  const page = await fetchPage(url, deps);
  if (!page.ok) return page;

  const product = await extractProduct(page.html, page.finalUrl);
  if (product.title === null && product.image === null) {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, product, finalUrl: page.finalUrl };
}