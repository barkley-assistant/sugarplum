import { describe, expect, test } from "bun:test";
import { seedCurrency } from "../src/web/components/ItemForm";

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
