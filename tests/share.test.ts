import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type { OwnedItem, ShareLinkResponse, ShareView } from "../src/shared/types";

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

/** Owner session + one item, via the public API (proves composition). */
async function seedItem(title: string, extra: Record<string, unknown> = {}): Promise<OwnedItem> {
  const res = await admin.request("POST", "/api/wishlist/items", { title, ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as OwnedItem;
}

/** Mints a fresh active token for the admin (rotating any previous one). */
async function activeToken(): Promise<string> {
  const res = await admin.request("POST", "/api/share");
  expect(res.status).toBe(201);
  return ((await res.json()) as ShareLinkResponse).token as string;
}

describe("anonymous share view", () => {
  test("view works without a session; item fields + display name, no owner identity", async () => {
    await loginAsAdmin();
    await seedItem("Teapot", {
      priceCents: "12.50",
      currency: "GBP",
      notes: "Green one",
      tags: ["kitchen"],
    });
    const token = await activeToken();

    const stranger = app.newJar(); // no session at all
    const res = await stranger.request("GET", `/api/share/${token}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as ShareView;
    expect(view.ownerDisplayName).toBe("Admin");
    expect(view.viewerIsOwner).toBe(false);
    expect(view.items).toHaveLength(1);
    const item = view.items[0];
    expect(item.title).toBe("Teapot");
    expect(item.priceCents).toBe("12.50");
    expect(item.currency).toBe("GBP");
    expect(item.notes).toBe("Green one");
    expect(item.tags).toEqual(["kitchen"]);
    expect(item.hasImage).toBe(false);
    expect(item.purchased).toBe(false);

    // Shape test — the security contract as data:
    const payload = JSON.stringify(view);
    for (const forbidden of [
      "claimed",
      "claimedByYou",
      "claimed_by", // claim state: never on the share surface
      "hintPrice",
      "hintSource",
      "priceStats",
      "cheaperUrl",
      "priceSource", // owner-only data
      "username",
      "isAdmin",
      "is_admin",
      "password", // owner identity / admin info
      "purchased_at",
      "purchasedAt",
      "updatedAt",
      "sortOrder",
      "fetchState",
      "imagePath",
      "imageSource",
      "user_id",
      "userId",
    ]) {
      expect(payload).not.toContain(forbidden);
    }
  });

  test("404 after revoke — view, and unknown tokens look identical", async () => {
    await loginAsAdmin();
    await seedItem("Vanishing");
    const token = await activeToken();
    const stranger = app.newJar();
    expect((await stranger.request("GET", `/api/share/${token}`)).status).toBe(200);

    expect((await admin.request("DELETE", "/api/share")).status).toBe(204);
    expect((await stranger.request("GET", `/api/share/${token}`)).status).toBe(404);
    const bogus = await stranger.request("GET", `/api/share/${"ab".repeat(32)}`);
    expect(bogus.status).toBe(404);
    const revBody = await (await stranger.request("GET", `/api/share/${token}`)).json();
    const bogBody = await bogus.json();
    expect(revBody).toEqual(bogBody); // indistinguishable 404s
  });

  test("deactivated owner's link → 404 (dark), reactivation restores it", async () => {
    await loginAsAdmin();
    const create = await admin.request("POST", "/api/users", {
      username: "friend",
      password: "friend-pass",
      displayName: "Friend",
    });
    expect(create.status).toBe(201);
    const friendId = ((await create.json()) as { id: string }).id;

    const friend = app.newJar();
    expect(
      (await friend.request("POST", "/api/auth/login", { username: "friend", password: "friend-pass" })).status,
    ).toBe(200);
    const fItem = await friend.request("POST", "/api/wishlist/items", { title: "Friend thing" });
    expect(fItem.status).toBe(201);
    const fToken = ((await (await friend.request("POST", "/api/share")).json()) as ShareLinkResponse)
      .token as string;

    const stranger = app.newJar();
    const before = (await (await stranger.request("GET", `/api/share/${fToken}`)).json()) as ShareView;
    expect(before.ownerDisplayName).toBe("Friend");
    expect(before.items.map((i) => i.title)).toEqual(["Friend thing"]);

    expect((await admin.request("POST", `/api/users/${friendId}/deactivate`)).status).toBe(200);
    expect((await stranger.request("GET", `/api/share/${fToken}`)).status).toBe(404);

    // Reactivation restores the link: it was never revoked, only dark.
    expect((await admin.request("POST", `/api/users/${friendId}/activate`)).status).toBe(200);
    expect((await stranger.request("GET", `/api/share/${fToken}`)).status).toBe(200);
  });
});
