import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { computeIntentHash } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import type { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// End-to-end check of the direct-Intent validation gap (t0-3a): kind: "intent" bypassed SemanticPort.normalize
// (and any Intent-catalog lookup it consults internally), so an invalid params value like metric:"bogus" used
// to reach finalizeIntent unchecked, mint a fresh intentHash, and eventually fail inside compose with a 500
// (query resolution). sample-api's SemanticPort (createSemanticPort, built on @kohaku-ui/semantic-llm's
// createLlmSemanticPort) now implements validateIntent, so every entry point that resolves a directly-specified
// Intent (host-core's resolveIntent) should reject it with 422 INTENT_INVALID instead, before anything is
// composed, cached, recorded to lineage, or fixated.

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A real Intent from sample-api's catalog whose `metric` param is a closed enum (revenue/units). */
const INVALID_INTENT = { canonical: "sales.trend", params: { metric: "bogus" } };

async function composedViewCount(app: Hono): Promise<number> {
  const res = await app.request("/api/kohaku/lineage?type=view.composed&limit=1000");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { events: unknown[] };
  return body.events.length;
}

async function fixationCount(app: Hono): Promise<number> {
  const res = await app.request("/api/kohaku/fixations");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { fixations: unknown[] };
  return body.fixations.length;
}

describe('direct-Intent validation (metric:"bogus") across compose / events / fixations approve', () => {
  it("POST /compose with an invalid params value is 422 INTENT_INVALID and records no view.composed", async () => {
    const dataDir = tmpDir("kohaku-intent-validation-");
    const { app } = await createApp({
      llm: new FakeLlm(),
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("test-secret"),
    });

    expect(await composedViewCount(app)).toBe(0);

    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: INVALID_INTENT }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(body.error.message).toContain("metric");
    expect(await composedViewCount(app)).toBe(0);
  });

  it("POST /events with the invalid Intent as `intent` (current) is 422 INTENT_INVALID and records no view.composed/view.interacted", async () => {
    const dataDir = tmpDir("kohaku-intent-validation-");
    const { app } = await createApp({
      llm: new FakeLlm(),
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("test-secret"),
    });

    const res = await app.request("/api/kohaku/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: INVALID_INTENT, event: { on: "table1.sort", payload: {} } }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(await composedViewCount(app)).toBe(0);
    const interactedRes = await app.request("/api/kohaku/lineage?type=view.interacted&limit=1000");
    expect(((await interactedRes.json()) as { events: unknown[] }).events).toHaveLength(0);
  });

  it("POST /fixations/approve with the invalid Intent is 422 INTENT_INVALID and no fixation is written", async () => {
    const dataDir = tmpDir("kohaku-intent-validation-");
    const { app } = await createApp({
      llm: new FakeLlm(),
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("test-secret"),
    });

    expect(await fixationCount(app)).toBe(0);

    const res = await app.request("/api/kohaku/fixations/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: INVALID_INTENT }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(await fixationCount(app)).toBe(0);
    // Rejected before composeForRest ever runs, so nothing was composed/cached either.
    expect(await composedViewCount(app)).toBe(0);
  });

  it("valid params still compose normally (200), and the intentHash is unaffected by validation", async () => {
    const dataDir = tmpDir("kohaku-intent-validation-");
    const { app } = await createApp({
      llm: new FakeLlm(),
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("test-secret"),
    });

    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: { canonical: "sales.trend", params: { metric: "revenue", granularity: "month" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: { intent: { hash: string } } };
    // Hash compatibility: params that fully specify every schema default hash exactly like the plain,
    // unvalidated Intent always would have (validation does not perturb an already-normalized request).
    const expectedHash = await computeIntentHash({
      canonical: "sales.trend",
      params: { metric: "revenue", granularity: "month" },
    });
    expect(body.spec.intent.hash).toBe(expectedHash);
  });

  it("params relying on a schema default now get it filled in, which changes the intentHash (by design)", async () => {
    const dataDir = tmpDir("kohaku-intent-validation-");
    const { app } = await createApp({
      llm: new FakeLlm(),
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("test-secret"),
    });

    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: { intent: { hash: string } } };
    // Before this fix, kind: "intent" hashed params exactly as given (no defaulting), so an empty params
    // object would hash differently from the explicit-defaults form below -- and differently from what this
    // endpoint now actually returns, since validateIntent fills the schema defaults in.
    const hashOfEmptyParams = await computeIntentHash({ canonical: "sales.trend", params: {} });
    const hashOfExplicitDefaults = await computeIntentHash({
      canonical: "sales.trend",
      params: { metric: "revenue", granularity: "month" },
    });
    expect(hashOfEmptyParams).not.toBe(hashOfExplicitDefaults);
    expect(body.spec.intent.hash).toBe(hashOfExplicitDefaults);
    expect(body.spec.intent.hash).not.toBe(hashOfEmptyParams);
  });
});
