import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type { AdminUser } from "../src/shared/types";

let app: TestAppHandle;
let admin: Jar;

beforeEach(() => {
  app = createTestApp();
  admin = app.newJar();
});

afterEach(async () => {
  await app.cleanup();
});

async function loginAsAdmin(): Promise<void> {
  const res = await admin.request("POST", "/api/auth/login", {
    username: "admin",
    password: "admin-password",
  });
  expect(res.status).toBe(200);
}

/** Id of the env-bootstrapped sole admin (DB pattern: integration.test.ts:198). */
function bootstrapAdminId(): string {
  const row = app.app.db
    .query("SELECT id FROM users WHERE username = ?")
    .get("admin") as { id: string };
  return row.id;
}

describe("last-admin guard", () => {
  test("deleting the last active admin → 409 with a clear message", async () => {
    await loginAsAdmin();
    const id = bootstrapAdminId();

    const res = await admin.request("DELETE", `/api/users/${id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("last active admin");

    // The admin row survives untouched.
    const row = app.app.db
      .query("SELECT is_admin, is_active FROM users WHERE id = ?")
      .get(id) as { is_admin: number; is_active: number };
    expect(row.is_admin).toBe(1);
    expect(row.is_active).toBe(1);
  });

  test("deactivating the last active admin → 409; session stays valid", async () => {
    await loginAsAdmin();
    const id = bootstrapAdminId();

    const res = await admin.request("POST", `/api/users/${id}/deactivate`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("last active admin");

    const me = await admin.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
  });

  test("with a second active admin, deactivate/activate/delete are allowed; guard re-engages when they are gone", async () => {
    await loginAsAdmin();
    const id = bootstrapAdminId();

    const created = await admin.request("POST", "/api/users", {
      username: "admin2",
      password: "admin2-pass",
      isAdmin: true,
    });
    expect(created.status).toBe(201);
    const secondId = ((await created.json()) as AdminUser).id;

    // Target the SECOND admin throughout so the acting session (bootstrap
    // admin) never loses its own row.
    const deact = await admin.request("POST", `/api/users/${secondId}/deactivate`);
    expect(deact.status).toBe(200);
    const react = await admin.request("POST", `/api/users/${secondId}/activate`);
    expect(react.status).toBe(200);
    const del = await admin.request("DELETE", `/api/users/${secondId}`);
    expect(del.status).toBe(204);

    // Back to one active admin → the guard must be back on.
    const blocked = await admin.request("DELETE", `/api/users/${id}`);
    expect(blocked.status).toBe(409);
  });

  test("inactive admins don't count: they don't unlock the last active admin, and remain deletable", async () => {
    await loginAsAdmin();
    const id = bootstrapAdminId();

    const created = await admin.request("POST", "/api/users", {
      username: "admin2",
      password: "admin2-pass",
      isAdmin: true,
    });
    expect(created.status).toBe(201);
    const secondId = ((await created.json()) as AdminUser).id;
    const deact = await admin.request("POST", `/api/users/${secondId}/deactivate`);
    expect(deact.status).toBe(200); // allowed: bootstrap admin still active

    // An inactive admin exists, but the ACTIVE pool is still just one →
    // the bootstrap admin stays protected.
    const blocked = await admin.request("POST", `/api/users/${id}/deactivate`);
    expect(blocked.status).toBe(409);

    // The inactive admin itself is removable (recovery path for the
    // pre-existing deadlock state).
    const del = await admin.request("DELETE", `/api/users/${secondId}`);
    expect(del.status).toBe(204);
  });
});
