import type { ReactNode } from "react";
import { S } from "../strings";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";

interface UserMenuProps {
  displayName: string;
  onLogout: () => void | Promise<void>;
  /** Navigates to /settings. Omitted on the settings page itself (the
   *  brand mark links home instead). */
  onSettings?: () => void;
  /** Extra menu items (e.g. the PWA install entry). */
  extra?: ReactNode;
}

/** Header user menu, built on the shared OverflowMenu primitive: bottom
 *  sheet under 640px, anchored popover above, arrow-key navigation and
 *  focus return in both. Trigger keeps the display-name label the e2e
 *  opens ("Admin"); rows keep role=menuitem. */
export function UserMenu({ displayName, onLogout, onSettings, extra }: UserMenuProps) {
  const items: OverflowItem[] = [];
  if (onSettings) {
    items.push({
      id: "settings",
      label: S.settings.openSettings,
      onSelect: () => onSettings(),
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
        menuLabel={displayName}
        extra={extra}
        items={items}
      />
    </div>
  );
}
