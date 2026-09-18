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
  /** Add mode keeps manual fields behind a progressive disclosure. */
  mode?: "add" | "edit";
}

const CURRENCIES = ["GBP", "USD", "EUR"];

export function ItemForm({
  initial,
  initialValues,
  submitLabel,
  onSubmit,
  onCancel,
  mode = "edit",
}: ItemFormProps) {
  const [title, setTitle] = useState(initialValues?.title ?? initial?.title ?? "");
  const [url, setUrl] = useState(initialValues?.url ?? initial?.url ?? "");
  const [priceCents, setPriceCents] = useState(initial?.priceCents ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "GBP");
  const [otherCurrency, setOtherCurrency] = useState("");
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
          {cancelButton && <div className="form-actions">{cancelButton}</div>}
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