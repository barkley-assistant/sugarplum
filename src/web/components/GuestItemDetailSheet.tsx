import { useEffect, useState, type ReactNode } from "react";
import type { PriceStats } from "../../shared/types";
import { formatDate, formatPrice, urlHost } from "../format";
import { useBackDismiss } from "../use-back-dismiss";
import { S } from "../strings";
import { useToast } from "../toast";
import { DetailMeta } from "./DetailMeta";
import { priceDelta } from "./ItemCard";
import { PriceHistoryCard } from "./PriceHistoryCard";
import { ProductImage } from "./ProductImage";
import { Sheet } from "./Sheet";
import { StatusBadge } from "./StatusBadge";

/** Normalized read-only detail input — deliberately NOT a DTO. Both guest
 *  callers (the other-user wishlist's PublicItem, the anonymous share view's
 *  ShareItem) map their projection into this shape, so the sheet can never
 *  render a field the server did not send to that exact surface. Every
 *  INFORMATIONAL section the owner page shows is representable here; owner-only
 *  actions (edit, re-check, blind reset, delete) and owner-only data (hint
 *  price, cheaper link, prices-elsewhere candidates) are not. */
export interface GuestItemDetail {
  id: string;
  title: string;
  url: string | null;
  priceCents: string | null;
  currency: string | null;
  notes: string | null;
  tags: string[];
  siteName: string | null;
  /** Already resolved by the caller: session-scoped for other-user rows,
   *  token-scoped for share rows. */
  imageSrc?: string;
  /** Both guests carry the add date now (CommonItem and ShareItem); the
   *  footer is omitted only when a caller has none. */
  createdAt?: string | null;
  /** Derived price history. Share rows carry it; the other-user projection
   *  has no ledger, so it passes null and the card stays absent. */
  priceStats?: PriceStats | null;
  /** Where the stored image came from ('direct' | 'search' | null) — the
   *  footer's provenance note. Product fact, never the image path. */
  imageSource?: string | null;
  /** Share rows only: a shared-link viewer may already know an item is
   *  bought. PublicItem has no such field, so other-user rows never pass it. */
  purchased?: boolean;
}

interface GuestItemDetailSheetProps {
  item: GuestItemDetail;
  onClose: () => void;
}

/** Read-only detail surface for the two guest projections (an authenticated
 *  other user's wishlist and the anonymous share link). Same Sheet shell and
 *  detail classes as the owner's item page (#62 moved the owner flow out of a
 *  sheet; this surface stays a sheet — same structure and density).
 *
 *  Every INFORMATIONAL section of the owner page is mirrored here — price
 *  history, lowest/at-add context, notes, tags, "More information", the
 *  sourced footer — while every owner ACTION stays out: no edit, no re-check,
 *  no reset, no delete, no overflow menu, and no prices-elsewhere toggle (the
 *  live candidate search is an owner-only route, not a public one). */
export function GuestItemDetailSheet({ item, onClose }: GuestItemDetailSheetProps) {
  // #72: the app back button (browser/Android back) is a dismissal path for
  // this surface, alongside Escape and overlay-click.
  useBackDismiss(onClose);
  const toast = useToast();
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : false,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setDesktop(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const site = item.siteName ?? (item.url ? urlHost(item.url) : null);
  const price = formatPrice(item.priceCents, item.currency);
  const notes = item.notes?.trim();
  const stats = item.priceStats ?? null;
  const delta = priceDelta(item.priceCents, item.currency, stats);
  const meta = stats ? S.item.lowestSeen(formatPrice(stats.lowestCents, stats.lowestCurrency)) : null;
  const footerHost = item.url ? urlHost(item.url) : null;

  /** The item's own URL — already public to anyone holding the link (the
   *  "Open product" button above it). HTTPS + a user gesture required, so a
   *  blocked clipboard degrades to the error toast, like the owner's copy. */
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast(S.item.copied);
    } catch {
      toast(S.errors.generic, "danger");
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      ariaLabel={item.title}
      variant={desktop ? "drawer" : "sheet"}
      boxClassName={desktop ? undefined : "sheet--detail"}
    >
      <div className="detail-handle" aria-hidden="true" />

      <div className="detail-scroll">
        <div className="detail-hero">
          {item.imageSrc ? (
            <ProductImage src={item.imageSrc} />
          ) : (
            <span className="product-img-fallback" aria-hidden="true" />
          )}
          <div className="detail-hero-info">
            <h2 className="detail-title">{item.title}</h2>
            {site && <span className="detail-site">{site}</span>}
            {price && <span className="detail-price">{price}</span>}
            {item.purchased && (
              <StatusBadge variant="purchased">{S.share.purchasedBadge}</StatusBadge>
            )}
            <DetailMeta meta={meta} delta={delta} />
          </div>
        </div>

        {item.url && (
          <div className="detail-actions">
            <a
              className="detail-open-btn"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              <ExternalLinkIcon />
              {S.detail.openProduct}
            </a>
          </div>
        )}

        {stats && <PriceHistoryCard stats={stats} currency={item.currency} />}

        {notes && (
          <section className="detail-card detail-notes-card">
            <div className="detail-card-heading">
              <NoteIcon />
              <h3 className="detail-card-title">{S.detail.notesTitle}</h3>
            </div>
            <p className="detail-notes-body">{notes}</p>
          </section>
        )}

        {item.tags.length > 0 && (
          <section className="detail-card detail-tags-card">
            <div className="detail-card-heading">
              <TagIcon />
              <h3 className="detail-card-title">{S.detail.tagsTitle}</h3>
            </div>
            <div className="detail-tags">
              {item.tags.map((tag) => (
                <span className="tag-pill" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}

        {item.url && (
          <section className="detail-card detail-more-card">
            <div className="detail-card-heading">
              <LinkIcon />
              <h3 className="detail-card-title">{S.detail.moreInfoTitle}</h3>
            </div>
            <a
              className="detail-row"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              <ExternalLinkIcon />
              <span>{S.detail.viewOn(site ?? urlHost(item.url))}</span>
              <ChevronRightIcon />
            </a>
            <button type="button" className="detail-row" onClick={() => copyLink(item.url as string)}>
              <LinkIcon />
              <span>{S.item.copyLink}</span>
            </button>
            {/* No prices-elsewhere toggle: the candidate search is a live,
                owner-only scrape (403 for everyone else), so the share
                surface shows the item's own link and nothing derived from
                a search the viewer cannot be trusted with. */}
          </section>
        )}

        {(item.createdAt || footerHost || item.imageSource === "search") && (
          <div className="detail-footer">
            {item.createdAt && <span>{S.detail.addedOn(formatDate(item.createdAt))}</span>}
            {(footerHost || item.imageSource === "search") && (
              <span className="detail-footer-source">
                {footerHost}
                {footerHost && item.imageSource === "search" && <span aria-hidden="true"> · </span>}
                {item.imageSource === "search" && S.item.imageViaSearch}
              </span>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <Icon>
      <path
        d="M11 4h5v5M16 4l-7 7M14 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  );
}

function NoteIcon() {
  return (
    <Icon>
      <path
        d="M5 3.5h7l3 3V16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M12 3.8V7h3M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </Icon>
  );
}

function TagIcon() {
  return (
    <Icon>
      <path
        d="M3.8 4.2h5.5l6.9 6.9-5.1 5.1-6.9-6.9V4.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="7.2" cy="7.2" r="1" fill="currentColor" />
    </Icon>
  );
}

function LinkIcon() {
  return (
    <Icon>
      <path
        d="m8.1 11.9 3.8-3.8M6.3 14.3l-1.1 1.1a2.7 2.7 0 0 1-3.8-3.8l2.2-2.2a2.7 2.7 0 0 1 3.8 0M13.7 5.7l1.1-1.1a2.7 2.7 0 0 1 3.8 3.8l-2.2 2.2a2.7 2.7 0 0 1-3.8 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Icon>
  );
}

function ChevronRightIcon() {
  return (
    <Icon size={16}>
      <path
        d="m7.5 4 5 6-5 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  );
}
