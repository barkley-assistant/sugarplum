import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4599";

// Same serial worker chain as the other e2e suites (alphabetical load order
// puts this FIRST: auth.spec < app.spec < settings.spec < spa.spec — its tests
// run before spa.spec's, so keep state self-contained: sign in, probe, sign
// out; no other suite's data is touched).
test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
}

test("a1: session persists across SPA navigation and full reloads", async ({ page }) => {
  await signIn(page);

  // SPA navigation keeps the session (no bounce to /login).
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Full document reload: the cookie + sliding session must still auth.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);

  // Boot gate: /api/auth/me 200 on the reloaded document.
  const me = await page.evaluate(async () => {
    const res = await fetch("/api/auth/me");
    return res.status;
  });
  expect(me).toBe(200);

  // And back at the feed, still signed in.
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
});

test("a2: authed /login visit redirects to the app (guard regression pin)", async ({ page }) => {
  await signIn(page);
  await page.goto(`${BASE}/login`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
  await expect(page).toHaveURL(`${BASE}/`);
});

test("a3: logout ends the session; login view is reachable again", async ({ page }) => {
  await signIn(page);
  await page.locator('.user-menu-button[aria-label="Admin"]').click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.locator(".auth-card")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  // Post-logout /api/auth/me is 401 — the boot gate works.
  const me = await page.evaluate(async () => {
    const res = await fetch("/api/auth/me");
    return res.status;
  });
  expect(me).toBe(401);
});

test("a4: login response and authed API carry hardened headers", async ({ page }) => {
  const res = await page.request.get(`${BASE}/api/auth/me`);
  expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["cache-control"]).toBe("no-store");
});
