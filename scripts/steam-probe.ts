// Read-only probe: run the REAL production pipeline against a live Steam store
// page and print one verifiable line. Manual evidence only — this is NOT a test
// (no live network in CI; tests/fixtures/steam-*.html + tests/scraper cover the
// extractor offline).
//
//   bun run scripts/steam-probe.ts [url]
//
// Exercises the registered chain for store.steampowered.com
// (custom-headers with the age-gate cookie → plain), so the printed
// `strategy=` is the transport actually used, and the generic title strip plus
// the Steam purchase tier are the only extraction paths.
import { scrapeProduct } from "../src/server/scraper/index";

const url = process.argv[2] ?? "https://store.steampowered.com/app/1086940/Baldurs_Gate_3/";

function fields(values: Record<string, string | number | null | undefined>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value ?? "null"}`)
    .join(" ");
}

const startedAt = Date.now();
const result = await scrapeProduct(url, {
  userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  timeoutMs: 20_000,
});
const ms = Date.now() - startedAt;

if (result.ok) {
  console.log(
    `ok strategy=${result.strategy} ms=${ms} ${fields({
      title: result.product.title ? JSON.stringify(result.product.title).slice(0, 120) : null,
      price: result.product.priceCents,
      cur: result.product.currency,
      site: result.product.siteName,
      image: result.product.image,
    })}`,
  );
} else {
  console.log(
    `FAIL strategy=${result.strategy} reason=${result.reason} ` +
      `heuristic=${result.heuristic ?? "-"} status=${result.status ?? "-"} ms=${ms}`,
  );
}
