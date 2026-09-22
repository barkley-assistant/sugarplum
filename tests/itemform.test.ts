import { describe, expect, test } from "bun:test";
import { hasDraft, seedCurrency } from "../src/web/components/ItemForm";

describe("seedCurrency (#114)", () => {
  test("null stored (no price) → GBP default, empty other", () => {
    expect(seedCurrency(null)).toEqual({ currency: "GBP", otherCurrency: "" });
  });
  test("undefined (add mode, no initial) → GBP default, empty other", () => {
    expect(seedCurrency(undefined)).toEqual({ currency: "GBP", otherCurrency: "" });
  });
  for (const code of ["GBP", "USD", "EUR"]) {
    test(`preset ${code} passes through, empty other`, () => {
      expect(seedCurrency(code)).toEqual({ currency: code, otherCurrency: "" });
    });
  }
  test("non-preset stored code (SEK) → Other + the code", () => {
    expect(seedCurrency("SEK")).toEqual({ currency: "Other", otherCurrency: "SEK" });
  });
  test("lowercase stored code seeds raw, untouched (D2)", () => {
    expect(seedCurrency("sek")).toEqual({ currency: "Other", otherCurrency: "sek" });
  });
  test("arbitrary code (XYZ) is honest — server accepts any string", () => {
    expect(seedCurrency("XYZ")).toEqual({ currency: "Other", otherCurrency: "XYZ" });
  });
});

describe("hasDraft (#127)", () => {
  const empty = {
    title: "",
    url: "",
    priceCents: "",
    notes: "",
    tags: "",
    cheaperUrl: "",
  };

  test("an untouched add form holds no draft", () => {
    expect(hasDraft(empty)).toBe(false);
  });

  test("whitespace-only input is not a draft (nothing would be sent)", () => {
    expect(hasDraft({ ...empty, title: "   ", notes: " \n ", url: "\t" })).toBe(false);
  });

  // Every field the submit path trims and sends counts on its own — including
  // the share-target prefill's url/title.
  for (const field of ["title", "url", "priceCents", "notes", "tags", "cheaperUrl"] as const) {
    test(`${field} alone is a draft`, () => {
      expect(hasDraft({ ...empty, [field]: "x" })).toBe(true);
    });
  }

  test("a field typed and then cleared is not a draft", () => {
    expect(hasDraft({ ...empty, priceCents: "" })).toBe(false);
  });
});
