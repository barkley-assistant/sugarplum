import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/server/db/db";
import { runMigrations } from "../src/server/db/migrations";

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
    expect(version.user_version).toBe(1);

    // Re-run migrations on the same connection (and a second open) — no-op.
    runMigrations(db);
    const again = openDatabase(dbPath);
    expect(again.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    again.close();
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