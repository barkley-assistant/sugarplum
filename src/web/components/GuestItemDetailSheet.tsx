import { useEffect, useState, type ReactNode } from "react";
import { formatDate, formatPrice, urlHost } from "../format";
import { useBackDismiss } from "../use-back-dismiss";
import { S } from "../strings";
import { ProductImage } from "./ProductImage";
import { Sheet } from "./Sheet";
import { StatusBadge } from "./StatusBadge";

/** Normalized read-only detail input — deliberately NOT a DTO. Both guest
 *  callers (the other-user wishlist's PublicItem, the anonymous share view's
 *  ShareItem) map their projection into this shape, so the sheet can never
 *  render a field the server did not send to that exact surface. Owner-only
 *  data (hint price, price history, cheaper link) and owner-only actions
 *  (edit, re-check, blind reset, delete) are not representable here. */
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
  /** Other-user rows carry the add date (CommonItem); the share DTO does
   *  not, so the footer is omitted for share viewers. */
  createdAt?: string | null;
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
 *  sheet; this surface stays a sheet — same structure and density, no owner
 *  affordances: no edit, no price history, no hints, no reset, no delete, and
 *  no overflow menu). */
export function GuestItemDetailSheet({ item, onClose }: GuestItemDetailSheetProps) {
  // #72: the app back button (browser/Android back) is a dismissal path for
  // this surface, alongside Escape and overlay-click.
  useBackDismiss(onClose);
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
          </div>
        </div>

        {item.url && (
          <div className="detail-actions">
            <a className="detail-open-btn" href={item.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              {S.detail.openProduct}
            </a>
          </div>
        )}

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

        {item.createdAt && (
          <div className="detail-footer">
            <span>{S.detail.addedOn(formatDate(item.createdAt))}</span>
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
