import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  stealthFetch,
  createStealthDeps,
  type StealthRunner,
  type StealthDeps,
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
});
