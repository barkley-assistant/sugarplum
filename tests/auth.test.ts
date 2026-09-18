import { rmSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { ConfigError, readConfig } from "../src/server/config";
import { hashPassword, verifyPassword } from "../src/server/auth/passwords";
import { createTestApp, makeTestConfig, type TestAppHandle } from "./helpers";

describe("passwords (scrypt)", () => {
  test("hash/verify roundtrip; wrong password fails; format has no plaintext", () => {
    const hash = hashPassword("hunter2-secret");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("hunter2-secret");
    expect(verifyPassword("hunter2-secret", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  test("verify rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "not-a-scrypt-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$bad")).toBe(false);
  });

  test("new hashes use N=32768; legacy N=16384 hashes still verify", () => {
    const hash = hashPassword("cost-bump-probe");
    expect(hash.startsWith("scrypt$32768$8$1$")).toBe(true);

    // Legacy hash (N=16384, hand-built in the stored format) must keep
    // verifying — this is the parameter-migration path #63 asks about.
    const legacySalt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const legacyHash = scryptSync("legacy-probe", legacySalt, 64, { N: 16384, r: 8, p: 1 });
    const stored = `scrypt$16384$8$1$${legacySalt.toString("hex")}$${legacyHash.toString("hex")}`;
    expect(verifyPassword("legacy-probe", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });
});

describe("config", () => {
  test("missing admin env refuses to boot, naming every missing key", () => {
    expect(() => readConfig({})).toThrow(ConfigError);

    let message = "";
    try {
      readConfig({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("SUGARPLUM_ADMIN_USERNAME");
    expect(message).toContain("SUGARPLUM_ADMIN_PASSWORD");
    expect(message).toContain("SUGARPLUM_ADMIN_DISPLAY_NAME");

    message = "";
    try {
      readConfig({ SUGARPLUM_ADMIN_USERNAME: "a" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("SUGARPLUM_ADMIN_USERNAME");
    expect(message).toContain("SUGARPLUM_ADMIN_PASSWORD");
  });
});

describe("auth flow (integration)", () => {
  let app: TestAppHandle;

  beforeAll(() => {
    app = createTestApp();
  });

  afterAll(async () => {
    await app.cleanup();
  });

  test("login sets HttpOnly + SameSite=Lax cookie, Secure only outside dev", async () => {
    const secureApp = createTestApp({ cookieSecure: true });
    const res = await secureApp.request("POST", "/api/auth/login", {
      username: "admin",
      password: "admin-password",
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sugarplum_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    await secureApp.cleanup();

    // Dev mode (SUGARPLUM_DEV=1 → cookieSecure false): no Secure attribute.
    const devApp = createTestApp({ cookieSecure: false, dev: true });
    const devRes = await devApp.request("POST", "/api/auth/login", {
      username: "admin",
      password: "admin-password",
    });
    expect(devRes.status).toBe(200);
    const devCookie = devRes.headers.get("set-cookie") ?? "";
    expect(devCookie).toContain("HttpOnly");
    expect(devCookie).not.toContain("Secure");
    await devApp.cleanup();
  });

  test("bootstrap admin exists with env password; bad creds → 401; deactivated → 400", async () => {
    const adminRow = app.app.db
      .query("SELECT username, is_admin, is_active FROM users WHERE username = ?")
      .get("admin") as { username: string; is_admin: number; is_active: number };
    expect(adminRow.is_admin).toBe(1);
    expect(adminRow.is_active).toBe(1);

    const good = await app.request("POST", "/api/auth/login", {
      username: "admin",
      password: "admin-password",
    });
    expect(good.status).toBe(200);

    const bad = await app.request("POST", "/api/auth/login", {
      username: "admin",
      password: "nope",
    });
    expect(bad.status).toBe(401);

    // Deactivated user: 400, distinct from bad credentials.
    app.app.db.run(
      `INSERT INTO users (id, username, display_name, password_hash, is_active)
       VALUES ('deact-user-1', 'deactivated', 'Deactivated', ?, 0)`,
      [hashPassword("pw")],
    );
    const deact = await app.request("POST", "/api/auth/login", {
      username: "deactivated",
      password: "pw",
    });
    expect(deact.status).toBe(400);
  });

  test("me: no cookie → 401; valid cookie → 200 with me shape", async () => {
    app.clearCookie();
    const none = await app.request("GET", "/api/auth/me");
    expect(none.status).toBe(401);

    const login = await app.request("POST", "/api/auth/login", {
      username: "admin",
      password: "admin-password",
    });
    expect(login.status).toBe(200);

    const me = await app.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      id: string;
      username: string;
      displayName: string;
      isAdmin: boolean;
    };
    expect(body.username).toBe("admin");
    expect(body.displayName).toBe("Admin");
    expect(body.isAdmin).toBe(true);
    expect(typeof body.id).toBe("string");
  });

  test("logout: 204, cookie cleared, subsequent me → 401", async () => {
    app.clearCookie();
    await app.request("POST", "/api/auth/login", { username: "admin", password: "admin-password" });

    const logout = await app.request("POST", "/api/auth/logout");
    expect(logout.status).toBe(204);
    const setCookie = logout.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");

    const me = await app.request("GET", "/api/auth/me");
    expect(me.status).toBe(401);
  });

  test("expired session: me → 401 and the row is swept", async () => {
    app.app.db.run(
      `INSERT INTO users (id, username, display_name, password_hash)
       VALUES ('expired-user-1', 'expireduser', 'Expired', ?)`,
      [hashPassword("pw")],
    );
    app.app.db.run(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
      ["expired-token-1", "expired-user-1", "2000-01-01T00:00:00.000Z"],
    );

    const res = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: { Cookie: "sugarplum_session=expired-token-1" },
    });
    expect(res.status).toBe(401);

    const leftover = app.app.db
      .query("SELECT COUNT(*) AS n FROM sessions WHERE token = ?")
      .get("expired-token-1") as { n: number };
    expect(leftover.n).toBe(0);
  });

  test("rate limit: 11th bad login within window → 429 with Retry-After", async () => {
    const rlApp = createTestApp();
    try {
      for (let i = 0; i < 10; i++) {
        const res = await rlApp.request("POST", "/api/auth/login", {
          username: "ratelimited",
          password: "wrong",
        });
        expect(res.status).toBe(401);
      }
      const blocked = await rlApp.request("POST", "/api/auth/login", {
        username: "ratelimited",
        password: "wrong",
      });
      expect(blocked.status).toBe(429);
      const retryAfter = blocked.headers.get("retry-after");
      expect(retryAfter).not.toBeNull();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    } finally {
      await rlApp.cleanup();
    }
  });

  test("second boot does not duplicate or overwrite the bootstrap admin", async () => {
    const { config, dir } = makeTestConfig();
    const first = createApp(config);
    const firstUrl = `http://127.0.0.1:${first.server.port}`;

    // "Reboot" on the same DB with a different env password.
    const second = createApp({ ...config, port: 0, adminPassword: "changed-password" });
    const secondUrl = `http://127.0.0.1:${second.server.port}`;

    try {
      const count = first.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number };
      expect(count.n).toBe(1);

      const orig = await fetch(`${firstUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "admin-password" }),
      });
      expect(orig.status).toBe(200);

      const changed = await fetch(`${secondUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "changed-password" }),
      });
      expect(changed.status).toBe(401);
    } finally {
      await first.stop();
      await second.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});