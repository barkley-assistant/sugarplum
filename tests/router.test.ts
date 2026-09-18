import { describe, expect, test } from "bun:test";
import { parseRoute, safeNext } from "../src/web/router";

// safeNext is exercised both directly (its e2e contract is pinned by
// app.spec test 14's open-redirect class) and through parseRoute.

describe("parseRoute", () => {
  test("/ and /add and unknown parse as home", () => {
    expect(parseRoute("/", "")).toEqual({ name: "home" });
    expect(parseRoute("/add", "?url=x")).toEqual({ name: "home" });
    expect(parseRoute("/nonsense", "")).toEqual({ name: "home" });
  });
  test("/share/<64hex> parses with token; malformed token falls through to home", () => {
    const token = "a".repeat(64);
    expect(parseRoute(`/share/${token}`, "")).toEqual({ name: "share", token });
    expect(parseRoute("/share/short", "")).toEqual({ name: "home" });
    expect(parseRoute("/share/" + "g".repeat(64), "")).toEqual({ name: "home" }); // non-hex
  });
  test("/login parses with sanitized next", () => {
    expect(parseRoute("/login", "?next=%2Fsettings")).toEqual({ name: "login", next: "/settings" });
    expect(parseRoute("/login", "?next=%2F%2Fevil.example")).toEqual({ name: "login", next: "/" });
  });
  test("/settings exact match only", () => {
    expect(parseRoute("/settings", "")).toEqual({ name: "settings" });
    expect(parseRoute("/settings/x", "")).toEqual({ name: "home" });
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
