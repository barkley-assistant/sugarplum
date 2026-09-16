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
  {
    version: 3,
    sql: `
-- Wave 12: provenance of the stored image. NULL/'direct' = downloaded from the
-- page the user pasted; 'search' = labelled best-effort fallback image from
-- SearXNG because the page carried none. No backfill: pre-wave-12 rows stay
-- NULL and read as direct.
ALTER TABLE wishlist_items ADD COLUMN image_source TEXT;
`,
  },
  {
    version: 4,
    sql: `
-- Wave 5: price provenance, the owner's manual "found it cheaper" link, and
-- the per-user price-hint honesty gate.
-- price_source records WHO wrote price_cents: 'scrape' | 'searxng-hint' |
-- 'manual'. No backfill: pre-v4 rows stay NULL, which the UI reads as
-- user-authored, so a re-check never overwrites a legacy value.
ALTER TABLE wishlist_items ADD COLUMN price_source TEXT;
ALTER TABLE wishlist_items ADD COLUMN cheaper_url TEXT;
ALTER TABLE users ADD COLUMN hints_enabled INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    version: 5,
    sql: `
-- Wave 10: public share links + anonymous purchased marking.
-- purchased is a SEPARATE concept from claimed_by (registered-user claims):
-- it records "someone with the share link bought this", is visible to other
-- share viewers, and is never projected to the owner. No backfill: existing
-- rows read as unpurchased (DEFAULT 0).
ALTER TABLE wishlist_items ADD COLUMN purchased INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wishlist_items ADD COLUMN purchased_at TEXT;

-- One ACTIVE share token per user; revoked_at distinguishes history. No
-- unique constraint on user_id: revocation is by timestamp, so rotation is
-- two statements and multi-token support later is additive.
CREATE TABLE share_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT
);
CREATE INDEX idx_share_tokens_user ON share_tokens(user_id);
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