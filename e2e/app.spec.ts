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

/** #72: the guest sheet's back-dismiss hook pops its same-URL sentinel via a
 *  history.back() on non-back closes. That traversal is ASYNC (commits a few
 *  ms later); a pushState issued before it commits is truncated. Any test that
 *  closes the sheet via Escape/overlay and then REOPENS it at machine speed
 *  must first wait for the previous sentinel to be gone from the history
 *  entry's state. goBack-close needs no settle (popstate already popped it). */
async function sheetHistorySettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = history.state as { sugarplum?: string } | null;
          return s?.sugarplum === "sheet";
        }),
      { timeout: 5_000 },
    )
    .toBe(false);
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
    // Capture the POST to learn the new row's id BEFORE any rendered state
    // exists — every later assertion anchors on that id, so --repeat-each
    // re-runs (same server, same DB, another "Fresh Kiss Trio" row) can never
    // go strict-mode-ambiguous or latch onto a prior run's row.
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/wishlist/items") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Add item" }).first().click();
    await expect(page).toHaveURL(`${BASE}/add`);
    await page.getByLabel("Link").fill(`${fixture.url}/product`);
    await page.getByRole("button", { name: "Add item" }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const item = (await response.json()) as { id: string };

    const card = page.locator(`.item-card[data-item-id="${item.id}"]`);
    // The pending→resolved transition IS the product contract: the row is
    // created pending with a provisional hostname title (127.0.0.1) and
    // enrichment must flip it to the scraped title. The feed polls while any
    // row is pending (AppPage convergence effect), so this converges even when
    // the initial feed fetch lost the race with the scrape.
    await expect
      .poll(() => card.locator(".row-open").innerText(), {
        timeout: 20_000,
        message: "scraped title replaces the provisional hostname",
      })
      .toContain("Fresh Kiss Trio");
    // Resolved: the pending marker is gone (data-fetch is undefined once
    // complete — ProductRow never renders data-fetch="complete").
    await expect(card).not.toHaveAttribute("data-fetch", "pending");
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
  // The add page clears the mobile overflow bar at the widths that matter.
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `add page overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `add page escapes at ${width}px`).toEqual([]);
  }
});

test("3e: add from the page returns to the feed scrolled to the new row", async ({ page }) => {
  // Seed enough rows that the new item lands below the fold: the handoff
  // scroll-to-row is only observable when the row is off-screen.
  for (let i = 0; i < 8; i++) {
    const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
      data: { title: `Scroll filler ${i}` },
    });
    expect(seeded.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();

  await page.getByRole("button", { name: "Add item" }).first().click();
  await expect(page).toHaveURL(`${BASE}/add`);
  await page.getByRole("button", { name: "Add details manually" }).click();
  await page.getByLabel("Title").fill("Scrollback probe");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page).toHaveURL(`${BASE}/`);

  const row = page.locator(".item-card").filter({ hasText: "Scrollback probe" });
  await expect(row).toBeVisible();
  // The feed handed the just-added row back and scrolled it into view (the
  // scroll is smooth unless reduced motion is requested, so poll for it).
  await expect
    .poll(
      async () => {
        const box = await row.boundingBox();
        if (!box) return false;
        const viewportHeight = await page.evaluate(() => window.innerHeight);
        return box.y >= 0 && box.y <= viewportHeight;
      },
      { timeout: 10_000, message: "the just-added row scrolled into view" },
    )
    .toBe(true);
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

  // The edit form keeps the mobile title row usable (no collapsed field) and
  // clears the overflow bar at every phone width.
  await page.getByRole("button", { name: "Edit item" }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}/edit`);
  await expect.poll(() => page.getByLabel("Title").evaluate((el) => Math.round(el.getBoundingClientRect().width)))
    .toBeGreaterThan(200);
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `edit page overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `edit page escapes at ${width}px`).toEqual([]);
  }

  // Cancel path: back to the item view, value discarded.
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
  // #72: the close icon is gone — a page is dismissed by the app back button.
  await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
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

  // #72: back dismisses the page (the close icon was its duplicate). The feed
  // and focus is not stranded in the unmounted page.
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
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

test("6c: back from an item page preserves the tag filter and scroll position", async ({ page }) => {
  // A long feed is needed for the scroll half of this test.
  for (let i = 0; i < 8; i++) {
    const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
      data: { title: `Context filler ${i}` },
    });
    expect(seeded.status()).toBe(201);
  }
  const tagged = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Context probe", tags: ["Birthday"] },
  });
  expect(tagged.status()).toBe(201);
  await page.reload();

  // Scroll half: the position survives the round trip, with no document load.
  const docLoads = await loads(page);
  await page.evaluate(() => window.scrollTo(0, 400));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled, "the feed really scrolls").toBeGreaterThan(100);
  // Open a row that is ALREADY inside the viewport. Playwright scrolls an
  // off-viewport target into view before clicking, and a scroll that happens
  // while the feed is on screen is — correctly — recorded by the feed's scroll
  // tracker; clicking the above-the-fold first row would therefore hand the
  // feed a 0 offset and the restore assertion below would compare against a
  // position the test itself erased.
  const visibleRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".item-card .row-open"));
    return rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
  });
  expect(visibleRow, "a row is fully inside the viewport at this scroll").toBeGreaterThanOrEqual(0);
  await page.locator(".item-card .row-open").nth(visibleRow).click();
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
  await expect(page.locator(".detail-title")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/`);
  expect(await loads(page)).toBe(docLoads); // soft navigation, no reload
  // The restore runs in AppPage's mount effects after boot()'s /api/auth/me
  // round trip — always after goBack() returns, sometimes a beat later. Poll
  // for it rather than reading once: the poll can only pass once the handoff's
  // scrollTo(0, restoreY) has actually run.
  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      timeout: 10_000,
      message: "scroll position restored from the feed handoff",
    })
    .toBeGreaterThanOrEqual(scrolled - 5);

  // Context half: the active tag filter survives the same round trip.
  await page.getByRole("button", { name: "Birthday", exact: true }).click();
  await expect(page.getByRole("button", { name: "Birthday", exact: true })).toHaveClass(/active/);
  const filtered = await page.locator(".item-card").count();
  expect(filtered).toBeGreaterThan(0);
  await page.locator(".item-card .row-open").first().click();
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.locator(".item-card")).toHaveCount(filtered);
  await expect(page.getByRole("button", { name: "Birthday", exact: true })).toHaveClass(/active/);

  // Leave the feed unfiltered for the tests that follow.
  await page.getByRole("button", { name: "All", exact: true }).click();
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

test("5d: desktop rows show no drag affordance outside reorder mode (#93)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  const lastCard = page.locator(".item-card").last();
  await expect(page.locator(".item-card.is-reordering")).toHaveCount(0);

  // Hover and focus-within must not conjure any drag affordance.
  await expect(lastCard.locator(".drag-handle")).toHaveCount(0);
  await lastCard.hover();
  await expect(lastCard.locator(".drag-handle")).toHaveCount(0);
  await lastCard.locator(".row-open").focus();
  await expect(lastCard.locator(".drag-handle")).toHaveCount(0);

  // Kebab is the only action left on a non-reordering row.
  await expect(lastCard.getByRole("button", { name: "More actions" })).toBeVisible();

  // Reorder mode remains the one path in, and its drag still persists.
  const titles = page.locator(".item-card .item-title");
  const before = await titles.allTextContents();
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await expect(page.locator(".item-list .drag-handle:visible").first()).toBeVisible();
  await page.locator(".item-list .drag-handle").last().dragTo(page.locator(".item-card").first());
  await expect(titles.first()).toHaveText(before[before.length - 1]);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".drag-handle:visible")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".item-card .item-title").first()).toHaveText(before[before.length - 1]);
});

test("5e: #70 desktop hover — title paints nothing, rows overflow nowhere", async ({ page }) => {
  // Two priced rows so hover state and price-cluster geometry are exercised
  // (priceCents/currency shape per test 18's API usage).
  for (const [title, price] of [["Hover probe A", "19.99"], ["Hover probe B", "9.99"]] as const) {
    const res = await page.request.post(`${BASE}/api/wishlist/items`, {
      data: { title, priceCents: price, currency: "USD" },
    });
    expect(res.status()).toBe(201);
  }
  await page.reload();

  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    // Mouse park: the PREVIOUS iteration may leave the pointer over a card
    // at stale viewport coordinates — clear hover so assertions are
    // deterministic (the suite's own pattern, e.g. test 5's mouse.move(0,0)).
    await page.mouse.move(0, 0);
    const card = page.locator(".item-card", { hasText: "Hover probe A" }).first();
    const open = card.locator(".row-open");

    // #70 Fix 1: hover the TITLE BUTTON itself — the global button:hover
    // only paints when the button is the hovered element.
    await open.hover();
    const btnBg = await open.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(btnBg, `title paint at ${width}px`).toBe("rgba(0, 0, 0, 0)");

    // #70 Fix 2: no native tooltip attribute.
    expect(await open.getAttribute("title")).toBeNull();

    // #93: no drag affordance renders on this row at all (was: grip
    // position/geometry probes — the grip no longer exists).
    await expect(card.locator(".drag-handle")).toHaveCount(0);

    // No horizontal escape introduced at this width.
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `#70 overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `#70 escapes at ${width}px`).toEqual([]);
  }

  // Both themes: the reset is token-free but verify dark renders the same.
  await page.emulateMedia({ colorScheme: "dark" });
  const card = page.locator(".item-card", { hasText: "Hover probe A" }).first();
  const open = card.locator(".row-open");
  await card.hover();
  await open.hover();
  const darkBg = await open.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg, "title paint dark").toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ colorScheme: "light" });
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

    // #72: the app back button also dismisses the guest sheet, and focus
    // returns to the opener row (Sheet's own close contract). The Escape
    // close above queued a pop, so let it commit before reopening.
    await sheetHistorySettled(bob);
    await card.getByRole("button", { name: "Claimable mug" }).click();
    const guestSheet2 = bob.getByRole("dialog", { name: "Claimable mug" });
    await expect(guestSheet2).toBeVisible();
    await expect(guestSheet2.getByRole("button", { name: "Close" })).toHaveCount(0);
    const guestUrl = bob.url();
    await bob.goBack();
    await expect(guestSheet2).toHaveCount(0);
    expect(bob.url()).toBe(guestUrl); // same-URL sentinel: no navigation
    await expect(card.getByRole("button", { name: "Claimable mug" })).toBeFocused();

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
      // #72: the previous iteration's Escape close queued a sentinel pop; let
      // that traversal commit before this open pushes a new one.
      await sheetHistorySettled(guest);
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
    // #72: same settle discipline as the other-user probe above.
    await sheetHistorySettled(page);
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
  // (--plum-600); both are locked here through the rendered ratio. The
  // --text-3 anchor is the item page's .detail-footer — the feed has no
  // guaranteed --text-3 element at rest since #94 dropped the app footer.
  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "History probe" }),
  });
  await card.getByRole("button", { name: "History probe", exact: true }).click();
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
  const muted = page.locator(".item-page .detail-footer");
  await expect(muted).toBeVisible();
  expect(await contrast(muted), "dark muted text").toBeGreaterThanOrEqual(4.5);

  await page.goto(`${BASE}/`);
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
    // #72: no close icon on the sheet; the app back button dismisses it
    // gesture equivalent) with focus returning to the opener row.
    await expect(sheet.getByRole("button", { name: "Close" })).toHaveCount(0);
    const shareUrl = `${BASE}/share/${token}`;
    await anonPage.goBack();
    await expect(sheet).toHaveCount(0);
    await expect(anonPage).toHaveURL(shareUrl); // sentinel is same-URL
    await expect(card.getByRole("button", { name: "Guest detail probe" })).toBeFocused();

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
    await anonPage.goBack();
    await expect(purchasedSheet).toHaveCount(0);
    await expect(anonPage).toHaveURL(shareUrl);
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
  // #73: Settings moved out of the mobile avatar menu (it now lives on the
  // bottom action bar), so the rows are Log out and Cancel — plus the install
  // row when the browser offers install, which is not focusable here.
  const logout = sheet.getByRole("menuitem", { name: "Log out" });
  const cancel = sheet.getByRole("menuitem", { name: "Cancel" });
  await expect(sheet.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
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
  await expect(logout).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(logout).toBeFocused();
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

  // Usable, not merely visible: the mobile route to Settings is the bottom
  // action bar's Settings item (#73), and it navigates.
  await trigger.click();
  const reopened = page.getByRole("dialog", { name: "Admin" });
  await expect(reopened).toBeVisible();
  await page.keyboard.press("Escape"); // close the sheet, back to the feed
  await expect(reopened).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Primary actions" })
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
});

test("18: currency select matches input metrics and keeps a chevron (#74)", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Select metrics probe", priceCents: "9.99", currency: "GBP" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };

  for (const width of [360, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/items/${item.id}/edit`);
    await expect(page.getByLabel("Currency")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const input = document.getElementById("item-price");
      const select = document.getElementById("item-currency");
      if (!input || !select) throw new Error("price/currency fields missing");
      const cs = getComputedStyle(select);
      const ir = input.getBoundingClientRect();
      const sr = select.getBoundingClientRect();
      return {
        inputH: ir.height,
        selectH: sr.height,
        topsEqual: ir.top === sr.top,
        bottomsEqual: ir.bottom === sr.bottom,
        minHeight: cs.minHeight,
        appearance: cs.appearance,
        chevron: cs.backgroundImage,
        padRight: cs.paddingRight,
      };
    });
    expect(metrics.minHeight, `select min-height at ${width}px`).toBe("44px");
    expect(metrics.appearance, `select appearance at ${width}px`).toBe("none");
    expect(metrics.chevron, `chevron painted at ${width}px`).toContain("data:image/svg+xml");
    // "Pixel-for-pixel" gate: identical boxes (≤0.5px float noise) and both at
    // least the shared 44px floor.
    expect(Math.abs(metrics.selectH - metrics.inputH), `select height at ${width}px`).toBeLessThanOrEqual(0.5);
    expect(metrics.selectH, `select floor at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(metrics.topsEqual && metrics.bottomsEqual, `row alignment at ${width}px`).toBe(true);
  }

  // Both themes: the chevron must paint in dark too (different SVG tint).
  // Compare lowercased — the serializer keeps the data URI verbatim (including
  // the %23 escaping), so the lowercase hex substring is stable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${BASE}/items/${item.id}/edit`);
  const darkChevron = await page.evaluate(() => {
    const select = document.getElementById("item-currency");
    if (!select) throw new Error("currency select missing");
    return getComputedStyle(select).backgroundImage.toLowerCase();
  });
  expect(darkChevron).toContain("%2394909f");

  // Keyboard behavior is unchanged by appearance:none (it styles the closed box
  // only). Measured on this host's headless Chromium with the real option set:
  // ArrowDown advances and commits GBP -> USD; type-ahead "e" jumps to EUR;
  // focus is retained throughout. On a real desktop ArrowDown opens the popup
  // and the same key lands on the next option either way — the VALUE contract
  // is the portable assertion.
  await expect(page.getByLabel("Currency")).toBeVisible();
  await page.getByLabel("Currency").focus();
  await expect(page.getByLabel("Currency")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("Currency")).toHaveValue("USD");
  await expect(page.getByLabel("Currency")).toBeFocused();
  await page.evaluate(() => {
    const sel = document.getElementById("item-currency");
    if (sel instanceof HTMLSelectElement) sel.value = "GBP";
  });
  await page.keyboard.press("e");
  await expect(page.getByLabel("Currency")).toHaveValue("EUR");
});

test("19: mobile bottom action bar — actions, layout, a11y (#73)", async ({ page }) => {
  // Seed one item so the feed shows the full 3-item bar (share included).
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Bottom bar probe" },
  });
  expect(seeded.status()).toBe(201);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/`);
    await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();

    // A nav landmark with three named buttons; the visible labels are the
    // bar's own short copy while the accessible names stay the app's.
    const bar = page.getByRole("navigation", { name: "Primary actions" });
    await expect(bar).toBeVisible();
    await expect(bar.locator(".action-bar-item")).toHaveCount(3);
    for (const name of ["Add item", "Share my list", "Settings"]) {
      await expect(bar.getByRole("button", { name })).toBeVisible();
    }
    await expect(bar.getByText("Share", { exact: true })).toBeVisible(); // visible label

    // Mockup grammar: fixed, borderless buttons on the app background, one
    // hairline divider, no fills.
    const chrome = await bar.evaluate((el) => {
      const cs = getComputedStyle(el);
      const btn = el.querySelector("button");
      const bcs = btn ? getComputedStyle(btn) : null;
      return {
        barBg: cs.backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        barBorderTop: cs.borderTopWidth,
        barBorderTopColor: cs.borderTopColor,
        position: cs.position,
        btnBorder: bcs?.borderStyle,
        btnBg: bcs?.backgroundColor,
        btnOutline: bcs?.outlineStyle,
      };
    });
    expect(chrome.position).toBe("fixed");
    expect(chrome.barBg).toBe(chrome.bodyBg); // app background, not a bar fill
    expect(chrome.barBorderTop).toBe("1px"); // thin top divider
    expect(chrome.barBorderTopColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(chrome.btnBorder).toBe("none"); // NO button borders
    expect(chrome.btnBg).toBe("rgba(0, 0, 0, 0)"); // no fills

    // 44px+ touch targets on a full-width bar.
    for (const item of await bar.locator(".action-bar-item").all()) {
      const box = await item.boundingBox();
      expect(Math.round(box?.height ?? 0), `target height at ${width}px`).toBeGreaterThanOrEqual(44);
    }
    const barBox = await bar.boundingBox();
    expect(Math.round(barBox?.width ?? 0), `bar width at ${width}px`).toBe(width);
    expect(Math.round(barBox?.y ?? 0) + Math.round(barBox?.height ?? 0)).toBe(844); // flush to the bottom

    // No occlusion: the bar is fixed over the last 56px of the viewport, so
    // at the bottom of the scroll the last feed row must still clear the
    // bar's top edge — the padding reserved on .app-main (the last
    // scroll-flow element now that #94 dropped the app footer) buys that
    // space. `.app-main`'s BOX ends at the viewport bottom; its content is
    // what would be swallowed without the reservation.
    const clearance = await page.evaluate(() => {
      const barEl = document.querySelector(".action-bar");
      const main = document.querySelector(".app-main");
      if (!barEl || !main) throw new Error("bar/main missing");
      window.scrollTo(0, document.body.scrollHeight);
      const rows = main.querySelectorAll(".item-card");
      const content = rows.length ? rows[rows.length - 1] : main;
      return {
        barTop: barEl.getBoundingClientRect().top,
        contentBottom: content.getBoundingClientRect().bottom,
      };
    });
    expect(clearance.contentBottom, `last row occluded at ${width}px`).toBeLessThanOrEqual(
      clearance.barTop,
    );

    // No horizontal overflow with the bar in place (also rides the 360-1280
    // sweep in test 9).
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `bar overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `bar escapes at ${width}px`).toEqual([]);

    // Wiring and the rest are route- or keyboard-level, not per-width.
    if (width === 390) {
      // Keyboard-complete: the bar closes the feed's tab order and all three
      // items are reachable in order with the app's focus ring.
      await page.evaluate(() => {
        const sel = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const barEl = document.querySelector(".action-bar");
        if (!barEl) throw new Error("bar missing");
        const before = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(
          (el) =>
            !barEl.contains(el) &&
            (barEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
        );
        before[before.length - 1]?.focus();
      });
      await page.keyboard.press("Tab");
      await expect(bar.getByRole("button", { name: "Add item" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(bar.getByRole("button", { name: "Share my list" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(bar.getByRole("button", { name: "Settings" })).toBeFocused();
      expect(
        await bar
          .getByRole("button", { name: "Settings" })
          .evaluate((el) => getComputedStyle(el).outlineWidth),
        "keyboard focus ring on a bar item",
      ).toBe("2px");
      await page.keyboard.press("Shift+Tab");
      await expect(bar.getByRole("button", { name: "Share my list" })).toBeFocused();

      // Settings navigates to /settings, where the bar PERSISTS (#95: it is
      // shell chrome now, not a feed-only control) and Settings carries the
      // current-destination accent.
      await bar.getByRole("button", { name: "Settings" }).click();
      await expect(page).toHaveURL(/\/settings$/);
      const barOnSettings = page.getByRole("navigation", { name: "Primary actions" });
      await expect(barOnSettings).toBeVisible();
      await expect(barOnSettings.locator(".action-bar-item")).toHaveCount(3);
      const settingsBtn = barOnSettings.getByRole("button", { name: "Settings" });
      await expect(settingsBtn).toHaveAttribute("aria-current", "page");
      await expect(settingsBtn).toHaveClass(/is-current/);
      await expect(
        barOnSettings.getByRole("button", { name: "Add item" }),
      ).not.toHaveAttribute("aria-current");
      await page.goBack();
      await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();

      // Share opens the SAME #45 surface (the mobile sheet), and closing it
      // returns focus to the bar trigger.
      await bar.getByRole("button", { name: "Share my list" }).click();
      const shareSheet = page.getByRole("dialog", { name: "Share my list" });
      await expect(shareSheet).toHaveClass(/sheet--share/);
      await expect(shareSheet.getByRole("heading", { name: "Share your wishlist" })).toBeVisible();
      await expect(shareSheet.getByRole("button", { name: /Create link|New link/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(shareSheet).toHaveCount(0);
      await expect(bar.getByRole("button", { name: "Share my list" })).toBeFocused();
      await expect(bar.getByRole("button", { name: "Share my list" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      // Add navigates to /add client-side (no document load) and the bar
      // persists there with Add as the current destination (#95).
      const loadsBefore = await loads(page);
      await bar.getByRole("button", { name: "Add item" }).click();
      await expect(page).toHaveURL(`${BASE}/add`);
      expect(await loads(page)).toBe(loadsBefore);
      const barOnAdd = page.getByRole("navigation", { name: "Primary actions" });
      await expect(barOnAdd).toBeVisible();
      await expect(barOnAdd.getByRole("button", { name: "Add item" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(barOnAdd.getByRole("button", { name: "Settings" })).not.toHaveAttribute(
        "aria-current",
      );
      await page.goBack();
      await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
    }
  }

  // The breakpoint seam is the app's existing 640px one: below it the bar
  // owns the actions, at it the header cluster does — and exactly ONE Share
  // and one Add button exist either side of the seam (#73 D1/D4).
  for (const [width, barCount] of [
    [639, 1],
    [640, 0],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${BASE}/`);
    await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
    await expect(page.locator(".action-bar"), `.action-bar at ${width}px`).toHaveCount(barCount);
    await expect(page.getByRole("button", { name: "Share my list" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(1);
  }

  // Desktop (1280): NO bar, and the top-bar actions are still there — with
  // the avatar menu still carrying Settings (#73 keeps desktop untouched).
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  await expect(page.locator(".action-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Share my list" })).toBeVisible();
  const menu = page.locator('.user-menu-button[aria-label="Admin"]');
  await menu.click();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("20: quiet ghost icon buttons — no standing chrome, soft hover (#75)", async ({ page }) => {
  // #75: the round ⋮ and the top-bar chips drop their standing fill/border
  // and read as quiet ghosts: transparent resting state, muted icon, soft
  // --surface-2 tint on hover. The avatar keeps its plum circle (brand);
  // only its wrapper chrome disappears. Focus-visible, aria-labels, 44px
  // targets and every existing selector are untouched.

  const bg = (el: Locator) => el.evaluate((e) => getComputedStyle(e).backgroundColor);
  const borderColor = (el: Locator) => el.evaluate((e) => getComputedStyle(e).borderColor);
  const NONE = "rgba(0, 0, 0, 0)"; // Chromium's transparent

  // The serial suite has items by now, but seed one when test 20 runs alone
  // (the filtered RED/GREEN runs do) so the desktop header cluster exists.
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
  const itemsUrl = `${BASE}/api/users/${me.id}/wishlist`;
  let list = (await (await page.request.get(itemsUrl)).json()) as Array<{ id: string }>;
  if (list.length === 0) {
    await page.request.post(`${BASE}/api/wishlist/items`, { data: { title: "Quiet probe" } });
    list = (await (await page.request.get(itemsUrl)).json()) as Array<{ id: string }>;
  }
  const itemId = list[0]!.id;

  for (const colorScheme of ["light", "dark"] as const) {
    // Exact token values per scheme (tokens.css:15/23, 143/150).
    const surface2 = colorScheme === "light" ? "rgb(244, 244, 245)" : "rgb(38, 33, 48)";
    const border = colorScheme === "light" ? "rgb(228, 228, 231)" : "rgb(42, 36, 56)";

    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/`);
    await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();

    // --- Desktop top-bar chips, scoped to .topbar-actions so the EmptyState's
    // primary "Add item" (AppPage.tsx:479, plum fill, correct as-is) can never
    // be mistaken for the header chip on an empty feed.
    const cluster = page.locator(".topbar-actions");
    await expect(cluster).toBeVisible(); // feed is non-empty by test 20 in this serial suite
    const add = cluster.getByRole("button", { name: "Add item", exact: true });
    const share = cluster.getByRole("button", { name: "Share my list", exact: true });
    for (const [name, btn] of [["Add item", add], ["Share", share]] as const) {
      expect(await bg(btn), `${colorScheme}/${name}: no standing fill`).toBe(NONE);
      expect(await borderColor(btn), `${colorScheme}/${name}: no standing border`).toBe(NONE);
    }
    // 44px target survives the quieting.
    expect((await add.boundingBox())!.height, `${colorScheme}: Add item target >= 44px`)
      .toBeGreaterThanOrEqual(44);

    // --- Ghost chip hover (the rule that changes most): soft tint + hairline
    // replace the old plum border + transparent background. Polled because
    // .icon-btn transitions background/border (the first probe can land
    // mid-interpolation).
    await add.hover();
    await expect.poll(() => bg(add), { message: `${colorScheme}/Add item hover tint` }).toBe(surface2);
    await expect.poll(() => borderColor(add), { message: `${colorScheme}/Add item hover hairline (no plum)` }).toBe(border);
    await page.mouse.move(0, 0); // leave hover before the next probe

    // --- Avatar chip: transparent wrapper; hover = soft tint + hairline, and
    // specifically NOT a plum border flash (the global button:hover leak,
    // plan §1.3 trap 2, must stay dead in both schemes).
    const avatar = page.locator('.user-menu-button[aria-label="Admin"]');
    expect(await bg(avatar), `${colorScheme}/avatar: no standing fill`).toBe(NONE);
    expect(await borderColor(avatar), `${colorScheme}/avatar: no standing border`).toBe(NONE);
    await avatar.hover();
    await expect.poll(() => bg(avatar), { message: `${colorScheme}/avatar hover tint` }).toBe(surface2);
    await expect.poll(() => borderColor(avatar), { message: `${colorScheme}/avatar hover hairline (no plum)` }).toBe(border);
    await page.mouse.move(0, 0); // leave hover before the next probe

    // --- Detail ⋮: transparent circle standing; quiet hover tint from
    // .icon-btn:hover (the trigger carries "icon-btn detail-menu-trigger").
    // Two-step idiom from test 4e2 (app.spec.ts:532-534): the wishlist route
    // is /api/users/:id (wishlist.ts:253) — there is no "me" literal route.
    await page.goto(`${BASE}/items/${itemId}`);
    const menuBtn = page.locator(".detail-menu-trigger");
    await expect(menuBtn).toBeVisible();
    expect(await bg(menuBtn), `${colorScheme}/⋮: no standing fill`).toBe(NONE);
    expect(await borderColor(menuBtn), `${colorScheme}/⋮: no standing border`).toBe(NONE);
    await menuBtn.hover();
    await expect.poll(() => bg(menuBtn), { message: `${colorScheme}/⋮ hover tint` }).toBe(surface2);
    // No cleanup needed: hover is discarded by the next loop's page.goto.
    // (The ⋮ menu opens on CLICK, not hover — nothing is left open. Do NOT
    // press Escape here: #72's back-dismiss would navigate away.)
  }

  // Focus-visible ring contract unchanged (spot-check one representative):
  // focusing the Add chip shows the plum ring exactly as before.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/`);
  const add = page.locator(".topbar-actions").getByRole("button", { name: "Add item", exact: true });
  await add.focus();
  await expect(add).toBeFocused();
  const outline = await add.evaluate((e) => getComputedStyle(e).outlineColor);
  expect(outline).toContain("124, 58, 237"); // --plum-500 light #7c3aed = rgb(124,58,237)
});

test("21: desktop reading column — non-feed pages cap at 720px, feed does not (#71)", async ({ page }) => {
  // #71: on desktop the non-feed pages (detail, add, edit) stop stretching
  // their drawer-era internals across the full 1060px .app-main column and
  // render a centered 720px reading column instead. The feed keeps the full
  // column. Geometry is asserted with computed styles + boundingBox (the
  // house idiom from tests 18/20) — screenshots cannot go red, geometry can.
  const COL = 720;

  // The serial chain seeds "History probe" in 4b. When this test runs alone
  // (the filtered RED/GREEN runs) seed the same shape, so the assertions
  // below measure the layout rather than a missing fixture.
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
  const list = (await (await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)).json()) as Array<{ id: string; title: string }>;
  let probe = list.find((item) => item.title === "History probe");
  if (!probe) {
    const created = await page.request.post(`${BASE}/api/wishlist/items`, {
      data: { title: "History probe", priceCents: "12.50", currency: "GBP" },
    });
    expect(created.status()).toBe(201);
    probe = { id: ((await created.json()) as { id: string }).id, title: "History probe" };
  }

  // --- Detail page: cap + centering at every desktop width, both schemes.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE}/items/${probe.id}`);
      const itemPage = page.locator(".item-page");
      await expect(itemPage).toBeVisible();

      const capped = await itemPage.evaluate((el) => ({
        maxWidth: getComputedStyle(el).maxWidth,
        box: el.getBoundingClientRect().width,
      }));
      expect(capped.maxWidth, `${scheme} @${width}: .item-page max-width`).toBe(`${COL}px`);
      expect(capped.box, `${scheme} @${width}: .item-page rendered width`).toBeLessThanOrEqual(COL);

      // Centered: .item-page's midpoint == .app-main's midpoint (both are
      // auto-margin centered on the same axis).
      const centers = await itemPage.evaluate((el) => {
        const pageBox = el.getBoundingClientRect();
        const main = el.closest(".app-main")!.getBoundingClientRect();
        return { pageMid: pageBox.left + pageBox.width / 2, mainMid: main.left + main.width / 2 };
      });
      expect(Math.abs(centers.pageMid - centers.mainMid), `${scheme} @${width}: column centered`).toBeLessThanOrEqual(1);

      const overflow = await horizontalEscapes(page);
      expect(overflow.docOverflow, `${scheme} @${width}: detail overflow`).toBe(false);
      expect(overflow.offenders, `${scheme} @${width}: detail escapes`).toEqual([]);
    }
  }

  // --- Add page: same cap; the submit pill spans the column, not the viewport.
  await page.emulateMedia({ colorScheme: "light" });
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/add`);
    const addPage = page.locator(".add-page");
    await expect(addPage).toBeVisible();
    expect((await addPage.boundingBox())!.width, `@${width}: .add-page column width`).toBeLessThanOrEqual(COL);

    const submit = page.locator(".add-submit");
    await expect(submit).toBeVisible();
    expect((await submit.boundingBox())!.width, `@${width}: submit pill spans the column`).toBeLessThanOrEqual(COL);

    const overflow = await horizontalEscapes(page);
    expect(overflow.docOverflow, `@${width}: add overflow`).toBe(false);
    expect(overflow.offenders, `@${width}: add escapes`).toEqual([]);
  }

  // --- Skeleton parity: the boot skeleton renders inside the same column, so
  // the skeleton→page swap never re-centers (no layout shift on slow loads).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/add`);
  const skeleton = page.locator(".skeleton-form");
  if ((await skeleton.count()) > 0) {
    expect((await skeleton.boundingBox())!.width, "boot skeleton width matches the column").toBeLessThanOrEqual(COL);
  } else {
    // The boot already settled. getComputedStyle on a detached-class probe
    // still resolves media queries in Chromium, so the rule itself is the
    // contract here (the live box above is best-effort).
    const probeMax = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "skeleton-form";
      document.body.appendChild(el);
      const maxWidth = getComputedStyle(el).maxWidth;
      el.remove();
      return maxWidth;
    });
    expect(probeMax, "skeleton-form carries the 720px cap rule").toBe(`${COL}px`);
  }

  // --- Edit page: shares .add-page — one spot check.
  await page.goto(`${BASE}/items/${probe.id}/edit`);
  const editPage = page.locator(".add-page");
  await expect(editPage).toBeVisible();
  expect((await editPage.boundingBox())!.width, "edit page column width").toBeLessThanOrEqual(COL);

  // --- Feed lock: the feed does NOT get the cap (its rows span the full
  // 1060px column minus the 16px gutters).
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  const rowWidth = await page.locator(".product-row-grid").first().evaluate((el) => el.getBoundingClientRect().width);
  expect(rowWidth, "feed rows keep the full app column").toBeGreaterThan(COL);

  // --- Below the 1024px gate there is NO cap: mobile (≤430px) and tablet
  // stay fluid, and the overflow probe stays clean at every width.
  for (const width of [430, 768, 1023]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/items/${probe.id}`);
    const itemPage = page.locator(".item-page");
    await expect(itemPage).toBeVisible();
    const fluid = await itemPage.evaluate((el) => {
      const main = el.closest(".app-main")!;
      const cs = getComputedStyle(main);
      return {
        maxWidth: getComputedStyle(el).maxWidth,
        box: el.getBoundingClientRect().width,
        contentWidth:
          main.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      };
    });
    expect(fluid.maxWidth, `@${width}: no 720 cap below the gate`).toBe("none");
    expect(fluid.box, `@${width}: page fills the app column`).toBeGreaterThanOrEqual(fluid.contentWidth - 1);

    const overflow = await horizontalEscapes(page);
    expect(overflow.docOverflow, `@${width}: overflow`).toBe(false);
    expect(overflow.offenders, `@${width}: escapes`).toEqual([]);
  }

  // Leave the viewport desktop for any later assertions.
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("22: owner purchased mark — mark, badge, unmark, and privacy (#76)", async ({
  page,
  browser,
}) => {
  // Seed a fresh item for this test (serial suite: earlier rows exist too —
  // scope every locator to THIS item id).
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Owner mark probe" },
  });
  expect(seeded.status()).toBe(201);
  const item = (await seeded.json()) as { id: string };
  await page.reload();

  // --- 1. Feed row: mark via overflow menu, confirm-guarded. ---
  const card = page.locator(`.item-card[data-item-id="${item.id}"]`);
  await card.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await menu.getByRole("menuitem", { name: "Mark as purchased" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Only you can see and undo this mark.")).toBeVisible();
  await dialog.getByRole("button", { name: "Mark as purchased" }).click();
  await expect(dialog).toHaveCount(0);

  // Row now carries the owner badge + share-view strike treatment.
  await expect(card.locator(".owner-purchased-badge")).toHaveText("Bought by you");
  await expect(card).toHaveClass(/is-purchased/);
  await expect(card.locator(".item-title")).toHaveCSS("text-decoration-line", "line-through");
  // The owner badge is NOT the share badge (test 15's selector contract).
  await expect(card.locator(".share-purchased-badge")).toHaveCount(0);

  // --- 2. Item page: badge + menu flips to Unmark; unmark clears. ---
  await card.getByRole("button", { name: "Owner mark probe", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
  const itemPage = page.locator(".item-page");
  await expect(itemPage.locator(".owner-purchased-badge")).toHaveText("Bought by you");
  await itemPage.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menu", { name: "More actions" })
    .getByRole("menuitem", { name: "Unmark purchased" })
    .click();
  await expect(itemPage.locator(".owner-purchased-badge")).toHaveCount(0);
  // Back on the feed, the row is restored (no strike, no badge).
  await page.goto(`${BASE}/`);
  await expect(card.locator(".owner-purchased-badge")).toHaveCount(0);
  await expect(card).not.toHaveClass(/is-purchased/);

  // --- 3. THE PRIVACY REGRESSION, in the browser. ---
  // Mark again (item page path this time), then have an anonymous friend
  // ALSO mark the same item via the share link. The owner's surfaces must
  // show ONLY their own mark — and an anonymous mark must move nothing the
  // owner can see.
  await page.goto(`${BASE}/items/${item.id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menu", { name: "More actions" })
    .getByRole("menuitem", { name: "Mark as purchased" })
    .click();
  const dialog2 = page.getByRole("alertdialog");
  await dialog2.getByRole("button", { name: "Mark as purchased" }).click();
  await expect(page.locator(".item-page .owner-purchased-badge")).toBeVisible();

  const shared = await page.request.post(`${BASE}/api/share`);
  expect(shared.status()).toBe(201);
  const { token } = (await shared.json()) as { token: string };
  const shareUrl = `${BASE}/share/${token}`;

  const anon = await browser.newContext();
  try {
    const anonPage = await anon.newPage();
    await anonPage.goto(shareUrl);
    const anonCard = anonPage.locator(`.item-card[data-item-id="${item.id}"]`);
    await anonCard.getByRole("button", { name: "More actions" }).click();
    await anonPage.getByRole("menuitem", { name: "Mark as purchased" }).click();
    const anonDialog = anonPage.getByRole("alertdialog");
    await anonDialog.getByRole("button", { name: "Mark as purchased" }).click();
    // The anonymous viewer sees the SHARE badge (double-gift prevention).
    await expect(anonCard.locator(".share-purchased-badge")).toBeVisible();

    // Owner list API: the raw JSON carries the owner's own mark ONLY.
    const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
    const ownList = (await (
      await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)
    ).json()) as Record<string, unknown>[];
    const mine = ownList.find((i) => i.id === item.id) as Record<string, unknown>;
    expect(mine.ownerPurchased).toBe(true);
    expect(Object.keys(mine)).not.toContain("purchased");
    expect(Object.keys(mine)).not.toContain("purchasedAt");
    expect(JSON.stringify(mine)).not.toContain("purchased_at");

    // Owner's own share view: the anonymous mark is projected out; the owner
    // mark does NOT appear on the share surface either.
    await page.goto(shareUrl);
    await expect(
      page.getByText("You are viewing your own shared list. Purchased marks are hidden from you."),
    ).toBeVisible();
    await expect(page.locator(".share-purchased-badge")).toHaveCount(0);
    await expect(page.locator(".owner-purchased-badge")).toHaveCount(0);
    await expect(page.locator(`.item-card[data-item-id="${item.id}"]`)).not.toHaveClass(/is-purchased/);
  } finally {
    await anon.close();
  }

  // --- 4. Mobile + dark sweep on the marked row (product rules). ---
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/`);
    await expect(card.locator(".owner-purchased-badge")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${BASE}/`);
    await expect(card.locator(".owner-purchased-badge")).toBeVisible();
  }
  // Restore the suite's ambient scheme (later tests assert light-tinted
  // styles; test 6b/12 set and reset explicitly — follow the same pattern).
  await page.emulateMedia({ colorScheme: "light" });

  // --- 5. Board hygiene: leave the row unmarked and the token dead for any
  // later test (mirror test 15's revoke-and-clean ending). ---
  await card.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menu", { name: "More actions" })
    .getByRole("menuitem", { name: "Unmark purchased" })
    .click();
  await expect(card.locator(".owner-purchased-badge")).toHaveCount(0);
  const revoke = await page.request.delete(`${BASE}/api/share`);
  expect([200, 204]).toContain(revoke.status());
});

test("23: bottom action bar persists on every authenticated route (#95)", async ({
  page,
  browser,
}) => {
  // Seed a probe item for the /items/:id + /items/:id/edit legs.
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Bar persistence probe" },
  });
  expect(seeded.status()).toBe(201);
  const probe = (await seeded.json()) as { id: string };

  // --- A. /settings at every mobile width, both schemes. --------------
  // #95's core: the bar is shell chrome, so a NON-feed route keeps it, and
  // Settings — the route's own destination — carries the accent while Add
  // does not.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${BASE}/settings`);
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

      const bar = page.getByRole("navigation", { name: "Primary actions" });
      await expect(bar, `no bar on /settings @${width}/${scheme}`).toBeVisible();
      // The issue's e2e row: from /settings the bar still offers all three.
      for (const name of ["Add item", "Share my list", "Settings"]) {
        await expect(bar.getByRole("button", { name })).toBeVisible();
      }

      const settingsBtn = bar.getByRole("button", { name: "Settings" });
      const addBtn = bar.getByRole("button", { name: "Add item" });
      await expect(settingsBtn).toHaveAttribute("aria-current", "page");
      await expect(settingsBtn).toHaveClass(/is-current/);
      await expect(addBtn).not.toHaveAttribute("aria-current");
      await expect(addBtn).not.toHaveClass(/is-current/);
      // Painted, not just classed — and AA in both schemes (plan §1.9).
      expect(
        await settingsBtn.evaluate((el) => getComputedStyle(el).color),
        `accent not painted @${width}/${scheme}`,
      ).not.toBe(await addBtn.evaluate((el) => getComputedStyle(el).color));
      expect(await contrast(settingsBtn), `accent contrast @${width}/${scheme}`)
        .toBeGreaterThanOrEqual(4.5);

      // No occlusion on a non-feed page: at the bottom of the scroll the
      // last settings section must clear the bar's top edge (the :has()
      // reservation now applies on every page that renders the bar).
      const clearance = await page.evaluate(() => {
        const barEl = document.querySelector(".action-bar");
        const sections = document.querySelectorAll(".settings-section");
        const content = sections.length ? sections[sections.length - 1] : null;
        if (!barEl || !content) throw new Error("bar/settings section missing");
        window.scrollTo(0, document.body.scrollHeight);
        return {
          barTop: barEl.getBoundingClientRect().top,
          contentBottom: content.getBoundingClientRect().bottom,
        };
      });
      expect(clearance.contentBottom, `occluded @${width}/${scheme}`).toBeLessThanOrEqual(
        clearance.barTop,
      );

      const probeOverflow = await horizontalEscapes(page);
      expect(probeOverflow.docOverflow, `overflow @${width}/${scheme}`).toBe(false);
      expect(probeOverflow.offenders, `escapes @${width}/${scheme}`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: "light" }); // restore ambient scheme

  // --- B. The bar's Share works from /settings. ------------------------
  // ShareMenu fetches /api/share itself and portals its mobile sheet, so the
  // trigger is route-independent — SharePanel is usable from any page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/settings`);
  const bar = page.getByRole("navigation", { name: "Primary actions" });
  await bar.getByRole("button", { name: "Share my list" }).click();
  const shareSheet = page.getByRole("dialog", { name: "Share my list" });
  await expect(shareSheet).toHaveClass(/sheet--share/);
  await expect(shareSheet.getByRole("button", { name: /Create link|New link/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shareSheet).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Share my list" })).toBeFocused();

  // --- C. /add keeps the bar, Add is current, current-tab tap is a no-op.
  await bar.getByRole("button", { name: "Add item" }).click();
  await expect(page).toHaveURL(`${BASE}/add`);
  const addBar = page.getByRole("navigation", { name: "Primary actions" });
  await expect(addBar.getByRole("button", { name: "Add item" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(addBar.getByRole("button", { name: "Settings" })).not.toHaveAttribute(
    "aria-current",
  );
  // Tapping the CURRENT destination must not navigate: a same-URL navigate()
  // would push a duplicate history entry and scroll a half-filled form to its
  // top (router.ts). Assert both signals, polled — the suite has no timeouts.
  const historyBefore = await page.evaluate(() => history.length);
  await page.evaluate(() => window.scrollTo(0, 200));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await addBar.getByRole("button", { name: "Add item" }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 1_500 }).toBe(
    scrollBefore,
  );
  expect(await page.evaluate(() => history.length), "duplicate history entry").toBe(historyBefore);
  await expect(page).toHaveURL(`${BASE}/add`);

  // --- D. Item + edit pages keep the bar; nothing is "current" there. --
  // They are content routes, not bar destinations — painting Add there is the
  // lie #73's D2 rejected.
  for (const path of [`/items/${probe.id}`, `/items/${probe.id}/edit`]) {
    await page.goto(`${BASE}${path}`);
    const routeBar = page.getByRole("navigation", { name: "Primary actions" });
    await expect(routeBar, `no bar on ${path}`).toBeVisible();
    for (const name of ["Add item", "Share my list", "Settings"]) {
      await expect(routeBar.getByRole("button", { name })).not.toHaveAttribute("aria-current");
    }
  }

  // --- E. No bar on the anonymous share view (D4) or on /login (D2). ---
  const created = await page.request.post(`${BASE}/api/share`);
  expect(created.status()).toBe(201);
  const { token } = (await created.json()) as { token: string };
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const anonPage = await anon.newPage();
    await anonPage.goto(`${BASE}/share/${token}`);
    await expect(anonPage.getByRole("heading", { name: /wishlist/ })).toBeVisible();
    await expect(anonPage.locator(".action-bar"), "bar on the anon share view").toHaveCount(0);

    await anonPage.goto(`${BASE}/login`); // the anon context has no session
    await expect(anonPage.locator(".auth-card")).toBeVisible();
    await expect(anonPage.locator(".action-bar"), "bar on /login").toHaveCount(0);
  } finally {
    await anon.close();
  }

  // --- F. Desktop untouched: no bar on a non-feed route either. --------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".action-bar")).toHaveCount(0);

  // Board hygiene: leave no live share link for later tests.
  const revoke = await page.request.delete(`${BASE}/api/share`);
  expect([200, 204]).toContain(revoke.status());
});

test("24: item row and reset row share their slot at every width (#97)", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Width probe", priceCents: "12.34", currency: "GBP" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };

  /** Every control in the item form's title/price/currency row, plus the row.
   *  #97's standard: a control's width comes from the row (its slot), never
   *  from an engine-intrinsic input/select metric. */
  const itemRow = () =>
    page.evaluate(() => {
      const row = document.getElementById("item-title")?.closest(".field-row");
      if (!row) throw new Error("item field-row missing");
      const rr = row.getBoundingClientRect();
      const boxes: Record<string, { width: number; top: number; bottom: number; right: number }> = {};
      for (const el of Array.from(row.querySelectorAll("input, select"))) {
        const r = el.getBoundingClientRect();
        boxes[el.id] = { width: r.width, top: r.top, bottom: r.bottom, right: r.right };
      }
      return { rowWidth: rr.width, rowRight: rr.right, boxes };
    });

  for (const width of [360, 390, 430, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/items/${item.id}/edit`);
    await expect(page.getByLabel("Title")).toBeVisible();

    const { rowWidth, boxes } = await itemRow();
    const title = boxes["item-title"];
    const price = boxes["item-price"];
    const currency = boxes["item-currency"];
    // Price and Currency are siblings, so they are equal at every width — the
    // mobile grid's two halves, the desktop row's two compact slots.
    expect(Math.abs(price.width - currency.width), `price vs currency at ${width}px`)
      .toBeLessThanOrEqual(1);
    if (width <= 430) {
      // Mobile: the mobile grid stacks Title across the full row.
      expect(Math.abs(title.width - rowWidth), `title spans the row at ${width}px`)
        .toBeLessThanOrEqual(1);
    } else {
      // Desktop: Title keeps the dominant share (2:1:1). On main this pair was
      // 231px vs 86px — two engine metrics, neither derived from the row.
      expect(title.width, `title dominant at ${width}px`).toBeGreaterThan(price.width);
      expect(price.width, `price is slot-derived at ${width}px`).toBeGreaterThan(140);
      expect(price.width, `price is slot-derived at ${width}px`).toBeLessThan(300);
    }
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `document overflow at ${width}px`).toBe(false);
    expect(probe.offenders, `true escapes at ${width}px`).toEqual([]);
  }

  // 4-field case (Other-currency open) at the desktop reading column: three
  // equal compact slots, Title still dominant. On main the engine metrics made
  // this 231/86/231 and crushed Title to 135px.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/items/${item.id}/edit`);
  await page.getByLabel("Currency").selectOption("Other");
  await expect(page.locator("#item-other-currency")).toBeVisible();
  const wide = await itemRow();
  const other = wide.boxes["item-other-currency"];
  expect(Math.abs(other.width - wide.boxes["item-price"].width), "other-currency vs price at 1280px")
    .toBeLessThanOrEqual(1);
  expect(Math.abs(other.width - wide.boxes["item-currency"].width), "other-currency vs currency at 1280px")
    .toBeLessThanOrEqual(1);
  expect(wide.boxes["item-title"].width, "title dominant with 4 fields at 1280px")
    .toBeGreaterThan(other.width);

  // Same page, resized: the SPA keeps Other selected, and the 4th field spans
  // the full row instead of orphaning in a half-cell.
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await itemRow();
  expect(narrow.boxes["item-other-currency"], "other-currency present at 390px").toBeTruthy();
  expect(
    Math.abs(narrow.boxes["item-other-currency"].width - narrow.rowWidth),
    "other-currency spans the row at 390px",
  ).toBeLessThanOrEqual(1);

  /** The admin reset-password row: the input plus its two buttons. */
  const resetRow = () =>
    page.evaluate(() => {
      const input = document.getElementById("reset-password");
      const row = input?.closest(".reset-form-row");
      if (!input || !row) throw new Error("reset row missing");
      const ir = input.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const buttons = Array.from(row.querySelectorAll("button")).map((b) => {
        const r = b.getBoundingClientRect();
        return { width: r.width, top: r.top };
      });
      return {
        rowWidth: rr.width,
        rowRight: rr.right,
        input: { width: ir.width, top: ir.top, bottom: ir.bottom, right: ir.right },
        buttons,
      };
    });

  const openReset = async (width: number) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/settings`);
    await page.getByRole("button", { name: "Reset password" }).first().click();
    await expect(page.locator("#reset-password")).toBeVisible();
  };
  const closeReset = () =>
    page.locator(".reset-form").getByRole("button", { name: "Cancel" }).click();

  // Phone rhythm: the input owns its line and the buttons split the next one.
  // At 430 on main the row squeezed the input to 183px and wrapped Cancel alone.
  for (const width of [360, 390, 430]) {
    await openReset(width);
    const m = await resetRow();
    expect(Math.abs(m.input.width - m.rowWidth), `reset input spans its line at ${width}px`)
      .toBeLessThanOrEqual(1);
    expect(m.input.bottom, `input sits above the buttons at ${width}px`)
      .toBeLessThanOrEqual(m.buttons[0].top);
    if (width >= 390) {
      // nowrap clamps "Set password" at 360, so equality is asserted from 390 up.
      expect(Math.abs(m.buttons[0].width - m.buttons[1].width), `reset buttons equal at ${width}px`)
        .toBeLessThanOrEqual(1);
    } else {
      expect(m.buttons[0].top, "reset buttons share one line at 360px").toBe(m.buttons[1].top);
      expect(m.buttons[0].width + m.buttons[1].width, "reset buttons fill the line at 360px")
        .toBeGreaterThan(m.input.width * 0.9);
    }
    const probe = await horizontalEscapes(page);
    expect(probe.docOverflow, `document overflow at ${width}px (reset row)`).toBe(false);
    await closeReset();
  }

  // Desktop keeps the shipped rhythm: input grows, both buttons on its line.
  for (const width of [768, 1024, 1280]) {
    await openReset(width);
    const m = await resetRow();
    expect(m.input.right, `reset input leaves room for the buttons at ${width}px`)
      .toBeLessThan(m.rowRight - 1);
    for (const button of m.buttons) {
      expect(Math.abs(button.top - m.input.top), `button centred on the input line at ${width}px`)
        .toBeLessThan(3);
    }
    await closeReset();
  }

  const removed = await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
  expect([200, 204]).toContain(removed.status());
});

test("25: row insets content --row-pad-x (12px) at every width, all surfaces (#87)", async ({ page, browser }) => {
  const seeded: string[] = [];
  for (const spec of [
    { title: "Inset probe A", priceCents: "12.34", currency: "GBP" },
    { title: "Inset probe B", priceCents: "56.78", currency: "GBP" },
  ]) {
    const res = await page.request.post(`${BASE}/api/wishlist/items`, { data: spec });
    expect(res.status()).toBe(201);
    seeded.push(((await res.json()) as { id: string }).id);
  }

  /** Resolved row geometry: content-box inset (left) + actions trigger
   *  inset (right) + the 44px touch floor. The grid's thumb column is flush
   *  with the content box, so grid.left - row.left === padding-left === the
   *  thumbnail's inset whenever a thumb renders. */
  const rowGeometry = (row: Locator) =>
    row.evaluate((el) => {
      const cs = getComputedStyle(el);
      const rowRect = el.getBoundingClientRect();
      const grid = el.querySelector<HTMLElement>(".product-row-grid");
      if (!grid) throw new Error("product-row-grid missing");
      const trigger = el.querySelector<HTMLElement>(".product-row-actions .icon-btn");
      const triggerRect = trigger?.getBoundingClientRect();
      return {
        padLeft: parseFloat(cs.paddingLeft),
        padRight: parseFloat(cs.paddingRight),
        contentInset: grid.getBoundingClientRect().left - rowRect.left,
        actionsInset: triggerRect ? rowRect.right - triggerRect.right : null,
        triggerW: triggerRect?.width ?? null,
        triggerH: triggerRect?.height ?? null,
      };
    });

  // --- Owner feed: the full walk, five widths × both schemes. ---
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.reload();
      const row = page.locator(`.item-card[data-item-id="${seeded[0]}"]`);
      await expect(row).toBeVisible();
      const m = await rowGeometry(row);
      expect(m.padLeft, `pad-left @${width}/${scheme}`).toBe(12);
      expect(m.padRight, `pad-right @${width}/${scheme}`).toBe(12);
      expect(m.contentInset, `grid starts at padding edge @${width}/${scheme}`).toBe(12);
      expect(m.actionsInset, `⋮ trigger inset from row right @${width}/${scheme}`).toBe(12);
      expect(m.triggerW, `⋮ trigger width @${width}/${scheme}`).toBeGreaterThanOrEqual(44);
      expect(m.triggerH, `⋮ trigger height @${width}/${scheme}`).toBeGreaterThanOrEqual(44);
      const probe = await horizontalEscapes(page);
      expect(probe.docOverflow, `doc overflow @${width}/${scheme}`).toBe(false);
      expect(probe.offenders, `true escapes @${width}/${scheme}`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });

  // --- Reorder mode: same row, handle column added — inset unchanged. ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await expect(page.locator(".item-card.is-reordering").first()).toBeVisible();
  const reordering = page.locator(`.item-card.is-reordering[data-item-id="${seeded[0]}"]`);
  await expect(reordering).toBeVisible();
  const rm = await rowGeometry(reordering);
  expect(rm.padLeft, "reordering row keeps 12px").toBe(12);
  expect(rm.padRight, "reordering row right inset").toBe(12);
  await page.getByRole("button", { name: "Done", exact: true }).click();

  // --- Anonymous share view: same .item-card class, inherited. ---
  const shared = await page.request.post(`${BASE}/api/share`);
  expect(shared.status()).toBe(201);
  const shareToken = ((await shared.json()) as { token: string }).token;
  const anon = await browser.newContext({ viewport: { width: 360, height: 844 } });
  try {
    for (const width of [360, 1280]) {
      const anonPage = await anon.newPage();
      await anonPage.setViewportSize({ width, height: 844 });
      await anonPage.goto(`${BASE}/share/${shareToken}`);
      await expect(anonPage.locator(`.item-card[data-item-id="${seeded[0]}"]`)).toBeVisible();
      const m = await anonPage.evaluate((id: string) => {
        const row = document.querySelector<HTMLElement>(`.item-card[data-item-id="${id}"]`);
        if (!row) throw new Error("share row missing");
        const cs = getComputedStyle(row);
        return { padLeft: parseFloat(cs.paddingLeft), padRight: parseFloat(cs.paddingRight) };
      }, seeded[0]);
      expect(m.padLeft, `share pad-left @${width}`).toBe(12);
      expect(m.padRight, `share pad-right @${width}`).toBe(12);
      const probe = await horizontalEscapes(anonPage);
      expect(probe.docOverflow, `share doc overflow @${width}`).toBe(false);
      expect(probe.offenders, `share escapes @${width}`).toEqual([]);
      await anonPage.close();
    }
  } finally {
    await anon.close();
  }
  const revoked = await page.request.delete(`${BASE}/api/share`);
  expect([200, 204]).toContain(revoked.status());

  // Hand the board back clean (test 15 expects no active share link).
  for (const id of seeded) {
    const removed = await page.request.delete(`${BASE}/api/wishlist/items/${id}`);
    expect([200, 204]).toContain(removed.status());
  }
});

test("26: row overflow menu floats above the list at desktop widths (#89)", async ({ page, browser }) => {
  const seeded: string[] = [];
  for (const spec of [
    { title: "Popover probe A", priceCents: "19.99", currency: "GBP" },
    { title: "Popover probe B", priceCents: "24.50", currency: "GBP" },
  ]) {
    const res = await page.request.post(`${BASE}/api/wishlist/items`, { data: spec });
    expect(res.status()).toBe(201);
    seeded.push(((await res.json()) as { id: string }).id);
  }
  await page.reload();

  // The open row needs a FOLLOWING sibling row: that is where the pre-fix
  // "steal band" came from (the next row's z-1 action cluster ties on z with
  // the open row's and wins on DOM order, painting over the popover's right
  // edge). Row 0 of the feed always has one.
  expect(await page.locator(".item-card").count()).toBeGreaterThanOrEqual(2);
  const openRowId = await page.locator(".item-card").first().getAttribute("data-item-id");
  expect(openRowId).toBeTruthy();

  const triggerOf = (p: Page, rowId: string) =>
    p.locator(`.item-card[data-item-id="${rowId}"]`).getByRole("button", { name: "More actions" });
  const popoverOf = (p: Page, rowId: string) =>
    p.locator(`.item-card[data-item-id="${rowId}"] .overflow-popover`);

  /** Hit-test sweep: every menu item is sampled with `elementFromPoint` at
   *  5/25/50/75/95% of its width, mid-height. This is the only probe that sees
   *  BOTH defects of #89 — the ancestor clip (an `overflow: hidden` row slices
   *  the popover, so the point belongs to whatever paints there instead) and
   *  the paint-order steal (a following row's action cluster covering the
   *  popover's right band). Playwright's `click()` sees neither: it scrolls
   *  `overflow: hidden` ancestors into view first, so click-based tests passed
   *  on the broken build. */
  const sweepPopover = (p: Page, rowId: string) =>
    p.evaluate((id: string) => {
      const row = document.querySelector<HTMLElement>(`.item-card[data-item-id="${id}"]`);
      if (!row) throw new Error("row missing");
      const popover = row.querySelector<HTMLElement>(".overflow-popover");
      if (!popover) throw new Error("desktop popover missing");
      const items = Array.from(popover.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      const describe = (el: HTMLElement | null) =>
        el ? `${el.tagName}.${typeof el.className === "string" ? el.className : el.getAttribute("class")}` : "none";
      const bad: string[] = [];
      for (const item of items) {
        const r = item.getBoundingClientRect();
        for (const frac of [0.05, 0.25, 0.5, 0.75, 0.95]) {
          const hit = document.elementFromPoint(
            r.left + r.width * frac,
            r.top + r.height / 2,
          ) as HTMLElement | null;
          if (!hit || (hit !== item && !item.contains(hit))) {
            bad.push(`"${item.textContent?.trim()}" @${frac}: ${describe(hit)}`);
          }
        }
      }
      const rowBox = row.getBoundingClientRect();
      const popoverBox = popover.getBoundingClientRect();
      const doc = document.documentElement;
      return {
        itemCount: items.length,
        bad,
        overflow: getComputedStyle(row).overflow,
        extendsBelowRow: Math.round(popoverBox.bottom - rowBox.bottom),
        docOverflow: doc.scrollWidth > doc.clientWidth,
      };
    }, rowId);

  // --- Owner feed: the popover must survive a following sibling row. ---
  for (const width of [768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await triggerOf(page, openRowId!).click();
    const popover = popoverOf(page, openRowId!);
    await expect(popover).toBeVisible();
    const m = await sweepPopover(page, openRowId!);
    expect(m.itemCount, `menu rows @${width}`).toBeGreaterThanOrEqual(4);
    expect(m.bad, `hit-test escapes @${width}`).toEqual([]);
    expect(m.overflow, `computed row overflow @${width}`).toBe("visible");
    expect(m.extendsBelowRow, `popover past the row bottom @${width}`).toBeGreaterThan(16);
    expect(m.docOverflow, `doc overflow @${width}`).toBe(false);
    // Keyboard contract untouched: Escape closes, focus returns to the trigger.
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(triggerOf(page, openRowId!)).toBeFocused();
  }

  // --- Anonymous share view: same row markup, same defect, no owner around. ---
  const shared = await page.request.post(`${BASE}/api/share`);
  expect(shared.status()).toBe(201);
  const shareToken = ((await shared.json()) as { token: string }).token;
  const anon = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  try {
    const anonPage = await anon.newPage();
    await anonPage.goto(`${BASE}/share/${shareToken}`);
    const anonRowId = await anonPage.locator(".item-card").first().getAttribute("data-item-id");
    expect(anonRowId, "share row carries its id").toBeTruthy();
    await triggerOf(anonPage, anonRowId!).click();
    const anonPopover = popoverOf(anonPage, anonRowId!);
    await expect(anonPopover).toBeVisible();
    const m = await sweepPopover(anonPage, anonRowId!);
    expect(m.itemCount, "anonymous menu rows").toBeGreaterThanOrEqual(1);
    expect(m.bad, "anonymous hit-test escapes").toEqual([]);
    expect(m.overflow, "anonymous computed row overflow").toBe("visible");
    expect(m.docOverflow, "anonymous doc overflow").toBe(false);
  } finally {
    await anon.close();
  }
  const revoked = await page.request.delete(`${BASE}/api/share`);
  expect([200, 204]).toContain(revoked.status());

  // --- Mobile sanity: <640px still portals the bottom sheet, not a popover. ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await triggerOf(page, seeded[0]).click();
  const sheet = page.getByRole("dialog", { name: "More actions" });
  await expect(sheet).toBeVisible();
  // The desktop branch's class is absent; the one menu lives inside the sheet.
  await expect(page.locator(".overflow-popover")).toHaveCount(0);
  await expect(sheet.locator('[role="menu"]')).toHaveCount(1);
  await expect(sheet.getByRole("menuitem", { name: "Cancel" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Hand the board back clean (test 15 expects no active share link).
  for (const id of seeded) {
    const removed = await page.request.delete(`${BASE}/api/wishlist/items/${id}`);
    expect([200, 204]).toContain(removed.status());
  }
});
