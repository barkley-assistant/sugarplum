// Live-evidence probe for #103 (plain → stealth auto-escalation + learned
// overrides). Manual evidence only — this is NOT a test: it needs the network
// and the stealth venv (no live eBay from CI).
//
//   bun run scripts/ebay-probe.ts [url] [cycles]
//
// It drives the REAL pipeline exactly as the enrichment worker does —
//   scrapeProduct(url, { userAgent, stealth, learnedDb }) → recordScrapeOutcome
// against an in-memory db carrying the production migrations — and prints one
// JSON line per cycle plus a final EVIDENCE line. Exit 0 only when all three
// facts the ticket asks for were observed:
//   1. the plain attempt fails and the escalated stealth attempt succeeds
//      (title/price/image extracted from the page),
//   2. THREE qualifying escalations write a promoted learned override,
//   3. a later fetch runs stealth-first with NO plain attempt.
// Exit 2 = stealth is unwired (nothing to escalate to).
//
// Env: SUGARPLUM_STEALTH_VENV_PY overrides the venv python (default: the
// sibling-of-checkout `.stealth-venv` that scripts/deploy.sh provisions);
// SUGARPLUM_STEALTH_PROFILES_DIR overrides the per-host profile dir.
import { openDatabase } from "../src/server/db/db";
import { normalizeHostname } from "../src/server/scraper/overrides";
import { scrapeProduct } from "../src/server/scraper/index";
import { recordScrapeOutcome } from "../src/server/scraper/learned";
import { createStealthDeps } from "../src/server/scraper/stealth";

const url = process.argv[2] ?? "https://www.ebay.co.uk/itm/327353411908";
const cycles = Number(process.argv[3] ?? 4);

const stealth = createStealthDeps({
  stealthDisabled: process.env.SUGARPLUM_STEALTH_DISABLED === "1",
  stealthTimeoutMs: Number(process.env.SUGARPLUM_STEALTH_TIMEOUT_MS ?? 90_000),
  stealthProfilesDir: process.env.SUGARPLUM_STEALTH_PROFILES_DIR ?? "./data/stealth-profiles",
  stealthVenvPython: process.env.SUGARPLUM_STEALTH_VENV_PY,
  allowPrivateFetch: process.env.SUGARPLUM_ALLOW_PRIVATE_FETCH === "1",
});
if (stealth === undefined) {
  console.log("stealth=unwired (SUGARPLUM_STEALTH_DISABLED=1) — nothing to escalate to");
  process.exit(2);
}

const hostname = normalizeHostname(url);
if (hostname === null) {
  console.log(`bad url: ${url}`);
  process.exit(2);
}

const db = openDatabase(":memory:");

interface LearnedRow {
  hostname: string;
  strategies: string | null;
  escalation_count: number;
  learned_at: string | null;
  last_escalated_at: string;
  last_demoted_at: string | null;
  successful_stealth_fetches: number;
}

function learnedRow(): LearnedRow | undefined {
  return db
    .query(
      `SELECT hostname, strategies, escalation_count, learned_at, last_escalated_at,
              last_demoted_at, successful_stealth_fetches
       FROM scrape_learned_overrides WHERE hostname = ?`,
    )
    .get(hostname) as LearnedRow | undefined;
}

const facts = { escalatedOk: false, promoted: false, stealthFirstWithoutPlain: false };

console.log(`url=${url} hostname=${hostname} cycles=${cycles}`);

for (let cycle = 1; cycle <= cycles; cycle++) {
  const startedAt = Date.now();
  const result = await scrapeProduct(url, {
    userAgent:
      process.env.SUGARPLUM_USER_AGENT ??
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    timeoutMs: 20_000,
    stealth,
    learnedDb: db,
  });
  recordScrapeOutcome(db, url, result.steps);
  const ms = Date.now() - startedAt;

  const escalatedOk =
    result.ok &&
    result.steps.some((s) => s.strategy === "plain" && !s.ok) &&
    result.strategy === "stealth-browser";
  if (escalatedOk) facts.escalatedOk = true;
  if (result.steps.length === 1 && result.steps[0].strategy === "stealth-browser") {
    facts.stealthFirstWithoutPlain = true;
  }

  const row = learnedRow();
  if (row && row.strategies !== null && row.escalation_count >= 3) facts.promoted = true;

  console.log(
    JSON.stringify({
      cycle,
      ms,
      verdict: result.ok ? "ok" : result.reason,
      status: result.ok ? 200 : result.status,
      strategy: result.strategy,
      steps: result.steps,
      plain_attempted: result.steps.some((s) => s.strategy === "plain"),
      product: result.ok
        ? {
            title: result.product.title,
            priceCents: result.product.priceCents,
            currency: result.product.currency,
            image: result.product.image,
            siteName: result.product.siteName,
          }
        : null,
      learned_row: row ?? null,
    }),
  );
}

console.log(`EVIDENCE ${JSON.stringify(facts)}`);
const ok = facts.escalatedOk && facts.promoted && facts.stealthFirstWithoutPlain;
console.log(ok ? "PASS all three facts observed" : "FAIL — inspect the cycle lines above");
process.exit(ok ? 0 : 1);
