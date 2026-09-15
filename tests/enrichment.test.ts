// tests/enrichment.test.ts — ALL scrape/searxng/image targets are local
// Bun.serve instances; the enrichment queue's fetches stay on localhost.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import type { OwnedItem } from "../src/shared/types";

const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
// Minimal JPEG payload (magic: FF D8 FF) — the shopify-local fixture's
// og:image points at /img/trio.jpg with Content-Type image/jpeg, so header
// and magic agree and the file is stored as .jpg.
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const FIXTURES = join(import.meta.dir, "fixtures");

async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await Bun.sleep(25);
  }
  return false;
}

async function login(jar: Jar, username: string, password: string): Promise<void> {
  const res = await jar.request("POST", "/api/auth/login", { username, password });
  expect(res.status).toBe(200);
}

async function myId(jar: Jar): Promise<string> {
  const res = await jar.request("GET", "/api/auth/me");
  const me = (await res.json()) as { id: string };
  return me.id;
}

async function waitForFetchState(
  jar: Jar,
  userId: string,
  itemId: string,
  state: string,
): Promise<boolean> {
  return waitFor(async () => {
    const res = await jar.request("GET", `/api/users/${userId}/wishlist`);
    if (res.status !== 200) return false;
    const items = (await res.json()) as OwnedItem[];
    const item = items.find((i) => i.id === itemId);
    return item !== undefined && item.fetchState === state;
  });
}

function serveShopifyPage(): ReturnType<typeof serve> {
  return serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/img/trio.jpg") {
        return new Response(JPEG_BYTES, { headers: { "Content-Type": "image/jpeg" } });
      }
      const html = await Bun.file(join(FIXTURES, "shopify-local.html")).text();
      return new Response(html);
    },
  });
}

let app: TestAppHandle;
let admin: Jar;

beforeAll(() => {
  app = createTestApp();
  admin = app.newJar();
});

afterAll(async () => {
  await app.cleanup();
});

describe("async enrichment", () => {
  test("create with url → pending → poll until complete (title/price/currency/siteName from fixture)", async () => {
    await login(admin, "admin", "admin-password");
    const shop = serveShopifyPage();
    const userId = await myId(admin);
    try {
      const res = await admin.request("POST", "/api/wishlist/items", {
        url: `http://127.0.0.1:${shop.port}/product`,
      });
      expect(res.status).toBe(201);
      const item = (await res.json()) as OwnedItem;
      expect(item.fetchState).toBe("pending");

      expect(await waitForFetchState(admin, userId, item.id, "complete")).toBe(true);

      const list = await admin.request("GET", `/api/users/${userId}/wishlist`);
      const items = (await list.json()) as OwnedItem[];
      const enriched = items.find((i) => i.id === item.id) as OwnedItem;
      expect(enriched.title).toBe("Fresh Kiss Trio");
      expect(enriched.priceCents).toBe("25.00");
      expect(enriched.currency).toBe("USD");
      expect(enriched.siteName).toBe("ColourPop");
      expect(enriched.imagePath).toBe(`${item.id}.jpg`);

      // Image file exists on disk and the image route serves it.
      expect(await Bun.file(join(app.app.config.imagesDir, `${item.id}.jpg`)).exists()).toBe(true);
      const img = await admin.request("GET", `/api/wishlist/items/${item.id}/image`);
      expect(img.status).toBe(200);
      const bytes = new Uint8Array(await img.arrayBuffer());
      expect(bytes.length).toBe(JPEG_BYTES.length);

      // price_history row on the scrape path.
      const history = app.app.db
        .query("SELECT price_cents, currency, source FROM price_history WHERE item_id = ?")
        .all(item.id) as { price_cents: number; currency: string; source: string }[];
      expect(history.some((h) => h.price_cents === 2500 && h.currency === "USD" && h.source === "scrape")).toBe(true);
    } finally {
      shop.stop(true);
    }
  });

  test("bot-walled URL → fetchState 'failed' + last_fetch_error mentions heuristic; item still listed", async () => {
    await login(admin, "admin", "admin-password");
    const userId = await myId(admin);
    const botwall = await Bun.file(join(FIXTURES, "botwall-captcha.html")).text();
    const wall = serve({ port: 0, fetch: () => new Response(botwall, { status: 200 }) });
    try {
      const res = await admin.request("POST", "/api/wishlist/items", {
        url: `http://127.0.0.1:${wall.port}/product`,
      });
      expect(res.status).toBe(201);
      const item = (await res.json()) as OwnedItem;

      expect(await waitForFetchState(admin, userId, item.id, "failed")).toBe(true);

      const row = app.app.db
        .query("SELECT fetch_state, last_fetch_error FROM wishlist_items WHERE id = ?")
        .get(item.id) as { fetch_state: string; last_fetch_error: string | null };
      expect(row.fetch_state).toBe("failed");
      expect(row.last_fetch_error).toContain("captcha");

      // Item is still listed (graceful degradation, not a dead end).
      const list = await admin.request("GET", `/api/users/${userId}/wishlist`);
      const items = (await list.json()) as OwnedItem[];
      expect(items.some((i) => i.id === item.id)).toBe(true);
    } finally {
      wall.stop(true);
    }
  });

  test("mid-body stall: server sends headers then never closes the body → fetchState 'failed' + 'network' error, NOT stuck 'pending' (dead-end regression)", async () => {
    await login(admin, "admin", "admin-password");
    const userId = await myId(admin);
    const stall = serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html><head><title>partial"));
            // never close() — the body stalls after the headers
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    try {
      const res = await admin.request("POST", "/api/wishlist/items", {
        url: `http://127.0.0.1:${stall.port}/stall`,
      });
      expect(res.status).toBe(201);
      const item = (await res.json()) as OwnedItem;

      // The default scrape timeout is 10s; wait past it for the failure to land.
      expect(
        await waitFor(async () => {
          const list = await admin.request("GET", `/api/users/${userId}/wishlist`);
          if (list.status !== 200) return false;
          const items = (await list.json()) as OwnedItem[];
          return items.find((i) => i.id === item.id)?.fetchState === "failed";
        }, 15_000),
      ).toBe(true);

      const row = app.app.db
        .query("SELECT fetch_state, last_fetch_error FROM wishlist_items WHERE id = ?")
        .get(item.id) as { fetch_state: string; last_fetch_error: string | null };
      expect(row.fetch_state).toBe("failed");
      expect(row.last_fetch_error).toContain("network");

      // Item still listed → Retry affordance available, no dead end.
      const list = await admin.request("GET", `/api/users/${userId}/wishlist`);
      const items = (await list.json()) as OwnedItem[];
      expect(items.some((i) => i.id === item.id)).toBe(true);
    } finally {
      stall.stop(true);
    }
  }, 20_000);

  test("bot-walled URL + searxng configured + hint found → fetchState 'complete' + hint_* stored + price_history row (source 'searxng-hint'); price_cents stays NULL", async () => {
    const botwall = await Bun.file(join(FIXTURES, "botwall-captcha.html")).text();
    const wall = serve({ port: 0, fetch: () => new Response(botwall, { status: 200 }) });
    const searx = serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Teapot 123 — Reseller",
                url: "https://reseller.example.com/p/1",
                content: "Only £25.00 today",
              },
            ],
          }),
        ),
    });
    const hintApp = createTestApp({ searxngUrl: `http://127.0.0.1:${searx.port}` });
    const jar = hintApp.newJar();
    await login(jar, "admin", "admin-password");
    const userId = await myId(jar);
    try {
      const res = await jar.request("POST", "/api/wishlist/items", {
        url: `http://127.0.0.1:${wall.port}/product`,
      });
      expect(res.status).toBe(201);
      const item = (await res.json()) as OwnedItem;

      expect(await waitForFetchState(jar, userId, item.id, "complete")).toBe(true);

      const row = hintApp.app.db
        .query(
          `SELECT fetch_state, price_cents, hint_price_cents, hint_currency, hint_source_url
           FROM wishlist_items WHERE id = ?`,
        )
        .get(item.id) as {
        fetch_state: string;
        price_cents: number | null;
        hint_price_cents: number;
        hint_currency: string;
        hint_source_url: string;
      };
      expect(row.fetch_state).toBe("complete");
      expect(row.price_cents).toBeNull();
      expect(row.hint_price_cents).toBe(2500);
      expect(row.hint_currency).toBe("GBP");
      expect(row.hint_source_url).toBe("https://reseller.example.com/p/1");

      const history = hintApp.app.db
        .query("SELECT price_cents, source FROM price_history WHERE item_id = ?")
        .all(item.id) as { price_cents: number; source: string }[];
      expect(history.some((h) => h.price_cents === 2500 && h.source === "searxng-hint")).toBe(true);

      const list = await jar.request("GET", `/api/users/${userId}/wishlist`);
      const items = (await list.json()) as OwnedItem[];
      const dto = items.find((i) => i.id === item.id) as OwnedItem;
      expect(dto.priceCents).toBeNull();
      expect(dto.hintPriceCents).toBe("25.00");
    } finally {
      wall.stop(true);
      searx.stop(true);
      await hintApp.cleanup();
    }
  });

  test("enrichment does not clobber a user-set title or price", async () => {
    await login(admin, "admin", "admin-password");
    const shop = serveShopifyPage();
    const userId = await myId(admin);
    try {
      const res = await admin.request("POST", "/api/wishlist/items", {
        url: `http://127.0.0.1:${shop.port}/product`,
        title: "My own title",
        priceCents: "5.00",
        currency: "GBP",
      });
      expect(res.status).toBe(201);
      const item = (await res.json()) as OwnedItem;

      expect(await waitForFetchState(admin, userId, item.id, "complete")).toBe(true);

      const list = await admin.request("GET", `/api/users/${userId}/wishlist`);
      const items = (await list.json()) as OwnedItem[];
      const enriched = items.find((i) => i.id === item.id) as OwnedItem;
      expect(enriched.title).toBe("My own title");
      expect(enriched.priceCents).toBe("5.00");
      expect(enriched.currency).toBe("GBP");

      // The scraped price is still recorded to history.
      const history = app.app.db
        .query("SELECT price_cents, source FROM price_history WHERE item_id = ?")
        .all(item.id) as { price_cents: number; source: string }[];
      expect(history.some((h) => h.price_cents === 2500 && h.source === "scrape")).toBe(true);
    } finally {
      shop.stop(true);
    }
  });

  test("concurrency cap: 3 enqueues against a 300ms-stalling server → max in-flight ≤ 2 (server-side counter)", async () => {
    await login(admin, "admin", "admin-password");
    const userId = await myId(admin);
    const html = await Bun.file(join(FIXTURES, "shopify-local.html")).text();
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/img/trio.jpg") {
          return new Response(PNG_1X1, { headers: { "Content-Type": "image/jpeg" } });
        }
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Bun.sleep(300);
        concurrent--;
        return new Response(html);
      },
    });
    const capApp = createTestApp({ maxEnrichConcurrency: 2 });
    const jar = capApp.newJar();
    await login(jar, "admin", "admin-password");
    const capUserId = await myId(jar);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await jar.request("POST", "/api/wishlist/items", {
          url: `http://127.0.0.1:${slow.port}/product/${i}`,
        });
        expect(res.status).toBe(201);
        const item = (await res.json()) as OwnedItem;
        ids.push(item.id);
      }
      // All three eventually complete (no deadlock at the cap).
      expect(
        await waitFor(async () => {
          const res = await jar.request("GET", `/api/users/${capUserId}/wishlist`);
          const items = (await res.json()) as OwnedItem[];
          return ids.every((id) => items.find((i) => i.id === id)?.fetchState === "complete");
        }),
      ).toBe(true);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    } finally {
      slow.stop(true);
      await capApp.cleanup();
    }
  });

  test("refresh on a failed item clears last_fetch_error once enrichment succeeds", async () => {
    await login(admin, "admin", "admin-password");
    const userId = await myId(admin);
    const botwall = await Bun.file(join(FIXTURES, "botwall-captcha.html")).text();
    const goodHtml = await Bun.file(join(FIXTURES, "shopify-local.html")).text();
    let serveGood = false;
    const flip = serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/img/trio.jpg") {
          return new Response(JPEG_BYTES, { headers: { "Content-Type": "image/jpeg" } });
        }
        return new Response(serveGood ? goodHtml : botwall, { status: 200 });
      },
    });
    try {
      const res = await admin.request("POST", "/api/wishlist/items", {
        url: `http://127.0.0.1:${flip.port}/product`,
      });
      expect(res.status).toBe(201);
      const item = (await res.json()) as OwnedItem;

      // First pass: bot-walled → failed with an error mentioning the heuristic.
      expect(await waitForFetchState(admin, userId, item.id, "failed")).toBe(true);
      let row = app.app.db
        .query("SELECT fetch_state, last_fetch_error FROM wishlist_items WHERE id = ?")
        .get(item.id) as { fetch_state: string; last_fetch_error: string | null };
      expect(row.fetch_state).toBe("failed");
      expect(row.last_fetch_error).toContain("captcha");

      // The site opens up; the owner retries via refresh.
      serveGood = true;
      const refresh = await admin.request("POST", `/api/wishlist/items/${item.id}/refresh`);
      expect(refresh.status).toBe(202);
      const refreshed = (await refresh.json()) as OwnedItem;
      expect(refreshed.fetchState).toBe("pending");

      expect(await waitForFetchState(admin, userId, item.id, "complete")).toBe(true);
      const rowAfter = app.app.db
        .query("SELECT fetch_state, last_fetch_error, title FROM wishlist_items WHERE id = ?")
        .get(item.id) as { fetch_state: string; last_fetch_error: string | null; title: string };
      expect(rowAfter.fetch_state).toBe("complete");
      expect(rowAfter.last_fetch_error).toBeNull();
      expect(rowAfter.title).toBe("Fresh Kiss Trio");
    } finally {
      flip.stop(true);
    }
  });

  test("crash sweep: stop app mid-pending → reboot on same dbPath marks the row 'failed'", async () => {
    const stall = serve({
      port: 0,
      fetch: async () => {
        await new Promise(() => {});
        return new Response("never");
      },
    });
    const app1 = createTestApp();
    const jar1 = app1.newJar();
    await login(jar1, "admin", "admin-password");
    const res = await jar1.request("POST", "/api/wishlist/items", {
      url: `http://127.0.0.1:${stall.port}/hang`,
    });
    expect(res.status).toBe(201);
    const item = (await res.json()) as OwnedItem;

    // Worker is stuck on the stall; the row is still pending.
    const rowBefore = app1.app.db
      .query("SELECT fetch_state FROM wishlist_items WHERE id = ?")
      .get(item.id) as { fetch_state: string };
    expect(rowBefore.fetch_state).toBe("pending");

    // Simulate a crash: stop the server WITHOUT deleting the DB file.
    await app1.app.stop();
    const dbPath = app1.app.config.dbPath;
    stall.stop(true);

    try {
      const app2 = createTestApp({ dbPath });
      try {
        const row = app2.app.db
          .query("SELECT fetch_state, last_fetch_error FROM wishlist_items WHERE id = ?")
          .get(item.id) as { fetch_state: string; last_fetch_error: string | null };
        expect(row.fetch_state).toBe("failed");
        expect(row.last_fetch_error).toBe("Interrupted by restart");
      } finally {
        await app2.cleanup();
      }
    } finally {
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
  });
});