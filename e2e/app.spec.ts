import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4599";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// One worker, one shared server: the specs build on each other's state.
test.describe.configure({ mode: "serial" });

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // App shell appears once the session is established (nav = wishlist switcher).
  await expect(page.getByRole("navigation")).toBeVisible();
}

/** Every test gets a fresh context, so log the admin in up front. */
test.beforeEach(async ({ page }) => {
  await login(page, "admin", "admin-password");
});

test("1: login lands on the app shell with the own empty state", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Nothing saved yet." })).toBeVisible();
  await expect(page.getByText("Paste a product link to start your list.")).toBeVisible();
});

test("2: manual add shows a card with a formatted price", async ({ page }) => {
  await page.getByRole("button", { name: "Add item" }).click();
  const sheet = page.getByRole("dialog", { name: "Add item" });
  await sheet.getByLabel("Title").fill("Manual mug");
  await sheet.getByLabel("Price").fill("12.50");
  await sheet.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("heading", { name: "Manual mug" })).toBeVisible();
  await expect(page.getByText("£12.50")).toBeVisible();
});

test("3: paste-link add scrapes a local fixture and resolves", async ({ page }) => {
  const fixture = await startFixtureServer();
  try {
    await page.getByRole("button", { name: "Add item" }).click();
    const sheet = page.getByRole("dialog", { name: "Add item" });
    await sheet.getByLabel("Link").fill(`${fixture.url}/product`);
    await sheet.getByRole("button", { name: "Add item" }).click();
    // The scrape on a fast local fixture may resolve before the provisional
    // "Fetching details…" state can be asserted; the contract is that the
    // item RESOLVES (fetchState complete / title updated).
    await expect(page.getByRole("heading", { name: "Fresh Kiss Trio" })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    fixture.close();
  }
});

test("4: editing an item persists after reload", async ({ page }) => {
  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "Manual mug" }),
  });
  await card.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Title").fill("Manual mug v2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Manual mug v2" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Manual mug v2" })).toBeVisible();
});

test("5: drag reorder persists after reload", async ({ page }) => {
  for (const title of ["Reorder one", "Reorder two", "Reorder three"]) {
    const res = await page.request.post(`${BASE}/api/wishlist/items`, { data: { title } });
    expect(res.status()).toBe(201);
  }
  await page.reload();
  const titles = page.locator(".item-card .item-title");
  await expect(titles.last()).toHaveText("Reorder three");

  // Drag the LAST card's handle above the FIRST card. dragTo scrolls both
  // into view; the pointer state machine lifts on pointerdown (mouse) and
  // reorders on pointermove.
  await page.locator(".drag-handle").last().dragTo(page.locator(".item-card").first());

  await expect(titles.first()).toHaveText("Reorder three");
  await page.reload();
  await expect(page.locator(".item-card .item-title").first()).toHaveText("Reorder three");
});

test("6: tag filter shows only matching items and preserves order", async ({ page }) => {
  const tagged = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Birthday candle", tags: ["Birthday"] },
  });
  expect(tagged.status()).toBe(201);
  const plain = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Plain notebook" },
  });
  expect(plain.status()).toBe(201);
  await page.reload();

  const titles = page.locator(".item-card .item-title");
  const before = await titles.allTextContents();
  expect(before).toContain("Birthday candle");
  expect(before).toContain("Plain notebook");

  await page.getByRole("button", { name: /Birthday/ }).click();
  await expect(page.locator(".item-card")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Birthday candle" })).toBeVisible();

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".item-card")).toHaveCount(before.length);
  expect(await titles.allTextContents()).toEqual(before);
});

test("7: claim/unclaim between users; owner never sees claim state", async ({ page, browser }) => {
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username: "boop", password: "boop-pass", displayName: "Boop" },
  });
  expect(created.status()).toBe(201);
  const claimable = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Claimable mug" },
  });
  expect(claimable.status()).toBe(201);

  const context = await browser.newContext();
  const bob = await context.newPage();
  try {
    await login(bob, "boop", "boop-pass");
    await bob.getByRole("button", { name: "View Admin's list" }).click();
    const card = bob.locator(".item-card", {
      has: bob.getByRole("heading", { name: "Claimable mug" }),
    });
    await card.getByRole("button", { name: "Claim" }).click();
    await expect(card.getByText("Claimed by you")).toBeVisible();
    await card.getByRole("button", { name: "Unclaim" }).click();
    await expect(card.getByText("Claimed by you")).not.toBeVisible();
  } finally {
    await context.close();
  }

  // The owner's own view never surfaces claim state.
  await page.reload();
  const ownCard = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "Claimable mug" }),
  });
  await expect(ownCard.getByText(/Claimed/)).toHaveCount(0);
});

test("8: share-target GET prefills and creates the item", async ({ page }) => {
  await page.goto(`${BASE}/add?url=https://example.com/x&title=Share test`);
  const sheet = page.getByRole("dialog", { name: "Add item" });
  await expect(sheet.getByLabel("Link")).toHaveValue("https://example.com/x");
  await sheet.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("heading", { name: "Share test" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Share test" })).toBeVisible();
});

test("9: no horizontal overflow at 360/390/430px", async ({ page }) => {
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload();
    const probe = await page.evaluate(() => {
      const doc = document.documentElement;
      const docOverflow = doc.scrollWidth > doc.clientWidth;
      // Flag only TRUE escapes: elements past the right edge with no
      // clipping/scrollable ancestor (contained escapes are fine).
      const offenders: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 1) {
          let anc = el.parentElement;
          let contained = false;
          while (anc) {
            const cs = getComputedStyle(anc);
            if (
              cs.overflowX === "hidden" ||
              cs.overflowX === "clip" ||
              cs.overflowX === "auto" ||
              cs.overflowX === "scroll"
            ) {
              contained = true;
              break;
            }
            anc = anc.parentElement;
          }
          if (!contained) {
            offenders.push(`${el.tagName}.${(el as HTMLElement).className}`);
          }
        }
      }
      return {
        docOverflow,
        docScrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        offenders,
      };
    });
    expect(probe.docOverflow, `document overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `true escapes at ${width}px`).toEqual([]);
  }
});

test("10: dark mode flips the surface tokens", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${BASE}/`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(12, 10, 15)"); // --bg dark: #0c0a0f
  expect(bg).not.toBe("rgb(250, 250, 250)"); // --bg light: #fafafa
});

test("11: manifest and service worker are installed", async ({ page }) => {
  const manifestRes = await page.request.get(`${BASE}/manifest.webmanifest`);
  expect(manifestRes.status()).toBe(200);
  const manifest = (await manifestRes.json()) as { name: string; share_target: unknown };
  expect(manifest.name).toBe("sugarplum");
  expect(manifest.share_target).toBeTruthy();

  const swRes = await page.request.get(`${BASE}/sw.js`);
  expect(swRes.status()).toBe(200);

  await page.goto(`${BASE}/`);
  const scriptUrl = await page.evaluate(() =>
    navigator.serviceWorker.ready.then((reg) => (reg.active ? reg.active.scriptURL : "")),
  );
  expect(scriptUrl).toContain("/sw.js");
});

test("12: primary button contrast meets WCAG AA (>= 4.5)", async ({ page }) => {
  await page.getByRole("button", { name: "Add item" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add item" });
  const submit = sheet.getByRole("button", { name: "Add item" });
  const ratio = await submit.evaluate((el) => {
    const cs = getComputedStyle(el);
    const parse = (s: string): number[] => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const lum = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bg = lum(parse(cs.backgroundColor));
    const fg = lum(parse(cs.color));
    return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

/** Local static fixture server: the app's scraper (server-side) fetches it,
 *  so it must listen on 127.0.0.1 — the e2e server runs with
 *  SUGARPLUM_ALLOW_PRIVATE_FETCH=1 (global-setup). */
async function startFixtureServer(): Promise<{ url: string; close: () => void }> {
  const html = await readFile(join(ROOT, "tests", "fixtures", "shopify-local.html"), "utf8");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture.local");
      if (url.pathname === "/img/trio.jpg") {
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        res.end(jpeg);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
      });
    });
  });
}