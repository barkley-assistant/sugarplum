import { useEffect, useRef, type ReactNode } from "react";

const openStack: symbol[] = [];

/** Tabbable descendants of a container, in DOM order: the set the Sheet traps
 *  focus within and OverflowMenu's mobile branch wraps at. */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface SheetProps {
  /** Controlled visibility. Mounts nothing when false. */
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog region. */
  ariaLabel: string;
  children: ReactNode;
  /** "sheet" = bottom-sheet on mobile / centred on >=640px; "dialog" =
   *  centred confirm-style box on every width; "drawer" = right-anchored
   *  full-height detail surface on wide screens. */
  variant?: "sheet" | "dialog" | "drawer";
  /** Optional modifier appended to the variant box class. */
  boxClassName?: string;
  /** Confirm flows keep the alertdialog role; everything else is dialog. */
  role?: "dialog" | "alertdialog";
}

/** One overlay/sheet primitive for the add-item sheet, the edit sheet, the
 *  mobile overflow menu and the confirm dialog. Focus moves to the first
 *  focusable element on open, Tab cycles within the sheet, Escape closes,
 *  and focus returns to the opener on close. */
export function Sheet({
  open,
  onClose,
  ariaLabel,
  children,
  variant = "sheet",
  boxClassName,
  role = "dialog",
}: SheetProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const stackToken = Symbol();
    openStack.push(stackToken);
    openerRef.current = document.activeElement;
    const box = boxRef.current;
    // Focus the first focusable element (the form's autofocused URL field,
    // the first menu row, the confirm button) once mounted.
    const focusables = () =>
      box
        ? Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        : [];
    const raf = requestAnimationFrame(() => {
      focusables()[0]?.focus({ preventScroll: true });
    });
    function onKey(e: KeyboardEvent) {
      if (openStack[openStack.length - 1] !== stackToken) return;
      // A sibling popover/menu (or a stacked dialog) owns keyboard events
      // while focus is outside this sheet's box. Desktop menus live inside
      // the box, so check the menu subtree explicitly as well — the menu's
      // own handler then owns those keys, including the mobile Tab wrap.
      if (box && e.target instanceof Node) {
        const menu = box.querySelector('[role="menu"]');
        if (menu?.contains(e.target)) return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !box) return;
      const items = focusables();
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
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      const wasTopmost = openStack[openStack.length - 1] === stackToken;
      const stackIndex = openStack.indexOf(stackToken);
      if (stackIndex >= 0) openStack.splice(stackIndex, 1);
      // Focus return; guarded for iOS Safari where programmatic focus can
      // scroll-jump (the opener is still keyboard-reachable regardless).
      const opener = openerRef.current as HTMLElement | null;
      if (wasTopmost && opener && typeof opener.focus === "function") {
        try {
          opener.focus({ preventScroll: true });
        } catch {
          // Focus return is best-effort; a failure must never break close.
        }
      }
    };
  }, [open]);

  if (!open) return null;

  const overlayClass =
    variant === "dialog" ? "confirm-overlay" : variant === "drawer" ? "detail-overlay" : "sheet-overlay";
  const baseBoxClass = variant === "dialog" ? "confirm-dialog" : variant === "drawer" ? "detail-drawer" : "sheet";
  const boxClass = [baseBoxClass, boxClassName].filter(Boolean).join(" ");

  return (
    <div
      className={overlayClass}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        className={boxClass}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>
  );
}
