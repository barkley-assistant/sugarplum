import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (also the tooltip). Icon-only buttons carry no text. */
  label: string;
  children: ReactNode;
  variant?: "default" | "ghost";
  /** React 19 exposes refs as ordinary function-component props. */
  ref?: Ref<HTMLButtonElement>;
}

/** Compact 44px icon button: transparent until hovered, focus-visible ring.
 *  The SVG icon is decorative (aria-hidden); the name comes from `label`. */
export function IconButton({
  label,
  children,
  className,
  type = "button",
  variant = "default",
  ref,
  ...rest
}: IconButtonProps) {
  const classes = ["icon-btn", variant === "ghost" ? "icon-btn--ghost" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      ref={ref}
      className={classes}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}

/** 20px stroke icons sharing one visual language (currentColor, 1.8px). */

export function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 4v12M4 10h12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="5" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="14.5" cy="4.5" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="14.5" cy="15.5" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M7 9l5.5-3.2M7 11l5.5 3.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function DotsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="4.5" r="1.5" fill="currentColor" />
      <circle cx="10" cy="10" r="1.5" fill="currentColor" />
      <circle cx="10" cy="15.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Outline gear for the mobile bottom bar's Settings item (#73). Same
 *  language as the other icons: 20px box, 1.8px stroke, currentColor. */
export function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M10 2.8a1.3 1.3 0 0 1 1.3 1.3v.5c.56.15 1.08.36 1.55.64l.35-.35a1.3 1.3 0 0 1 1.84 1.84l-.35.35c.27.48.48 1 .63 1.55h.5a1.3 1.3 0 0 1 0 2.6h-.5a5.9 5.9 0 0 1-.64 1.55l.36.36a1.3 1.3 0 0 1-1.84 1.84l-.36-.36a5.9 5.9 0 0 1-1.54.63v.5a1.3 1.3 0 0 1-2.6 0v-.5a5.9 5.9 0 0 1-1.55-.64l-.36.36a1.3 1.3 0 0 1-1.84-1.84l.36-.36a5.9 5.9 0 0 1-.64-1.54H2.8a1.3 1.3 0 0 1 0-2.6h.5c.16-.54.36-1.06.64-1.54l-.36-.36a1.3 1.3 0 0 1 1.84-1.84l.36.36a5.9 5.9 0 0 1 1.54-.64v-.5A1.3 1.3 0 0 1 10 2.8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
