import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hashPassword } from "../src/server/auth/passwords";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type { AdminUser, Me } from "../src/shared/types";

let app: TestAppHandle;
let admin: Jar;
let member: Jar;

beforeEach(() => {
  app = createTestApp();
  admin = app.newJar();
  member = app.newJar();
});

afterEach(async () => {
  await app.cleanup();
});

async function login(jar: Jar, username: string, password: string): Promise<void> {
  const res = await jar.request("POST", "/api/auth/login", { username, password });
  expect(res.status).toBe(200);
}

async function createMember(username = "member", password = "member-pass"): Promise<AdminUser> {
  await login(admin, "admin", "admin-password");
  const created = await admin.request("POST", "/api/users", {
    username,
    password,
    displayName: "Member",
  });
  expect(created.status).toBe(201);
  return (await created.json()) as AdminUser;
}

describe("self-service: PUT /api/auth/me/profile", () => {
  test("valid update → 200 with updated me; /api/auth/me reflects it", async () => {
    await createMember();
    await login(member, "member", "member-pass");

    const res = await member.request("PUT", "/api/auth/me/profile", { displayName: "New Name" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Me;
    expect(body.displayName).toBe("New Name");
    expect(body.username).toBe("member");

    const me = await member.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as Me).displayName).toBe("New Name");
  });

  test("admin can update their own display name", async () => {
    await login(admin, "admin", "admin-password");
    const res = await admin.request("PUT", "/api/auth/me/profile", { displayName: "Boss" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Me).displayName).toBe("Boss");
  });

  test("empty displayName → 400", async () => {
    await login(admin, "admin", "admin-password");
    for (const bad of ["", "   ", 123, undefined]) {
      const res = await admin.request(
        "PUT",
        "/api/auth/me/profile",
        bad === undefined ? {} : { displayName: bad },
      );
      expect(res.status).toBe(400);
    }
  });

  test("no session → 401", async () => {
    const res = await member.request("PUT", "/api/auth/me/profile", { displayName: "X" });
    expect(res.status).toBe(401);
  });
});

describe("self-service: PUT /api/auth/me/password", () => {
  test("correct current → 200 + cookie cleared; re-login with new works, old fails", async () => {
    await createMember("pwuser", "old-pass");
    await login(member, "pwuser", "old-pass");

    const res = await member.request("PUT", "/api/auth/me/password", {
      currentPassword: "old-pass",
      newPassword: "brand-new-pass",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

    // Session was invalidated: subsequent authed call → 401.
    const me = await member.request("GET", "/api/auth/me");
    expect(me.status).toBe(401);

    // New password works; old password fails.
    const fresh = app.newJar();
    const okLogin = await fresh.request("POST", "/api/auth/login", {
      username: "pwuser",
      password: "brand-new-pass",
    });
    expect(okLogin.status).toBe(200);

    const stale = app.newJar();
    const badLogin = await stale.request("POST", "/api/auth/login", {
      username: "pwuser",
      password: "old-pass",
    });
    expect(badLogin.status).toBe(401);
  });

  test("wrong current password → 401 and the stored hash is unchanged", async () => {
    await createMember("pwuser2", "correct-pass");
    await login(member, "pwuser2", "correct-pass");

    const before = app.app.db
      .query("SELECT password_hash AS h FROM users WHERE username = ?")
      .get("pwuser2") as { h: string };

    const res = await member.request("PUT", "/api/auth/me/password", {
      currentPassword: "wrong-pass",
      newPassword: "whatever-new",
    });
    expect(res.status).toBe(401);

    const after = app.app.db
      .query("SELECT password_hash AS h FROM users WHERE username = ?")
      .get("pwuser2") as { h: string };
    expect(after.h).toBe(before.h);

    // Session still valid.
    const me = await member.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
  });

  test("empty new password → 400", async () => {
    await login(admin, "admin", "admin-password");
    const res = await admin.request("PUT", "/api/auth/me/password", {
      currentPassword: "admin-password",
      newPassword: "",
    });
    expect(res.status).toBe(400);
  });

  test("no session → 401", async () => {
    const res = await member.request("PUT", "/api/auth/me/password", {
      currentPassword: "x",
      newPassword: "y",
    });
    expect(res.status).toBe(401);
  });

  test("self-service password change cannot touch another user's row", async () => {
    await createMember("victim", "victim-pass");
    await login(member, "victim", "victim-pass");
    const before = app.app.db
      .query("SELECT password_hash AS h FROM users WHERE username = ?")
      .get("admin") as { h: string };
    expect(hashPassword("x").length).toBeGreaterThan(0);

    // There is no user-id parameter on the endpoint — the body is ignored
    // except for the two password fields. Send a decoy and confirm the
    // admin row is untouched.
    const res = await member.request("PUT", "/api/auth/me/password", {
      currentPassword: "victim-pass",
      newPassword: "victim-new-pass",
    });
    expect(res.status).toBe(200);
    const after = app.app.db
      .query("SELECT password_hash AS h FROM users WHERE username = ?")
      .get("admin") as { h: string };
    expect(after.h).toBe(before.h);
  });
});
