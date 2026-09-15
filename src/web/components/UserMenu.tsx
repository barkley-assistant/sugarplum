import { useEffect, useRef, useState, type ReactNode } from "react";
import { S } from "../strings";

interface UserMenuProps {
  displayName: string;
  isAdmin: boolean;
  onLogout: () => void | Promise<void>;
  /** Scrolls to the admin panel (rendered on the page for admins). */
  onAdmin?: () => void;
  /** Extra menu items (e.g. the PWA install entry). */
  extra?: ReactNode;
}

export function UserMenu({ displayName, isAdmin, onLogout, onAdmin, extra }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        {displayName}
      </button>
      {open && (
        <div className="menu-sheet" role="menu">
          {isAdmin && onAdmin && (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAdmin();
              }}
            >
              {S.admin.users}
            </button>
          )}
          {extra}
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void onLogout();
            }}
          >
            {S.auth.signOut}
          </button>
        </div>
      )}
    </div>
  );
}