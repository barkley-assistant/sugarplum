import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
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

/** #102: one external product link. Every one of them must be a plain anchor
 *  with `target="_blank"`, an explicit `noopener noreferrer`, and a per-element
 *  `no-referrer` policy — the mechanism through which the OS hands the URL to
 *  the system default browser in a NEW browsing context. */
async function expectHandoffAnchor(link: Locator, label: string): Promise<void> {
  await expect(link, label).toBeVisible();
  await expect(link, label).toHaveAttribute("target", "_blank");
  const rel = ((await link.getAttribute("rel")) ?? "").split(/\s+/);
  expect(rel, `${label}: rel`).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  expect(await link.getAttribute("referrerpolicy"), `${label}: referrerpolicy`).toBe("no-referrer");
  // A real anchor (not a button/window.open stand-in): href present, http(s).
  expect(
    await link.evaluate(
      (el) => el.tagName === "A" && /^https?:\/\//.test(el.getAttribute("href") ?? ""),
    ),
    `${label}: plain external anchor`,
  ).toBe(true);
}

/** #102: click an external anchor and prove it LEFT the SPA. A new browsing
 *  context opens and the SPA document neither navigates nor re-loads. Where the
 *  popup finally lands is the browser's business (the e2e host may have no
 *  route to the merchant), so what is asserted is the handoff contract. */
async function expectHandoffClick(page: Page, link: Locator, context: string): Promise<void> {
  const urlBefore = page.url();
  const loadsBefore = await loads(page);
  const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await popup.close();
  expect(page.url(), `${context}: the SPA document stayed put`).toBe(urlBefore);
  expect(await loads(page), `${context}: no extra document load`).toBe(loadsBefore);
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

/** #131 (WCAG 1.4.11, non-text): the ratio of a control's own boundary
 *  (borderTopColor) against the first opaque background behind it. Text
 *  contrast is `contrast()` above; this is the field/control-outline probe —
 *  3:1 is the minimum for a boundary that has to be perceivable. */
async function boundaryContrast(locator: Locator): Promise<number> {
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
    const border = parse(getComputedStyle(el).borderTopColor);
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
    const lb = lum(border);
    const lg = lum(bg);
    return (Math.max(lb, lg) + 0.05) / (Math.min(lb, lg) + 0.05);
  });
}

/** Index of the last card fully inside the viewport, kept clear of the topbar
 *  and of the bottom edge (where the drag's auto-scroll would engage). The
 *  suite's feed is long by the time these run: the LAST row is often below the
 *  fold, and a pointer event aimed off-viewport never reaches its handle. */
async function lastVisibleIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".item-card"));
    let index = 1;
    rows.forEach((row, i) => {
      const rect = row.getBoundingClientRect();
      if (rect.top > 64 && rect.bottom < window.innerHeight - 96) index = i;
    });
    return index;
  });
}

/** Lift card `index` by its handle and move the pointer just past the midpoint
 *  of the row above it, so the drop moves it exactly one slot. Returns the
 *  pointer position, for the release. */
async function liftAndDragUpOne(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(".item-list .drag-handle").nth(index).boundingBox();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const crossing = await page.evaluate((i: number) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".item-card"));
    const above = rows[i - 1].getBoundingClientRect();
    return above.top + above.height / 2;
  }, index);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, crossing - 2, { steps: 6 });
  return { x, y };
}

/** Card ids in DOM order. */
const cardIds = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".item-card")).map(
      (el) => el.dataset.itemId as string,
    ),
  );

/** `ids` with the entry at `index` moved one slot up — what a one-crossing drag
 *  produces. */
function movedUpOne(ids: string[], index: number): string[] {
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(index - 1, 0, moved);
  return next;
}

/** #119: one feed row's thumb-frame geometry. Every row must reserve exactly
 *  one frame — the cover-fit image, or the neutral well when the item has no
 *  image — and the title column must start at the same x on every row, so a
 *  no-image row cannot fall out of line with its neighbours. */
interface RowFrame {
  id: string;
  title: string;
  wellCount: number;
  imgCount: number;
  frameW: number | null;
  frameH: number | null;
  titleX: number;
}

/** Geometry of every `.item-card` in the current list, in DOM order. */
const listFrames = (page: Page): Promise<RowFrame[]> =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".item-list .item-card"));
    return rows.map((el) => {
      const title = el.querySelector<HTMLElement>(".product-row-title");
      if (!title) throw new Error("product-row-title missing");
      const frame = el.querySelector<HTMLElement>(".product-img-fallback, .product-img");
      const rect = frame?.getBoundingClientRect();
      return {
        id: el.dataset.itemId ?? "",
        title: (title.textContent ?? "").trim(),
        wellCount: el.querySelectorAll(".product-img-fallback").length,
        imgCount: el.querySelectorAll(".product-img").length,
        frameW: rect?.width ?? null,
        frameH: rect?.height ?? null,
        titleX: title.getBoundingClientRect().left,
      };
    });
  });

/** #119 acceptance, asserted on EVERY row of the list rather than one pair:
 *  exactly one thumb frame per row, sized to the row token, one shared title x. */
function expectFrameContract(frames: RowFrame[], label: string, thumb: number): void {
  expect(frames.length, `${label}: rows to compare`).toBeGreaterThan(1);
  for (const frame of frames) {
    const tag = `${label}: "${frame.title}"`;
    expect(frame.wellCount + frame.imgCount, `${tag} reserves exactly one thumb frame`).toBe(1);
    expect(Math.abs((frame.frameW ?? 0) - thumb), `${tag} frame width`).toBeLessThanOrEqual(1);
    expect(Math.abs((frame.frameH ?? 0) - thumb), `${tag} frame height`).toBeLessThanOrEqual(1);
  }
  const xs = frames.map((f) => f.titleX);
  expect(Math.max(...xs) - Math.min(...xs), `${label}: titles share one column`).toBeLessThanOrEqual(1);
}

/** #130: one row's kebab-vs-thumb geometry. The kebab must sit at the THUMB's
 *  vertical center — a fixed row anchor — whatever the text height does. */
interface RowAnchor {
  id: string;
  title: string;
  kebabCenterY: number;
  thumbCenterY: number;
  thumbH: number;
  rowH: number;
  titleLines: number;
}

/** Geometry of every `.item-card` row that carries both a thumb frame and a
 *  row action trigger (owner/share rows), in DOM order. */
const rowAnchors = (page: Page): Promise<RowAnchor[]> =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".item-list .item-card"));
    const out: RowAnchor[] = [];
    for (const el of rows) {
      const kebab = el.querySelector<HTMLElement>(".product-row-actions .icon-btn");
      const thumb = el.querySelector<HTMLElement>(".product-img, .product-img-fallback");
      const title = el.querySelector<HTMLElement>(".product-row-title");
      if (!kebab || !thumb || !title) continue;
      const k = kebab.getBoundingClientRect();
      const t = thumb.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
      out.push({
        id: el.dataset.itemId ?? "",
        title: (title.textContent ?? "").trim(),
        kebabCenterY: k.top + k.height / 2,
        thumbCenterY: t.top + t.height / 2,
        thumbH: t.height,
        rowH: el.getBoundingClientRect().height,
        titleLines: Math.round(title.getBoundingClientRect().height / lineHeight),
      });
    }
    return out;
  });

/** #130 acceptance, asserted on EVERY row of the list: the kebab's center is
 *  the thumb's center within a pixel — on one-line rows and on wrapped ones. */
function expectKebabContract(rows: RowAnchor[], label: string): void {
  expect(rows.length, `${label}: rows to measure`).toBeGreaterThan(1);
  for (const row of rows) {
    expect(
      Math.abs(row.kebabCenterY - row.thumbCenterY),
      `${label}: "${row.title}" kebab sits at the thumb's center`,
    ).toBeLessThanOrEqual(1);
  }
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
  // A page is not an overlay: Escape closes nothing, so leave via the
  // guarded Discard (#127) — it renders because the form holds content a
  // submit would send (title, notes, link).
  await page.getByRole("button", { name: "Discard" }).click();
  const discard = page.getByRole("alertdialog");
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
});

test("3c: desktop add page has no sheet chrome and no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Add item" }).first().click();
  await expect(page).toHaveURL(`${BASE}/add`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Add item" })).toBeVisible();
  // #127 (D2): the #121 pair holds as a SET on /add — heading, submit label
  // and document title all read "Add item" (the heading pin alone, #146's,
  // could not see a regression in either of the other two).
  await expect(page.getByRole("button", { name: "Add item", exact: true })).toBeVisible();
  expect(await page.title()).toBe("Add item · sugarplum");
  // #127 (D3): a pristine /add renders NO in-form exit — the persistent
  // chrome's "Back to list" link is the exit; a "Cancel" here would be a
  // second, unguarded way off a page that holds nothing.
  await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to list" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("link", { name: "Back to list" }).click();
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

test("3f: #112 add-page disclosure hover stays neutral and readable, both schemes", async ({ page }) => {
  // The /add disclosure is a quiet hairline row, not a control the user
  // commits to — the global button:hover (0,1,1) used to out-specify its
  // class reset (0,1,0) and paint it a solid plum bar under the --text-2
  // label: 1.16:1 light / 2.66:1 dark, far below AA. Verified collapsed and
  // expanded, in both schemes, plus the keyboard path and the untouched CTA.
  const NONE = "rgba(0, 0, 0, 0)";
  const LABEL = { light: "rgb(109, 40, 217)", dark: "rgb(167, 139, 250)" } as const;
  const HAIRLINE = { light: "rgb(228, 228, 231)", dark: "rgb(42, 36, 56)" } as const;
  const CTA = { light: "rgb(91, 33, 182)", dark: "rgb(109, 78, 209)" } as const;
  const value = (locator: Locator, prop: string) =>
    locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/add`);
    const disclose = page.getByRole("button", { name: "Add details manually" });
    await expect(disclose).toBeVisible();

    // Collapsed + hovered: no bar, the label accent clears AA, and the
    // hairline stays the token instead of the plum-700 the global hover
    // repaints. The row transitions color (--ease, 150ms) — settle first.
    await page.mouse.move(0, 0);
    await disclose.hover();
    await settleEntryAnimation(disclose);
    expect(await value(disclose, "background-color"), `${scheme}: collapsed hover paints no bar`).toBe(NONE);
    expect(await value(disclose, "color"), `${scheme}: collapsed hover label accent`).toBe(LABEL[scheme]);
    expect(await contrast(disclose), `${scheme}: collapsed hover label AA`).toBeGreaterThanOrEqual(4.5);
    expect(await value(disclose, "border-top-color"), `${scheme}: collapsed hairline`).toBe(HAIRLINE[scheme]);

    // Expanded + hovered: the same class rule has to hold with the form open.
    await disclose.click();
    await expect(page.getByLabel("Title")).toBeVisible();
    await page.mouse.move(0, 0);
    await disclose.hover();
    await settleEntryAnimation(disclose);
    expect(await value(disclose, "background-color"), `${scheme}: expanded hover paints no bar`).toBe(NONE);
    expect(await contrast(disclose), `${scheme}: expanded hover label AA`).toBeGreaterThanOrEqual(4.5);
    expect(await value(disclose, "border-top-color"), `${scheme}: expanded hairline`).toBe(HAIRLINE[scheme]);
    // The caret carries no color of its own: it rides the row's.
    expect(await value(page.locator(".add-disclose-caret"), "color"), `${scheme}: caret follows the row`).toBe(LABEL[scheme]);

    // Issue non-negotiable: the primary CTA keeps its violet treatment.
    const submit = page.locator(".add-submit");
    await page.mouse.move(0, 0);
    await submit.hover();
    await settleEntryAnimation(submit);
    expect(await value(submit, "background-color"), `${scheme}: CTA hover intact`).toBe(CTA[scheme]);
  }

  // Keyboard: the disclosure stays a Tab stop. The page heading is focused on
  // mount (usePageFocus), so tabbing walks the content in DOM order — #125 put
  // the list-context row (its switcher trigger) between the heading and the
  // form, which is what makes the disclosure the FOURTH stop instead of the
  // third. Focus alone never paints the bar, and the global focus ring is
  // drawn.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${BASE}/add`);
  await page.mouse.move(0, 0);
  const disclose = page.getByRole("button", { name: "Add details manually" });
  await expect(disclose).toBeVisible();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  await expect(disclose, "the disclosure is the fourth Tab stop").toBeFocused();
  expect(await value(disclose, "background-color"), "keyboard focus paints no bar").toBe(NONE);
  expect(await value(disclose, "outline-style"), "keyboard focus keeps the ring").toBe("solid");
  expect(await value(disclose, "outline-width"), "keyboard focus ring width").toBe("2px");
  expect(await value(disclose, "outline-color"), "keyboard focus ring color").toBe("rgb(124, 58, 237)");
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
  // #130: the drop put the row AT its lowest, so the "Lowest £10.00" line
  // (which repeated the price) collapses into the chip. The delta line below
  // is independent of the verdict and stays.
  await expect(card.locator(".price-meta.price-at-lowest")).toHaveText("At lowest");
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
  await expect(history.locator(".price-graph-caption")).toHaveText("Watching for a trend");
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

  // #126: one primary external action. The "View on <site>" duplicate of the
  // hero CTA is gone from the More information card.
  await expect(itemPage.getByRole("link", { name: /View on/ })).toHaveCount(0);
  await expect(itemPage.getByRole("link", { name: "Open product" })).toHaveCount(1);

  // #126 + #113: the more-card's standing rows are the saved cheaper link
  // (only when one is stored — this seed has none) and the hints
  // disclosure; this seed exercises the hints disclosure.
  await expect(itemPage.getByRole("button", { name: "Check prices elsewhere" })).toBeVisible();

  // #126: the detail rhythm rides #131's --section-gap (16px) — the 7px
  // off-grid literal is gone. Computed-style probe (the house idiom).
  const scrollGap = await itemPage.locator(".detail-scroll").evaluate(
    (el) => getComputedStyle(el).gap,
  );
  expect(scrollGap, "#126 detail section gap").toBe("16px");

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
  await expect(page.getByRole("heading", { name: "Edit item" })).toBeVisible();
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

test("5f: fluid drag — the card tracks the pointer while the DOM order stays frozen (#91)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const title of ["Tracked one", "Tracked two", "Tracked three"]) {
    const res = await page.request.post(`${BASE}/api/wishlist/items`, { data: { title } });
    expect(res.status()).toBe(201);
  }
  await page.reload();
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await expect(page.locator(".item-card.is-reordering").first()).toBeVisible();

  const before = await cardIds(page);
  expect(before.length).toBeGreaterThanOrEqual(3);
  const index = await lastVisibleIndex(page);
  expect(index, "a fully visible row to grab").toBeGreaterThanOrEqual(1);
  const expected = movedUpOne(before, index);

  await liftAndDragUpOne(page, index);

  // Mid-drag: the lifted card has an inline transform (it follows the pointer),
  // the row it passed has shifted, exactly one row is lifted — and the DOM
  // order has NOT moved: that is the frozen-DOM invariant the transform math
  // depends on. The scale is part of the same inline transform (CSS cannot own
  // it: an inline transform replaces a class-level one).
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".item-card.dragging")?.style.transform ?? ""))
    .toContain("translate3d");
  const mid = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".item-card"));
    const lifted = rows.find((r) => r.classList.contains("dragging"));
    return {
      lifted: rows.filter((r) => r.classList.contains("dragging")).length,
      liftedTransform: lifted?.style.transform ?? "",
      shifted: rows.filter((r) => !r.classList.contains("dragging") && r.style.transform !== "").length,
      order: rows.map((r) => r.dataset.itemId),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      listClass: document.querySelector(".item-list")?.className ?? "",
    };
  });
  expect(mid.lifted, "exactly one lifted row").toBe(1);
  expect(mid.liftedTransform).toContain("scale(1.02)");
  expect(mid.shifted, "the rows in between shifted out of the way").toBeGreaterThanOrEqual(1);
  expect(mid.order, "the DOM order does not move mid-drag").toEqual(before);
  expect(mid.overflow, "a scaled row in the gutter overflows nothing").toBe(false);
  expect(mid.listClass).toContain("is-dragging");

  await page.mouse.up();
  await expect.poll(() => cardIds(page)).toEqual(expected);
  // Every inline transform is gone once the order is React's again.
  const settled = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".item-card")).map((r) => r.style.transform),
  );
  expect(settled).toEqual(before.map(() => ""));
  expect(await page.locator(".item-card.dropping").count()).toBe(0);

  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect.poll(() => cardIds(page)).toEqual(expected);
});

test("5g: reduced motion — reorder stays instant and writes no transforms (#91)", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, { data: { title: "Calm probe" } });
  expect(created.status()).toBe(201);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await expect(page.locator(".item-card.is-reordering").first()).toBeVisible();

  const before = await cardIds(page);
  const index = await lastVisibleIndex(page);
  const expected = movedUpOne(before, index);

  await liftAndDragUpOne(page, index);
  await page.waitForTimeout(120);

  // No lift, no translation, no sibling slide: the list re-renders in the new
  // order as the pointer crosses, exactly as it did before #91.
  const mid = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".item-card"));
    return {
      transforms: rows.map((r) => r.style.transform).filter((t) => t !== ""),
      order: rows.map((r) => r.dataset.itemId),
    };
  });
  expect(mid.transforms, "reduced motion writes no inline transform").toEqual([]);
  expect(mid.order, "the crossing re-orders immediately").toEqual(expected);

  await page.mouse.up();
  await expect.poll(() => cardIds(page)).toEqual(expected);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await expect.poll(() => cardIds(page)).toEqual(expected);
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

  // A10: the settings screens and Login are their own surfaces and clear the
  // same bar. The admin user table (the widest content, including its own
  // scroll containment at 360px) lives on /settings/users as of #96 — and is
  // opt-in since #98, so seed it for this probe and hand it back off after.
  const uiOn = await page.request.put(`${BASE}/api/auth/me/settings`, {
    data: { showUserManagement: true },
  });
  expect(uiOn.status()).toBe(200);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const screen of [
      { path: "/settings", heading: "Account & Preferences", table: false },
      { path: "/settings/users", heading: "Users", table: true },
      { path: "/settings/users/new", heading: "New user", table: false },
    ]) {
      await page.goto(`${BASE}${screen.path}`);
      await expect(page.getByRole("heading", { name: screen.heading, level: 2 })).toBeVisible();
      if (screen.table) await expect(page.locator(".admin-table")).toBeVisible();
      const probe = await horizontalEscapes(page);
      expect(probe.docOverflow, `${screen.path} overflow at ${width}px`).toBe(false);
      expect(probe.offenders, `${screen.path} escapes at ${width}px`).toEqual([]);
    }
  }
  const uiOff = await page.request.put(`${BASE}/api/auth/me/settings`, {
    data: { showUserManagement: false },
  });
  expect(uiOff.status()).toBe(200);

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

    // #131: the mobile feed header is composed, not squeezed — the count is
    // one line and the caret ends the title line instead of being pushed onto
    // a line of its own below it. On the pre-#131 composition at 360px the
    // count wrapped to two lines (42px tall) and the caret sat at the START of
    // a line of its own under the title (left edge x=16, right edge 32, while
    // the trigger's right edge was 195.7).
    const desktopViewport = page.viewportSize();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${BASE}/`);
    await expect(page.getByRole("heading", { name: /wishlist/ }).first()).toBeVisible();
    const header = await page.evaluate(() => {
      const rect = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height };
      };
      const count = document.querySelector(".list-heading .count");
      let countLines = 0;
      if (count) {
        const range = document.createRange();
        range.selectNodeContents(count);
        countLines = Array.from(range.getClientRects()).filter((x) => x.height > 4).length;
      }
      return {
        trigger: rect(".list-switcher-trigger"),
        name: rect(".list-switcher-name"),
        caret: rect(".list-switcher-caret"),
        count: rect(".list-heading .count"),
        countLines,
      };
    });
    expect(header.count, `${colorScheme}: the count renders at 360px`).not.toBeNull();
    expect(header.count!.height, `${colorScheme}: count is one line at 360px`).toBeLessThan(30);
    expect(header.countLines, `${colorScheme}: count line boxes at 360px`).toBe(1);
    expect(header.name, `${colorScheme}: the title owns a wrapping span`).not.toBeNull();
    // The caret adds no line of its own: the trigger is exactly as tall as the
    // title text block it wraps.
    expect(header.trigger!.height, `${colorScheme}: trigger height = title block height`)
      .toBeCloseTo(header.name!.height, 0);
    // …and it ends the title line, flush against the trigger's right edge.
    expect(header.caret!.right, `${colorScheme}: caret ends the title line`)
      .toBeCloseTo(header.trigger!.right, 0);
    // …and it rides inside the title's own box (vertically centered on it).
    expect(header.caret!.top, `${colorScheme}: caret top inside the title box`)
      .toBeGreaterThanOrEqual(header.name!.top - 0.5);
    expect(header.caret!.bottom, `${colorScheme}: caret bottom inside the title box`)
      .toBeLessThanOrEqual(header.name!.bottom + 0.5);
    expect(header.caret!.right - header.caret!.left, `${colorScheme}: caret keeps its 16px box`)
      .toBeCloseTo(16, 1);
    await page.setViewportSize(desktopViewport ?? { width: 1280, height: 720 });
    await page.goto(`${BASE}/`);
    await expect(rowButton).toBeVisible();

    // Primary CTA: white on the plum fill in either scheme.
    await page.getByRole("button", { name: "Add item" }).first().click();
    const submit = page.getByRole("button", { name: "Add item" });
    await expect(submit).toBeVisible();
    expect(await contrast(submit), `${colorScheme}: primary button`).toBeGreaterThanOrEqual(4.5);

    // #131: a form field's own boundary must be perceivable — WCAG 1.4.11
    // asks 3:1 for non-text UI boundaries, and the old --border-2 outline
    // measured 1.48:1 on white / 1.49:1 on the dark surface.
    const urlField = page.locator("#item-url");
    await expect(urlField).toBeVisible();
    expect(await boundaryContrast(urlField), `${colorScheme}: field boundary`).toBeGreaterThanOrEqual(3);
    // #127: the pristine add form renders no exit of its own; the header's
    // brand link is the one that was always there, at every width.
    await page.getByRole("link", { name: "Back to list" }).click();
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
    // #90 added the "Lowest £19.99" meta line, so the hero price match must
    // say WHICH "£19.99" it means.
    await expect(sheet.locator(".detail-price")).toHaveText("£19.99");
    await expect(sheet.getByRole("link", { name: /Open product/ })).toHaveCount(0); // no url seeded
    await expect(sheet.getByRole("button", { name: "Edit item" })).toHaveCount(0);
    await expect(sheet.locator(".price-graph")).toHaveCount(0);
    // #90: the "More information" card is gated on the item's own URL — this
    // seed has none, so the card stays absent.
    await expect(sheet.locator(".detail-more-card")).toHaveCount(0);
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

test("15f: anonymous share sheet shows price history and more info, no owner actions", async ({
  page,
  browser,
}) => {
  // Two manual observations (the add price, then a drop) so the graph is
  // drawable, and a URL so the "More information" card + the footer source
  // exist. The PATCH carries the URL: only POST-with-url enqueues a scrape,
  // so the title stays exactly as seeded.
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: {
      title: "Share parity probe",
      notes: "Size large",
      tags: ["Kitchen"],
      priceCents: "19.99",
      currency: "GBP",
    },
  });
  expect(seeded.status()).toBe(201);
  const item = (await seeded.json()) as { id: string };
  const patched = await page.request.patch(`${BASE}/api/wishlist/items/${item.id}`, {
    data: { priceCents: "14.99", url: "https://example.com/probe" },
  });
  expect(patched.status()).toBe(200);

  const created = await page.request.post(`${BASE}/api/share`);
  expect(created.status()).toBe(201);
  const token = ((await created.json()) as { token: string }).token;

  // reduce: the sheet's entry animation must never race the geometry probes.
  const anon = await browser.newContext({ reducedMotion: "reduce" });
  const anonPage = await anon.newPage();
  try {
    await anonPage.goto(`${BASE}/share/${token}`);
    const card = anonPage.locator(".item-card", {
      has: anonPage.getByRole("heading", { name: "Share parity probe" }),
    });
    await card.getByRole("button", { name: "Share parity probe" }).click();
    const sheet = anonPage.getByRole("dialog", { name: "Share parity probe" });
    await expect(sheet).toBeVisible();

    // Price parity with the owner page: the lowest/at-add context and the
    // drawable graph (two observations, one currency).
    await expect(sheet.getByText("Lowest £14.99")).toBeVisible();
    await expect(sheet.getByText("£5.00 since added")).toBeVisible();
    const history = sheet.locator(".detail-history-card");
    await expect(history).toBeVisible();
    await expect(history.getByRole("heading", { name: "Price history" })).toBeVisible();
    await expect(history.locator(".price-graph")).toBeVisible();
    await expect(history.getByRole("group", { name: "Trend window" })).toBeVisible();
    await expect(history.getByRole("button", { name: "30d", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    // #118: the share sheet renders the same component — a drawn chart with no
    // derivable trend is captioned with the watching copy, not the empty-state
    // literal.
    await expect(history.locator(".price-graph-caption")).toHaveText("Watching for a trend");

    // "More information" — the item's OWN link was removed with #126's
    // duplicate-CTA resolution: the hero "Open product" is the single
    // external action; the sheet keeps only the copy affordance here. The live
    // prices-elsewhere search is an owner-only route: never on this surface.
    const more = sheet.locator(".detail-more-card");
    await expect(more).toBeVisible();
    await expect(more.getByRole("link", { name: /View on/ })).toHaveCount(0);
    await expect(sheet.getByRole("link", { name: "Open product" }))
      .toHaveAttribute("href", "https://example.com/probe");
    await expect(more.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(sheet.getByText("Check prices elsewhere")).toHaveCount(0);
    await expect(sheet.getByText("Prices seen elsewhere (unverified)")).toHaveCount(0);

    // Footer: the added date AND the source host.
    const footer = sheet.locator(".detail-footer");
    await expect(footer).toContainText(/^Added /);
    await expect(footer.locator(".detail-footer-source")).toHaveText("example.com");

    // Owner actions stay owner-only.
    for (const name of ["Edit item", "Re-check price", "Reset purchased mark", "More actions"]) {
      await expect(sheet.getByRole("button", { name })).toHaveCount(0);
    }

    // The parity sections must clear the phone width too. The shared overflow
    // probe (test 9) opens an item with NO url, so it never renders this
    // card — this is the only place the "More information" row is measured.
    // A SEPARATE 360px context: resizing the desktop drawer mid-flight would
    // measure the variant swap, not the phone sheet.
    const phone = await browser.newContext({
      viewport: { width: 360, height: 800 },
      reducedMotion: "reduce",
    });
    const phonePage = await phone.newPage();
    try {
      await phonePage.goto(`${BASE}/share/${token}`);
      await phonePage
        .locator(".item-card", { has: phonePage.getByRole("heading", { name: "Share parity probe" }) })
        .getByRole("button", { name: "Share parity probe" })
        .click();
      const phoneSheet = phonePage.getByRole("dialog", { name: "Share parity probe" });
      await expect(phoneSheet).toBeVisible();
      await expect(phoneSheet.locator(".detail-more-card")).toBeVisible();
      await settleEntryAnimation(phoneSheet);
      const probe = await horizontalEscapes(phonePage);
      expect(probe.docOverflow, "share sheet overflow at 360px").toBe(false);
      expect(probe.offenders, "share sheet escapes at 360px").toEqual([]);
    } finally {
      await phone.close();
    }
  } finally {
    await anon.close();
    // Leave no seeded row and no live link behind for later specs.
    await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
    await page.request.delete(`${BASE}/api/share`);
  }
});

/** Local static fixture server: the app's scraper (server-side) fetches it,
 *  so it must listen on 127.0.0.1 — the e2e server runs with
 *  SUGARPLUM_ALLOW_PRIVATE_FETCH=1 (global-setup). */
async function startFixtureServer(): Promise<{ url: string; close: () => void }> {
  const html = await readFile(join(ROOT, "tests", "fixtures", "shopify-local.html"), "utf8");
  // A real 1x1 PNG (valid signature, CRCs and zlib stream), served at the
  // fixture's og:image path. The bytes must be DECODABLE: a truncated header
  // still passes the magic-byte sniff, so the download "succeeds" while the
  // browser fires <img> error and ProductImage swaps in the fallback well —
  // leaving the thumbnail-fit probes with no image to measure. The stored
  // extension follows the response CONTENT TYPE (src/server/images.ts), so the
  // URL's .jpg name is only a label.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture.local");
      if (url.pathname === "/img/trio.jpg") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
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
      await expect(page.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();
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

  // #98: the admin table is opt-in — seed it for the reset-row probe, hand it
  // back off once the geometry work is done (below).
  const uiOn = await page.request.put(`${BASE}/api/auth/me/settings`, {
    data: { showUserManagement: true },
  });
  expect(uiOn.status()).toBe(200);

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
        return { width: r.width, top: r.top, height: r.height };
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
    // #96: the admin table (and its inline reset form) lives on the Users
    // screen; the row geometry contract is unchanged.
    await page.goto(`${BASE}/settings/users`);
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
    // #116: the reset pair (Set password / Cancel) keeps the app-wide 44px
    // touch floor — destructive-family buttons measured 40.6px on main.
    for (const button of m.buttons) {
      expect(button.height, `reset button height at ${width}px`).toBeGreaterThanOrEqual(44);
    }
    await closeReset();
  }

  // #116: the admin row actions (Deactivate / Delete / Reset password) are the
  // same family — 40.6px on main, ≥44px now.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/settings/users`);
  // The table's rows arrive from an async fetch; measuring straight after the
  // goto raced it (empty NodeList → 0 heights). Wait for the row first.
  await expect(page.locator(".admin-actions button").first()).toBeVisible();
  const adminActionHeights = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".admin-actions button")).map(
      (b) => Math.round(b.getBoundingClientRect().height * 10) / 10,
    ),
  );
  expect(adminActionHeights.length, "admin row actions render").toBeGreaterThan(0);
  for (const height of adminActionHeights) {
    expect(height, "admin row action height").toBeGreaterThanOrEqual(44);
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

  const uiOff = await page.request.put(`${BASE}/api/auth/me/settings`, {
    data: { showUserManagement: false },
  });
  expect(uiOff.status()).toBe(200);

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

/** #102: every external product link on every surface is a clean handoff
 *  anchor. The web layer cannot pick the OS browser app; what it CAN guarantee
 *  is that the tap leaves the PWA context for the system instead of being
 *  routed in-app — a plain `target="_blank"` anchor, never intercepted. */
test("27: external product links hand off, never route in-app (#102)", async ({ page, browser }) => {
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: {
      title: "Handoff probe",
      url: "https://example.com/handoff-probe",
      priceCents: "31.50",
      currency: "GBP",
      cheaperUrl: "https://elsewhere.example.com/deal",
    },
  });
  expect(seeded.status()).toBe(201);
  const item = (await seeded.json()) as { id: string };

  try {
    // The document-level policy is the second half of the privacy contract
    // (the per-anchor attribute is the first): no Referer leaks to the merchant.
    const shell = await page.request.get(`${BASE}/items/${item.id}`);
    expect(shell.headers()["referrer-policy"], "document referrer policy").toBe("no-referrer");

    await page.goto(`${BASE}/items/${item.id}`);
    const itemPage = page.locator(".item-page");
    await expect(itemPage.locator(".detail-title")).toHaveText("Handoff probe");

    // --- Owner item page: "Open product". ---
    const open = itemPage.getByRole("link", { name: "Open product" });
    await expect(open).toBeVisible();
    await expectHandoffAnchor(open, "ItemPage / Open product");

    // --- Owner item page: the saved "found it cheaper at" row (#113). It is
    //     the page's second external anchor (#126's single-primary-action rule
    //     is about the hero CTA, and this href is a different destination). ---
    const cheaper = itemPage.getByRole("link", { name: /Found it cheaper at/ });
    await expect(cheaper).toBeVisible();
    await expectHandoffAnchor(cheaper, "ItemPage / found it cheaper");

    // --- Owner item page: a hints candidate (the third surface). The live
    // search is unconfigured in e2e (503 -> the honesty state), and the
    // installed service worker claims the client, so a page.route stub cannot
    // see the owner-only POST. A dedicated SERVICE-WORKER-FREE context lets the
    // stub land, so the RENDERED candidate anchor can be asserted. ---
    const raw = await browser.newContext({ serviceWorkers: "block" });
    try {
      const rawPage = await raw.newPage();
      await login(rawPage, "admin", "admin-password");
      await rawPage.route("**/api/wishlist/items/*/hints", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            hints: [
              {
                priceCents: "2750",
                currency: "GBP",
                sourceUrl: "https://other.example.com/p/1",
                sourceTitle: "Other shop",
              },
            ],
            disabled: false,
          }),
        }),
      );
      await rawPage.goto(`${BASE}/items/${item.id}`);
      const rawItemPage = rawPage.locator(".item-page");
      await rawItemPage.getByRole("button", { name: "Check prices elsewhere" }).click();
      const candidate = rawItemPage.locator(".hints-row a");
      await expect(candidate).toHaveCount(1);
      await expectHandoffAnchor(candidate, "HintsPanel / prices elsewhere");
    } finally {
      await raw.close();
    }

    // --- The handoff itself: a NEW browsing context, and an SPA that stays put.
    await expectHandoffClick(page, open, "item page");

    // --- Anonymous share surface: the same anchor, same contract. ---
    const shared = await page.request.post(`${BASE}/api/share`);
    expect(shared.status()).toBe(201);
    const token = ((await shared.json()) as { token: string }).token;
    const anon = await browser.newContext({ reducedMotion: "reduce" });
    try {
      const anonPage = await anon.newPage();
      await anonPage.goto(`${BASE}/share/${token}`);
      await anonPage
        .locator(".item-card", { has: anonPage.getByRole("heading", { name: "Handoff probe" }) })
        .getByRole("button", { name: "Handoff probe" })
        .click();
      const sheet = anonPage.getByRole("dialog", { name: "Handoff probe" });
      await expect(sheet).toBeVisible();
      const guestOpen = sheet.getByRole("link", { name: "Open product" });
      await expect(guestOpen).toBeVisible();
      await expectHandoffAnchor(guestOpen, "Guest sheet / Open product");
      await expectHandoffClick(anonPage, guestOpen, "guest sheet");
      await expect(sheet, "the guest sheet survives the handoff").toBeVisible();
    } finally {
      await anon.close();
      const revoked = await page.request.delete(`${BASE}/api/share`);
      expect([200, 204]).toContain(revoked.status());
    }
  } finally {
    const removed = await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
    expect([200, 204]).toContain(removed.status());
  }
});

/** #116: how tall a control's hit area really is, measured by walking
 *  elementFromPoint outward from the element's own box. Deliberately
 *  mechanism-agnostic: a grown box (chips, Reorder) and an absolutely
 *  positioned ::after overlay (brand lockup, list switcher) both report their
 *  true target height, so this pins the 44px standard instead of the
 *  technique. Chromium hit-tests an element's own pseudo-element boxes as that
 *  element — the rule both overlays rely on. */
async function hitExtent(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} missing`);
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 60);
    const hits = (y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit === el || !!hit?.closest(sel);
    };
    let top = r.top;
    let bottom = r.bottom;
    for (let i = 0; i < 40 && hits(top - 0.5); i += 1) top -= 0.5;
    for (let i = 0; i < 40 && hits(bottom + 0.5); i += 1) bottom += 0.5;
    return {
      boxHeight: Math.round(r.height * 10) / 10,
      hitHeight: Math.round((bottom - top) * 10) / 10,
      hitTop: top,
      x,
    };
  }, selector);
}

test("28: recurring mobile controls keep the app-wide 44px touch floor (#116)", async ({ page }) => {
  // The filter row only renders when the list has tags (FilterChips returns
  // null otherwise), so seed one tagged item like the other specs do.
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Touch probe", priceCents: "9.99", currency: "GBP", tags: ["Touch probe"] },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };

  try {
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${BASE}/`);
      await expect(page.getByRole("heading", { name: /wishlist/ }).first()).toBeVisible();

      // Tier 1 — grown boxes. On main these measured 36px.
      const chip = page.locator("button.filter-chip").first();
      await expect(chip, `filter chips at ${width}px`).toBeVisible();
      expect(Math.round((await chip.boundingBox())!.height), `chip height at ${width}px`)
        .toBeGreaterThanOrEqual(44);
      const reorder = page.getByRole("button", { name: "Reorder", exact: true });
      expect(Math.round((await reorder.boundingBox())!.height), `Reorder height at ${width}px`)
        .toBeGreaterThanOrEqual(44);

      // Tier 2 — hit overlays. The brand lockup is the only back affordance on
      // the non-feed routes (28px on main) and the switcher trigger's rendered
      // height IS the title's line box (#131 pins that), so both grow their
      // target while their boxes stay put.
      const brand = await hitExtent(page, ".brand");
      expect(brand.boxHeight, `brand stays a 28px lockup at ${width}px`).toBeLessThan(29);
      expect(brand.hitHeight, `brand hit area at ${width}px`).toBeGreaterThanOrEqual(44);
      const trigger = await hitExtent(page, ".list-switcher-trigger");
      expect(trigger.boxHeight, `switcher box is still the title line at ${width}px`).toBeLessThan(34.5);
      expect(trigger.hitHeight, `switcher hit area at ${width}px`).toBeGreaterThanOrEqual(44);

      const probe = await horizontalEscapes(page);
      expect(probe.docOverflow, `document overflow at ${width}px (touch floor)`).toBe(false);
      expect(probe.offenders, `true escapes at ${width}px (touch floor)`).toEqual([]);
    }

    // The overlays are real targets, not just geometry: a tap 3px inside the
    // switcher's padded band opens the popover…
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`);
    const switcher = await hitExtent(page, ".list-switcher-trigger");
    await page.mouse.click(switcher.x, switcher.hitTop + 3);
    await expect(page.locator(".list-switcher-trigger")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");

    // …and on a non-feed route the same tap on the lockup takes the documented
    // Back-to-list route (the lockup is the ONLY back affordance there).
    await page.goto(`${BASE}/settings`);
    const lockup = await hitExtent(page, ".brand");
    expect(lockup.hitHeight, "brand hit area on /settings").toBeGreaterThanOrEqual(44);
    await page.mouse.click(lockup.x, lockup.hitTop + 3);
    await expect(page).toHaveURL(`${BASE}/`);
    // …and the padded band did not grow the bar it lives in (#116 §F risk 1:
    // the topbar is min-height driven, so a grown lockup box WOULD have pushed
    // the bar past the height the cluster routes render). #125 made the header
    // uniform: /add now carries the same right-hand cluster as the feed, so
    // the bar's height is the feed's — what #116 pins here is the LOCKUP, and
    // that the lockup is not what sizes the bar.
    await page.goto(`${BASE}/add`);
    await expect(page.locator(".brand")).toBeVisible();
    const bar = await page.evaluate(() => ({
      topbar: document.querySelector(".topbar")!.getBoundingClientRect().height,
      brand: document.querySelector(".brand")!.getBoundingClientRect().height,
    }));
    await page.goto(`${BASE}/`);
    await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
    const feedBar = await page.evaluate(
      () => document.querySelector(".topbar")!.getBoundingClientRect().height,
    );
    expect(Math.round(bar.topbar), "#125: the add-page topbar matches the feed's").toBe(
      Math.round(feedBar),
    );
    expect(Math.round(bar.brand), "the lockup box is untouched").toBe(28);
  } finally {
    const removed = await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
    expect([200, 204]).toContain(removed.status());
  }
});

/** #114: the issue reported an edit form whose stored currency is not in the
 *  preset list (GBP/USD/EUR) — the select read "Other" with NO code field, so
 *  the stored code was neither visible nor correctable (probe:
 *  `selectValue: "Other"`, `codeVisible: 0`). This spec inverts that probe on
 *  the same shape of item and walks the whole round-trip through the form. */
test("29: edit form — non-preset currency shows Other + seeded code input (#114)", async ({ page }) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "SEK round-trip probe", priceCents: "349.00", currency: "SEK" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };

  try {
    // --- The defect, inverted: the select reads Other AND the code input is
    // visible and pre-filled with the stored code (codeVisible was 0).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/items/${item.id}/edit`);
    await expect(page.getByLabel("Currency")).toHaveValue("Other");
    const code = page.locator("#item-other-currency");
    await expect(code).toBeVisible();
    await expect(code).toHaveValue("SEK");

    // --- Correctability: edit the code, save, reload — the new code sticks.
    await code.fill("NOK");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
    await page.goto(`${BASE}/items/${item.id}/edit`);
    await expect(page.getByLabel("Currency")).toHaveValue("Other");
    await expect(page.locator("#item-other-currency")).toHaveValue("NOK");

    // --- An unchanged save keeps the code (the omit-when-empty seam works).
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
    await page.goto(`${BASE}/items/${item.id}/edit`);
    await expect(page.locator("#item-other-currency")).toHaveValue("NOK");

    // --- Clearing the code input and saving must NOT destroy the stored code:
    // ItemEditPage omits an empty currency from the PATCH, so the server keeps
    // it. A custom code is correctable, never silently clearable.
    await page.locator("#item-other-currency").fill("");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
    await page.goto(`${BASE}/items/${item.id}/edit`);
    await expect(page.locator("#item-other-currency")).toHaveValue("NOK");

    // --- Preset switch hides the input; re-picking Other keeps the slot.
    await page.getByLabel("Currency").selectOption("USD");
    await expect(page.locator("#item-other-currency")).toHaveCount(0);
    await page.getByLabel("Currency").selectOption("Other");
    await expect(page.locator("#item-other-currency")).toBeVisible();
    await expect(page.locator("#item-other-currency")).toHaveValue("NOK");

    // --- The 4-field row MOUNTED BY DATA (test 24 only reaches it by hand)
    // keeps the page inside the viewport at every shipping width.
    for (const width of [360, 390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${BASE}/items/${item.id}/edit`);
      await expect(page.locator("#item-other-currency")).toBeVisible();
      const probe = await horizontalEscapes(page);
      expect(probe.docOverflow, `edit page overflow at ${width}px`).toBe(false);
      expect(probe.offenders, `edit page escapes at ${width}px`).toEqual([]);
    }

    // --- Add flow untouched: no initial item → GBP, no code input until the
    // user picks Other (and then it starts empty, with nothing to seed).
    await page.goto(`${BASE}/add`);
    await page.getByRole("button", { name: "Add details manually" }).click();
    await expect(page.getByLabel("Currency")).toHaveValue("GBP");
    await expect(page.locator("#item-other-currency")).toHaveCount(0);
    await page.getByLabel("Currency").selectOption("Other");
    await expect(page.locator("#item-other-currency")).toBeVisible();
    await expect(page.locator("#item-other-currency")).toHaveValue("");
  } finally {
    const removed = await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
    expect([200, 204]).toContain(removed.status());
  }
  await page.goto(`${BASE}/`);
});

/** #115: every painted state of a text-bearing danger control must clear AA.
 *  At rest the label is --danger (4.83:1 on --surface light / 6.40:1 dark);
 *  hovered it kept --danger over its own --danger-surface tint and fell to
 *  4.41:1 in light — below the 4.5:1 the control's own text needs. The fix
 *  routes the hover label through --danger-strong (5.91:1 light / 9.05:1
 *  dark). This spec pins BOTH states of all four rendered danger affordances
 *  — row-menu delete, share revoke, the destructive confirm, and the admin
 *  users delete — in both schemes. */
const DANGER_REST = { light: "rgb(220, 38, 38)", dark: "rgb(248, 113, 113)" } as const;
const DANGER_HOVER = { light: "rgb(185, 28, 28)", dark: "rgb(252, 165, 165)" } as const;

test("30: danger hover clears AA in both schemes (#115)", async ({ page }) => {
  const itemRes = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Danger probe", priceCents: "12.00", currency: "GBP" },
  });
  expect(itemRes.status()).toBe(201);
  const item = (await itemRes.json()) as { id: string };

  // The share revoke button only renders when a link exists.
  const shareRes = await page.request.post(`${BASE}/api/share`);
  expect(shareRes.status()).toBe(201);

  // A throwaway admin-table row to hover (never confirmed, so never deleted).
  const userRes = await page.request.post(`${BASE}/api/users`, {
    data: {
      username: "danger-probe-guest",
      password: "danger-probe-pass",
      displayName: "Danger probe",
    },
  });
  expect(userRes.status()).toBe(201);
  const guest = (await userRes.json()) as { id: string };

  // #98: the users table is opt-in — turn the pref on for the admin row probe
  // and hand it back off in the finally block.
  const uiOn = await page.request.put(`${BASE}/api/auth/me/settings`, {
    data: { showUserManagement: true },
  });
  expect(uiOn.status()).toBe(200);

  const value = (locator: Locator, prop: string) =>
    locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

  /** Both painted states of one danger affordance: the rest label is --danger,
   *  the hovered label is --danger-strong, and each clears 4.5:1 against the
   *  first opaque background behind it (the control's own hover tint). */
  async function expectDanger(scheme: "light" | "dark", label: string, locator: Locator) {
    await page.mouse.move(0, 0);
    expect(await value(locator, "color"), `${scheme}: ${label} rest label`).toBe(DANGER_REST[scheme]);
    expect(await contrast(locator), `${scheme}: ${label} rest AA`).toBeGreaterThanOrEqual(4.5);
    await locator.hover();
    await settleEntryAnimation(locator);
    expect(await value(locator, "color"), `${scheme}: ${label} hover label`).toBe(DANGER_HOVER[scheme]);
    expect(await contrast(locator), `${scheme}: ${label} hover AA`).toBeGreaterThanOrEqual(4.5);
  }

  try {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${BASE}/`);

      // 1. Feed row overflow menu — the danger "Delete" row (.menu-item-danger).
      const card = page.locator(`.item-card[data-item-id="${item.id}"]`);
      await card.getByRole("button", { name: "More actions" }).click();
      const popover = card.locator(".overflow-popover");
      const menuDelete = popover.getByRole("menuitem", { name: "Delete" });
      await expect(menuDelete).toBeVisible();
      await expectDanger(scheme, "row menu delete", menuDelete);

      // 2. Destructive confirm — selecting the row delete opens the alertdialog
      //    whose confirm button is the other button.danger call site.
      await menuDelete.click();
      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toBeVisible();
      const confirmDelete = confirm.getByRole("button", { name: "Delete" });
      await expectDanger(scheme, "confirm delete", confirmDelete);
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toHaveCount(0);

      // 3. Share popover — the "Revoke link" button (button.danger).
      await page.getByRole("button", { name: "Share my list" }).click();
      const sharePopover = page.getByRole("dialog", { name: "Share my list" });
      const revoke = sharePopover.getByRole("button", { name: "Revoke link" });
      await expect(revoke).toBeVisible();
      await expectDanger(scheme, "share revoke", revoke);
      await page.keyboard.press("Escape");
      await expect(sharePopover).toHaveCount(0);

      // 4. Admin users table — the per-row "Delete" button.
      await page.goto(`${BASE}/settings/users`);
      const adminRow = page.locator(".admin-table tbody tr", { hasText: "danger-probe-guest" });
      const adminDelete = adminRow.getByRole("button", { name: "Delete" });
      await expect(adminDelete).toBeVisible();
      await expectDanger(scheme, "admin delete", adminDelete);
    }
  } finally {
    // Hand the board back clean: no probe item, no live share link (test 15's
    // contract), no probe user in the admin table, user-management pref off.
    const uiOff = await page.request.put(`${BASE}/api/auth/me/settings`, {
      data: { showUserManagement: false },
    });
    expect(uiOff.status()).toBe(200);
    await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
    await page.request.delete(`${BASE}/api/share`);
    await page.request.delete(`${BASE}/api/users/${guest.id}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${BASE}/`);
});

test("31: #118 — empty state keeps the literal, drawn charts never do", async ({ page }) => {
  // Seed via the API the way 4b does: an item whose ONLY history row is one
  // observation (series.length 1 < 2 → drawable false → empty state).
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Caption probe", priceCents: "7.25", currency: "GBP" },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };
  const detail = `${BASE}/items/${item.id}`;
  try {
    await page.goto(detail);
    const history = page.locator(".detail-history-card");
    await expect(history.locator(".price-history-empty")).toHaveText("Not enough history yet");
    // The watching copy and the chart are absent from the empty state.
    await expect(history.locator(".price-graph")).toHaveCount(0);
    await expect(history.locator(".price-graph-caption")).toHaveCount(0);
    await expect(history.getByText("Watching for a trend")).toHaveCount(0);
    // The literal is gone from every drawn-chart caption on this account:
    // the 4b "History probe" item (same-day pair, insufficient trend).
    const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
    const list = (await (await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)).json()) as Array<{ id: string; title: string }>;
    const probe = list.find((entry) => entry.title === "History probe");
    expect(probe).toBeTruthy();
    await page.goto(`${BASE}/items/${probe!.id}`);
    const drawn = page.locator(".detail-history-card");
    await expect(drawn.locator(".price-graph")).toBeVisible();
    await expect(drawn.locator(".price-graph-caption")).toHaveText("Watching for a trend");
    await expect(drawn.getByText("Not enough history yet")).toHaveCount(0);
  } finally {
    await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
  }
});

test("32: #119 — every feed row reserves the thumb frame; titles align down the list", async ({
  page,
  browser,
}) => {
  // A manual add is fetchState "complete" with imagePath null — the exact
  // "no image" shape the issue reports (a scrape that failed, or found none).
  // Two of them so the row-to-row comparison holds even against a list that
  // has nothing else in it (the serial DB carries imaged rows from test 3).
  const seeded: string[] = [];
  for (const spec of [
    { title: "Thumb probe bare", priceCents: "5.00", currency: "GBP" },
    { title: "Thumb probe bare 2", priceCents: "9.00", currency: "GBP" },
  ]) {
    const created = await page.request.post(`${BASE}/api/wishlist/items`, { data: spec });
    expect(created.status()).toBe(201);
    seeded.push(((await created.json()) as { id: string }).id);
  }
  const probe = { id: seeded[0] };

  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const guest = await guestContext.newPage();
  let guestUser: { id: string } | undefined;
  let shareToken: string | undefined;

  try {
    // --- Owner feed: the two breakpoints the thumb TRACK switches between
    //     (72px, 96px at 1024px), both schemes. The track edit is
    //     breakpoint-scoped; the call-site edit is not. ---
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [width, thumb] of [
        [390, 72],
        [1280, 96],
      ] as const) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${BASE}/`);
        await expect(page.locator(`.item-card[data-item-id="${probe.id}"]`)).toBeVisible();
        const frames = await listFrames(page);
        const bare = frames.find((f) => f.id === probe.id);
        expect(bare, `owner @${width}/${scheme}: seeded no-image row`).toBeTruthy();
        expect(bare!.wellCount, `owner @${width}/${scheme}: bare row holds the well`).toBe(1);
        expect(bare!.imgCount, `owner @${width}/${scheme}: bare row has no image`).toBe(0);
        expectFrameContract(frames, `owner feed @${width}/${scheme}`, thumb);
        const overflow = await horizontalEscapes(page);
        expect(overflow.docOverflow, `owner overflow @${width}/${scheme}`).toBe(false);
        expect(overflow.offenders, `owner escapes @${width}/${scheme}`).toEqual([]);
      }
    }
    await page.emulateMedia({ colorScheme: "light" });

    // --- Reorder mode at 390: the handle is a second leading track; the thumb
    //     track behind it must stay fixed. ---
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: "Reorder", exact: true }).click();
    await expect(page.locator(".item-card.is-reordering").first()).toBeVisible();
    const reorderFrames = await listFrames(page);
    expect(reorderFrames.length, "reorder mode lists every row").toBeGreaterThan(1);
    expect(
      reorderFrames.find((f) => f.id === probe.id)?.wellCount,
      "reorder @390: bare row holds the well",
    ).toBe(1);
    await expect(page.locator(".product-row-handle").first()).toBeVisible();
    expectFrameContract(reorderFrames, "owner reorder @390", 72);
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // --- Guest feed: the same ItemCard path with viewerIsOwner false, where
    //     the pending branch never applied — the well branch is the only code
    //     these rows newly execute. ---
    const guestRes = await page.request.post(`${BASE}/api/users`, {
      data: { username: "thumb-guest", password: "guest-pass", displayName: "Thumb Guest" },
    });
    expect(guestRes.status()).toBe(201);
    guestUser = (await guestRes.json()) as { id: string };
    await login(guest, "thumb-guest", "guest-pass");
    await guest.getByRole("button", { name: /wishlist/ }).click();
    await guest.getByRole("menuitemradio", { name: /Admin/ }).click();
    await expect(guest.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
    for (const [width, thumb] of [
      [390, 72],
      [1280, 96],
    ] as const) {
      await guest.setViewportSize({ width, height: 844 });
      await expect(guest.locator(`.item-card[data-item-id="${probe.id}"]`)).toBeVisible();
      const frames = await listFrames(guest);
      expect(
        frames.find((f) => f.id === probe.id)?.wellCount,
        `guest @${width}: bare row holds the well`,
      ).toBe(1);
      expectFrameContract(frames, `guest feed @${width}`, thumb);
      const overflow = await horizontalEscapes(guest);
      expect(overflow.docOverflow, `guest overflow @${width}`).toBe(false);
      expect(overflow.offenders, `guest escapes @${width}`).toEqual([]);
    }

    // --- Anonymous share view: the third ProductRow consumer. ---
    const shared = await page.request.post(`${BASE}/api/share`);
    expect(shared.status()).toBe(201);
    shareToken = ((await shared.json()) as { token: string }).token;
    const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const anonPage = await anon.newPage();
      for (const [width, thumb] of [
        [390, 72],
        [1280, 96],
      ] as const) {
        await anonPage.setViewportSize({ width, height: 844 });
        await anonPage.goto(`${BASE}/share/${shareToken}`);
        await expect(anonPage.locator(`.item-card[data-item-id="${probe.id}"]`)).toBeVisible();
        const frames = await listFrames(anonPage);
        expect(
          frames.find((f) => f.id === probe.id)?.wellCount,
          `share @${width}: bare row holds the well`,
        ).toBe(1);
        expectFrameContract(frames, `share view @${width}`, thumb);
        const overflow = await horizontalEscapes(anonPage);
        expect(overflow.docOverflow, `share overflow @${width}`).toBe(false);
        expect(overflow.offenders, `share escapes @${width}`).toEqual([]);
      }
    } finally {
      await anon.close();
    }
  } finally {
    // Hand the board back to the serial state: no share link, no extra user,
    // no probe row (later files run against the same server + DB).
    if (shareToken) await page.request.delete(`${BASE}/api/share`);
    await guestContext.close();
    if (guestUser) await page.request.delete(`${BASE}/api/users/${guestUser.id}`);
    for (const id of seeded) {
      await page.request.delete(`${BASE}/api/wishlist/items/${id}`);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${BASE}/`);
  }
});

test("33: #130 — price placeholder, Lowest verdict, letterbox, kebab anchor", async ({
  page,
  browser,
}) => {
  // Four rows, seeded through the same API the form uses: no price at all, a
  // price AT its lowest, a price ABOVE its lowest, and one whose title wraps.
  // The ledger's minimum can never exceed the current price, so the only way
  // to build a real "above the lowest" row is add low, then raise.
  const seeded: string[] = [];
  const seed = async (data: Record<string, unknown>): Promise<string> => {
    const created = await page.request.post(`${BASE}/api/wishlist/items`, { data });
    expect(created.status()).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    seeded.push(id);
    return id;
  };

  const noPrice = await seed({ title: "No price probe" });
  const atLowest = await seed({ title: "At lowest probe", priceCents: "20.00", currency: "GBP" });
  const above = await seed({
    title: "Above lowest probe with a product title long enough to wrap",
    priceCents: "25.00",
    currency: "GBP",
  });
  const raised = await page.request.patch(`${BASE}/api/wishlist/items/${above}`, {
    data: { priceCents: "30.00" },
  });
  expect(raised.status()).toBe(200);

  // A fixture-scraped row, so the letterbox assertions own their image instead
  // of leaning on a row an earlier spec happened to leave behind (spec 3's
  // fixture server is closed by then; this one stays up until the scrape has
  // stored the bytes).
  const fixture = await startFixtureServer();
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { id: string };
  const fixtureItem = await seed({ url: `${fixture.url}/product` });
  await expect
    .poll(
      async () => {
        const list = (await (
          await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)
        ).json()) as Array<{ id: string; imagePath: string | null }>;
        return list.find((row) => row.id === fixtureItem)?.imagePath ?? null;
      },
      { timeout: 20_000, message: "the fixture scrape stores an image" },
    )
    .not.toBeNull();

  // The list switcher is a popover MENU at desktop widths and a Sheet of
  // buttons on mobile, so the guest switches lists at 1280 (like specs 12 and
  // 32) and the parity assertions then run at 390, where the feed's rows are
  // the surface this ticket is about.
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const guest = await guestContext.newPage();
  let guestUser: { id: string } | undefined;
  let shareToken: string | undefined;
  let ownerChipText = "";

  try {
    // --- Owner feed, 390 light: the three price states, the letterbox and the
    //     kebab anchor, on one-line AND wrapped rows. ---
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`);

    const noPriceCard = page.locator(`.item-card[data-item-id="${noPrice}"]`);
    const atLowestCard = page.locator(`.item-card[data-item-id="${atLowest}"]`);
    const aboveCard = page.locator(`.item-card[data-item-id="${above}"]`);
    await expect(noPriceCard).toBeVisible();

    // 1. Missing price: the placeholder keeps the price slot — the same type
    //    size as a real price, the phrase as the accessible name, and no
    //    invented number anywhere.
    await expect(noPriceCard.locator(".price")).toHaveCount(0);
    await expect(noPriceCard.locator(".hint-price")).toHaveCount(0);
    await expect(noPriceCard.locator(".price-unavailable")).toBeVisible();
    await expect(noPriceCard.locator('.price-unavailable [aria-hidden="true"]')).toHaveText("—");
    await expect(noPriceCard.locator(".price-unavailable .visually-hidden")).toHaveText(
      "Price unavailable",
    );
    await expect(noPriceCard.locator(".price-meta")).toHaveCount(0);
    const rhythm = await page.evaluate(
      ([dashId, priceId]) => {
        const dash = document.querySelector<HTMLElement>(
          `.item-card[data-item-id="${dashId}"] .price-unavailable`,
        );
        const price = document.querySelector<HTMLElement>(
          `.item-card[data-item-id="${priceId}"] .price`,
        );
        if (!dash || !price) throw new Error("price slots missing");
        return {
          dashFont: getComputedStyle(dash).fontSize,
          priceFont: getComputedStyle(price).fontSize,
          dashH: dash.getBoundingClientRect().height,
          priceH: price.getBoundingClientRect().height,
        };
      },
      [noPrice, atLowest] as const,
    );
    expect(rhythm.dashFont, "placeholder keeps the row's price type size").toBe(rhythm.priceFont);
    expect(
      Math.abs(rhythm.dashH - rhythm.priceH),
      "placeholder keeps the row's price line height",
    ).toBeLessThanOrEqual(1);

    // 2. At the lowest: the chip, and NO "Lowest £X" line repeating the price.
    await expect(atLowestCard.locator(".price")).toHaveText("£20.00");
    await expect(atLowestCard.locator(".price-meta.price-at-lowest")).toHaveText("At lowest");
    await expect(atLowestCard.locator(".price-meta")).toHaveCount(1);
    await expect(atLowestCard).not.toContainText("Lowest £");
    ownerChipText = (await atLowestCard.locator(".price-meta").innerText()).trim();

    // 3. Above the lowest: the line exists, the chip does not, and the delta
    //    line keeps its own direction signal.
    await expect(aboveCard.locator(".price")).toHaveText("£30.00");
    await expect(aboveCard.locator(".price-meta")).toHaveText("Lowest £25.00");
    await expect(aboveCard.locator(".price-at-lowest")).toHaveCount(0);
    await expect(aboveCard.locator(".price-delta")).toHaveAttribute("data-direction", "up");

    // 4. Kebab anchor: every row's kebab center is its thumb center, and the
    //    long title really does wrap (so the tall-row case is covered).
    const anchors390 = await rowAnchors(page);
    expectKebabContract(anchors390, "owner feed @390/light");
    const wrapped = anchors390.find((row) => row.id === above);
    expect(wrapped?.titleLines, "the long title wraps at 390").toBeGreaterThanOrEqual(2);
    expect(wrapped!.rowH, "the wrapped row is taller than its thumb").toBeGreaterThan(72);

    // 5. Letterbox: contain + the 6px pad, inside an UNCHANGED frame.
    const imagedCard = page.locator(`.item-card[data-item-id="${fixtureItem}"]`);
    await expect(imagedCard.locator(".product-img")).toBeVisible();
    const letterbox = await imagedCard.locator(".product-img").evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return { fit: style.objectFit, pad: style.paddingTop, w: box.width, h: box.height };
    });
    expect(letterbox.fit, "the feed thumb letterboxes").toBe("contain");
    expect(letterbox.pad, "the feed thumb pads").toBe("6px");
    expect(Math.abs(letterbox.w - 72), "the frame width is unchanged").toBeLessThanOrEqual(1);
    expect(Math.abs(letterbox.h - 72), "the frame height is unchanged").toBeLessThanOrEqual(1);
    // Every imaged row in the list, not only the seeded one.
    const allImgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>(".item-list .product-img")).map(
        (img) => ({
          id: img.closest<HTMLElement>(".item-card")?.dataset.itemId ?? "",
          fit: getComputedStyle(img).objectFit,
          pad: getComputedStyle(img).paddingTop,
        }),
      ),
    );
    expect(allImgs.length, "the feed renders at least the seeded image").toBeGreaterThan(0);
    for (const img of allImgs) {
      expect(img.fit, `feed thumb ${img.id} letterboxes`).toBe("contain");
      expect(img.pad, `feed thumb ${img.id} pads`).toBe("6px");
    }
    expectFrameContract(await listFrames(page), "owner feed @390/light", 72);

    // 6. No overflow at the two narrowest widths the brief names.
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await horizontalEscapes(page);
      expect(overflow.docOverflow, `owner overflow @${width}`).toBe(false);
      expect(overflow.offenders, `owner escapes @${width}`).toEqual([]);
    }

    // --- The same verdicts and the same anchor in dark, and at the desktop
    //     thumb size (the track switches to 96px at 1024px). ---
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [width, thumb] of [
        [390, 72],
        [1280, 96],
      ] as const) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${BASE}/`);
        await expect(page.locator(`.item-card[data-item-id="${noPrice}"]`)).toBeVisible();
        await expect(
          page.locator(`.item-card[data-item-id="${atLowest}"] .price-at-lowest`),
        ).toHaveText("At lowest");
        await expect(page.locator(`.item-card[data-item-id="${above}"] .price-meta`)).toHaveText(
          "Lowest £25.00",
        );
        const anchors = await rowAnchors(page);
        expectKebabContract(anchors, `owner feed @${width}/${scheme}`);
        expect(
          Math.abs(anchors[0].thumbH - thumb),
          `thumb token @${width}/${scheme}`,
        ).toBeLessThanOrEqual(1);
        const overflow = await horizontalEscapes(page);
        expect(overflow.docOverflow, `owner overflow @${width}/${scheme}`).toBe(false);
        expect(overflow.offenders, `owner escapes @${width}/${scheme}`).toEqual([]);
      }
    }
    await page.emulateMedia({ colorScheme: "light" });

    // --- The detail hero letterboxes too: same ProductImage, same crop. ---
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/items/${fixtureItem}`);
    const hero = page.locator(".detail-hero .product-img");
    await expect(hero).toBeVisible();
    expect(await hero.evaluate((el) => getComputedStyle(el).objectFit), "detail hero letterboxes")
      .toBe("contain");
    await page.goto(`${BASE}/`);

    // --- Guest feed parity: the SAME verdict text on the same rows. ---
    const guestRes = await page.request.post(`${BASE}/api/users`, {
      data: { username: "price-guest", password: "guest-pass", displayName: "Price Guest" },
    });
    expect(guestRes.status()).toBe(201);
    guestUser = (await guestRes.json()) as { id: string };
    await login(guest, "price-guest", "guest-pass");
    await guest.getByRole("button", { name: /wishlist/ }).click();
    await guest.getByRole("menuitemradio", { name: /Admin/ }).click();
    await expect(guest.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
    await guest.setViewportSize({ width: 390, height: 844 });
    await expect(guest.locator(`.item-card[data-item-id="${atLowest}"]`)).toBeVisible();

    const guestAtLowest = guest.locator(`.item-card[data-item-id="${atLowest}"]`);
    await expect(guestAtLowest.locator(".price")).toHaveText("£20.00");
    await expect(guestAtLowest.locator(".price-meta.price-at-lowest")).toHaveText("At lowest");
    expect(
      (await guestAtLowest.locator(".price-meta").innerText()).trim(),
      "owner and guest feeds agree on the Lowest verdict",
    ).toBe(ownerChipText);
    await expect(guest.locator(`.item-card[data-item-id="${above}"] .price-meta`)).toHaveText(
      "Lowest £25.00",
    );
    await expect(
      guest.locator(
        `.item-card[data-item-id="${noPrice}"] .price-unavailable [aria-hidden="true"]`,
      ),
    ).toHaveText("—");

    // The guest DETAIL sheet shows the full line the feed's chip collapses —
    // #90's representable-everything contract, fed by the same ledger now.
    await guestAtLowest.getByRole("button", { name: "At lowest probe" }).click();
    const guestSheet = guest.getByRole("dialog", { name: "At lowest probe" });
    await expect(guestSheet).toBeVisible();
    await expect(guestSheet.getByText("Lowest £20.00")).toBeVisible();
    // One observation is not a chart: the drawn graph stays absent.
    await expect(guestSheet.locator(".price-graph")).toHaveCount(0);
    await guest.keyboard.press("Escape");
    await expect(guestSheet).toHaveCount(0);

    // --- Anonymous share feed: the third consumer of the #130 verdict. #133
    //     took the parity decision: share rows run the SAME Lowest rule as the
    //     owner and other-user feeds (chip at the lowest, "Lowest £X" above
    //     it, the dash placeholder with no price at all). The delta line stays
    //     owner-side — no share row renders it. ---
    const shared = await page.request.post(`${BASE}/api/share`);
    expect(shared.status()).toBe(201);
    shareToken = ((await shared.json()) as { token: string }).token;
    const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const anonPage = await anon.newPage();
      await anonPage.goto(`${BASE}/share/${shareToken}`);
      await expect(
        anonPage.locator(
          `.item-card[data-item-id="${noPrice}"] .price-unavailable [aria-hidden="true"]`,
        ),
      ).toHaveText("—");
      // No history → no verdict (the placeholder row keeps the price slot).
      await expect(
        anonPage.locator(`.item-card[data-item-id="${noPrice}"] .price-meta`),
      ).toHaveCount(0);
      // At the lowest → the quiet chip, textually identical to the owner's.
      await expect(
        anonPage.locator(`.item-card[data-item-id="${atLowest}"] .price-meta.price-at-lowest`),
      ).toHaveText("At lowest");
      expect(
        (await anonPage.locator(`.item-card[data-item-id="${atLowest}"] .price-meta`).innerText()).trim(),
        "the share feed agrees with the owner feed on the Lowest verdict",
      ).toBe(ownerChipText);
      // Above the lowest → the "Lowest £X" line, never the chip.
      await expect(
        anonPage.locator(`.item-card[data-item-id="${above}"] .price-meta`),
      ).toHaveText("Lowest £25.00");
      await expect(
        anonPage.locator(`.item-card[data-item-id="${above}"] .price-at-lowest`),
      ).toHaveCount(0);
      // #133's boundary: the delta line stays owner-side on every share row.
      await expect(anonPage.locator(".price-delta")).toHaveCount(0);
      const overflow = await horizontalEscapes(anonPage);
      expect(overflow.docOverflow, "share overflow @390").toBe(false);
      expect(overflow.offenders, "share escapes @390").toEqual([]);
    } finally {
      await anon.close();
    }
  } finally {
    // Hand the board back to the serial state: no share link, no extra user,
    // no probe row (later files run against the same server + DB).
    if (shareToken) await page.request.delete(`${BASE}/api/share`);
    fixture.close();
    await guestContext.close();
    if (guestUser) await page.request.delete(`${BASE}/api/users/${guestUser.id}`);
    for (const id of seeded) {
      await page.request.delete(`${BASE}/api/wishlist/items/${id}`);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`);
  }
});

/** #113: the owner's saved "found it cheaper at" link renders on the detail
 *  page — read-only, in the More information card, as a #102 handoff row.
 *  The guest surfaces (other-user sheet, anonymous share sheet) never see it:
 *  cheaperUrl is owner-only data on every DTO (PublicItem, ShareItem), so the
 *  row must be absent there at the RENDER level, not just on the wire. */
test("34: #113 — owner detail surfaces the saved cheaper link; guests never do", async ({
  page,
  browser,
}) => {
  const created = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: {
      title: "Cheaper link probe",
      url: "https://example.com/linen-apron",
      priceCents: "24.99",
      currency: "GBP",
      cheaperUrl: "https://elsewhere.example.com/cheaper-apron",
    },
  });
  expect(created.status()).toBe(201);
  const item = (await created.json()) as { id: string };
  const unset = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "No cheaper probe", priceCents: "9.99", currency: "GBP" },
  });
  expect(unset.status()).toBe(201);
  const bare = (await unset.json()) as { id: string };

  let guestUser: { id: string } | undefined;
  let shareToken: string | undefined;
  const seeded = [item.id, bare.id];
  try {
    // --- Owner page: the row renders with the saved href + host label. ---
    await page.goto(`${BASE}/items/${item.id}`);
    const itemPage = page.locator(".item-page");
    const more = itemPage.locator(".detail-more-card");
    const cheaperRow = more.getByRole("link", { name: "Found it cheaper at elsewhere.example.com" });
    await expect(cheaperRow).toBeVisible();
    await expect(cheaperRow).toHaveAttribute("href", "https://elsewhere.example.com/cheaper-apron");
    // #102: the saved link hands off exactly like every external anchor.
    await expectHandoffAnchor(cheaperRow, "ItemPage / found it cheaper");
    // Row order: saved evidence above the on-demand hints disclosure.
    const toggle = itemPage.getByRole("button", { name: "Check prices elsewhere" });
    await expect(toggle).toBeVisible();
    const cheaperBox = (await cheaperRow.boundingBox())!;
    const toggleBox = (await toggle.boundingBox())!;
    expect(
      cheaperBox.y + cheaperBox.height,
      "the cheaper row sits above the hints toggle",
    ).toBeLessThanOrEqual(toggleBox.y + 1);
    // Exactly one cheaper row; the hero keeps the single primary exit.
    await expect(itemPage.getByRole("link", { name: /Found it cheaper at/ })).toHaveCount(1);
    await expect(itemPage.getByRole("link", { name: "Open product" })).toHaveCount(1);

    // --- Absence when the field is unset (no dead-end affordance). ---
    await page.goto(`${BASE}/items/${bare.id}`);
    await expect(page.locator(".detail-more-card")).toBeVisible();
    await expect(page.getByRole("link", { name: /Found it cheaper at/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check prices elsewhere" })).toBeVisible();

    // --- Clearing via the edit form removes the row (round-trip). ---
    await page.goto(`${BASE}/items/${item.id}`);
    await page.getByRole("button", { name: "Edit item" }).click();
    await page.getByLabel("Found it cheaper at").fill("");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(`${BASE}/items/${item.id}`);
    await expect(page.getByRole("link", { name: /Found it cheaper at/ })).toHaveCount(0);
    // …and re-setting it through the form brings the row back. Re-enter the
    // ORIGINAL URL so the guest/share privacy probes below assert against the
    // value actually stored at that point (a stale URL would make the absence
    // probes trivially true).
    await page.getByRole("button", { name: "Edit item" }).click();
    await page.getByLabel("Found it cheaper at").fill("https://elsewhere.example.com/cheaper-apron");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("link", { name: "Found it cheaper at elsewhere.example.com" }),
    ).toBeVisible();

    // --- Narrow widths: the row never escapes. ---
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const probe = await horizontalEscapes(page);
      expect(probe.docOverflow, `item page overflow @${width}`).toBe(false);
      expect(probe.offenders, `item page escapes @${width}`).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 844 });

    // --- Long host: the label wraps (overflow-wrap: anywhere), no escape. ---
    const long = await page.request.post(`${BASE}/api/wishlist/items`, {
      data: {
        title: "Long host probe",
        priceCents: "5.00",
        currency: "GBP",
        cheaperUrl: `https://shop.${"very-long-subdomain".repeat(4)}.example.co.uk/deep/path`,
      },
    });
    expect(long.status()).toBe(201);
    const longItem = (await long.json()) as { id: string };
    seeded.push(longItem.id);
    await page.goto(`${BASE}/items/${longItem.id}`);
    await expect(
      page.getByRole("link", { name: /Found it cheaper at shop\.very-long/ }),
    ).toBeVisible();
    await page.setViewportSize({ width: 360, height: 844 });
    const narrow = await horizontalEscapes(page);
    expect(narrow.docOverflow, "long host doc overflow @360").toBe(false);
    expect(narrow.offenders, "long host escapes @360").toEqual([]);
    await page.setViewportSize({ width: 1280, height: 844 });

    // --- Guest surface 1: the other-user detail sheet never renders it. ---
    // Switch lists at 1280 (the switcher is a popover menu at desktop, a sheet
    // on mobile), then probe the sheet at 390.
    const guestRes = await page.request.post(`${BASE}/api/users`, {
      data: { username: "cheaper-guest", password: "guest-pass", displayName: "Cheaper Guest" },
    });
    expect(guestRes.status()).toBe(201);
    guestUser = (await guestRes.json()) as { id: string };
    const guestContext = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    try {
      const guest = await guestContext.newPage();
      await login(guest, "cheaper-guest", "guest-pass");
      await guest.getByRole("button", { name: /wishlist/ }).click();
      await guest.getByRole("menuitemradio", { name: /Admin/ }).click();
      await expect(guest.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
      await guest.setViewportSize({ width: 390, height: 844 });
      await guest
        .locator(".item-card", { has: guest.getByRole("heading", { name: "Cheaper link probe" }) })
        .getByRole("button", { name: "Cheaper link probe" })
        .click();
      const guestSheet = guest.getByRole("dialog", { name: "Cheaper link probe" });
      await expect(guestSheet).toBeVisible();
      await expect(guestSheet.getByText(/Found it cheaper at/)).toHaveCount(0);
      await expect(
        guestSheet.getByRole("link", { name: /elsewhere\.example\.com/ }),
      ).toHaveCount(0);
      // The guest more-card still carries its own (copy-link) row.
      await expect(guestSheet.locator(".detail-more-card")).toBeVisible();
      await guest.keyboard.press("Escape");
    } finally {
      await guestContext.close();
    }

    // --- Guest surface 2: the anonymous share sheet never renders it. ---
    const shared = await page.request.post(`${BASE}/api/share`);
    expect(shared.status()).toBe(201);
    shareToken = ((await shared.json()) as { token: string }).token;
    const anon = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    try {
      const anonPage = await anon.newPage();
      await anonPage.goto(`${BASE}/share/${shareToken}`);
      await anonPage
        .locator(".item-card", { has: anonPage.getByRole("heading", { name: "Cheaper link probe" }) })
        .getByRole("button", { name: "Cheaper link probe" })
        .click();
      const shareSheet = anonPage.getByRole("dialog", { name: "Cheaper link probe" });
      await expect(shareSheet).toBeVisible();
      await expect(shareSheet.getByText(/Found it cheaper at/)).toHaveCount(0);
      await expect(
        shareSheet.getByRole("link", { name: /elsewhere\.example\.com/ }),
      ).toHaveCount(0);
      // The raw URL must not be in the share page's rendered DOM at all.
      expect(await anonPage.locator("body").innerText()).not.toContain("cheaper-apron");
      await anonPage.keyboard.press("Escape");
      await expect(shareSheet).toHaveCount(0);
    } finally {
      await anon.close();
    }
  } finally {
    if (shareToken) await page.request.delete(`${BASE}/api/share`);
    if (guestUser) await page.request.delete(`${BASE}/api/users/${guestUser.id}`);
    for (const id of seeded) {
      await page.request.delete(`${BASE}/api/wishlist/items/${id}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`);
  }
});

/** #133: the guest share view. One tagline under the title, a guest-safe row
 *  menu (the issue's read-only pair plus the one guest write the share flow
 *  sells), the #130 Lowest verdict on the rows, and one quiet sign-in hook at
 *  the page end — with no owner identity beyond the display name the owner
 *  chose. */
test("35: #133 — guest share view: scoped menu, one tagline, Lowest parity, sign-in hook", async ({
  page,
  browser,
}) => {
  // A dedicated owner whose USERNAME and display name are unalike, so the
  // "no owner identity on the share surface" probes are real tests: a leaked
  // username would render "zog-private" while the heading reads "Zoe's
  // wishlist".
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username: "zog-private", password: "zog-private-pass", displayName: "Zoe" },
  });
  expect(created.status()).toBe(201);
  const ownerUser = (await created.json()) as { id: string };

  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ownerPage = await ownerContext.newPage();
  const seeded: string[] = [];
  let anonContext: BrowserContext | undefined;
  let shareToken: string | undefined;

  try {
    await login(ownerPage, "zog-private", "zog-private-pass");

    // Two rows, seeded through the same API the form uses: one AT its lowest
    // with a product URL (the menu's read-only pair needs a url), one ABOVE
    // its lowest with a real delta the row must NOT render. The ledger's
    // minimum can never exceed the current price, so "above" is add low, raise.
    const atLowestRes = await ownerPage.request.post(`${BASE}/api/wishlist/items`, {
      data: {
        title: "At lowest probe",
        url: "https://example.com/gift",
        priceCents: "25.00",
        currency: "GBP",
      },
    });
    expect(atLowestRes.status()).toBe(201);
    const atLowest = ((await atLowestRes.json()) as { id: string }).id;
    seeded.push(atLowest);

    const aboveRes = await ownerPage.request.post(`${BASE}/api/wishlist/items`, {
      data: { title: "Above lowest probe", priceCents: "25.00", currency: "GBP" },
    });
    expect(aboveRes.status()).toBe(201);
    const above = ((await aboveRes.json()) as { id: string }).id;
    seeded.push(above);
    const raised = await ownerPage.request.patch(`${BASE}/api/wishlist/items/${above}`, {
      data: { priceCents: "30.00" },
    });
    expect(raised.status()).toBe(200);

    const shared = await ownerPage.request.post(`${BASE}/api/share`);
    expect(shared.status()).toBe(201);
    shareToken = ((await shared.json()) as { token: string }).token;

    // Anonymous viewer: a fresh context with zero cookies. Clipboard
    // permissions are granted so the "Copy link" row can be checked against
    // the real clipboard, not just the toast.
    const anon = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    anonContext = anon;
    await anon.addInitScript(() => {
      sessionStorage.setItem("docLoads", String(Number(sessionStorage.getItem("docLoads") ?? 0) + 1));
    });
    const anonPage = await anon.newPage();
    await anonPage.goto(`${BASE}/share/${shareToken}`);
    await expect(anonPage.getByRole("heading", { name: "Zoe's wishlist" })).toBeVisible();

    const atLowestCard = anonPage.locator(`.item-card[data-item-id="${atLowest}"]`);
    const aboveCard = anonPage.locator(`.item-card[data-item-id="${above}"]`);
    await expect(atLowestCard).toBeVisible();
    await expect(aboveCard).toBeVisible();

    // 1. Tagline dedup: ONE line under the title — the shared-list note — and
    //    the marketing tagline is gone from this surface.
    await expect(anonPage.getByText("Shared list — no account needed")).toBeVisible();
    await expect(anonPage.locator(".share-note")).toHaveCount(1);
    await expect(
      anonPage.getByText("Private wishlists, shared with people you trust."),
    ).toHaveCount(0);

    // 2a. Desktop popover (>= 640px): exactly the guest-safe trio, no Cancel
    //     row (that is the mobile Sheet's own dismiss route).
    await anonPage.setViewportSize({ width: 1280, height: 900 });
    await atLowestCard.getByRole("button", { name: "More actions" }).click();
    const popover = anonPage.getByRole("menu", { name: "More actions" });
    await expect(popover).toBeVisible();
    expect(
      (await popover.getByRole("menuitem").allInnerTexts()).map((t) => t.trim()).sort(),
    ).toEqual(["Copy link", "Mark as purchased", "Open product"]);
    await anonPage.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);

    // 2b. Mobile sheet (390px): the same trio plus the Sheet's Cancel row, and
    //     never an owner action.
    await anonPage.setViewportSize({ width: 390, height: 844 });
    await atLowestCard.getByRole("button", { name: "More actions" }).click();
    const sheetMenu = anonPage.getByRole("menu", { name: "More actions" });
    await expect(sheetMenu).toBeVisible();
    const sheetItems = (await sheetMenu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
    expect(sheetItems.filter((label) => label !== "Cancel").sort()).toEqual([
      "Copy link",
      "Mark as purchased",
      "Open product",
    ]);
    expect(sheetItems, "the Sheet keeps its own dismiss row").toContain("Cancel");
    for (const ownerAction of ["Edit", "Edit item", "Re-check price", "Reset purchased mark", "Delete"]) {
      await expect(
        sheetMenu.getByRole("menuitem", { name: ownerAction, exact: true }),
      ).toHaveCount(0);
    }

    // 3. The read-only pair WORKS: Copy link writes the product URL to the
    //    clipboard and toasts.
    await sheetMenu.getByRole("menuitem", { name: "Copy link" }).click();
    await expect(anonPage.locator(".toast")).toContainText("Copied");
    expect(
      await anonPage.evaluate(() => navigator.clipboard.readText()),
      "the copied text is the product url",
    ).toBe("https://example.com/gift");

    // …and Open product hands the URL off to a NEW browsing context without
    // re-loading the SPA (#102's contract, for a menu row rather than a link).
    const urlBefore = anonPage.url();
    const loadsBefore = await loads(anonPage);
    await atLowestCard.getByRole("button", { name: "More actions" }).click();
    const [popup] = await Promise.all([
      anon.waitForEvent("page"),
      anonPage.getByRole("menuitem", { name: "Open product" }).click(),
    ]);
    await popup.close();
    expect(anonPage.url(), "the SPA document stayed put").toBe(urlBefore);
    expect(await loads(anonPage), "no extra document load").toBe(loadsBefore);

    // 4. The one guest WRITE survives the rescoped menu (spec 15e's chain).
    await atLowestCard.getByRole("button", { name: "More actions" }).click();
    await anonPage.getByRole("menuitem", { name: "Mark as purchased" }).click();
    const dialog = anonPage.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("This tells other viewers the item is already bought."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Mark as purchased" }).click();
    await expect(atLowestCard.locator(".share-purchased-badge")).toHaveText("Purchased");
    await expect(atLowestCard).toHaveClass(/is-purchased/);

    // 5. Lowest parity with the owner/other-user feeds (#130's rule)…
    await expect(atLowestCard.locator(".price-meta.price-at-lowest")).toHaveText("At lowest");
    await expect(aboveCard.locator(".price-meta")).toHaveText("Lowest £25.00");
    await expect(aboveCard.locator(".price-at-lowest")).toHaveCount(0);
    // …with the delta line deliberately owner-side (the row above has a real
    // "up £5.00" the guest surface must not render).
    await expect(anonPage.locator(".price-delta")).toHaveCount(0);

    // 6. A row without a URL gets no read-only pair (the url gate).
    await aboveCard.getByRole("button", { name: "More actions" }).click();
    const urlLessMenu = anonPage.getByRole("menu", { name: "More actions" });
    await expect(urlLessMenu).toBeVisible();
    expect(
      (await urlLessMenu.getByRole("menuitem").allInnerTexts())
        .map((t) => t.trim())
        .filter((label) => label !== "Cancel")
        .sort(),
    ).toEqual(["Mark as purchased"]);
    await anonPage.keyboard.press("Escape");
    await expect(urlLessMenu).toHaveCount(0);

    // 7. Privacy in the browser: the owner's username never reaches the DOM;
    //    the display name the owner chose does.
    expect(await anonPage.locator("body").innerText()).not.toContain("zog-private");

    // 8. The sign-in hook: one muted link at the page end, below the list,
    //    never in the header — and it routes to the login form.
    const hook = anonPage.getByRole("link", { name: "Sign in to create your own wishlist" });
    await expect(hook).toBeVisible();
    await expect(hook).toHaveAttribute("href", "/login?next=/");
    await expect(
      anonPage.locator(".topbar").getByRole("link", { name: "Sign in to create your own wishlist" }),
    ).toHaveCount(0);
    const listBox = (await anonPage.locator(".item-list").boundingBox())!;
    const hookBox = (await hook.boundingBox())!;
    expect(hookBox.y, "the hook sits below the list it advertises").toBeGreaterThan(
      listBox.y + listBox.height - 1,
    );
    // Muted copy, but still the app's standard link colour: it clears AA in
    // both schemes (the capture pass measures the same ratio).
    for (const scheme of ["light", "dark"] as const) {
      await anonPage.emulateMedia({ colorScheme: scheme });
      expect(await contrast(hook), `hook contrast @${scheme}`).toBeGreaterThanOrEqual(4.5);
    }
    await anonPage.emulateMedia({ colorScheme: "light" });

    // 9. Narrow widths: neither the hook line nor the wider menu escapes.
    for (const width of [360, 390]) {
      await anonPage.setViewportSize({ width, height: 844 });
      const probe = await horizontalEscapes(anonPage);
      expect(probe.docOverflow, `share overflow @${width}`).toBe(false);
      expect(probe.offenders, `share escapes @${width}`).toEqual([]);
    }

    // 10. Click-through: the hook lands on the login view with `next` intact
    //     (safeNext's own contract is spec 14's, not re-asserted here).
    await hook.click();
    await expect(anonPage).toHaveURL(`${BASE}/login?next=/`);
    await expect(anonPage.getByRole("button", { name: "Sign in" })).toBeVisible();

    // 11. The owner's own copy: no hook, the owner note instead, no mark
    //     affordance at all, and the username just as absent.
    await ownerPage.goto(`${BASE}/share/${shareToken}`);
    await expect(ownerPage.getByRole("heading", { name: "Zoe's wishlist" })).toBeVisible();
    await expect(
      ownerPage.getByText("You are viewing your own shared list."),
    ).toBeVisible();
    await expect(
      ownerPage.getByRole("link", { name: "Sign in to create your own wishlist" }),
    ).toHaveCount(0);
    await expect(ownerPage.locator(".share-signin")).toHaveCount(0);
    await expect(ownerPage.getByRole("button", { name: "More actions" })).toHaveCount(0);
    expect(await ownerPage.locator("body").innerText()).not.toContain("zog-private");
  } finally {
    // Hand the board back to the serial state: no share link, no probe rows,
    // no extra user (the suite's later specs share this server + DB).
    if (shareToken) await ownerPage.request.delete(`${BASE}/api/share`);
    for (const id of seeded) {
      await ownerPage.request.delete(`${BASE}/api/wishlist/items/${id}`);
    }
    await anonContext?.close();
    await ownerContext.close();
    await page.request.delete(`${BASE}/api/users/${ownerUser.id}`);
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`);
  }
});

test("36: #127 — purchased cluster, guarded discard, canonical add pair", async ({ page }) => {
  // A TITLE-ONLY row: with no url the menu inventory is deterministic — no
  // copy-link row and no fetch-state-dependent recheck/retry entry — which is
  // exactly the pin #127's walkthrough was missing. It is also the state the
  // issue filed against: "Mark as purchased" AND "Reset purchased mark" both
  // rendering on an item nothing has marked.
  const seeded = await page.request.post(`${BASE}/api/wishlist/items`, {
    data: { title: "Desktop nits probe" },
  });
  expect(seeded.status()).toBe(201);
  const item = (await seeded.json()) as { id: string };
  await page.reload();
  const card = page.locator(`.item-card[data-item-id="${item.id}"]`);

  // --- 1. D1, desktop popover: the purchased pair reads as ONE cluster. ---
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/`);
  const menu = page.getByRole("menu", { name: "More actions" });
  const inventory = async () =>
    (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
  await card.getByRole("button", { name: "More actions" }).click();
  await expect(menu).toBeVisible();
  expect(await inventory()).toEqual(["Edit", "Mark as purchased", "Reset purchased mark", "Delete"]);
  // Two dividers: one opens the purchased cluster, one opens Delete (danger).
  await expect(menu.locator(".overflow-separator")).toHaveCount(2);

  // --- 2. D1 owner-mark XOR — with the blind reset surviving it. ---
  await menu.getByRole("menuitem", { name: "Mark as purchased" }).click();
  const markDialog = page.getByRole("alertdialog");
  await expect(markDialog).toBeVisible();
  await markDialog.getByRole("button", { name: "Mark as purchased" }).click();
  await expect(card.locator(".owner-purchased-badge")).toHaveText("Bought by you");

  await card.getByRole("button", { name: "More actions" }).click();
  await expect(menu).toBeVisible();
  expect(await inventory()).toEqual(["Edit", "Unmark purchased", "Reset purchased mark", "Delete"]);
  await expect(menu.locator(".overflow-separator")).toHaveCount(2);
  // #84's XOR is the owner's OWN flag; the reset acts on the anonymous one,
  // which this client cannot see — so it is NOT the other half of an XOR and
  // must stay on every owner row (it is the only owner-side way to clear a
  // mark a guest left, and revoking the link does not clear it).
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // --- 3. D1, mobile sheet: the same cluster + the sheet's own dismiss row. ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/`);
  await card.getByRole("button", { name: "More actions" }).click();
  const sheetMenu = page.getByRole("menu", { name: "More actions" });
  await expect(sheetMenu).toBeVisible();
  expect((await sheetMenu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim())).toEqual([
    "Edit",
    "Unmark purchased",
    "Reset purchased mark",
    "Delete",
    "Cancel",
  ]);
  // cluster + danger + the sheet's dismiss divider.
  await expect(sheetMenu.locator(".overflow-separator")).toHaveCount(3);
  await sheetMenu.getByRole("menuitem", { name: "Unmark purchased" }).click();
  await expect(card.locator(".owner-purchased-badge")).toHaveCount(0);

  // --- 4. D1, detail-menu parity (that menu has no Edit entry). ---
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/items/${item.id}`);
  const detailPage = page.locator(".item-page");
  await detailPage.getByRole("button", { name: "More actions" }).click();
  await expect(menu).toBeVisible();
  expect(await inventory()).toEqual(["Mark as purchased", "Reset purchased mark", "Delete"]);
  // The cluster LEADS this menu (the probe has no url), so only the danger
  // divider renders: a divider above the first row separates nothing.
  await expect(menu.locator(".overflow-separator")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // --- 5. D3, /add pristine → no in-form exit; a draft → guarded Discard. ---
  await page.goto(`${BASE}/add`);
  await expect(page.getByRole("heading", { name: "Add item" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to list" })).toBeVisible();

  // Whitespace alone is NOT a draft: nothing a submit would send would be lost.
  await page.getByLabel("Link").fill("   ");
  await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await page.getByLabel("Link").fill("https://example.com/discard-probe");
  const discard = page.getByRole("button", { name: "Discard" });
  await expect(discard).toBeVisible();

  // Rejecting the guard keeps the user on /add with the draft intact.
  await discard.click();
  const discardDialog = page.getByRole("alertdialog");
  await expect(discardDialog).toBeVisible();
  await expect(discardDialog.getByRole("heading", { name: "Discard this item?" })).toBeVisible();
  await discardDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(`${BASE}/add`);
  await expect(page.getByLabel("Link")).toHaveValue("https://example.com/discard-probe");

  // Confirming it lands on the feed.
  await discard.click();
  await discardDialog.getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${BASE}/`);

  // --- 6. D3, a share-target prefill counts as a draft (the link arrived
  //        with intent — "Back to list" would silently drop it). ---
  await page.goto(`${BASE}/add?url=https://example.com/prefill-probe&title=Prefill probe`);
  await expect(page.getByLabel("Title")).toHaveValue("Prefill probe");
  await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${BASE}/`);

  // --- 7. Board hygiene: no probe row (and no draft state) left behind. ---
  const removed = await page.request.delete(`${BASE}/api/wishlist/items/${item.id}`);
  expect([200, 204]).toContain(removed.status());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/`);
});

test("37: #125 — one header on every authenticated page, Back-to-list button, subpage switcher", async ({
  page,
  browser,
}) => {
  // Two probe rows: the feed only offers Reorder from two items up, and leg 2
  // pins the feed as unchanged — including that action.
  const probeIds: string[] = [];
  for (const title of ["Header probe", "Header probe two"]) {
    const seeded = await page.request.post(`${BASE}/api/wishlist/items`, { data: { title } });
    expect(seeded.status()).toBe(201);
    probeIds.push(((await seeded.json()) as { id: string }).id);
  }
  const itemId = probeIds[0]!;

  // A second member with a non-empty list: the switcher on a subpage must be
  // able to leave the own list (D4).
  const OTHER = { username: "header-other", password: "header-other-pass", displayName: "Header Other" };
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username: OTHER.username, password: OTHER.password, displayName: OTHER.displayName },
  });
  expect([201, 409], "the second member exists (created here or by an earlier run)").toContain(
    created.status(),
  );

  const otherContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const other = await otherContext.newPage();
    await login(other, OTHER.username, OTHER.password);
    const otherRow = await other.request.post(`${BASE}/api/wishlist/items`, {
      data: { title: "Other list probe" },
    });
    expect(otherRow.status()).toBe(201);

    // --- 1. Item view: the full cluster, with a real Back-to-list BUTTON. --
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/items/${itemId}`);
    await expect(page.locator(".item-page")).toBeVisible();

    const cluster = page.locator(".topbar-actions");
    await expect(cluster, "#125: the item view carries the header cluster").toBeVisible();
    await expect(cluster.getByRole("button", { name: "Add item", exact: true })).toBeVisible();
    await expect(cluster.getByRole("button", { name: "Share my list", exact: true })).toBeVisible();
    const back = cluster.getByRole("button", { name: "Back to list", exact: true });
    await expect(back, "#125: a visible Back-to-list button, not just the text link").toBeVisible();
    // Same control family as the feed's Reorder, and a real 44px target.
    await expect(back).toHaveClass(/secondary/);
    await expect(back).toHaveClass(/topbar-back/);
    expect(Math.round((await back.boundingBox())!.height), "Back to list target").toBeGreaterThanOrEqual(44);
    // The brand LINK keeps its own role (3c/4d/9/12 click it).
    await expect(page.getByRole("link", { name: "Back to list" })).toBeVisible();
    // …and the page says which list it belongs to (the compact context bar).
    await expect(page.locator(".list-switcher--compact .list-switcher-name")).toHaveText(
      "Admin's wishlist",
    );

    const loadsBefore = await loads(page);
    await back.click();
    await expect(page).toHaveURL(`${BASE}/`);
    expect(await loads(page), "Back to list is a client-side navigation").toBe(loadsBefore);

    // --- 2. Feed: UNCHANGED (display-scale switcher + Reorder, no bar). ----
    await expect(page.locator(".list-switcher .page-title")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reorder", exact: true })).toBeVisible();
    await expect(page.locator(".list-switcher--compact")).toHaveCount(0);

    // --- 3. /add: the same cluster, WITHOUT the Add chip (its destination is
    //        this page), so the submit stays the page's only "Add item". ----
    await page.goto(`${BASE}/add`);
    await expect(page.getByRole("heading", { name: "Add item" })).toBeVisible();
    const addCluster = page.locator(".topbar-actions");
    await expect(addCluster, "#125: /add carries the header cluster too").toBeVisible();
    await expect(addCluster.getByRole("button", { name: "Share my list", exact: true })).toBeVisible();
    await expect(addCluster.getByRole("button", { name: "Add item", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add item", exact: true })).toHaveCount(1);
    await expect(addCluster.getByRole("button", { name: "Back to list", exact: true })).toHaveCount(0);
    await expect(page.locator(".list-switcher--compact")).toBeVisible();

    // --- 4. Settings: same cluster + bar; the avatar menu drops its own
    //        Settings row there, and keeps it on a page that is not Settings.
    await page.goto(`${BASE}/settings`);
    await expect(page.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();
    const settingsCluster = page.locator(".topbar-actions");
    await expect(settingsCluster.getByRole("button", { name: "Add item", exact: true })).toBeVisible();
    await expect(settingsCluster.getByRole("button", { name: "Share my list", exact: true })).toBeVisible();
    await expect(page.locator(".list-switcher--compact")).toBeVisible();
    await page.locator('.user-menu-button[aria-label="Admin"]').click();
    const menu = page.getByRole("menu", { name: "Admin" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.goto(`${BASE}/items/${itemId}`);
    await page.locator('.user-menu-button[aria-label="Admin"]').click();
    const itemMenu = page.getByRole("menu", { name: "Admin" });
    await expect(itemMenu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(itemMenu).toHaveCount(0);

    // --- 5. The two admin screens too (opt-in on), then hand it back off. ---
    const uiOn = await page.request.put(`${BASE}/api/auth/me/settings`, {
      data: { showUserManagement: true },
    });
    expect(uiOn.status()).toBe(200);
    for (const path of ["/settings/users", "/settings/users/new"]) {
      await page.goto(`${BASE}${path}`);
      await expect(page.locator(".topbar-actions"), `cluster on ${path}`).toBeVisible();
      await expect(page.locator(".list-switcher--compact"), `bar on ${path}`).toBeVisible();
    }
    const uiOff = await page.request.put(`${BASE}/api/auth/me/settings`, {
      data: { showUserManagement: false },
    });
    expect(uiOff.status()).toBe(200);

    // --- 6. D4: the subpage switcher navigates to that list's feed. -------
    await page.goto(`${BASE}/items/${itemId}`);
    await page.locator(".list-switcher--compact .list-switcher-trigger").click();
    const popover = page.getByRole("menu", { name: "Switch wishlist" });
    await expect(popover).toBeVisible();
    await popover.getByRole("menuitemradio", { name: /Header Other/ }).click();
    await expect(page).toHaveURL(`${BASE}/`);
    await expect(page.getByRole("heading", { name: "Header Other's wishlist" })).toBeVisible();
    // …and the feed's own switcher is still how you come back.
    await page.getByRole("button", { name: /wishlist/ }).click();
    await page.getByRole("menuitemradio", { name: /Admin/ }).click();
    await expect(page.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();

    // --- 6b. The own row is the OTHER half of scope 4 ("own name -> own
    //        feed"), and the compact bar marks it as the list on screen. ---
    await page.goto(`${BASE}/items/${itemId}`);
    await page.locator(".list-switcher--compact .list-switcher-trigger").click();
    const ownPopover = page.getByRole("menu", { name: "Switch wishlist" });
    await expect(ownPopover).toBeVisible();
    const ownRow = ownPopover.getByRole("menuitemradio", { name: /Admin/ });
    await expect(ownRow, "#125: the compact switcher checks the own row").toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(
      ownPopover.getByRole("menuitemradio", { name: /Header Other/ }),
      "#125: only the list on screen is current",
    ).toHaveAttribute("aria-checked", "false");
    await ownRow.click();
    await expect(page).toHaveURL(`${BASE}/`);
    await expect(page.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
    // OWNER mode, not the guest projection: the owner-only actions are back.
    await expect(page.getByRole("button", { name: "Reorder", exact: true })).toBeVisible();
    await expect(
      page.locator(".topbar-actions").getByRole("button", { name: "Add item", exact: true }),
    ).toBeVisible();

    // --- 6c. …and that own-list handoff overrides a feed snapshot left on
    //        someone else's list: `null` means "own list", `undefined` means
    //        "no handoff" (feed-handoff). Leave the feed while it shows
    //        Header Other, then pick the own row from the subpage. --------
    await page.getByRole("button", { name: /wishlist/ }).click();
    await page.getByRole("menuitemradio", { name: /Header Other/ }).click();
    await expect(page.getByRole("heading", { name: "Header Other's wishlist" })).toBeVisible();
    await page.locator('.user-menu-button[aria-label="Admin"]').click();
    await page.getByRole("menu", { name: "Admin" }).getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL(`${BASE}/settings`);
    await page.locator(".list-switcher--compact .list-switcher-trigger").click();
    await page
      .getByRole("menu", { name: "Switch wishlist" })
      .getByRole("menuitemradio", { name: /Admin/ })
      .click();
    await expect(page).toHaveURL(`${BASE}/`);
    await expect(
      page.getByRole("heading", { name: "Admin's wishlist" }),
      "#125: the own-list handoff overrides the snapshot's other-user view",
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reorder", exact: true })).toBeVisible();

    // --- 7. D6: mobile keeps the bottom bar and no desktop cluster. -------
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [`/items/${itemId}`, "/add", "/settings"]) {
      await page.goto(`${BASE}${path}`);
      await expect(page.locator(".topbar-actions"), `cluster on ${path} @390`).toHaveCount(0);
      await expect(page.locator(".topbar-back"), `back button on ${path} @390`).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Back to list" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Primary actions" })).toBeVisible();
    }

    // --- 8. One header height, and no overflow, at every width. ----------
    for (const width of [360, 390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const path of ["/", "/add", "/settings", `/items/${itemId}`]) {
        await page.goto(`${BASE}${path}`);
        await expect(page.locator(".topbar")).toBeVisible();
        const probe = await horizontalEscapes(page);
        expect(probe.docOverflow, `${path} overflow at ${width}px`).toBe(false);
        expect(probe.offenders, `${path} escapes at ${width}px`).toEqual([]);
      }
      if (width < 640) continue;
      const heights: number[] = [];
      for (const path of ["/", "/add", "/settings", `/items/${itemId}`]) {
        await page.goto(`${BASE}${path}`);
        await expect(page.locator(".topbar")).toBeVisible();
        heights.push(
          Math.round(
            await page.locator(".topbar").evaluate((el) => el.getBoundingClientRect().height),
          ),
        );
      }
      expect(
        new Set(heights).size,
        `#125: the header never changes shape — heights at ${width}px: ${heights.join(",")}`,
      ).toBe(1);
    }
  } finally {
    await otherContext.close();
    for (const id of probeIds) {
      const removed = await page.request.delete(`${BASE}/api/wishlist/items/${id}`);
      expect([200, 204]).toContain(removed.status());
    }
  }
});
