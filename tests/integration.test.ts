import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type {
  AdminUser,
  Me,
  OwnedItem,
  PriceHintsResponse,
  PublicItem,
  WishlistSummaryRow,
} from "../src/shared/types";

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

    // #130: EVERY public row carries the ledger-summary field — an object, or
    // null for an item with no history, but never absent: the guest feed's
    // Lowest rule reads it directly, with no viewer branching.
    for (const row of bobItems) {
      expect("priceStats" in row).toBe(true);
      expect(row.priceStats === null || typeof row.priceStats === "object").toBe(true);
    }

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

    // D17 appends at max+10, so the pair is already ordered. Move first past
    // second with a larger sortOrder to prove PATCH sortOrder drives order.
    expect(first.sortOrder).toBeLessThan(second.sortOrder);
    const patch = await alice.request("PATCH", `/api/wishlist/items/${first.id}`, {
      sortOrder: second.sortOrder + 10,
    });
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

  test("sweep: undeclared /api/* → 404 JSON; missing user → 404; owner cannot claim own item", async () => {
    const stranger = app.newJar();
    await login(stranger, "admin", "admin-password");

    const unknown = await stranger.request("GET", "/api/does-not-exist");
    expect(unknown.status).toBe(404);
    const body = (await unknown.json()) as { error?: string };
    expect(body.error).toBe("Not found");

    const missingUser = await stranger.request("GET", "/api/users/00000000-0000-0000-0000-000000000000/wishlist");
    expect(missingUser.status).toBe(404);

    // Claiming one's own item is rejected, distinct from a conflict.
    const own = await createItem(stranger, "Own claim attempt");
    const ownClaim = await stranger.request("POST", `/api/wishlist/items/${own.id}/claim`);
    expect(ownClaim.status).toBe(400);
  });

  test("wave2: URL-only create → 201, provisional title = hostname, fetchState 'pending'", async () => {
    const alice = app.newJar();
    await login(alice, "alice", "alice-pass");
    const res = await alice.request("POST", "/api/wishlist/items", {
      url: closedLocalUrl(),
    });
    expect(res.status).toBe(201);
    const item = (await res.json()) as OwnedItem;
    expect(item.fetchState).toBe("pending");
    expect(item.title).toBe("127.0.0.1");
  });

  test("wave2: neither url nor title → 400; ftp:// → 400; >2048-char URL → 400", async () => {
    const alice = app.newJar();
    await login(alice, "alice", "alice-pass");

    const neither = await alice.request("POST", "/api/wishlist/items", {});
    expect(neither.status).toBe(400);

    const ftp = await alice.request("POST", "/api/wishlist/items", {
      title: "FTP thing",
      url: "ftp://example.com/file",
    });
    expect(ftp.status).toBe(400);

    const tooLong = await alice.request("POST", "/api/wishlist/items", {
      url: `https://example.com/${"x".repeat(2100)}`,
    });
    expect(tooLong.status).toBe(400);
  });

  test("wave2: refresh: owner POST /api/wishlist/items/:id/refresh → 202 + re-enriches; non-owner → 403; no-url item → 400; unauthenticated → 401", async () => {
    const alice = app.newJar();
    const bob = app.newJar();
    const stranger = app.newJar();
    await login(alice, "alice", "alice-pass");
    await login(bob, "bob", "bob-pass");

    const item = await createItem(alice, "Refresh me", { url: closedLocalUrl() });

    const unauth = await stranger.request("POST", `/api/wishlist/items/${item.id}/refresh`);
    expect(unauth.status).toBe(401);

    const forbidden = await bob.request("POST", `/api/wishlist/items/${item.id}/refresh`);
    expect(forbidden.status).toBe(403);

    const manual = await createItem(alice, "Manual item");
    const noUrl = await alice.request("POST", `/api/wishlist/items/${manual.id}/refresh`);
    expect(noUrl.status).toBe(400);

    const ok = await alice.request("POST", `/api/wishlist/items/${item.id}/refresh`);
    expect(ok.status).toBe(202);
    const body = (await ok.json()) as OwnedItem;
    expect(body.fetchState).toBe("pending");
  });

  test("wave2: refresh on a missing item → 404", async () => {
    const alice = app.newJar();
    await login(alice, "alice", "alice-pass");
    const res = await alice.request(
      "POST",
      "/api/wishlist/items/00000000-0000-0000-0000-000000000000/refresh",
    );
    expect(res.status).toBe(404);
  });

  test("wave2: fetchState + siteName present on owner list and public list", async () => {
    const alice = app.newJar();
    const bob = app.newJar();
    await login(alice, "alice", "alice-pass");
    await login(bob, "bob", "bob-pass");
    const aliceId = await aliceIdOf();

    // URL points at a closed local port: the enqueued worker fails fast and
    // locally — the DTO assertions below check field PRESENCE, so the item's
    // eventual state (pending/failed) is irrelevant to this test.
    const created = await alice.request("POST", "/api/wishlist/items", {
      url: closedLocalUrl(),
    });
    const item = (await created.json()) as OwnedItem;
    expect(item.fetchState).toBe("pending");
    expect(item.siteName).toBeNull();
    expect(item.hintPriceCents).toBeNull();

    const ownerList = await alice.request("GET", `/api/users/${aliceId}/wishlist`);
    const ownerItems = (await ownerList.json()) as OwnedItem[];
    const ownerItem = ownerItems.find((i) => i.id === item.id) as OwnedItem;
    expect(["pending", "complete", "failed"]).toContain(ownerItem.fetchState);
    expect("siteName" in ownerItem).toBe(true);
    expect("hintPriceCents" in ownerItem).toBe(true);

    // Public view: fetchState/siteName present, hint data is owner-only.
    const publicList = await bob.request("GET", `/api/users/${aliceId}/wishlist`);
    const publicItems = (await publicList.json()) as PublicItem[];
    const publicItem = publicItems.find((i) => i.id === item.id) as PublicItem;
    expect(["pending", "complete", "failed"]).toContain(publicItem.fetchState);
    expect("siteName" in publicItem).toBe(true);
    expect("hintPriceCents" in publicItem).toBe(false);
  });
});

describe("reorder", () => {
  /** Each test gets a dedicated user so the strict full-list match sees a
   *  controlled item set (the shared alice/bob lists accumulate items). */
  async function newUser(prefix: string): Promise<{ jar: Jar; id: string }> {
    const name = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    await login(admin, "admin", "admin-password");
    const id = await createUser(admin, name, "pass", prefix);
    const jar = app.newJar();
    await login(jar, name, "pass");
    return { jar, id };
  }

  test("reorder [c,a,b] persists → GET returns c,a,b", async () => {
    const { jar, id } = await newUser("reorder");
    const a = await createItem(jar, "Reorder A");
    const b = await createItem(jar, "Reorder B");
    const c = await createItem(jar, "Reorder C");

    const res = await jar.request("PUT", "/api/wishlist/order", { itemIds: [c.id, a.id, b.id] });
    expect(res.status).toBe(200);

    const list = await jar.request("GET", `/api/users/${id}/wishlist`);
    const items = (await list.json()) as OwnedItem[];
    expect(items.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
  });

  test("duplicate ids → 400", async () => {
    const { jar } = await newUser("reorder-dup");
    const a = await createItem(jar, "Dup A");
    const b = await createItem(jar, "Dup B");
    const res = await jar.request("PUT", "/api/wishlist/order", { itemIds: [a.id, a.id, b.id] });
    expect(res.status).toBe(400);
  });

  test("missing id (stale client) → 400", async () => {
    const { jar } = await newUser("reorder-missing");
    const a = await createItem(jar, "Missing A");
    const res = await jar.request("PUT", "/api/wishlist/order", {
      itemIds: [a.id, "00000000-0000-0000-0000-000000000000"],
    });
    expect(res.status).toBe(400);
  });

  test("foreign user's id → 400", async () => {
    const alice = await newUser("reorder-alice");
    const bob = await newUser("reorder-bob");
    const aliceItem = await createItem(alice.jar, "Alice's item");
    const bobItem = await createItem(bob.jar, "Bob's item");
    const res = await bob.jar.request("PUT", "/api/wishlist/order", {
      itemIds: [bobItem.id, aliceItem.id],
    });
    expect(res.status).toBe(400);
  });

  test("unauthenticated → 401", async () => {
    const stranger = app.newJar();
    const res = await stranger.request("PUT", "/api/wishlist/order", { itemIds: [] });
    expect(res.status).toBe(401);
  });

  test("empty list is a valid no-op → 200 (for an empty wishlist)", async () => {
    const { jar } = await newUser("reorder-empty");
    const res = await jar.request("PUT", "/api/wishlist/order", { itemIds: [] });
    expect(res.status).toBe(200);
  });

  test("items created after a reorder append to the bottom (sort_order 30, 40)", async () => {
    const { jar, id } = await newUser("reorder-append");
    const a = await createItem(jar, "Append A");
    const b = await createItem(jar, "Append B");

    const reorder = await jar.request("PUT", "/api/wishlist/order", { itemIds: [b.id, a.id] });
    expect(reorder.status).toBe(200);

    const c = await createItem(jar, "Append C");
    const d = await createItem(jar, "Append D");

    const list = await jar.request("GET", `/api/users/${id}/wishlist`);
    const items = (await list.json()) as OwnedItem[];
    expect(items.map((i) => i.id)).toEqual([b.id, a.id, c.id, d.id]);

    const rows = app.app.db
      .query("SELECT id, sort_order FROM wishlist_items WHERE id IN (?, ?, ?, ?)")
      .all(c.id, d.id, a.id, b.id) as { id: string; sort_order: number }[];
    const orderOf = Object.fromEntries(rows.map((r) => [r.id, r.sort_order]));
    expect(orderOf[c.id]).toBe(30);
    expect(orderOf[d.id]).toBe(40);
  });

  test("non-array / non-string itemIds → 400", async () => {
    const { jar } = await newUser("reorder-shape");
    const bad = await jar.request("PUT", "/api/wishlist/order", { itemIds: [1, 2] });
    expect(bad.status).toBe(400);
    const missing = await jar.request("PUT", "/api/wishlist/order", {});
    expect(missing.status).toBe(400);
  });
});

describe("price history", () => {
  /** A dedicated user per test: the shared admin/alice lists accumulate
   *  items, and these assertions count history rows per item. */
  async function newIsolatedUser(prefix: string): Promise<{ jar: Jar; id: string }> {
    await login(admin, "admin", "admin-password");
    const name = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    const id = await createUser(admin, name, "pass", prefix);
    const jar = app.newJar();
    await login(jar, name, "pass");
    return { jar, id };
  }

  async function listItem(jar: Jar, userId: string, itemId: string): Promise<OwnedItem> {
    const res = await jar.request("GET", `/api/users/${userId}/wishlist`);
    expect(res.status).toBe(200);
    const items = (await res.json()) as OwnedItem[];
    return items.find((i) => i.id === itemId) as OwnedItem;
  }

  test("manual POST price → price_source 'manual' + one 'manual' snapshot with stats", async () => {
    const { jar, id } = await newIsolatedUser("price-manual");
    const item = await createItem(jar, "Manual price probe", {
      priceCents: "12.50",
      currency: "GBP",
    });

    expect(item.priceSource).toBe("manual");
    expect(item.priceStats?.lowestCents).toBe("12.50");
    expect(item.priceStats?.atAddCents).toBe("12.50");
    expect(item.cheaperUrl).toBeNull();

    const rows = app.app.db
      .query("SELECT price_cents, currency, source FROM price_history WHERE item_id = ?")
      .all(item.id) as { price_cents: number; currency: string; source: string }[];
    expect(rows).toEqual([{ price_cents: 1250, currency: "GBP", source: "manual" }]);

    const fromList = await listItem(jar, id, item.id);
    expect(fromList.priceSource).toBe("manual");
    expect(fromList.priceStats?.atAddCurrency).toBe("GBP");
  });

  test("PATCH priceCents → a second manual snapshot (append-only ledger)", async () => {
    const { jar, id } = await newIsolatedUser("price-patch");
    const item = await createItem(jar, "Patched price probe", {
      priceCents: "12.50",
      currency: "GBP",
    });

    const patched = await jar.request("PATCH", `/api/wishlist/items/${item.id}`, {
      priceCents: "10.00",
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as OwnedItem;
    expect(body.priceCents).toBe("10.00");
    expect(body.priceSource).toBe("manual");

    const rows = app.app.db
      .query("SELECT price_cents, source FROM price_history WHERE item_id = ? ORDER BY rowid")
      .all(item.id) as { price_cents: number; source: string }[];
    expect(rows).toEqual([
      { price_cents: 1250, source: "manual" },
      { price_cents: 1000, source: "manual" },
    ]);

    // Lowest is the newer, lower price; "at add" stays the first observation.
    const fromList = await listItem(jar, id, item.id);
    expect(fromList.priceStats?.lowestCents).toBe("10.00");
    expect(fromList.priceStats?.atAddCents).toBe("12.50");
  });

  test("priceStats: lowest is the minimum, at-add is the earliest observation", async () => {
    const { jar, id } = await newIsolatedUser("price-stats");
    const item = await createItem(jar, "Stats probe");

    const day = 86_400_000;
    const d10 = new Date(Date.now() - 10 * day).toISOString();
    const d5 = new Date(Date.now() - 5 * day).toISOString();
    const d1 = new Date(Date.now() - 1 * day).toISOString();
    const insert = app.app.db.query(
      `INSERT INTO price_history (id, item_id, price_cents, currency, source, observed_at)
       VALUES (?, ?, ?, ?, 'scrape', ?)`,
    );
    insert.run(crypto.randomUUID(), item.id, 1200, "GBP", d10);
    insert.run(crypto.randomUUID(), item.id, 1000, "GBP", d5);
    insert.run(crypto.randomUUID(), item.id, 1500, "GBP", d1);

    const fromList = await listItem(jar, id, item.id);
    expect(fromList.priceStats).toEqual({
      lowestCents: "10.00",
      lowestCurrency: "GBP",
      lowestSeenAt: d5,
      atAddCents: "12.00",
      atAddCurrency: "GBP",
      series: [
        { observedAt: d10, priceCents: "12.00", currency: "GBP" },
        { observedAt: d5, priceCents: "10.00", currency: "GBP" },
        { observedAt: d1, priceCents: "15.00", currency: "GBP" },
      ],
      trend: {
        direction: "rising",
        advice: "near-30d-high",
        daysSinceDrop: 5,
      },
    });
  });

  test("priceStats series: one observation → insufficient trend; none → null", async () => {
    const { jar, id } = await newIsolatedUser("price-series");
    const item = await createItem(jar, "Series probe", {
      priceCents: "12.50",
      currency: "GBP",
    });

    const fromList = await listItem(jar, id, item.id);
    expect(fromList.priceStats?.series).toHaveLength(1);
    expect(fromList.priceStats?.trend).toEqual({
      direction: "stable",
      advice: "insufficient",
      daysSinceDrop: null,
    });
  });

  test("priceStats series: mixed currencies → series kept, trend null", async () => {
    const { jar, id } = await newIsolatedUser("price-mixed");
    const item = await createItem(jar, "Mixed probe", {
      priceCents: "12.50",
      currency: "GBP",
    });
    const insert = app.app.db.query(
      `INSERT INTO price_history (id, item_id, price_cents, currency, source, observed_at)
       VALUES (?, ?, ?, ?, 'scrape', ?)`,
    );
    insert.run(
      crypto.randomUUID(),
      item.id,
      1400,
      "USD",
      new Date(Date.now() - 86_400_000).toISOString(),
    );

    const fromList = await listItem(jar, id, item.id);
    expect(fromList.priceStats?.series).toHaveLength(2);
    expect(fromList.priceStats?.trend).toBeNull();
  });

  test("priceStats series is history, not the scheduler: present for opted-out users", async () => {
    const { jar, id } = await newIsolatedUser("price-optout");
    const item = await createItem(jar, "Opt-out probe", {
      priceCents: "9.99",
      currency: "GBP",
    });
    const off = await jar.request("PUT", "/api/auth/me/settings", {
      hintsEnabled: true,
      priceTrackingEnabled: false,
    });
    expect(off.status).toBe(200);

    // The toggle gates the scheduler pass, not the read: past observations
    // (manual edits, re-checks) are still returned.
    const fromList = await listItem(jar, id, item.id);
    expect(fromList.priceStats?.series).toHaveLength(1);
    expect(fromList.priceStats?.trend?.advice).toBe("insufficient");
  });

  test("an item with no price observations → priceStats null", async () => {
    const { jar, id } = await newIsolatedUser("price-none");
    const item = await createItem(jar, "No price probe");
    const fromList = await listItem(jar, id, item.id);
    expect(fromList.priceStats).toBeNull();
  });

  test("price stats are a product fact on both projections; the cheaper link stays owner-only", async () => {
    const { jar, id } = await newIsolatedUser("price-private");
    const item = await createItem(jar, "Private stats probe", {
      priceCents: "4.99",
      currency: "GBP",
      cheaperUrl: "https://elsewhere.example.com/cheaper",
    });

    const bob = app.newJar();
    await login(bob, "bob", "bob-pass");
    const res = await bob.request("GET", `/api/users/${id}/wishlist`);
    expect(res.status).toBe(200);
    const items = (await res.json()) as PublicItem[];
    const dto = items.find((i) => i.id === item.id) as PublicItem;
    // #130: the ledger summary is a PRODUCT fact, not owner data (the
    // anonymous share DTO has always carried it), and the guest feed now
    // renders the same "Lowest" rule as the owner's — one derivation, one
    // verdict, no viewer branching. The field is on the wire for both, with
    // the same numbers.
    expect("priceStats" in dto).toBe(true);
    expect(dto.priceStats).not.toBeNull();
    expect(dto.priceStats?.lowestCents).toBe(item.priceStats?.lowestCents);
    expect(dto.priceStats?.lowestCurrency).toBe(item.priceStats?.lowestCurrency);
    // Provenance and the owner's own "found it cheaper" link stay owner-only.
    expect("priceSource" in dto).toBe(false);
    expect("cheaperUrl" in dto).toBe(false);
    // The claim boundary the widening rides next to is unchanged.
    expect("claimed" in dto).toBe(true);
    expect(dto.claimedByYou).toBe(false);
  });

  test("cheaper link round-trip: POST, PATCH, clear with null; invalid → 400", async () => {
    const { jar, id } = await newIsolatedUser("price-cheaper");
    const item = await createItem(jar, "Cheaper link probe", {
      cheaperUrl: "https://elsewhere.example.com/first",
    });
    expect(item.cheaperUrl).toBe("https://elsewhere.example.com/first");

    const changed = await jar.request("PATCH", `/api/wishlist/items/${item.id}`, {
      cheaperUrl: "https://other.example.com/second",
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as OwnedItem).cheaperUrl).toBe("https://other.example.com/second");

    // Clearing does NOT touch the price ledger.
    const before = app.app.db
      .query("SELECT COUNT(*) AS n FROM price_history WHERE item_id = ?")
      .get(item.id) as { n: number };
    const cleared = await jar.request("PATCH", `/api/wishlist/items/${item.id}`, { cheaperUrl: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as OwnedItem).cheaperUrl).toBeNull();
    const after = app.app.db
      .query("SELECT COUNT(*) AS n FROM price_history WHERE item_id = ?")
      .get(item.id) as { n: number };
    expect(after.n).toBe(before.n);

    const invalid = await jar.request("POST", "/api/wishlist/items", {
      title: "Bad cheaper link",
      cheaperUrl: "not a url",
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toContain("cheaperUrl");
  });

  test("settings: PUT /api/auth/me/settings toggles the hints gate and /api/auth/me reflects it", async () => {
    const { jar } = await newIsolatedUser("price-settings");

    const me = await jar.request("GET", "/api/auth/me");
    expect(((await me.json()) as Me).hintsEnabled).toBe(true); // default ON

    const off = await jar.request("PUT", "/api/auth/me/settings", { hintsEnabled: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as Me).hintsEnabled).toBe(false);

    const afterOff = await jar.request("GET", "/api/auth/me");
    expect(((await afterOff.json()) as Me).hintsEnabled).toBe(false);

    const on = await jar.request("PUT", "/api/auth/me/settings", { hintsEnabled: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as Me).hintsEnabled).toBe(true);

    const invalid = await jar.request("PUT", "/api/auth/me/settings", { hintsEnabled: "yes" });
    expect(invalid.status).toBe(400);

    const stranger = app.newJar();
    const unauth = await stranger.request("PUT", "/api/auth/me/settings", { hintsEnabled: false });
    expect(unauth.status).toBe(401);
  });

  test("settings: PUT /api/auth/me/settings toggles daily price tracking", async () => {
    const { jar } = await newIsolatedUser("price-tracking-settings");

    const me = await jar.request("GET", "/api/auth/me");
    expect(((await me.json()) as Me).priceTrackingEnabled).toBe(true); // default ON

    const off = await jar.request("PUT", "/api/auth/me/settings", { priceTrackingEnabled: false });
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as Me;
    expect(offBody.priceTrackingEnabled).toBe(false);
    expect(offBody.hintsEnabled).toBe(true); // untouched knob keeps its value

    const afterOff = await jar.request("GET", "/api/auth/me");
    expect(((await afterOff.json()) as Me).priceTrackingEnabled).toBe(false);

    const both = await jar.request("PUT", "/api/auth/me/settings", {
      hintsEnabled: false,
      priceTrackingEnabled: true,
    });
    expect(both.status).toBe(200);
    const bothBody = (await both.json()) as Me;
    expect(bothBody.hintsEnabled).toBe(false);
    expect(bothBody.priceTrackingEnabled).toBe(true);

    const invalid = await jar.request("PUT", "/api/auth/me/settings", {
      priceTrackingEnabled: "yes",
    });
    expect(invalid.status).toBe(400);

    const empty = await jar.request("PUT", "/api/auth/me/settings", {});
    expect(empty.status).toBe(400);
  });

  test("settings: PUT /api/auth/me/settings opts into admin user management (#98)", async () => {
    const { jar } = await newIsolatedUser("admin-ui-settings");

    const me = await jar.request("GET", "/api/auth/me");
    expect(((await me.json()) as Me).showUserManagement).toBe(false); // default OFF

    const on = await jar.request("PUT", "/api/auth/me/settings", { showUserManagement: true });
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as Me;
    expect(onBody.showUserManagement).toBe(true);
    expect(onBody.hintsEnabled).toBe(true); // untouched knobs keep their values
    expect(onBody.priceTrackingEnabled).toBe(true);

    // Persisted, not just echoed: a fresh GET reads the stored row.
    const afterOn = await jar.request("GET", "/api/auth/me");
    expect(((await afterOn.json()) as Me).showUserManagement).toBe(true);

    const off = await jar.request("PUT", "/api/auth/me/settings", { showUserManagement: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as Me).showUserManagement).toBe(false);

    const invalid = await jar.request("PUT", "/api/auth/me/settings", { showUserManagement: "yes" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toBe("showUserManagement must be a boolean");

    const stranger = app.newJar();
    const unauth = await stranger.request("PUT", "/api/auth/me/settings", { showUserManagement: true });
    expect(unauth.status).toBe(401);
  });
});

describe("price hints route", () => {
  test("owner POST /hints → ≤3 title-derived candidates (stubbed searxng); 403 non-owner; 404 unknown", async () => {
    const seen: string[] = [];
    const searx = serve({
      port: 0,
      fetch: (req) => {
        seen.push(req.url);
        return new Response(
          JSON.stringify({
            results: [
              // The item's own shop — not a "hint" (research §Q2c noise).
              {
                title: "LEGO Architecture 21042 Statue of Liberty — John Lewis & Partners",
                url: "https://own.example.com/p/1",
                content: "£50.00",
              },
              // Same URL twice: deduped.
              { title: "Liberty elsewhere", url: "https://a.example.com/p/1", content: "£44.99" },
              { title: "Liberty elsewhere", url: "https://a.example.com/p/1", content: "£44.99" },
              // No parseable price: skipped.
              { title: "Review site", url: "https://review.example.com/x", content: "no price here" },
              { title: "Reseller one", url: "https://b.example.com/p/1", content: "Only £42.00" },
              { title: "Reseller two", url: "https://c.example.com/p/1", content: "€39,50" },
              // Fourth valid price — must be cut by the cap.
              { title: "Reseller three", url: "https://d.example.com/p/1", content: "£38.00" },
            ],
          }),
        );
      },
    });
    const hintApp = createTestApp({ searxngUrl: `http://127.0.0.1:${searx.port}` });
    const jar = hintApp.newJar();
    await login(jar, "admin", "admin-password");

    try {
      const created = await jar.request("POST", "/api/wishlist/items", {
        title: "LEGO Architecture 21042 Statue of Liberty",
        url: "https://own.example.com/p/1",
      });
      expect(created.status).toBe(201);
      const item = (await created.json()) as OwnedItem;

      const res = await jar.request("POST", `/api/wishlist/items/${item.id}/hints`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as PriceHintsResponse;
      expect(body.disabled).toBe(false);
      expect(body.hints.map((h) => h.sourceUrl)).toEqual([
        "https://a.example.com/p/1",
        "https://b.example.com/p/1",
        "https://c.example.com/p/1",
      ]);
      expect(body.hints[0]).toEqual({
        priceCents: "44.99",
        currency: "GBP",
        sourceUrl: "https://a.example.com/p/1",
        sourceTitle: "Liberty elsewhere",
      });
      expect(body.hints[2].priceCents).toBe("39.50"); // comma-decimal guard holds

      // Title-derived query, not the URL's path.
      expect(seen[0]).toContain(encodeURIComponent("LEGO Architecture 21042 Statue of Liberty buy"));

      // Nothing was persisted: still no direct price, no hint columns.
      const row = hintApp.app.db
        .query("SELECT price_cents, hint_price_cents FROM wishlist_items WHERE id = ?")
        .get(item.id) as { price_cents: number | null; hint_price_cents: number | null };
      expect(row.price_cents).toBeNull();
      expect(row.hint_price_cents).toBeNull();

      // Unauthenticated → 401; unknown id → 404.
      const stranger = hintApp.newJar();
      const unauth = await stranger.request("POST", `/api/wishlist/items/${item.id}/hints`);
      expect(unauth.status).toBe(401);

      const missing = await jar.request(
        "POST",
        "/api/wishlist/items/00000000-0000-0000-0000-000000000000/hints",
      );
      expect(missing.status).toBe(404);
    } finally {
      searx.stop(true);
      await hintApp.cleanup();
    }
  });

  test("non-owner POST /hints → 403 (separate user)", async () => {
    const searx = serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ results: [] })),
    });
    const hintApp = createTestApp({ searxngUrl: `http://127.0.0.1:${searx.port}` });
    const owner = hintApp.newJar();
    await login(owner, "admin", "admin-password");
    try {
      const created = await owner.request("POST", "/api/wishlist/items", { title: "Owned thing" });
      const item = (await created.json()) as OwnedItem;

      // A second user, created through the admin session.
      const created2 = await owner.request("POST", "/api/users", {
        username: "hints-bob",
        password: "bob-pass",
        displayName: "Bob",
      });
      expect(created2.status).toBe(201);
      const bob = hintApp.newJar();
      await login(bob, "hints-bob", "bob-pass");

      const res = await bob.request("POST", `/api/wishlist/items/${item.id}/hints`);
      expect(res.status).toBe(403);
    } finally {
      searx.stop(true);
      await hintApp.cleanup();
    }
  });

  test("hints enabled = 0 → { hints: [], disabled: true } and no search is made", async () => {
    let calls = 0;
    const searx = serve({
      port: 0,
      fetch: () => {
        calls++;
        return new Response(JSON.stringify({ results: [] }));
      },
    });
    const hintApp = createTestApp({ searxngUrl: `http://127.0.0.1:${searx.port}` });
    const jar = hintApp.newJar();
    await login(jar, "admin", "admin-password");
    try {
      const created = await jar.request("POST", "/api/wishlist/items", { title: "Hidden hints" });
      const item = (await created.json()) as OwnedItem;

      const off = await jar.request("PUT", "/api/auth/me/settings", { hintsEnabled: false });
      expect(off.status).toBe(200);

      const res = await jar.request("POST", `/api/wishlist/items/${item.id}/hints`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hints: [], disabled: true });
      expect(calls).toBe(0);
    } finally {
      searx.stop(true);
      await hintApp.cleanup();
    }
  });

  test("no SearXNG configured → 503 (the default deployment)", async () => {
    const alice = app.newJar();
    await login(alice, "alice", "alice-pass");
    const item = await createItem(alice, "Unconfigured hints probe");
    const res = await alice.request("POST", `/api/wishlist/items/${item.id}/hints`);
    expect(res.status).toBe(503);
  });
});

async function aliceIdOf(): Promise<string> {
  const row = app.app.db.query("SELECT id FROM users WHERE username = ?").get("alice") as {
    id: string;
  };
  return row.id;
}

/** A valid http URL on a just-freed local port: URL validation passes, the
 *  enqueued enrichment worker fails instantly with a network error, and no
 *  external network is touched. */
function closedLocalUrl(): string {
  const probe = serve({ port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  return `http://127.0.0.1:${port}/item`;
}