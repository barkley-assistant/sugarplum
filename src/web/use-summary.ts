import { useEffect, useState } from "react";
import type { Me, WishlistSummaryRow } from "../shared/types";
import { readStoredSummary, writeStoredSummary } from "./me-store";

/** #125: the wishlist summary (which lists exist + their item counts) for the
 *  non-feed pages' context bar. The feed boots this itself; every other
 *  authenticated page now shows the same context, so the fetch lives here.
 *
 *  Seeded from the same localStorage cache the feed writes (me-store), so the
 *  bar paints instantly and the request only revalidates in the background —
 *  the offline ladder the feed already boots on (a failed fetch keeps the
 *  cached rows). */
export function useWishlistSummary(me: Me | null): WishlistSummaryRow[] {
  const [rows, setRows] = useState<WishlistSummaryRow[]>(() => readStoredSummary() ?? []);
  const meId = me?.id;

  useEffect(() => {
    if (!meId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/wishlist/summary");
        if (!res.ok) return;
        const next = (await res.json()) as WishlistSummaryRow[];
        if (cancelled) return;
        setRows(next);
        writeStoredSummary(next);
      } catch {
        // Offline: the cached rows stand.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meId]);

  return rows;
}
