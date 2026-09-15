/**
 * Stealth-browser scrape client. Spawns `scripts/stealth-fetch.py` (a Python
 * 3.11 + invisible_playwright helper) via Bun.spawn and maps its stdout JSON
 * verdict into the existing FetchFailure / success shape used by the rest of
 * the pipeline. See .hermes/plans/wave13-overrides.md §Contracts.
 *
 * Concurrency: process-wide promise-chain mutex — Firefox profile locks would
 * fail a second concurrent launch anyway, so the mutex is defense-in-depth,
 * not the primary gate. Timeout ladder is `timeoutMs + termGraceMs` for
 * SIGTERM, then +5s for SIGKILL (a hard last resort; library teardown via the
 * helper's signal handlers should make SIGKILL unreachable).
 */

import { existsSync } from "node:fs";
import { isPrivateLiteralUrl, finalUrlIsPrivate } from "../net/private-ip";

export interface StealthRunResult {
  /** Whole stdout as a string. */
  stdout: string;
  /** Process exit code; null when killed by a signal. */
  exitCode: number | null;
  /** Signal name when the process was terminated (e.g. "SIGKILL"); else undefined. */
  signal: string | undefined;
}

export type StealthRunner = (
  argv: string[],
  env: Record<string, string>,
) => Promise<StealthRunResult>;

export interface StealthDeps {
  /** Absolute; must exist at call time (gated by statSync). */
  pythonBin: string;
  /** Absolute path to scripts/stealth-fetch.py. */
  scriptPath: string;
  /** Absolute; per-host profile dirs are created inside. */
  profilesDir: string;
  /** Per-scrape budget — fed to the helper as --timeout-ms. */
  timeoutMs: number;
  /** SIGTERM → SIGKILL delay; default 15s. */
  termGraceMs?: number;
  /** Test seam: default uses Bun.spawn. */
  runner?: StealthRunner;
  /** SSRF parity with fetchPage: skip both literal pre-check and post-fetch
   *  final-URL DNS check. Tests opt in; production readConfig never sets it. */
  allowPrivate?: boolean;
}

export type StealthResult =
  | { ok: true; html: string; finalUrl: string }
  | {
      ok: false;
      reason: "network" | "http" | "private-ip";
      heuristic?: string;
      status?: number;
    };

interface HelperVerdict {
  ok: boolean;
  reason?: string;
  html?: string;
  finalUrl?: string;
  status?: number;
  detail?: string;
}

/** Serialize stealth scrapes process-wide. Firefox profile locks would
 *  otherwise fail a second concurrent launch; the mutex is defense-in-depth
 *  on top of that hard limit. */
let mutex: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutex.then(fn, fn);
  // Swallow rejections on the chain itself so one failure doesn't poison the
  // next caller; each `next` re-throws independently to its own .then().
  mutex = next.catch(() => undefined);
  return next;
}

const DEFAULT_TERM_GRACE_MS = 15_000;
const SIGKILL_DELAY_MS = 5_000;

/** Default runner: Bun subprocess with the documented argv + env.
 *  The stdout reader can hang on processes killed by SIGKILL (the pipe
 *  never gets EOF cleanly under Bun on Linux), so we drive it with a
 *  short drain race after the process has been reaped. */
async function defaultRunner(
  argv: string[],
  env: Record<string, string>,
): Promise<StealthRunResult> {
  const proc = Bun.spawn(argv, {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = Number(argv[argv.indexOf("--timeout-ms") + 1] ?? "60000");
  const termGraceMs = Number(env.__SUGARPLUM_STEALTH_TERM_GRACE_MS ?? DEFAULT_TERM_GRACE_MS);

  let killed = false;
  let killReason: "term" | "kill" | null = null;

  const termTimer = setTimeout(() => {
    killed = true;
    killReason = "term";
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  }, timeoutMs + termGraceMs);
  const killTimer = setTimeout(() => {
    killReason = "kill";
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs + termGraceMs + SIGKILL_DELAY_MS);

  // Read stdout concurrently with waiting for exit. After exit, give it a
  // brief drain window — if SIGKILL has detached the pipe's EOF, return
  // what we have rather than hanging the runner.
  let stdoutText = "";
  const readPromise = (async () => {
    try {
      stdoutText = await new Response(proc.stdout).text();
    } catch {
      /* ignore — pipe error after kill */
    }
  })();

  const exitCode = await proc.exited;
  clearTimeout(termTimer);
  clearTimeout(killTimer);

  // Reader may still be parked on a pipe whose EOF never came (SIGKILL).
  // Race against a short window so the runner always returns.
  await Promise.race([readPromise, Bun.sleep(250)]);

  return {
    stdout: stdoutText,
    exitCode,
    signal: killed
      ? killReason === "kill"
        ? "SIGKILL"
        : "SIGTERM"
      : undefined,
  };
}

/** Resolve config → deps; undefined when stealth is disabled or the venv
 *  python is missing. `allowPrivate` is read from `config.allowPrivateFetch`
 *  so the SSRF guard stays in one place. */
export interface StealthConfigSource {
  stealthDisabled: boolean;
  stealthTimeoutMs: number;
  stealthProfilesDir: string;
  stealthVenvPython?: string;
  allowPrivateFetch?: boolean;
}

/** repo root = src/server/scraper/stealth.ts → 3 levels up. The venv lives as
 *  a SIBLING of the checkout (<repo>/../.stealth-venv) to survive git resets. */
function repoRootFromHere(): string {
  return new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
}

export function createStealthDeps(config: StealthConfigSource): StealthDeps | undefined {
  if (config.stealthDisabled) return undefined;
  const profilesDir = config.stealthProfilesDir;
  const pythonBin =
    config.stealthVenvPython && config.stealthVenvPython.length > 0
      ? config.stealthVenvPython
      : `${repoRootFromHere()}/../.stealth-venv/bin/python`;
  return {
    pythonBin,
    scriptPath: `${repoRootFromHere()}/scripts/stealth-fetch.py`,
    profilesDir,
    timeoutMs: config.stealthTimeoutMs,
    runner: defaultRunner,
    allowPrivate: config.allowPrivateFetch ?? false,
  };
}

/** One stealth fetch attempt. Never throws — every outcome maps into the
 *  shape below so the strategy pipeline can fall through cleanly. */
export async function stealthFetch(url: string, deps: StealthDeps): Promise<StealthResult> {
  // SSRF parity with fetchPage: literal pre-check, final-URL check after a
  // successful run. Both skipped when the test/operator opt-in is set.
  if (!deps.allowPrivate && isPrivateLiteralUrl(url)) {
    return { ok: false, reason: "private-ip" };
  }
  if (!existsSync(deps.pythonBin)) {
    return { ok: false, reason: "network", heuristic: "stealth-unavailable" };
  }

  return withLock(async () => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PYTHONUNBUFFERED: "1",
      __SUGARPLUM_STEALTH_TERM_GRACE_MS: String(deps.termGraceMs ?? DEFAULT_TERM_GRACE_MS),
    };
    const argv = [
      deps.pythonBin,
      deps.scriptPath,
      url,
      "--timeout-ms",
      String(deps.timeoutMs),
      "--profiles-dir",
      deps.profilesDir,
    ];
    const runner = deps.runner ?? defaultRunner;
    let result: StealthRunResult;
    try {
      result = await runner(argv, env);
    } catch {
      return { ok: false, reason: "network", heuristic: "stealth-spawn-error" } as const;
    }

    // Helper contract: exit 0 ⇒ a JSON verdict was printed. Anything else is
    // an unmanaged death (signal, hard crash).
    if (result.exitCode !== 0) {
      const sig = result.signal ? `-${result.signal}` : `-${result.exitCode ?? "null"}`;
      return { ok: false, reason: "network", heuristic: `stealth-exit${sig}` } as const;
    }

    let verdict: HelperVerdict;
    try {
      verdict = JSON.parse(result.stdout) as HelperVerdict;
    } catch {
      return { ok: false, reason: "network", heuristic: "stealth-parse-error" } as const;
    }

    if (verdict.ok === true) {
      const finalUrl = verdict.finalUrl ?? url;
      if (!deps.allowPrivate && (await finalUrlIsPrivate(finalUrl))) {
        return { ok: false, reason: "private-ip" } as const;
      }
      return {
        ok: true,
        html: verdict.html ?? "",
        finalUrl,
      };
    }

    // Managed failure mapping (helper JSON → FetchFailure reasons).
    switch (verdict.reason) {
      case "http":
        return {
          ok: false,
          reason: "http",
          status: verdict.status,
        } as const;
      case "challenged":
        return {
          ok: false,
          reason: "network",
          heuristic: "stealth-challenged",
        } as const;
      case "timeout":
        return {
          ok: false,
          reason: "network",
          heuristic: "stealth-timeout",
        } as const;
      case "error":
      default:
        return {
          ok: false,
          reason: "network",
          heuristic: "stealth-error",
        } as const;
    }
  });
}
