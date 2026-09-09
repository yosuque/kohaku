import type { ComposeResult } from "@kohaku-ui/composer";
import { parseInvokableRef } from "@kohaku-ui/host-core";
import type { TabularData, UISpec } from "@kohaku-ui/spec-core";
import {
  collectComponentRefs,
  preresolveTimeoutMs,
  preresolveTotalTimeoutMs,
  resolveRefsBounded,
} from "./initial-data.js";
import type { ToolContext } from "./types.js";

/** Detects the #kohaku-snapshot placeholder (`null`) inside the shared renderer (survives even after the single-file build). */
const SNAPSHOT_PLACEHOLDER_RE = /(<script id="kohaku-snapshot"[^>]*>)null(<\/script>)/;

/**
 * Replaces the shared renderer's #kohaku-snapshot placeholder (`null`) with the {spec, data} JSON.
 * If the placeholder is absent (= renderer unbuilt / FALLBACK_HTML), throws an exception directing a rebuild.
 */
function injectSnapshot(html: string, spec: UISpec, data: Record<string, TabularData>): string {
  if (!SNAPSHOT_PLACEHOLDER_RE.test(html)) {
    // A `code` marks this as a deliberate, host-authored guidance error (host-core's isTypedHostError), so
    // its message still reaches the caller instead of collapsing to the generic internal-error text.
    throw Object.assign(
      new Error(
        'The shared renderer has no <script id="kohaku-snapshot"> placeholder. ' +
          "Please rebuild with pnpm --filter @kohaku-ui-sample/mcp build:renderer.",
      ),
      { code: "RENDERER_UNBUILT" },
    );
  }
  // Uniformly escape every `<` (U+003C) in the JSON string to Unicode-escape form. HTML's script end-tag detection is
  // case-insensitive and also terminates on whitespace / newline / `/`, so escaping only an exact `</script>` match would
  // let variants (`</SCRIPT>`, `</script >`, `</script\n>`, etc.) pass through, and an HTML/JS injection (breakout) from the
  // embedded JSON would succeed. Uniformly escaping `<` makes it impossible to close the script early with any variant
  // (the escaped form is valid JSON escaping, so JSON.parse restores the original `<` and the renderer-side reading is unchanged).
  const json = JSON.stringify({ spec, data }).replace(/</g, "\\u003c");
  // Pass the replacement as a function (so that the "$" in $ref / $state etc. is not misinterpreted as replace's special replacement patterns like $1).
  return html.replace(SNAPSHOT_PLACEHOLDER_RE, (_m, open: string, close: string) => `${open}${json}${close}`);
}

/**
 * Assembles self-contained snapshot HTML from a composed result (shared by the render_snapshot tool and the
 * mcp-ui legacy UIResource co-emission). For each data in the Spec, resolves the initial $ref and all bind
 * variants (enumerateBindVariants) with read, and embeds them into the shared renderer's #kohaku-snapshot as
 * {spec, data} (landing the reference-passing right here). The same variant set as capability issuance
 * (issueCapability) is resolved all the way down to actual data here. The snapshot is the full amount with no
 * budget (unlike preresolveInitialData's `_meta` co-embedding).
 *
 * `preresolved`, when passed, supplies already-resolved refs (composeAndPackage passes preresolveInitialData's
 * full pre-budget Map here for the legacyUiResource co-emission path, since it needs the identical ref set
 * preresolveInitialData already resolved) — only refs missing from it are actually invoked here, avoiding a
 * second round of domain.invoke calls against the same DomainPort for the same request. When omitted
 * (buildSnapshot's standalone `${prefix}_render_snapshot` tool path, which has no other resolution pass to
 * share with), every ref is resolved here.
 *
 * Resolution shares initial-data.ts's resolveRefsBounded (bounded concurrency + an overall wall-clock
 * deadline, the same primitive preresolveInitialData uses) rather than an unbounded `Promise.all`, so one hung
 * dependency can no longer stall this call forever. Within that bound, a still-missing *resolvable* ref
 * (a genuine per-ref failure, per-ref timeout, or an outstanding resolution cut off by the overall deadline)
 * still throws rather than being swallowed — the snapshot must not silently embed incomplete data. A ref whose
 * source does not match `querySource` is not an error (it is simply not an embedding target, same as
 * preresolveInitialData / resolve_binding) and is excluded from both the "must resolve" set and the output.
 */
export async function snapshotHtmlFor(
  ctx: ToolContext,
  result: ComposeResult,
  preresolved?: Map<string, TabularData>,
): Promise<string> {
  // The key is the effective ref's raw (the snapshot renderer's fetcher looks up by ref.raw).
  const refs = new Set<string>();
  for (const { variants } of collectComponentRefs(result.spec)) {
    for (const variant of variants) refs.add(variant);
  }
  // Refs whose source does not match querySource are never embedding targets (mirrors resolveVariant's own
  // null-on-mismatch rule) — excluded up front so a genuine resolution failure of a *resolvable* ref can be
  // told apart from "this ref was never meant to be resolved here" below.
  const resolvableRefs = [...refs].filter(
    (ref) => parseInvokableRef(ref, ctx.deps.querySource).kind !== "source_mismatch",
  );
  const missing = resolvableRefs.filter((ref) => !preresolved?.has(ref));
  const freshlyResolved =
    missing.length > 0
      ? await resolveRefsBounded(missing, ctx, preresolveTimeoutMs(), preresolveTotalTimeoutMs())
      : new Map<string, TabularData>();

  const data: Record<string, TabularData> = {};
  for (const ref of resolvableRefs) {
    const value = preresolved?.get(ref) ?? freshlyResolved.get(ref);
    if (value == null) {
      // A code property marks this as a deliberate host error (host-core's isTypedHostError), so its message
      // reaches the caller instead of collapsing to the generic internal-error text.
      throw Object.assign(new Error(`snapshot: failed to resolve ref within the bounded deadline: ${ref}`), {
        code: "SNAPSHOT_RESOLUTION_INCOMPLETE",
      });
    }
    data[ref] = value;
  }
  return injectSnapshot(await ctx.getRendererHtml(), result.spec, data);
}
