import { BindingError } from "@kohaku-ui/data-binding";

/** The `{ error: { code, message, retryAfterMs? } }` envelope host-mcp-apps puts in a tool error's `structuredContent` (SPEC §6.1). */
interface StructuredToolError {
  code?: string;
  message?: string;
  retryAfterMs?: number;
}

function structuredRateLimit(
  structuredContent: unknown,
): { message: string; retryAfterMs: number | undefined } | null {
  const error = (structuredContent as { error?: StructuredToolError } | null | undefined)?.error;
  if (error?.code !== "RATE_LIMITED") return null;
  const retryAfterMs =
    typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
      ? error.retryAfterMs
      : undefined;
  return { message: error.message ?? "rate limit exceeded", retryAfterMs };
}

/**
 * Maps a failed `kohaku_resolve_binding` tool result onto the `{ status, body }` shape a `BindingClient`
 * fetcher returns. A structured `RATE_LIMITED` becomes a 429 carrying the host's `error.retryAfterMs`
 * envelope, which data-binding's client turns into `BindingError("RATE_LIMITED", ..., { retryAfterMs })`
 * (the same mapping it applies to a REST 429, SPEC REST-RL-001); every other tool error stays a 403.
 */
export function resolveFailureResponse(structuredContent: unknown): { status: number; body: unknown } {
  const rateLimit = structuredRateLimit(structuredContent);
  if (rateLimit == null) return { status: 403, body: null };
  return {
    status: 429,
    body: {
      error: {
        code: "RATE_LIMITED",
        message: rateLimit.message,
        ...(rateLimit.retryAfterMs != null ? { retryAfterMs: rateLimit.retryAfterMs } : {}),
      },
    },
  };
}

/**
 * The `BindingError` for a structured `RATE_LIMITED` failed `kohaku_action` tool result, carrying
 * `retryAfterMs` so a caller can back off (SPEC §6.1); `null` when the result is some other failure.
 */
export function actionRateLimitedError(structuredContent: unknown): BindingError | null {
  const rateLimit = structuredRateLimit(structuredContent);
  if (rateLimit == null) return null;
  return new BindingError("RATE_LIMITED", rateLimit.message, {
    status: 429,
    ...(rateLimit.retryAfterMs != null ? { retryAfterMs: rateLimit.retryAfterMs } : {}),
  });
}
