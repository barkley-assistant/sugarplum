import { describe, expect, test } from "bun:test";
import { parseRoute, safeNext } from "../src/web/router";

// safeNext is exercised both directly (its e2e contract is pinned by
// app.spec test 14's open-redirect class) and through parseRoute.

describe("parseRoute", () => {
  test("/ and unknown parse as home", () => {
    expect(parseRoute("/", "")).toEqual({ name: "home", list: null });
    expect(parseRoute("/nonsense", "")).toEqual({ name: "home", list: null });
  });
  test("/share/<64hex> parses with token; malformed token falls through to home", () => {
    const token = "a".repeat(64);
    expect(parseRoute(`/share/${token}`, "")).toEqual({ name: "share", token });
    expect(parseRoute("/share/short", "")).toEqual({ name: "home", list: null });
    expect(parseRoute("/share/" + "g".repeat(64), "")).toEqual({ name: "home", list: null }); // non-hex
  });
  test("/login parses with sanitized next", () => {
    expect(parseRoute("/login", "?next=%2Fsettings")).toEqual({ name: "login", next: "/settings" });
    expect(parseRoute("/login", "?next=%2F%2Fevil.example")).toEqual({ name: "login", next: "/" });
  });
  test("/settings exact match only", () => {
    expect(parseRoute("/settings", "")).toEqual({ name: "settings" });
    expect(parseRoute("/settings/x", "")).toEqual({ name: "home", list: null });
  });
});

// #96: the settings area is three exact-match routes. Anything else under
// /settings stays an unknown path (home), same philosophy as the malformed
// share token / item id guards above.
describe("parseRoute — #96 settings screens", () => {
  test("/settings/users and /settings/users/new parse as their own routes", () => {
    expect(parseRoute("/settings/users", "")).toEqual({ name: "settingsUsers" });
    expect(parseRoute("/settings/users/new", "")).toEqual({ name: "settingsUserNew" });
  });
  test("/settings/users/new never parses as the users table", () => {
    expect(parseRoute("/settings/users/new", "")).not.toEqual({ name: "settingsUsers" });
  });
  test("other /settings sub-paths fall through to home", () => {
    expect(parseRoute("/settings/users/x", "")).toEqual({ name: "home", list: null });
    expect(parseRoute("/settings/users/new/x", "")).toEqual({ name: "home", list: null });
    expect(parseRoute("/settings/", "")).toEqual({ name: "home", list: null });
  });
});

// #62: the add / item / edit flows became real routes. The id pattern is the
// lowercase-hex randomUUID shape (the /share token guard's precedent): a
// malformed id falls through to home, exactly like a malformed share token.
describe("parseRoute — #62 page routes", () => {
  const id = "0123abcd-45ef-6789-abcd-ef0123456789";

  test("/add parses as its own route carrying the raw search", () => {
    expect(parseRoute("/add", "")).toEqual({ name: "add", search: "" });
    expect(parseRoute("/add", "?url=x")).toEqual({ name: "add", search: "?url=x" });
  });

  test("/items/:id parses; malformed ids fall through to home", () => {
    expect(parseRoute(`/items/${id}`, "")).toEqual({ name: "item", id });
    expect(parseRoute("/items/not-a-uuid", "")).toEqual({ name: "home", list: null });
    expect(parseRoute("/items/", "")).toEqual({ name: "home", list: null });
    expect(parseRoute(`/items/${id}/extra`, "")).toEqual({ name: "home", list: null });
  });

  test("/items/:id/edit parses as itemEdit, never as item", () => {
    expect(parseRoute(`/items/${id}/edit`, "")).toEqual({ name: "itemEdit", id });
    expect(parseRoute(`/items/${id}/edit`, "")).not.toEqual({ name: "item", id });
  });

  test("uppercase-hex ids fall through (ids are lowercase randomUUID)", () => {
    expect(parseRoute(`/items/${id.toUpperCase()}`, "")).toEqual({ name: "home", list: null });
  });
});

// #158: the selected list is a validated search parameter on the home route.
// Absent or malformed → the own list (null), the same fall-through a malformed
// share token or item id gets. A well-formed but UNKNOWN id is not decided
// here — that is a fetch failure the feed owns.
describe("parseRoute — #158 selected list", () => {
  const id = "0123abcd-45ef-6789-abcd-ef0123456789";
  const other = "fedcba98-7654-3210-fedc-ba9876543210";

  test("no search → own list", () => {
    expect(parseRoute("/", "")).toEqual({ name: "home", list: null });
  });

  test("unrelated search params do not name a list", () => {
    expect(parseRoute("/", "?foo=bar")).toEqual({ name: "home", list: null });
    expect(parseRoute("/", "?title=x")).toEqual({ name: "home", list: null });
  });

  test("?list=<uuid> names that list", () => {
    expect(parseRoute("/", `?list=${id}`)).toEqual({ name: "home", list: id });
    expect(parseRoute("/", `?list=${other}`)).toEqual({ name: "home", list: other });
  });

  test("a malformed list value falls through to the own list", () => {
    for (const bad of [
      "not-a-uuid",
      id.toUpperCase(),
      "../etc/passwd",
      "javascript:alert(1)",
      `${id}x`,
      `${id}%00`,
    ]) {
      expect(parseRoute("/", `?list=${bad}`), `list=${bad}`).toEqual({
        name: "home",
        list: null,
      });
    }
  });

  test("an empty list parameter is absent, not malformed", () => {
    expect(parseRoute("/", "?list=")).toEqual({ name: "home", list: null });
    expect(parseRoute("/", `?LIST=${id}`)).toEqual({ name: "home", list: null }); // case-sensitive key
  });

  test("duplicate list keys: the first wins (URLSearchParams.get)", () => {
    expect(parseRoute("/", `?list=${id}&list=${other}`)).toEqual({ name: "home", list: id });
  });

  test("the other routes are unaffected and carry no list", () => {
    expect(parseRoute("/add", `?list=${id}`)).toEqual({ name: "add", search: `?list=${id}` });
    expect(parseRoute("/login", "?next=%2F")).toEqual({ name: "login", next: "/" });
    expect(parseRoute("/settings", "")).toEqual({ name: "settings" });
    expect(parseRoute(`/items/${id}`, "")).toEqual({ name: "item", id });
    expect(parseRoute(`/share/${"a".repeat(64)}`, "")).toEqual({ name: "share", token: "a".repeat(64) });
  });

  test("an unknown path with a list still parses as home with that list", () => {
    expect(parseRoute("/nonsense", `?list=${id}`)).toEqual({ name: "home", list: id });
  });
});

describe("safeNext (open-redirect guard, e2e test 14 pins this class)", () => {
  test("null/empty → /", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });
  test("absolute and protocol-relative shapes → /", () => {
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example/x")).toBe("/");
    expect(safeNext("/\\evil.example/x")).toBe("/");
    expect(safeNext("/\tevil.example/x")).toBe("/");
    expect(safeNext("/\nevil.example/x")).toBe("/");
    expect(safeNext("/\revil.example/x")).toBe("/");
    expect(safeNext("mailto: x")).toBe("/");
  });
  test("oversized → /; valid paths survive verbatim", () => {
    expect(safeNext("x".repeat(513))).toBe("/");
    expect(safeNext("/settings")).toBe("/settings");
    expect(safeNext("/add?url=https%3A%2F%2Fexample.com%2Fx&title=T")).toBe(
      "/add?url=https%3A%2F%2Fexample.com%2Fx&title=T",
    );
  });
});
