export interface Config {
  port: number;
  host: string;
  dbPath: string;
  sessionTtlDays: number;
  adminUsername: string;
  adminPassword: string;
  adminDisplayName: string;
  /** Cookie gets the Secure attribute unless SUGARPLUM_DEV=1. */
  cookieSecure: boolean;
  dev: boolean;
  /** SearXNG instance for best-effort price hints; unset → fallback disabled. */
  searxngUrl?: string;
  /** Where downloaded product images are stored (runtime dir, gitignored). */
  imagesDir: string;
  /** Desktop-class UA for the scraper (plain browser, no "bot" advertising). */
  scraperUserAgent: string;
  /** Max concurrent enrichment jobs; clamped to [1, 8]. */
  maxEnrichConcurrency: number;
  /**
   * Test/operator escape hatch: allow outbound fetch targets on
   * private/loopback ranges (scrape + product-image download). Production
   * readConfig never sets this — tests opt in explicitly.
   */
  allowPrivateFetch?: boolean;
  /** Stealth-browser capability. Disabled → chain filters out stealth-browser. */
  stealthDisabled: boolean;
  /** Stealth per-scrape budget in milliseconds (default 60000). */
  stealthTimeoutMs: number;
  /** Where per-host Firefox profiles are persisted (gitignored). */
  stealthProfilesDir: string;
  /** Raw env value when SUGARPLUM_STEALTH_VENV_PY is set; resolution to an
   *  absolute path lives in createStealthDeps (stealth.ts). */
  stealthVenvPython?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing: string[] = [];
  const adminUsername = env.SUGARPLUM_ADMIN_USERNAME;
  const adminPassword = env.SUGARPLUM_ADMIN_PASSWORD;
  const adminDisplayName = env.SUGARPLUM_ADMIN_DISPLAY_NAME;
  if (!adminUsername) missing.push("SUGARPLUM_ADMIN_USERNAME");
  if (!adminPassword) missing.push("SUGARPLUM_ADMIN_PASSWORD");
  if (!adminDisplayName) missing.push("SUGARPLUM_ADMIN_DISPLAY_NAME");
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const dev = env.SUGARPLUM_DEV === "1";

  const rawConcurrency = Number(env.SUGARPLUM_ENRICH_CONCURRENCY ?? "2");
  const maxEnrichConcurrency = Math.min(8, Math.max(1, Number.isFinite(rawConcurrency) ? rawConcurrency : 2));

  const searxngUrlRaw = env.SUGARPLUM_SEARXNG_URL;
  const searxngUrl = searxngUrlRaw ? searxngUrlRaw.replace(/\/+$/, "") : undefined;

  const rawStealthTimeout = Number(env.SUGARPLUM_STEALTH_TIMEOUT_MS ?? "60000");
  const stealthTimeoutMs = Number.isFinite(rawStealthTimeout) && rawStealthTimeout > 0
    ? rawStealthTimeout
    : 60000;

  return {
    port: Number(env.SUGARPLUM_PORT ?? "3499"),
    host: env.SUGARPLUM_HOST ?? "127.0.0.1",
    dbPath: env.SUGARPLUM_DB_PATH ?? "./data/sugarplum.db",
    sessionTtlDays: Number(env.SUGARPLUM_SESSION_TTL_DAYS ?? "30"),
    adminUsername: adminUsername as string,
    adminPassword: adminPassword as string,
    adminDisplayName: adminDisplayName as string,
    cookieSecure: !dev,
    dev,
    searxngUrl,
    imagesDir: env.SUGARPLUM_IMAGES_DIR ?? "./data/images",
    scraperUserAgent:
      env.SUGARPLUM_USER_AGENT ??
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    maxEnrichConcurrency,
    // Operator/test escape hatch for local scrape fixtures. Production env
    // never sets this; the e2e suite enables it to scrape 127.0.0.1 pages.
    allowPrivateFetch: env.SUGARPLUM_ALLOW_PRIVATE_FETCH === "1",
    // Stealth-browser capability. Disabled → the chain filters the
    // stealth-browser strategy out (chain falls back to plain-only).
    stealthDisabled: env.SUGARPLUM_STEALTH_DISABLED === "1",
    stealthTimeoutMs,
    stealthProfilesDir: env.SUGARPLUM_STEALTH_PROFILES_DIR ?? "./data/stealth-profiles",
    stealthVenvPython: env.SUGARPLUM_STEALTH_VENV_PY,
  };
}