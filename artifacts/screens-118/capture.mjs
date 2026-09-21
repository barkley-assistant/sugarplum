/**
 * Throwaway evidence harness for sugarplum #118 (NOT product code).
 *
 * Boots the real server on a temp DB, seeds the three price-history states,
 * and captures each at 360/390/430/768/1280 in light + dark, plus the
 * anonymous share sheet at 390. Writes measurements.json next to the PNGs so
 * the PR claims are backed by a runtime DOM probe.
 *
 *   bun capture.mjs <outDir> <port>
 */
import { Database } from "bun:sqlite";
import { chromium } from "/home/agent/projects/barkley-assistant/sugarplum/node_modules/@playwright/test/index.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const REPO = "/home/agent/projects/barkley-assistant/sugarplum";
const OUT = process.argv[2];
const PORT = Number(process.argv[3] ?? 34981);
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTHS = [360, 390, 430, 768, 1280];
const THEMES = ["light", "dark"];
const DAY = 86_400_000;

mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "sugarplum-118-"));
const dbPath = join(dir, "db.sqlite");
const server = spawn("bun", ["src/server/index.ts"], {
  cwd: REPO,
  env: {
    ...process.env,
    SUGARPLUM_DEV: "1",
    SUGARPLUM_PORT: String(PORT),
    SUGARPLUM_DB_PATH: dbPath,
    SUGARPLUM_IMAGES_DIR: join(dir, "images"),
    SUGARPLUM_ADMIN_USERNAME: "admin",
    SUGARPLUM_ADMIN_PASSWORD: "admin-password",
    SUGARPLUM_ADMIN_DISPLAY_NAME: "Admin",
    SUGARPLUM_ENRICH_CONCURRENCY: "1",
    SUGARPLUM_ALLOW_PRIVATE_FETCH: "1",
  },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

for (let i = 0; i < 120; i += 1) {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (res.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
  if (i === 119) throw new Error("server never became healthy");
}

const measurements = [];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`);
await page.getByLabel("Username").fill("admin");
await page.getByLabel("Password").fill("admin-password");
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("heading", { name: /wishlist/ }).first().waitFor();

// 1. drawn, no derivable trend — two same-day observations (the #118 state).
const trendlessRes = await page.request.post(`${BASE}/api/wishlist/items`, {
  data: { title: "Trendless probe", priceCents: "10.00", currency: "GBP" },
});
const trendless = await trendlessRes.json();
const patched = await page.request.patch(`${BASE}/api/wishlist/items/${trendless.id}`, {
  data: { priceCents: "7.50" },
});
if (patched.status() !== 200) throw new Error("trendless patch failed");

// 2. drawn, real signal — a three-day series ending at its low.
const signalRes = await page.request.post(`${BASE}/api/wishlist/items`, {
  data: { title: "Signal probe", priceCents: "9.00", currency: "GBP" },
});
const signal = await signalRes.json();
{
  const db = new Database(dbPath);
  const insert = db.query(
    `INSERT INTO price_history (id, item_id, price_cents, currency, source, observed_at)
     VALUES (?, ?, ?, 'GBP', 'manual', ?)`,
  );
  insert.run(randomUUID(), signal.id, 1200, new Date(Date.now() - 20 * DAY).toISOString());
  insert.run(randomUUID(), signal.id, 1100, new Date(Date.now() - 10 * DAY).toISOString());
  db.close();
}

// 3. empty state — a single observation, so nothing is drawable.
const emptyRes = await page.request.post(`${BASE}/api/wishlist/items`, {
  data: { title: "Empty probe", priceCents: "7.25", currency: "GBP" },
});
const empty = await emptyRes.json();

const shareRes = await page.request.post(`${BASE}/api/share`);
const shareToken = (await shareRes.json()).token;

const settlePage = async () => {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  await page.waitForTimeout(250);
};

/** Runtime DOM probe: what the history card actually renders. */
const cardState = (locator) =>
  locator.evaluate((el) => ({
    caption: el.querySelector(".price-graph-caption")?.textContent ?? null,
    graph: el.querySelector(".price-graph") !== null,
    empty: el.querySelector(".price-history-empty")?.textContent ?? null,
  }));

const shot = async (name, theme, width, itemId) => {
  const file = `${name}-${theme}-${width}.png`;
  await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 });
  await page.goto(`${BASE}/items/${itemId}`);
  const card = page.locator(".detail-history-card");
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await settlePage();
  const state = await cardState(card);
  measurements.push({ surface: name, theme, width, file, ...state });
  await page.screenshot({ path: join(OUT, file) });
};

for (const theme of THEMES) {
  await page.emulateMedia({ colorScheme: theme });
  for (const width of WIDTHS) {
    await shot("drawn", theme, width, trendless.id);
    await shot("signal", theme, width, signal.id);
    await shot("empty", theme, width, empty.id);
  }
}

// Anonymous share sheet: the same card on the second surface, 390 only.
for (const theme of THEMES) {
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const anonPage = await anon.newPage();
  await anonPage.emulateMedia({ colorScheme: theme });
  await anonPage.goto(`${BASE}/share/${shareToken}`);
  const row = anonPage.locator(".item-card", { has: anonPage.getByRole("heading", { name: "Trendless probe" }) });
  await row.getByRole("button", { name: "Trendless probe" }).click();
  const sheet = anonPage.getByRole("dialog", { name: "Trendless probe" });
  await sheet.waitFor();
  const card = sheet.locator(".detail-history-card");
  await card.scrollIntoViewIfNeeded();
  await anonPage.waitForTimeout(300);
  const file = `share-drawn-${theme}-390.png`;
  measurements.push({ surface: "share-drawn", theme, width: 390, file, ...(await cardState(card)) });
  await anonPage.screenshot({ path: join(OUT, file) });
  await anon.close();
}

writeFileSync(join(OUT, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
console.log(`captured ${measurements.length} shots -> ${OUT}`);
for (const m of measurements) {
  console.log(`${m.file}\tgraph=${m.graph}\tcaption=${JSON.stringify(m.caption)}\tempty=${JSON.stringify(m.empty)}`);
}

await browser.close();
server.kill("SIGTERM");
