import type { Ref } from "react";
import { S } from "../strings";
import { GearIcon, PlusIcon, ShareIcon } from "./IconButton";

interface ActionBarProps {
  /** Ref forwarded to the Share trigger so ShareMenu can return focus to it
   *  (and so the e2e can pin aria-expanded). Only one action cluster is
   *  mounted per width, so the desktop header cluster forwards this same
   *  ref when it is the live one. */
  shareTriggerRef: Ref<HTMLButtonElement>;
  /** Share popover/sheet open state — mirrors the header trigger's
   *  aria-expanded, exactly like the desktop cluster does. */
  shareOpen: boolean;
  onShareClick: () => void;
  /** Navigates to /add. */
  onAdd: () => void;
  /** Navigates to /settings. */
  onSettings: () => void;
  /** #95: the bar destination matching the current route ("add" |
   *  "settings"), or null when the route is not a bar destination (feed,
   *  item pages). Drives aria-current + the .is-current accent — the hook
   *  #73 left dormant for the cross-route navigator this bar now is. */
  currentDestination?: "add" | "settings" | null;
}

/** Mobile-only bottom action bar (#73, made persistent by #95): outline
 *  icons with a small label beneath, borderless buttons, one hairline
 *  divider on the bar's top edge, the app background behind it, and
 *  safe-area padding below. Rendered by AppBottomBar — Root-level shell
 *  chrome — on every AUTHENTICATED route below 640px; /share/:token and
 *  /login render no bar.
 *
 *  Semantics: a <nav> landmark with three buttons. Share always renders
 *  (#95): ShareMenu fetches /api/share itself, so the trigger works from
 *  any authenticated route. Add/Settings are navigation destinations, and
 *  the one matching the current route carries aria-current="page" plus the
 *  .is-current accent (#95 activates the hook #73 left dormant); Share is
 *  an action, never "current".
 *
 *  Mount point: AppBottomBar renders this as a sibling of the route view
 *  inside #root, which — like .app-shell/.app-main — creates no containing
 *  block for fixed descendants (no transform/filter/backdrop-filter), so
 *  the bar is fixed against the viewport. It must NOT move into .topbar,
 *  whose backdrop-filter WOULD clip it. Visibility is CSS-gated to the
 *  same <640px range the caller renders it for (`.action-bar { display:
 *  none }` above that). */
export function ActionBar({
  shareTriggerRef,
  shareOpen,
  onShareClick,
  onAdd,
  onSettings,
  currentDestination = null,
}: ActionBarProps) {
  return (
    <nav className="action-bar" aria-label={S.bar.navigation}>
      <button
        type="button"
        className={`action-bar-item${currentDestination === "add" ? " is-current" : ""}`}
        aria-current={currentDestination === "add" ? "page" : undefined}
        onClick={onAdd}
      >
        <PlusIcon />
        <span className="action-bar-label">{S.bar.add}</span>
      </button>
      <button
        type="button"
        ref={shareTriggerRef}
        className="action-bar-item"
        aria-label={S.share.shareList}
        aria-expanded={shareOpen}
        aria-haspopup="dialog"
        onClick={onShareClick}
      >
        <ShareIcon />
        <span className="action-bar-label">{S.bar.share}</span>
      </button>
      <button
        type="button"
        className={`action-bar-item${currentDestination === "settings" ? " is-current" : ""}`}
        aria-current={currentDestination === "settings" ? "page" : undefined}
        onClick={onSettings}
      >
        <GearIcon />
        <span className="action-bar-label">{S.bar.settings}</span>
      </button>
    </nav>
  );
}
