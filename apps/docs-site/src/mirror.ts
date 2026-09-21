import { readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export type Lang = "en" | "ja";

/**
 * Repository-relative roots mirrored into the site. Everything the mirrored Markdown links to that is NOT
 * under one of these is rewritten to a GitHub URL, so the site never has a dead link and never carries a
 * second copy of a file that is not documentation.
 */
export const MIRROR_ROOTS: readonly string[] = [
  "docs",
  "spec/SPEC.md",
  "spec/SPEC.ja.md",
  "spec/examples",
  "python/README.md",
  "python/README.ja.md",
];

export const GITHUB_BLOB_BASE = "https://github.com/yosuque/kohaku/blob/main/";

export interface MirrorEntry {
  /** Repository-relative source path (posix), e.g. "docs/user-guide.ja.md". */
  source: string;
  /** Path inside the generated srcDir, e.g. "ja/docs/user-guide.md" or "public/spec/examples/x.json". */
  target: string;
  lang: Lang;
  kind: "page" | "asset";
}

const JA_SUFFIX = ".ja.md";

function walk(repoRoot: string, rel: string, out: string[]): void {
  const abs = join(repoRoot, rel);
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(repoRoot, posix.join(rel, name), out);
  } else {
    out.push(rel);
  }
}

/** Every file under MIRROR_ROOTS, sorted, as repository-relative posix paths. */
export function listMirrorSources(repoRoot: string): string[] {
  const out: string[] = [];
  for (const root of MIRROR_ROOTS) walk(repoRoot, root, out);
  return out.sort();
}

function isJaPage(source: string): boolean {
  return source.endsWith(JA_SUFFIX);
}

function isPage(source: string): boolean {
  return source.endsWith(".md");
}

export function planMirror(sources: readonly string[]): MirrorEntry[] {
  return sources.map((source) => {
    if (isJaPage(source)) {
      return { source, target: `ja/${source.slice(0, -JA_SUFFIX.length)}.md`, lang: "ja", kind: "page" };
    }
    if (isPage(source)) return { source, target: source, lang: "en", kind: "page" };
    return { source, target: `public/${source}`, lang: "en", kind: "asset" };
  });
}

/** The VitePress route (cleanUrls) of a mirrored page: "/docs/user-guide", "/ja/docs/user-guide". */
export function routeOf(entry: MirrorEntry): string {
  if (entry.kind !== "page") throw new Error(`not a page: ${entry.source}`);
  return `/${entry.target.slice(0, -".md".length)}`;
}

function isUntouched(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/");
}

/** Resolves `href` written in `entry.source` to a repository-relative posix path (no anchor). */
function resolveRepoPath(entry: MirrorEntry, href: string): string {
  return posix.normalize(posix.join(posix.dirname(entry.source), href));
}

/**
 * Relative path from the directory of `fromTarget` to `toTarget`, both inside the generated srcDir.
 * posix.relative("docs", "docs/design.md") = "design.md"; ("docs", "ja/docs/user-guide.md") = "../ja/docs/user-guide.md";
 * ("ja/docs", "docs/user-guide.md") = "../../docs/user-guide.md".
 */
function relativeTarget(fromTarget: string, toTarget: string): string {
  return posix.relative(posix.dirname(fromTarget), toTarget);
}

function rewriteOne(href: string, entry: MirrorEntry, mirrored: ReadonlySet<string>): string {
  if (isUntouched(href)) return href;
  const hashAt = href.indexOf("#");
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const anchor = hashAt >= 0 ? href.slice(hashAt) : "";
  if (path === "") return href;
  const repoPath = resolveRepoPath(entry, path);
  if (!mirrored.has(repoPath)) return `${GITHUB_BLOB_BASE}${repoPath}${anchor}`;
  const [targetEntry] = planMirror([repoPath]);
  if (targetEntry.kind === "asset") return `/${repoPath}${anchor}`;
  return `${relativeTarget(entry.target, targetEntry.target)}${anchor}`;
}

/**
 * Rewrites the inline links of one mirrored Markdown page so that every relative link keeps working
 * inside the generated site. Fenced code blocks are left untouched. Both the Markdown `](...)` link form
 * and a raw-HTML `src="..."` attribute (e.g. `<img src="../docs/assets/x.png">`) are rewritten through the
 * same resolver, since some pages (the Python READMEs) open with a raw `<img>` tag rather than Markdown
 * image syntax.
 */
export function rewriteLinks(markdown: string, entry: MirrorEntry, mirrored: ReadonlySet<string>): string {
  const lines = markdown.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(/\]\(([^)\s]+)\)/g, (_m, href: string) => `](${rewriteOne(href, entry, mirrored)})`)
        .replace(
          /\bsrc=(["'])([^"']+)\1/g,
          (_m, quote: string, href: string) => `src=${quote}${rewriteOne(href, entry, mirrored)}${quote}`,
        );
    })
    .join("\n");
}
