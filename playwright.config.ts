import { defineConfig } from "@playwright/test";

/** e2e for issue #3. Runs against the REAL server booted in global-setup
 *  (temp DB, random port, plain http on 127.0.0.1). One worker keeps the
 *  shared server state deterministic: the specs build on each other.
 *  The specs read E2E_BASE_URL (set by global-setup) for navigation; this
 *  baseURL is only a fallback. */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/fixtures/global-setup.ts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4599",
    headless: true,
    trace: "retain-on-failure",
  },
});