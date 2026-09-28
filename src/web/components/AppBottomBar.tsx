import { navigate, type Route } from "../router";
import { useMedia } from "../use-media";
import { ActionBar } from "./ActionBar";

interface AppBottomBarProps {
  /** Current route — the bar is route-aware chrome (Root passes useRoute()'s
   *  value down; it re-renders on every navigation, which is the point). */
  route: Route;
}

/** #95: the mobile bottom action bar as persistent shell chrome. Root
 *  renders this ONCE, as a sibling of the route view, so it survives every
 *  client-side navigation instead of unmounting with AppPage (#73's
 *  feed-only mount). Authenticated routes only: /share/:token (anonymous,
 *  no account actions — the Share surface would manage the VIEWER's link)
 *  and /login (pre-auth) render no bar.
 *
 *  #184: the bar is a pure navigator — List (the lists screen), Add,
 *  Settings. Share moved into the avatar menu (UserMenu, opened by
 *  HeaderCluster under 640px), so nothing here owns share state and exactly
 *  one Share surface exists per width. The bar stays the LAST element in
 *  the document, so it still closes the page's tab order (#95).
 *
 *  Width gating mirrors #73 exactly: useMedia("(min-width: 640px)") here,
 *  `not all and (min-width: 640px)` in the CSS — the same seam, so no
 *  fractional-boundary sliver where the DOM has the bar but CSS hides it.
 *
 *  Active accent (#95): the bar is a cross-route navigator, so the
 *  destination matching the current route carries aria-current="page" and
 *  the .is-current accent (the hook #73 left dormant for exactly this).
 *  The lists screen IS a bar destination (#184): `?list=<id>` still parses
 *  as the home route, so viewing another member's list marks List current —
 *  the same screen, the same destination. Item and edit pages are content
 *  routes, not bar destinations. Tapping the already-current destination is
 *  a no-op: a same-URL navigate() would push a duplicate history entry and
 *  scroll a half-filled form to its top (router.ts).
 *
 *  #96 keeps the destination match EXACT (deliberately, not by accident): the
 *  settings area has sub-routes (/settings/users, /settings/users/new) and
 *  family-matching them would light the accent there while `go()` no-ops on
 *  the same destination — a lit-but-dead Settings button stranding the user
 *  on the sub-screen. Exact match means the button is never "current" off
 *  /settings, so it stays a live way back to the account screen. */
export function AppBottomBar({ route }: AppBottomBarProps) {
  const isDesktop = useMedia("(min-width: 640px)");

  if (isDesktop) return null;
  // Anonymous / pre-auth surfaces stay clean (see doc comment).
  if (route.name === "share" || route.name === "login") return null;

  const current =
    route.name === "home" || route.name === "add" || route.name === "settings"
      ? route.name
      : null;

  function go(dest: "home" | "add" | "settings") {
    if (dest === current) return; // no duplicate pushState / scroll jump
    navigate(dest === "home" ? "/" : dest === "add" ? "/add" : "/settings");
  }

  return (
    <ActionBar
      currentDestination={current}
      onList={() => go("home")}
      onAdd={() => go("add")}
      onSettings={() => go("settings")}
    />
  );
}
