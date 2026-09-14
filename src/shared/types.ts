/** API DTOs shared by server and client. Prices are exchanged as decimal
 *  strings ("24.99"); the DB stores integer cents. No floats, ever. */

export interface Me {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
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
}

export interface UpdateItemInput {
  title?: string;
  url?: string;
  priceCents?: string;
  currency?: string;
  notes?: string;
  tags?: string[];
  sortOrder?: number;
}