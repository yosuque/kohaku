import {
  applyPatch,
  canonicalStringify,
  parsePatch,
  parseSpec,
  type TabularData,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { ConformanceResult, RestTarget } from "./types.js";

/** An element of GET /lineage (only the parts needed by the black-box check). */
interface LineageEventLike {
  type: string;
  ts: string;
  actor?: { kind?: string };
  payload?: Record<string, unknown>;
}

/** Decides whether the response is an {error:{code,message}} envelope (code/message non-null). */
async function isErrorEnvelope(res: Response): Promise<boolean> {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown };
  } | null;
  return json?.error?.code != null && json.error.message != null;
}

/**
 * Black-box check of the REST profile (SPEC §6.1).
 * Applies to any implementation (including outside this repo) with just a baseUrl.
 */
export async function runRestSuite(target: RestTarget): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const post = (path: string, body: unknown): Promise<Response> =>
    target.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // REST-INT-001
  results.push(
    await tryCheck("REST-INT-001", async () => {
      const res = await post("/intent/normalize", {
        input: {
          kind: "gui",
          action: "view.select",
          params: { intent: target.composeIntent.canonical, ...target.composeIntent.params },
        },
      });
      if (res.status !== 200) return `status ${res.status}`;
      const json = (await res.json()) as { intent?: { hash?: string } };
      return /^sha256:[0-9a-f]{64}$/.test(json.intent?.hash ?? "") || "invalid hash format";
    }),
  );

  // REST-CMP-001 / 002
  let spec: UISpec | null = null;
  let capability = "";
  results.push(
    await tryCheck("REST-CMP-001", async () => {
      const res = await post("/compose", { intent: target.composeIntent });
      if (res.status !== 200) return `status ${res.status}`;
      const json = (await res.json()) as { spec: unknown; capability?: string };
      spec = parseSpec(json.spec); // throws if non-conformant
      capability = json.capability ?? "";
      return capability.length > 0 || "no capability";
    }),
  );

  results.push(
    await tryCheck("REST-CMP-002", async () => {
      if (spec == null) return "precondition (REST-CMP-001) not met";
      const res = await post("/compose", { intent: target.composeIntent });
      const json = (await res.json()) as { spec: unknown };
      const second = parseSpec(json.spec);
      if (second.provenance.cache !== "hit" && second.provenance.cache !== "fixated") {
        return `second compose was cache ${second.provenance.cache}`;
      }
      return (
        JSON.stringify(second.components) === JSON.stringify(spec.components) ||
        "components are not identical (determinism violation)"
      );
    }),
  );

  // REST-BND-001 / 002
  const ref = (): string | null => spec?.components.find((c) => c.data != null)?.data?.$ref ?? null;

  results.push(
    await tryCheck("REST-BND-001", async () => {
      const r = ref();
      if (r == null) return "spec has no $ref (cannot check)";
      const res = await target.fetch(`/binding/resolve?ref=${encodeURIComponent(r)}`);
      return res.status === 401 || `status ${res.status} without a capability`;
    }),
  );

  results.push(
    await tryCheck("REST-BND-002", async () => {
      const r = ref();
      if (r == null || spec == null) return "precondition not met";
      const res = await target.fetch(`/binding/resolve?ref=${encodeURIComponent(r)}`, {
        headers: { authorization: `Bearer ${capability}` },
      });
      if (res.status !== 200) return `status ${res.status}`;
      const data = (await res.json()) as TabularData;
      if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) return "not a tabular envelope";
      // SPEC-DATA-002: for a Spec with multiple $refs, spec.dataVersion is a composite version
      // ("multi:<hash>") that does not match a single response version. Compare against the
      // per-reference expected version (refVersions?.[ref] ?? dataVersion).
      const expected = spec.refVersions?.[r] ?? spec.dataVersion;
      return data.dataVersion === expected || "dataVersion does not match the per-reference expected version";
    }),
  );

  // REST-BND-003: /binding/action (the write counterpart of REST-BND-001/002) — no capability is 401, and a
  // valid capability that was never issued the needed write scope (the compose result's capability is read-only
  // for this dashboard-style Intent) is 403. Verification happens before any domain.invoke, so this probe never
  // performs a real write.
  results.push(
    await tryCheck("REST-BND-003", async () => {
      const probeBody = { action: "conformance-probe.no-such-action", payload: {} };
      const noCap = await post("/binding/action", probeBody);
      if (noCap.status !== 401) return `no capability returned status ${noCap.status} (should be 401)`;
      if (capability === "") return "precondition (REST-CMP-001 capability) not met";
      const readOnly = await target.fetch("/binding/action", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
        body: JSON.stringify(probeBody),
      });
      return (
        readOnly.status === 403 ||
        `a read-only capability on /binding/action returned status ${readOnly.status} (should be 403)`
      );
    }),
  );

  // REST-CAT-001
  results.push(
    await tryCheck("REST-CAT-001", async () => {
      const res = await target.fetch("/catalog");
      if (res.status !== 200) return `status ${res.status}`;
      const json = (await res.json()) as {
        components?: { type?: string; version?: string; propsSchema?: unknown }[];
        catalogVersion?: string;
      };
      if (json.catalogVersion == null || json.catalogVersion === "") return "no catalogVersion";
      const ok = (json.components ?? []).every(
        (c) => c.type != null && c.version != null && c.propsSchema != null,
      );
      return (ok && (json.components?.length ?? 0) > 0) || "component definition is missing required fields";
    }),
  );

  // REST-EVT-001 (MUST): a spec with declared events must have /events return a re-composition.
  // Using an Intent without events makes the MUST uncheckable (a skip does not count as a pass).
  results.push(
    await tryCheck("REST-EVT-001", async () => {
      if (spec == null) return "precondition not met";
      const event = spec.events[0];
      if (event == null) {
        return "spec declares no events, so REST-EVT-001 cannot be checked (specify an Intent that declares events via --intent)";
      }
      const res = await post("/events", {
        intent: { canonical: spec.intent.canonical, params: spec.intent.params },
        event: { on: event.on, payload: {} },
      });
      if (res.status !== 200) return `status ${res.status}`;
      const json = (await res.json()) as { spec: unknown };
      parseSpec(json.spec);
      return true;
    }),
  );

  // --- REST-ERR-001 (MUST): an invalid body to POST /compose is 400 + an error envelope ----------
  results.push(
    await tryCheck("REST-ERR-001", async () => {
      // Non-JSON body (the post helper serializes to JSON, so use raw fetch).
      const nonJson = await target.fetch("/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is not JSON",
      });
      if (nonJson.status !== 400) return `non-JSON body returned status ${nonJson.status} (should be 400)`;
      if (!(await isErrorEnvelope(nonJson)))
        return "the response to a non-JSON body is not {error:{code,message}}";
      // Both input and intent missing.
      const empty = await post("/compose", { session: { surface: "web" } });
      if (empty.status !== 400)
        return `both input and intent missing returned status ${empty.status} (should be 400)`;
      return (
        (await isErrorEnvelope(empty)) ||
        "the response with both input and intent missing is not {error:{code,message}}"
      );
    }),
  );

  // --- REST-ERR-002 (SHOULD): governance GETs are either a 200 shape or a 501 envelope --------------------
  results.push(
    await tryCheck("REST-ERR-002", async () => {
      const check = async (path: string, key: string): Promise<true | string> => {
        const res = await target.fetch(path);
        if (res.status === 200) {
          const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          return Array.isArray(json?.[key]) || `${path} is 200 but not a {${key}: []} shape`;
        }
        if (res.status === 501) {
          const json = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
          return (
            json?.error?.code === "NOT_IMPLEMENTED" || `${path} is 501 but not a NOT_IMPLEMENTED envelope`
          );
        }
        return `${path} returned status ${res.status} (should be 200 or 501)`;
      };
      const promotions = await check("/promotions", "candidates");
      if (promotions !== true) return promotions;
      return check("/fixations", "fixations");
    }),
  );

  // --- REST-LIN-001 (SHOULD): GET /lineage has an {events:[]} shape and ?limit=1 returns ≤1 items ----------
  results.push(
    await tryCheck("REST-LIN-001", async () => {
      const res = await target.fetch("/lineage?limit=1");
      if (res.status !== 200) return `status ${res.status}`;
      const json = (await res.json().catch(() => null)) as { events?: unknown } | null;
      if (!Array.isArray(json?.events)) return "not an {events: []} shape";
      return json.events.length <= 1 || `?limit=1 returned ${json.events.length} items (should be ≤1)`;
    }),
  );

  // --- REST-GOV-001 (SHOULD): invalid payload → 400, valid action on an unknown artifact → 404 --------
  results.push(
    await tryCheck("REST-GOV-001", async () => {
      const probe = await target.fetch("/promotions");
      if (probe.status === 501) {
        return { skipped: true as const, detail: "promotions not configured (GET /promotions is 501)" };
      }
      // Invalid payload (an unknown action.kind). A validation error returns 400 before the artifact-existence check.
      const bad = await post("/promotions/unknown-artifact/actions", { action: { kind: "not-a-real-kind" } });
      if (bad.status !== 400) return `invalid payload returned status ${bad.status} (should be 400)`;
      // A valid action on an unknown artifact.
      const missing = await post("/promotions/nonexistent-artifact-id/actions", {
        action: { kind: "nominate" },
      });
      return (
        missing.status === 404 ||
        `a valid action on an unknown artifact returned status ${missing.status} (should be 404)`
      );
    }),
  );

  // --- LIN-PRM-001 (MUST, black-box): a human approve(reviewed) precedes published in time order -----
  results.push(
    await tryCheck("LIN-PRM-001", async () => {
      const res = await target.fetch("/lineage?limit=1000");
      if (res.status !== 200) {
        // Unlike a vacuous pass (no component.published events, below), the check could not be attempted at
        // all here — GET /lineage itself is unreachable/erroring. Report as not-checked rather than a skip
        // that counts as a pass, so an unreachable dependency cannot masquerade as CONFORMANT.
        return {
          notChecked: true as const,
          detail: `GET /lineage returned status ${res.status} (cannot check)`,
        };
      }
      const json = (await res.json().catch(() => null)) as { events?: LineageEventLike[] } | null;
      const events = Array.isArray(json?.events) ? json.events : [];
      const published = events.filter((e) => e.type === "component.published");
      if (published.length === 0) {
        return {
          skipped: true as const,
          detail: "no component.published, cannot check (re-check after a publish)",
        };
      }
      for (const pub of published) {
        const artifactId = pub.payload?.["artifactId"];
        // Does an approve (component.reviewed, actor.kind=user) for the same artifact precede it in time order?
        const approve = events.find(
          (e) =>
            e.type === "component.reviewed" &&
            e.payload?.["artifactId"] === artifactId &&
            e.payload?.["decision"] === "approve" &&
            e.actor?.kind === "user",
        );
        if (approve == null) {
          return `no human approve (component.reviewed) precedes published (artifact ${String(artifactId)})`;
        }
        if (Date.parse(approve.ts) > Date.parse(pub.ts)) {
          return `approve is after published (time-order violation, artifact ${String(artifactId)})`;
        }
      }
      return true;
    }),
  );

  // --- REST-STR-001..003 (SPEC §6.1.1 [Draft]. The route itself is MAY, so skip if unimplemented) -----
  // POST to /compose/stream exactly once, read the SSE with a self-contained parser, and evaluate the 3 requirements
  // (not shared with the renderer-side parser, to keep the black-box check independent).
  let streamRes: Response | null = null;
  try {
    streamRes = await post("/compose/stream", { intent: target.composeIntent });
  } catch {
    streamRes = null;
  }
  const streamUnavailable =
    streamRes == null || streamRes.status === 404 || streamRes.status === 405 || streamRes.status === 501;
  const streamStatus = streamRes?.status ?? "unreachable";
  const streamSkip = {
    skipped: true as const,
    detail: `POST /compose/stream is not exposed (status ${streamStatus})`,
  };
  const streamEvents = streamUnavailable || streamRes == null ? [] : await readSseEvents(streamRes);

  results.push(
    await tryCheck("REST-STR-001", async () => {
      if (streamUnavailable) return streamSkip;
      const first = streamEvents[0];
      if (first == null || first.event !== "spec") return "the first event is not event: spec";
      const payload = JSON.parse(first.data) as { spec: unknown; capability?: string; final?: unknown };
      parseSpec(payload.spec); // §2-conformant (throws if non-conformant)
      if (typeof payload.final !== "boolean") return "final is not a boolean";
      return (payload.capability != null && payload.capability.length > 0) || "no capability";
    }),
  );

  results.push(
    await tryCheck("REST-STR-002", async () => {
      if (streamUnavailable) return streamSkip;
      const first = streamEvents.find((e) => e.event === "spec");
      if (first == null) return "no spec event";
      let streamed = parseSpec((JSON.parse(first.data) as { spec: unknown }).spec);
      for (const ev of streamEvents.filter((e) => e.event === "patch")) {
        const patch = parsePatch((JSON.parse(ev.data) as { patch: unknown }).patch);
        streamed = applyPatch(streamed, patch);
      }
      const res = await post("/compose", { intent: target.composeIntent });
      if (res.status !== 200) return `non-streaming /compose returned status ${res.status}`;
      const nonStream = parseSpec(((await res.json()) as { spec: unknown }).spec);
      const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
      return (
        (same(streamed.components, nonStream.components) && same(streamed.events, nonStream.events)) ||
        "the result of applying patches does not match the non-streaming /compose in components/events"
      );
    }),
  );

  results.push(
    await tryCheck("REST-STR-003", async () => {
      if (streamUnavailable) return streamSkip;
      const terminators = streamEvents.filter((e) => e.event === "done" || e.event === "error");
      if (terminators.length !== 1) return `${terminators.length} terminator events (should be exactly 1)`;
      const last = streamEvents[streamEvents.length - 1];
      return last?.event === terminators[0]!.event || "the terminator event is not last";
    }),
  );

  return results;
}

/**
 * Parses an SSE response into a sequence of {event, data} (a self-contained parser for the black-box check).
 * The stream terminates with done/error and the server closes it, so read the whole body before splitting into lines.
 * Multi-line data is joined with newlines; fields other than event/data (id / retry / comments) are ignored.
 */
async function readSseEvents(res: Response): Promise<{ event: string; data: string }[]> {
  const text = await res.text();
  const events: { event: string; data: string }[] = [];
  let event = "";
  let dataLines: string[] = [];
  const flush = (): void => {
    if (event !== "" || dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") });
      event = "";
      dataLines = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue; // comment line
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  flush(); // do not drop the last event even if there is no trailing blank line
  return events;
}

async function tryCheck(
  id: string,
  fn: () => Promise<true | string | { skipped: true; detail: string } | { notChecked: true; detail: string }>,
): Promise<ConformanceResult> {
  try {
    const result = await fn();
    if (result === true) return { id, pass: true };
    if (typeof result === "object") {
      if ("skipped" in result && result.skipped) {
        return { id, pass: true, skipped: true, detail: result.detail };
      }
      if ("notChecked" in result && result.notChecked) {
        return { id, pass: false, notChecked: true, detail: result.detail };
      }
    }
    return { id, pass: false, detail: result as string };
  } catch (e) {
    return { id, pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
