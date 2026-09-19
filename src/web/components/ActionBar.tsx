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
  /** #45's rule, bar edition: Share only renders when there is a list to
   *  share (own feed, >=1 item). Add/Settings always render — an empty
   *  mobile feed still needs its destinations. */
  shareAvailable?: boolean;
}

/** Mobile-only bottom action bar (#73), styled after the operator mockup:
 *  outline icons with a small label beneath, borderless buttons, one hairline
 *  divider on the bar's top edge, the app background behind it, and safe-area
 *  padding below.
 *
 *  Semantics: a <nav> landmark with three buttons. This is an action bar, not
 *  a tab strip — nothing here is "current" while the feed is displayed, so no
 *  item carries aria-current and no accent is painted (see the plan's D2). The
 *  CSS keeps a dormant `.is-current` hook for a future cross-route navigator.
 *
 *  Mount point: AppPage renders this inside AppShell's children slot (i.e.
 *  inside .app-main), which is fixed-position safe — .app-main creates no
 *  containing block for fixed descendants (no transform/filter/backdrop-filter;
 *  the GuestItemDetailSheet's own fixed overlay already mounts in this same
 *  slot). It must NOT move into .topbar, whose backdrop-filter WOULD clip it.
 *  Visibility is CSS-gated to the same <640px range the caller renders it for
 *  (`.action-bar { display: none }` above that). */
export function ActionBar({
  shareTriggerRef,
  shareOpen,
  onShareClick,
  onAdd,
  onSettings,
  shareAvailable = true,
}: ActionBarProps) {
  return (
    <nav className="action-bar" aria-label={S.bar.navigation}>
      <button type="button" className="action-bar-item" onClick={onAdd}>
        <PlusIcon />
        <span className="action-bar-label">{S.bar.add}</span>
      </button>
      {shareAvailable && (
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
      )}
      <button type="button" className="action-bar-item" onClick={onSettings}>
        <GearIcon />
        <span className="action-bar-label">{S.bar.settings}</span>
      </button>
    </nav>
  );
}
