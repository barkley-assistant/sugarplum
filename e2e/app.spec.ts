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
  // App shell appears once the session is established (heading = switcher).
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
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
  // Scope the price assertion to the card so other rows cannot match it.
  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "Manual mug" }),
  });
  await expect(card.locator(".price")).toHaveText("£12.50");
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
  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Title").fill("Manual mug v2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Manual mug v2" })).toBeVisible();
  await page.reload();
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

test("4c: row opens the detail sheet; overflow does not", async ({ page }) => {
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
  const list = (await (await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)).json()) as Array<{ id: string; title: string; url: string | null }>;
  const probe = list.find((item) => item.title === "History probe");
  expect(probe).toBeTruthy();

  const card = page.locator(".item-card", {
    has: page.getByRole("heading", { name: "History probe" }),
  });
  const rowButton = card.getByRole("button", { name: "History probe" });
  await rowButton.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "History probe" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".detail-title")).toHaveText("History probe");
  await expect(sheet.getByText("Lowest £10.00")).toBeVisible();
  await expect(sheet.getByText("£2.50 since added")).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Open product" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Edit item" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(rowButton).toBeFocused();

  await card.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu", { name: "More actions" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "History probe" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  for (const selector of [
    ".drag-handle",
    ".item-link-row",
    ".tags",
    ".item-notes",
    ".price-trend",
    ".hint-block",
    ".item-cheaper",
    ".item-image-source",
  ]) {
    await expect(card.locator(selector)).toHaveCount(0);
  }
});

test("4d: detail actions and stacked edit/delete flows stay in sync", async ({ page }) => {
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
  await card.getByRole("button", { name: "Detail probe" }).click();
  const sheet = page.getByRole("dialog", { name: "Detail probe" });
  await expect(sheet.locator(".detail-site")).toHaveText("example.com");
  await expect(sheet.locator(".detail-price")).toHaveText("£24.99");
  await expect(sheet.getByText("Lowest £24.99")).toBeVisible();
  const productLink = sheet.getByRole("link", { name: "Open product" });
  await expect(productLink).toHaveAttribute("href", "https://example.com/detail-probe");
  await expect(productLink).toHaveAttribute("target", "_blank");

  await sheet.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  // Re-check/retry is URL- and fetch-state-gated; the background fetch may
  // resolve before this menu opens, so either valid state is accepted.
  const refreshEntry = menu.getByRole("menuitem", { name: /Re-check price|Retry fetch/ });
  expect(await refreshEntry.count()).toBeLessThanOrEqual(1);
  await expect(menu.getByRole("menuitem", { name: "Copy product link" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Reset purchased mark" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await sheet.getByRole("button", { name: "Edit item" }).click();
  const editSheet = page.getByRole("dialog", { name: "Edit" });
  await expect(editSheet).toBeVisible();
  await editSheet.getByLabel("Title").fill("Detail probe updated");
  await editSheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.locator(".detail-title")).toHaveText("Detail probe updated");
  await expect(card.getByRole("heading", { name: "Detail probe updated" })).toBeVisible();

  // Re-open edit to exercise the stacked Escape rule independently from the
  // existing save flow, which closes the edit sheet after a successful save.
  await sheet.getByRole("button", { name: "Edit item" }).click();
  const secondEditSheet = page.getByRole("dialog", { name: "Edit" });
  await page.keyboard.press("Escape");
  await expect(secondEditSheet).toHaveCount(0);
  await expect(sheet).toBeVisible();

  const added = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date());
  await expect(sheet).toContainText(`Added ${added}`);

  await sheet.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(`.item-card[data-item-id="${item.id}"]`)).toHaveCount(0);
});

test("4e: detail switches between bottom sheet and desktop drawer without overflow", async ({ page }) => {
  const card = page.locator(".item-card", { has: page.getByRole("heading", { name: "History probe" }) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await card.getByRole("button", { name: "History probe" }).click();
  const drawer = page.getByRole("dialog", { name: "History probe" });
  await expect(drawer).toHaveClass(/detail-drawer/);
  const drawerWidth = await drawer.boundingBox();
  expect(drawerWidth?.width).toBeGreaterThanOrEqual(480);
  expect(drawerWidth?.width).toBeLessThanOrEqual(560);
  await expect(drawer.locator(".detail-handle")).not.toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByRole("button", { name: "History probe" }).click();
  const sheet = page.getByRole("dialog", { name: "History probe" });
  await expect(sheet).toHaveClass(/sheet--detail/);
  await expect(sheet.locator(".detail-handle")).toBeVisible();
  await expect(sheet).not.toHaveClass(/detail-drawer/);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, `document overflow at ${width}px`).toBe(false);
  }
  await page.keyboard.press("Escape");
});

test("4f: detail surface keeps focus contained and labels secondary actions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const card = page.locator(".item-card", { has: page.getByRole("heading", { name: "History probe" }) });
  const rowButton = card.getByRole("button", { name: "History probe" });
  await rowButton.click();
  const sheet = page.getByRole("dialog", { name: "History probe" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "More actions" })).toBeVisible();

  const focusableSelector = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusableCount = await sheet.locator(focusableSelector).count();
  expect(focusableCount).toBeGreaterThan(0);
  for (let i = 0; i < focusableCount + 2; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  await sheet.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu.locator(".overflow-separator")).toHaveCount(2);
  await expect(menu.locator(".menu-item-danger")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
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
  await expect(page.locator(".drag-handle")).toHaveCount(0);
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

test("9: no horizontal overflow at 360/390/430/1280px", async ({ page }) => {
  // Seed one item so the populated feed is exercised in every viewport.
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Overflow probe" },
  });
  expect(seeded.status()).toBe(201);

  for (const width of [360, 390, 430, 1280]) {
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
  expect(bg).toBe("rgb(18, 16, 23)"); // --bg dark: #121017
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

test("14: share-target GET prefills the add sheet through the login hop", async ({ page, context }) => {
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

  // After sign-in we land back on /add with the sheet open and the title
  // + link prefilled. Submit and confirm the card renders.
  const sheet = page.getByRole("dialog", { name: "Add item" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Title")).toHaveValue("Shared mug");
  await expect(sheet.getByLabel("Link")).toHaveValue("https://example.com/shared");
  await sheet.getByRole("button", { name: "Add item" }).click();
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
    data: { title: "Gift for the admin" },
  });
  expect(seeded.status()).toBe(201);
  await page.reload();

  // Owner (admin, logged in by beforeEach) mints a link for their own list.
  await page.getByRole("button", { name: "Share my list" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const linkInput = page.locator(".share-link-row input");
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
    await expect(page.getByRole("button", { name: "Mark as purchased" })).toHaveCount(0);

    // Revocation: back to the app, reopen the panel at 375px (mobile-first:
    // the link row must not overflow).
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: "Share my list" }).click();
    await expect(page.locator(".share-link-row input")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Revoke link" }).click();
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