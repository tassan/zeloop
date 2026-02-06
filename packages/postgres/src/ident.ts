const SAFE_IDENT_RE = /^[a-zA-Z0-9_.]+$/;

/**
 * Throws if `ident` contains characters outside `[a-zA-Z0-9_.]`.
 * Identifiers must NOT come from untrusted end-user input.
 */
export function assertSafeIdent(ident: string): void {
  if (!ident || !SAFE_IDENT_RE.test(ident)) {
    throw new Error(`Unsafe identifier: "${ident}"`);
  }
}

/**
 * Quotes each dot-separated part of an identifier.
 * `"public.my_table"` → `"public"."my_table"`
 */
export function quoteIdent(ident: string): string {
  assertSafeIdent(ident);
  return ident
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}
