import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { S } from "../strings";
import { Sheet } from "./Sheet";

export interface OverflowItem {
  id: string;
  label: string;
  onSelect: () => void | Promise<void>;
  /** Danger items render separated + tinted (Delete). */
  danger?: boolean;
  disabled?: boolean;
}

interface TriggerApi {
  open: boolean;
  toggle: () => void;
  triggerRef: (el: HTMLButtonElement | null) => void;
}

interface OverflowMenuProps {
  /** Renders the trigger (an IconButton or a label button like the user
   *  chip). Receives open state, a toggle and a ref for focus return. */
  renderTrigger: (api: TriggerApi) => ReactNode;
  items: OverflowItem[];
  /** Accessible name for the menu (defaults to the overflow label). */
  menuLabel?: string;
  /** Caller-supplied raw rows (e.g. the PWA install entry) rendered after
   *  the items in both containers. */
  extra?: ReactNode;
}

/** One overflow primitive for item rows and the header user menu. Under
 *  640px it renders a bottom Sheet (full-width 44px rows, danger items
 *  separated, Cancel row); at >= 640px an anchored popover reusing the
 *  menu-sheet look. Both share the items array, arrow-key navigation,
 *  Home/End, Escape and focus return to the trigger. */
export function OverflowMenu({ renderTrigger, items, menuLabel, extra }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 640px)").matches : true,
  );
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Desktop popover: click-outside + Escape close, focus returns to trigger.
  useEffect(() => {
    if (!open || !desktop) return;
    function onDocClick(e: MouseEvent) {
      const menu = menuRef.current;
      const trigger = triggerEl.current;
      if (
        menu &&
        !menu.contains(e.target as Node) &&
        trigger &&
        !trigger.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerEl.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, desktop]);

  function closeAndFocusTrigger() {
    setOpen(false);
    triggerEl.current?.focus();
  }

  function choose(item: OverflowItem) {
    setOpen(false);
    // Let the menu unmount before the action opens its own Sheet/confirm,
    // so focus return lands sanely and overlays never stack.
    queueMicrotask(() => {
      triggerEl.current?.focus();
      void item.onSelect();
    });
  }

  /** Arrow-key navigation shared by both containers. */
  function onMenuKeyDown(e: React.KeyboardEvent) {
    const rows = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    if (!rows || rows.length === 0) return;
    const current = Array.from(rows).indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      rows[(current + 1 + rows.length) % rows.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      rows[(current - 1 + rows.length) % rows.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      rows[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      rows[rows.length - 1].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeAndFocusTrigger();
    } else if (e.key === "Tab") {
      // Let Tab leave naturally on desktop; Sheet traps it on mobile.
      if (desktop) closeAndFocusTrigger();
    }
  }

  function renderItems() {
    const rows: ReactNode[] = [];
    let dangerStarted = false;
    for (const item of items) {
      if (item.danger && !dangerStarted) {
        dangerStarted = true;
        rows.push(<div key="__danger-separator" className="overflow-separator" aria-hidden="true" />);
      }
      rows.push(
        <button
          key={item.id}
          type="button"
          className={item.danger ? "menu-item menu-item-danger" : "menu-item"}
          role="menuitem"
          disabled={item.disabled}
          aria-disabled={item.disabled || undefined}
          onClick={() => choose(item)}
        >
          {item.label}
        </button>,
      );
    }
    if (extra) rows.push(<Fragment key="__extra">{extra}</Fragment>);
    return rows;
  }

  const api: TriggerApi = {
    open,
    toggle: () => setOpen((v) => !v),
    triggerRef: (el) => {
      triggerEl.current = el;
    },
  };

  return (
    <>
      {renderTrigger(api)}
      {open &&
        (desktop ? (
          <div
            ref={menuRef}
            className="menu-sheet overflow-popover"
            role="menu"
            id={menuId}
            aria-label={menuLabel ?? S.item.moreActions}
            onKeyDown={onMenuKeyDown}
          >
            {renderItems()}
          </div>
        ) : (
          <Sheet open onClose={closeAndFocusTrigger} ariaLabel={menuLabel ?? S.item.moreActions}>
            <div
              ref={menuRef}
              role="menu"
              id={menuId}
              aria-label={menuLabel ?? S.item.moreActions}
              className="overflow-sheet-list"
              onKeyDown={onMenuKeyDown}
            >
              {renderItems()}
              <div className="overflow-separator" aria-hidden="true" />
              <button type="button" className="menu-item overflow-cancel" role="menuitem" onClick={closeAndFocusTrigger}>
                {S.confirm.cancel}
              </button>
            </div>
          </Sheet>
        ))}
    </>
  );
}
