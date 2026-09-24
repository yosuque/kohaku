/** The token of an `Authorization: Bearer <token>` header (scheme matched case-insensitively), or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (header == null) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}
