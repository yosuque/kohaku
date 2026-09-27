import {
  type GenerateObjectRequest,
  type GenerateObjectResult,
  type GenerateTextRequest,
  isZodSchema,
  LlmError,
  type LlmPort,
  type LlmUsage,
} from "@kohaku-ui/llm";
import { objectFixtureKey, textFixtureKey } from "./fixture-key.js";

const USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

/** A recorded `generateObject` response, in the same shape FixtureLlm writes to a `<key>.json` file. */
export interface RecordedObjectResponse {
  object: unknown;
  /** Recording-time provenance only; ignored on replay. */
  prompt?: string;
}

/** A recorded `generateText` response, in the same shape FixtureLlm writes to a `<key>.json` file. */
export interface RecordedTextResponse {
  text: string;
  /** Recording-time provenance only; ignored on replay. */
  prompt?: string;
}

export type ReplayFixtureValue = RecordedObjectResponse | RecordedTextResponse;

/** One fixture entry carrying its own lookup key, for the array constructor form (see ReplayLlm's doc). */
export type ReplayFixtureEntry = ReplayFixtureValue & { key: string };

/**
 * A fixture set: either a `Record<key, response>` (e.g. `JSON.parse`d straight from a bundled fixture
 * asset keyed by fixtureKeyOf), or an array of `{ key, ...response }` entries (equivalent, just easier to
 * hand-write or diff — see reports/u5-2.md for how u5-3's recording step is expected to produce either
 * shape).
 */
export type ReplayFixtures = ReplayFixtureEntry[] | Record<string, ReplayFixtureValue>;

function isObjectResponse(value: ReplayFixtureValue): value is RecordedObjectResponse {
  return "object" in value;
}

function toFixtureMap(fixtures: ReplayFixtures): Map<string, ReplayFixtureValue> {
  if (Array.isArray(fixtures)) {
    return new Map(fixtures.map(({ key, ...value }) => [key, value as ReplayFixtureValue]));
  }
  return new Map(Object.entries(fixtures));
}

/**
 * A replay-only LlmPort, browser-safe (no filesystem access, unlike FixtureLlm): looks up a recorded
 * response by the exact same key function FixtureLlm uses (`fixture-key.ts`'s `objectFixtureKey` /
 * `textFixtureKey`), so a fixture recorded via `FixtureLlm({ record: true, live })`'s `<key>.json` files
 * replays here unchanged once bundled into a `ReplayFixtures` set. Intended for the static playground
 * (U5), where there is no server to record against and no filesystem to read from at runtime.
 *
 * Does not implement `streamObject` (optional on LlmPort) — a caller falls back to `generateObject`
 * (behaviorally equivalent, no partials), matching FixtureLlm's own behavior.
 */
export class ReplayLlm implements LlmPort {
  readonly provider: string;
  readonly modelId: string;

  private readonly fixtures: Map<string, ReplayFixtureValue>;

  constructor(fixtures: ReplayFixtures, opts: { provider?: string; modelId?: string } = {}) {
    this.fixtures = toFixtureMap(fixtures);
    this.provider = opts.provider ?? "replay";
    this.modelId = opts.modelId ?? "replay";
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const key = await objectFixtureKey(req);
    const recorded = this.fixtures.get(key);
    if (recorded === undefined || !isObjectResponse(recorded)) {
      throw new LlmError(
        "INVALID_OUTPUT",
        `ReplayLlm: no recorded fixture for key ${key} (prompt: ${req.prompt.slice(0, 120)})`,
      );
    }
    if (isZodSchema(req.schema)) {
      const parsed = req.schema.safeParse(recorded.object);
      // Same rationale as FixtureLlm: never let a schema-mismatched recording flow downstream unvalidated.
      if (!parsed.success) {
        throw new LlmError(
          "INVALID_OUTPUT",
          `ReplayLlm: recorded response for key ${key} does not match the schema: ${parsed.error.message.slice(0, 200)}`,
        );
      }
      return { object: parsed.data, usage: USAGE, model: this.modelId };
    }
    return { object: recorded.object as T, usage: USAGE, model: this.modelId };
  }

  async generateText(req: GenerateTextRequest): Promise<{ text: string; usage: LlmUsage }> {
    const key = await textFixtureKey(req);
    const recorded = this.fixtures.get(key);
    if (recorded === undefined || isObjectResponse(recorded)) {
      throw new LlmError(
        "INVALID_OUTPUT",
        `ReplayLlm: no recorded fixture for key ${key} (prompt: ${req.prompt.slice(0, 120)})`,
      );
    }
    return { text: recorded.text, usage: USAGE };
  }
}
