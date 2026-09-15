import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  stealthFetch,
  createStealthDeps,
  type StealthRunner,
  type StealthDeps,
  type ProcessKillFn,
} from "../src/server/scraper/stealth";

/** Bun-friendly fs wrappers (the bun:test file already runs in Bun, so
 *  these map to fs/promises via the global Bun.* API surface that the
 *  tests use elsewhere). Keep them local so the file is self-contained. */
async function mkdtemp(prefix: string): Promise<string> {
  return mkdtempSync(prefix);
}
async function writeFile(path: string, content: string): Promise<void> {
  writeFileSync(path, content);
}
async function readFile(path: string, _enc: string): Promise<string> {
  return readFileSync(path, "utf-8");
}

function deps(
  runner: StealthRunner,
  extra: Partial<StealthDeps> = {},
): StealthDeps {
  return {
    pythonBin: "/bin/true",
    scriptPath: "/repo/scripts/stealth-fetch.py",
    profilesDir: "/tmp/profiles",
    timeoutMs: 1000,
    runner,
    allowPrivate: true,
    ...extra,
  };
}

describe("stealth client", () => {
  test("ok:true stdout → {ok:true, html, finalUrl}; argv carries url + flags", async () => {
    let argv: string[] = [];
    const runner: StealthRunner = async (a) => {
      argv = a;
      return {
        stdout: JSON.stringify({
          ok: true,
          html: "<html>x</html>",
          finalUrl: "https://www.smythstoys.com/p/1",
          status: 200,
        }),
        exitCode: 0,
        signal: undefined,
      };
    };
    const r = await stealthFetch("https://www.smythstoys.com/p/1", deps(runner));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).toBe("<html>x</html>");
      expect(r.finalUrl).toBe("https://www.smythstoys.com/p/1");
    }
    expect(argv[0]).toBe("/bin/true");
    expect(argv).toContain("https://www.smythstoys.com/p/1");
    expect(argv).toContain("--timeout-ms");
    expect(argv).toContain("--profiles-dir");
  });

  test("helper {ok:false,reason:'timeout'} exit 0 → network/stealth-timeout", async () => {
    const r = await stealthFetch(
      "https://www.smythstoys.com/p/1",
      deps(async () => ({
        stdout: JSON.stringify({ ok: false, reason: "timeout" }),
        exitCode: 0,
        signal: undefined,
      })),
    );
    expect(r).toEqual({ ok: false, reason: "network", heuristic: "stealth-timeout" });
  });

  test("helper {ok:false,reason:'http',status:404} → http + status", async () => {
    const r = await stealthFetch(
      "https://www.smythstoys.com/p/1",
      deps(async () => ({
        stdout: JSON.stringify({ ok: false, reason: "http", status: 404 }),
        exitCode: 0,
        signal: undefined,
      })),
    );
    expect(r).toEqual({ ok: false, reason: "http", status: 404 });
  });

  test("helper {ok:false,reason:'challenged'} → network/stealth-challenged", async () => {
    const r = await stealthFetch(
      "https://www.smythstoys.com/p/1",
      deps(async () => ({
        stdout: JSON.stringify({ ok: false, reason: "challenged" }),
        exitCode: 0,
        signal: undefined,
      })),
    );
    expect(r).toEqual({ ok: false, reason: "network", heuristic: "stealth-challenged" });
  });

  test("unmanaged death (exit 9, garbage stdout) → network/stealth-exit-9", async () => {
    const r = await stealthFetch(
      "https://www.smythstoys.com/p/1",
      deps(async () => ({ stdout: "Traceback ...", exitCode: 9, signal: undefined })),
    );
    expect(r).toEqual({ ok: false, reason: "network", heuristic: "stealth-exit-9" });
  });

  test("unparseable stdout on exit 0 → network/stealth-parse-error", async () => {
    const r = await stealthFetch(
      "https://www.smythstoys.com/p/1",
      deps(async () => ({ stdout: "not json", exitCode: 0, signal: undefined })),
    );
    expect(r).toEqual({ ok: false, reason: "network", heuristic: "stealth-parse-error" });
  });

  test("missing pythonBin → network/stealth-unavailable, runner NOT called", async () => {
    let called = 0;
    const r = await stealthFetch("https://www.smythstoys.com/p/1", {
      pythonBin: "/definitely/not/here/python",
      scriptPath: "/s",
      profilesDir: "/tmp/p",
      timeoutMs: 1000,
      allowPrivate: true,
      runner: async () => {
        called++;
        return { stdout: "", exitCode: 0, signal: undefined };
      },
    });
    expect(r).toEqual({ ok: false, reason: "network", heuristic: "stealth-unavailable" });
    expect(called).toBe(0);
  });

  test("private-literal URL → private-ip before any spawn (allowPrivate unset)", async () => {
    const r = await stealthFetch(
      "http://127.0.0.1:9/x",
      deps(async () => {
        throw new Error("must not run");
      }, { allowPrivate: false }),
    );
    expect(r).toEqual({ ok: false, reason: "private-ip" });
  });

  test("mutex: two concurrent calls never overlap", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: StealthRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(50);
      active--;
      return {
        stdout: JSON.stringify({ ok: false, reason: "timeout" }),
        exitCode: 0,
        signal: undefined,
      };
    };
    await Promise.all([
      stealthFetch("https://www.smythstoys.com/a", deps(runner)),
      stealthFetch("https://www.smythstoys.com/b", deps(runner)),
    ]);
    expect(maxActive).toBe(1);
  });

  test("createStealthDeps: disabled → undefined; env override wins over default path", () => {
    expect(
      createStealthDeps({
        stealthDisabled: true,
        stealthTimeoutMs: 60000,
        stealthProfilesDir: "/tmp/p",
      } as Parameters<typeof createStealthDeps>[0]),
    ).toBeUndefined();
    const d = createStealthDeps({
      stealthDisabled: false,
      stealthTimeoutMs: 5000,
      stealthProfilesDir: "/tmp/p",
      stealthVenvPython: "/x/python",
    } as Parameters<typeof createStealthDeps>[0]);
    expect(d?.pythonBin).toBe("/x/python");
    expect(d?.timeoutMs).toBe(5000);
    expect(d?.profilesDir).toBe("/tmp/p");
    expect(d?.allowPrivate).toBe(false); // default when allowPrivateFetch unset
  });

  test(
    "default runner: SIGTERM-ignoring child → SIGTERM→SIGKILL ladder → network failure",
    async () => {
      // The helper contract makes argv[0] the executable; a trap script
      // that ignores TERM and sleeps is a faithful fake for a stuck browser.
      const trap = join(import.meta.dir, "fixtures", "stealth-trap.sh");
      const r = await stealthFetch("https://www.smythstoys.com/p/1", {
        pythonBin: trap,
        scriptPath: "ignored-by-trap-script",
        profilesDir: "/tmp/p",
        timeoutMs: 300,
        termGraceMs: 200,
        allowPrivate: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("network");
        // Heuristic carries the signal name from the ladder (SIGKILL after
        // SIGTERM-ignore).
        expect(String(r.heuristic)).toMatch(/^stealth-/);
      }
    },
    15_000,
  );

  test(
    "regression (BLOCKING 1): helper exits non-zero with no JSON → bounded wait + stealth-exit-* verdict",
    async () => {
      // BLOCKING 1 from the wave-13 review: when the SIGALRM watchdog races
      // the goto timeout, the alarm's unwind can wedge the playwright driver
      // and the helper hangs forever with no JSON. This test exercises the
      // post-fix path through the default runner with a helper that simply
      // dies (no JSON, non-zero exit) and asserts the runner bounds the wait
      // instead of blocking forever on an EOF that never arrives.
      //
      // /bin/false exits 1 with no stdout — the worst-case "helper crashed
      // before printing JSON" scenario. Large timeoutMs so the ladder never
      // fires; only the post-exit drain race bounds the wait.
      const start = Date.now();
      const r = await stealthFetch("https://www.smythstoys.com/p/1", {
        pythonBin: "/bin/false",
        scriptPath: "ignored",
        profilesDir: "/tmp/p",
        timeoutMs: 60_000,
        allowPrivate: true,
      });
      const elapsed = Date.now() - start;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("network");
        // Non-zero exit with no JSON → stealth-exit-{code}.
        expect(String(r.heuristic)).toMatch(/^stealth-exit-/);
      }
      // 250ms drain race caps the post-exit wait; full call overhead is
      // sub-second on any reasonable machine.
      expect(elapsed).toBeLessThan(2_000);
    },
    5_000,
  );

  test(
    "regression (BLOCKING 2): SIGTERM-ignoring child → both ladder rungs address the whole process group (-pid)",
    async () => {
      // BLOCKING 2 from the wave-13 review: SIGTERM only killed the Python
      // child; Firefox/Xvfb were orphaned and SIGKILL never fired because the
      // child was already dead. The fix is `detached: true` + kill(-pid, sig)
      // on both ladder rungs so the kernel sends the signal to every member
      // of the helper's group.
      //
      // We inject processKill to record every kill call. We forward to the
      // real process.kill too, so the trap actually dies and the runner
      // returns — without the real kill the trap would sleep through the
      // ladder and proc.exited would never resolve.
      const calls: Array<{ pid: number; sig: NodeJS.Signals }> = [];
      const realKill: ProcessKillFn = (pid, sig) => process.kill(pid, sig);
      const trap = join(import.meta.dir, "fixtures", "stealth-trap.sh");
      await stealthFetch("https://www.smythstoys.com/p/1", {
        pythonBin: trap,
        scriptPath: "ignored-by-trap-script",
        profilesDir: "/tmp/p",
        timeoutMs: 100,
        termGraceMs: 100,
        killDelayMs: 100,
        allowPrivate: true,
        processKill: (pid, sig) => {
          calls.push({ pid, sig });
          return realKill(pid, sig);
        },
      });
      expect(calls.length).toBe(2);
      // Both rungs address the whole group (negative pid). A positive pid
      // here would mean "just this process" — the pre-fix bug.
      expect(calls[0]?.pid).toBeLessThan(0);
      expect(calls[0]?.sig).toBe("SIGTERM");
      expect(calls[1]?.pid).toBeLessThan(0);
      expect(calls[1]?.sig).toBe("SIGKILL");
      // The two pids are the same group; on POSIX the negative pid equals
      // -pgid, so both rungs target the same group leader.
      expect(calls[0]?.pid).toBe(calls[1]?.pid);
    },
    10_000,
  );

  // ─────────────────────────────────────────────────────────────────────
  // BLOCKING 2 (round 2) — Xvfb orphan reaper.
  //
  // The original BLOCKING 2 fix killed the helper's PROCESS GROUP, which
  // reaped Firefox but not Xvfb (invisible_core spawns Xvfb with
  // start_new_session=True → Xvfb is in its own session, not the
  // helper's). The round-2 fix adds a detached helper-side reaper that
  // survives the helper's death and kills any Xvfb matching the helper's
  // DISPLAY number. These tests cover that fix end-to-end.
  // ─────────────────────────────────────────────────────────────────────

  const REPO_ROOT = join(import.meta.dir, "..");
  const STEALTH_HELPER = join(REPO_ROOT, "scripts", "stealth-fetch.py");
  const FAKE_INVISIBLE_PLAYWRIGHT_DIR = join(
    import.meta.dir,
    "fixtures",
  );
  const REAP_TRIGGER = join(import.meta.dir, "fixtures", "stealth-reap-trigger.py");

  /** Spawn the Python helper in --xvfb-reap-test mode and return its parsed
   *  JSON verdict. */
  async function runXvfbReapTest(args: {
    display: string;
    fakePs: Array<[number, string]>;
  }): Promise<{ display: string; matched: number[]; killed: number[] }> {
    const scanFile = join(
      await mkdtemp(join(tmpdir(), "stealth-reap-scan-")),
      "scan.json",
    );
    const killFile = join(
      await mkdtemp(join(tmpdir(), "stealth-reap-kill-")),
      "kills.txt",
    );
    await writeFile(scanFile, JSON.stringify(args.fakePs));
    const proc = Bun.spawn(
      [
        "python3",
        STEALTH_HELPER,
        "--xvfb-reap-test",
        `--display=${args.display}`,
        `--scan-json-file=${scanFile}`,
        `--kill-record-file=${killFile}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    return JSON.parse(out.trim());
  }

  test(
    "regression (BLOCKING 2 r2): reap_xvfb_by_display kills ONLY Xvfb matching the display; never blanket-pkill",
    async () => {
      // Matching logic, synchronous mode (no fork). The fake ps output
      // contains four candidates; only one is a real Xvfb on the target
      // display. The reaper must kill exactly that one.
      const r = await runXvfbReapTest({
        display: ":99",
        fakePs: [
          [1234, "/usr/bin/Xvfb :99 -screen 0 1280x720x24"], // match
          [5678, "/usr/bin/Xvfb :100 -screen 0 1280x720x24"], // wrong display
          [9999, "grep Xvfb :99 something"],                  // not Xvfb basename
          [8888, "Xvfb-launcher.sh :99"],                     // basename != 'Xvfb'
        ],
      });
      expect(r.display).toBe(":99");
      expect(r.matched).toEqual([1234]);
      expect(r.killed).toEqual([1234]);
    },
    10_000,
  );

  test(
    "regression (BLOCKING 2 r2): reap_xvfb_by_display is a no-op for empty / invalid display (never blanket-pkill)",
    async () => {
      // Empty DISPLAY (no scan at all) and non-numeric suffix must both
      // short-circuit to a no-op. This is the safety net against
      // accidental pkill if DISPLAY is unset or malformed.
      const empty = await runXvfbReapTest({ display: "", fakePs: [] });
      expect(empty.matched).toEqual([]);
      expect(empty.killed).toEqual([]);

      const bogus = await runXvfbReapTest({
        display: ":not-a-number",
        fakePs: [[1234, "/usr/bin/Xvfb :99"]],
      });
      expect(bogus.matched).toEqual([]);
      expect(bogus.killed).toEqual([]);
    },
    10_000,
  );

  test(
    "regression (BLOCKING 2 r2): live reaper — forked child survives parent exit and kills matching Xvfb",
    async () => {
      // End-to-end: spawn the trigger script which forks the reaper and
      // then os._exit(0)s. The reaper (detached via setsid) detects the
      // parent's death and kills the matching Xvfb via the env-injected
      // fake. The kill-record file is the assertion surface.
      const killRecord = join(
        await mkdtemp(join(tmpdir(), "stealth-reap-record-")),
        "kills.txt",
      );
      const proc = Bun.spawn(
        [
          "python3",
          REAP_TRIGGER,
          "--fake-ps",
          JSON.stringify([
            [1234, "/usr/bin/Xvfb :99 -screen 0 1280x720x24"],
            [5678, "/usr/bin/Xvfb :100 -screen 0 1280x720x24"],
            [9999, "grep Xvfb :99"],
            [8888, "Xvfb-launcher.sh :99"],
          ]),
          "--kill-record",
          killRecord,
          "--display",
          ":99",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      const reaperPid = parseInt(out.trim(), 10);
      expect(Number.isFinite(reaperPid)).toBe(true);
      expect(reaperPid).toBeGreaterThan(0);

      // Wait for the trigger to exit AND for the reaper to do its work.
      // The trigger waits settle-ms (default 300ms) before os._exit; the
      // reaper polls every 500ms, so add generous headroom.
      const triggerExit = await proc.exited;
      expect(triggerExit).toBe(0);
      await Bun.sleep(2_500);

      const killed = (await readFile(killRecord, "utf-8")).trim().split("\n").filter(Boolean);
      // Order isn't guaranteed (single match here so sort first).
      expect(killed.sort()).toEqual(["1234"]);
    },
    15_000,
  );

  test(
    "regression (BLOCKING 2 r2): SIGTERM hits helper → os._exit(3) bypasses the with-block __exit__ wedge",
    async () => {
      // Pre-fix, _on_term was `raise SystemExit(3)`, which unwinds through
      // the with-block __exit__. With a wedged __exit__ (we simulate one
      // via the fake invisible_playwright's 10s sleep), the helper hangs
      // for the full wedge duration. The fix is `os._exit(3)` directly,
      // which terminates the process without touching __exit__.
      //
      // Test setup: PYTHONPATH points at the fake invisible_playwright,
      // which in 'wedge' mode sleeps 10s inside __exit__. We send
      // SIGTERM while the helper is sleeping in __exit__ (i.e. after a
      // normal completion of the scrape body). The pre-fix code would
      // block on __exit__ for the full wedge; the post-fix code
      // bypasses __exit__ via os._exit(3) and exits 3 within a second.
      //
      // --timeout-ms is large (60s) so the SIGALRM alarm never fires;
      // --challenge-wait-ms is tiny (1ms) so the inner poll loop is a
      // no-op. The helper races through the scrape body, prints its
      // JSON verdict (which we discard), then enters __exit__. We send
      // SIGTERM shortly after that.
      const proc = Bun.spawn(
        [
          "python3",
          STEALTH_HELPER,
          "https://example.com",
          "--timeout-ms",
          "60000",
          "--challenge-wait-ms",
          "1",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PYTHONPATH: FAKE_INVISIBLE_PLAYWRIGHT_DIR,
            SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_MODE: "wedge",
            SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_WEDGE_SECONDS: "10",
          },
        },
      );
      // Race window: the helper reaches __exit__ quickly (fake __enter__
      // + new_page + goto + content + JSON print + return all take
      // milliseconds). Give it a small delay so we're inside the
      // __exit__ wedge, then SIGTERM.
      await Bun.sleep(300);
      const start = Date.now();
      proc.kill("SIGTERM");
      const exit = await proc.exited;
      const elapsed = Date.now() - start;
      // os._exit(3) bypasses the 10s __exit__ wedge — bounded below 5s
      // even on a slow CI box. The pre-fix code would take ≥8s here.
      expect(elapsed).toBeLessThan(5_000);
      expect(exit).toBe(3);
      // Drain stdout/stderr so the pipes don't block.
      await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    },
    15_000,
  );

  test(
    "regression (BLOCKING 2 r2): SIGTERM after a goto-wedge → playwright TimeoutError still resolves to managed JSON verdict",
    async () => {
      // Companion to the wedge test above: when the wedge is INSIDE
      // page.goto() (real playwright TimeoutError), the helper's
      // existing managed-failure path prints a timeout JSON verdict and
      // exits 0 — the SIGTERM handler must not interfere with that
      // managed path. This is the BLOCKING-1 fix verified end-to-end
      // through the new fake.
      const proc = Bun.spawn(
        [
          "python3",
          STEALTH_HELPER,
          "https://example.com",
          // goto timeout = 60000 - 3000 = 57000ms, but the fake raises
          // after the first sleep(0.5) so the helper sees the
          // TimeoutError within ~500ms. alarm budget (60s) is well
          // above; SIGTERM ladder never fires.
          "--timeout-ms",
          "60000",
          "--challenge-wait-ms",
          "1",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PYTHONPATH: FAKE_INVISIBLE_PLAYWRIGHT_DIR,
            SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_MODE: "goto-wedge",
            SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_WEDGE_SECONDS: "0.5",
          },
        },
      );
      const exit = await proc.exited;
      expect(exit).toBe(0);
      const stdout = (await new Response(proc.stdout).text()).trim();
      const verdict = JSON.parse(stdout) as { ok: boolean; reason?: string };
      // The fake's goto-wedge raises TimeoutError which the helper maps
      // to {ok: false, reason: "error", detail: ...}. The exact shape is
      // stable in tests.
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe("error");
    },
    15_000,
  );
});
