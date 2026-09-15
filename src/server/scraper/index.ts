/**
 * The scrape pipeline entry point (research §113-144): fetch → parse.
 * Partial results are success — title-only extraction is a usable item.
 */

import { extractProduct, type ParsedProduct } from "./parse";
import { fetchPage, type FetchFailure } from "./fetch";
import type { SearxngFetch as FetchLike } from "../searxng";

export type ScrapeResult =
  | { ok: true; product: ParsedProduct; finalUrl: string }
  | FetchFailure;

export interface ScrapeDeps {
  userAgent: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Explicit opt-in to allow private/loopback targets (tests use local
   *  Bun.serve servers on 127.0.0.1). Never a silent global. */
  allowPrivate?: boolean;
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