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