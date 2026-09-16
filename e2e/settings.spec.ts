import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4599";

// Settings specs run against the same shared server as app.spec.ts (one
// worker, serial). To never disturb that suite's state, every mutation here
// targets a dedicated member user — the bootstrap admin's password and
// display name are left untouched.
const MEMBER = { username: "settings-member", password: "member-pass", newPassword: "member-new-pass" };

test.describe.configure({ mode: "serial" });

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
}

async function openMenu(page: Page, buttonName: string): Promise<void> {
  await page.getByRole("button", { name: buttonName }).click();
}

test.beforeEach(async ({ page }) => {
  await login(page, "admin", "admin-password");
});

test("1: admin on /settings sees Account and Users sections", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.locator("#settings-display-name")).toBeVisible();
  await expect(page.locator("#settings-current-password")).toBeVisible();
  // The user table lists the bootstrap admin.
  const table = page.locator(".admin-table");
  await expect(table.locator("tbody tr", { hasText: "admin" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create user" })).toBeVisible();
});

test("2: member on /settings sees Account only; /api/users is 403", async ({ page, request }) => {
  await page.request.post(`${BASE}/api/users`, {
    data: { username: MEMBER.username, password: MEMBER.password, displayName: "Settings Member" },
  });

  const ctx = await page.context().newPage();
  try {
    await login(ctx, MEMBER.username, MEMBER.password);
    await ctx.goto(`${BASE}/settings`);
    await expect(ctx.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(ctx.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(ctx.getByRole("heading", { name: "Users" })).toHaveCount(0);
    await expect(ctx.locator(".admin-table")).toHaveCount(0);

    const users = await request.get(`${BASE}/api/users`);
    expect(users.status()).toBe(401); // no session on the raw request fixture
  } finally {
    await ctx.close();
  }

  // Same assertion with the member's session: 403, not 401.
  const memberApi = await page.context().newPage();
  try {
    await login(memberApi, MEMBER.username, MEMBER.password);
    const forbidden = await memberApi.request.get(`${BASE}/api/users`);
    expect(forbidden.status()).toBe(403);
  } finally {
    await memberApi.close();
  }
});

test("3: main page has no admin controls", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.locator("#admin-panel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create user" })).toHaveCount(0);
  await expect(page.locator(".admin-table")).toHaveCount(0);

  // The user menu offers Settings instead of an admin scroll entry.
  await openMenu(page, "Admin");
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
});

test("4: last-admin guard surfaces in the settings Users section", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  await expect(page.locator(".admin-table")).toBeVisible();
  const adminRow = page.locator(".admin-table tbody tr", { hasText: "admin" }).first();
  await adminRow.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByText("Cannot deactivate the last active admin")).toBeVisible();
});

test("5: member changes their own password and signs in again", async ({ page }) => {
  const ctx = await page.context().newPage();
  try {
    await login(ctx, MEMBER.username, MEMBER.password);
    await ctx.goto(`${BASE}/settings`);
    await ctx.locator("#settings-current-password").fill(MEMBER.password);
    await ctx.locator("#settings-new-password").fill(MEMBER.newPassword);
    await ctx.locator("#settings-confirm-password").fill(MEMBER.newPassword);
    await ctx.getByRole("button", { name: "Set new password" }).click();
    // Session cleared server-side: the UI returns to the login page.
    await expect(ctx).toHaveURL(/\/login/);

    // Old password fails.
    await ctx.getByLabel("Username").fill(MEMBER.username);
    await ctx.getByLabel("Password").fill(MEMBER.password);
    await ctx.getByRole("button", { name: "Sign in" }).click();
    await expect(ctx.getByText("Invalid username or password.")).toBeVisible();

    // New password works.
    await ctx.getByLabel("Password").fill(MEMBER.newPassword);
    await ctx.getByRole("button", { name: "Sign in" }).click();
    await expect(ctx.getByRole("navigation")).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("6: member changes their display name; header follows", async ({ page }) => {
  const ctx = await page.context().newPage();
  try {
    await login(ctx, MEMBER.username, MEMBER.newPassword);
    await ctx.goto(`${BASE}/settings`);
    await ctx.locator("#settings-display-name").fill("Renamed Member");
    await ctx.getByRole("button", { name: "Save", exact: true }).click();
    await expect(ctx.getByText("Profile updated.")).toBeVisible();

    const me = await ctx.request.get(`${BASE}/api/auth/me`);
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { displayName: string }).displayName).toBe("Renamed Member");

    await ctx.goto(`${BASE}/`);
    await expect(ctx.getByRole("button", { name: "Renamed Member" })).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("7: menu navigates to settings and the brand navigates home", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await openMenu(page, "Admin");
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole("navigation")).toBeVisible();
});

test("8: /settings loads offline from the shell cache", async ({ page, context }) => {
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await context.setOffline(true);
  try {
    await page.goto(`${BASE}/settings`);
    // Cached shell boots from localStorage identity — no browser offline page.
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
