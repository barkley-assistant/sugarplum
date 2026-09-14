import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/server/app";
import type { Config } from "../src/server/config";

export interface TestResponse {
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

export interface TestAppHandle {
  app: App;
  baseUrl: string;
  /** fetch wrapper with a per-instance cookie jar. */
  request: (method: string, path: string, body?: unknown) => Promise<TestResponse>;
  /** Clears the jar's cookie (simulates a fresh browser). */
  clearCookie: () => void;
  cleanup: () => Promise<void>;
}

export function makeTestConfig(overrides: Partial<Config> = {}): { config: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sugarplum-test-"));
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    dbPath: join(dir, "db.sqlite"),
    sessionTtlDays: 30,
    adminUsername: "admin",
    adminPassword: "admin-password",
    adminDisplayName: "Admin",
    cookieSecure: false,
    dev: false,
    ...overrides,
  };
  return { config, dir };
}

export function createTestApp(overrides: Partial<Config> = {}): TestAppHandle {
  const { config, dir } = makeTestConfig(overrides);
  const app = createApp(config);
  const baseUrl = `http://127.0.0.1:${app.server.port}`;

  let cookie = "";
  const handle: TestAppHandle = {
    app,
    baseUrl,
    request: async (method, path, body) => {
      const headers: Record<string, string> = {};
      if (cookie) headers["Cookie"] = cookie;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const res = await fetch(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const [nameValue] = setCookie.split(";");
        cookie = setCookie.includes("Max-Age=0") ? "" : nameValue;
      }

      return {
        status: res.status,
        headers: res.headers,
        json: () => res.json() as Promise<unknown>,
        text: () => res.text(),
      };
    },
    clearCookie: () => {
      cookie = "";
    },
    cleanup: async () => {
      await app.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}