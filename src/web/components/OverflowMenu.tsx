import { Fragment, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { S } from "../strings";
import { Sheet, FOCUSABLE_SELECTOR } from "./Sheet";

export interface OverflowItem {
  id: string;
  label: string;
  onSelect: () => void | Promise<void>;
  /** Danger items render separated + tinted (Delete). */
  danger?: boolean;
  /** #127: opens a new group — a divider is drawn ABOVE this row (never
   *  above the menu's first row, which has nothing to divide). */
  section?: boolean;
  disabled?: boolean;
}

interface OverflowMenuProps {
  /** Trigger button content: an icon (row overflow) or a text label (the
   *  header user chip). The accessible name is always `triggerLabel`. */
  triggerLabel: string;
  triggerIcon?: ReactNode;
  /** Defaults to "icon-btn"; the header menu passes "user-menu-button". */
  triggerClassName?: string;
  /** Disables the trigger (e.g. while a share purchase is in flight). */
  triggerDisabled?: boolean;
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
export function OverflowMenu({ triggerLabel, triggerIcon, triggerClassName, triggerDisabled, items, menuLabel, extra }: OverflowMenuProps) {
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

  // Move focus into the desktop popover as soon as it mounts. Besides making
  // keyboard navigation discoverable, this keeps Escape targeted at the
  // menu rather than at a parent detail Sheet.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    triggerEl.current?.focus();
  }

  function choose(item: OverflowItem) {
    setOpen(false);
    // Let the menu unmount before the action opens its own Sheet/confirm,
    // so focus return lands sanely and overlays never stack.
    setTimeout(() => {
      triggerEl.current?.focus();
      void item.onSelect();
    }, 0);
  }

  /** Focusable rows inside the menu surface, in DOM order. Shares the Sheet's
   *  tabbable selector so the mobile wrap closes on the same boundaries. */
  function menuFocusables(): HTMLElement[] {
    const menu = menuRef.current;
    if (!menu) return [];
    return Array.from(menu.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  /** Arrow-key navigation shared by both containers. */
  function onMenuKeyDown(e: ReactKeyboardEvent) {
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
      if (desktop) {
        // Desktop popover: Tab leaves the menu naturally (focus walks on
        // inside the enclosing surface); only the mobile sheet wraps.
        closeAndFocusTrigger();
        return;
      }
      // Mobile sheet: the Sheet defers keydown inside a [role="menu"] subtree
      // to this handler, so the wrap has to live here — without it Tab past
      // the last row walks out of the modal into the page behind the scrim.
      const items = menuFocusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function renderItems() {
    const rows: ReactNode[] = [];
    let dangerStarted = false;
    // No divider directly above the menu's top edge, and never two in a row —
    // a divider separates groups, so it needs a row above it to separate from.
    let previousWasDivider = true;
    function divider(key: string) {
      if (previousWasDivider) return;
      rows.push(<div key={key} className="overflow-separator" aria-hidden="true" />);
      previousWasDivider = true;
    }
    for (const item of items) {
      // #127: a section opener is divided from the group above it, and the
      // danger divider is the same grammar for Delete.
      if (item.danger && !dangerStarted) {
        dangerStarted = true;
        divider("__danger-separator");
      }
      if (item.section) divider(`__section-separator-${item.id}`);
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
      previousWasDivider = false;
    }
    if (extra) rows.push(<Fragment key="__extra">{extra}</Fragment>);
    return rows;
  }

  const setTriggerRef = useCallback((el: HTMLButtonElement | null) => {
    triggerEl.current = el;
  }, []);

  const iconOnly = triggerIcon !== undefined;

  return (
    <>
      <button
        type="button"
        ref={setTriggerRef}
        className={triggerClassName ?? "icon-btn"}
        aria-label={iconOnly ? triggerLabel : undefined}
        title={iconOnly ? triggerLabel : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={triggerDisabled}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerIcon ?? triggerLabel}
      </button>
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
          // The mobile sheet portals to document.body: .topbar's
          // backdrop-filter makes it a containing block for position: fixed,
          // which would clip the overlay to a topbar-height strip (#60).
          // Mirrors ShareMenu's portal for the mobile branch.
          createPortal(
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
            </Sheet>,
            document.body,
          )
        ))}
    </>
  );
}
