import { describe, expect, test } from "bun:test";
import { createTestApp } from "./helpers";

const DAY = 86_400_000;

describe("sliding session renewal (#63 G1)", () => {
  test("session in the last half of its window is renewed on use; fresh ones are not", async () => {
    const app = createTestApp();
    try {
      await app.request("POST", "/api/auth/login", {
        username: "admin",
        password: "admin-password",
      });
      const row = app.app.db.query("SELECT token FROM sessions").get() as { token: string };

      // Rewind: created 25d ago, expires in 5d (30d window; 5 < 15 → renew).
      app.app.db.run("UPDATE sessions SET created_at = ?, expires_at = ? WHERE token = ?", [
        new Date(Date.now() - 25 * DAY).toISOString(),
        new Date(Date.now() + 5 * DAY).toISOString(),
        row.token,
      ]);

      const me = await app.request("GET", "/api/auth/me");
      expect(me.status).toBe(200);

      const after = app.app.db
        .query("SELECT expires_at FROM sessions WHERE token = ?")
        .get(row.token) as { expires_at: string };
      expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.now() + 29 * DAY);

      // Second use immediately: now inside the FRESH half → no rewrite.
      await app.request("GET", "/api/auth/me");
      const after2 = app.app.db
        .query("SELECT expires_at FROM sessions WHERE token = ?")
        .get(row.token) as { expires_at: string };
      expect(after2.expires_at).toBe(after.expires_at);

      // No-drift pin (#63): renewal must co-update created_at, so the
      // window span (expires_at − created_at) stays == the original 30d.
      const span = app.app.db
        .query("SELECT created_at, expires_at FROM sessions WHERE token = ?")
        .get(row.token) as { created_at: string; expires_at: string };
      const spanMs = Date.parse(span.expires_at) - Date.parse(span.created_at);
      expect(Math.abs(spanMs - 30 * DAY)).toBeLessThan(2000);
    } finally {
      await app.cleanup();
    }
  });

  test("session in the first half of its window is left alone on use", async () => {
    const app = createTestApp();
    try {
      await app.request("POST", "/api/auth/login", {
        username: "admin",
        password: "admin-password",
      });
      const row = app.app.db.query("SELECT token FROM sessions").get() as { token: string };

      // created now, expires in 25d (30d window; 25 > 15 → NOT renewed)
      app.app.db.run("UPDATE sessions SET created_at = ?, expires_at = ? WHERE token = ?", [
        new Date().toISOString(),
        new Date(Date.now() + 25 * DAY).toISOString(),
        row.token,
      ]);
      const me = await app.request("GET", "/api/auth/me");
      expect(me.status).toBe(200);
      const after = app.app.db
        .query("SELECT expires_at FROM sessions WHERE token = ?")
        .get(row.token) as { expires_at: string };
      // Exact: expires_at untouched (still ~25d out, within 2s of clock skew).
      expect(Math.abs(Date.parse(after.expires_at) - (Date.now() + 25 * DAY))).toBeLessThan(2000);
    } finally {
      await app.cleanup();
    }
  });

  test("expired session is deleted, not renewed (existing behavior kept)", async () => {
    const app = createTestApp();
    try {
      app.app.db.run(
        `INSERT INTO users (id, username, display_name, password_hash)
         VALUES ('slide-user-1', 'slideuser', 'Slide', ?)`,
        ["scrypt$16384$8$1$00$00"], // junk hash; login never happens
      );
      app.app.db.run(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        [
          "slide-expired-token",
          "slide-user-1",
          new Date(Date.now() - 60 * DAY).toISOString(),
          "2000-01-01T00:00:00.000Z",
        ],
      );
      const res = await fetch(`${app.baseUrl}/api/auth/me`, {
        headers: { Cookie: "sugarplum_session=slide-expired-token" },
      });
      expect(res.status).toBe(401);
      const leftover = app.app.db
        .query("SELECT COUNT(*) AS n FROM sessions WHERE token = ?")
        .get("slide-expired-token") as { n: number };
      expect(leftover.n).toBe(0);
    } finally {
      await app.cleanup();
    }
  });
});
