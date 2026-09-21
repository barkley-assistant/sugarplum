// #103 — plain → stealth auto-escalation (tier 1) and learned overrides
// (tier 2). Every fetch and every browser run here is a local stub: the tests
// exercise chain resolution, promotion, decay and demotion without touching
// the network, and re-assert that the committed registry hosts are unchanged.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/server/db/db";
import { scrapeProduct } from "../src/server/scraper";
import {
  ESCALATABLE_FAILURES,
  LEARNED_PROMOTION_THRESHOLD,
  readLearned,
  recordScrapeOutcome,
  type ScrapeStep,
} from "../src/server/scraper/learned";
import type { StealthDeps, StealthRunner } from "../src/server/scraper/stealth";
import type { SearxngFetch } from "../src/server/searxng";

const FIXTURES = join(import.meta.dir, "fixtures");
/** No registry entry, and never a real HTTP request: every fetch is stubbed. */
const PAGE_URL = "https://shop.example.test/itm/1";
const HOST = "shop.example.test";

interface LearnedRow {
  hostname: string;
  strategies: string | null;
  escalation_count: number;
  learned_at: string | null;
  last_escalated_at: string;
  last_demoted_at: string | null;
  successful_stealth_fetches: number;
}

function freshDb(): Database {
  return openDatabase(":memory:");
}

async function shopifyHtml(): Promise<string> {
  return Bun.file(join(FIXTURES, "shopify.html")).text();
}

/** A stub transport whose response can be any status; `url` is the page URL
 *  the parse tier resolves relative links against. */
function stubFetch(status: number, body: string, url = PAGE_URL): SearxngFetch {
  return async () => {
    const res = new Response(body, { status });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
}

/** Counts every plain attempt so a test can prove the chain skipped it. */
function countingFetch(inner: SearxngFetch, calls: { n: number }): SearxngFetch {
  return async (input, init) => {
    calls.n++;
    return inner(input, init);
  };
}

function stealthStub(
  html: string,
  outcome: "ok" | "fail",
  seen: { calls: number },
  finalUrl = PAGE_URL,
): StealthDeps {
  const runner: StealthRunner = async () => {
    seen.calls++;
    const verdict =
      outcome === "ok"
        ? { ok: true, html, finalUrl, status: 200 }
        : { ok: false, reason: "timeout" };
    return { stdout: JSON.stringify(verdict), exitCode: 0, signal: undefined };
  };
  return {
    pythonBin: "/bin/true",
    scriptPath: "/s",
    profilesDir: "/tmp/p",
    timeoutMs: 1000,
    runner,
    allowPrivate: true,
  };
}

function steps(result: { steps: ScrapeStep[] }): string {
  return result.steps.map((s) => `${s.strategy}:${s.ok ? "ok" : (s.reason ?? "?")}`).join(",");
}

function learnedRow(db: Database, hostname = HOST): LearnedRow | undefined {
  return (
    (db
      .query(
        `SELECT hostname, strategies, escalation_count, learned_at, last_escalated_at,
                last_demoted_at, successful_stealth_fetches
         FROM scrape_learned_overrides WHERE hostname = ?`,
      )
      .get(hostname) as LearnedRow | null) ?? undefined
  );
}

/** Seed a promoted (stealth-first) entry, with knobs for the decay tests. */
function seedPromoted(
  db: Database,
  opts: { hostname?: string; learnedAt?: string; stealthFetches?: number } = {},
): void {
  db.run(
    `INSERT INTO scrape_learned_overrides
       (hostname, strategies, escalation_count, learned_at, last_escalated_at, successful_stealth_fetches)
     VALUES (?, ?, 3, ?, ?, ?)`,
    [
      opts.hostname ?? HOST,
      JSON.stringify(["stealth-browser", "plain"]),
      opts.learnedAt ?? new Date().toISOString(),
      new Date().toISOString(),
      opts.stealthFetches ?? 0,
    ],
  );
}

describe("escalation set (D1)", () => {
  test("botwall, empty and http escalate; network and private-ip do not", () => {
    expect([...ESCALATABLE_FAILURES].sort()).toEqual(["botwall", "empty", "http"]);
    expect(ESCALATABLE_FAILURES.has("network")).toBe(false);
    expect(ESCALATABLE_FAILURES.has("private-ip")).toBe(false);
  });
});

describe("default chain auto-escalation (#103 tier 1)", () => {
  test("wired stealth: plain 403 → stealth retried → success, both steps recorded", async () => {
    const html = await shopifyHtml();
    const seen = { calls: 0 };
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(403, "<html><head><title>Error Page</title></head></html>"),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", seen),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("stealth-browser");
    expect(result.product.title).toBe("Fresh Kiss Trio");
    expect(steps(result)).toBe("plain:http,stealth-browser:ok");
    expect(seen.calls).toBe(1);
  });

  test("wired stealth: plain success short-circuits — no browser launch", async () => {
    const html = await shopifyHtml();
    const seen = { calls: 0 };
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(200, html),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", seen),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy).toBe("plain");
    expect(steps(result)).toBe("plain:ok");
    expect(seen.calls).toBe(0);
  });

  test("network failure does NOT escalate (a browser cannot reach what the network cannot)", async () => {
    const html = await shopifyHtml();
    const seen = { calls: 0 };
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      allowPrivate: true,
      stealth: stealthStub(html, "ok", seen),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network");
    expect(steps(result)).toBe("plain:network");
    expect(seen.calls).toBe(0);
  });

  test("empty body does escalate (content failure)", async () => {
    const html = await shopifyHtml();
    const seen = { calls: 0 };
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(200, "<html><body>hi</body></html>"),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", seen),
    });

    expect(result.ok).toBe(true);
    expect(steps(result)).toBe("plain:empty,stealth-browser:ok");
  });

  test("unwired stealth: chain stays plain-only (no cost, no behaviour change)", async () => {
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(403, "<html><body>nope</body></html>"),
      allowPrivate: true,
    });

    expect(result.ok).toBe(false);
    expect(steps(result)).toBe("plain:http");
  });

  test("registered host keeps wave-13 semantics: every entry tried in order", async () => {
    const seen = { calls: 0 };
    const result = await scrapeProduct("https://www.smythstoys.com/en-gb/p/1", {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(403, "<html><body>nope</body></html>", "https://www.smythstoys.com/p/1"),
      allowPrivate: true,
      // Stealth fails with a non-escalatable verdict, yet the registry chain
      // still falls through to plain — the gate is for the default chain only.
      stealth: stealthStub("", "fail", seen, "https://www.smythstoys.com/p/1"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("http");
    expect(steps(result)).toBe("stealth-browser:network,plain:http");
  });
});

describe("learned overrides (#103 tier 2)", () => {
  test("a promoted row sends the next fetch straight to stealth (no plain attempt)", async () => {
    const db = freshDb();
    seedPromoted(db);
    const html = await shopifyHtml();
    const plain = { n: 0 };
    const seen = { calls: 0 };

    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: countingFetch(stubFetch(200, html), plain),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", seen),
      learnedDb: db,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy).toBe("stealth-browser");
    expect(steps(result)).toBe("stealth-browser:ok");
    expect(plain.n).toBe(0); // the doomed plain attempt never happened
    expect(seen.calls).toBe(1);
    db.close();
  });

  test("a candidate row (strategies NULL) changes nothing: still plain-first", async () => {
    const db = freshDb();
    db.run(
      `INSERT INTO scrape_learned_overrides (hostname, escalation_count, last_escalated_at)
       VALUES (?, 1, ?)`,
      ["shop.example.test", new Date().toISOString()],
    );
    const html = await shopifyHtml();
    const seen = { calls: 0 };

    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(403, "<html><body>nope</body></html>"),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", seen),
      learnedDb: db,
    });

    expect(steps(result)).toBe("plain:http,stealth-browser:ok");
    db.close();
  });

  test("the committed registry shadows a learned row for the same host", async () => {
    const db = freshDb();
    // A learned plain-first row for a REGISTRY host must never be consulted.
    seedPromoted(db, { hostname: "smythstoys.com" });
    db.run("UPDATE scrape_learned_overrides SET strategies = ? WHERE hostname = ?", [
      JSON.stringify(["plain"]),
      "smythstoys.com",
    ]);
    const seen = { calls: 0 };
    const result = await scrapeProduct("https://www.smythstoys.com/en-gb/p/1", {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(403, "<html><body>nope</body></html>", "https://www.smythstoys.com/p/1"),
      allowPrivate: true,
      stealth: stealthStub("", "fail", seen, "https://www.smythstoys.com/p/1"),
      learnedDb: db,
    });

    // Registry order wins: stealth first, then plain fallback.
    expect(steps(result)).toBe("stealth-browser:network,plain:http");
    db.close();
  });
});

describe("recordScrapeOutcome: promotion", () => {
  test("three qualifying escalations promote the host to stealth-first", async () => {
    const db = freshDb();
    const html = await shopifyHtml();

    for (let cycle = 1; cycle <= LEARNED_PROMOTION_THRESHOLD; cycle++) {
      const seen = { calls: 0 };
      const result = await scrapeProduct(PAGE_URL, {
        userAgent: "UA/1.0",
        fetchImpl: stubFetch(403, "<html><body>nope</body></html>"),
        allowPrivate: true,
        stealth: stealthStub(html, "ok", seen),
        learnedDb: db,
      });
      expect(result.ok).toBe(true);
      recordScrapeOutcome(db, PAGE_URL, result.steps);

      const row = learnedRow(db);
      expect(row?.escalation_count).toBe(cycle);
      if (cycle < LEARNED_PROMOTION_THRESHOLD) {
        // Candidate: evidence only, no behaviour change yet.
        expect(row?.strategies).toBeNull();
        expect(row?.learned_at).toBeNull();
      } else {
        expect(row?.strategies).toBe(JSON.stringify(["stealth-browser", "plain"]));
        expect(row?.learned_at).not.toBeNull();
      }
    }

    // The 4th fetch skips plain entirely.
    const seen4 = { calls: 0 };
    const plain4 = { n: 0 };
    const fourth = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: countingFetch(stubFetch(403, "<html><body>nope</body></html>"), plain4),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", seen4),
      learnedDb: db,
    });
    recordScrapeOutcome(db, PAGE_URL, fourth.steps);
    expect(steps(fourth)).toBe("stealth-browser:ok");
    expect(plain4.n).toBe(0);
    expect(learnedRow(db)?.successful_stealth_fetches).toBe(1);
    db.close();
  });

  test("a plain-fail-then-stealth-FAIL cycle records nothing", async () => {
    const db = freshDb();
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(403, "<html><body>nope</body></html>"),
      allowPrivate: true,
      stealth: stealthStub("", "fail", { calls: 0 }),
      learnedDb: db,
    });
    expect(result.ok).toBe(false);
    recordScrapeOutcome(db, PAGE_URL, result.steps);
    expect(learnedRow(db)).toBeUndefined();
    db.close();
  });

  test("registry hosts are never learned about", async () => {
    const db = freshDb();
    const stepsIn: ScrapeStep[] = [
      { strategy: "plain", ok: false, reason: "http" },
      { strategy: "stealth-browser", ok: true },
    ];
    recordScrapeOutcome(db, "https://www.amazon.co.uk/dp/B0EXAMPLE1", stepsIn);
    expect(learnedRow(db, "amazon.co.uk")).toBeUndefined();
    db.close();
  });

  test("a plain success clears a stale candidate's escalation count", async () => {
    const db = freshDb();
    db.run(
      `INSERT INTO scrape_learned_overrides (hostname, escalation_count, last_escalated_at)
       VALUES (?, 2, ?)`,
      ["shop.example.test", new Date().toISOString()],
    );

    recordScrapeOutcome(db, PAGE_URL, [{ strategy: "plain", ok: true }]);
    const row = learnedRow(db);
    expect(row?.escalation_count).toBe(0);
    expect(row?.strategies).toBeNull();
    db.close();
  });
});

describe("recordScrapeOutcome: decay and demotion", () => {
  test("a promoted entry past its time budget is probed with plain; plain wins → demoted", async () => {
    const db = freshDb();
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    seedPromoted(db, { learnedAt: stale });
    expect(readLearned(db, PAGE_URL)?.dueForRevalidation).toBe(true);

    const html = await shopifyHtml();
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(200, html),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", { calls: 0 }),
      learnedDb: db,
    });

    expect(steps(result)).toBe("plain:ok"); // the revalidation probe
    recordScrapeOutcome(db, PAGE_URL, result.steps);

    const row = learnedRow(db);
    expect(row?.strategies).toBeNull();
    expect(row?.learned_at).toBeNull();
    expect(row?.last_demoted_at).not.toBeNull();
    // Demoted → the next fetch is plain-first again (the default chain).
    expect(readLearned(db, PAGE_URL)).toBeNull();
    db.close();
  });

  test("a promoted entry past its fetch-count budget is probed the same way", async () => {
    const db = freshDb();
    seedPromoted(db, { stealthFetches: 10 });
    expect(readLearned(db, PAGE_URL)?.dueForRevalidation).toBe(true);

    const html = await shopifyHtml();
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(200, html),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", { calls: 0 }),
      learnedDb: db,
    });
    expect(steps(result)).toBe("plain:ok");
    db.close();
  });

  test("a fresh promoted entry is NOT probed (no plain attempt)", async () => {
    const db = freshDb();
    seedPromoted(db);
    expect(readLearned(db, PAGE_URL)?.dueForRevalidation).toBe(false);

    const html = await shopifyHtml();
    const plain = { n: 0 };
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: countingFetch(stubFetch(200, html), plain),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", { calls: 0 }),
      learnedDb: db,
    });
    expect(steps(result)).toBe("stealth-browser:ok");
    expect(plain.n).toBe(0);
    db.close();
  });

  test("the probe escalates again (stealth succeeds) → the lease is renewed", async () => {
    const db = freshDb();
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    seedPromoted(db, { learnedAt: stale });

    const html = await shopifyHtml();
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(403, "<html><body>nope</body></html>"),
      allowPrivate: true,
      stealth: stealthStub(html, "ok", { calls: 0 }),
      learnedDb: db,
    });
    expect(steps(result)).toBe("plain:http,stealth-browser:ok");
    recordScrapeOutcome(db, PAGE_URL, result.steps);

    const row = learnedRow(db);
    expect(row?.strategies).toBe(JSON.stringify(["stealth-browser", "plain"]));
    expect(row?.learned_at).not.toBe(stale);
    expect(row?.escalation_count).toBe(4);
    expect(readLearned(db, PAGE_URL)?.dueForRevalidation).toBe(false);
    db.close();
  });

  test("stealth-first fails but plain succeeds → the override is dropped", async () => {
    const db = freshDb();
    seedPromoted(db);
    const html = await shopifyHtml();

    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(200, html),
      allowPrivate: true,
      stealth: stealthStub("", "fail", { calls: 0 }),
      learnedDb: db,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy).toBe("plain");
    expect(steps(result)).toBe("stealth-browser:network,plain:ok");
    recordScrapeOutcome(db, PAGE_URL, result.steps);

    const row = learnedRow(db);
    expect(row?.strategies).toBeNull();
    expect(row?.last_demoted_at).not.toBeNull();
    db.close();
  });
});

describe("learning never breaks a scrape", () => {
  test("a db that throws on every read degrades to the default chain", async () => {
    const broken = {
      query: () => {
        throw new Error("db is closed");
      },
    } as unknown as Database;
    const html = await shopifyHtml();
    const result = await scrapeProduct(PAGE_URL, {
      userAgent: "UA/1.0",
      fetchImpl: stubFetch(200, html),
      allowPrivate: true,
      learnedDb: broken,
    });

    expect(result.ok).toBe(true);
    expect(steps(result)).toBe("plain:ok");
  });

  test("recordScrapeOutcome swallows a broken db instead of throwing", () => {
    const broken = {
      query: () => {
        throw new Error("db is closed");
      },
    } as unknown as Database;
    expect(() => recordScrapeOutcome(broken, PAGE_URL, [{ strategy: "plain", ok: true }])).not.toThrow();
  });

  test("readLearned is null for a non-URL and for an unknown host", () => {
    const db = freshDb();
    expect(readLearned(db, "not a url")).toBeNull();
    expect(readLearned(db, PAGE_URL)).toBeNull();
    db.close();
  });

  test("readLearned never returns a candidate row", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO scrape_learned_overrides (hostname, escalation_count, last_escalated_at)
       VALUES (?, 2, ?)`,
      ["shop.example.test", new Date().toISOString()],
    );
    expect(readLearned(db, PAGE_URL)).toBeNull();
    db.close();
  });
});
