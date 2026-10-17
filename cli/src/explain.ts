import { readFileSync } from "node:fs";
import type { ExplainReport, Transport } from "@kohaku-ui/client";
import { type UISpec, UISpecSchema } from "@kohaku-ui/spec-core";
import { errorMessage } from "./error-message.js";
import { parseHeaderArgs } from "./header-args.js";
import { createRestClient } from "./rest-client.js";

/** Options for `kohaku explain <requestId>`. */
export interface ExplainOptions {
  /** REST host base URL (e.g. http://localhost:8787/api/kohaku). */
  rest: string;
  /** Extra request headers as "name:value" strings (repeatable --header flag; commonly tenant/auth headers). */
  headers?: string[];
  /** Path to a UISpec JSON file. When given, the report's `scopes` field is populated (collectCapabilityScopes). */
  specPath?: string;
  /**
   * Transport override (no CLI flag exposes this). Symmetric with KohakuClientConfig.transport: exists so
   * tests can inject an in-process Hono app's `app.request` instead of a real network fetch. Defaults to the
   * client SDK's own default (the global fetch) when omitted, which is what every real CLI invocation gets.
   */
  transport?: Transport;
}

/**
 * `kohaku explain <requestId>`: fetches every lineage event recorded under `requestId`'s correlationId from
 * a REST host and builds an ExplainReport (@kohaku-ui/client's buildExplainReport, via KohakuClient.explain).
 * When `opts.specPath` is given, the file is parsed and validated as a UISpec (UISpecSchema) so the report's
 * `scopes` field can be computed -- a malformed file is rejected here with a clear message rather than
 * reaching collectCapabilityScopes with an untyped value.
 */
export async function runExplain(requestId: string, opts: ExplainOptions): Promise<ExplainReport> {
  const headers = parseHeaderArgs(opts.headers);
  const client = createRestClient(opts.rest, headers, opts.transport);
  let spec: UISpec | undefined;
  if (opts.specPath != null) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(opts.specPath, "utf8"));
    } catch (e) {
      throw new Error(`Cannot read/parse --spec ${opts.specPath} (${errorMessage(e)})`);
    }
    spec = UISpecSchema.parse(raw);
  }
  return client.explain(requestId, spec != null ? { spec } : undefined);
}

/** Right-pads a label to a fixed column width for formatExplainReport's aligned key/value lines. */
function label(text: string, width = 20): string {
  return text.length >= width ? `${text}: ` : `${text}:${" ".repeat(width - text.length)}`;
}

/**
 * Replaces C0 / C1 control characters (newline and carriage return included) and DEL with a visible `\xNN` escape.
 * `kohaku explain` prints strings that come out of lineage (an Intent's canonical name, validation
 * issues, ...), which a tampered or hostile record could fill with terminal escape sequences (an ESC
 * that rewrites the screen, a carriage return that overwrites the line above, a newline that forges an
 * extra report line); escaping them keeps the
 * report a plain-text description of the data rather than a channel into the terminal.
 */
export function escapeControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += isControl ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

/**
 * Formats an ExplainReport as human-readable text: `kohaku explain`'s default output (the non-`--json`
 * path). Renders provenance, the cache-key breakdown, the decision flow, capability scopes (when present),
 * and the raw lineage events -- in that order, matching the documented order of "tier, cache, cache-key breakdown,
 * decision flow, related lineage events" (docs/user-guide.md, "Kohaku DevTools and `kohaku explain`").
 */
export function formatExplainReport(report: ExplainReport): string {
  const esc = escapeControlChars;
  const lines: string[] = [];
  if (report.composes.length === 0) {
    lines.push("No view.composed event found for this requestId.");
    lines.push(
      "Check that the host has a lineage recorder wired (createKohakuHost does by default; a hand-built " +
        "createKohakuRoutes host needs `recorder`), and that this is the requestId of a compose response. " +
        "Events recorded before correlationId support shipped have none and will never match; " +
        "see docs/user-guide.md's DevTools section.",
    );
  }
  report.composes.forEach((c, i) => {
    if (report.composes.length > 1) {
      lines.push(`--- compose ${i + 1}/${report.composes.length} (a reused requestId) ---`);
    }
    lines.push(`${label("Intent")}${esc(c.canonical)} (${esc(c.intentHash)})`);
    lines.push(
      `${label("Tier / cache")}${esc(c.tier)} / ${esc(c.cache)}${c.model != null ? ` (model: ${esc(c.model)})` : ""}`,
    );
    if (c.generatorVersion != null) lines.push(`${label("Generator")}${esc(c.generatorVersion)}`);
    if (c.kit != null) lines.push(`${label("Design kit")}${esc(c.kit.id)}@${esc(c.kit.version)}`);
    if (c.fallback != null) {
      lines.push(
        `${label("Fallback")}${esc(c.fallback.from)} (${esc(c.fallback.kind ?? "generation")}): ${esc(c.fallback.reason)}`,
      );
    }
    if (c.cacheKey != null) {
      lines.push(`${label("Cache key")}${esc(c.cacheKey)}`);
      if (c.cacheKeyParts != null) {
        const p = c.cacheKeyParts;
        lines.push(
          `${label("  specVersion")}${esc(p.specVersion ?? "-")}`,
          `${label("  intentHash")}${esc(p.intentHash)}`,
          `${label("  dataVersion")}${esc(p.dataVersion)}`,
          `${label("  catalogFingerprint")}${esc(p.catalogFingerprint ?? "-")}`,
          `${label("  generatorVersion")}${esc(p.generatorVersion ?? "-")}`,
          `${label("  policyFingerprint")}${esc(p.policyFingerprint ?? "-")}`,
        );
      }
    }
    if (c.decision != null) {
      lines.push("Decision:");
      for (const a of c.decision.attempts) {
        lines.push(
          `  ${esc(a.kind)} attempt: ${a.ok ? "ok" : "failed"}${a.issues != null ? ` -- ${esc(a.issues.join("; "))}` : ""}`,
        );
      }
      for (const d of c.decision.downgrades ?? []) {
        lines.push(`  downgrade: ${esc(d.id)} ${esc(d.from)} -> ${esc(d.to)} (${esc(d.reason)})`);
      }
      if (c.decision.coalesced === true) {
        lines.push("  coalesced: rode along on another compose under single-flight");
      }
      if (c.decision.usage != null) {
        lines.push(
          `  usage: ${c.decision.usage.inputTokens} input / ${c.decision.usage.outputTokens} output tokens`,
        );
      }
    }
  });
  if (report.scopes != null) {
    lines.push(`Capability scopes (${report.scopes.length}):`);
    for (const s of report.scopes) lines.push(`  ${esc(s.kind)}: ${esc(s.ref)}`);
  }
  lines.push(`Lineage events (${report.events.length}):`);
  for (const e of report.events) lines.push(`  ${esc(e.ts)}  ${esc(e.type)}  ${esc(e.id)}`);
  return lines.join("\n");
}
