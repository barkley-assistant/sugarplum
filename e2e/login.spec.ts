import { test, expect, type Locator, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4599";

// Login concerns live here from #120 on. Runs in the same serial worker chain
// as the other e2e suites (alphabetical load order: app.spec < auth.spec <
// login.spec < settings.spec < spa.spec). It signs in but mutates no data, so
// it disturbs no other suite.
test.describe.configure({ mode: "serial" });

async function login(page: Page, username: string, password: string): Promise<void> {
  // The SPA /login view bounces already-authenticated visitors to the feed
  // (INV-6), so a login inside a context that already holds a session cookie
  // must start cookieless — the cookie would otherwise win.
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").fill(username);
  // #120: the reveal control's accessible name CONTAINS "password", and
  // getByLabel is a case-insensitive substring match, so this fill must be
  // exact or it resolves to two elements and dies in strict mode.
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();
}

/** Rendered WCAG contrast ratio of an element's text against the first opaque
 *  background behind it (walks ancestors, so transparent rows work). Pair it
 *  with emulateMedia({ colorScheme }) to prove both themes. Same helper as
 *  app.spec.ts. */
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

test("120a: reveal toggles the field type, its name, and keeps the value", async ({ page, context }) => {
  await context.clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/login`);
  await expect(page.locator(".auth-card")).toBeVisible();

  const field = page.getByLabel("Password", { exact: true });
  const reveal = page.getByRole("button", { name: "Show password" });
  await expect(reveal).toBeVisible();
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await expect(field).toHaveAttribute("type", "password");

  // Type a password, then reveal: the VALUE must survive the type swap.
  await field.fill("hunter2hunter2");
  await reveal.click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue("hunter2hunter2");
  await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Hiding again restores type=password with the value still intact.
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveValue("hunter2hunter2");
  await expect(page.getByRole("button", { name: "Show password" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // The control is not a submit button: toggling must not sign in (or
  // otherwise navigate away from the form).
  await expect(page.locator(".auth-card")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  // 44px on both axes (the app-wide touch floor, #116).
  const box = (await reveal.boundingBox())!;
  expect(Math.round(box.width), "reveal target width").toBeGreaterThanOrEqual(44);
  expect(Math.round(box.height), "reveal target height").toBeGreaterThanOrEqual(44);
});

test("120b: the reveal control clears AA in both themes", async ({ page, context }) => {
  await context.clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto(`${BASE}/login`);
    await expect(page.locator(".auth-card")).toBeVisible();

    const reveal = page.getByRole("button", { name: "Show password" });
    await expect(reveal).toBeVisible();
    expect(await contrast(reveal), `${colorScheme}: reveal glyph`).toBeGreaterThanOrEqual(4.5);
  }
});

test("120c: the field still fits and the card does not grow", async ({ page, context }) => {
  await context.clearCookies();
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${BASE}/login`);
  await expect(page.locator(".auth-card")).toBeVisible();

  const username = page.getByLabel("Username");
  const field = page.getByLabel("Password", { exact: true });
  const reveal = page.getByRole("button", { name: "Show password" });
  const card = page.locator(".auth-card");

  // No horizontal page overflow at the narrowest supported width.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    "document horizontal overflow",
  ).toBe(false);

  // The overlay sits INSIDE the card's padding box, not past its right edge.
  const revealBox = (await reveal.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(Math.round(revealBox.x + revealBox.width), "reveal right edge").toBeLessThanOrEqual(
    Math.round(cardBox.x + cardBox.width),
  );

  // The input keeps its full width: reserving the toggle's 44px is padding,
  // not a shrunk box, so the two fields still line up edge to edge.
  const usernameBox = (await username.boundingBox())!;
  const fieldBox = (await field.boundingBox())!;
  expect(Math.round(fieldBox.width), "password field width").toBe(
    Math.round(usernameBox.width),
  );
  expect(Math.round(fieldBox.x), "password field left edge").toBe(Math.round(usernameBox.x));

  // The toggle is inside the field's own box (overlay, not a sibling row).
  expect(Math.round(revealBox.x), "reveal left edge").toBeGreaterThanOrEqual(
    Math.round(fieldBox.x),
  );
  expect(Math.round(revealBox.y), "reveal top edge").toBeGreaterThanOrEqual(
    Math.round(fieldBox.y),
  );
});

test("120d: sign-in still works after revealing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await expect(page.locator(".auth-card")).toBeVisible();

  await page.getByLabel("Username").fill("admin");
  const field = page.getByLabel("Password", { exact: true });
  await field.fill("admin-password");

  // Reveal, check the plain-text value, hide again — then sign in normally.
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue("admin-password");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(field).toHaveAttribute("type", "password");

  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /wishlist/ })).toBeVisible();

  // The shared helper shape is intact too (the PREREQ-1 re-anchor).
  await login(page, "admin", "admin-password");
});
