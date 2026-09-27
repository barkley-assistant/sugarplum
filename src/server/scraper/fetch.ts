/**
 * Page fetch with a desktop UA, timeout, redirect-following, and bot-wall
 * detection. The bot-wall heuristic consults BOTH the status and the body:
 * eBay 403s arrive with an error page, Amazon 200s arrive with a captcha —
 * either signal alone misclassifies.
 *
 * A fetch that never produces a response, or whose body dies mid-read, comes
 * back as `reason: "network"` with a `heuristic` naming the transport failure
 * (`classifyFetchError`): `timeout` | `conn-reset` | `dns` | `refused` |
 * `unknown`. The scrape chain's escalation gate (`isEscalatableStep`) and the
 * enrichment log (`strategy:reason/heuristic`) are the consumers — a name is
 * all that is ever recorded, never the error body.
 *
 * Akamai Bot Manager (`akamai-bm`, #172): Inditex shops answer a plain fetch
 * with a 2KB challenge body that carries the bm-verify token in a meta refresh,
 * so a 200 alone does not mean the page arrived.
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
  // "akamai" removed 2026-09-15 (wave 14): it never matched eBay's actual block
  // body (the AkamaiGHost marker is a response header, unseen here) and it
  // false-positived on legit pages loading assets from *.akamai.steamstatic.com.
  [/captcha/, "captcha"],
  // Imperva Incapsula — specific markers; matches `/_Incapsula_Resource?...`
  // and `distil_referrer` (case-insensitive via the lowercased sample at the
  // call site) without false-matching the bare word "distil".
  [/\/_?incapsula_resource|distil_referrer/, "incapsula"],
  // Akamai Bot Manager interstitial (measured on Bershka 2026-09-27: HTTP 200,
  // 2,381 bytes, no redirect). ONE grouped pattern and ONE name: the four
  // markers all appear in the same 2KB body, and the operator needs "this is
  // the Akamai Bot Manager family", not which byte matched first. Still no
  // bare `akamai` (see the removal note above) — none of these four is a
  // substring of `akamai.steamstatic.com`.
  [/bm-verify|_sec\/verify|triggerinterstitialchallenge|interstitial\/ic\.html/, "akamai-bm"],
];

/** Lowercases the first ~4KB of the body and reports the matched heuristic. */
export function detectBotWall(html: string): string | null {
  const sample = html.slice(0, 4096).toLowerCase();
  for (const [re, name] of BOT_WALL_PATTERNS) {
    if (re.test(sample)) return name;
  }
  return null;
}

/** Transport-failure prose that arrives WITHOUT a usable `code` — a wrapped or
 *  cross-realm error, or the HTTP/2 session/stream family (prose only: from
 *  this host Bun's fetch surfaces an HTTP/2 refusal as a stall, measured
 *  2026-09-27). All case-insensitive. Order matters: reset is tested before
 *  dns/refused so a socket kill is never mistaken for a host that is not
 *  there. */
const RESET_TEXT = /reset|not closed cleanly|INTERNAL_ERROR|session|stream|socket/i;
const DNS_TEXT = /getaddrinfo|ENOTFOUND|EAI_AGAIN|dns/i;
const REFUSED_TEXT = /ECONNREFUSED|refused/i;

/** A wrapped error's cause, as text. `cause` may be a getter that throws, so
 *  reading it is inside the try — the classifier must never throw. */
function describedCause(err: unknown): string {
  try {
    const cause = (err as { cause?: unknown })?.cause;
    if (cause === null || cause === undefined) return "";
    return String((cause as { message?: unknown })?.message ?? cause);
  } catch {
    return "";
  }
}

/**
 * Name the transport failure behind a thrown fetch/body error. First match
 * wins, so the specific `code`s are checked before the text fallbacks.
 *
 * `code` must be read with `typeof === "string"`, never truthiness: a
 * DOMException (what `AbortSignal.timeout` throws) carries a NUMERIC legacy
 * `code` of 23, which is not one of the transport codes. Never throws.
 */
export function classifyFetchError(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof e?.name === "string" ? e.name : "";
  const code = typeof e?.code === "string" ? e.code : "";
  const text = `${typeof e?.message === "string" ? e.message : ""} ${describedCause(e)}`;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (code === "ECONNRESET") return "conn-reset";
  if (code === "ConnectionRefused") return "refused";
  if (code === "ENOTFOUND") return "dns";
  if (RESET_TEXT.test(text)) return "conn-reset";
  if (DNS_TEXT.test(text)) return "dns";
  if (REFUSED_TEXT.test(text)) return "refused";
  return "unknown";
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
  } catch (err) {
    // Abort (timeout), connection refused, DNS failure, a reset socket — all
    // "network"; the heuristic names WHICH, so the chain can tell a
    // fingerprint block (the host answered, the transport was killed) from a
    // host that is genuinely not reachable.
    return { ok: false, reason: "network", heuristic: classifyFetchError(err) };
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
  } catch (err) {
    // Headers arrived but the body stalled or reset mid-read (a server that
    // sends headers then never closes the stream). Same class of failure as
    // the fetch itself — "network", never a throw out of the pipeline. Same
    // classifier: the signal that fires on a stall is the timeout, a socket
    // killed mid-body is ECONNRESET (measured 2026-09-27).
    return { ok: false, reason: "network", heuristic: classifyFetchError(err) };
  }

  const heuristic = detectBotWall(html);
  if (heuristic) return { ok: false, reason: "botwall", status: res.status, heuristic };
  if (res.status >= 400) return { ok: false, reason: "http", status: res.status };

  // Bodies under 2KB are candidates for "empty", but the pipeline decides:
  // parse-first keeps tiny-but-valid pages honest.
  return { ok: true, html, finalUrl };
}