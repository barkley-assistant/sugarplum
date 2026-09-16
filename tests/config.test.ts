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
  test("defaults: 24h interval, 60s initial delay, 15min stagger, 90-row cap", () => {
    const cfg = readConfig({ ...BASE });
    expect(cfg.trackIntervalMs).toBe(86400000);
    expect(cfg.trackInitialDelayMs).toBe(60000);
    expect(cfg.trackStaggerMs).toBe(900000);
    expect(cfg.trackSeriesCap).toBe(90);
  });
  test("env overrides flow through", () => {
    const cfg = readConfig({
      ...BASE,
      SUGARPLUM_TRACK_INTERVAL_MS: "3600000",
      SUGARPLUM_TRACK_INITIAL_DELAY_MS: "5000",
      SUGARPLUM_TRACK_STAGGER_MS: "60000",
      SUGARPLUM_TRACK_SERIES_CAP: "30",
    });
    expect(cfg.trackIntervalMs).toBe(3600000);
    expect(cfg.trackInitialDelayMs).toBe(5000);
    expect(cfg.trackStaggerMs).toBe(60000);
    expect(cfg.trackSeriesCap).toBe(30);
  });
  test("bad numbers fall back to defaults; series cap clamps to [1,365]", () => {
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_INTERVAL_MS: "abc" }).trackIntervalMs).toBe(
      86400000,
    );
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_STAGGER_MS: "0" }).trackStaggerMs).toBe(900000);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_SERIES_CAP: "abc" }).trackSeriesCap).toBe(90);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_SERIES_CAP: "0" }).trackSeriesCap).toBe(1);
    expect(readConfig({ ...BASE, SUGARPLUM_TRACK_SERIES_CAP: "9999" }).trackSeriesCap).toBe(365);
  });
});