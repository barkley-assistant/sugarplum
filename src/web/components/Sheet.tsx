import { useEffect, useRef, type ReactNode } from "react";

interface SheetProps {
  /** Controlled visibility. Mounts nothing when false. */
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog region. */
  ariaLabel: string;
  children: ReactNode;
  /** "sheet" = bottom-sheet on mobile / centred on >=640px; "dialog" =
   *  centred confirm-style box on every width. */
  variant?: "sheet" | "dialog";
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
    openerRef.current = document.activeElement;
    const box = boxRef.current;
    // Focus the first focusable element (the form's autofocused URL field,
    // the first menu row, the confirm button) once mounted.
    const focusables = () =>
      box
        ? Array.from(
            box.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
    const raf = requestAnimationFrame(() => {
      focusables()[0]?.focus();
    });
    function onKey(e: KeyboardEvent) {
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
      // Focus return; guarded for iOS Safari where programmatic focus can
      // scroll-jump (the opener is still keyboard-reachable regardless).
      const opener = openerRef.current as HTMLElement | null;
      if (opener && typeof opener.focus === "function") {
        try {
          opener.focus({ preventScroll: true });
        } catch {
          // Focus return is best-effort; a failure must never break close.
        }
      }
    };
  }, [open ]);

  if (!open) return null;

  const overlayClass = variant === "dialog" ? "confirm-overlay" : "sheet-overlay";
  const boxClass = variant === "dialog" ? "confirm-dialog" : "sheet";

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
