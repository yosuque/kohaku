import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GenerateObjectRequest,
  type GenerateObjectResult,
  type GenerateTextRequest,
  isZodSchema,
  LlmError,
  type LlmPort,
  type LlmUsage,
} from "@kohaku-ui/llm";
import { sha256Hex } from "@kohaku-ui/spec-core";

const USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * A record/replay LlmPort. The key is sha256(prompt + system + schemaName).
 * - replay (default): responds deterministically from fixtures (CI runs on this)
 * - record: delegates to a real LLM and writes the response back to a fixture (pass `{ record: true, live: <LlmPort> }` to the constructor; remove record when replaying)
 */
export class FixtureLlm implements LlmPort {
  readonly provider = "fixture";
  readonly modelId: string;

  constructor(
    private readonly dir: string,
    private readonly opts: { record?: boolean; live?: LlmPort } = {},
  ) {
    this.modelId = opts.live?.modelId ?? "fixture";
    if (opts.record === true && opts.live == null) {
      throw new LlmError("CONFIG", "FixtureLlm record mode requires a live LlmPort");
    }
  }

  private async keyOf(parts: (string | undefined)[]): Promise<string> {
    return (await sha256Hex(parts.map((p) => p ?? "").join("\u0000"))).slice(0, 24);
  }

  private read(key: string): unknown | undefined {
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Do not throw a raw SyntaxError on a corrupted fixture; fail explicitly, following the same philosophy as a schema mismatch.
      throw new LlmError(
        "INVALID_OUTPUT",
        `FixtureLlm: fixture ${key}.json is corrupted (re-recording required)`,
      );
    }
  }

  private write(key: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(value, null, 2) + "\n");
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const key = await this.keyOf(["object", req.schemaName, req.system, req.prompt]);
    const recorded = this.read(key);
    if (recorded !== undefined) {
      const object = (recorded as { object: T }).object;
      if (isZodSchema(req.schema)) {
        const parsed = req.schema.safeParse(object);
        // If a recorded response does not match the schema, do not swallow it; fail explicitly.
        // This prevents a schema revision or a corrupted fixture from quietly flowing downstream as
        // unvalidated data, which would break FixtureLlm's guarantee of "deterministic, type-safe replay".
        if (!parsed.success) {
          throw new LlmError(
            "INVALID_OUTPUT",
            `FixtureLlm: recorded response does not match the schema (re-recording required): ${parsed.error.message.slice(0, 200)}`,
          );
        }
        return { object: parsed.data, usage: USAGE, model: this.modelId };
      }
      return { object, usage: USAGE, model: this.modelId };
    }
    if (this.opts.record === true && this.opts.live != null) {
      const result = await this.opts.live.generateObject(req);
      this.write(key, { object: result.object, prompt: req.prompt.slice(0, 400) });
      return result;
    }
    throw new LlmError(
      "INVALID_OUTPUT",
      `FixtureLlm: no fixture for key ${key} (to record, construct with { record: true, live: <real LlmPort> } and run; remove record when replaying)`,
    );
  }

  async generateText(req: GenerateTextRequest): Promise<{ text: string; usage: LlmUsage }> {
    const key = await this.keyOf(["text", req.system, req.prompt]);
    const recorded = this.read(key);
    if (recorded !== undefined) {
      return { text: (recorded as { text: string }).text, usage: USAGE };
    }
    if (this.opts.record === true && this.opts.live != null) {
      const result = await this.opts.live.generateText(req);
      this.write(key, { text: result.text, prompt: req.prompt.slice(0, 400) });
      return result;
    }
    throw new LlmError(
      "INVALID_OUTPUT",
      `FixtureLlm: no fixture for key ${key} (to record, construct with { record: true, live: <real LlmPort> } and run)`,
    );
  }
}
