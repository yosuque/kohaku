/**
 * The composer's identifier stamped onto every delivered Spec's provenance.composedBy. Isolated in its
 * own dependency-free leaf module so that other composer-internal modules (assemble.ts, and anything else
 * that needs to stamp provenance) can read it without creating a value-level import cycle back into
 * compose.ts (which re-exports it for backward compatibility — index.ts and external consumers still
 * resolve COMPOSER_ID from "./compose.js" / "./index.js").
 */
export const COMPOSER_ID = "composer@0.1.0";
