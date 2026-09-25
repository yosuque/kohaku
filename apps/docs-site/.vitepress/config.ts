import { defineConfig } from "vitepress";
import { githubHeadingSlug } from "../src/github-slug.js";
import { mermaidFence } from "../src/mermaid-fence.js";
import { NAV_EN, NAV_JA, SIDEBAR_EN, SIDEBAR_JA } from "../src/sidebar.js";

// DOCS_BASE lets a deployment mount the site under a sub-path (e.g. "/kohaku/" on GitHub Pages)
// without touching the config; local builds and CI use "/".
const base = process.env["DOCS_BASE"] ?? "/";

export default defineConfig({
  title: "kohaku",
  description: "An AI-native GUI library: UI as data, generation separated from rendering.",
  base,
  srcDir: ".generated",
  outDir: "dist",
  cacheDir: ".vitepress/cache",
  cleanUrls: true,
  // The mirror rewrites every relative link, so a dead link normally means a real documentation bug.
  // The one known exception is docs/user-guide.md's prose ("Open http://localhost:5173"), which is a
  // literal dev-server URL, not a mirror target — rewriteLinks correctly leaves it untouched (absolute
  // URLs are never rewritten), and VitePress's own checker flags localhost links as dead by design.
  // 'localhostLinks' ignores only that category while still failing the build on any other dead link.
  ignoreDeadLinks: "localhostLinks",
  lastUpdated: false,
  markdown: {
    config: (md) => mermaidFence(md),
    // Every in-repo anchor link (README.md, apps/sample-mcp/README.md, and the pages this plan added)
    // is written against GitHub's own heading-slug rule, because the Markdown is read on GitHub too.
    // Overriding only `slugify` here keeps markdown-it-anchor's own duplicate-id disambiguation intact.
    anchor: { slugify: githubHeadingSlug },
  },
  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: { nav: NAV_EN, sidebar: SIDEBAR_EN },
    },
    ja: {
      label: "日本語",
      lang: "ja",
      link: "/ja/",
      themeConfig: { nav: NAV_JA, sidebar: SIDEBAR_JA },
    },
  },
  themeConfig: {
    socialLinks: [{ icon: "github", link: "https://github.com/yosuque/kohaku" }],
    search: { provider: "local" },
    outline: { level: [2, 3] },
  },
});
