import { sha256Hex } from "@kohaku-ui/spec-core";

/**
 * The fixture lookup key shared by FixtureLlm (record/replay against the filesystem) and ReplayLlm
 * (replay-only, browser-safe): sha256 of `parts` joined by U+0000, truncated to the first 24 hex
 * characters. Extracted from FixtureLlm's original private `keyOf` without changing its behavior — for a
 * given part list this produces the exact same key it always has, so a fixture recorded through one of
 * FixtureLlm / ReplayLlm replays under the identical key through the other.
 */
export async function fixtureKeyOf(parts: (string | undefined)[]): Promise<string> {
  return (await sha256Hex(parts.map((p) => p ?? "").join("\u0000"))).slice(0, 24);
}

/** Fixture key for a `generateObject` call (matches FixtureLlm.generateObject's key derivation). */
export function objectFixtureKey(req: {
  schemaName?: string;
  system?: string;
  prompt: string;
}): Promise<string> {
  return fixtureKeyOf(["object", req.schemaName, req.system, req.prompt]);
}

/** Fixture key for a `generateText` call (matches FixtureLlm.generateText's key derivation). */
export function textFixtureKey(req: { system?: string; prompt: string }): Promise<string> {
  return fixtureKeyOf(["text", req.system, req.prompt]);
}
