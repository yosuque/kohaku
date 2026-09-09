export type ComposeErrorCode = "SEMANTIC_FAILED" | "LLM_INVALID" | "L2_DISABLED" | "INTERNAL";

export class ComposeError extends Error {
  readonly code: ComposeErrorCode;

  constructor(code: ComposeErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "ComposeError";
    this.code = code;
  }
}
