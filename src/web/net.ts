/** #117: "was this write failure the connection's fault?"
 *
 *  One rule, in one place. Every owner write routes its failure through
 *  `classifyWriteFailure` (inside a `catch`) or `classifyResponse` (in an
 *  `!res.ok` branch), so the offline framing cannot drift per call site — and
 *  the surfaces that are NOT connectivity failures (the clipboard copies)
 *  never consult it at all.
 *
 *  This module returns a KIND only. The copy lives in strings.ts and the call
 *  site picks it, which is what keeps the predicate pure and testable with no
 *  DOM and no rendering.
 */

export type WriteFailureKind = "offline" | "failed";

/** The SW's offline sentinel body (scripts/generate-sw.ts). A bare 503 is NOT
 *  the signal: the server answers 503 for its own "price search is not
 *  configured", and that one keeps the action's own copy. */
const OFFLINE_SENTINEL = "offline";

function browserIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** The rule that needs no Response: the fetch REJECTED, so nothing arrived and
 *  the connection is the only honest explanation available. A rejected fetch
 *  is also the shape `navigator.onLine` misses (captive portal, dead access
 *  point, DNS failure — all of which keep reporting onLine === true), which is
 *  why the ambient flag is checked first and the rejection second. Anything
 *  else (a `!res.ok` marker the call site threw) keeps its per-action copy. */
export function classifyWriteFailure(err: unknown): WriteFailureKind {
  if (!browserIsOnline()) return "offline";
  if (err instanceof TypeError) return "offline";
  return "failed";
}

/** The sentinel rule, for call sites that hold a Response.
 *
 *  A response ARRIVED, so the connection carried it: the only offline answer
 *  the server side can give is the SW's sentinel, and it is identified by its
 *  body rather than by the 503 status (see OFFLINE_SENTINEL). Read through a
 *  clone so the caller still owns its own body (the admin screens parse the
 *  server's error message), and treat an unreadable body as "failed" rather
 *  than throwing — the ambient flag is the fallback for the burned-Response
 *  case, where the sentinel is there but its body can no longer be read. */
export async function classifyResponse(res: Response): Promise<WriteFailureKind> {
  if (res.status !== 503) return "failed";
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return body?.error === OFFLINE_SENTINEL ? "offline" : "failed";
  } catch {
    return browserIsOnline() ? "failed" : "offline";
  }
}
