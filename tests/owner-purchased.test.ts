import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type { OwnedItem } from "../src/shared/types";

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

async function seedItem(title: string): Promise<OwnedItem> {
  const res = await admin.request("POST", "/api/wishlist/items", { title });
  expect(res.status).toBe(201);
  return (await res.json()) as OwnedItem;
}

describe("owner purchased mark", () => {
  test("PUT marks; response carries ownerPurchased true; DB timestamp set", async () => {
    await loginAsAdmin();
    const item = await seedItem("Self-bought");
    const res = await admin.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OwnedItem;
    expect(body.id).toBe(item.id);
    expect(body.ownerPurchased).toBe(true);
    const row = app.app.db
      .query("SELECT owner_purchased, owner_purchased_at FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased: number; owner_purchased_at: string | null };
    expect(row.owner_purchased).toBe(1);
    expect(row.owner_purchased_at).not.toBeNull();
  });

  test("re-PUT is idempotent: owner_purchased_at unchanged", async () => {
    await loginAsAdmin();
    const item = await seedItem("Re-put");
    await admin.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    const before = app.app.db
      .query("SELECT owner_purchased_at FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased_at: string };
    const again = await admin.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    expect(again.status).toBe(200);
    const after = app.app.db
      .query("SELECT owner_purchased_at FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased_at: string };
    expect(after.owner_purchased_at).toBe(before.owner_purchased_at);
  });

  test("DELETE clears; 204 empty; idempotent on never-marked; unknown item 404", async () => {
    await loginAsAdmin();
    const item = await seedItem("Undo me");
    await admin.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    const del = await admin.request("DELETE", `/api/wishlist/items/${item.id}/owner-purchased`);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    const row = app.app.db
      .query("SELECT owner_purchased, owner_purchased_at FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased: number; owner_purchased_at: string | null };
    expect(row.owner_purchased).toBe(0);
    expect(row.owner_purchased_at).toBeNull();
    // Never-marked → still 204 (idempotent).
    expect(
      (await admin.request("DELETE", `/api/wishlist/items/${item.id}/owner-purchased`)).status,
    ).toBe(204);
    // Unknown item → 404.
    expect(
      (await admin.request("DELETE", `/api/wishlist/items/${crypto.randomUUID()}/owner-purchased`))
        .status,
    ).toBe(404);
    expect(
      (await admin.request("PUT", `/api/wishlist/items/${crypto.randomUUID()}/owner-purchased`))
        .status,
    ).toBe(404);
  });

  test("non-owner → 403, no state change; unauthenticated → 401", async () => {
    await loginAsAdmin();
    const item = await seedItem("Guarded");
    const create = await admin.request("POST", "/api/users", {
      username: "snoop",
      password: "snoop-pass",
      displayName: "Snoop",
    });
    expect(create.status).toBe(201);
    const snoop = app.newJar();
    await snoop.request("POST", "/api/auth/login", { username: "snoop", password: "snoop-pass" });
    const deniedPut = await snoop.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    expect(deniedPut.status).toBe(403);
    const deniedDel = await snoop.request(
      "DELETE",
      `/api/wishlist/items/${item.id}/owner-purchased`,
    );
    expect(deniedDel.status).toBe(403);
    const row = app.app.db
      .query("SELECT owner_purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased: number };
    expect(row.owner_purchased).toBe(0);

    const anon = app.newJar();
    expect(
      (await anon.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`)).status,
    ).toBe(401);
  });

  test("owner list read carries the owner's own mark (and only that)", async () => {
    const adminId = await loginAsAdmin();
    const item = await seedItem("List reads it");
    await admin.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    const list = await admin.request("GET", `/api/users/${adminId}/wishlist`);
    expect(list.status).toBe(200);
    const items = (await list.json()) as OwnedItem[];
    const mine = items.find((i) => i.id === item.id);
    expect(mine?.ownerPurchased).toBe(true);
  });

  test("PRIVACY: an anonymous share mark is invisible next to the owner's own mark", async () => {
    const adminId = await loginAsAdmin();
    const item = await seedItem("Both flags");
    // Owner marks their own.
    await admin.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    // An anonymous friend ALSO marks via the share link.
    const tokenRes = await admin.request("POST", "/api/share");
    expect(tokenRes.status).toBe(201);
    const token = ((await tokenRes.json()) as { token: string }).token;
    const anon = app.newJar();
    const purchase = await anon.request("POST", `/api/share/${token}/items/${item.id}/purchase`, {
      confirm: true,
    });
    expect(purchase.status).toBe(200);

    const row = app.app.db
      .query("SELECT owner_purchased, purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased: number; purchased: number };
    expect(row.owner_purchased).toBe(1);
    expect(row.purchased).toBe(1); // both flags independently set

    // The owner's response carries ONLY the owner's own mark — and NOTHING
    // about the anonymous one: no purchased/purchased_at key, no value
    // derived from the anonymous flag.
    const list = (await (
      await admin.request("GET", `/api/users/${adminId}/wishlist`)
    ).json()) as Record<string, unknown>[];
    const mine = list.find((i) => i.id === item.id) as Record<string, unknown>;
    expect(mine.ownerPurchased).toBe(true);
    expect(Object.keys(mine)).not.toContain("purchased");
    expect(Object.keys(mine)).not.toContain("purchasedAt");
    expect(JSON.stringify(mine)).not.toContain("purchased_at");

    // Public + share projections unchanged: PublicItem has no owner mark,
    // share view (as another anonymous viewer) shows only the anonymous flag.
    const create = await admin.request("POST", "/api/users", {
      username: "reg-friend",
      password: "reg-pass",
      displayName: "Reg",
    });
    expect(create.status).toBe(201);
    const regFriend = app.newJar();
    await regFriend.request("POST", "/api/auth/login", {
      username: "reg-friend",
      password: "reg-pass",
    });
    const publicView = (await (
      await regFriend.request("GET", `/api/users/${adminId}/wishlist`)
    ).json()) as Record<string, unknown>[];
    const pub = publicView.find((i) => i.id === item.id) as Record<string, unknown>;
    expect(Object.keys(pub)).not.toContain("ownerPurchased");
    expect(Object.keys(pub)).not.toContain("purchased");

    const shareView = (await (
      await app.newJar().request("GET", `/api/share/${token}`)
    ).json()) as { items: Record<string, unknown>[] };
    const shared = shareView.items.find((i) => i.id === item.id) as Record<string, unknown>;
    expect(Object.keys(shared)).not.toContain("ownerPurchased");
    expect(shared.purchased).toBe(true); // anonymous mark intact for anon viewers
  });

  test("PRIVACY: the blind share reset never clears the owner's mark, and vice versa", async () => {
    await loginAsAdmin();
    const item = await seedItem("Isolated");
    await admin.request("PUT", `/api/wishlist/items/${item.id}/owner-purchased`);
    const tokenRes = await admin.request("POST", "/api/share");
    const token = ((await tokenRes.json()) as { token: string }).token;
    const anon = app.newJar();
    await anon.request("POST", `/api/share/${token}/items/${item.id}/purchase`, { confirm: true });

    // Blind reset clears ONLY the anonymous flag.
    expect(
      (await admin.request("DELETE", `/api/wishlist/items/${item.id}/purchased`)).status,
    ).toBe(204);
    let row = app.app.db
      .query("SELECT owner_purchased, purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased: number; purchased: number };
    expect(row.purchased).toBe(0);
    expect(row.owner_purchased).toBe(1); // owner mark survives the blind reset

    // Owner unmark clears ONLY the owner flag.
    expect(
      (await admin.request("DELETE", `/api/wishlist/items/${item.id}/owner-purchased`)).status,
    ).toBe(204);
    await anon.request("POST", `/api/share/${token}/items/${item.id}/purchase`, { confirm: true });
    row = app.app.db
      .query("SELECT owner_purchased, purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { owner_purchased: number; purchased: number };
    expect(row.owner_purchased).toBe(0);
    expect(row.purchased).toBe(1); // anonymous mark survives the owner unmark
  });

  test("the share-route owner guard still fires (unchanged behavior)", async () => {
    await loginAsAdmin();
    const item = await seedItem("Guard intact");
    const tokenRes = await admin.request("POST", "/api/share");
    const token = ((await tokenRes.json()) as { token: string }).token;
    const res = await admin.request("POST", `/api/share/${token}/items/${item.id}/purchase`, {
      confirm: true,
    });
    expect(res.status).toBe(400); // "Cannot mark your own item as purchased"
    const row = app.app.db
      .query("SELECT purchased, owner_purchased FROM wishlist_items WHERE id = ?")
      .get(item.id) as { purchased: number; owner_purchased: number };
    expect(row.purchased).toBe(0);
    expect(row.owner_purchased).toBe(0); // and it did NOT set the owner flag either
  });
});
