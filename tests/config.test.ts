import { describe, expect, test } from "bun:test";
import { readConfig } from "../src/server/config";

const BASE = { SUGARPLUM_ADMIN_USERNAME: "a", SUGARPLUM_ADMIN_PASSWORD: "b", SUGARPLUM_ADMIN_DISPLAY_NAME: "c" };

describe("wave2 config", () => {
  test("defaults: searxng off, cap 2, desktop UA, images dir", () => {
    const cfg = readConfig({ ...BASE });
    expect(cfg.searxngUrl).toBeUndefined();
    expect(cfg.maxEnrichConcurrency).toBe(2);
    expect(cfg.scraperUserAgent).toContain("Mozilla/5.0");
    expect(cfg.imagesDir).toBe("./data/images");
  });
  test("searxng url set → parsed; trailing slash normalized away", () => {
    const cfg = readConfig({ ...BASE, SUGARPLUM_SEARXNG_URL: "http://192.168.0.200:35000/" });
    expect(cfg.searxngUrl).toBe("http://192.168.0.200:35000");
  });
  test("invalid enrich concurrency clamps to [1,8]", () => {
    expect(readConfig({ ...BASE, SUGARPLUM_ENRICH_CONCURRENCY: "99" }).maxEnrichConcurrency).toBe(8);
    expect(readConfig({ ...BASE, SUGARPLUM_ENRICH_CONCURRENCY: "0" }).maxEnrichConcurrency).toBe(1);
  });
});

describe("wave13 config (stealth)", () => {
  test("defaults: stealth enabled, 60s timeout, default profiles dir, no venv override", () => {
    const cfg = readConfig({ ...BASE });
    expect(cfg.stealthDisabled).toBe(false);
    expect(cfg.stealthTimeoutMs).toBe(60000);
    expect(cfg.stealthProfilesDir).toBe("./data/stealth-profiles");
    expect(cfg.stealthVenvPython).toBeUndefined();
  });
  test("SUGARPLUM_STEALTH_DISABLED=1 → stealthDisabled true", () => {
    const cfg = readConfig({ ...BASE, SUGARPLUM_STEALTH_DISABLED: "1" });
    expect(cfg.stealthDisabled).toBe(true);
  });
  test("invalid stealth timeout → falls back to 60000", () => {
    expect(readConfig({ ...BASE, SUGARPLUM_STEALTH_TIMEOUT_MS: "abc" }).stealthTimeoutMs).toBe(60000);
    expect(readConfig({ ...BASE, SUGARPLUM_STEALTH_TIMEOUT_MS: "0" }).stealthTimeoutMs).toBe(60000);
    expect(readConfig({ ...BASE, SUGARPLUM_STEALTH_TIMEOUT_MS: "12000" }).stealthTimeoutMs).toBe(12000);
  });
  test("explicit profiles dir + venv python override flow through", () => {
    const cfg = readConfig({
      ...BASE,
      SUGARPLUM_STEALTH_PROFILES_DIR: "/srv/stealth",
      SUGARPLUM_STEALTH_VENV_PY: "/opt/stealth-venv/bin/python",
    });
    expect(cfg.stealthProfilesDir).toBe("/srv/stealth");
    expect(cfg.stealthVenvPython).toBe("/opt/stealth-venv/bin/python");
  });
});

describe("wave25 config (daily tracking)", () => {
  test("defaults: 24h interval, 60s initial delay, 15min stagger, 180-row cap", () => {
    const cfg = readConfig({ ...BASE });
    expect(cfg.trackIntervalMs).toBe(86400000);
    expect(cfg.trackInitialDelayMs).toBe(60000);
    expect(cfg.trackStaggerMs).toBe(900000);
    expect(cfg.trackSeriesCap).toBe(180);
    expect(cfg.trackActiveMs).toBe(43200000);
    expect(cfg.trackStableMs).toBe(86400000);
    expect(cfg.trackFailedMs).toBe(172800000);
    expect(cfg.trackMovedWindowMs).toBe(604800000);
  });
  test("env overrides flow through", () => {
    const cfg = readConfig({
      ...BASE,
      SUGARPLUM_TRACK_INTERVAL_MS: "3600000",
      SUGARPLUM_TRACK_INITIAL_DELAY_MS: "5000",
      SUGARPLUM_TRACK_STAGGER_MS: "60000",
      SUGARPLUM_TRACK_SERIES_CAP: "30",
      SUGARPLUM_TRACK_ACTIVE_MS: "600000",
      SUGARPLUM_TRACK_STABLE_MS: "1800000",
      SUGARPLUM_TRACK_FAILED_MS: "7200000",
      SUGARPLUM_TRACK_MOVED_WINDOW_MS: "86400000",
    });
    expect(cfg.trackIntervalMs).toBe(3600000);
    expect(cfg.trackInitialDelayMs).toBe(5000);
    expect(cfg.trackStaggerMs).toBe(60000);
    expect(cfg.trackSeriesCap).toBe(30);
    expect(cfg.trackActiveMs).toBe(600000);
    expect(cfg.trackStableMs).toBe(1800000);
    expect(cfg.trackFailedMs).toBe(7200000);
    expect(cfg.trackMovedWindowMs).toBe(86400000);
  });
  test("bad numbers fall back to defaults; series cap clamps to [1,365]", () => {
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_INTERVAL_MS: "abc" }).trackIntervalMs).toBe(
      86400000,
    );
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_STAGGER_MS: "0" }).trackStaggerMs).toBe(900000);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_SERIES_CAP: "abc" }).trackSeriesCap).toBe(180);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_SERIES_CAP: "0" }).trackSeriesCap).toBe(1);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_SERIES_CAP: "9999" }).trackSeriesCap).toBe(365);
  });
  test("stable cadence follows the interval unless set explicitly", () => {
    // The interval/cutoff footgun: lowering ONLY the interval lowers the
    // stable per-item cutoff with it instead of silently doing nothing.
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_INTERVAL_MS: "3600000" }).trackStableMs).toBe(
      3600000,
    );
    expect(readConfig({ ...BASE }).trackStableMs).toBe(86400000);
    // An explicit cadence wins over the interval.
    expect(
      readConfig({ ...BASE, SUGARPLUM_TRACK_INTERVAL_MS: "3600000", SUGARPLUM_TRACK_STABLE_MS: "21600000" })
        .trackStableMs,
    ).toBe(21600000);
  });
  test("sub-1000ms per-item cadences fall back to their defaults", () => {
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_ACTIVE_MS: "500" }).trackActiveMs).toBe(43200000);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_FAILED_MS: "abc" }).trackFailedMs).toBe(172800000);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_MOVED_WINDOW_MS: "0" }).trackMovedWindowMs).toBe(
      604800000,
    );
    // Unset AND unusable both fall back to the interval.
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_STABLE_MS: "500" }).trackStableMs).toBe(86400000);
  });
});