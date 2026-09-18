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
  | { name: "settings" }
  | { name: "share"; token: string };

/** Exact-match route table, no patterns: `/add` parses as `home` (it is the
 *  feed with the add sheet open — the prefill seam reads location.search)
 *  and an unknown path falls through to the app view, same as the
 *  pre-router switch did. */
export function parseRoute(path: string, search: string): Route {
  const share = /^\/share\/([0-9a-f]{64})$/.exec(path);
  if (share) return { name: "share", token: share[1] };
  if (path === "/login") {
    return { name: "login", next: safeNext(new URLSearchParams(search).get("next")) };
  }
  if (path === "/settings") return { name: "settings" };
  return { name: "home" };
}

const ROUTE_EVENT = "sugarplum:navigate";

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
