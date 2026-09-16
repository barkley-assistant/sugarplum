import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/server/db/db";
import { createTracker, type TrackTimers } from "../src/server/jobs/track";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-16T12:00:00.000Z");
const STAGGER = 900_000;

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
  opts: { url?: string | null; trackedAgoMs?: number | null; pending?: boolean } = {},
): void {
  const url = opts.url === undefined ? "https://shop.example.com/p/1" : opts.url;
  const tracked =
    opts.trackedAgoMs === undefined || opts.trackedAgoMs === null
      ? null
      : new Date(NOW.getTime() - opts.trackedAgoMs).toISOString();
  db.run(
    "INSERT INTO wishlist_items (id, user_id, title, url, fetch_state, last_tracked_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, `Item ${id}`, url, opts.pending ? "pending" : "complete", tracked],
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
});
