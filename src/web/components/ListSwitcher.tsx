import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { S } from "../strings";
import { Sheet } from "./Sheet";

interface ListSwitcherProps {
  /** Display name whose list is currently shown. */
  currentName: string;
  /** Own list first, then other accessible lists in display-name order. */
  rows: { userId: string; displayName: string; itemCount: number }[];
  /** The currently shown user; null means the signed-in user's list. */
  currentUserId: string | null;
  /** Count for the currently shown list. */
  count?: number;
  /** Select a list; null returns to the signed-in user's list. */
  onSelect: (userId: string | null) => void;
  /** Optional action beside the count (for example, a reorder-mode toggle). */
  action?: ReactNode;
}

function CaretIcon() {
  return (
    <svg
      className="list-switcher-caret"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="m3 7.25 2.5 2.5L11 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Heading trigger and responsive wishlist selector. Desktop uses an anchored
 * menu; mobile uses the shared bottom-sheet primitive. */
export function ListSwitcher({ currentName, rows, currentUserId, count, onSelect, action }: ListSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 640px)").matches : true,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const surfaceId = useId();

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 640px)");
    const onChange = () => setDesktop(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open || !desktop) return;

    function onDocumentClick(event: MouseEvent) {
      const target = event.target as Node;
      if (!surfaceRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [desktop, open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(userId: string | null) {
    const isCurrent = userId === currentUserId;
    setOpen(false);
    if (desktop) triggerRef.current?.focus();
    if (!isCurrent) onSelect(userId);
  }

  function onSurfaceKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const rows = surfaceRef.current?.querySelectorAll<HTMLButtonElement>("button.switcher-row");
    if (!rows || rows.length === 0) return;
    const current = Array.from(rows).indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows[(current + 1 + rows.length) % rows.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      rows[(current - 1 + rows.length) % rows.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      rows[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      rows[rows.length - 1].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
    } else if (event.key === "Tab" && desktop) {
      setOpen(false);
    }
  }

  function renderRows() {
    return rows.map((row) => {
      const isCurrent = row.userId === currentUserId;
      return (
        <button
          key={row.userId}
          type="button"
          className="menu-item switcher-row"
          {...(desktop
            ? { role: "menuitemradio" as const, "aria-checked": isCurrent }
            : { "aria-current": isCurrent ? "page" : undefined })}
          onClick={() => choose(row.userId === rows[0]?.userId ? null : row.userId)}
        >
          <span className="switcher-name">
            {isCurrent && <span className="switcher-check"><CheckIcon /></span>}
            {row.displayName}
          </span>
          <span className="switcher-count">{S.list.itemCount(row.itemCount)}</span>
        </button>
      );
    });
  }

  return (
    <div className="list-switcher">
      <div className="list-heading">
        <h2 className="page-title">
          <button
            ref={triggerRef}
            type="button"
            className="list-switcher-trigger"
            aria-expanded={open}
            aria-haspopup={desktop ? "menu" : "dialog"}
            aria-controls={open && desktop ? surfaceId : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="list-switcher-name">{S.list.heading(currentName)}</span>
            <CaretIcon />
          </button>
        </h2>
        {(count !== undefined || action) && (
          <div className="list-heading-meta">
            {count !== undefined && <span className="count">{S.list.itemCount(count)}</span>}
            {action && <div className="list-heading-action">{action}</div>}
          </div>
        )}
      </div>

      {open && desktop ? (
        <div
          ref={surfaceRef}
          id={surfaceId}
          className="menu-sheet list-switcher-popover"
          role="menu"
          aria-label={S.list.switcherLabel}
          onKeyDown={onSurfaceKeyDown}
        >
          {renderRows()}
        </div>
      ) : (
        <Sheet open={open && !desktop} onClose={closeAndFocusTrigger} ariaLabel={S.list.switcherLabel}>
          <div ref={surfaceRef} className="overflow-sheet-list" onKeyDown={onSurfaceKeyDown}>
            {renderRows()}
          </div>
        </Sheet>
      )}
    </div>
  );
}
