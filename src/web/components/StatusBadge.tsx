import type { ReactNode } from "react";

export type StatusVariant = "claimed" | "purchased" | "fetching" | "failed";

const LEGACY_CLASS: Record<StatusVariant, string> = {
  claimed: "claimed-badge",
  purchased: "share-purchased-badge",
  fetching: "fetch-state",
  failed: "fetch-state",
};

/** One visual language for row state. Keeps the legacy class each variant
 *  grew (claimed-badge, share-purchased-badge, fetch-state) so e2e anchors
 *  and existing CSS keep working. */
export function StatusBadge({ variant, children }: { variant: StatusVariant; children: ReactNode }) {
  return (
    <span className={`status status--${variant} ${LEGACY_CLASS[variant]}`}>
      {children}
    </span>
  );
}
