import { describe, expect, it } from "vitest";
import { assertSafeIdent, quoteIdent } from "./ident.js";

describe("assertSafeIdent", () => {
  it("allows simple identifier", () => {
    expect(() => assertSafeIdent("zeloop_outbox_events")).not.toThrow();
  });

  it("allows schema-qualified identifier", () => {
    expect(() => assertSafeIdent("public.zeloop_outbox_events")).not.toThrow();
  });

  it("allows identifier with digits", () => {
    expect(() => assertSafeIdent("table_v2")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => assertSafeIdent("")).toThrow();
  });

  it("rejects SQL injection attempt", () => {
    expect(() => assertSafeIdent("; DROP TABLE users")).toThrow();
  });

  it("rejects spaces", () => {
    expect(() => assertSafeIdent("my table")).toThrow();
  });

  it("rejects semicolons", () => {
    expect(() => assertSafeIdent("foo;bar")).toThrow();
  });

  it("rejects quotes", () => {
    expect(() => assertSafeIdent('foo"bar')).toThrow();
    expect(() => assertSafeIdent("foo'bar")).toThrow();
  });

  it("rejects hyphens", () => {
    expect(() => assertSafeIdent("my-table")).toThrow();
  });
});

describe("quoteIdent", () => {
  it("wraps single part in double quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
  });

  it("wraps schema.table as separate quoted parts", () => {
    expect(quoteIdent("public.zeloop_outbox_events")).toBe(
      '"public"."zeloop_outbox_events"',
    );
  });

  it("handles single-part table name", () => {
    expect(quoteIdent("zeloop_outbox_events")).toBe('"zeloop_outbox_events"');
  });
});
