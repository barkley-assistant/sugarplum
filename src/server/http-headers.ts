/** Response hardening for issue #63 (G4). Applied at the route-table edge in
 *  createApp so every response — API, static, SPA shell, 404s — is covered
 *  exactly once. Fills headers; NEVER overwrites one the handler already set
 *  (item images keep their own private Cache-Control). */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Paths carrying identity or one-shot token data: never cacheable. Wishlist
 *  reads are deliberately NOT here — the service worker's DATA_CACHE
 *  stale-while-revalidate stores them (scripts/generate-sw.ts), and
 *  cache.put() refuses a no-store response. */
const NO_STORE_PREFIXES = ["/api/auth/", "/api/share/"];

export function withSecurityHeaders(res: Response, path: string): Response {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
  });
  // Fetch Headers iterate set-cookie as one combined value; getSetCookie()
  // preserves them individually. No route emits two today, but a forEach
  // copy would collapse them — this has to be exact anyway.
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }

  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", CSP);
  if (!headers.has("Strict-Transport-Security")) {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "no-referrer");
  if (!headers.has("X-Content-Type-Options")) headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Cache-Control") && NO_STORE_PREFIXES.some((p) => path.startsWith(p))) {
    headers.set("Cache-Control", "no-store");
  }

  // 204/304 carry no body by spec (Response(body) would throw on a 204).
  const body = res.status === 204 || res.status === 304 ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
