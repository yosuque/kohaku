import type { KohakuHostError } from "@kohaku-ui/client";
import type { AdminMessages } from "./messages.js";

/**
 * Explains a governance call's thrown error to the reviewer, or returns null when the error is neither an
 * auth problem nor a declarative-RBAC denial (the caller then falls back to a generic failure notice).
 *
 * - 401 (missing / expired session — `err.status === 401`) is distinguished from 403 CAPABILITY_DENIED: the
 *   former means "sign in again", the latter means "your role cannot do this".
 * - 403 CAPABILITY_DENIED returns the role explanation.
 *
 * The SDK client throws KohakuHostError on any !ok response, so callers pass the caught exception straight
 * through. `messages` is injected — this package never reads a module-level i18n singleton. Domain vocabulary
 * of the console (RBAC / session semantics), so this lives at the package root, not on the generic `/ui`
 * primitives subpath.
 */
export function describeDeniedOperation(
  err: KohakuHostError,
  operation: string,
  messages: AdminMessages,
): string | null {
  if (err.status === 401) return messages.authRequiredMessage(err.code, operation);
  if (err.code === "CAPABILITY_DENIED") return messages.deniedMessage(err.code, operation);
  return null;
}
