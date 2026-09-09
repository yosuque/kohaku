/**
 * Splits an L2-generated HTML document into the parts the worker runtime needs: a display title, the CSS to
 * inject as a `<style>` in the trusted document `<head>`, the JavaScript to run inside the Worker, and the
 * body markup handed to the Worker's DOM shim for parsing into its virtual tree.
 *
 * A pure function (no imports needed) reused by srcdoc.ts (build time, in the browser/Node) and by
 * smoke/index.ts (server-side pre-delivery validation) — the same split the production path uses.
 *
 * Not comment-aware: like the rest of this codebase's L2 handling (see collectScriptSyntaxIssues), `<script>`
 * and `<style>` are found with a plain regex, so one written out textually inside an HTML comment is still
 * extracted. This is deliberately fail-closed rather than fail-open with respect to inclusion — under-counting
 * scripts would silently drop generated behavior, whereas over-counting only pulls in inert-looking text that
 * runs under the exact same restricted Worker as everything else in the artifact (no special trust is granted
 * by having been "hidden" in a comment).
 */
export interface ArtifactParts {
  /** The generated `<title>` text (trimmed, whitespace-collapsed), or "" if absent. */
  title: string;
  /** The content of every `<style>` block, in document order (not yet concatenated). */
  styles: string[];
  /** The content of every classic `<script>` block (no `src`, no non-JS `type`), in document order. */
  scripts: string[];
  /** Everything left after scripts/styles are removed and (if present) `<body>...</body>` is unwrapped. */
  body: string;
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLE_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const BODY_RE = /<body[^>]*>([\s\S]*?)<\/body>/i;
const HEAD_CLOSE_RE = /<\/head\s*>/i;

/** True when a `<script ...>` tag's attribute text describes a classic (non-module, no-src) script. */
function isClassicScript(attrs: string): boolean {
  if (/\bsrc\s*=/i.test(attrs)) return false;
  const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(attrs);
  const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? "").trim().toLowerCase();
  if (type === "") return true;
  return type === "text/javascript" || type === "application/javascript";
}

export function splitArtifact(html: string): ArtifactParts {
  const titleMatch = TITLE_RE.exec(html);
  const title = titleMatch?.[1] != null ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

  const scripts: string[] = [];
  let stripped = html.replace(SCRIPT_RE, (_whole, attrs: string, body: string) => {
    if (isClassicScript(attrs)) scripts.push(body);
    return "";
  });

  const styles: string[] = [];
  stripped = stripped.replace(STYLE_RE, (_whole, body: string) => {
    styles.push(body);
    return "";
  });

  let body = stripped;
  const bodyMatch = BODY_RE.exec(stripped);
  if (bodyMatch != null) {
    body = bodyMatch[1]!;
  } else {
    const headClose = HEAD_CLOSE_RE.exec(stripped);
    if (headClose != null) {
      body = stripped.slice(headClose.index + headClose[0].length);
    }
  }
  return { title, styles, scripts, body: body.trim() };
}
