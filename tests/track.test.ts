import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/server/db/db";
import { createTracker, type TrackTimers } from "../src/server/jobs/track";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = new Date("2026-09-16T12:00:00.000Z");
const STAGGER = 900_000;

/** Production defaults for the per-item cadence knobs (src/server/config.ts). */
const THRESHOLDS = {
  failedMs: 172_800_000,
  activeMs: 43_200_000,
  stableMs: DAY_MS,
  movedWindowMs: 604_800_000,
};

let dir: string;
let db: Database;

interface Scheduled {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

interface FakeClock {
  scheduled: Scheduled[];
  timers: TrackTimers;
  enqueued: string[];
}

function makeFake(): FakeClock {
  const scheduled: Scheduled[] = [];
  const enqueued: string[] = [];
  const timers: TrackTimers = {
    setTimeout: (fn: () => void, ms: number) => {
      const rec: Scheduled = { fn, ms, cleared: false };
      scheduled.push(rec);
      return rec;
    },
    clearTimeout: (handle: unknown) => {
      (handle as Scheduled).cleared = true;
    },
  };
  return { scheduled, timers, enqueued };
}

function fire(rec: Scheduled): void {
  if (!rec.cleared) rec.fn();
}

function addUser(id: string, opts: { tracking?: boolean; active?: boolean } = {}): void {
  db.run("INSERT INTO users (id, username, display_name, password_hash, price_tracking_enabled, is_active) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    `user_${id}`,
    `User ${id}`,
    "scrypt$x",
    opts.tracking === false ? 0 : 1,
    opts.active === false ? 0 : 1,
  ]);
}

function addItem(
  id: string,
  userId: string,
  opts: {
    url?: string | null;
    trackedAgoMs?: number | null;
    pending?: boolean;
    fetchState?: string;
  } = {},
): void {
  const url = opts.url === undefined ? "https://shop.example.com/p/1" : opts.url;
  const tracked =
    opts.trackedAgoMs === undefined || opts.trackedAgoMs === null
      ? null
      : new Date(NOW.getTime() - opts.trackedAgoMs).toISOString();
  db.run(
    "INSERT INTO wishlist_items (id, user_id, title, url, fetch_state, last_tracked_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, `Item ${id}`, url, opts.pending ? "pending" : (opts.fetchState ?? "complete"), tracked],
  );
}

/** One price observation, `observedAgoMs` before NOW (default: observed now). */
function addHistory(
  itemId: string,
  opts: { priceCents?: number; observedAgoMs?: number; source?: string } = {},
): void {
  db.run(
    `INSERT INTO price_history (id, item_id, price_cents, currency, source, observed_at)
     VALUES (?, ?, ?, 'GBP', ?, ?)`,
    [
      crypto.randomUUID(),
      itemId,
      opts.priceCents ?? 1000,
      opts.source ?? "scrape",
      new Date(NOW.getTime() - (opts.observedAgoMs ?? 0)).toISOString(),
    ],
  );
}

function trackedAt(id: string): string | null {
  const row = db.query("SELECT last_tracked_at FROM wishlist_items WHERE id = ?").get(id) as {
    last_tracked_at: string | null;
  };
  return row.last_tracked_at;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sugarplum-track-test-"));
  db = openDatabase(join(dir, "db.sqlite"));
});

beforeEach(() => {
  // Each test owns its candidates: the scheduler reads the whole table, so
  // rows from an earlier test would leak into a later pass.
  db.run("DELETE FROM wishlist_items");
  db.run("DELETE FROM users");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("daily tracker scheduler", () => {
  test("first pass runs after initialDelayMs, not immediately", () => {
    addUser("u-delay");
    addItem("i-delay", "u-delay");
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 60_000,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      expect(fake.scheduled).toHaveLength(1);
      expect(fake.scheduled[0].ms).toBe(60_000);
      expect(fake.enqueued).toHaveLength(0);
    } finally {
      tracker.stop();
    }
  });

  test("dedupe: 12h-ago skipped, 25h-ago and never-tracked enqueued with stagger", () => {
    addUser("u-dedupe");
    addItem("i-fresh", "u-dedupe", { trackedAgoMs: 12 * 3_600_000 });
    addItem("i-stale", "u-dedupe", { trackedAgoMs: 25 * 3_600_000 });
    addItem("i-never", "u-dedupe", { trackedAgoMs: null });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]); // the first pass
      // Never-tracked sorts first, then oldest-tracked: i-never, i-stale.
      const staggers = fake.scheduled.slice(1, 3);
      expect(staggers.map((s) => s.ms)).toEqual([0, STAGGER]);
      expect(fake.scheduled).toHaveLength(4); // pass + 2 staggers + next pass
      expect(fake.scheduled[3].ms).toBe(DAY_MS);

      fire(staggers[0]);
      fire(staggers[1]);
      expect(fake.enqueued).toEqual(["i-never", "i-stale"]);
      expect(trackedAt("i-never")).toBe(NOW.toISOString());
      expect(trackedAt("i-stale")).toBe(NOW.toISOString());
      expect(trackedAt("i-fresh")).not.toBe(NOW.toISOString());
    } finally {
      tracker.stop();
    }
  });

  test("row turned pending between query and enqueue → skipped, stamp untouched", () => {
    addUser("u-pending");
    addItem("i-race", "u-pending", { trackedAgoMs: null });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      // A user-triggered re-check picks the item up before the stagger fires.
      db.run("UPDATE wishlist_items SET fetch_state = 'pending' WHERE id = ?", ["i-race"]);
      fire(fake.scheduled[1]);
      expect(fake.enqueued).toHaveLength(0);
      expect(trackedAt("i-race")).toBeNull();
    } finally {
      tracker.stop();
    }
  });

  test("opt-out between query and enqueue → skipped; opted-out users never candidates", () => {
    addUser("u-optout");
    addItem("i-optout", "u-optout", { trackedAgoMs: null });
    addUser("u-off", { tracking: false });
    addItem("i-off", "u-off", { trackedAgoMs: null });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      const staggers = fake.scheduled.slice(1, -1);
      // i-off (opted out) is never a candidate; only i-optout is scheduled.
      expect(staggers).toHaveLength(1);
      db.run("UPDATE users SET price_tracking_enabled = 0 WHERE id = ?", ["u-optout"]);
      fire(staggers[0]);
      expect(fake.enqueued).toHaveLength(0);
      expect(trackedAt("i-optout")).toBeNull();
    } finally {
      tracker.stop();
    }
  });

  test("no-URL items and inactive owners are never candidates", () => {
    addUser("u-skip");
    addItem("i-nourl", "u-skip", { url: null, trackedAgoMs: null });
    addUser("u-gone", { active: false });
    addItem("i-gone", "u-gone", { trackedAgoMs: null });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      // Pass + next pass only: zero stagger timers.
      expect(fake.scheduled).toHaveLength(2);
      expect(fake.scheduled[1].ms).toBe(DAY_MS);
    } finally {
      tracker.stop();
    }
  });

  test("stop() clears pending timers; cleared callbacks never enqueue", () => {
    addUser("u-stop");
    addItem("i-stop", "u-stop", { trackedAgoMs: null });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    fire(fake.scheduled[0]);
    expect(fake.scheduled.length).toBeGreaterThan(1);
    tracker.stop();
    // The already-fired initial timer is spent (not pending); every timer
    // still pending is cleared.
    expect(fake.scheduled[0].cleared).toBe(false);
    for (const rec of fake.scheduled.slice(1)) expect(rec.cleared).toBe(true);
    for (const rec of fake.scheduled) fire(rec);
    expect(fake.enqueued).toHaveLength(0);
    expect(trackedAt("i-stop")).toBeNull();
  });

  test("active tier: a price observation inside the moved window → due at 12h", () => {
    addUser("u-active");
    addItem("i-active", "u-active", { trackedAgoMs: 13 * HOUR_MS });
    addHistory("i-active", { observedAgoMs: DAY_MS });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      fire(fake.scheduled[1]);
      expect(fake.enqueued).toEqual(["i-active"]);
      expect(trackedAt("i-active")).toBe(NOW.toISOString());
    } finally {
      tracker.stop();
    }
  });

  test("stable tier: a history row outside the moved window → only at 24h", () => {
    addUser("u-stable-old");
    addItem("i-stable-old", "u-stable-old", { trackedAgoMs: 13 * HOUR_MS });
    addHistory("i-stable-old", { observedAgoMs: 8 * DAY_MS });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      // Pass + next pass only: zero stagger timers.
      expect(fake.scheduled).toHaveLength(2);
      expect(fake.enqueued).toHaveLength(0);
    } finally {
      tracker.stop();
    }
  });

  test("stable tier: no history at all → only at 24h", () => {
    addUser("u-stable-none");
    addItem("i-stable-none", "u-stable-none", { trackedAgoMs: 13 * HOUR_MS });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      expect(fake.scheduled).toHaveLength(2);
      expect(fake.enqueued).toHaveLength(0);
    } finally {
      tracker.stop();
    }
  });

  test("failed tier: a 30h-old failure waits, a 49h-old failure is due at 48h", () => {
    addUser("u-failed");
    // Both carry a history row inside the moved window, so a rule that let
    // the active tier win would enqueue the 30h item too.
    addItem("i-fail-wait", "u-failed", { trackedAgoMs: 30 * HOUR_MS, fetchState: "failed" });
    addItem("i-fail-due", "u-failed", { trackedAgoMs: 49 * HOUR_MS, fetchState: "failed" });
    addHistory("i-fail-wait", { observedAgoMs: DAY_MS });
    addHistory("i-fail-due", { observedAgoMs: DAY_MS });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      // Pass + one stagger + next pass: the 30h failure is filtered out.
      expect(fake.scheduled).toHaveLength(3);
      fire(fake.scheduled[1]);
      expect(fake.enqueued).toEqual(["i-fail-due"]);
    } finally {
      tracker.stop();
    }
  });

  test("moved-window boundary: an observation exactly 7d old is still inside", () => {
    addUser("u-boundary");
    addItem("i-boundary", "u-boundary", { trackedAgoMs: 13 * HOUR_MS });
    addHistory("i-boundary", { observedAgoMs: 604_800_000 });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      fire(fake.scheduled[1]);
      expect(fake.enqueued).toEqual(["i-boundary"]);
    } finally {
      tracker.stop();
    }
  });

  test("mixed tiers in one pass keep the ORDER BY and the stagger", () => {
    addUser("u-mixed");
    addItem("i-mixed-never", "u-mixed", { trackedAgoMs: null });
    addItem("i-mixed-failed", "u-mixed", { trackedAgoMs: 49 * HOUR_MS, fetchState: "failed" });
    addItem("i-mixed-stable", "u-mixed", { trackedAgoMs: 20 * HOUR_MS });
    addItem("i-mixed-active", "u-mixed", { trackedAgoMs: 13 * HOUR_MS });
    addHistory("i-mixed-active", { observedAgoMs: DAY_MS });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: DAY_MS,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      // i-mixed-stable survives the prefilter (20h > the loosest 12h cutoff)
      // and then loses in the tier filter; the other three are due, in the
      // ORDER BY order (never-tracked first).
      const staggers = fake.scheduled.slice(1, 4);
      expect(staggers.map((s) => s.ms)).toEqual([0, STAGGER, 2 * STAGGER]);
      expect(fake.scheduled).toHaveLength(5); // pass + 3 staggers + next pass
      expect(fake.scheduled[4].ms).toBe(DAY_MS);
      for (const rec of staggers) fire(rec);
      expect(fake.enqueued).toEqual(["i-mixed-never", "i-mixed-failed", "i-mixed-active"]);
    } finally {
      tracker.stop();
    }
  });

  test("lowered interval: the stable cutoff follows it, the prefilter stays loosest", () => {
    addUser("u-interval");
    addItem("i-int-stable", "u-interval", { trackedAgoMs: 90 * 60_000 });
    addItem("i-int-active", "u-interval", { trackedAgoMs: 90 * 60_000 });
    addHistory("i-int-active", { observedAgoMs: 70 * 60_000 });
    const fake = makeFake();
    const tracker = createTracker({
      db,
      queue: { enqueue: (id) => fake.enqueued.push(id) },
      intervalMs: 3_600_000,
      initialDelayMs: 0,
      staggerMs: STAGGER,
      ...THRESHOLDS,
      stableMs: 3_600_000,
      now: () => NOW,
      timers: fake.timers,
    });
    try {
      fire(fake.scheduled[0]);
      // Both rows are 90min old, so both survive a 60min prefilter; only the
      // stable row is due (the moved row's active tier is 12h).
      const staggers = fake.scheduled.slice(1, -1);
      expect(staggers).toHaveLength(1);
      fire(staggers[0]);
      expect(fake.enqueued).toEqual(["i-int-stable"]);
      expect(fake.scheduled).toHaveLength(3); // pass + 1 stagger + next pass
      expect(fake.scheduled[2].ms).toBe(3_600_000);
    } finally {
      tracker.stop();
    }
  });
});
