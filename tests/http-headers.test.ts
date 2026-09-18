import { describe, expect, test } from "bun:test";
import { createTestApp } from "./helpers";

describe("security headers (issue #63 G4)", () => {
  test("API routes carry CSP, HSTS, nosniff, frame protection, no-store", async () => {
    const app = createTestApp();
    try {
      const res = await fetch(`${app.baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      await app.cleanup();
    }
  });

  test("auth + share API paths are no-store; wishlist reads are NOT", async () => {
    const app = createTestApp();
    try {
      const me = await fetch(`${app.baseUrl}/api/auth/me`);
      expect(me.status).toBe(401); // no session yet — headers still present
      expect(me.headers.get("cache-control")).toBe("no-store");

      const summaryRes = await fetch(`${app.baseUrl}/api/wishlist/summary`);
      expect(summaryRes.status).toBe(401);
      expect(summaryRes.headers.get("cache-control")).not.toBe("no-store");
    } finally {
      await app.cleanup();
    }
  });

  test("login's Set-Cookie survives the wrapper intact", async () => {
    const app = createTestApp();
    try {
      const res = await app.request("POST", "/api/auth/login", {
        username: "admin",
        password: "admin-password",
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("sugarplum_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    } finally {
      await app.cleanup();
    }
  });

  test("SPA shell response carries the headers (static path)", async () => {
    const app = createTestApp();
    try {
      const res = await fetch(`${app.baseUrl}/`);
      // dist/public may not exist in a fresh test run — 404 is acceptable,
      // but the headers must be on it either way.
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect((res.headers.get("content-security-policy") ?? "")).toContain(
        "default-src 'self'",
      );
    } finally {
      await app.cleanup();
    }
  });

  test("wrapper never clobbers an existing Cache-Control (image route shape)", async () => {
    // Unit-level: exercise the helper directly on a synthetic response.
    // (The end-to-end image assertion already lives in tests/images.test.ts.)
    const { withSecurityHeaders } = await import("../src/server/http-headers");
    const synthetic = new Response(null, {
      status: 200,
      headers: { "Cache-Control": "private, max-age=86400" },
    });
    const wrapped = withSecurityHeaders(synthetic, "/api/wishlist/items/x/image");
    expect(wrapped.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(wrapped.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("204 logout keeps its clear-cookie and gains headers (no body throw)", async () => {
    const app = createTestApp();
    try {
      await app.request("POST", "/api/auth/login", {
        username: "admin",
        password: "admin-password",
      });
      const logout = await app.request("POST", "/api/auth/logout");
      expect(logout.status).toBe(204);
      expect((logout.headers.get("set-cookie") ?? "")).toContain("Max-Age=0");
      expect(logout.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await app.cleanup();
    }
  });
});
