import type { Me, WishlistSummaryRow } from "../shared/types";

/** Shared localStorage cache for the signed-in identity and the wishlist
 *  summary (user-switcher chips). Extracted from AppPage so SettingsPage
 *  reuses the same keys and shape — one source of truth for the cache. */

export const STORAGE_KEY_ME = "sugarplum.me";
export const STORAGE_KEY_SUMMARY = "sugarplum.summary";

export function readStoredMe(): Me | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Me>;
    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      return {
        id: parsed.id,
        username: parsed.username ?? "",
        displayName: parsed.displayName ?? "",
        isAdmin: Boolean(parsed.isAdmin),
        // Older cached payloads predate the field; default to hints ON (the
        // server default) so the offline shell matches a fresh session.
        hintsEnabled: parsed.hintsEnabled !== false,
      };
    }
  } catch {
    // Corrupted entry — ignore and fall through to no-identity error.
  }
  return null;
}

export function writeStoredMe(me: Me): void {
  try {
    localStorage.setItem(STORAGE_KEY_ME, JSON.stringify(me));
  } catch {
    // Storage may be unavailable (private mode); offline fallback just won't work.
  }
}

export function clearStoredIdentity(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_ME);
    localStorage.removeItem(STORAGE_KEY_SUMMARY);
  } catch {
    // Ignore.
  }
}

export function readStoredSummary(): WishlistSummaryRow[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SUMMARY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as WishlistSummaryRow[];
  } catch {
    // Ignore.
  }
  return null;
}

export function writeStoredSummary(rows: WishlistSummaryRow[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_SUMMARY, JSON.stringify(rows));
  } catch {
    // Ignore.
  }
}
