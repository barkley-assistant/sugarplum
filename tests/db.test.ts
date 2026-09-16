import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/server/db/db";
import { MIGRATIONS, runMigrations } from "../src/server/db/migrations";

let dir: string;
let dbPath: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sugarplum-db-test-"));
  dbPath = join(dir, "db.sqlite");
  db = openDatabase(dbPath);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("db migrations", () => {
  test("migrations are idempotent", () => {
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(5);

    // Re-run migrations on the same connection (and a second open) — no-op.
    runMigrations(db);
    const again = openDatabase(dbPath);
    expect(again.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    again.close();
  });

  test("v2 (enrichment state) + v3 (image provenance) + v4 (price provenance) + v5 (share) columns exist on an upgraded db", () => {
    const v = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(5);
    const cols = db.query("PRAGMA table_info(wishlist_items)").all() as { name: string }[];
    for (const c of [
      "fetch_state",
      "last_fetch_error",
      "site_name",
      "hint_price_cents",
      "hint_currency",
      "hint_source_url",
      "image_source",
      "price_source",
      "cheaper_url",
      "purchased",
      "purchased_at",
    ]) {
      expect(cols.some((x) => x.name === c)).toBe(true);
    }
    const userCols = db.query("PRAGMA table_info(users)").all() as { name: string; dflt_value: string | null }[];
    const hintsCol = userCols.find((c) => c.name === "hints_enabled");
    expect(hintsCol).toBeDefined();
    // Default ON: the feature is discoverable, and the gate is opt-out.
    expect(hintsCol?.dflt_value).toBe("1");

    // A row created under the v1 schema (before v2-v4 ran) reads 'complete'
    // with NULL provenance — the DEFAULT guarantees zero data migration.
    const freshPath = join(dir, "v2-upgrade.sqlite");
    const fresh = new Database(freshPath);
    try {
      const v1 = MIGRATIONS.find((m) => m.version === 1);
      if (!v1) throw new Error("v1 migration missing");
      fresh.exec(v1.sql);
      fresh.exec("PRAGMA user_version = 1");
      fresh.run("INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)", [
        "v2-upgrade-user",
        "v2_upgrade_user",
        "Upgrade",
        "scrypt$x",
      ]);
      fresh.run("INSERT INTO wishlist_items (id, user_id, title) VALUES (?, ?, ?)", [
        "v2-upgrade-item",
        "v2-upgrade-user",
        "Old item",
      ]);
      runMigrations(fresh);
      expect((fresh.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
      const row = fresh
        .query(
          `SELECT fetch_state, site_name, hint_price_cents, image_source, price_source, cheaper_url
           FROM wishlist_items WHERE id = ?`,
        )
        .get("v2-upgrade-item") as {
        fetch_state: string;
        site_name: string | null;
        hint_price_cents: number | null;
        image_source: string | null;
        price_source: string | null;
        cheaper_url: string | null;
      };
      expect(row.fetch_state).toBe("complete");
      expect(row.site_name).toBeNull();
      expect(row.hint_price_cents).toBeNull();
      expect(row.image_source).toBeNull(); // no backfill: reads as 'direct'
      expect(row.price_source).toBeNull(); // no backfill: reads as user-authored
      expect(row.cheaper_url).toBeNull();

      // The pre-existing user gains the gate switched ON, not NULL.
      const user = fresh.query("SELECT hints_enabled FROM users WHERE id = ?").get("v2-upgrade-user") as {
        hints_enabled: number;
      };
      expect(user.hints_enabled).toBe(1);

      // v5: purchased flag + share tokens
      const cols5 = fresh.query("PRAGMA table_info(wishlist_items)").all() as {
        name: string;
        dflt_value: string | null;
      }[];
      const purchasedCol = cols5.find((c) => c.name === "purchased");
      expect(purchasedCol).toBeDefined();
      expect(purchasedCol?.dflt_value).toBe("0");
      const upgraded = fresh
        .query("SELECT purchased, purchased_at FROM wishlist_items WHERE id = ?")
        .get("v2-upgrade-item") as { purchased: number; purchased_at: string | null };
      expect(upgraded.purchased).toBe(0); // no backfill: pre-v5 rows read unpurchased
      expect(upgraded.purchased_at).toBeNull();
      const tokenCols = fresh.query("PRAGMA table_info(share_tokens)").all() as { name: string }[];
      for (const c of ["token", "user_id", "created_at", "revoked_at"]) {
        expect(tokenCols.some((x) => x.name === c)).toBe(true);
      }
    } finally {
      fresh.close();
      rmSync(freshPath, { force: true });
    }
  });

  test("core tables exist", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of ["users", "sessions", "wishlist_items", "price_history"]) {
      expect(names).toContain(expected);
    }
  });

  test("WAL mode is enabled", () => {
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  test("foreign keys are enabled", () => {
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  test("FK cascade: deleting a user removes their items and sessions", () => {
    const alice = "user-cascade-alice";
    db.run("INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)", [
      alice,
      "cascade_alice",
      "Alice",
      "scrypt$x",
    ]);
    db.run(
      "INSERT INTO wishlist_items (id, user_id, title) VALUES (?, ?, ?)",
      ["item-cascade-1", alice, "Alice item"],
    );
    db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [
      "tok-cascade-1",
      alice,
      "2099-01-01T00:00:00.000Z",
    ]);

    db.run("DELETE FROM users WHERE id = ?", [alice]);

    const items = db.query("SELECT COUNT(*) AS n FROM wishlist_items WHERE user_id = ?").get(alice) as {
      n: number;
    };
    const sessions = db.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(alice) as {
      n: number;
    };
    expect(items.n).toBe(0);
    expect(sessions.n).toBe(0);
  });

  test("FK set-null: deleting a claimant releases their claims", () => {
    const owner = "user-setnull-owner";
    const claimant = "user-setnull-claimant";
    db.run("INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)", [
      owner,
      "setnull_owner",
      "Owner",
      "scrypt$x",
    ]);
    db.run("INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)", [
      claimant,
      "setnull_claimant",
      "Claimant",
      "scrypt$x",
    ]);
    db.run(
      "INSERT INTO wishlist_items (id, user_id, title, claimed_by, claimed_at) VALUES (?, ?, ?, ?, ?)",
      ["item-setnull-1", owner, "Claimed item", claimant, "2026-01-01T00:00:00.000Z"],
    );

    db.run("DELETE FROM users WHERE id = ?", [claimant]);

    const row = db.query("SELECT claimed_by, claimed_at FROM wishlist_items WHERE id = ?").get(
      "item-setnull-1",
    ) as { claimed_by: string | null; claimed_at: string | null };
    expect(row.claimed_by).toBeNull();
    // claimed_at is inert without claimed_by (the API projection keys off
    // claimed_by only), so it is intentionally not cleared by the FK action.
    expect(row.claimed_at).not.toBeNull();
  });
});