import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4599";

// Runs in the same serial worker chain as app.spec/settings.spec (loaded
// alphabetically, so this file is last). Its own state: the share link it
// mints is revoked at the end, and no test mutates another suite's data.
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
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
}

/** Document-load counter (INV-4). A soft navigation (pushState) never reloads
 *  the document; a full reload replaces the window and its performance
 *  timeline, so `performance.getEntriesByType("navigation")` is ALWAYS
 *  length 1 in whatever document probes it — that probe cannot detect a
 *  reload (false green). Instead: addInitScript increments a sessionStorage
 *  counter on every real document load, and sessionStorage survives
 *  same-origin loads in the tab, so the number only moves on a full load. */
async function loads(page: Page): Promise<number> {
  return page.evaluate(() => Number(sessionStorage.getItem("docLoads") ?? 0));
}

test.beforeEach(async ({ page }) => {
  // One addInitScript per fresh page: it runs on every document load.
  await page.addInitScript(() => {
    sessionStorage.setItem("docLoads", String(Number(sessionStorage.getItem("docLoads") ?? 0) + 1));
  });
  await login(page, "admin", "admin-password"); // 1 load (the goto); sign-in is soft
});

test("s1: feed → settings is client-side; URL + no document reload", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  const before = await loads(page);
  await page.locator('.user-menu-button[aria-label="Admin"]').click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();
  // The boot skeleton has settled by now (SectionRenderer replaced it).
  await expect(page.locator(".skeleton-settings")).toHaveCount(0);
  expect(await loads(page)).toBe(before); // INV-4: no document reload
});

test("s2: settings route renders its boot skeleton before content", async ({ page }) => {
  // Route interception cannot widen this window: the app runs a service
  // worker (PROD build) and SW-mediated fetches do not reach page.route, so
  // the boot window stays sub-frame. Watch the DOM instead — React commits
  // the skeleton before the boot fetch resolves, and a MutationObserver on
  // `document` (documentElement does not exist yet at init-script time)
  // records that commit even if the follow-up commit lands in the same tick.
  await page.addInitScript(() => {
    const state = { saw: false };
    (window as unknown as { __sawSettingsSkeleton: { saw: boolean } }).__sawSettingsSkeleton = state;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          const el = node as Element;
          if (el.nodeType !== 1) continue;
          if (el.matches?.(".skeleton-settings") || el.querySelector?.(".skeleton-settings")) {
            state.saw = true;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();

  await page.locator('.user-menu-button[aria-label="Admin"]').click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __sawSettingsSkeleton: { saw: boolean } }).__sawSettingsSkeleton.saw,
    ),
  ).toBe(true);
  await expect(page.locator(".skeleton-settings")).toHaveCount(0); // settled
});

test("s3: brand link returns home client-side", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();
  const before = await loads(page);
  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  expect(await loads(page)).toBe(before);
});

test("s4: login view: anonymous sees the form; authed user is bounced to app", async ({ page, browser }) => {
  // Authed (from beforeEach): /login lands on the app (INV-6).
  await page.goto(`${BASE}/login`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  await expect(page).toHaveURL(`${BASE}/`);

  // Anonymous: fresh context, no cookies.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  try {
    await anonPage.goto(`${BASE}/login`);
    await expect(anonPage.locator(".auth-card")).toBeVisible();
    // The share-target ?next= carry-through still works in-SPA:
    await anonPage.goto(`${BASE}/login?next=%2Fsettings`);
    await anonPage.getByLabel("Username").fill("admin");
    await anonPage.getByLabel("Password").fill("admin-password");
    await anonPage.getByRole("button", { name: "Sign in" }).click();
    await expect(anonPage).toHaveURL(/\/settings$/);
    await expect(anonPage.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();
  } finally {
    await anon.close();
  }
});

test("s5: 401 boot bounce lands on /login?next= without a document load", async ({ page, context }) => {
  await context.clearCookies();
  await page.goto(`${BASE}/add?url=https%3A%2F%2Fexample.com%2Fspa&title=Spa%20probe`);
  await expect(page).toHaveURL(/\/login\?next=/); // the bounce is in-document
  const before = await loads(page);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // #62: the add flow is a page at /add (it was a sheet in the feed).
  await expect(page).toHaveURL(/\/add\?/);
  await expect(page.getByLabel("Link")).toHaveValue("https://example.com/spa");
  await expect(page.getByLabel("Title")).toHaveValue("Spa probe");
  expect(await loads(page)).toBe(before); // login → app was client-side
});

test("s6: logout returns to the login view client-side", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  const before = await loads(page);
  await page.locator('.user-menu-button[aria-label="Admin"]').click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.locator(".auth-card")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  expect(await loads(page)).toBe(before); // logout was pushState, not a reload
});

test("s7: anonymous /share/:token never calls /api/auth/me (INV-1)", async ({ page, browser }) => {
  const created = await page.request.post(`${BASE}/api/share`);
  expect(created.status()).toBe(201);
  const { token } = (await created.json()) as { token: string };

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  try {
    const meCalls: string[] = [];
    anonPage.on("request", (req) => {
      if (req.url().includes("/api/auth/me")) meCalls.push(req.url());
    });
    await anonPage.goto(`${BASE}/share/${token}`);
    await expect(anonPage.getByRole("heading", { name: "Admin's wishlist" })).toBeVisible();
    expect(meCalls).toEqual([]); // THE invariant
  } finally {
    await anon.close();
    await page.request.delete(`${BASE}/api/share`); // leave no live link
  }
});

test("s8: back/forward popstate restores routes", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  await page.locator('.user-menu-button[aria-label="Admin"]').click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Account & Preferences", level: 2 })).toBeVisible();
});
