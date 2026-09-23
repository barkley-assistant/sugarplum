import { useEffect, useState } from "react";
import type { OwnedItem } from "../../shared/types";
import { navigate } from "../router";
import { S } from "../strings";
import { useBootMe } from "../use-boot-me";
import { usePageFocus } from "../use-page-focus";
import { AppShell } from "./AppShell";
import { EmptyState } from "./EmptyState";
import { FormSkeleton } from "./Skeletons";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { ListContextBar } from "./ListContextBar";

/** The edit form as a page (#62): the full form (no progressive disclosure —
 *  an existing item already has every field), saved back to the item view.
 *  Nothing is autofocused on mount (INV-B). */
export function ItemEditPage({ id }: { id: string }) {
  const boot = useBootMe();
  const me = boot.status === "ready" || boot.status === "offline" ? boot.me : null;
  const [item, setItem] = useState<OwnedItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const headingRef = usePageFocus(item?.id);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    void (async () => {
      // Same seam as the item page: the owner list GET is the only item read
      // that exists (and is SW cached, so the form fills instantly on a
      // deep-link boot).
      const res = await fetch(`/api/users/${me.id}/wishlist`);
      if (cancelled) return;
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      const items = (await res.json()) as OwnedItem[];
      const found = items.find((candidate) => candidate.id === id) ?? null;
      if (cancelled) return;
      if (found) setItem(found);
      else setNotFound(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [me, id]);

  async function saveItem(values: ItemFormValues) {
    const payload: Record<string, unknown> = { title: values.title };
    if (values.priceCents) payload.priceCents = values.priceCents;
    if (values.currency) payload.currency = values.currency;
    if (values.notes) payload.notes = values.notes;
    if (values.tags.length) payload.tags = values.tags;
    // Emptied link fields clear the stored value (null), never a stale one.
    payload.url = values.url || null;
    payload.cheaperUrl = values.cheaperUrl || null;

    const res = await fetch(`/api/wishlist/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(S.errors.saveItem);
    // Back to the item view.
    navigate(`/items/${id}`);
  }

  if (boot.status === "loading") return <FormSkeleton />;
  if (boot.status === "error") {
    return (
      <AppShell brandHref="/" brandLinkLabel={S.settings.backToList}>
        <p className="error" role="alert">{boot.message}</p>
      </AppShell>
    );
  }
  if (notFound) {
    return (
      <AppShell me={me} brandHref="/" brandLinkLabel={S.settings.backToList}>
        <EmptyState title={S.item.notFound} />
      </AppShell>
    );
  }
  if (!me || !item) return <FormSkeleton />;

  return (
    <AppShell me={me} brandHref="/" brandLinkLabel={S.settings.backToList}>
      <div className="add-page">
        {/* #121: heading mirrors the "Edit item" button that navigates
            here; the commit stays "Save". */}
        <h1 ref={headingRef} tabIndex={-1} className="page-title page-title--form">{S.detail.editItem}</h1>
        {/* #125: the header is uniform now, so the page also says which list
            the item belongs to. */}
        <ListContextBar me={me} />
        <ItemForm
          initial={item}
          submitLabel={S.form.save}
          onSubmit={saveItem}
          onCancel={() => navigate(`/items/${id}`)}
        />
      </div>
    </AppShell>
  );
}
