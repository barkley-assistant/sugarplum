import type { ReactNode } from "react";
import { S } from "../strings";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";

interface UserMenuProps {
  displayName: string;
  onLogout: () => void | Promise<void>;
  /** Navigates to /settings. Omitted on the settings page itself (the
   *  brand mark links home instead). */
  onSettings?: () => void;
  /** #184: opens the share surface. Supplied only under 640px, where the
   *  bottom bar no longer owns a Share item; the row is absent entirely
   *  when unset, so the desktop menu is byte-identical to before. */
  onShare?: () => void;
  /** Extra menu items (e.g. the PWA install entry). */
  extra?: ReactNode;
}

/** Header user menu, built on the shared OverflowMenu primitive: bottom
 *  sheet under 640px, anchored popover above, arrow-key navigation and
 *  focus return in both. Trigger keeps the display-name label the e2e
 *  opens ("Admin"); rows keep role=menuitem.
 *
 *  Row order: Settings (where the menu offers it), Share wishlist (mobile
 *  only, #184), Log out. */
export function UserMenu({ displayName, onLogout, onSettings, onShare, extra }: UserMenuProps) {
  const items: OverflowItem[] = [];
  if (onSettings) {
    items.push({
      id: "settings",
      label: S.settings.openSettings,
      onSelect: () => onSettings(),
    });
  }
  if (onShare) {
    items.push({
      id: "share",
      label: S.share.shareMenu,
      onSelect: () => onShare(),
    });
  }
  items.push({
    id: "logout",
    label: S.auth.signOut,
    onSelect: () => onLogout(),
  });

  return (
    <div className="user-menu">
      <OverflowMenu
        triggerLabel={displayName}
        triggerClassName="user-menu-button"
        triggerIcon={
          <span className="user-avatar-trigger" aria-hidden="true">
            {displayName.trim().charAt(0).toUpperCase()}
          </span>
        }
        menuLabel={displayName}
        extra={extra}
        items={items}
      />
    </div>
  );
}
