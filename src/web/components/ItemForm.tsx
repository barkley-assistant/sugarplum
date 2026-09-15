import { useState, type FormEvent } from "react";
import type { CommonItem } from "../../shared/types";

export interface ItemFormValues {
  title: string;
  url: string;
  priceCents: string;
  currency: string;
  notes: string;
  tags: string[];
}

interface ItemFormProps {
  initial?: CommonItem;
  /** Partial values for the add flow (e.g. the share-target prefill). */
  initialValues?: Partial<ItemFormValues>;
  submitLabel: string;
  onSubmit: (values: ItemFormValues) => void | Promise<void>;
  onCancel?: () => void;
}

const CURRENCIES = ["GBP", "USD", "EUR"];

export function ItemForm({ initial, initialValues, submitLabel, onSubmit, onCancel }: ItemFormProps) {
  const [title, setTitle] = useState(initialValues?.title ?? initial?.title ?? "");
  const [url, setUrl] = useState(initialValues?.url ?? initial?.url ?? "");
  const [priceCents, setPriceCents] = useState(initial?.priceCents ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "GBP");
  const [otherCurrency, setOtherCurrency] = useState("");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() && !url.trim()) {
      setError("Add a title or a link.");
      return;
    }
    const effectiveCurrency = currency === "Other" ? otherCurrency.trim().toUpperCase() : currency;
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
      });
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="item-form" onSubmit={submit}>
      <div className="field-row">
        <div className="field grow">
          <label htmlFor="item-title">Title</label>
          <input
            id="item-title"
            type="text"
            placeholder="Leave blank to auto-fill from the link"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="item-price">Price</label>
          <input
            id="item-price"
            type="text"
            inputMode="decimal"
            placeholder="24.99"
            value={priceCents}
            onChange={(e) => setPriceCents(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="item-currency">Currency</label>
          <select
            id="item-currency"
            value={CURRENCIES.includes(currency) ? currency : "Other"}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="Other">Other</option>
          </select>
        </div>
        {currency === "Other" && (
          <div className="field">
            <label htmlFor="item-other-currency">Code</label>
            <input
              id="item-other-currency"
              type="text"
              placeholder="SEK"
              value={otherCurrency}
              onChange={(e) => setOtherCurrency(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="item-url">Link</label>
        <input
          id="item-url"
          type="text"
          inputMode="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="item-tags">Tags</label>
        <input
          id="item-tags"
          type="text"
          placeholder="Birthday, Someday"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="item-notes">Notes</label>
        <textarea
          id="item-notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <div className="form-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}