import {
  type GenerateObjectRequest,
  type GenerateObjectResult,
  type GenerateTextRequest,
  isZodSchema,
  type LlmEffort,
  LlmError,
  type LlmPort,
  type LlmUsage,
} from "./port.js";

export interface FakeLlmCall {
  kind: "object" | "text";
  prompt: string;
  system?: string;
  schemaName?: string;
  /** The request's `effort`, when the caller passed one (WP1 test hook — FakeLlm never acts on this itself). */
  effort?: LlmEffort;
}

type ObjectScript = unknown[] | ((req: GenerateObjectRequest<unknown>) => unknown);
type TextScript = string[] | ((req: GenerateTextRequest) => string);

const USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Scripted-response LLM for tests and CI. Records calls and, when a Zod schema is given,
 * schema-validates the scripted response to catch fixture mistakes on the test side early.
 */
export class FakeLlm implements LlmPort {
  readonly provider: string;
  readonly modelId: string;
  readonly calls: FakeLlmCall[] = [];

  private readonly objects: ObjectScript;
  private readonly texts: TextScript;
  private readonly partials: unknown[][];
  private objectIndex = 0;
  private textIndex = 0;

  constructor(
    script: {
      objects?: ObjectScript;
      texts?: TextScript;
      partials?: unknown[][];
      /**
       * Overrides `provider`/`modelId` (default "fake"/"fake-model" — unchanged from before these options
       * existed). Lets a test construct two distinct FakeLlm instances with distinguishable identities, for
       * asserting `ComposeContext.llmByTier` routing and cacheKey separation (WP2).
       */
      provider?: string;
      modelId?: string;
    } = {},
  ) {
    this.objects = script.objects ?? [];
    this.texts = script.texts ?? [];
    // partials[i] = the sequence of cumulative partials to notify before the final response (objects[i])
    // on the i-th streamObject call (for testing the LlmPort.streamObject contract). Not used via generateObject.
    this.partials = script.partials ?? [];
    this.provider = script.provider ?? "fake";
    this.modelId = script.modelId ?? "fake-model";
  }

  async streamObject<T>(
    req: GenerateObjectRequest<T> & { onPartial: (partial: unknown) => void },
  ): Promise<GenerateObjectResult<T>> {
    // Notify the corresponding scripted partial sequence in order before the final response
    // (reproducing the cumulative form is the script's responsibility).
    // Swallow a throw from onPartial (port contract: a consumer exception must not break generation).
    for (const partial of this.partials[this.objectIndex] ?? []) {
      try {
        req.onPartial(partial);
      } catch {
        // Swallowed as per the contract.
      }
    }
    return this.generateObject(req);
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    this.calls.push({
      kind: "object",
      prompt: req.prompt,
      ...(req.system != null ? { system: req.system } : {}),
      ...(req.schemaName != null ? { schemaName: req.schemaName } : {}),
      ...(req.effort != null ? { effort: req.effort } : {}),
    });
    // The function path has no side effects. The array path uses "peek → validate → advance index only on
    // success" so that even if schema validation throws, the consumption position does not shift (to avoid
    // breaking record/replay-style usage where the same response is re-consumed after a validation failure).
    const isFn = typeof this.objects === "function";
    const raw = isFn
      ? (this.objects as (req: GenerateObjectRequest<unknown>) => unknown)(
          req as GenerateObjectRequest<unknown>,
        )
      : (this.objects as unknown[])[this.objectIndex];
    if (raw === undefined) {
      throw new LlmError("INVALID_OUTPUT", "FakeLlm: no scripted object response left");
    }
    if (isZodSchema(req.schema)) {
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        // Throw without advancing the index (a validation failure is treated as not consumed).
        throw new LlmError(
          "INVALID_OUTPUT",
          `FakeLlm: scripted response does not match schema: ${parsed.error.message}`,
        );
      }
      if (!isFn) this.objectIndex++;
      return { object: parsed.data, usage: USAGE, model: this.modelId };
    }
    if (!isFn) this.objectIndex++;
    return { object: raw as T, usage: USAGE, model: this.modelId };
  }

  async generateText(req: GenerateTextRequest): Promise<{ text: string; usage: LlmUsage }> {
    this.calls.push({
      kind: "text",
      prompt: req.prompt,
      ...(req.system != null ? { system: req.system } : {}),
      ...(req.effort != null ? { effort: req.effort } : {}),
    });
    const text = typeof this.texts === "function" ? this.texts(req) : this.texts[this.textIndex++];
    if (text === undefined) {
      throw new LlmError("INVALID_OUTPUT", "FakeLlm: no scripted text response left");
    }
    return { text, usage: USAGE };
  }
}
