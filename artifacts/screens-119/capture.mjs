/**
 * Throwaway evidence harness for sugarplum #119 (NOT product code).
 *
 * Boots the real server on a temp DB with a MIXED list (one scraped row with a
 * real image, one failed row, two bare manual rows) and captures the three
 * ProductRow surfaces — owner feed, guest (other-user) feed, anonymous share —
 * plus reorder mode, at 360/390/430/768/1280 in light + dark.
 *
 * Writes measurements.json next to the PNGs so every "the titles line up" claim
 * is backed by a runtime DOM probe (title x, frame kind, frame box).
 *
 *   bun capture.mjs <outDir> <port>
 */
import { chromium } from "/home/agent/projects/barkley-assistant/sugarplum/node_modules/@playwright/test/index.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { spawn } from "node:child_process";

const REPO = "/home/agent/projects/barkley-assistant/sugarplum";
const OUT = process.argv[2];
const PORT = Number(process.argv[3] ?? (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTHS = [360, 390, 430, 768, 1280];
const THEMES = ["light", "dark"];

mkdirSync(OUT, { recursive: true });

// 0. Build the web bundle from the CURRENT working tree (what is captured).
await new Promise((resolve, reject) => {
  const build = spawn("bun", ["run", "build:web"], {
    cwd: REPO,
    env: { ...process.env, SUGARPLUM_DEV: "0" },
    stdio: "inherit",
  });
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
});

// 1. Local fixture shop: the repo's og:meta page + a REAL, decodable JPEG
//    (a 10-byte stub never decodes, and a Chromium img that fails to decode
//    swaps itself to the fallback well — which would erase the very difference
//    being captured). `thumb.jpg` is a neutral 300x300 gradient + disc shipped
//    beside this harness, so the run is deterministic and needs no tooling.
const FIXTURE_JPEG = readFileSync(new URL("./thumb.jpg", import.meta.url));
const fixtureHtml = readFileSync(join(REPO, "tests/fixtures/shopify-local.html"), "utf8");
const fixture = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture.local");
  if (url.pathname === "/img/trio.jpg") {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(FIXTURE_JPEG);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(fixtureHtml);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;

// 2. The real server on a temp DB.
try {
  const squatter = await fetch(`${BASE}/api/health`);
  if (squatter.ok) throw new Error(`port ${PORT} already serves a healthy app — refusing to capture`);
} catch (error) {
  if (error instanceof Error && error.message.includes("refusing")) throw error;
  /* nothing listening: expected */
}
const dir = mkdtempSync(join(tmpdir(), "sugarplum-119-"));
const server = spawn("bun", ["src/server/index.ts"], {
  cwd: REPO,
  env: {
    ...process.env,
    SUGARPLUM_DEV: "1",
    SUGARPLUM_PORT: String(PORT),
    SUGARPLUM_DB_PATH: join(dir, "db.sqlite"),
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

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`);
await page.getByLabel("Username").fill("admin");
await page.getByLabel("Password").fill("admin-password");
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("heading", { name: /wishlist/ }).first().waitFor();

const me = await (await page.request.get(`${BASE}/api/auth/me`)).json();
const listItems = async () =>
  (await (await page.request.get(`${BASE}/api/users/${me.id}/wishlist`)).json());

/** Seed one item and wait for the enrichment state it needs. */
async function seed(data, want, label) {
  const res = await page.request.post(`${BASE}/api/wishlist/items`, { data });
  if (res.status() !== 201) throw new Error(`seed ${label} -> ${res.status()}`);
  const item = await res.json();
  for (let i = 0; i < 80; i += 1) {
    const row = (await listItems()).find((entry) => entry.id === item.id);
    if (row && want(row)) return row;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`seed ${label}: never reached the expected state`);
}

// 3. The mixed list the issue is about, in feed order.
//    (a) a FAILED scrape — the issue's "Running socks" row.
const failed = await seed({ url: "http://127.0.0.1:1/running-socks" }, (r) => r.fetchState === "failed", "failed");
await page.request.patch(`${BASE}/api/wishlist/items/${failed.id}`, { data: { title: "Running socks" } });
//    (b) a scraped row with a real downloaded image — the indented row.
const imaged = await seed({ url: `${fixtureUrl}/product` }, (r) => Boolean(r.imagePath), "imaged");
//    (c) two bare manual rows.
const mug = await seed({ title: "Manual mug", priceCents: "12.50", currency: "GBP" }, (r) => r.fetchState === "complete", "mug");
const lamp = await seed({ title: "Desk lamp", priceCents: "34.00", currency: "GBP" }, (r) => r.fetchState === "complete", "lamp");

const shareToken = (await (await page.request.post(`${BASE}/api/share`)).json()).token;

/** Runtime DOM probe: one entry per rendered row. */
const rowProbe = (p) =>
  p.evaluate(() =>
    Array.from(document.querySelectorAll(".item-list .item-card")).map((el) => {
      const title = el.querySelector(".product-row-title");
      const img = el.querySelector(".product-img");
      const well = el.querySelector(".product-img-fallback");
      const frame = img ?? well;
      const rect = frame?.getBoundingClientRect();
      const round = (n) => Math.round(n * 100) / 100;
      return {
        title: (title?.textContent ?? "").trim(),
        frame: img ? "img" : well ? "well" : null,
        frameW: rect ? round(rect.width) : null,
        frameH: rect ? round(rect.height) : null,
        titleX: title ? round(title.getBoundingClientRect().left) : null,
        rowLeft: round(el.getBoundingClientRect().left),
      };
    }),
  );

const settle = async (p) => {
  await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await p.waitForTimeout(250);
};

const measurements = [];

/** Navigate (unless already on the right list) + settle + probe + shoot one
 *  surface state at one viewport. `url: null` re-measures the CURRENT page —
 *  the guest feed holds the switched-to list in memory, so a goto would drop
 *  it back to the guest's own (empty) list. */
async function shot(p, surface, theme, width, url) {
  await p.setViewportSize({ width, height: width >= 768 ? 900 : 844 });
  if (url) await p.goto(url);
  await p.locator(".item-list .item-card").first().waitFor();
  await settle(p);
  const rows = await rowProbe(p);
  const titleXs = rows.map((r) => r.titleX).filter((x) => x !== null);
  const file = `${surface}-${theme}-${width}.png`;
  measurements.push({
    surface,
    theme,
    width,
    file,
    rows,
    titleXSpread: titleXs.length ? Math.round((Math.max(...titleXs) - Math.min(...titleXs)) * 100) / 100 : null,
    docOverflow: await p.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  });
  await p.screenshot({ path: join(OUT, file) });
  console.log(`  -> ${file} spread=${titleXs.length ? Math.round((Math.max(...titleXs) - Math.min(...titleXs)) * 100) / 100 : "n/a"}`);
}

// 4. Owner feed — the primary surface: five widths × both schemes.
for (const theme of THEMES) {
  await page.emulateMedia({ colorScheme: theme });
  for (const width of WIDTHS) {
    await shot(page, "owner", theme, width, `${BASE}/`);
  }
}

// 5. Reorder mode (owner, 390, light): the handle column plus the thumb frame.
{
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await page.locator(".item-card.is-reordering").first().waitFor();
  await settle(page);
  const rows = await rowProbe(page);
  const titleXs = rows.map((r) => r.titleX).filter((x) => x !== null);
  measurements.push({
    surface: "reorder",
    theme: "light",
    width: 390,
    file: "reorder-light-390.png",
    rows,
    titleXSpread: Math.round((Math.max(...titleXs) - Math.min(...titleXs)) * 100) / 100,
    docOverflow: false,
  });
  await page.screenshot({ path: join(OUT, "reorder-light-390.png") });
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

// 6. Guest (other-user) feed: a second account viewing Admin's list.
{
  const created = await page.request.post(`${BASE}/api/users`, {
    data: { username: "guest", password: "guest-pass", displayName: "Guest" },
  });
  if (created.status() !== 201) throw new Error(`guest user -> ${created.status()}`);
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(`${BASE}/login`);
  await guest.getByLabel("Username").fill("guest");
  await guest.getByLabel("Password").fill("guest-pass");
  await guest.getByRole("button", { name: "Sign in" }).click();
  await guest.getByRole("heading", { name: /wishlist/ }).first().waitFor();
  await guest.getByRole("button", { name: /wishlist/ }).click();
  await guest.getByRole("menuitemradio", { name: /Admin/ }).click();
  await guest.getByRole("heading", { name: "Admin's wishlist" }).waitFor();
  for (const theme of THEMES) {
    await guest.emulateMedia({ colorScheme: theme });
    for (const width of [390, 1280]) {
      await shot(guest, "guest", theme, width, null);
    }
  }
  await guestContext.close();
}

// 7. Anonymous share view — the third ProductRow consumer.
for (const theme of THEMES) {
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const anonPage = await anon.newPage();
  await anonPage.emulateMedia({ colorScheme: theme });
  for (const width of [390, 1280]) {
    await shot(anonPage, "share", theme, width, `${BASE}/share/${shareToken}`);
  }
  await anon.close();
}

writeFileSync(join(OUT, "measurements.json"), `${JSON.stringify({ seeds: { failed: failed.id, imaged: imaged.id, mug: mug.id, lamp: lamp.id }, measurements }, null, 2)}\n`);
console.log(`captured ${measurements.length} shots -> ${OUT}`);
for (const m of measurements) {
  console.log(
    `${m.file}\tspread=${m.titleXSpread}\toverflow=${m.docOverflow}\t${m.rows
      .map((r) => `${r.title}[${r.frame ?? "none"} ${r.frameW}px x=${r.titleX}]`)
      .join(" | ")}`,
  );
}

await browser.close();
fixture.close();
server.kill("SIGTERM");

/** An unused 127.0.0.1 port, so a stale listener from an earlier run can never
 *  serve the captures (or a different code revision). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createProbeServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
