import { test, expect, type Locator, type Page } from "@playwright/test";
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
  // The SPA /login view bounces already-authenticated visitors to the feed
  // (INV-6), so a login inside a context that already holds a session cookie
  // must start cookieless — the cookie would otherwise win.
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // App shell appears once the session is established (heading = switcher).
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
}

/** Document-load counter (reused from spa.spec INV-4): addInitScript bumps a
 *  sessionStorage counter on every real document load, and sessionStorage
 *  survives same-origin loads in the tab — so the number only moves on a full
 *  reload. `performance.getEntriesByType("navigation")` cannot detect this
 *  (it is always length 1 in whatever document probes it). */
async function loads(page: Page): Promise<number> {
  return page.evaluate(() => Number(sessionStorage.getItem("docLoads") ?? 0));
}

/** Every test gets a fresh context, so log the admin in up front. */
test.beforeEach(async ({ page }) => {
  // One addInitScript per fresh page: it runs on every document load.
  await page.addInitScript(() => {
    sessionStorage.setItem("docLoads", String(Number(sessionStorage.getItem("docLoads") ?? 0) + 1));
  });
  await login(page, "admin", "admin-password");
});

/** Horizontal-overflow probe shared by the feed, guest and share surfaces:
 *  document overflow, plus TRUE element escapes (past the right edge with no
 *  clipping/scrollable ancestor — contained escapes are fine). */
async function horizontalEscapes(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const docOverflow = doc.scrollWidth > doc.clientWidth;
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
}

/** Waits for an overlay's own entry animation to settle, so geometry probes
 *  measure the resting layout instead of a mid-slide frame (the desktop
 *  drawer enters from translateX(100%)). */
async function settleEntryAnimation(locator: Locator) {
  await locator.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
}

/** Rendered WCAG contrast ratio of an element's text against the first opaque
 *  background behind it (walks ancestors, so transparent rows work). Pair it
 *  with emulateMedia({ colorScheme }) to prove both themes. */
async function contrast(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const numbers = (s: string): number[] => (s.match(/[\d.]+/g) ?? []).map(Number);
    const parse = (s: string): number[] => numbers(s).slice(0, 3);
    const opaque = (s: string): boolean => numbers(s).length < 4 || numbers(s)[3] === 1;
    const lum = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = lum(parse(getComputedStyle(el).color));
    let node: Element | null = el;
    let bg = [255, 255, 255];
    while (node) {
      const cs = getComputedStyle(node);
      if (opaque(cs.backgroundColor)) {
        bg = parse(cs.backgroundColor);
        break;
      }
      node = node.parentElement;
    }
    const lg = lum(bg);
    return (Math.max(fg, lg) + 0.05) / (Math.min(fg, lg) + 0.05);
  });
}

test("1: login lands on the app shell with the own empty state", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Nothing saved yet." })).toBeVisible();
  await expect(page.getByText("Paste a product link to start your list.")).toBeVisible();
});

test("2: manual add shows a card with a formatted price", async ({ page }) => {
  const before = await loads(page);
  await page.getByRole("button", { name: "Add item" }).first().click();
  // #62: add is a page, not a sheet — and the navigation is client-side.
  await expect(page).toHaveURL(`${BASE}/add`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Add details manually" }).click();
  await page.getByLabel("Title").fill("Manual mug");
  await page.getByLabel("Price").fill("12.50");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  expect(await loads(page)).toBe(before); // soft nav, no document reload
  await expect(page.getByRole("heading", { name: "Manual mug" })).toBeVisible();
  // Scope the price assertion to the card so other rows cannot match it.
  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "Manual mug" }),
  });
  await expect(card.locator(".price")).toHaveText("£12.50");
});

test("3: paste-link add scrapes a local fixture and resolves", async ({ page }) => {
  const fixture = await startFixtureServer();
  try {
    await page.getByRole("button", { name: "Add item" }).first().click();
    await expect(page).toHaveURL(`${BASE}/add`);
    await page.getByLabel("Link").fill(`${fixture.url}/product`);
    await page.getByRole("button", { name: "Add item" }).click();
    // The scrape on a fast local fixture may resolve before the provisional
    // "Fetching details…" state can be asserted; the contract is that the
    // item RESOLVES (fetchState complete / title updated).
    await expect(page.getByRole("heading", { name: "Fresh Kiss Trio" })).toBeVisible({
      timeout: 20_000,
    });
    const resolvedCard = page.locator(".item-card", {
      has: page.getByRole("heading", { name: "Fresh Kiss Trio" }),
    });
    await expect(resolvedCard).not.toHaveAttribute("data-fetch", "pending");
  } finally {
    fixture.close();
  }
});

test("3b: add details disclosure preserves values and link-only primary flow", async ({ page }) => {
  await page.getByRole("button", { name: "Add item" }).first().click();
  await expect(page).toHaveURL(`${BASE}/add`);
  // INV-B: nothing is focused on mount. This is the bug class the page exists
  // to close — an autofocused field pops the keyboard over a form the user
  // (often mid-share) has not engaged.
  await expect(page.getByLabel("Link")).not.toBeFocused();
  await expect(page.getByRole("button", { name: "Add details manually" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Title")).toHaveCount(0);

  await page.getByRole("button", { name: "Add details manually" }).click();
  await page.getByLabel("Title").fill("Disclosure probe");
  await page.getByLabel("Notes").fill("Kept while collapsed");
  await expect(page.getByLabel("Found it cheaper at")).toHaveCount(0);
  await page.getByLabel("Link").fill("https://example.com/disclosure-probe");
  await expect(page.getByLabel("Found it cheaper at")).toBeVisible();
  await page.getByRole("button", { name: "Add details manually" }).click();
  await expect(page.getByLabel("Title")).toHaveCount(0);
  await page.getByRole("button", { name: "Add details manually" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Disclosure probe");
  await expect(page.getByLabel("Notes")).toHaveValue("Kept while collapsed");
  // A page is not an overlay: Escape closes nothing, so leave via Cancel.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
});

test("3c: desktop add page has no sheet chrome and no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Add item" }).first().click();
  await expect(page).toHaveURL(`${BASE}/add`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Add to Sugarplum" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
});

test("3c2: mobile add mount focuses no field (no keyboard pop)", async ({ page }) => {
  // The viewport where the keyboard pop hurts (INV-B). A field focused on
  // mount is what raises the on-screen keyboard; an h1/body never does.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  await page.getByRole("button", { name: "Add item" }).first().click();
  await expect(page).toHaveURL(`${BASE}/add`);
  await expect(page.getByLabel("Link")).toBeVisible();
  await expect(page.getByLabel("Link")).not.toBeFocused();
  expect(
    await page.evaluate(() =>
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? ""),
    ),
    "no form field is focused after the add page mounts",
  ).toBe(false);
});

test("3d: failed enrichment remains recoverable through Retry fetch", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Recoverable item", url: "https://127.0.0.1:1/unreachable" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };
  await page.reload();
  const card = page.locator(`.item-card[data-item-id="${item.id}"]`);
  await expect(card).toHaveAttribute("data-fetch", "failed", { timeout: 20_000 });
  await expect(card.getByText("Details unavailable")).toBeVisible();
  await card.getByRole("button", { name: "More actions" }).click();
  const retryResponse = page.waitForResponse(
    (response) => response.url().endsWith(`/api/wishlist/items/${item.id}/refresh`) && response.request().method() === "POST",
  );
  await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: "Retry fetch" }).click();
  expect((await retryResponse).status()).toBe(202);
  await expect.poll(() => card.getAttribute("data-fetch") ?? "complete", { timeout: 5_000 }).toMatch(/^(pending|failed|complete)$/);
  await expect(card).toHaveCount(1);
  await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
});

test("4: editing an item persists after reload", async ({ page }) => {
  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "Manual mug" }),
  });
  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  // #62: edit is a page route, not a stacked sheet.
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}\/edit$/);
  await page.getByLabel("Title").fill("Manual mug v2");
  await page.getByRole("button", { name: "Save" }).click();
  // Save returns to the item view.
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
  await expect(page.locator(".detail-title")).toHaveText("Manual mug v2");
  // The item URL is addressable: a real reload renders it from the server.
  await page.reload();
  await expect(page.locator(".detail-title")).toHaveText("Manual mug v2");
  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page.getByRole("heading", { name: "Manual mug v2" })).toBeVisible();
});

test("4b: price history shows the lowest price and the delta since added", async ({ page }) => {
  // A manual item with a price, then a price drop (same API the form uses).
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "History probe", priceCents: "12.50", currency: "GBP" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };

  const patched = await page.request.patch(`${BASE}/api/wishlist/items/${item.id}`, {
    data: { priceCents: "10.00" },
  });
  expect(patched.status()).toBe(200);

  await page.reload();
  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "History probe" }),
  });
  await expect(card.locator(".price")).toHaveText("£10.00");
  await expect(card.locator(".price-meta")).toHaveText("Lowest £10.00");
  await expect(card.locator(".price-delta .delta-copy")).toHaveText("£2.50 since added");
  await expect(card.locator(".price-delta")).toHaveAttribute("data-direction", "down");
  await expect(card.getByRole("button", { name: "Re-check price" })).toHaveCount(0); // no URL
  await expect(card.locator(".price-meta")).not.toContainText("At add");
  await expect(card.getByRole("button", { name: "Prices seen elsewhere (unverified)" })).toHaveCount(0);
});

test("4c: row opens the item page; overflow does not", async ({ page }) => {
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
  const list = (await (await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)).json()) as Array<{ id: string; title: string; url: string | null }>;
  const probe = list.find((item) => item.title === "History probe");
  expect(probe).toBeTruthy();

  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "History probe" }),
  });
  const rowButton = card.getByRole("button", { name: "History probe", exact: true });
  await rowButton.focus();
  await page.keyboard.press("Enter");
  // #62: the row opener navigates to the item page — it opens no dialog.
  await expect(page).toHaveURL(`${BASE}/items/${probe!.id}`);
  const itemPage = page.locator(".item-page");
  await expect(itemPage.locator(".detail-title")).toHaveText("History probe");
  await expect(itemPage.getByText("Lowest £10.00")).toBeVisible();
  await expect(itemPage.getByText("£2.50 since added")).toBeVisible();
  const history = itemPage.locator(".detail-history-card");
  await expect(history).toBeVisible();
  await expect(history.getByRole("heading", { name: "Price history" })).toBeVisible();
  await expect(history.locator(".price-graph")).toBeVisible();
  await expect(history.getByRole("group", { name: "Trend window" })).toBeVisible();
  await expect(history.getByRole("button", { name: "30d", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(history.getByRole("button", { name: "90d", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(history.getByRole("button", { name: "All", exact: true })).toHaveCount(0);
  await expect(history.locator(".price-graph")).toHaveAttribute("aria-label", /now £10\.00/);
  await expect(history.locator(".price-graph")).toHaveAttribute("aria-label", /lowest £10\.00/);
  await expect(history.locator(".price-graph")).toContainText("£10.00");
  await expect(history.locator(".price-graph-caption")).toHaveText("Not enough history yet");
  await history.getByRole("button", { name: "90d", exact: true }).click();
  await expect(history.getByRole("button", { name: "90d", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sugarplum.trend-window"))).toBe("90d");
  await expect(itemPage.getByRole("link", { name: "Open product" })).toHaveCount(0);
  await expect(itemPage.getByRole("button", { name: "Edit item" })).toBeVisible();

  // A page is left by navigation, not by Escape; there is no focus-return
  // contract to the row opener any more (it navigated away).
  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page).toHaveURL(`${BASE}/`);

  // The row's overflow menu does not navigate anywhere.
  await card.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu", { name: "More actions" })).toBeVisible();
  await expect(page).toHaveURL(`${BASE}/`);
  await page.keyboard.press("Escape");

  for (const selector of [
    ".item-link-row",
    ".tags",
    ".item-notes",
    ".price-trend",
    ".hint-block",
    ".window-seg",
    ".price-graph",
    ".sparkline",
    ".item-cheaper",
    ".item-image-source",
  ]) {
    await expect(card.locator(selector)).toHaveCount(0);
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(card.locator(".drag-handle:visible")).toHaveCount(0);
});

test("4d: item page actions, edit route round-trip and delete", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: {
      title: "Detail probe",
      url: "https://example.com/detail-probe",
      priceCents: "24.99",
      currency: "GBP",
      notes: "A note for the detail surface.",
      tags: ["Collection", "Gifts"],
    },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };
  await page.reload();

  const card = page.locator(`.item-card[data-item-id="${item.id}"]`);
  await card.getByRole("button", { name: "Detail probe", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
  const itemPage = page.locator(".item-page");
  await expect(itemPage.locator(".detail-site")).toHaveText("example.com");
  await expect(itemPage.locator(".detail-price")).toHaveText("£24.99");
  await expect(itemPage.getByText("Lowest £24.99")).toBeVisible();
  const productLink = itemPage.getByRole("link", { name: "Open product" });
  await expect(productLink).toHaveAttribute("href", "https://example.com/detail-probe");
  await expect(productLink).toHaveAttribute("target", "_blank");

  await itemPage.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  // Re-check/retry is URL- and fetch-state-gated; the background fetch may
  // resolve before this menu opens, so either valid state is accepted.
  const refreshEntry = menu.getByRole("menuitem", { name: /Re-check price|Retry fetch/ });
  expect(await refreshEntry.count()).toBeLessThanOrEqual(1);
  await expect(menu.getByRole("menuitem", { name: "Copy product link" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Reset purchased mark" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  // Edit is not a menu entry on the item page: it is the action button below.
  await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Edit is the /items/:id/edit page; Save returns to the item view.
  await itemPage.getByRole("button", { name: "Edit item" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}/edit`);
  await page.getByLabel("Title").fill("Detail probe updated");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
  await expect(page.locator(".detail-title")).toHaveText("Detail probe updated");

  // Cancel returns to the item view without saving (the route pairing).
  await page.getByRole("button", { name: "Edit item" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}/edit`);
  await page.getByLabel("Title").fill("Should not persist");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
  await expect(page.locator(".detail-title")).toHaveText("Detail probe updated");

  const added = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date());
  await expect(page.locator(".item-page")).toContainText(`Added ${added}`);

  // Delete confirms, then lands on the feed with the card gone.
  await page.locator(".item-page").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.locator(`.item-card[data-item-id="${item.id}"]`)).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

test("4e: item page keeps one layout and no overflow at any width", async ({ page }) => {
  const card = page.locator(".item-card", { has: page.getByRole("heading", { name: "History probe" }) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await card.getByRole("button", { name: "History probe", exact: true }).click();
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
  await expect(page.locator(".item-page .detail-title")).toBeVisible();
  // One layout at every width: no drawer variant, no sheet handle, no dialog.
  await expect(page.locator(".detail-drawer")).toHaveCount(0);
  await expect(page.locator(".detail-handle")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  for (const width of [360, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `item page overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `item page escapes at ${width}px`).toEqual([]);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
});

test("4e2: item page deep link, unknown id and malformed id", async ({ page }) => {
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
  const list = (await (await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)).json()) as Array<{ id: string; title: string }>;
  const probe = list.find((item) => item.title === "History probe");
  expect(probe).toBeTruthy();

  // A cold deep link is a fresh document load: the server static map must
  // serve the SPA shell for /items/*, not 404 against a nonexistent file.
  await page.goto(`${BASE}/items/${probe!.id}`);
  await expect(page.locator(".detail-title")).toHaveText("History probe");
  await expect(page.locator(".item-page .price-graph")).toBeVisible();

  // A well-formed id that is not in the owner's list renders the not-found
  // state (never a blank page or a dead end).
  await page.goto(`${BASE}/items/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { name: "Item not found." })).toBeVisible();

  // A malformed id is not a route: it falls through to the feed.
  await page.goto(`${BASE}/items/not-a-uuid`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
});

test("4i: edit page round-trip and keyboard stillness", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Edit page probe", priceCents: "9.99", currency: "GBP" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };

  await page.setViewportSize({ width: 390, height: 844 });
  // A deep link straight to the edit route (no feed in history).
  await page.goto(`${BASE}/items/${item.id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit" })).toBeVisible();
  // INV-B on the edit surface too: nothing focused, so no keyboard pops.
  await expect(page.getByLabel("Title")).not.toBeFocused();
  expect(
    await page.evaluate(() =>
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? ""),
    ),
    "no form field is focused after the edit page mounts",
  ).toBe(false);

  await page.getByLabel("Title").fill("Edited via page");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
  await expect(page.locator(".detail-title")).toHaveText("Edited via page");

  // Cancel path: back to the item view, value discarded.
  await page.getByRole("button", { name: "Edit item" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}/edit`);
  await page.getByLabel("Title").fill("Discarded");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
  await expect(page.locator(".detail-title")).toHaveText("Edited via page");

  await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
  await page.goto(`${BASE}/`);
});

test("4f: item page does not trap focus and keeps the menu popover contract", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const card = page.locator(".item-card", { has: page.getByRole("heading", { name: "History probe" }) });
  const rowButton = card.getByRole("button", { name: "History probe", exact: true });
  await rowButton.click();
  const itemPage = page.locator(".item-page");
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();

  // A page traps nothing: tabbing walks out of the item body into the shell
  // (topbar/footer) instead of cycling inside a modal (the retired sheet's
  // Tab-wrap contract).
  await expect(page.locator(".detail-title")).toBeFocused(); // usePageFocus heading
  const focusables = await itemPage
    .locator('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    .count();
  expect(focusables).toBeGreaterThan(0);
  const visited: string[] = [];
  let escaped = false;
  for (let i = 0; i < focusables + 4 && !escaped; i++) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName}.${el.className}` : "none";
    });
    visited.push(active);
    escaped = !(await itemPage.evaluate((el) => el.contains(document.activeElement)));
  }
  expect(escaped, `Tab left the item page (no focus trap); path=${visited.join(" → ")}`).toBe(true);

  // The overflow menu keeps its own small-overlay keyboard contract.
  await itemPage.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu.locator(".overflow-separator")).toHaveCount(2);
  await expect(menu.locator(".menu-item-danger")).toHaveCount(1);
  const rows = menu.getByRole("menuitem");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(rows.first()).toBeFocused();

  // The menu portals to document.body, so the shared OverflowMenu primitive
  // owns the mobile Tab wrap: focus never leaves the overflow sheet.
  const menuSheet = page.getByRole("dialog", { name: "More actions" });
  await expect.poll(() => menuSheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // Escape closes the menu, not the page.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(menuSheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/items\//);
});

test("4h: prices elsewhere stays inside detail and preserves honesty states", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Hints probe", url: "https://example.com/hints-probe", priceCents: "18.00", currency: "GBP" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };
  await page.reload();

  const card = page.locator(`.item-card[data-item-id="${item.id}"]`);
  await card.getByRole("button", { name: "Hints probe", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
  const itemPage = page.locator(".item-page");
  const toggle = itemPage.getByRole("button", { name: "Check prices elsewhere" });
  await toggle.click();
  const candidates = itemPage.locator(".hint-candidates");
  await expect(candidates).toBeVisible();
  await expect(candidates).toContainText("Could not check prices.");
  await expect(itemPage.locator(".hints-rows")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(candidates).toHaveCount(0);
  await toggle.click();
  await expect(candidates).toContainText("Could not check prices.");

  try {
    const disabled = await page.request.put(`${BASE}/api/auth/me/settings`, { data: { hintsEnabled: false } });
    expect(disabled.status()).toBe(200);
    await toggle.click();
    await toggle.click();
    await expect(candidates).toContainText("Price hints are off in settings.");
  } finally {
    const restored = await page.request.put(`${BASE}/api/auth/me/settings`, { data: { hintsEnabled: true } });
    expect(restored.status()).toBe(200);
  }
  // Leave the board on the feed (the sheet's Escape-then-reload closer is gone;
  // a page is left by navigating).
  await page.goto(`${BASE}/`);
});

test("5: manual order persists and the order API round-trips", async ({ page }) => {
  for (const title of ["Reorder one", "Reorder two", "Reorder three"]) {
    const res = await page.request.post(`${BASE}/api/wishlist/items`, { data: { title } });
    expect(res.status()).toBe(201);
  }
  await page.reload();
  const titles = page.locator(".item-card .item-title");
  await expect(titles.last()).toHaveText("Reorder three");

  const ids = (await page.evaluate(() => Array.from(
    document.querySelectorAll<HTMLElement>(".item-card"),
  ).map((el) => el.dataset.itemId))) as string[];
  expect(ids.length).toBeGreaterThanOrEqual(3);
  const rotated = [ids[ids.length - 1], ...ids.slice(0, -1)];
  const put = await page.request.put(`${BASE}/api/wishlist/order`, {
    data: { itemIds: rotated },
  });
  expect(put.status()).toBe(200);

  await page.reload();
  await expect(page.locator(".item-card .item-title").first()).toHaveText("Reorder three");
  await expect(page.locator(".drag-handle:visible")).toHaveCount(0);
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

  await page.getByRole("button", { name: "Birthday", exact: true }).click();
  await expect(page.locator(".item-card")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Birthday candle" })).toBeVisible();

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".item-card")).toHaveCount(before.length);
  expect(await titles.allTextContents()).toEqual(before);

  // A8: filters and reorder mode are mutually exclusive. Entering the mode
  // clears the filter before any handle can commit a partial id list.
  await page.getByRole("button", { name: "Birthday", exact: true }).click();
  await expect(page.locator(".drag-handle")).toHaveCount(0);
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await expect(page.locator(".item-card.is-reordering").first()).toBeVisible();
  await expect(page.locator(".item-list .drag-handle:visible").first()).toBeVisible();
  await expect(page.locator(".item-card")).toHaveCount(before.length);
  await page.getByRole("button", { name: "Done", exact: true }).click();
});

test("5b: reorder mode supports keyboard movement and persists", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, { data: { title: "Reorder four" } });
  expect(created.status()).toBe(201);
  await page.reload();

  const toggle = page.getByRole("button", { name: "Reorder", exact: true });
  await expect(toggle).toBeVisible();
  await expect(page.locator(".drag-handle:visible")).toHaveCount(0);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".item-card.is-reordering").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(page.locator(".item-list .drag-handle").first()).toBeFocused();
  // A10: every handle is named after its own row (not a shared "Move item").
  const firstTitle = (await page.locator(".item-card .item-title").first().innerText()).trim();
  await expect(page.locator(".item-list .drag-handle").first())
    .toHaveAccessibleName(`Move "${firstTitle}"`);
  await expect(page.locator(".item-card .icon-btn")).toHaveCount(0);
  await expect(page.locator(".filter-row")).toHaveCount(0);

  const ids = () => page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".item-card")).map((el) => el.dataset.itemId),
  );
  const before = await ids();
  expect(before.length).toBeGreaterThanOrEqual(4);
  const orderResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/wishlist/order") && response.request().method() === "PUT",
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect((await orderResponse).status()).toBe(200);
  await expect.poll(async () => (await ids())[0]).toBe(before[1]);
  const moved = await ids();
  expect(moved[1]).toBe(before[0]);

  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".drag-handle:visible")).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.reload();
  await expect.poll(async () => (await ids())[0]).toBe(before[1]);
  await expect.poll(async () => (await ids())[1]).toBe(before[0]);
});

test("5c: pointer drag in reorder mode persists after reload", async ({ page }) => {
  await page.reload();
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  const titles = page.locator(".item-card .item-title");
  const before = await titles.allTextContents();
  await page.locator(".item-list .drag-handle").last().dragTo(page.locator(".item-card").first());
  await expect(titles.first()).toHaveText(before[before.length - 1]);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator(".item-card .item-title").first()).toHaveText(before[before.length - 1]);
  await expect(page.locator(".drag-handle:visible")).toHaveCount(0);
});

test("5d: desktop hover reveals a reorder grip without entering mode", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  const firstCard = page.locator(".item-card").first();
  const lastCard = page.locator(".item-card").last();
  const grip = lastCard.locator(".drag-handle--peek");
  await expect(grip).toBeHidden();
  await expect(page.locator(".item-card.is-reordering")).toHaveCount(0);
  await lastCard.hover();
  await expect(grip).toBeVisible();
  // The desktop peek grip carries the same per-item label (A10).
  const lastTitle = (await lastCard.locator(".item-title").innerText()).trim();
  await expect(grip).toHaveAccessibleName(`Move "${lastTitle}"`);

  const titles = page.locator(".item-card .item-title");
  const before = await titles.allTextContents();
  await grip.dragTo(firstCard);
  await expect(titles.first()).toHaveText(before[before.length - 1]);
  await expect(page.locator(".item-card.is-reordering")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reorder", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".item-card .item-title").first()).toHaveText(before[before.length - 1]);
});

test("6b: heading switcher opens a sheet and switches lists", async ({ page, browser }) => {
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username: "switcher-probe", password: "probe-pass", displayName: "Probe" },
  });
  expect(created.status()).toBe(201);

  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const probe = await context.newPage();
  try {
    await login(probe, "switcher-probe", "probe-pass");
    await expect(probe.getByRole("heading", { name: "Probe's wishlist" })).toBeVisible();
    await probe.getByRole("button", { name: "Probe's wishlist" }).click();
    const sheet = probe.getByRole("dialog", { name: "Switch wishlist" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: /Admin/ })).toBeVisible();
    await sheet.getByRole("button", { name: /Admin/ }).click();
    await expect(probe.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();

    await probe.getByRole("button", { name: "Admin's wishlist" }).click();
    await probe
      .getByRole("dialog", { name: "Switch wishlist" })
      .getByRole("button", { name: /Probe/ })
      .click();
    await expect(probe.getByRole("heading", { name: "Probe's wishlist" })).toBeVisible();
  } finally {
    await context.close();
  }
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
    await bob.getByRole("button", { name: /wishlist/ }).click();
    await bob.getByRole("menuitemradio", { name: /Admin/ }).click();
    const card = bob.locator(".item-card", {
      has: bob.getByRole("heading", { name: "Claimable mug" }),
    });
    await card.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(card.getByText("Claimed by you")).toBeVisible();
    await card.getByRole("button", { name: "Unclaim", exact: true }).click();
    await expect(card.getByText("Claimed by you")).not.toBeVisible();

    // A9: the public row stays compact — claim state is a row affordance and
    // carries no owner-only tooling or price intelligence.
    await card.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(card.getByText("Claimed by you")).toBeVisible();
    await expect(card.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await expect(card.locator(".price-meta")).toHaveCount(0);
    await expect(card.locator(".price-delta")).toHaveCount(0);

    // A9: the public row title opens the read-only guest detail surface.
    await card.getByRole("button", { name: "Claimable mug" }).click();
    const guestSheet = bob.getByRole("dialog", { name: "Claimable mug" });
    await expect(guestSheet).toBeVisible();
    await expect(guestSheet.getByRole("button", { name: "Edit item" })).toHaveCount(0);
    await expect(guestSheet.locator(".price-graph")).toHaveCount(0);
    await expect(guestSheet.getByRole("button", { name: "Re-check price" })).toHaveCount(0);
    await expect(guestSheet.getByText("Reset purchased mark")).toHaveCount(0);
    await expect(guestSheet.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await bob.keyboard.press("Escape");
    await expect(guestSheet).toHaveCount(0);

    // Leave the item unclaimed, as the original test did.
    await card.getByRole("button", { name: "Unclaim", exact: true }).click();
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

test("8: share-target GET prefills the add page and creates the item", async ({ page }) => {
  await page.goto(`${BASE}/add?url=https://example.com/x&title=Share test`);
  await expect(page).toHaveURL(/\/add\?url=/);
  await expect(page.getByLabel("Link")).toHaveValue("https://example.com/x");
  await expect(page.getByRole("button", { name: "Add details manually" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Title")).toHaveValue("Share test");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole("heading", { name: "Share test" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Share test" })).toBeVisible();
});

test("9: no horizontal overflow at 360-1280px across surfaces", async ({ page, browser }) => {
  // Seed one item so the populated feed is exercised in every viewport.
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Overflow probe" },
  });
  expect(seeded.status()).toBe(201);

  for (const width of [360, 390, 430, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload();
    if (width < 1024) {
      const historyCard = page.locator(".item-card", { has: page.getByRole("heading", { name: "History probe" }) });
      await historyCard.getByRole("button", { name: "History probe", exact: true }).click();
      await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
      await expect(page.locator(".item-page .price-graph")).toBeVisible();
    }
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `document overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `true escapes at ${width}px`).toEqual([]);
    if (width < 1024) {
      // #62: the item view is a page — it is left by navigating back, not by
      // Escape (the sheet closer is gone).
      await page.getByRole("link", { name: "Back to list" }).click();
      await expect(page).toHaveURL(`${BASE}/`);
    }
    if (width === 390) {
      await page.getByRole("button", { name: "Reorder", exact: true }).click();
      await expect(page.locator(".item-card.is-reordering").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
      await page.getByRole("button", { name: "Done", exact: true }).click();
    }
  }

  // A9 guest surfaces: the other-user feed and the anonymous share view must
  // clear the same bar, including with their guest detail surface open.
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username: "overflow-guest", password: "guest-pass", displayName: "Guest" },
  });
  expect(created.status()).toBe(201);
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guest = await guestContext.newPage();
  try {
    await login(guest, "overflow-guest", "guest-pass");
    for (const title of ["Guest row one", "Guest row two"]) {
      const row = await guest.request.post(`${BASE}/api/wishlist/items`, {
        data: { title, notes: "Guest note", tags: ["Guest tag"] },
      });
      expect(row.status()).toBe(201);
    }
    await guest.reload();
    await guest.getByRole("button", { name: /wishlist/ }).click();
    await guest.getByRole("menuitemradio", { name: /Admin/ }).click();
    await expect(guest.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();

    for (const width of [360, 390, 430, 768, 1024, 1280]) {
      await guest.setViewportSize({ width, height: 800 });
      const probe = await horizontalEscapes(guest);
      expect(probe.docOverflow, `other-user overflow at ${width}px`).toBe(false);
      expect(probe.offenders, `other-user escapes at ${width}px`).toEqual([]);
    }

    // The guest detail sheet is the new surface: probe it at both ends.
    for (const width of [360, 1280]) {
      await guest.setViewportSize({ width, height: 800 });
      await guest
        .locator(".item-card", { has: guest.getByRole("heading", { name: "Claimable mug" }) })
        .getByRole("button", { name: "Claimable mug" })
        .click();
      const sheet = guest.getByRole("dialog", { name: "Claimable mug" });
      await expect(sheet).toBeVisible();
      await settleEntryAnimation(sheet);
      const probe = await horizontalEscapes(guest);
      expect(probe.docOverflow, `other-user sheet overflow at ${width}px`).toBe(false);
      expect(probe.offenders, `other-user sheet escapes at ${width}px`).toEqual([]);
      await guest.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    }
  } finally {
    await guestContext.close();
  }

  const shared = await page.request.post(`${BASE}/api/share`);
  expect(shared.status()).toBe(201);
  const { token } = (await shared.json()) as { token: string };
  await page.goto(`${BASE}/share/${token}`);
  await expect(page.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();

  for (const width of [360, 390, 430, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `share view overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `share view escapes at ${width}px`).toEqual([]);
  }

  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page
      .locator(".item-card", { has: page.getByRole("heading", { name: "Claimable mug" }) })
      .getByRole("button", { name: "Claimable mug" })
      .click();
    const sheet = page.getByRole("dialog", { name: "Claimable mug" });
    await expect(sheet).toBeVisible();
    await settleEntryAnimation(sheet);
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `share sheet overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `share sheet escapes at ${width}px`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }

  // A10: Settings and Login are their own surfaces and clear the same bar.
  // Settings is the admin's page here, so the user table (the widest content)
  // is exercised, including its own scroll containment at 360px.
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${BASE}/settings`);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.locator(".admin-table")).toBeVisible();
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `settings overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `settings escapes at ${width}px`).toEqual([]);
  }

  // The login card is the one surface with no session: probe it anonymously.
  const anonymous = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const loginPage = await anonymous.newPage();
  try {
    for (const width of [360, 390, 430, 768, 1280]) {
      await loginPage.setViewportSize({ width, height: 800 });
      await loginPage.goto(`${BASE}/login`);
      await expect(loginPage.locator(".auth-card")).toBeVisible();
      const probe = await horizontalEscapes(loginPage);
      expect(probe.docOverflow, `login overflow at ${width}px`).toBe(false);
      expect(probe.offenders, `login escapes at ${width}px`).toEqual([]);
    }
  } finally {
    await anonymous.close();
  }

  // Hand the board back clean: test 15 expects no active link (its share
  // dialog must offer "Create link", not "New link").
  const revoked = await page.request.delete(`${BASE}/api/share`);
  expect(revoked.status()).toBe(204);
});

test("10: dark mode flips the surface tokens", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${BASE}/`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(18, 16, 23)"); // --bg dark: #121017
  expect(bg).not.toBe("rgb(250, 250, 250)"); // --bg light: #fafafa

  // A10 retuned the dark muted text (--text-3) and the primary fill
  // (--plum-600); both are locked here through the rendered ratio.
  const muted = page.locator(".app-footer a");
  await expect(muted).toBeVisible();
  expect(await contrast(muted), "dark muted text").toBeGreaterThanOrEqual(4.5);

  await page.getByRole("button", { name: "Add item" }).first().click();
  const submit = page.getByRole("button", { name: "Add item" });
  await expect(submit).toBeVisible();
  expect(await contrast(submit), "dark primary button").toBeGreaterThanOrEqual(4.5);
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

test("12: AA contrast sweep holds in both schemes", async ({ page, browser }) => {
  const card = page.locator(".item-card", { has: page.getByRole("heading", { name: "History probe" }) });
  const rowButton = card.getByRole("button", { name: "History probe", exact: true });

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto(`${BASE}/`);
    await expect(rowButton).toBeVisible();

    // Muted text (--text-3) on the page background.
    const muted = page.locator(".app-footer a");
    await expect(muted).toBeVisible();
    expect(await contrast(muted), `${colorScheme}: muted text`).toBeGreaterThanOrEqual(4.5);

    // Primary CTA: white on the plum fill in either scheme.
    await page.getByRole("button", { name: "Add item" }).first().click();
    const submit = page.getByRole("button", { name: "Add item" });
    await expect(submit).toBeVisible();
    expect(await contrast(submit), `${colorScheme}: primary button`).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    // Detail surface: muted footer metadata, and the segmented control's
    // inactive label (--text-3 on the --surface-2 track).
    await rowButton.click();
    await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
    const detail = page.locator(".item-page");
    await expect(detail.locator(".detail-history-card")).toBeVisible();
    expect(await contrast(detail.locator(".detail-footer")), `${colorScheme}: detail footer`)
      .toBeGreaterThanOrEqual(4.5);
    const inactiveWindow = detail.locator(".window-seg button:not(.active)").first();
    await expect(inactiveWindow).toBeVisible();
    expect(await contrast(inactiveWindow), `${colorScheme}: inactive window label`)
      .toBeGreaterThanOrEqual(4.5);
    await page.getByRole("link", { name: "Back to list" }).click();
    await expect(page).toHaveURL(`${BASE}/`);
  }

  // The claim control only exists on another user's list, where it rides
  // --share-accent instead of --plum-600: sample it in dark.
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username: "contrast-guest", password: "contrast-pass", displayName: "Contrast" },
  });
  expect(created.status()).toBe(201);
  const guestContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  const guest = await guestContext.newPage();
  try {
    await login(guest, "contrast-guest", "contrast-pass");
    await guest.getByRole("button", { name: /wishlist/ }).click();
    await guest.getByRole("menuitemradio", { name: /Admin/ }).click();
    await expect(guest.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
    const claim = guest.locator(".claim-btn").first();
    await expect(claim).toBeVisible();
    expect(await contrast(claim), "dark claim control").toBeGreaterThanOrEqual(4.5);
  } finally {
    await guestContext.close();
  }
});

test("13: offline reload still shows a previously loaded list", async ({ page, context }) => {
  // Seed an item the SW will cache on the next reload, then load the app
  // once online so boot() writes the last-known me to localStorage.
  const added = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Offline candle" },
  });
  expect(added.status()).toBe(201);
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: "Offline candle" })).toBeVisible();

  // Now drop the network: a reload must still render the cached card.
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Offline candle" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("14: share-target GET prefills the add page through the login hop", async ({ page, context }) => {
  // Log out by dropping the session cookie — the shared context carries
  // it forward from beforeEach, so a fresh cookie jar starts the user off
  // the same way an Android share-target recipient lands.
  await context.clearCookies();
  await page.goto(`${BASE}/add?url=https%3A%2F%2Fexample.com%2Fshared&title=Shared%20mug`);

  // The 401 hop must carry the share URL forward (encoded), not silently
  // drop the prefill onto /.
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  // After sign-in we land back on /add (the page, not a sheet) with the
  // title + link prefilled. Submit and confirm the card renders.
  await expect(page).toHaveURL(/\/add\?/);
  await expect(page.getByLabel("Title")).toHaveValue("Shared mug");
  await expect(page.getByLabel("Link")).toHaveValue("https://example.com/shared");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("heading", { name: "Shared mug" })).toBeVisible();

  // Open-redirect guard: a protocol-relative `next` must fall back to /.
  await page.request.post(`${BASE}/api/auth/logout`);
  await context.clearCookies();
  await page.goto(`${BASE}/login?next=${encodeURIComponent("//evil.example/x")}`);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Pin the ORIGIN, not just a trailing slash: the off-site navigation
  // to a non-resolving host ends on chrome-error://chromewebdata/, whose
  // URL ends in "/", so /\/$/ passes vacuously on the unguarded code.
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();

  // Open-redirect guard, bypass class: WHATWG URL parsing treats
  // backslash / tab / LF / CR as a slash, so /\<host>, /\t<host>, /\n<host>
  // all navigate off-site as protocol-relative URLs unless the guard
  // rejects them. Pin the class instead of only the literal `//` shape.
  await page.request.post(`${BASE}/api/auth/logout`);
  await context.clearCookies();
  // `/\evil.example/x` — URL-encoded as %2F%5Cevil.example%2Fx.
  await page.goto(`${BASE}/login?next=%2F%5Cevil.example%2Fx`);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Pin the ORIGIN, not just a trailing slash: the off-site navigation
  // to a non-resolving host ends on chrome-error://chromewebdata/, whose
  // URL ends in "/", so /\/$/ passes vacuously on the unguarded code.
  await expect(page).toHaveURL(`${BASE}/`);
});

test("15: share link — owner creates, anonymous marks purchased, owner sees nothing, revoke kills it", async ({
  page,
  browser,
}) => {
  // Seed the item the guest will mark (admin session via page.request), then
  // reload so the owner's list state has it (the share action needs a list).
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Gift for the admin", notes: "Note for the guest" },
  });
  expect(seeded.status()).toBe(201);
  await page.reload();

  // Owner (admin, logged in by beforeEach) mints a link for their own list.
  await page.getByRole("button", { name: "Share my list" }).click();
  const desktopShare = page.getByRole("dialog", { name: "Share my list" });
  await expect(desktopShare).toBeVisible();
  const triggerBox = await page.getByRole("button", { name: "Share my list" }).boundingBox();
  const popoverBox = await desktopShare.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.x + popoverBox!.width).toBeCloseTo(triggerBox!.x + triggerBox!.width, 0);
  expect(popoverBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
  expect(popoverBox!.width).toBeLessThanOrEqual(360);
  await desktopShare.getByRole("button", { name: "Create link" }).click();
  const linkInput = desktopShare.locator(".share-link-row input");
  await expect(linkInput).toBeVisible();
  const shareUrl = await linkInput.inputValue();
  expect(shareUrl).toMatch(/\/share\/[0-9a-f]{64}$/);

  // Anonymous friend's browser: a fresh context, zero cookies.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  try {
    await anonPage.goto(shareUrl);
    await expect(anonPage.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
    await expect(anonPage.getByText("Shared list — no account needed")).toBeVisible();

    // Mobile-first: the anonymous page must not overflow at 375px.
    await anonPage.setViewportSize({ width: 375, height: 800 });
    await anonPage.reload();
    await expect(anonPage.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
    expect(
      await anonPage.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);

    const card = anonPage.locator(".item-card", {
      has: anonPage.getByRole("heading", { name: "Gift for the admin" }),
    });

    // A9: share rows carry the compact feed grammar — notes, tags and the raw
    // link move into the guest detail sheet, never inline.
    await expect(card.locator(".item-notes")).toHaveCount(0);
    await expect(card.locator(".tags")).toHaveCount(0);
    await expect(card.locator(".item-link-row")).toHaveCount(0);
    await expect(card.locator(".price-meta")).toHaveCount(0);
    await expect(card.locator(".price-delta")).toHaveCount(0);

    // A9: the row title opens the read-only guest sheet, which now carries
    // the details. No owner surface may appear inside it.
    await card.getByRole("button", { name: "Gift for the admin" }).click();
    const guestSheet = anonPage.getByRole("dialog", { name: "Gift for the admin" });
    await expect(guestSheet).toBeVisible();
    await expect(guestSheet.getByText("Note for the guest")).toBeVisible();
    await expect(guestSheet.getByRole("button", { name: "Edit item" })).toHaveCount(0);
    await expect(guestSheet.locator(".price-graph")).toHaveCount(0);
    await expect(guestSheet.getByRole("button", { name: "Re-check price" })).toHaveCount(0);
    await expect(guestSheet.getByText("Reset purchased mark")).toHaveCount(0);
    await expect(guestSheet.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await anonPage.keyboard.press("Escape");
    await expect(guestSheet).toHaveCount(0);

    await card.getByRole("button", { name: "More actions" }).click();
    await anonPage.getByRole("menuitem", { name: "Mark as purchased" }).click();
    // Confirm dialog — same label as the row button, so scope to the dialog.
    const dialog = anonPage.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("This tells other viewers the item is already bought."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Mark as purchased" }).click();
    await expect(card.locator(".share-purchased-badge")).toHaveText("Purchased");

    // A9: the purchased state is the struck title + dimmed meta, with the
    // badge at full emphasis (no whole-card opacity).
    await expect(card).toHaveClass(/is-purchased/);
    await expect(card.locator(".item-title")).toHaveCSS("text-decoration-line", "line-through");
    await expect(card.locator(".share-purchased-badge")).toHaveCSS("opacity", "1");

    // A second anonymous viewer sees the mark (double-gift prevention).
    const anon2 = await browser.newContext();
    try {
      const anon2Page = await anon2.newPage();
      await anon2Page.goto(shareUrl);
      const card2 = anon2Page.locator(".item-card", {
        has: anon2Page.getByRole("heading", { name: "Gift for the admin" }),
      });
      await expect(card2.locator(".share-purchased-badge")).toBeVisible();
    } finally {
      await anon2.close();
    }

    // THE INVARIANT, in the browser: the owner's own list carries no signal.
    await page.reload();
    const ownerCard = page.locator(".item-card", {
      has: page.getByRole("heading", { name: "Gift for the admin" }),
    });
    await expect(ownerCard).toBeVisible();
    await expect(page.locator(".share-purchased-badge")).toHaveCount(0);

    // …and the owner's own copy of the share view is projected server-side.
    await page.goto(shareUrl);
    await expect(
      page.getByText("You are viewing your own shared list. Purchased marks are hidden from you."),
    ).toBeVisible();
    await expect(page.locator(".share-purchased-badge")).toHaveCount(0);
    await expect(page.locator(".item-card.is-purchased")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark as purchased" })).toHaveCount(0);

    // Revocation: back to the app, reopen the sheet at 375px (mobile-first:
    // the link row must not overflow).
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: "Share my list" }).click();
    const mobileShare = page.getByRole("dialog", { name: "Share my list" });
    await expect(mobileShare).toHaveClass(/sheet--share/);
    await expect(mobileShare.locator(".detail-handle")).toBeVisible();
    await expect(mobileShare.locator(".share-link-row input")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await mobileShare.getByRole("button", { name: "Revoke link" }).click();
    await expect(page.getByText("Anyone with the link will no longer be able to view your list.")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke link" }).click();
    await expect(page.locator(".share-link-row")).toHaveCount(0);

    // The copied link is dead: the anonymous reload shows the invalid state.
    await anonPage.reload();
    await expect(anonPage.getByText("This link is not valid or has been revoked.")).toBeVisible();
  } finally {
    await anon.close();
  }
});

test("15b: desktop share popover closes outside, returns focus, and stays in bounds", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const trigger = page.getByRole("button", { name: "Share my list" });
  await trigger.click();
  const popover = page.getByRole("dialog", { name: "Share my list" });
  await expect(popover).toBeVisible();

  await page.mouse.click(24, 300);
  await expect(popover).toHaveCount(0);

  await trigger.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 768, height: 800 });
  await trigger.click();
  await expect(popover).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
});

test("15c: desktop share confirm stays stacked and regenerates the token", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const created = await page.request.post(`${BASE}/api/share`);
  expect(created.status()).toBe(201);
  await page.reload();

  await page.getByRole("button", { name: "Share my list" }).click();
  const popover = page.getByRole("dialog", { name: "Share my list" });
  const linkInput = popover.locator(".share-link-row input");
  await expect(linkInput).toBeVisible();
  const oldUrl = await linkInput.inputValue();

  await popover.getByRole("button", { name: "New link" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(popover).toBeVisible();
  await expect(linkInput).toHaveValue(oldUrl);

  await popover.getByRole("button", { name: "New link" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "New link" }).click();
  await expect.poll(() => linkInput.inputValue()).not.toBe(oldUrl);
  expect(await linkInput.inputValue()).toMatch(/\/share\/[0-9a-f]{64}$/);

  await popover.getByRole("button", { name: "Revoke link" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke link" }).click();
  await expect(popover.locator(".share-link-row")).toHaveCount(0);
});

test("15d: mobile share sheet traps focus and returns it to the trigger", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const created = await page.request.post(`${BASE}/api/share`);
  expect(created.status()).toBe(201);
  await page.reload();

  const trigger = page.getByRole("button", { name: "Share my list" });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Share my list" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/sheet--share/);
  await expect(sheet.locator(".detail-handle")).toBeVisible();
  await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  const focusableSelector = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusableCount = await sheet.locator(focusableSelector).count();
  expect(focusableCount).toBeGreaterThan(0);
  for (let i = 0; i < focusableCount + 2; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await page.getByRole("dialog", { name: "Share my list" }).getByRole("button", { name: "Revoke link" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke link" }).click();
});

test("15e: anonymous guest sheet shows details and confirmed purchase state", async ({
  page,
  browser,
}) => {
  // Seed + mint a link exactly like test 15 (page.request carries the session).
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: {
      title: "Guest detail probe",
      notes: "Size medium",
      tags: ["Kitchen"],
      priceCents: "19.99",
      currency: "GBP",
    },
  });
  expect(seeded.status()).toBe(201);
  const created = await page.request.post(`${BASE}/api/share`);
  expect(created.status()).toBe(201);
  const token = ((await created.json()) as { token: string }).token;

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  try {
    await anonPage.goto(`${BASE}/share/${token}`);
    const card = anonPage.locator(".item-card", {
      has: anonPage.getByRole("heading", { name: "Guest detail probe" }),
    });
    await card.getByRole("button", { name: "Guest detail probe" }).click();
    const sheet = anonPage.getByRole("dialog", { name: "Guest detail probe" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Size medium")).toBeVisible();
    await expect(sheet.getByText("Kitchen")).toBeVisible();
    await expect(sheet.getByText("£19.99")).toBeVisible();
    await expect(sheet.getByRole("link", { name: /Open product/ })).toHaveCount(0); // no url seeded
    await expect(sheet.getByRole("button", { name: "Edit item" })).toHaveCount(0);
    await expect(sheet.locator(".price-graph")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);

    // Marking stays a row interaction; the sheet then reports the confirmed
    // state without offering a second marking affordance.
    await card.getByRole("button", { name: "More actions" }).click();
    await anonPage.getByRole("menuitem", { name: "Mark as purchased" }).click();
    await anonPage.getByRole("alertdialog").getByRole("button", { name: "Mark as purchased" }).click();
    await expect(card.locator(".share-purchased-badge")).toHaveText("Purchased");

    await card.getByRole("button", { name: "Guest detail probe" }).click();
    const purchasedSheet = anonPage.getByRole("dialog", { name: "Guest detail probe" });
    await expect(purchasedSheet.locator(".share-purchased-badge")).toHaveText("Purchased");
    await expect(purchasedSheet.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await purchasedSheet.getByRole("button", { name: "Close" }).click();
    await expect(purchasedSheet).toHaveCount(0);
  } finally {
    await anon.close();
    // Leave no live link behind for later specs.
    await page.request.delete(`${BASE}/api/share`);
  }
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

test("16: login card meets AA, fits 360px, and reports failures", async ({ page, context }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  // Anonymous: the login page is the one surface without a session.
  await context.clearCookies();
  await page.goto(`${BASE}/login`);
  const card = page.locator(".auth-card");
  await expect(card).toBeVisible();

  const signIn = page.getByRole("button", { name: "Sign in" });
  await expect(signIn).toHaveClass(/settings-submit/);
  expect(await contrast(signIn), "login primary button").toBeGreaterThanOrEqual(4.5);
  expect(await contrast(card.locator(".auth-lockup .muted")), "login tagline")
    .toBeGreaterThanOrEqual(4.5);

  // Keyboard-reachable fields draw the shared 2px focus ring (A10 F5).
  const username = page.getByLabel("Username");
  await username.focus();
  expect(await username.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe("2px");

  // A failed sign-in is announced, not a silent no-op.
  await username.fill("admin");
  await page.getByLabel("Password").fill("not-the-password");
  await signIn.click();
  await expect(page.getByRole("alert")).toHaveText(/Invalid username or password|Too many attempts/);
  await expect(card).toBeVisible();
});

test("17: mobile user-menu sheet shows every row and does not jump the page", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });

  // The admin's header UserMenu trigger is named after the display name
  // (UserMenu.tsx:37,44; settings.spec.ts:22 pins "Admin").
  const trigger = page.locator('.user-menu-button[aria-label="Admin"]');
  await expect(trigger).toBeVisible();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await trigger.click();

  const sheet = page.getByRole("dialog", { name: "Admin" });
  await expect(sheet).toBeVisible();

  // The mobile sheet portals to document.body, so its overlay resolves
  // `inset: 0` against the viewport. Rendered in place it resolves against
  // .topbar's backdrop-filter containing block instead and collapses to a
  // ~topbar-height strip (#60), pushing the upper rows above the viewport.
  const overlay = await page.locator(".sheet-overlay").boundingBox();
  expect(overlay).not.toBeNull();
  expect(overlay!.y, "overlay starts at the viewport top").toBeLessThanOrEqual(1);
  expect(overlay!.height, "overlay spans the viewport").toBeGreaterThanOrEqual(840);

  // Every row is on screen and clickable — not clipped out of the viewport.
  // (`toBeVisible` alone cannot catch this: an element above the viewport
  // still has a non-empty box.)
  const settings = sheet.getByRole("menuitem", { name: "Settings" });
  const logout = sheet.getByRole("menuitem", { name: "Log out" });
  const cancel = sheet.getByRole("menuitem", { name: "Cancel" });
  await expect(settings).toBeInViewport();
  await expect(logout).toBeInViewport();
  await expect(cancel).toBeInViewport();

  // Focus moved into the sheet without scrolling the page (Sheet's
  // focus-on-open passes preventScroll).
  const scrollAfterOpen = await page.evaluate(() => window.scrollY);
  expect(scrollAfterOpen, "opening the sheet did not scroll the page").toBe(scrollBefore);
  await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  // Menu keyboard navigation works through the portal: focus starts on the
  // first row, Tab moves row by row, and Tab/Shift+Tab wrap at the ends —
  // focus never walks out of the modal into the page behind the scrim.
  // Sheet defers keydown inside a [role="menu"] subtree to OverflowMenu's
  // own handler, so that handler owns the mobile wrap (the desktop popover
  // still closes on Tab by design).
  await expect(settings).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(logout).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settings).toBeFocused();
  await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // Escape closes and returns focus to the trigger (the opener is captured
  // via document.activeElement at open, so it survives the portal).
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  // Usable, not merely visible: choosing Settings navigates to /settings.
  await trigger.click();
  const reopened = page.getByRole("dialog", { name: "Admin" });
  await expect(reopened).toBeVisible();
  await reopened.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
});
