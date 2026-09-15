// Read-only probe: run the REAL production extraction against a live Amazon
// page and print one verifiable line. Manual evidence only — this is NOT a
// test (no live network in CI; tests/fixtures/amazon-dp*.html + tests/scraper
// cover the extractor offline). Driver: scripts/amazon-smoke.sh.
//
//   bun run scripts/amazon-probe.ts [url]
//     → real scrapeProduct pipeline (registered chain: plain → stealth).
//
//   bun run scripts/amazon-probe.ts [url] [pageFile]
//     → parse an already-fetched page. pageFile is either raw HTML or a
//       stealth-fetch.py verdict JSON (its `html` field is used), so the
//       smoke script can prove the stealth transport end to end.
import { scrapeProduct } from "../src/server/scraper/index";
import { extractProduct } from "../src/server/scraper/parse";

const url = process.argv[2] ?? "https://www.amazon.co.uk/dp/B0BPCCKL3N";
const pageFile = process.argv[3];

function fields(values: Record<string, string | number | null | undefined>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value ?? "null"}`)
    .join(" ");
}

if (pageFile) {
  const raw = await Bun.file(pageFile).text();
  let html = raw;
  try {
    const verdict = JSON.parse(raw) as { html?: unknown };
    if (typeof verdict.html === "string") html = verdict.html;
  } catch {
    // Plain HTML file — use it as-is.
  }
  const product = await extractProduct(html, url);
  console.log(
    `ok strategy=html-file bytes=${html.length} ${fields({
      title: product.title ? JSON.stringify(product.title).slice(0, 120) : null,
      price: product.priceCents,
      cur: product.currency,
      image: product.image,
      site: product.siteName,
    })}`,
  );
} else {
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
        image: result.product.image,
        site: result.product.siteName,
      })}`,
    );
  } else {
    console.log(
      `FAIL strategy=${result.strategy} reason=${result.reason} ` +
        `heuristic=${result.heuristic ?? "-"} status=${result.status ?? "-"} ms=${ms}`,
    );
  }
}
