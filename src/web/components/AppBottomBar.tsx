import { useRef, useState } from "react";
import { navigate, type Route } from "../router";
import { useMedia } from "../use-media";
import { ActionBar } from "./ActionBar";
import { ShareMenu } from "./ShareMenu";

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
 *  The bar's Share is self-sufficient: ShareMenu fetches /api/share itself
 *  and portals its mobile sheet to document.body, so the trigger works from
 *  any authenticated route (the desktop header cluster keeps its own
 *  popover inside AppPage; the 640px media gates keep exactly one Share
 *  and one Add in the DOM at any width — #73 D4).
 *
 *  Width gating mirrors #73 exactly: useMedia("(min-width: 640px)") here,
 *  `not all and (min-width: 640px)` in the CSS — the same seam, so no
 *  fractional-boundary sliver where the DOM has the bar but CSS hides it.
 *
 *  Active accent (#95): the bar is now a cross-route navigator, so the
 *  destination matching the current route carries aria-current="page" and
 *  the .is-current accent (the hook #73 left dormant for exactly this).
 *  Only /add and /settings are bar destinations — the feed and item pages
 *  are content routes, and painting Add there would be the lie #73's D2
 *  rejected. Tapping the already-current destination is a no-op: a same-URL
 *  navigate() would push a duplicate history entry and scroll a half-filled
 *  form to its top (router.ts). */
export function AppBottomBar({ route }: AppBottomBarProps) {
  const isDesktop = useMedia("(min-width: 640px)");
  const [shareOpen, setShareOpen] = useState(false);
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null);

  if (isDesktop) return null;
  // Anonymous / pre-auth surfaces stay clean (see doc comment).
  if (route.name === "share" || route.name === "login") return null;

  const current = route.name === "add" || route.name === "settings" ? route.name : null;

  function go(dest: "add" | "settings") {
    if (dest === current) return; // no duplicate pushState / scroll jump
    navigate(dest === "add" ? "/add" : "/settings");
  }

  return (
    <>
      <ActionBar
        shareTriggerRef={shareTriggerRef}
        shareOpen={shareOpen}
        currentDestination={current}
        onShareClick={() => setShareOpen((v) => !v)}
        onAdd={() => go("add")}
        onSettings={() => go("settings")}
      />
      <ShareMenu
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        triggerRef={shareTriggerRef}
      />
    </>
  );
}
