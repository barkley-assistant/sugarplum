import { useEffect, useState, type ReactNode } from "react";
import type { OwnedItem, PriceHintState } from "../../shared/types";
import { formatDate, formatPrice, urlHost } from "../format";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { HintsBlock } from "./PriceCluster";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { DotsIcon, IconButton } from "./IconButton";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { ProductImage } from "./ProductImage";
import { Sheet } from "./Sheet";
import { StatusBadge } from "./StatusBadge";
import { priceDelta } from "./ItemCard";

interface ItemDetailSheetProps {
  item: OwnedItem;
  onClose: () => void;
  onEdit: (id: string, values: ItemFormValues) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onRefresh: (id: string) => void | Promise<void>;
  onResetPurchased: (id: string) => void | Promise<void>;
  onCheckPrices: (id: string) => void | Promise<void>;
  hintState?: PriceHintState;
}

export function ItemDetailSheet({
  item,
  onClose,
  onEdit,
  onDelete,
  onRefresh,
  onResetPurchased,
  onCheckPrices,
  hintState,
}: ItemDetailSheetProps) {
  const [editing, setEditing] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : false,
  );
  const confirm = useConfirm();
  const toast = useToast();

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setDesktop(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  async function copyProductLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast(S.item.copied);
    } catch {
      toast(S.errors.generic, "danger");
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: S.confirm.deleteItem(item.title),
      body: S.confirm.deleteItemBody,
    });
    if (ok) await onDelete(item.id);
  }

  async function handleResetPurchased() {
    const ok = await confirm({
      title: S.share.resetConfirmTitle,
      body: S.share.resetConfirmBody,
      confirmLabel: S.share.resetPurchased,
      danger: false,
    });
    if (ok) await onResetPurchased(item.id);
  }

  function secondaryMenuItems(): OverflowItem[] {
    const items: OverflowItem[] = [];
    if (item.fetchState === "failed") {
      items.push({ id: "retry", label: S.item.retry, onSelect: () => onRefresh(item.id) });
    } else if (item.url && item.fetchState !== "pending") {
      items.push({ id: "recheck", label: S.item.recheckPrice, onSelect: () => onRefresh(item.id) });
    }
    if (item.url) {
      items.push({
        id: "copy-link",
        label: S.item.copyProductLink,
        onSelect: () => copyProductLink(item.url as string),
      });
    }
    items.push({
      id: "reset-purchased",
      label: S.share.resetPurchased,
      onSelect: handleResetPurchased,
    });
    items.push({ id: "delete", label: S.item.delete, danger: true, onSelect: handleDelete });
    return items;
  }

  function toggleHints() {
    const nextOpen = !hintsOpen;
    setHintsOpen(nextOpen);
    if (nextOpen) void onCheckPrices(item.id);
  }

  async function handleEdit(values: ItemFormValues) {
    await onEdit(item.id, values);
    setEditing(false);
  }

  const stats = item.priceStats;
  const delta = priceDelta(item.priceCents, item.currency, stats);
  const site = item.siteName ?? (item.url ? urlHost(item.url) : null);
  const price = formatPrice(item.priceCents, item.currency);
  const hintPrice = formatPrice(item.hintPriceCents, item.hintCurrency);
  const meta = stats ? S.item.lowestSeen(formatPrice(stats.lowestCents, stats.lowestCurrency)) : null;
  const footerHost = item.url ? urlHost(item.url) : null;
  const detailSheet = (
    <Sheet
      open
      onClose={onClose}
      ariaLabel={item.title}
      variant={desktop ? "drawer" : "sheet"}
      boxClassName={desktop ? undefined : "sheet--detail"}
    >
      <div className="detail-handle" aria-hidden="true" />
      <div className="detail-header">
        <IconButton label={S.detail.close} onClick={onClose} className="detail-close">
          <CloseIcon />
        </IconButton>
        <OverflowMenu
          triggerLabel={S.item.moreActions}
          triggerIcon={<DotsIcon />}
          triggerClassName="icon-btn detail-menu-trigger"
          menuLabel={S.item.moreActions}
          items={secondaryMenuItems()}
        />
      </div>

      <div className="detail-scroll">
        <div className="detail-hero">
          {item.imagePath ? (
            <ProductImage src={`/api/wishlist/items/${item.id}/image`} />
          ) : (
            <span className="product-img-fallback" aria-hidden="true" />
          )}
          <div className="detail-hero-info">
            <h2 className="detail-title">{item.title}</h2>
            {site && <span className="detail-site">{site}</span>}
            {item.fetchState === "pending" && <StatusBadge variant="fetching">{S.item.fetching}</StatusBadge>}
            {item.fetchState === "failed" && <StatusBadge variant="failed">{S.item.unavailable}</StatusBadge>}
            {price ? (
              <span className="detail-price">{price}</span>
            ) : (
              hintPrice && <span className="detail-price detail-price--hint">~{hintPrice}</span>
            )}
            {(meta || delta) && (
              <div className="detail-meta">
                {meta && <span>{meta}</span>}
                {meta && delta && <span className="detail-meta-sep" aria-hidden="true" />}
                {delta && (
                  <span className="price-delta" data-direction={delta.direction}>
                    <span className="delta-arrow" aria-hidden="true">
                      <DeltaArrow direction={delta.direction} />
                    </span>
                    <span className="visually-hidden">{delta.direction === "down" ? "Down " : "Up "}</span>
                    <span className="delta-copy">{S.item.deltaSinceAdd(delta.amount)}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={`detail-actions${item.url ? "" : " detail-actions--single"}`}>
          {item.url && (
            <a className="detail-open-btn" href={item.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              {S.detail.openProduct}
            </a>
          )}
          <button type="button" className="secondary detail-edit-btn" onClick={() => setEditing(true)}>
            <PencilIcon />
            {S.detail.editItem}
          </button>
        </div>

        {item.notes?.trim() && (
          <section className="detail-card detail-notes-card">
            <div className="detail-card-head">
              <div className="detail-card-heading">
                <NoteIcon />
                <h3 className="detail-card-title">{S.detail.notesTitle}</h3>
              </div>
              <button type="button" className="detail-edit-link" onClick={() => setEditing(true)}>
                {S.item.edit}
              </button>
            </div>
            <p className="detail-notes-body">{item.notes}</p>
          </section>
        )}

        {item.tags.length > 0 && (
          <section className="detail-card detail-tags-card">
            <div className="detail-card-head">
              <div className="detail-card-heading">
                <TagIcon />
                <h3 className="detail-card-title">{S.detail.tagsTitle}</h3>
              </div>
              <button type="button" className="detail-edit-link" onClick={() => setEditing(true)}>
                {S.item.edit}
              </button>
            </div>
            <div className="detail-tags">
              {item.tags.map((tag) => <span className="tag-pill" key={tag}>{tag}</span>)}
            </div>
          </section>
        )}

        <section className="detail-card detail-more-card">
          <div className="detail-card-heading">
            <LinkIcon />
            <h3 className="detail-card-title">{S.detail.moreInfoTitle}</h3>
          </div>
          {item.url && (
            <a className="detail-row" href={item.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              <span>{S.detail.viewOn(site ?? urlHost(item.url))}</span>
              <ChevronRightIcon />
            </a>
          )}
          <div className="detail-hints">
            <HintsBlock
              itemId={item.id}
              open={hintsOpen}
              onToggle={toggleHints}
              hintState={hintState}
              label={S.detail.checkElsewhere}
              leading={<SearchIcon />}
              trailing={<ChevronRightIcon />}
            />
          </div>
        </section>

        <div className="detail-footer">
          <span>{S.detail.addedOn(formatDate(item.createdAt))}</span>
          {(footerHost || item.imageSource === "search") && (
            <span className="detail-footer-source">
              {footerHost}
              {footerHost && item.imageSource === "search" && <span aria-hidden="true"> · </span>}
              {item.imageSource === "search" && S.item.imageViaSearch}
            </span>
          )}
        </div>
      </div>
    </Sheet>
  );

  return (
    <>
      {detailSheet}
      <Sheet open={editing} onClose={() => setEditing(false)} ariaLabel={S.item.edit}>
        <h2>{S.item.edit}</h2>
        <ItemForm
          initial={item}
          submitLabel={S.form.save}
          onSubmit={handleEdit}
          onCancel={() => setEditing(false)}
        />
      </Sheet>
    </>
  );
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">{children}</svg>;
}

function CloseIcon() {
  return <Icon><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></Icon>;
}

function ExternalLinkIcon() {
  return <Icon><path d="M11 4h5v5M16 4l-7 7M14 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

function PencilIcon() {
  return <Icon><path d="m5 14.8-.7 2.7 2.7-.7L15.8 8 13 5.2 5 14.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="m11.8 6.4 2.8 2.8" stroke="currentColor" strokeWidth="1.5" /></Icon>;
}

function NoteIcon() {
  return <Icon><path d="M5 3.5h7l3 3V16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M12 3.8V7h3M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

function TagIcon() {
  return <Icon><path d="M3.8 4.2h5.5l6.9 6.9-5.1 5.1-6.9-6.9V4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><circle cx="7.2" cy="7.2" r="1" fill="currentColor" /></Icon>;
}

function LinkIcon() {
  return <Icon><path d="m8.1 11.9 3.8-3.8M6.3 14.3l-1.1 1.1a2.7 2.7 0 0 1-3.8-3.8l2.2-2.2a2.7 2.7 0 0 1 3.8 0M13.7 5.7l1.1-1.1a2.7 2.7 0 0 1 3.8 3.8l-2.2 2.2a2.7 2.7 0 0 1-3.8 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

function SearchIcon() {
  return <Icon><circle cx="8.7" cy="8.7" r="4.5" stroke="currentColor" strokeWidth="1.5" /><path d="m12.1 12.1 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></Icon>;
}

function ChevronRightIcon() {
  return <Icon size={16}><path d="m7.5 4 5 6-5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

function DeltaArrow({ direction }: { direction: "down" | "up" }) {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d={direction === "down" ? "M5 1.5v7M1.5 5 5 8.5 8.5 5" : "M5 8.5v-7M1.5 5 5 1.5 8.5 5"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
