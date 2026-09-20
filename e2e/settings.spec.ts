import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4599";

// Settings specs run against the same shared server as app.spec.ts (one
// worker, serial). To never disturb that suite's state, every mutation here
// targets a dedicated member user — the bootstrap admin's password and
// display name are left untouched.
const MEMBER = { username: "settings-member", password: "member-pass", newPassword: "member-new-pass" };

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

async function openMenu(page: Page, buttonName: string): Promise<void> {
  await page.locator(`.user-menu-button[aria-label="${buttonName}"]`).click();
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
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
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
    await expect(ctx.getByRole("heading", { name: /wishlist/ })).toBeVisible();
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

    // A10: the toast's manual dismiss is the only early route, so it is a
    // full 44px touch target (rounded: browsers report sub-pixel boxes).
    const dismiss = ctx.getByRole("button", { name: "Dismiss" });
    const dismissBox = await dismiss.boundingBox();
    expect(Math.round(dismissBox?.width ?? 0)).toBeGreaterThanOrEqual(44);
    expect(Math.round(dismissBox?.height ?? 0)).toBeGreaterThanOrEqual(44);
    await dismiss.click();
    await expect(ctx.getByText("Profile updated.")).toHaveCount(0);

    const me = await ctx.request.get(`${BASE}/api/auth/me`);
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { displayName: string }).displayName).toBe("Renamed Member");

    await ctx.goto(`${BASE}/`);
    await expect(ctx.locator('.user-menu-button[aria-label="Renamed Member"]')).toBeVisible();
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
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
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

test("9: preference rows are real switches that round-trip", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as { hintsEnabled: boolean };
  const hints = page.getByRole("switch", { name: /Show unverified price hints/ });
  await expect(page.getByRole("switch", { name: /Track prices daily/ })).toBeVisible();
  await expect(hints).toHaveAttribute("aria-checked", String(me.hintsEnabled));
  // role=menuitemcheckbox is invalid outside a menu: the old role is gone.
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(0);

  await hints.click();
  await expect(hints).toHaveAttribute("aria-checked", String(!me.hintsEnabled));
  await page.reload();
  await expect(page.getByRole("switch", { name: /Show unverified price hints/ }))
    .toHaveAttribute("aria-checked", String(!me.hintsEnabled));

  // Leave the operator's setting as it was for the remaining specs.
  await page.getByRole("switch", { name: /Show unverified price hints/ }).click();
  await expect(page.getByRole("switch", { name: /Show unverified price hints/ }))
    .toHaveAttribute("aria-checked", String(me.hintsEnabled));
});

test("10: heading ladder has one h2 and unique section headings", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(1);
  for (const name of ["Account", "Change password", "Preferences", "Users"]) {
    await expect(page.getByRole("heading", { name, exact: true, level: 3 })).toHaveCount(1);
  }
  // The Users section is named once (h3), not twice.
  await expect(page.getByRole("heading", { name: "Users", level: 2 })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Create user", level: 4 })).toBeVisible();

  // No level is skipped anywhere on the page.
  const levels = await page.evaluate(() =>
    Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) => Number(el.tagName[1])),
  );
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i] - levels[i - 1], `heading ladder ${levels[i - 1]} -> ${levels[i]}`)
      .toBeLessThanOrEqual(1);
  }
});

test("11: settings submits carry the amethyst pill grammar", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  for (const name of ["Save", "Set new password"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveClass(/settings-submit/);
    const rendered = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        radius: cs.borderRadius,
        weight: Number(cs.fontWeight),
        height: el.getBoundingClientRect().height,
      };
    });
    expect(rendered.radius).toBe("999px"); // --r-full
    expect(rendered.weight).toBeGreaterThanOrEqual(600);
    expect(rendered.height).toBeGreaterThanOrEqual(44);
  }
});

test("12: create-user row shares its slot at every width, both themes (#97)", async ({ page }) => {
  /** The admin create-user row: the row plus its three fields. */
  const createRow = () =>
    page.evaluate(() => {
      const row = document.getElementById("new-username")?.closest(".field-row");
      if (!row) throw new Error("create-user field-row missing");
      const rr = row.getBoundingClientRect();
      const box = (id: string) => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`#${id} missing`);
        const r = el.getBoundingClientRect();
        return { width: r.width, left: r.left };
      };
      return {
        rowWidth: rr.width,
        rowLeft: rr.left,
        username: box("new-username"),
        displayName: box("new-display-name"),
        password: box("new-password"),
      };
    });

  const passwordRow = () =>
    page.evaluate(() => {
      const row = document.getElementById("settings-new-password")?.closest(".field-row");
      if (!row) throw new Error("settings password field-row missing");
      const rr = row.getBoundingClientRect();
      const box = (id: string) => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`#${id} missing`);
        return el.getBoundingClientRect().width;
      };
      return {
        rowWidth: rr.width,
        next: box("settings-new-password"),
        confirm: box("settings-confirm-password"),
      };
    });

  const docOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  const openSettings = async (width: number) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/settings`);
    await expect(page.getByRole("heading", { name: "Create user", level: 4 })).toBeVisible();
  };

  for (const width of [360, 390, 430, 768, 1024, 1280]) {
    await openSettings(width);
    const m = await createRow();
    const fields = [
      ["username", m.username],
      ["display name", m.displayName],
      ["password", m.password],
    ] as const;
    if (width <= 430) {
      // Mobile: all three stack full-width (the mobile grid spans every .grow).
      // On main Password sat in one grid cell at 133-168px vs the row's 278-348.
      for (const [name, field] of fields) {
        expect(Math.abs(field.width - m.rowWidth), `${name} spans the row at ${width}px`)
          .toBeLessThanOrEqual(1);
      }
    } else {
      // Desktop: three equal slot-derived thirds. On main Password pinned to the
      // 231px input metric beside two 215px siblings.
      const widths = fields.map(([, field]) => field.width);
      expect(Math.max(...widths) - Math.min(...widths), `create-user fields equal at ${width}px`)
        .toBeLessThanOrEqual(1);
    }
    expect(await docOverflow(), `document overflow at ${width}px`).toBe(false);

    // Witness: the settings password row (the reference pattern) is unchanged.
    const pw = await passwordRow();
    if (width <= 430) {
      expect(Math.abs(pw.next - pw.rowWidth), `new password spans the row at ${width}px`)
        .toBeLessThanOrEqual(1);
      expect(Math.abs(pw.confirm - pw.rowWidth), `confirm password spans the row at ${width}px`)
        .toBeLessThanOrEqual(1);
    } else {
      expect(Math.abs(pw.next - pw.confirm), `settings password pair equal at ${width}px`)
        .toBeLessThanOrEqual(1);
    }
  }

  // Both schemes render the same geometry at the phone width (the stylesheet
  // has no scheme-specific layout rule, and this proves it).
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openSettings(390);
    const m = await createRow();
    for (const [name, field] of [
      ["username", m.username],
      ["display name", m.displayName],
      ["password", m.password],
    ] as const) {
      expect(Math.abs(field.width - m.rowWidth), `${name} spans the row at 390px ${scheme}`)
        .toBeLessThanOrEqual(1);
    }
    expect(await docOverflow(), `document overflow at 390px ${scheme}`).toBe(false);
  }
});
