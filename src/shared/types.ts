/** API DTOs shared by server and client. Prices are exchanged as decimal
 *  strings ("24.99"); the DB stores integer cents. No floats, ever. */

export interface Me {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  /** Honesty gate: when false the UI hides automated price-search hints and
   *  the server skips attaching them during enrichment. */
  hintsEnabled: boolean;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
}

export interface CommonItem {
  id: string;
  title: string;
  url: string | null;
  imagePath: string | null;
  /** Where imagePath came from: 'direct' (downloaded from the pasted page),
   *  'search' (labelled SearXNG fallback image), or null for rows that
   *  predate the column. */
  imageSource: string | null;
  priceCents: string | null;
  currency: string | null;
  notes: string | null;
  tags: string[];
  sortOrder: number;
  createdAt: string;
  /** 'pending' while a background scrape is running; 'failed' when a scrape
   *  (and any search hint) could not produce a usable item. */
  fetchState: "pending" | "complete" | "failed";
  /** Source site name from og:site_name, or the hostname fallback. */
  siteName: string | null;
}

/** Owner view of an item. Deliberately has NO claim fields — the API never
 *  transmits claim state to an item's owner. Hint fields are owner data:
 *  PublicItem stays lean. */
export interface OwnedItem extends CommonItem {
  updatedAt: string;
  /** Best-effort SearXNG price hint (decimal string, like priceCents). */
  hintPriceCents: string | null;
  hintCurrency: string | null;
  hintSourceUrl: string | null;
  /** Who wrote priceCents: 'scrape' | 'searxng-hint' | 'manual', or null for
   *  rows that predate the column (read as user-authored). */
  priceSource: string | null;
  /** The owner's manual "found it cheaper at" link. Never a public field. */
  cheaperUrl: string | null;
  /** Lowest + earliest price observation from price_history; null when the
   *  item has no history rows at all. */
  priceStats: PriceStats | null;
}

/** Derived summary of an item's price_history ledger. Every money value is a
 *  decimal string, like the rest of the API. */
export interface PriceStats {
  lowestCents: string;
  lowestCurrency: string | null;
  /** ISO timestamp of the first observation of the lowest price. */
  lowestSeenAt: string | null;
  /** The earliest observation — the price the item was added at. */
  atAddCents: string | null;
  atAddCurrency: string | null;
}

/** One automated "prices seen elsewhere" candidate. Display-only: never
 *  persisted, never presented as a verified comparison. */
export interface PriceCandidate {
  priceCents: string;
  currency: string;
  sourceUrl: string;
  sourceTitle: string;
}

/** POST /api/wishlist/items/:id/hints response. `disabled` means the viewer
 *  turned price hints off in settings — not that the search found nothing. */
export interface PriceHintsResponse {
  hints: PriceCandidate[];
  disabled: boolean;
}

/** Client-side state of one on-demand candidates lookup. */
export interface PriceHintState {
  status: "loading" | "done" | "error";
  hints: PriceCandidate[];
  disabled: boolean;
}

/** Viewer is not the owner: only booleans, never claimant identity. */
export interface PublicItem extends CommonItem {
  claimed: boolean;
  claimedByYou: boolean;
}

export interface WishlistSummaryRow {
  userId: string;
  displayName: string;
  itemCount: number;
  claimedCount: number;
}

export interface CreateItemInput {
  title: string;
  url?: string;
  priceCents?: string;
  currency?: string;
  notes?: string;
  tags?: string[];
  cheaperUrl?: string;
}

export interface UpdateItemInput {
  title?: string;
  url?: string;
  priceCents?: string;
  currency?: string;
  notes?: string;
  tags?: string[];
  sortOrder?: number;
  /** Cleared with null (or an empty string). */
  cheaperUrl?: string | null;
}

/** PUT /api/wishlist/order body: the FULL ordered list of the viewer's item
 *  ids. The server validates it matches the viewer's wishlist exactly (no
 *  dupes, no foreign ids, no missing items) and reassigns spacing 10, 20… */
export interface ReorderRequest {
  itemIds: string[];
}