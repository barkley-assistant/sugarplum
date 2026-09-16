import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type { ShareLinkResponse } from "../src/shared/types";

let app: TestAppHandle;
let admin: Jar;

beforeEach(() => {
  app = createTestApp();
  admin = app.newJar();
});

afterEach(async () => {
  await app.cleanup();
});

async function loginAsAdmin(): Promise<string> {
  const res = await admin.request("POST", "/api/auth/login", {
    username: "admin",
    password: "admin-password",
  });
  expect(res.status).toBe(200);
  const row = app.app.db.query("SELECT id FROM users WHERE username = ?").get("admin") as {
    id: string;
  };
  return row.id;
}

describe("share token management (owner-only)", () => {
  test("unauthenticated share management → 401", async () => {
    const res = await app.request("GET", "/api/share");
    expect(res.status).toBe(401);
  });

  test("GET before creating → { token: null, path: null }", async () => {
    await loginAsAdmin();
    const res = await admin.request("GET", "/api/share");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, path: null });
  });

  test("POST mints a 64-char hex token, stored server-side, idempotent GET", async () => {
    await loginAsAdmin();
    const res = await admin.request("POST", "/api/share");
    expect(res.status).toBe(201);
    const body = (await res.json()) as ShareLinkResponse;
    expect(body.token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex — unguessability/length test
    expect(body.path).toBe(`/share/${body.token}`);
    const row = app.app.db
      .query("SELECT user_id, revoked_at FROM share_tokens WHERE token = ?")
      .get(body.token as string) as { user_id: string; revoked_at: string | null };
    expect(row.revoked_at).toBeNull();

    const again = await admin.request("GET", "/api/share");
    expect(await again.json()).toEqual({ token: body.token, path: body.path });
  });

  test("POST rotates: old token dies in the same transaction, new one works", async () => {
    const id = await loginAsAdmin();
    const first = ((await (await admin.request("POST", "/api/share")).json()) as ShareLinkResponse)
      .token as string;
    const secondRes = await admin.request("POST", "/api/share");
    expect(secondRes.status).toBe(201);
    const second = ((await secondRes.json()) as ShareLinkResponse).token as string;
    expect(second).not.toBe(first);
    const dead = app.app.db
      .query("SELECT revoked_at FROM share_tokens WHERE token = ?")
      .get(first) as { revoked_at: string | null };
    expect(dead.revoked_at).not.toBeNull();
    // Owner row intact, exactly one active token remains.
    const active = app.app.db
      .query("SELECT COUNT(*) AS n FROM share_tokens WHERE user_id = ? AND revoked_at IS NULL")
      .get(id) as { n: number };
    expect(active.n).toBe(1);
  });

  test("DELETE revokes; GET returns null; DELETE again still 204 (idempotent)", async () => {
    await loginAsAdmin();
    await admin.request("POST", "/api/share");
    const del = await admin.request("DELETE", "/api/share");
    expect(del.status).toBe(204);
    const got = await admin.request("GET", "/api/share");
    expect(await got.json()).toEqual({ token: null, path: null });
    expect((await admin.request("DELETE", "/api/share")).status).toBe(204);
  });

  test("each user gets their own link: one user's token never serves another's list", async () => {
    await loginAsAdmin();
    const other = app.newJar();
    await admin.request("POST", "/api/users", {
      username: "second",
      password: "second-pass",
      displayName: "Second",
    });
    await other.request("POST", "/api/auth/login", { username: "second", password: "second-pass" });
    const mine = ((await (await admin.request("POST", "/api/share")).json()) as ShareLinkResponse)
      .token as string;
    const theirs = ((await (await other.request("POST", "/api/share")).json()) as ShareLinkResponse)
      .token as string;
    expect(theirs).not.toBe(mine);

    const ownerOfMine = app.app.db
      .query("SELECT user_id FROM share_tokens WHERE token = ?")
      .get(mine) as { user_id: string };
    const ownerOfTheirs = app.app.db
      .query("SELECT user_id FROM share_tokens WHERE token = ?")
      .get(theirs) as { user_id: string };
    expect(ownerOfMine.user_id).not.toBe(ownerOfTheirs.user_id);

    // Revoking one user's link leaves the other user's link alone.
    expect((await admin.request("DELETE", "/api/share")).status).toBe(204);
    expect((await other.request("GET", "/api/share")).json()).resolves.toEqual({
      token: theirs,
      path: `/share/${theirs}`,
    });
  });
});
