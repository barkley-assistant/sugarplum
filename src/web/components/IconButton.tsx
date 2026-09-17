import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (also the tooltip). Icon-only buttons carry no text. */
  label: string;
  children: ReactNode;
  variant?: "default" | "ghost";
}

/** Compact 44px icon button: transparent until hovered, focus-visible ring.
 *  The SVG icon is decorative (aria-hidden); the name comes from `label`. */
export function IconButton({
  label,
  children,
  className,
  type = "button",
  variant = "default",
  ...rest
}: IconButtonProps) {
  const classes = ["icon-btn", variant === "ghost" ? "icon-btn--ghost" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
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
