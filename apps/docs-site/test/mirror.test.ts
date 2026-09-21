import { describe, expect, it } from "vitest";
import { GITHUB_BLOB_BASE, type MirrorEntry, planMirror, rewriteLinks, routeOf } from "../src/mirror.js";

const MIRRORED = new Set([
  "docs/user-guide.md",
  "docs/user-guide.ja.md",
  "docs/design.md",
  "docs/design.ja.md",
  "docs/runbooks/release.md",
  "docs/runbooks/release.ja.md",
  "docs/runbooks/python-mirror.md",
  "spec/SPEC.md",
  "spec/SPEC.ja.md",
  "spec/examples/quarterly-sales.spec.json",
  "python/README.md",
  "python/README.ja.md",
  "docs/assets/kohaku-icon.png",
]);

const EN_GUIDE: MirrorEntry = {
  source: "docs/user-guide.md",
  target: "docs/user-guide.md",
  lang: "en",
  kind: "page",
};
const JA_GUIDE: MirrorEntry = {
  source: "docs/user-guide.ja.md",
  target: "ja/docs/user-guide.md",
  lang: "ja",
  kind: "page",
};
const JA_DESIGN: MirrorEntry = {
  source: "docs/design.ja.md",
  target: "ja/docs/design.md",
  lang: "ja",
  kind: "page",
};
const EN_RELEASE: MirrorEntry = {
  source: "docs/runbooks/release.md",
  target: "docs/runbooks/release.md",
  lang: "en",
  kind: "page",
};
const PYTHON_README: MirrorEntry = {
  source: "python/README.md",
  target: "python/README.md",
  lang: "en",
  kind: "page",
};

describe("planMirror", () => {
  it("maps EN pages, JA pages and assets to their site paths", () => {
    const plan = planMirror([
      "docs/user-guide.md",
      "docs/user-guide.ja.md",
      "spec/examples/quarterly-sales.spec.json",
      "python/README.ja.md",
    ]);
    expect(plan).toEqual([
      { source: "docs/user-guide.md", target: "docs/user-guide.md", lang: "en", kind: "page" },
      { source: "docs/user-guide.ja.md", target: "ja/docs/user-guide.md", lang: "ja", kind: "page" },
      {
        source: "spec/examples/quarterly-sales.spec.json",
        target: "public/spec/examples/quarterly-sales.spec.json",
        lang: "en",
        kind: "asset",
      },
      { source: "python/README.ja.md", target: "ja/python/README.md", lang: "ja", kind: "page" },
    ]);
  });

  it("derives clean routes for pages", () => {
    expect(routeOf(EN_GUIDE)).toBe("/docs/user-guide");
    expect(routeOf(JA_GUIDE)).toBe("/ja/docs/user-guide");
  });
});

describe("rewriteLinks", () => {
  it("leaves external links, anchors and absolute paths alone", () => {
    const md =
      "[a](https://example.com/x.md) [b](#4-demo-walkthroughs-8) [c](/spec/examples/x.json) [d](mailto:x@y.z)";
    expect(rewriteLinks(md, EN_GUIDE, MIRRORED)).toBe(md);
  });

  it("points an EN page's .ja.md link at the JA tree (relative)", () => {
    expect(rewriteLinks("English | [日本語](user-guide.ja.md)", EN_GUIDE, MIRRORED)).toBe(
      "English | [日本語](../ja/docs/user-guide.md)",
    );
  });

  it("keeps an EN page's .md link inside the EN tree, anchors preserved", () => {
    expect(
      rewriteLinks("see [design](design.md#prompt-caching) and [spec](../spec/SPEC.md)", EN_GUIDE, MIRRORED),
    ).toBe("see [design](design.md#prompt-caching) and [spec](../spec/SPEC.md)");
  });

  it("maps a JA page's .ja.md link to the same JA tree", () => {
    expect(rewriteLinks("[設計書](design.ja.md#prompt-caching)", JA_GUIDE, MIRRORED)).toBe(
      "[設計書](design.md#prompt-caching)",
    );
    expect(rewriteLinks("[SPEC](../spec/SPEC.ja.md)", JA_DESIGN, MIRRORED)).toBe("[SPEC](../spec/SPEC.md)");
  });

  it("maps a JA page's unsuffixed .md link (the English counterpart) to the EN tree", () => {
    expect(rewriteLinks("[English](user-guide.md) | 日本語", JA_GUIDE, MIRRORED)).toBe(
      "[English](../../docs/user-guide.md) | 日本語",
    );
    expect(rewriteLinks("[runbook](runbooks/python-mirror.md#x)", JA_GUIDE, MIRRORED)).toBe(
      "[runbook](../../docs/runbooks/python-mirror.md#x)",
    );
  });

  it("maps a mirrored non-Markdown file to its public/ absolute path", () => {
    expect(rewriteLinks("[example](../spec/examples/quarterly-sales.spec.json)", JA_DESIGN, MIRRORED)).toBe(
      "[example](/spec/examples/quarterly-sales.spec.json)",
    );
  });

  it("sends links to repository files outside the mirror to GitHub", () => {
    expect(rewriteLinks("[changesets](../../.changeset/README.md)", EN_RELEASE, MIRRORED)).toBe(
      `[changesets](${GITHUB_BLOB_BASE}.changeset/README.md)`,
    );
    expect(rewriteLinks("[agents](../AGENTS.md)", EN_GUIDE, MIRRORED)).toBe(
      `[agents](${GITHUB_BLOB_BASE}AGENTS.md)`,
    );
  });

  it("rewrites every link on a line, not only the first", () => {
    expect(rewriteLinks("[a](design.ja.md) and [b](user-guide.ja.md)", EN_GUIDE, MIRRORED)).toBe(
      "[a](../ja/docs/design.md) and [b](../ja/docs/user-guide.md)",
    );
  });

  it("does not touch fenced code blocks", () => {
    const md =
      "```bash\nnode cli/bin/kohaku.js scaffold ports --out ./my-app/kohaku # [x](design.ja.md)\n```\n[y](design.ja.md)";
    expect(rewriteLinks(md, EN_GUIDE, MIRRORED)).toBe(
      "```bash\nnode cli/bin/kohaku.js scaffold ports --out ./my-app/kohaku # [x](design.ja.md)\n```\n[y](../ja/docs/design.md)",
    );
  });

  it("rewrites a raw-HTML img src attribute on the mirrored python/README.md page", () => {
    const md = '<img src="../docs/assets/kohaku-icon.png" alt="kohaku" width="112">';
    expect(rewriteLinks(md, PYTHON_README, MIRRORED)).toBe(
      '<img src="/docs/assets/kohaku-icon.png" alt="kohaku" width="112">',
    );
  });

  it("leaves a raw-HTML img src inside a fenced code block alone", () => {
    const md = '```html\n<img src="../docs/assets/kohaku-icon.png" alt="kohaku" width="112">\n```';
    expect(rewriteLinks(md, PYTHON_README, MIRRORED)).toBe(md);
  });
});
