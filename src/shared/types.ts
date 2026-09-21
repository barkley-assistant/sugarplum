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
  /** Daily price-tracking opt-in (default on): when false the server skips
   *  this user's items in the daily tracking pass. */
  priceTrackingEnabled: boolean;
  /** #98: admin UI-exposure opt-in (default off). When true AND isAdmin, the
   *  settings area shows the Users management screens. UI GATING ONLY: never
   *  consulted by /api/users* authorization — the server's requireAdmin 403
   *  is the enforcement, and it applies whether this is on or off. */
  showUserManagement: boolean;
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
  /** #76: the OWNER's own "I bought this" mark. This is owner data about
   *  THEMSELVES — unrelated to the anonymous share-link purchased flag,
   *  which is never transmitted to the owner on any surface. */
  ownerPurchased: boolean;
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
  /** 90-day window series, oldest first, capped at the server's series cap. */
  series: PricePoint[];
  /** Trend derived server-side from the series; null on mixed currencies. */
  trend: PriceTrend | null;
}

/** One observation in the 90-day series. Decimal string, like the API. */
export interface PricePoint {
  observedAt: string;
  priceCents: string;
  currency: string | null;
}

/** Buy-time signal derived from the series (single source of truth: the
 *  server derives it; the client renders it). Informational only. */
export interface PriceTrend {
  direction: "rising" | "falling" | "stable";
  advice:
    | "below-30d-avg"
    | "near-30d-low"
    | "near-30d-high"
    | "trending-down"
    | "stable"
    | "insufficient";
  daysSinceDrop: number | null;
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

/** Anonymous share view of an item. A dedicated DTO: never OwnedItem (owner
 *  data) and never PublicItem (claim state).
 *
 *  The informational fields (priceStats, createdAt, imageSource) are PRODUCT
 *  facts and are sent to every viewer, the owner included — the ledger and the
 *  row carry no owner identity. The only owner-sensitive field on this DTO is
 *  `purchased`, which the server projects out for the owner. */
export interface ShareItem {
  id: string;
  title: string;
  url: string | null;
  priceCents: string | null;
  currency: string | null;
  notes: string | null;
  tags: string[];
  siteName: string | null;
  /** Added date — the share footer shows it, like the owner's item page. */
  createdAt: string;
  /** Lowest + earliest observation from price_history, plus the capped 90-day
   *  series and server-derived trend; null when the item has no history. The
   *  same derivation the owner's list uses. */
  priceStats: PriceStats | null;
  /** Where the stored image came from: 'direct' | 'search' | null. A
   *  provenance flag for the footer — never the image path. */
  imageSource: string | null;
  /** True when the item has a stored image; bytes are served token-scoped
   *  at /api/share/:token/items/:id/image (never the item-scoped path). */
  hasImage: boolean;
  /** Purchased-via-share-link. ALWAYS false in responses to the owner
   *  (server-side projection — never trust the client to hide it). */
  purchased: boolean;
}

export interface ShareView {
  ownerDisplayName: string;
  /** True when the requester's session (if any) IS the list owner. Tells the
   *  requester only about THEMSELVES — no leak. Hides the mark action. */
  viewerIsOwner: boolean;
  items: ShareItem[];
}

/** GET/POST /api/share. `path` is the share path; the client prefixes its own
 *  origin — the server cannot know its public URL behind the tunnel. */
export interface ShareLinkResponse {
  token: string | null;
  path: string | null;
}

export interface PurchaseResponse {
  id: string;
  purchased: boolean;
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