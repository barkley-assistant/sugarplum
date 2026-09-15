/**
 * Page fetch with a desktop UA, timeout, redirect-following, and bot-wall
 * detection. The bot-wall heuristic consults BOTH the status and the body:
 * eBay 403s arrive with an error page, Amazon 200s arrive with a captcha —
 * either signal alone misclassifies.
 */

import { isPrivateLiteralUrl, finalUrlIsPrivate } from "../net/private-ip";
// Bun's `typeof fetch` has extra static members (e.g. preconnect) that make
// test stubs awkward; SearxngFetch is the structural fetch type the codebase
// already uses for that reason (see src/server/searxng.ts).
import type { SearxngFetch as FetchLike } from "../searxng";

export type FetchFailure =
  | {
      ok: false;
      reason: "network" | "http" | "botwall" | "empty" | "private-ip";
      status?: number;
      heuristic?: string;
    };

export interface FetchPageOptions {
  userAgent: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Explicit opt-in to allow private/loopback targets (tests use local
   *  Bun.serve servers on 127.0.0.1). Never a silent global. */
  allowPrivate?: boolean;
  /** Merged AFTER the default headers (override wins per key). Used by the
   *  custom-headers strategy from the per-site override registry. */
  extraHeaders?: Record<string, string>;
}

export type FetchPageResult =
  | { ok: true; html: string; finalUrl: string }
  | FetchFailure;

/** Matched heuristic NAME only — the body itself is never stored or logged. */
const BOT_WALL_PATTERNS: [RegExp, string][] = [
  [/validatecaptcha/, "validatecaptcha"],
  [/datadome/, "datadome"],
  [/px-captcha/, "px-captcha"],
  [/perimeterx/, "perimeterx"],
  [/access denied/, "access denied"],
  [/robot or human/, "robot or human"],
  [/are you a human/, "are you a human"],
  [/attention required/, "attention required"],
  [/akamai/, "akamai"],
  [/captcha/, "captcha"],
  // Imperva Incapsula — specific markers; matches `/_Incapsula_Resource?...`
  // and `distil_referrer` (case-insensitive via the lowercased sample at the
  // call site) without false-matching the bare word "distil".
  [/\/_?incapsula_resource|distil_referrer/, "incapsula"],
];

/** Lowercases the first ~4KB of the body and reports the matched heuristic. */
export function detectBotWall(html: string): string | null {
  const sample = html.slice(0, 4096).toLowerCase();
  for (const [re, name] of BOT_WALL_PATTERNS) {
    if (re.test(sample)) return name;
  }
  return null;
}

export async function fetchPage(url: string, opts: FetchPageOptions): Promise<FetchPageResult> {
  // SSRF guard, pre-fetch: literal private/loopback host → reject before any
  // network I/O. Skipped only by the explicit allowPrivate opt-in.
  if (!opts.allowPrivate && isPrivateLiteralUrl(url)) {
    return { ok: false, reason: "private-ip" };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        "User-Agent": opts.userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
        ...(opts.extraHeaders ?? {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch {
    // Abort (timeout), connection refused, DNS failure — all "network".
    return { ok: false, reason: "network" };
  }

  // SSRF guard, post-fetch: redirects were followed, so check the FINAL url.
  // Literal private → reject; otherwise one DNS lookup — any resolved private
  // address → reject. (The fetch already happened, but the result is dropped
  // before the body is read or parsed.)
  const finalUrl = res.url || url;
  if (!opts.allowPrivate && (await finalUrlIsPrivate(finalUrl))) {
    return { ok: false, reason: "private-ip" };
  }

  let html: string;
  try {
    html = await res.text();
  } catch {
    // Headers arrived but the body stalled or reset mid-read (a server that
    // sends headers then never closes the stream). Same class of failure as
    // the fetch itself — "network", never a throw out of the pipeline.
    return { ok: false, reason: "network" };
  }

  const heuristic = detectBotWall(html);
  if (heuristic) return { ok: false, reason: "botwall", status: res.status, heuristic };
  if (res.status >= 400) return { ok: false, reason: "http", status: res.status };

  // Bodies under 2KB are candidates for "empty", but the pipeline decides:
  // parse-first keeps tiny-but-valid pages honest.
  return { ok: true, html, finalUrl };
}