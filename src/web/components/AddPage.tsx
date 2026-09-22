import { useState } from "react";
import { navigate } from "../router";
import { parseShareTarget } from "../format";
import { useBootMe } from "../use-boot-me";
import { usePageFocus } from "../use-page-focus";
import { setPendingFocusItemId } from "../feed-handoff";
import { AppShell } from "./AppShell";
import { FormSkeleton } from "./Skeletons";
import { ItemForm, type ItemFormValues } from "./ItemForm";
import { S } from "../strings";

interface AddPageProps {
  /** Raw location.search — parsed once here. The share-target seam
   *  (`/add?url=&title=&text=`), which is why the route carries it. */
  search: string;
}

/** The add flow as a page (#62): paste-a-link first, manual fields behind a
 *  progressive disclosure. Nothing is autofocused on mount (INV-B) — a
 *  share-target arrival is mid-share with intent to paste, and a keyboard
 *  popping over an untouched form is the bug this page exists to fix. */
export function AddPage({ search }: AddPageProps) {
  const boot = useBootMe();
  const headingRef = usePageFocus(boot.status);
  // Parsed once: the prefill is the arrival state, never a live mirror.
  const [initial] = useState(() => parseShareTarget(new URLSearchParams(search)));

  async function createItem(values: ItemFormValues) {
    const payload: Record<string, unknown> = { title: values.title };
    if (values.url) payload.url = values.url;
    if (values.priceCents) payload.priceCents = values.priceCents;
    if (values.currency) payload.currency = values.currency;
    if (values.notes) payload.notes = values.notes;
    if (values.tags.length) payload.tags = values.tags;
    if (values.cheaperUrl) payload.cheaperUrl = values.cheaperUrl;

    const res = await fetch("/api/wishlist/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(S.errors.addItem);
    const created = (await res.json()) as { id: string };
    // #62 D8: hand the feed the new row so it scrolls it into view — this
    // page cannot scroll a feed that is not mounted.
    setPendingFocusItemId(created.id);
    navigate("/");
  }

  if (boot.status === "loading") return <FormSkeleton />;
  if (boot.status === "error") {
    return (
      <AppShell brandHref="/" brandLinkLabel={S.settings.backToList}>
        <p className="error" role="alert">{boot.message}</p>
      </AppShell>
    );
  }

  return (
    <AppShell brandHref="/" brandLinkLabel={S.settings.backToList}>
      <div className="add-page">
        {/* #121: the heading mirrors the "Add item" CTA that navigated
            here; the submit button (same words) names the commit. */}
        <h1 ref={headingRef} tabIndex={-1} className="page-title page-title--form">{S.list.addItem}</h1>
        <ItemForm
          mode="add"
          submitLabel={S.list.addItem}
          initialValues={initial}
          onSubmit={createItem}
          onCancel={() => navigate("/")}
        />
      </div>
    </AppShell>
  );
}
