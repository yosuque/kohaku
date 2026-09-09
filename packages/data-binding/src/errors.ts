export type BindingErrorCode =
  | "BAD_REF"
  | "UNAUTHORIZED"
  | "REF_NOT_FOUND"
  | "STALE_VERSION"
  | "RESOLVE_FAILED";

export class BindingError extends Error {
  readonly code: BindingErrorCode;
  readonly status?: number;

  constructor(code: BindingErrorCode, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "BindingError";
    this.code = code;
    this.status = opts.status;
  }
}
