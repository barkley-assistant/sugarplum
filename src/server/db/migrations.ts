import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  sql: string;
}

/**
 * Versioned DDL. Each migration runs exactly once, tracked by
 * `PRAGMA user_version`. Append new migrations with a higher version;
 * never edit an already-shipped migration.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE wishlist_items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  url         TEXT,
  image_path  TEXT,
  price_cents INTEGER,
  currency    TEXT,
  notes       TEXT,
  tags        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  claimed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_items_user ON wishlist_items(user_id);

-- Price history snapshots. Designed now, wired in a later wave (price
-- hints/history); no wave-1 route reads or writes it.
CREATE TABLE price_history (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES wishlist_items(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL,
  currency    TEXT,
  source      TEXT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_price_history_item ON price_history(item_id, observed_at);
`,
  },
  {
    version: 2,
    sql: `
-- Wave 2: paste-a-link enrichment state + best-effort price hints.
-- fetch_state DEFAULT 'complete' keeps every pre-wave-2 row (and every
-- manual item) untouched: 'pending'/'failed' are opt-in states of the
-- URL-driven flow only.
ALTER TABLE wishlist_items ADD COLUMN fetch_state TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE wishlist_items ADD COLUMN last_fetch_error TEXT;
ALTER TABLE wishlist_items ADD COLUMN site_name TEXT;
ALTER TABLE wishlist_items ADD COLUMN hint_price_cents INTEGER;
ALTER TABLE wishlist_items ADD COLUMN hint_currency TEXT;
ALTER TABLE wishlist_items ADD COLUMN hint_source_url TEXT;
`,
  },
];

export function runMigrations(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.run(migration.sql);
      db.run(`PRAGMA user_version = ${migration.version}`);
    })();
  }
}