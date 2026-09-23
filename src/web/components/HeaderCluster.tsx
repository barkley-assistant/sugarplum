import { useRef, useState } from "react";
import type { Me } from "../../shared/types";
import { S } from "../strings";
import { navigate, useRoute } from "../router";
import { useMedia } from "../use-media";
import { useInstallPrompt } from "../pwa/install";
import { clearStoredIdentity } from "../me-store";
import { IconButton, PlusIcon, ShareIcon } from "./IconButton";
import { ShareMenu } from "./ShareMenu";
import { UserMenu } from "./UserMenu";

interface HeaderClusterProps {
  /** The signed-in identity the avatar menu speaks for. */
  me: Me;
  /** Suppress the Add chip: its destination is the page it would be on
   *  (/add). A control that navigates where you already are is a lie, and on
   *  /add it would also collide with the form's own "Add item" submit. */
  hideAdd?: boolean;
  /** Suppress Add AND Share (the feed, while another user's list is on
   *  screen or the own list is empty): "Share my list" over someone else's
   *  list is the same lie as Add. */
  hideActions?: boolean;
  /** Render the Back-to-list button — the item view's way back to the feed
   *  (the issue's "destination-based, predictable" back affordance). */
  showBackToList?: boolean;
}

/** #125: the topbar's identity cluster — Back to list (item view), Add,
 *  Share, avatar menu — rendered by AppShell on EVERY authenticated page so
 *  the header never changes shape between routes. Desktop only: under 640px
 *  the same actions live on the bottom action bar (#73 D4, one cluster per
 *  width), and the avatar keeps its own mobile menu.
 *
 *  Built as a standalone component (no feed state, no page props beyond the
 *  identity) so #128 can mount the mobile chevron back inside the same seam.
 *  The settings entry is suppressed while a settings screen is on screen —
 *  the menu must not offer the destination the page already is (the mobile
 *  bar has the same rule, AppBottomBar.tsx). */
export function HeaderCluster({
  me,
  hideAdd = false,
  hideActions = false,
  showBackToList = false,
}: HeaderClusterProps) {
  const route = useRoute();
  const isDesktop = useMedia("(min-width: 640px)");
  const [shareOpen, setShareOpen] = useState(false);
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null);
  const install = useInstallPrompt();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredIdentity();
    navigate("/login");
  }

  const onSettingsScreen =
    route.name === "settings" || route.name === "settingsUsers" || route.name === "settingsUserNew";

  return (
    <>
      {isDesktop && !hideActions && (
        <div className="topbar-actions">
          {showBackToList && (
            <button
              type="button"
              className="secondary compact-action topbar-back"
              onClick={() => navigate("/")}
            >
              {S.settings.backToList}
            </button>
          )}
          {!hideAdd && (
            <IconButton variant="ghost" label={S.list.addItem} onClick={() => navigate("/add")}>
              <PlusIcon />
            </IconButton>
          )}
          {/* ShareMenu is self-sufficient (it fetches /api/share itself and
              portals its mobile sheet), so the trigger works from any route. */}
          <div className="share-anchor">
            <IconButton
              ref={shareTriggerRef}
              variant="ghost"
              label={S.share.shareList}
              onClick={() => setShareOpen((open) => !open)}
              aria-expanded={shareOpen}
              aria-haspopup="dialog"
            >
              <ShareIcon />
            </IconButton>
            <ShareMenu
              open={shareOpen}
              onClose={() => setShareOpen(false)}
              triggerRef={shareTriggerRef}
            />
          </div>
        </div>
      )}
      <UserMenu
        displayName={me.displayName || me.username}
        onLogout={logout}
        onSettings={isDesktop && !onSettingsScreen ? () => navigate("/settings") : undefined}
        extra={
          install.canInstall ? (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={install.promptInstall}
            >
              {S.pwa.install}
            </button>
          ) : undefined
        }
      />
    </>
  );
}
