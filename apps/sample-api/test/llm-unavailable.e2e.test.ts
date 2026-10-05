import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { LLM_PROVIDER_UNAVAILABLE_MESSAGE } from "@kohaku-ui/host-core";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { SemanticNormalizeError } from "@kohaku-ui/semantic-llm";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// Integration check across the real classes the unit tests only stub: sample-api's SemanticPort is built on
// @kohaku-ui/semantic-llm's createLlmSemanticPort, so an error thrown by the LLM travels
// normalizeNlQuery -> createLlmSemanticPort -> host-core's resolveIntent -> host-rest's intentResolutionFailure.
// A provider that cannot serve the call must answer 503 with the fixed message (never the SDK wording), while a
// real SemanticNormalizeError (code NO_MATCH) keeps its own message on 422 INTENT_INVALID.

const RAW_SDK_MESSAGE =
  "[claude/claude-sonnet-5] Anthropic API key is missing. Pass it using the 'apiKey' parameter or the ANTHROPIC_API_KEY environment variable.";

async function normalize(
  thrown: Error,
): Promise<{ status: number; body: { error: { code: string; message: string } } }> {
  const llm = new FakeLlm({
    objects: () => {
      throw thrown;
    },
  });
  const { app } = await createApp({
    llm,
    storage: createMemoryStoragePort(),
    authz: createHmacAuthzPort("test-secret"),
  });
  const res = await app.request("/api/kohaku/intent/normalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { kind: "nl", text: "monthly revenue trend" } }),
  });
  return { status: res.status, body: (await res.json()) as { error: { code: string; message: string } } };
}

describe("an unavailable LLM provider through the real createLlmSemanticPort", () => {
  it("POST /intent/normalize answers 503 INTERNAL with the fixed message and no SDK wording", async () => {
    const { status, body } = await normalize(new LlmError("CONFIG", RAW_SDK_MESSAGE));

    expect(status).toBe(503);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe(LLM_PROVIDER_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify(body)).not.toContain("API key");
  });

  it("a real SemanticNormalizeError (NO_MATCH) keeps its own message on 422 INTENT_INVALID", async () => {
    // normalizeNlQuery rethrows anything that is not an LlmError, so the real class reaches the route unchanged.
    const { status, body } = await normalize(
      new SemanticNormalizeError(
        "monthly revenue trend",
        "the question does not match any intent in the catalog",
      ),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(body.error.message).toBe("the question does not match any intent in the catalog");
  });
});
