import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { S } from "../strings";
import { Sheet } from "./Sheet";
import { SharePanel } from "./SharePanel";

interface ShareMenuProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Responsive owner share surface: an anchored popover on desktop and the
 * shared bottom-sheet primitive on mobile. The content stays in SharePanel so
 * both surfaces expose exactly the same link-management actions. */
export function ShareMenu({ open, onClose, triggerRef }: ShareMenuProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 640px)").matches : true,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 640px)");
    const onChange = () => setDesktop(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open || !desktop) return;

    function onDocumentMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      const element = event.target instanceof Element ? event.target : null;
      // Confirm dialogs render at the app root, outside the popover. Keep the
      // parent surface alive while the user confirms a share operation.
      if (element?.closest(".confirm-overlay")) return;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        onClose();
        triggerRef.current?.focus();
      }
    }

    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      onClose();
      triggerRef.current?.focus();
    }

    document.addEventListener("mousedown", onDocumentMouseDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [desktop, onClose, open, triggerRef]);

  useEffect(() => {
    if (!open || !desktop) return;
    const raf = requestAnimationFrame(() => {
      popoverRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [desktop, open]);

  function onPopoverKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const items = popoverRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!items || items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  if (!desktop) {
    return createPortal(
      <Sheet open onClose={onClose} ariaLabel={S.share.shareList} boxClassName="sheet--share">
        <div className="detail-handle" aria-hidden="true" />
        <SharePanel />
      </Sheet>,
      document.body,
    );
  }

  return (
    <div
      ref={popoverRef}
      className="share-popover menu-sheet"
      role="dialog"
      aria-label={S.share.shareList}
      onKeyDown={onPopoverKeyDown}
    >
      <SharePanel />
    </div>
  );
}
