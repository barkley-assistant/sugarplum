import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  stealthFetch,
  createStealthDeps,
  type StealthRunner,
  type StealthDeps,
  type ProcessKillFn,
} from "../src/server/scraper/stealth";

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
});
