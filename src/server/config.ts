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
  };
}