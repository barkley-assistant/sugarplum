import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApp, type Jar, type TestAppHandle, type TestResponse } from "./helpers";
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

async function purchase(
  token: string,
  itemId: string,
  body?: Record<string, unknown>,
): Promise<TestResponse> {
  return app.request(
    "POST",
    `/api/share/${token}/items/${itemId}/purchase`,
    body ?? { confirm: true },
  );
}

describe("anonymous purchased marking", () => {
  test("confirm field required: absent/false → 400, no state change", async () => {
    await loginAsAdmin();
    const item = await seedItem("Puzzle");
    const token = await activeToken();

    const noBody = await purchase(token, item.id, {});
    expect(noBody.status).toBe(400);
    const falseBody = await purchase(token, item.id, { confirm: false });
    expect(falseBody.status).toBe(400);
    const row = app.app.db
      .query("SELECT purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased: number };
    expect(row.purchased).toBe(0);
  });

  test("purchase marks the row; visible to a second anonymous viewer", async () => {
    await loginAsAdmin();
    const item = await seedItem("Board game");
    const token = await activeToken();

    const first = await purchase(token, item.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ id: item.id, purchased: true });

    const secondViewer = app.newJar();
    const view = (await (
      await secondViewer.request("GET", `/api/share/${token}`)
    ).json()) as ShareView;
    expect(view.items[0].purchased).toBe(true); // double-gift prevention
  });

  test("re-mark is idempotent (200, purchased_at unchanged)", async () => {
    await loginAsAdmin();
    const item = await seedItem("Socks");
    const token = await activeToken();
    await purchase(token, item.id);
    const before = app.app.db
      .query("SELECT purchased_at FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased_at: string };
    const again = await purchase(token, item.id);
    expect(again.status).toBe(200);
    const after = app.app.db
      .query("SELECT purchased_at FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased_at: string };
    expect(after.purchased_at).toBe(before.purchased_at);
  });

  test("THE INVARIANT: owner never receives purchased on any surface", async () => {
    await loginAsAdmin();
    const create = await admin.request("POST", "/api/users", {
      username: "giftee",
      password: "giftee-pass",
      displayName: "Giftee",
    });
    expect(create.status).toBe(201);
    const gifteeId = ((await create.json()) as { id: string }).id;

    const giftee = app.newJar();
    expect(
      (await giftee.request("POST", "/api/auth/login", { username: "giftee", password: "giftee-pass" }))
        .status,
    ).toBe(200);
    const itemRes = await giftee.request("POST", "/api/wishlist/items", { title: "Surprise" });
    expect(itemRes.status).toBe(201);
    const item = (await itemRes.json()) as OwnedItem;
    const tokenRes = await giftee.request("POST", "/api/share");
    expect(tokenRes.status).toBe(201);
    const token = ((await tokenRes.json()) as ShareLinkResponse).token as string;

    // An anonymous friend marks it purchased.
    const marked = await purchase(token, item.id);
    expect(marked.status).toBe(200);
    const row = app.app.db
      .query("SELECT purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased: number };
    expect(row.purchased).toBe(1); // it IS in the DB…

    // …and the owner sees NOTHING, anywhere:

    // 1. Their own list (OwnedItem must not even carry the field).
    const ownList = (await (
      await giftee.request("GET", `/api/users/${gifteeId}/wishlist`)
    ).json()) as OwnedItem[];
    const ownPayload = JSON.stringify(ownList);
    expect(ownPayload).not.toContain("purchased");
    expect(ownPayload).not.toContain("Purchased");

    // 2. Another registered user's PublicItem view (claims only, never purchase).
    const otherView = (await (
      await admin.request("GET", `/api/users/${gifteeId}/wishlist`)
    ).json()) as unknown[];
    expect(JSON.stringify(otherView)).not.toContain("purchased");

    // 3. The share view fetched WITH the owner's session cookie.
    const ownShare = await giftee.request("GET", `/api/share/${token}`);
    expect(ownShare.status).toBe(200);
    const shareView = (await ownShare.json()) as ShareView;
    expect(shareView.viewerIsOwner).toBe(true);
    expect(shareView.items[0].purchased).toBe(false); // projected out server-side

    // 4. The summary route (counts claims only).
    const summary = (await (await admin.request("GET", "/api/wishlist/summary")).json()) as {
      claimedCount: number;
    }[];
    expect(JSON.stringify(summary)).not.toContain("purchased");

    // But a fresh anonymous viewer DOES see it:
    const anonView = (await (
      await app.newJar().request("GET", `/api/share/${token}`)
    ).json()) as ShareView;
    expect(anonView.items[0].purchased).toBe(true);
  });

  test("owner cannot mark via own link: 400, no state change; unknown item → 404", async () => {
    await loginAsAdmin();
    const item = await seedItem("Own thing");
    const token = await activeToken();

    const res = await admin.request("POST", `/api/share/${token}/items/${item.id}/purchase`, {
      confirm: true,
    });
    expect(res.status).toBe(400);
    const row = app.app.db
      .query("SELECT purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased: number };
    expect(row.purchased).toBe(0);

    // Cross-token item: the token owner has no item with this id →
    // indistinguishable 404 (never 403 — no existence leak).
    const ghost = await purchase(token, crypto.randomUUID());
    expect(ghost.status).toBe(404);
  });

  test("rate limit: 6th purchase attempt in the window → 429 with Retry-After", async () => {
    await loginAsAdmin();
    const token = await activeToken();
    for (let i = 0; i < 5; i++) {
      const item = await seedItem(`Gift ${i}`);
      const res = await purchase(token, item.id);
      expect(res.status).toBe(200);
    }
    const sixth = await seedItem("Gift 5");
    const blocked = await purchase(token, sixth.id);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    const body = (await blocked.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    // No mutation snuck through with the 429.
    const row = app.app.db
      .query("SELECT purchased FROM wishlist_items WHERE id = ?")
      .get(sixth.id) as { purchased: number };
    expect(row.purchased).toBe(0);
  });

  test("revoked token: purchase → 404", async () => {
    await loginAsAdmin();
    const item = await seedItem("Poster");
    const token = await activeToken();
    expect((await admin.request("DELETE", "/api/share")).status).toBe(204);
    expect((await purchase(token, item.id)).status).toBe(404);
  });
});

describe("anonymous share image", () => {
  test("token-scoped image serves bytes; 404 for foreign items and dead tokens", async () => {
    await loginAsAdmin();
    const item = await seedItem("Framed print");
    // 1x1 transparent PNG. serveItemImage only needs the file to exist.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const path = `${item.id}.png`;
    await Bun.write(`${app.app.config.imagesDir}/${path}`, png);
    app.app.db.run("UPDATE wishlist_items SET image_path = ? WHERE id = ?", [path, item.id]);

    const token = await activeToken();
    // The share view advertises the image without leaking the filename.
    const stranger = app.newJar();
    const view = (await (await stranger.request("GET", `/api/share/${token}`)).json()) as ShareView;
    expect(view.items[0].hasImage).toBe(true);

    const res = await stranger.request("GET", `/api/share/${token}/items/${item.id}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");

    // Foreign / nonexistent item id → 404 (same as a dead token).
    expect(
      (await stranger.request("GET", `/api/share/${token}/items/${crypto.randomUUID()}/image`))
        .status,
    ).toBe(404);

    // An item id that exists but belongs to ANOTHER user is not reachable
    // through this token either.
    const other = app.newJar();
    await admin.request("POST", "/api/users", {
      username: "imgother",
      password: "imgother-pass",
      displayName: "Img Other",
    });
    await other.request("POST", "/api/auth/login", {
      username: "imgother",
      password: "imgother-pass",
    });
    const otherItem = await other.request("POST", "/api/wishlist/items", { title: "Other" });
    const otherId = ((await otherItem.json()) as OwnedItem).id;
    expect(
      (await stranger.request("GET", `/api/share/${token}/items/${otherId}/image`)).status,
    ).toBe(404);

    // Revocation kills image access (a copied link must not keep loading images).
    await admin.request("DELETE", "/api/share");
    expect(
      (await stranger.request("GET", `/api/share/${token}/items/${item.id}/image`)).status,
    ).toBe(404);
  });
});

describe("owner blind purchased reset", () => {
  test("non-owner → 403/404; owner → 204 blind; no purchased data in any owner response", async () => {
    await loginAsAdmin();
    const item = await seedItem("Bike");
    const token = await activeToken();
    await purchase(token, item.id); // an anonymous friend marks it

    // Another registered user cannot reset.
    const create = await admin.request("POST", "/api/users", {
      username: "snoop",
      password: "snoop-pass",
      displayName: "Snoop",
    });
    expect(create.status).toBe(201);
    const snoop = app.newJar();
    await snoop.request("POST", "/api/auth/login", { username: "snoop", password: "snoop-pass" });
    const denied = await snoop.request("DELETE", `/api/wishlist/items/${item.id}/purchased`);
    expect([403, 404]).toContain(denied.status);

    // The owner's own list must not carry the flag even while it is set.
    const ownList = await admin.request("GET", "/api/wishlist/summary");
    expect(JSON.stringify(await ownList.json())).not.toContain("purchased");

    // Owner resets blind: 204, zero body — reveals neither who nor when.
    const reset = await admin.request("DELETE", `/api/wishlist/items/${item.id}/purchased`);
    expect(reset.status).toBe(204);
    expect(await reset.text()).toBe("");

    const row = app.app.db
      .query("SELECT purchased, purchased_at FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased: number; purchased_at: string | null };
    expect(row.purchased).toBe(0);
    expect(row.purchased_at).toBeNull();

    // Idempotent for never-marked items.
    const item2 = await seedItem("Never marked");
    expect(
      (await admin.request("DELETE", `/api/wishlist/items/${item2.id}/purchased`)).status,
    ).toBe(204);

    // Unknown item → 404.
    expect(
      (await admin.request("DELETE", `/api/wishlist/items/${crypto.randomUUID()}/purchased`)).status,
    ).toBe(404);

    // The reset survives a second anonymous purchase (buyer re-marks).
    expect((await purchase(token, item.id)).status).toBe(200);
    const after = app.app.db
      .query("SELECT purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased: number };
    expect(after.purchased).toBe(1);
  });
});
