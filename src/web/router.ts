import { useEffect, useState } from "react";

/** Open-redirect guard (moved verbatim from Login.tsx — e2e test 14 pins
 *  this class): only same-site relative paths; `//`, backslash and
 *  tab/LF/CR second chars are all protocol-relative to the WHATWG
 *  parser and must fall back to "/". */
export function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (raw.length > 512) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || (raw.length >= 2 && /[\\\t\n\r]/.test(raw[1]))) return "/";
  return raw;
}

export type Route =
  | { name: "home" }
  | { name: "login"; next: string }
  /** /settings — the Account & Preferences screen (#96). */
  | { name: "settings" }
  /** /settings/users — the admin user-management table (#96). */
  | { name: "settingsUsers" }
  /** /settings/users/new — the admin create-user form (#96). */
  | { name: "settingsUserNew" }
  | { name: "share"; token: string }
  /** Raw location.search — the share-target prefill seam (INV-A). */
  | { name: "add"; search: string }
  | { name: "item"; id: string }
  | { name: "itemEdit"; id: string };

/** Item ids are `randomUUID()` (lowercase hex). Same guard style as the
 *  64-hex share token: a malformed id is not a route. */
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exact-match route table. `/add` is its own page (#62 — it was the feed
 *  with the add sheet open before), `/items/:id` and `/items/:id/edit` are
 *  the owner item pages, `/settings*` is the three-screen settings area
 *  (#96 — users/new is matched before users, so a future param route under
 *  /settings/users cannot shadow the creation form), and an unknown path
 *  (including a malformed item id, or any /settings sub-path other than the
 *  two admin screens) falls through to home, same as the pre-router switch
 *  did and the same as a malformed /share token. */
export function parseRoute(path: string, search: string): Route {
  const share = /^\/share\/([0-9a-f]{64})$/.exec(path);
  if (share) return { name: "share", token: share[1] };
  // /edit is matched first: /items/:id would shadow it otherwise.
  const edit = /^\/items\/([0-9a-f-]{36})\/edit$/.exec(path);
  if (edit && ITEM_ID.test(edit[1])) return { name: "itemEdit", id: edit[1] };
  const item = /^\/items\/([0-9a-f-]{36})$/.exec(path);
  if (item && ITEM_ID.test(item[1])) return { name: "item", id: item[1] };
  if (path === "/login") {
    return { name: "login", next: safeNext(new URLSearchParams(search).get("next")) };
  }
  if (path === "/add") return { name: "add", search };
  if (path === "/settings/users/new") return { name: "settingsUserNew" };
  if (path === "/settings/users") return { name: "settingsUsers" };
  if (path === "/settings") return { name: "settings" };
  return { name: "home" };
}

const ROUTE_EVENT = "sugarplum:navigate";

/** Subscribes to in-app navigation REQUESTS (the same signal useRoute()
 *  consumes). Callers use it to freeze view state that must survive the
 *  incoming route's scroll-to-top, which navigate() fires in the same tick. */
export function onNavigateRequest(listener: () => void): () => void {
  window.addEventListener(ROUTE_EVENT, listener);
  return () => window.removeEventListener(ROUTE_EVENT, listener);
}

/** Client-side navigation: pushState + notify listeners. Never a full
 *  document load. `replace` is for the authed-login redirect (INV-6) so
 *  back-button doesn't trap the user on a login view they skipped. */
export function navigate(path: string, opts?: { replace?: boolean }): void {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) return; // defensive; safeNext already guards
  if (opts?.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new CustomEvent(ROUTE_EVENT));
  if (!opts?.replace) window.scrollTo(0, 0);
}

/** Current route, re-parsed on every pushState (`navigate`) and popstate. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname, location.search));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(location.pathname, location.search));
    window.addEventListener("popstate", sync);
    window.addEventListener(ROUTE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(ROUTE_EVENT, sync);
    };
  }, []);
  return route;
}
