import { describe, expect, test } from "bun:test";
import { lowestState } from "../src/web/components/ItemCard";
import type { PriceStats } from "../src/shared/types";

/** The ledger summary the server derives — only the two fields the verdict
 *  reads are meaningful here. */
function stats(lowestCents: string, lowestCurrency: string | null): PriceStats {
  return {
    lowestCents,
    lowestCurrency,
    lowestSeenAt: "2026-09-20T10:00:00.000Z",
    atAddCents: null,
    atAddCurrency: null,
    series: [],
    trend: null,
  };
}

describe("lowestState (#130)", () => {
  test("current == lowest → equal (the row shows the At lowest chip)", () => {
    expect(lowestState("10.00", "GBP", stats("10.00", "GBP"))).toEqual({ kind: "equal" });
  });

  test("current above lowest → below, carrying the formatted lowest", () => {
    expect(lowestState("15.00", "GBP", stats("12.50", "GBP"))).toEqual({
      kind: "below",
      lowest: "£12.50",
    });
  });

  test("cents are normalised, not compared as strings", () => {
    // "10.0" and "10.00" are the same money; a string compare would call this
    // a delta and render a "Lowest" line that says the same number twice.
    expect(lowestState("10.0", "GBP", stats("10.00", "GBP"))).toEqual({ kind: "equal" });
  });

  test("currency codes compare case- and whitespace-insensitively", () => {
    expect(lowestState("10.00", "gbp", stats("10.00", " GBP "))).toEqual({ kind: "equal" });
  });

  test("mixed currency is never compared — no verdict at all", () => {
    expect(lowestState("10.00", "GBP", stats("10.00", "USD"))).toBeNull();
  });

  test("no history → null (nothing honest to say)", () => {
    expect(lowestState("10.00", "GBP", null)).toBeNull();
  });

  test("no current price → null, even with history", () => {
    expect(lowestState(null, null, stats("10.00", "GBP"))).toBeNull();
  });

  test("unparseable money on either side → null, never a guessed verdict", () => {
    expect(lowestState("ten", "GBP", stats("10.00", "GBP"))).toBeNull();
    expect(lowestState("10.00", "GBP", stats("nope", "GBP"))).toBeNull();
  });

  test("a missing currency on both sides is a match (nothing contradicts)", () => {
    expect(lowestState("10.00", null, stats("10.00", null))).toEqual({ kind: "equal" });
  });
});
