/**
 * Current time in epoch seconds (floor). The single source of "now" for expiry checks, so `verify` /
 * `revokeCapability` (hmac-authz-port.ts) and the memory revocation store's sweep (revocation.ts) all treat
 * "expired" as the same boundary. Previously `verify`/`revokeCapability` used `exp < now` while the memory
 * store's own sweep already used `exp <= now` -- two different boundaries for the same concept, off by one
 * second at the instant `exp === now`. `isExpired` below is the shared boundary going forward.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Whether a token's `exp` claim (epoch seconds) has passed. Expired means `exp <= now` (a token is
 * considered expired exactly at its `exp` instant, not only strictly after it). */
export function isExpired(claims: { exp: number }): boolean {
  return claims.exp <= nowSeconds();
}
