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
  };
}