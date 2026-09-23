import { describe, expect, test } from "bun:test";
import { upsertByKey } from "../src/web/toast";

/** #134: the reorder snackbar must never stack. `upsertByKey` is the pure
 *  decision behind that — a toast carrying a `key` replaces the previous
 *  toast with the same key, a keyless toast always appends. */
interface ProbeToast {
  id: number;
  message: string;
  key?: string;
}

describe("upsertByKey (#134)", () => {
  test("a keyless toast appends", () => {
    const prev: ProbeToast[] = [{ id: 1, message: "Copied" }];
    expect(upsertByKey(prev, { id: 2, message: "Order saved" })).toEqual([
      { id: 1, message: "Copied" },
      { id: 2, message: "Order saved" },
    ]);
  });

  test("a keyed toast replaces the toast holding the same key", () => {
    const prev: ProbeToast[] = [{ id: 1, message: "Order saved", key: "reorder" }];
    const next = upsertByKey(prev, { id: 2, message: "Order saved", key: "reorder" });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(2); // newest wins; the replaced toast's id is gone
  });

  test("replacement drops the stale entry — only one toast per key survives", () => {
    const prev: ProbeToast[] = [
      { id: 1, message: "Copied" },
      { id: 2, message: "Order saved", key: "reorder" },
      { id: 3, message: "Marked as purchased" },
    ];
    const next = upsertByKey(prev, { id: 4, message: "Order saved", key: "reorder" });
    expect(next.filter((t) => t.key === "reorder").map((t) => t.id)).toEqual([4]);
    expect(next.map((t) => t.id)).toEqual([1, 3, 4]); // unkeyed neighbours untouched
  });

  test("different keys coexist", () => {
    const prev: ProbeToast[] = [{ id: 1, message: "Order saved", key: "reorder" }];
    const next = upsertByKey(prev, { id: 2, message: "Order saved", key: "something-else" });
    expect(next.map((t) => t.id)).toEqual([1, 2]);
  });

  test("a keyless toast never removes a keyed one", () => {
    const prev: ProbeToast[] = [{ id: 1, message: "Order saved", key: "reorder" }];
    const next = upsertByKey(prev, { id: 2, message: "Couldn't save the new order." });
    expect(next.map((t) => t.message)).toEqual([
      "Order saved",
      "Couldn't save the new order.",
    ]);
  });
});
