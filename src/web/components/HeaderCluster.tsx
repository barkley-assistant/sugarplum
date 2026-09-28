import { useRef, useState, type RefObject } from "react";
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
}

/** #184: ShareMenu's triggerRef on the mobile sheet, where no popover anchor
 *  exists. The ref is dereferenced only inside ShareMenu's desktop-only
 *  effects, each of which early-returns under 640px, so the constant is
 *  never read. */
const NULL_TRIGGER: RefObject<HTMLButtonElement | null> = { current: null };

/** #125: the topbar's identity cluster — Add, Share and avatar menu —
 *  rendered by AppShell on EVERY authenticated page so the header never
 *  changes shape between routes.
 *
 *  One cluster per width (#73 D4), and #184 keeps the invariant while moving
 *  Share: the desktop header keeps its Share icon (.topbar-actions is
 *  desktop-only chrome), and under 640px the same action lives on the avatar
 *  menu's "Share wishlist" row — the bottom bar is a pure navigator now.
 *  Exactly one Share surface exists at any width: the header popover at
 *  >= 640px, the avatar row's sheet below it.
 *
 *  Both Share surfaces are served by this one component, so there is still a
 *  single owner of the open state (`shareOpen`): the desktop instance sits
 *  inside .share-anchor, which is the popover's containing block (#183); the
 *  mobile instance renders outside .topbar-actions — that block is absent
 *  below 640px, so a sheet mounted inside it could never open — and portals
 *  its Sheet to document.body, which makes its DOM position irrelevant. The
 *  media gate keeps exactly one of the two mounted.
 *
 *  The settings entry is suppressed while a settings screen is on screen —
 *  the menu must not offer the destination the page already is (the mobile
 *  bar has the same rule, AppBottomBar.tsx). */
export function HeaderCluster({
  me,
  hideAdd = false,
  hideActions = false,
}: HeaderClusterProps) {
  const route = useRoute();
  const isDesktop = useMedia("(min-width: 640px)");
  const [shareOpen, setShareOpen] = useState(false);
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null);
  const install = useInstallPrompt();

  function closeShare() {
    setShareOpen(false);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredIdentity();
    navigate("/login");
  }

  const onSettingsScreen =
    route.name === "settings" || route.name === "settingsUsers" || route.name === "settingsUserNew";

  return (
    <>
      {isDesktop && (
        <div className="topbar-actions">
          {!hideAdd && (
            <IconButton variant="ghost" label={S.list.addItem} onClick={() => navigate("/add")}>
              <PlusIcon />
            </IconButton>
          )}
          {/* #184: hideActions now gates only the Share ICON (it never gated
              Add — hideAdd does). The wrapper stays mounted on desktop so
              .share-anchor keeps seating the popover (#183), and ShareMenu
              stays inside it for the same reason. */}
          <div className="share-anchor">
            {!hideActions && (
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
            )}
            <ShareMenu open={shareOpen} onClose={closeShare} triggerRef={shareTriggerRef} />
          </div>
        </div>
      )}
      {/* #184: the mobile Share surface. Rendered OUTSIDE .topbar-actions —
          that block is display:none and unmounted below 640px, and its count
          is pinned at 0 there — while the desktop-only effects inside
          ShareMenu are what would read triggerRef, so a null ref is safe. */}
      {!isDesktop && <ShareMenu open={shareOpen} onClose={closeShare} triggerRef={NULL_TRIGGER} />}
      <UserMenu
        displayName={me.displayName || me.username}
        onLogout={logout}
        onSettings={isDesktop && !onSettingsScreen ? () => navigate("/settings") : undefined}
        onShare={isDesktop ? undefined : () => setShareOpen(true)}
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
