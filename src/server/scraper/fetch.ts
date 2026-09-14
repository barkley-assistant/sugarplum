/**
 * Page fetch with a desktop UA, timeout, redirect-following, and bot-wall
 * detection. The bot-wall heuristic consults BOTH the status and the body:
 * eBay 403s arrive with an error page, Amazon 200s arrive with a captcha —
 * either signal alone misclassifies.
 */

export type FetchFailure =
  | {
      ok: false;
      reason: "network" | "http" | "botwall" | "empty";
      status?: number;
      heuristic?: string;
    };

export interface FetchPageOptions {
  userAgent: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
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
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        "User-Agent": opts.userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch {
    // Abort (timeout), connection refused, DNS failure — all "network".
    return { ok: false, reason: "network" };
  }

  const finalUrl = res.url || url;
  const html = await res.text();

  const heuristic = detectBotWall(html);
  if (heuristic) return { ok: false, reason: "botwall", status: res.status, heuristic };
  if (res.status >= 400) return { ok: false, reason: "http", status: res.status };

  // Bodies under 2KB are candidates for "empty", but the pipeline decides:
  // parse-first keeps tiny-but-valid pages honest.
  return { ok: true, html, finalUrl };
}