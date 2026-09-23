import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { githubHeadingSlug } from "../src/github-slug.js";
import { listMirrorSources, planMirror } from "../src/mirror.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * GitHub's renderer slugifies a heading's *rendered plain text*, after Markdown's own delimiter syntax
 * (code-span backticks, bold/italic markers, a link's URL) has already been stripped away by rendering
 * — the same thing markdown-it-anchor's own `getTokensText` does when it hands a heading's text /
 * code_inline token content to `slugify` (see ../src/github-slug.ts's docstring for why the production
 * function itself does not need to do this: it is only ever called with text already reduced this way).
 * Reproduced here, minimally, so this test extracts the same plain text from the raw Markdown source.
 */
function headingPlainText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/**
 * Every anchor id a page actually exposes: both the ids markdown-it-anchor derives from headings
 * (including its duplicate-id disambiguation — a slug repeated on the same page gets "-1", "-2", ...
 * appended, first occurrence keeps the bare slug; reproduced here rather than in the production
 * module, since that dedup is markdown-it-anchor's own job on the real site) and any explicit
 * `<a id="...">` / `<a name="...">` anchor a page hand-places right before a heading.
 *
 * `docs/design.md` / `docs/design.ja.md` do the latter deliberately (e.g. `<a id="prompt-caching">`
 * before `### Opt-in Anthropic prompt caching (...)`): those headings are long, decision-record-style
 * prose that changes over time, so a short, stable, hand-picked anchor is what other pages link
 * against instead of the heading's own (long, drifting) slug. GitHub renders a raw `<a id="...">` HTML
 * tag with a working id exactly the same way; VitePress passes the raw HTML through unchanged too
 * (verified against the built site) — so this is a second, equally valid source of anchors, not a
 * heading-slugging concern, and treating it as a slugging bug would misfix a correct link.
 */
function pageAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"\s*>\s*<\/a>/g)) anchors.add(m[1]);
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const slug = githubHeadingSlug(headingPlainText(heading[1]));
    const priorCount = seen.get(slug) ?? 0;
    seen.set(slug, priorCount + 1);
    anchors.add(priorCount === 0 ? slug : `${slug}-${priorCount}`);
  }
  return anchors;
}

/** A link this repository never rewrites and this test does not need to resolve: absolute or schemed. */
function isOutOfScope(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/");
}

/** Every `](path#anchor)` / `](#anchor)`-shaped link on a page, fenced code blocks excluded. */
function extractAnchorLinks(markdown: string): string[] {
  const links: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) links.push(m[1]);
  }
  return links.filter((href) => href.includes("#") && !isOutOfScope(href));
}

describe("githubHeadingSlug", () => {
  // Every case is a real heading in this repository paired with a real cross-file (or same-file) anchor
  // link already written against it elsewhere in the repository — so each pair is independently
  // checkable by reading the file on GitHub.com, not invented for this test.
  const CASES: ReadonlyArray<[heading: string, slug: string, evidence: string]> = [
    ["Choose your path", "choose-your-path", "docs/why-kohaku.md:40"],
    ["4. Demo walkthroughs (8)", "4-demo-walkthroughs-8", "README.md:81"],
    [
      "5. Using it from an external chat (MCP)",
      "5-using-it-from-an-external-chat-mcp",
      "apps/sample-mcp/README.md:7",
    ],
    ["4. デモウォークスルー(8 本)", "4-デモウォークスルー8-本", "README.ja.md:79"],
    [
      "Step 0 — Server-Driven UI without an LLM",
      "step-0--server-driven-ui-without-an-llm",
      "docs/paths/mcp-apps.md:46",
    ],
    [
      "Demo 3 — L2 free generation → promotion (the true forte of this framework)",
      "demo-3--l2-free-generation--promotion-the-true-forte-of-this-framework",
      "docs/paths/full-stack.md:71",
    ],
    [
      "デモ 3 — L2 自由生成 → 昇格(このフレームワークの真骨頂)",
      "デモ-3--l2-自由生成--昇格このフレームワークの真骨頂",
      "docs/paths/full-stack.ja.md:71",
    ],
    [
      "Demonstrating the non-React renderer (Web Components / zero React)",
      "demonstrating-the-non-react-renderer-web-components--zero-react",
      "docs/paths/react-dashboard.md:91",
    ],
    [
      "非 React レンダラーの実演(Web Components / React ゼロ)",
      "非-react-レンダラーの実演web-components--react-ゼロ",
      "docs/paths/react-dashboard.ja.md:91",
    ],
    ["Admin (governance plane)", "admin-governance-plane", "docs/paths/full-stack.md:71"],
    ["Admin(統制面)", "admin統制面", "docs/paths/full-stack.ja.md:71"],
    ["Applying a design system to L2", "applying-a-design-system-to-l2", "docs/paths/full-stack.md:75"],
    [
      "Getting started with golden regression",
      "getting-started-with-golden-regression",
      "docs/paths/full-stack.md:76",
    ],
    ["L2 にデザインシステムを適用する", "l2-にデザインシステムを適用する", "docs/paths/full-stack.ja.md:75"],
    ["Golden 回帰を始める", "golden-回帰を始める", "docs/paths/full-stack.ja.md:76"],
    ["Adding a part", "adding-a-part", "docs/runbooks/add-component.md:5"],
  ];

  it.each(CASES)("%s -> #%s (per %s)", (heading, slug) => {
    expect(githubHeadingSlug(heading)).toBe(slug);
  });
});

describe("every mirrored page's anchor links resolve under GitHub's own slug rule", () => {
  // This is the deliverable itself, not a proxy for it: a unit test of githubHeadingSlug alone proves
  // the function, not that a reader clicking a link on the built site actually gets somewhere. This
  // walks every page this site mirrors, extracts every anchor-carrying relative link, computes the
  // target page's real heading slugs with the same function the site's markdown-it-anchor uses, and
  // asserts the link's anchor is one of them.
  const sources = listMirrorSources(REPO_ROOT);
  const mirrored = new Set(sources);
  const pages = planMirror(sources).filter((e) => e.kind === "page");
  const anchorsByRepoPath = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!source.endsWith(".md")) continue;
    anchorsByRepoPath.set(source, pageAnchors(readFileSync(join(REPO_ROOT, source), "utf8")));
  }

  it("has no dangling in-repo anchor link", () => {
    const broken: string[] = [];
    for (const page of pages) {
      const raw = readFileSync(join(REPO_ROOT, page.source), "utf8");
      for (const href of extractAnchorLinks(raw)) {
        const hashAt = href.indexOf("#");
        const path = href.slice(0, hashAt);
        const anchor = href.slice(hashAt + 1);
        if (anchor === "") continue; // a bare trailing "#" is not an anchor link
        const targetRepoPath =
          path === "" ? page.source : posix.normalize(posix.join(posix.dirname(page.source), path));
        // Out of scope: not a Markdown page this site mirrors (e.g. a GitHub-only file, or an asset).
        if (!mirrored.has(targetRepoPath) || !targetRepoPath.endsWith(".md")) continue;
        const anchors = anchorsByRepoPath.get(targetRepoPath);
        if (anchors == null || !anchors.has(anchor)) {
          broken.push(
            `${page.source} -> ${href}  (${targetRepoPath} has no heading slugging to "${anchor}"; has: ${[...(anchors ?? [])].join(", ")})`,
          );
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
