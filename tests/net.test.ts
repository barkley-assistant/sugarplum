import { afterEach, describe, expect, test } from "bun:test";
import { classifyResponse, classifyWriteFailure } from "../src/web/net";

/** #117: the predicate behind every offline-framed write failure. It answers
 *  "was this the connection?" from what each call site already holds — the
 *  thrown error, or the Response — and it is the ONLY decision point, so the
 *  rule is pinned here rather than at a dozen call sites.
 *
 *  Bun has no `navigator.onLine`, so the ambient signal is stubbed and always
 *  restored: a leak here would flip other files' expectations. */

const realNavigator = globalThis.navigator;

function setOnline(onLine: boolean): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: realNavigator,
    configurable: true,
    writable: true,
  });
});

/** The SW's offline sentinel, as scripts/generate-sw.ts builds it. */
function sentinel(): Response {
  return new Response(JSON.stringify({ error: "offline" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

describe("classifyWriteFailure (#117)", () => {
  test("an offline browser → offline", () => {
    setOnline(false);
    expect(classifyWriteFailure(new Error())).toBe("offline");
  });

  test("a rejected fetch → offline even while navigator.onLine still says true", () => {
    // The captive-portal / dead-AP shape: nothing arrived, so the connection
    // is the honest answer, and the ambient flag is exactly what misses it.
    setOnline(true);
    expect(classifyWriteFailure(new TypeError("Failed to fetch"))).toBe("offline");
  });

  test("a call site's own non-ok marker keeps the action's copy → failed", () => {
    setOnline(true);
    expect(classifyWriteFailure(new Error())).toBe("failed");
  });
});

describe("classifyResponse (#117)", () => {
  test("the SW's offline sentinel → offline", async () => {
    setOnline(true);
    expect(await classifyResponse(sentinel())).toBe("offline");
  });

  test("the server's OWN 503 keeps its copy — the status alone is not the signal", async () => {
    setOnline(true);
    const res = new Response(JSON.stringify({ error: "Price search is not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
    expect(await classifyResponse(res)).toBe("failed");
  });

  test("a real server error → failed, whatever its body", async () => {
    setOnline(true);
    for (const status of [400, 401, 403, 409, 429, 500]) {
      const res = new Response(JSON.stringify({ error: "nope" }), { status });
      expect(await classifyResponse(res), `status ${status}`).toBe("failed");
    }
  });

  test("a response that arrived while the browser reports offline is still a server answer → failed", async () => {
    // A response exists only because something carried it: the ambient flag
    // alone must never relabel a real 4xx/5xx as the connection's fault.
    setOnline(false);
    expect(await classifyResponse(new Response("nope", { status: 500 }))).toBe("failed");
  });

  test("an unreadable body → failed, never a throw", async () => {
    setOnline(true);
    const res = sentinel();
    await res.text(); // consume it: the pre-#117 shared-sentinel burn
    expect(await classifyResponse(res)).toBe("failed");
  });

  test("an unreadable body while offline still names the connection", async () => {
    setOnline(false);
    const res = sentinel();
    await res.text();
    expect(await classifyResponse(res)).toBe("offline");
  });

  test("classifying leaves the caller's own body readable", async () => {
    // The admin screens parse the server's error message AFTER classifying.
    setOnline(true);
    const res = sentinel();
    expect(await classifyResponse(res)).toBe("offline");
    expect(await res.json()).toEqual({ error: "offline" });
  });
});
