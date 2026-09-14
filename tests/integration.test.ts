import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type { AdminUser, OwnedItem, PublicItem, WishlistSummaryRow } from "../src/shared/types";

let app: TestAppHandle;
let admin: Jar;

async function login(jar: Jar, username: string, password: string): Promise<void> {
  const res = await jar.request("POST", "/api/auth/login", { username, password });
  expect(res.status).toBe(200);
}

async function createUser(
  adminJar: Jar,
  username: string,
  password: string,
  displayName?: string,
): Promise<string> {
  const res = await adminJar.request("POST", "/api/users", {
    username,
    password,
    displayName,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as AdminUser;
  return body.id;
}

async function createItem(
  jar: Jar,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<OwnedItem> {
  const res = await jar.request("POST", "/api/wishlist/items", { title, ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as OwnedItem;
}

beforeAll(() => {
  app = createTestApp();
  admin = app.newJar();
});

afterAll(async () => {
  await app.cleanup();
});

describe("wishlist API", () => {
  test("unauthenticated wishlist summary → 401", async () => {
    const stranger = app.newJar();
    const res = await stranger.request("GET", "/api/wishlist/summary");
    expect(res.status).toBe(401);
  });

  test("admin creates Carol; Carol listed; non-admin users list → 403", async () => {
    await login(admin, "admin", "admin-password");
    await createUser(admin, "carol", "carol-pass", "Carol");

    const list = await admin.request("GET", "/api/users");
    expect(list.status).toBe(200);
    const users = (await list.json()) as AdminUser[];
    expect(users.some((u) => u.username === "carol" && u.displayName === "Carol")).toBe(true);

    const carol = app.newJar();
    await login(carol, "carol", "carol-pass");
    const forbidden = await carol.request("GET", "/api/users");
    expect(forbidden.status).toBe(403);
  });

  test("Carol creates an item; her own list returns OwnedItem with no claim keys", async () => {
    const carol = app.newJar();
    await login(carol, "carol", "carol-pass");

    const created = await createItem(carol, "Teapot", { priceCents: "12.50", currency: "GBP" });
    expect(created.title).toBe("Teapot");
    expect("claimed" in created).toBe(false);
    expect("claimedByYou" in created).toBe(false);

    const carolRow = app.app.db
      .query("SELECT id FROM users WHERE username = ?")
      .get("carol") as { id: string };
    const list = await carol.request("GET", `/api/users/${carolRow.id}/wishlist`);
    expect(list.status).toBe(200);
    const items = (await list.json()) as OwnedItem[];
    expect(items.length).toBe(1);
    expect("claimed" in items[0]).toBe(false);
    expect("claimedByYou" in items[0]).toBe(false);
  });

  test("THE invariant: owner never receives claim state; non-owners get booleans", async () => {
    const alice = app.newJar();
    const bob = app.newJar();
    const carol = app.newJar();

    // Real actors: use dedicated users to avoid cross-test interference.
    const aliceId = await createUser(admin, "alice", "alice-pass", "Alice");
    const bobId = await createUser(admin, "bob", "bob-pass", "Bob");
    await login(alice, "alice", "alice-pass");
    await login(bob, "bob", "bob-pass");

    const item = await createItem(alice, "Lava lamp", { priceCents: "29.99", currency: "GBP" });

    const claimed = await bob.request("POST", `/api/wishlist/items/${item.id}/claim`);
    expect(claimed.status).toBe(200);

    // Alice's own view: the item is present but claim state is ABSENT —
    // both in the item keys and anywhere in the payload.
    const ownerList = await alice.request("GET", `/api/users/${aliceId}/wishlist`);
    expect(ownerList.status).toBe(200);
    const ownerPayload = JSON.stringify(await ownerList.json());
    expect(ownerPayload).not.toContain("claimed");
    const ownerItems = JSON.parse(ownerPayload) as OwnedItem[];
    expect(ownerItems.some((i) => i.id === item.id)).toBe(true);
    expect("claimed" in ownerItems[0]).toBe(false);

    // Bob's view: claimed and claimedByYou true.
    const bobList = await bob.request("GET", `/api/users/${aliceId}/wishlist`);
    const bobItems = (await bobList.json()) as PublicItem[];
    const bobItem = bobItems.find((i) => i.id === item.id) as PublicItem;
    expect(bobItem.claimed).toBe(true);
    expect(bobItem.claimedByYou).toBe(true);

    // Carol's view: claimed true, claimedByYou false.
    await login(carol, "carol", "carol-pass");
    const carolList = await carol.request("GET", `/api/users/${aliceId}/wishlist`);
    const carolItems = (await carolList.json()) as PublicItem[];
    const carolItem = carolItems.find((i) => i.id === item.id) as PublicItem;
    expect(carolItem.claimed).toBe(true);
    expect(carolItem.claimedByYou).toBe(false);

    expect(bobId).toBeTruthy();
  });

  test("claim conflict: 409 for a second claimant; only the claimant can unclaim", async () => {
    const alice = app.newJar();
    const bob = app.newJar();
    const carol = app.newJar();
    await login(alice, "alice", "alice-pass");
    await login(bob, "bob", "bob-pass");
    await login(carol, "carol", "carol-pass");

    const item = await createItem(alice, "Conflict mug");

    const first = await bob.request("POST", `/api/wishlist/items/${item.id}/claim`);
    expect(first.status).toBe(200);

    const conflict = await carol.request("POST", `/api/wishlist/items/${item.id}/claim`);
    expect(conflict.status).toBe(409);

    const carolUnclaim = await carol.request("POST", `/api/wishlist/items/${item.id}/unclaim`);
    expect(carolUnclaim.status).toBe(403);

    const bobUnclaim = await bob.request("POST", `/api/wishlist/items/${item.id}/unclaim`);
    expect(bobUnclaim.status).toBe(200);
    const unclaimedBody = (await bobUnclaim.json()) as PublicItem;
    expect(unclaimedBody.claimed).toBe(false);

    const reclaim = await bob.request("POST", `/api/wishlist/items/${item.id}/claim`);
    expect(reclaim.status).toBe(200);
  });

  test("edit/delete are owner-only", async () => {
    const alice = app.newJar();
    const bob = app.newJar();
    await login(alice, "alice", "alice-pass");
    await login(bob, "bob", "bob-pass");

    const item = await createItem(alice, "Owner-only notebook");

    const aliceEdit = await alice.request("PATCH", `/api/wishlist/items/${item.id}`, {
      title: "Renamed notebook",
    });
    expect(aliceEdit.status).toBe(200);
    const renamed = (await aliceEdit.json()) as OwnedItem;
    expect(renamed.title).toBe("Renamed notebook");

    const bobEdit = await bob.request("PATCH", `/api/wishlist/items/${item.id}`, { title: "Hacked" });
    expect(bobEdit.status).toBe(403);

    const bobDelete = await bob.request("DELETE", `/api/wishlist/items/${item.id}`);
    expect(bobDelete.status).toBe(403);

    const aliceDelete = await alice.request("DELETE", `/api/wishlist/items/${item.id}`);
    expect(aliceDelete.status).toBe(204);
  });

  test("user lifecycle: deactivate → reactivate → reset-password → delete", async () => {
    const carol = app.newJar();
    await login(carol, "carol", "carol-pass");
    const carolRow = app.app.db.query("SELECT id FROM users WHERE username = ?").get("carol") as {
      id: string;
    };
    const item = await createItem(carol, "Carol keeps this");

    // Deactivate: Carol's session dies, but her list stays visible.
    const deact = await admin.request("POST", `/api/users/${carolRow.id}/deactivate`);
    expect(deact.status).toBe(200);
    const meAfterDeact = await carol.request("GET", "/api/auth/me");
    expect(meAfterDeact.status).toBe(401);

    const bob = app.newJar();
    await login(bob, "bob", "bob-pass");
    const carolList = await bob.request("GET", `/api/users/${carolRow.id}/wishlist`);
    expect(carolList.status).toBe(200);
    const items = (await carolList.json()) as PublicItem[];
    expect(items.some((i) => i.title === "Carol keeps this")).toBe(true);

    // Reactivate → Carol can log in again.
    const react = await admin.request("POST", `/api/users/${carolRow.id}/activate`);
    expect(react.status).toBe(200);
    await login(carol, "carol", "carol-pass");

    // Reset password: Carol's current session dies, new password works.
    const reset = await admin.request("POST", `/api/users/${carolRow.id}/reset-password`, {
      password: "new-carol-pass",
    });
    expect(reset.status).toBe(200);
    const meAfterReset = await carol.request("GET", "/api/auth/me");
    expect(meAfterReset.status).toBe(401);
    await login(carol, "carol", "new-carol-pass");

    // Delete Dave: his items vanish from all lists; his claims are released.
    const daveId = await createUser(admin, "dave", "dave-pass", "Dave");
    const dave = app.newJar();
    await login(dave, "dave", "dave-pass");
    await createItem(dave, "Dave's thing");
    const aliceJar = app.newJar();
    await login(aliceJar, "alice", "alice-pass");
    const aliceItem = await createItem(aliceJar, "Alice claims target");
    const daveClaim = await dave.request("POST", `/api/wishlist/items/${aliceItem.id}/claim`);
    expect(daveClaim.status).toBe(200);

    const del = await admin.request("DELETE", `/api/users/${daveId}`);
    expect(del.status).toBe(204);

    const daveList = await bob.request("GET", `/api/users/${daveId}/wishlist`);
    expect(daveList.status).toBe(404);

    const aliceList = await bob.request("GET", `/api/users/${(await aliceIdOf())}/wishlist`);
    const aliceItems = (await aliceList.json()) as PublicItem[];
    const released = aliceItems.find((i) => i.id === aliceItem.id) as PublicItem;
    expect(released.claimed).toBe(false);

    const summary = await bob.request("GET", "/api/wishlist/summary");
    const rows = (await summary.json()) as WishlistSummaryRow[];
    expect(rows.some((r) => r.userId === daveId)).toBe(false);
  });

  test("username uniqueness is case-insensitive", async () => {
    const res = await admin.request("POST", "/api/users", {
      username: "CAROL",
      password: "whatever",
    });
    expect(res.status).toBe(409);
  });

  test("price handling: decimal string in, decimal string out; invalid → 400", async () => {
    const carol = app.newJar();
    await login(carol, "carol", "new-carol-pass");

    const good = await createItem(carol, "Price probe", { priceCents: "24.99", currency: "GBP" });
    expect(good.priceCents).toBe("24.99");
    const stored = app.app.db
      .query("SELECT price_cents, currency FROM wishlist_items WHERE id = ?")
      .get(good.id) as { price_cents: number; currency: string };
    expect(stored.price_cents).toBe(2499);
    expect(stored.currency).toBe("GBP");

    const negative = await carol.request("POST", "/api/wishlist/items", {
      title: "Negative",
      priceCents: "-5.00",
    });
    expect(negative.status).toBe(400);

    const nonNumeric = await carol.request("POST", "/api/wishlist/items", {
      title: "Not a number",
      priceCents: "abc",
    });
    expect(nonNumeric.status).toBe(400);
  });

  test("health endpoint is public", async () => {
    const res = await fetch(`${app.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("sort_order persists and drives list order", async () => {
    const alice = app.newJar();
    await login(alice, "alice", "alice-pass");
    const aliceId = await aliceIdOf();

    const first = await createItem(alice, "First item");
    const second = await createItem(alice, "Second item");

    // Both default to sort_order 0 → creation order. Move first to the end.
    const patch = await alice.request("PATCH", `/api/wishlist/items/${first.id}`, { sortOrder: 1 });
    expect(patch.status).toBe(200);

    const list = await alice.request("GET", `/api/users/${aliceId}/wishlist`);
    const items = (await list.json()) as OwnedItem[];
    const relevant = items.filter((i) => i.id === first.id || i.id === second.id);
    expect(relevant.map((i) => i.id)).toEqual([second.id, first.id]);
  });

  test("tags round-trip as an array; invalid type → 400", async () => {
    const carol = app.newJar();
    await login(carol, "carol", "new-carol-pass");

    const tagged = await createItem(carol, "Tagged thing", {
      tags: ["Birthday", "Someday"],
    });
    expect(tagged.tags).toEqual(["Birthday", "Someday"]);

    const invalid = await carol.request("POST", "/api/wishlist/items", {
      title: "Bad tags",
      tags: "not-an-array",
    });
    expect(invalid.status).toBe(400);
  });
});

async function aliceIdOf(): Promise<string> {
  const row = app.app.db.query("SELECT id FROM users WHERE username = ?").get("alice") as {
    id: string;
  };
  return row.id;
}