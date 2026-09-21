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

/** #98: the admin user-management surface is opt-in and the e2e server boots a
 *  fresh DB every run, so a spec that needs the Users screens seeds the
 *  preference through its own session first (page.request shares the browser
 *  context's cookie). Callers re-navigate afterwards so the SPA reboots the
 *  identity. */
async function setUserManagement(page: Page, on: boolean): Promise<void> {
  const res = await page.request.put(`${BASE}/api/auth/me/settings`, {
    data: { showUserManagement: on },
  });
  expect(res.status()).toBe(200);
}

/** The three settings screens' page headings (#96): one h2 per screen. */
const ACCOUNT = "Account & Preferences";
const USERS = "Users";
const NEW_USER = "New user";

/** Document-load counter (INV-4), same probe spa.spec uses: a soft navigation
 *  never reloads the document, so the counter only moves on a real load. */
async function loads(page: Page): Promise<number> {
  return page.evaluate(() => Number(sessionStorage.getItem("docLoads") ?? 0));
}

test.beforeEach(async ({ page }) => {
  await login(page, "admin", "admin-password");
});

test("1: admin /settings is Account & Preferences; the Users entry opens the table", async ({ page }) => {
  // #98 baseline for this spec: start with the preference explicitly off, so
  // the assertions below do not depend on whatever earlier specs left behind.
  await setUserManagement(page, false);
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeVisible();
  await expect(page.locator("#settings-display-name")).toBeVisible();
  await expect(page.locator("#settings-current-password")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preferences", level: 3 })).toBeVisible();

  // The admin table and the create-user form no longer live on this screen.
  await expect(page.locator(".admin-table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create user" })).toHaveCount(0);

  // #98: off means no entry row — but the admin still owns the opt-in switch,
  // which is the only way back.
  const usersSwitch = page.getByRole("switch", { name: "Show user management" });
  await expect(usersSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: USERS, exact: true })).toHaveCount(0);

  // The switch reveals the entry in the same session (no reload needed).
  await usersSwitch.click();
  await expect(usersSwitch).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: USERS, exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/settings/users`);
  await expect(page.getByRole("heading", { name: USERS, level: 2 })).toBeVisible();

  // The user table lists the bootstrap admin; the screen head carries the
  // page-level New user action and the way back.
  const table = page.locator(".admin-table");
  await expect(table.locator("tbody tr", { hasText: "admin" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: NEW_USER, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Account & Preferences" })).toBeVisible();
});

test("2: member: Account & Preferences only; users screens bounce; /api/users is 403", async ({ page, request }) => {
  await page.request.post(`${BASE}/api/users`, {
    data: { username: MEMBER.username, password: MEMBER.password, displayName: "Settings Member" },
  });

  const ctx = await page.context().newPage();
  try {
    await login(ctx, MEMBER.username, MEMBER.password);
    await ctx.goto(`${BASE}/settings`);
    await expect(ctx.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();
    await expect(ctx.getByRole("heading", { name: "Account", level: 3 })).toBeVisible();
    await expect(ctx.getByRole("heading", { name: "Preferences", level: 3 })).toBeVisible();

    // No admin surface anywhere on the member's account screen.
    await expect(ctx.getByRole("button", { name: USERS, exact: true })).toHaveCount(0);
    await expect(ctx.locator(".admin-table")).toHaveCount(0);

    // Deep links to the admin screens land back on /settings (the client gate
    // replaces the history entry, so Back cannot return to them either).
    for (const path of ["/settings/users", "/settings/users/new"]) {
      await ctx.goto(`${BASE}${path}`);
      await expect(ctx).toHaveURL(`${BASE}/settings`);
      await expect(ctx.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();
      await expect(ctx.locator(".admin-table")).toHaveCount(0);
    }

    // The server is the enforcement — the redirect above is only UX.
    const users = await request.get(`${BASE}/api/users`);
    expect(users.status()).toBe(401); // no session on the raw request fixture
    const forbidden = await ctx.request.get(`${BASE}/api/users`);
    expect(forbidden.status()).toBe(403); // the member's own session: 403, not 401

    // #98: a member CAN flip the preference on their own row (the settings
    // route is role-agnostic like its two siblings) and still gets no admin UI:
    // the switch is admin-only and the entry ANDs isAdmin, while /api/users
    // keeps 403ing.
    const optedIn = await ctx.request.put(`${BASE}/api/auth/me/settings`, {
      data: { showUserManagement: true },
    });
    expect(optedIn.status()).toBe(200);
    await ctx.goto(`${BASE}/settings`);
    await expect(ctx.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();
    await expect(ctx.getByRole("switch", { name: "Show user management" })).toHaveCount(0);
    await expect(ctx.getByRole("button", { name: USERS, exact: true })).toHaveCount(0);
    await ctx.goto(`${BASE}/settings/users`);
    await expect(ctx).toHaveURL(`${BASE}/settings`);
  } finally {
    await ctx.close();
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

test("4: last-admin guard surfaces on the Users screen", async ({ page }) => {
  await setUserManagement(page, true);
  await page.goto(`${BASE}/settings/users`);
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
  await expect(page.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();

  await page.getByRole("link", { name: "Back to list" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
});

test("8: all three settings routes load offline from the shell cache", async ({ page, context }) => {
  // #98: the admin screens are opt-in, so seed the preference for the cached
  // identity both passes below boot from.
  await setUserManagement(page, true);
  const screens = [
    { path: "/settings", heading: ACCOUNT },
    { path: "/settings/users", heading: USERS },
    { path: "/settings/users/new", heading: NEW_USER },
  ];

  // Online first: the shell cache installs and the identity is stored.
  for (const screen of screens) {
    await page.goto(`${BASE}${screen.path}`);
    await expect(page.getByRole("heading", { name: screen.heading, level: 2 })).toBeVisible();
  }

  await context.setOffline(true);
  try {
    for (const screen of screens) {
      await page.goto(`${BASE}${screen.path}`);
      // Cached shell boots from the stored identity — no browser offline page.
      await expect(page.getByRole("heading", { name: screen.heading, level: 2 })).toBeVisible();
    }
  } finally {
    await context.setOffline(false);
  }
});

test("9: preference switches are real switches and round-trip (click + keyboard)", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  const me = (await (await page.request.get(`${BASE}/api/auth/me`)).json()) as {
    hintsEnabled: boolean;
    showUserManagement: boolean;
  };
  const hints = page.getByRole("switch", { name: /Show unverified price hints/ });
  await expect(page.getByRole("switch", { name: /Track prices daily/ })).toBeVisible();
  await expect(hints).toHaveAttribute("aria-checked", String(me.hintsEnabled));
  // The On/Off text affordance the old rows carried is gone: the row parses as
  // one switch, and only the track communicates the state (#96).
  await expect(page.locator(".menu-item-state")).toHaveCount(0);
  // #98 added the admin-only third switch; the geometry contract is shared.
  const adminUi = page.getByRole("switch", { name: "Show user management" });
  await expect(adminUi).toBeVisible();
  await expect(adminUi).toHaveAttribute("aria-checked", String(me.showUserManagement));
  await expect(page.locator(".toggle-row .switch-track")).toHaveCount(3);

  // The visual: a 44x26 track whose thumb sits left when off and slides to the
  // right when on, driven by aria-checked — not an On/Off text row (#96).
  const track = hints.locator(".switch-track");
  const box = await track.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(44);
  expect(Math.round(box?.height ?? 0)).toBe(26);
  const thumbX = () =>
    track.evaluate((el) => {
      const transform = getComputedStyle(el, "::after").transform;
      return transform === "none" ? 0 : Number(transform.split(",")[4]);
    });
  const trackFill = () => track.evaluate((el) => getComputedStyle(el).backgroundColor);

  const startX = me.hintsEnabled ? 18 : 0;
  await expect.poll(thumbX).toBe(startX);
  const fillAtStart = await trackFill();

  await hints.click();
  await expect(hints).toHaveAttribute("aria-checked", String(!me.hintsEnabled));
  await expect.poll(thumbX).toBe(startX === 0 ? 18 : 0);
  expect(await trackFill()).not.toBe(fillAtStart);

  // Keyboard: Space on the focused row toggles it (native button semantics).
  await hints.focus();
  await page.keyboard.press("Space");
  await expect(hints).toHaveAttribute("aria-checked", String(me.hintsEnabled));
  await page.reload();
  await expect(page.getByRole("switch", { name: /Show unverified price hints/ }))
    .toHaveAttribute("aria-checked", String(me.hintsEnabled));

  // Leave the operator's setting as it was for the remaining specs.
  await page.getByRole("switch", { name: /Show unverified price hints/ }).click();
  await expect(page.getByRole("switch", { name: /Show unverified price hints/ }))
    .toHaveAttribute("aria-checked", String(!me.hintsEnabled));
  await page.getByRole("switch", { name: /Show unverified price hints/ }).click();
  await expect(page.getByRole("switch", { name: /Show unverified price hints/ }))
    .toHaveAttribute("aria-checked", String(me.hintsEnabled));
});

test("10: heading ladder — one h2 per settings screen", async ({ page }) => {
  /** No level is skipped anywhere on the page (the brand mark is the h1). */
  const assertNoSkippedLevels = async () => {
    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) => Number(el.tagName[1])),
    );
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1], `heading ladder ${levels[i - 1]} -> ${levels[i]}`)
        .toBeLessThanOrEqual(1);
    }
  };

  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: ACCOUNT, level: 2, exact: true })).toHaveCount(1);
  for (const name of ["Account", "Change password", "Preferences"]) {
    await expect(page.getByRole("heading", { name, exact: true, level: 3 })).toHaveCount(1);
  }
  // The admin table and its h4 left this screen.
  await expect(page.getByRole("heading", { name: "Create user" })).toHaveCount(0);
  await assertNoSkippedLevels();

  // #98: the Users screens are opt-in; seed before climbing their ladders.
  await setUserManagement(page, true);
  await page.goto(`${BASE}/settings/users`);
  await expect(page.getByRole("heading", { name: USERS, level: 2, exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: USERS, exact: true })).toHaveCount(1); // h2 only
  await expect(page.getByRole("heading", { name: "Create user" })).toHaveCount(0);
  await assertNoSkippedLevels();

  await page.goto(`${BASE}/settings/users/new`);
  await expect(page.getByRole("heading", { name: NEW_USER, level: 2, exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: NEW_USER, exact: true })).toHaveCount(1); // h2 only
  await assertNoSkippedLevels();
});

test("11: settings CTAs — one primary pill, one quiet secondary (#131)", async ({ page }) => {
  await page.goto(`${BASE}/settings`);

  // Save keeps the amethyst pill grammar: it is the page's single primary CTA.
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeVisible();
  await expect(save).toHaveClass(/settings-submit/);
  const saveRendered = await save.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      radius: cs.borderRadius,
      weight: Number(cs.fontWeight),
      height: el.getBoundingClientRect().height,
    };
  });
  expect(saveRendered.radius).toBe("999px"); // --r-full
  expect(saveRendered.weight).toBeGreaterThanOrEqual(600);
  expect(saveRendered.height).toBeGreaterThanOrEqual(44);

  // The password submit is demoted to the shared secondary grammar — a quiet,
  // bordered control rather than a second full-width plum pill.
  const password = page.getByRole("button", { name: "Set new password", exact: true });
  await expect(password).toBeVisible();
  await expect(password).not.toHaveClass(/settings-submit/);
  const quiet = await password.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      radius: cs.borderRadius,
      borderWidth: parseFloat(cs.borderTopWidth),
      borderColor: cs.borderTopColor,
      background: cs.backgroundColor,
      height: el.getBoundingClientRect().height,
      surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
      surface2: getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim(),
      text3: getComputedStyle(document.documentElement).getPropertyValue("--text-3").trim(),
      pillToken: getComputedStyle(document.documentElement).getPropertyValue("--plum-600").trim(),
    };
  });
  // Token values come back as authored (the bundler collapses #ffffff to
  // #fff), so normalise the shorthand before comparing with a computed rgb().
  const rgb = (value: string): string => {
    const hex = value.trim().replace("#", "");
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return `rgb(${r}, ${g}, ${b})`;
  };
  expect(quiet.radius).toBe("8px"); // --r-control, NOT the pill
  expect(quiet.borderWidth).toBe(1);
  // Quiet grammar, not a second primary: no plum, no pill.
  expect(quiet.borderColor).not.toBe(rgb(quiet.pillToken));
  expect(quiet.background).toBe(rgb(quiet.surface));
  expect(quiet.height).toBeGreaterThanOrEqual(44);
  // Hover is a visible state change, not a no-op.
  await password.hover();
  await expect
    .poll(() => password.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(rgb(quiet.surface2));
  await expect
    .poll(() => password.evaluate((el) => getComputedStyle(el).borderTopColor))
    .toBe(rgb(quiet.text3));

  // #131: the page heading is the page scale (22px), not the feed's
  // display-scale list title (28px).
  const settingsHeading = page.getByRole("heading", { name: ACCOUNT, level: 2, exact: true });
  expect(await settingsHeading.evaluate((el) => getComputedStyle(el).fontSize)).toBe("22px");
  await page.goto(`${BASE}/`);
  const feedTitle = page.locator(".list-switcher .page-title");
  await expect(feedTitle).toBeVisible();
  expect(await feedTitle.evaluate((el) => getComputedStyle(el).fontSize)).toBe("28px");

  // The OFF switch track is a control boundary too (WCAG 1.4.11, 3:1) — it
  // rides the same --border-field token as the form fields.
  await setUserManagement(page, false);
  await page.goto(`${BASE}/settings`);
  const offTrack = page.locator('.toggle-row[aria-checked="false"] .switch-track').first();
  await expect(offTrack).toBeVisible();
  await page.mouse.move(2, 2); // resting state: :hover darkens this border
  const boundary = await offTrack.evaluate((el) => {
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
  expect(boundary, "off switch track boundary").toBeGreaterThanOrEqual(3);
});

test("12: create-user row shares its slot at every width, both themes (#97)", async ({ page }) => {
  // #98: /settings/users/new is behind the opt-in preference.
  await setUserManagement(page, true);
  /** The create-user row: the row plus its three fields. */
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
        rowRight: rr.right,
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

  const openCreateUser = async (width: number) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/settings/users/new`);
    await expect(page.getByRole("heading", { name: NEW_USER, level: 2 })).toBeVisible();
    await expect(page.locator("#new-username")).toBeVisible();
  };

  for (const width of [360, 390, 430, 768, 1024, 1280]) {
    await openCreateUser(width);
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
        expect(Math.abs(field.left - m.rowLeft), `${name} is flush left at ${width}px`)
          .toBeLessThanOrEqual(1);
      }
    } else {
      // Desktop: three equal slot-derived thirds. On main Password pinned to the
      // 231px input metric beside two 215px siblings.
      const widths = fields.map(([, field]) => field.width);
      expect(Math.max(...widths) - Math.min(...widths), `create-user fields equal at ${width}px`)
        .toBeLessThanOrEqual(1);
      // The row reads left to right with no overlap and no gap at the right edge.
      expect(Math.abs(m.username.left - m.rowLeft), `row starts at the first field at ${width}px`)
        .toBeLessThanOrEqual(1);
      expect(m.username.left, `username before display name at ${width}px`)
        .toBeLessThan(m.displayName.left);
      expect(m.displayName.left, `display name before password at ${width}px`)
        .toBeLessThan(m.password.left);
      expect(
        Math.abs(m.password.left + m.password.width - m.rowRight),
        `row ends at the last field at ${width}px`,
      ).toBeLessThanOrEqual(1);
    }
    expect(await docOverflow(), `document overflow at ${width}px`).toBe(false);

    // #116: the Admin checkbox row is the control — the <label> wraps the input,
    // so the whole row is the touch target. 21px on main; the 44px floor now
    // lives on the row while the native box grows to a 20px visual (the switch
    // thumb's size) so the tick reads at arm's length.
    const checkbox = await page.evaluate(() => {
      const label = document.querySelector(".checkbox");
      const input = label?.querySelector("input");
      if (!label || !input) throw new Error("admin checkbox missing");
      const lr = label.getBoundingClientRect();
      const ir = input.getBoundingClientRect();
      return { label: Math.round(lr.height * 10) / 10, box: Math.round(ir.width), boxHeight: Math.round(ir.height) };
    });
    expect(checkbox.label, `admin checkbox row at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(checkbox.box, `admin checkbox box at ${width}px`).toBe(20);
    expect(checkbox.boxHeight, `admin checkbox box height at ${width}px`).toBe(20);

    // Witness: the settings password row (the reference pattern, which stayed
    // on /settings) is unchanged.
    await page.goto(`${BASE}/settings`);
    await expect(page.locator("#settings-new-password")).toBeVisible();
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
    await openCreateUser(390);
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

test("13: the settings area navigates client-side; the bar's Settings stays exact", async ({ page }) => {
  await setUserManagement(page, true);
  await page.addInitScript(() => {
    sessionStorage.setItem("docLoads", String(Number(sessionStorage.getItem("docLoads") ?? 0) + 1));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();
  const before = await loads(page);

  const bar = page.getByRole("navigation", { name: "Primary actions" });
  const barSettings = bar.getByRole("button", { name: "Settings" });
  // On /settings the bar destination IS the current screen.
  await expect(barSettings).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: USERS, exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/settings/users`);
  await expect(page.getByRole("heading", { name: USERS, level: 2 })).toBeVisible();

  // #96 keeps the accent EXACT: on a sub-route the Settings button is not
  // "current", so it stays a live way back to the account screen.
  await expect(barSettings).not.toHaveAttribute("aria-current");
  await barSettings.click();
  await expect(page).toHaveURL(`${BASE}/settings`);
  await expect(barSettings).toHaveAttribute("aria-current", "page");

  // Forward again through the area, then back through the pushState chain.
  await page.getByRole("button", { name: USERS, exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/settings/users`);
  await page.getByRole("button", { name: NEW_USER, exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/settings/users/new`);
  await expect(page.getByRole("heading", { name: NEW_USER, level: 2 })).toBeVisible();

  await page.getByRole("button", { name: "Back to Users" }).click();
  await expect(page).toHaveURL(`${BASE}/settings/users`);

  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/settings/users/new`);
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/settings/users`);
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/settings`);
  await expect(page.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();

  // INV-4: not one of those navigations loaded the document.
  expect(await loads(page)).toBe(before);
});

test("14: user management is opt-in — a fresh admin starts hidden (#98)", async ({ page, browser }) => {
  // A BRAND-NEW admin row proves the default: the bootstrap admin's preference
  // has been seeded by earlier specs, so only a fresh row is order-independent.
  const username = `fresh-admin-${Math.random().toString(36).slice(2, 8)}`;
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username, password: "fresh-admin-pass", displayName: "Fresh Admin", isAdmin: true },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;

  // A separate context so the bootstrap admin's session (and the cleanup
  // DELETE below) survives.
  const ctx = await browser.newContext();
  try {
    const fresh = await ctx.newPage();
    await login(fresh, username, "fresh-admin-pass");

    // Default OFF: the opt-in switch is there (it belongs to every admin)...
    await fresh.goto(`${BASE}/settings`);
    await expect(fresh.getByRole("heading", { name: ACCOUNT, level: 2 })).toBeVisible();
    const toggle = fresh.getByRole("switch", { name: "Show user management" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // ...and the management surface is absent, entry row included.
    await expect(fresh.getByRole("button", { name: USERS, exact: true })).toHaveCount(0);
    await fresh.goto(`${BASE}/settings/users`);
    await expect(fresh).toHaveURL(`${BASE}/settings`);
    await expect(fresh.locator(".admin-table")).toHaveCount(0);

    // Opting in reveals it, entry and deep link alike.
    await fresh.getByRole("switch", { name: "Show user management" }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await fresh.getByRole("button", { name: USERS, exact: true }).click();
    await expect(fresh).toHaveURL(`${BASE}/settings/users`);
    await expect(fresh.locator(".admin-table")).toBeVisible();

    // Opting back out hides it again — the choice is persisted, and the deep
    // link bounces once more.
    await fresh.getByRole("button", { name: "Back to Account & Preferences" }).click();
    await fresh.getByRole("switch", { name: "Show user management" }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(fresh.getByRole("button", { name: USERS, exact: true })).toHaveCount(0);
    await fresh.goto(`${BASE}/settings/users`);
    await expect(fresh).toHaveURL(`${BASE}/settings`);
  } finally {
    await ctx.close();
    // Leave the board exactly as found: the last-admin guard specs depend on
    // the bootstrap admin being the only active one. No status assertion here,
    // so a real failure above is never masked.
    await page.request.delete(`${BASE}/api/users/${id}`);
  }
});
