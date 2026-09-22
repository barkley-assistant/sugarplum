import { useState, type FormEvent } from "react";
import type { CommonItem } from "../../shared/types";
import { S } from "../strings";

export interface ItemFormValues {
  title: string;
  url: string;
  priceCents: string;
  currency: string;
  notes: string;
  tags: string[];
  cheaperUrl: string;
}

interface ItemFormProps {
  initial?: CommonItem & { cheaperUrl?: string | null };
  /** Partial values for the add flow (e.g. the share-target prefill). */
  initialValues?: Partial<ItemFormValues>;
  submitLabel: string;
  onSubmit: (values: ItemFormValues) => void | Promise<void>;
  onCancel?: () => void;
  /** #127: the ADD flow's guarded exit. The button renders only while the
   *  form holds a draft; the page owns the confirm dialog + navigation. */
  onDiscard?: () => void | Promise<void>;
  /** Add mode keeps manual fields behind a progressive disclosure. */
  mode?: "add" | "edit";
}

const CURRENCIES = ["GBP", "USD", "EUR"];

/** #114: split a stored currency code into the form's two state slots — a
 *  preset stays in `currency`; anything else becomes "Other" + the raw code
 *  in `otherCurrency`, so the code input mounts visible AND filled. */
export function seedCurrency(stored: string | null | undefined): {
  currency: string;
  otherCurrency: string;
} {
  const code = stored ?? "GBP";
  if (CURRENCIES.includes(code)) return { currency: code, otherCurrency: "" };
  return { currency: S.form.currencyOther, otherCurrency: code };
}

/** #127: does the form hold something a submit would actually send? The six
 *  payload fields the submit path trims (ItemForm's submit); `tags` is the
 *  RAW comma-string state, not `ItemFormValues`' `string[]`. The currency
 *  select and the Other-code input are deliberately excluded: with an empty
 *  price the payload never carries a currency, so alone they lose nothing. */
export function hasDraft(raw: {
  title: string;
  url: string;
  priceCents: string;
  notes: string;
  tags: string;
  cheaperUrl: string;
}): boolean {
  return [raw.title, raw.url, raw.priceCents, raw.notes, raw.tags, raw.cheaperUrl].some(
    (value) => value.trim() !== "",
  );
}

export function ItemForm({
  initial,
  initialValues,
  submitLabel,
  onSubmit,
  onCancel,
  onDiscard,
  mode = "edit",
}: ItemFormProps) {
  const [title, setTitle] = useState(initialValues?.title ?? initial?.title ?? "");
  const [url, setUrl] = useState(initialValues?.url ?? initial?.url ?? "");
  const [priceCents, setPriceCents] = useState(initial?.priceCents ?? "");
  const [currency, setCurrency] = useState(() => seedCurrency(initial?.currency).currency);
  const [otherCurrency, setOtherCurrency] = useState(
    () => seedCurrency(initial?.currency).otherCurrency,
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [cheaperUrl, setCheaperUrl] = useState(initial?.cheaperUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(mode === "add" && Boolean(initialValues?.title));
  const isAdd = mode === "add";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() && !url.trim()) {
      setError(S.form.needTitleOrLink);
      return;
    }
    const effectiveCurrency = currency === S.form.currencyOther ? otherCurrency.trim().toUpperCase() : currency;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        url: url.trim() || "",
        priceCents: priceCents.trim() || "",
        // A currency with no price is meaningless; leaving it empty lets a
        // URL-only add receive the scraped currency instead of a stale default.
        currency: priceCents.trim() ? effectiveCurrency : "",
        notes: notes.trim() || "",
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        cheaperUrl: cheaperUrl.trim(),
      });
    } catch {
      setError(S.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  const urlField = (
    <div className="field">
      <label htmlFor="item-url">{S.form.link}</label>
      <input
        id="item-url"
        type="text"
        inputMode="url"
        placeholder={isAdd ? S.form.linkPlaceholderAdd : S.form.linkPlaceholder}
        className="input-lg"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
    </div>
  );

  const titlePriceRow = (
    <div className="field-row">
      <div className="field grow">
        <label htmlFor="item-title">{S.form.title}</label>
        <input
          id="item-title"
          type="text"
          placeholder={S.form.titlePlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="item-price">{S.form.price}</label>
        <input
          id="item-price"
          type="text"
          inputMode="decimal"
          placeholder={S.form.pricePlaceholder}
          value={priceCents}
          onChange={(e) => setPriceCents(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="item-currency">{S.form.currency}</label>
        <select
          id="item-currency"
          value={CURRENCIES.includes(currency) ? currency : S.form.currencyOther}
          onChange={(e) => setCurrency(e.target.value)}
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value={S.form.currencyOther}>{S.form.currencyOther}</option>
        </select>
      </div>
      {currency === S.form.currencyOther && (
        <div className="field">
          <label htmlFor="item-other-currency">{S.form.currencyCode}</label>
          <input
            id="item-other-currency"
            type="text"
            placeholder={S.form.currencyCodePlaceholder}
            value={otherCurrency}
            onChange={(e) => setOtherCurrency(e.target.value)}
          />
        </div>
      )}
    </div>
  );

  const tagsField = (
    <div className="field">
      <label htmlFor="item-tags">{S.form.tags}</label>
      <input
        id="item-tags"
        type="text"
        placeholder={S.form.tagsPlaceholder}
        value={tags}
        onChange={(e) => setTags(e.target.value)}
      />
    </div>
  );

  const notesField = (
    <div className="field">
      <label htmlFor="item-notes">{S.form.notes}</label>
      <textarea
        id="item-notes"
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
    </div>
  );

  const cheaperField = (
    <div className="field">
      <label htmlFor="item-cheaper-url">{S.form.cheaperLink}</label>
      <input
        id="item-cheaper-url"
        type="text"
        inputMode="url"
        placeholder={S.form.cheaperLinkPlaceholder}
        value={cheaperUrl}
        onChange={(e) => setCheaperUrl(e.target.value)}
      />
    </div>
  );

  const cancelButton = onCancel ? (
    <button type="button" className="secondary" onClick={onCancel}>
      {S.form.cancel}
    </button>
  ) : null;

  // #127: the add flow's exit places itself, and only when there is something
  // to lose — a pristine form needs no button (the header's "Back to list"
  // link already leaves). Busy-gated like the submit: mid-submit this is not
  // an escape hatch out from under the request already in flight.
  const draft = isAdd && hasDraft({ title, url, priceCents, notes, tags, cheaperUrl });
  const discardButton =
    draft && onDiscard ? (
      <button type="button" className="secondary" disabled={busy} onClick={() => void onDiscard()}>
        {S.form.discard}
      </button>
    ) : null;

  return (
    <form className={`item-form${isAdd ? " item-form--add" : ""}`} onSubmit={submit}>
      {urlField}
      {isAdd ? (
        <>
          <button type="submit" className="primary add-submit" disabled={busy}>
            {busy ? S.form.addSubmitBusy : submitLabel}
          </button>
          <button
            type="button"
            className="add-disclose"
            aria-expanded={manualOpen}
            aria-controls="add-manual-fields"
            onClick={() => setManualOpen((open) => !open)}
          >
            <span>{S.form.addDetailsManually}</span>
            <span className="add-disclose-caret" aria-hidden="true">⌄</span>
          </button>
          {manualOpen && (
            <div id="add-manual-fields" className="add-manual">
              <p className="muted add-manual-intro">{S.form.manualIntro}</p>
              {titlePriceRow}
              {tagsField}
              {notesField}
              {(url.trim() || cheaperUrl.trim()) && cheaperField}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          {discardButton && <div className="form-actions">{discardButton}</div>}
        </>
      ) : (
        <>
          {titlePriceRow}
          {tagsField}
          {notesField}
          {cheaperField}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              {busy ? S.form.saving : submitLabel}
            </button>
            {cancelButton}
          </div>
        </>
      )}
    </form>
  );
}