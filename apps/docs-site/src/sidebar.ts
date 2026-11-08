export interface SidebarItem {
  text: string;
  link: string;
}

export interface SidebarGroup {
  text: string;
  items: SidebarItem[];
}

export const NAV_EN: SidebarItem[] = [
  { text: "User guide", link: "/docs/user-guide" },
  { text: "Design", link: "/docs/design" },
  { text: "Protocol", link: "/spec/SPEC" },
];

export const NAV_JA: SidebarItem[] = [
  { text: "ユーザーガイド", link: "/ja/docs/user-guide" },
  { text: "設計書", link: "/ja/docs/design" },
  { text: "プロトコル", link: "/ja/spec/SPEC" },
];

export const SIDEBAR_EN: SidebarGroup[] = [
  {
    text: "Start here",
    items: [
      { text: "Why kohaku", link: "/docs/why-kohaku" },
      { text: "Path (a): MCP Apps only", link: "/docs/paths/mcp-apps" },
      { text: "Path (b): React dashboard only", link: "/docs/paths/react-dashboard" },
      { text: "Path (c): Full stack", link: "/docs/paths/full-stack" },
    ],
  },
  {
    text: "Guides",
    items: [
      { text: "Glossary", link: "/docs/glossary" },
      { text: "User guide", link: "/docs/user-guide" },
      { text: "Implementation design", link: "/docs/design" },
      { text: "Specification", link: "/docs/specification" },
      { text: "Python implementation", link: "/python/README" },
    ],
  },
  {
    text: "Protocol",
    items: [{ text: "Kohaku Protocol v0.1", link: "/spec/SPEC" }],
  },
  {
    text: "Runbooks",
    items: [
      { text: "Adding a core component", link: "/docs/runbooks/add-component" },
      { text: "Changing the protocol", link: "/docs/runbooks/protocol-change" },
      { text: "Mirroring to Python", link: "/docs/runbooks/python-mirror" },
      { text: "Release", link: "/docs/runbooks/release" },
    ],
  },
  {
    text: "Decisions (ADR)",
    items: [
      { text: "ADR template", link: "/docs/adr/0000-template" },
      { text: "0001. Record architecture decisions", link: "/docs/adr/0001-record-architecture-decisions" },
      {
        text: "0002. Lockfile-only dependency updates",
        link: "/docs/adr/0002-update-dependencies-lockfile-only-with-cooldown",
      },
      {
        text: "0003. No sampling parameters (Python claude)",
        link: "/docs/adr/0003-python-claude-adapter-sends-no-sampling-parameters",
      },
      {
        text: "0004. Capability tenant is authoritative",
        link: "/docs/adr/0004-capability-tenant-is-authoritative-on-the-data-plane",
      },
      {
        text: "0005. Optional storage compare-and-set",
        link: "/docs/adr/0005-storage-compare-and-set-is-an-optional-extension",
      },
      {
        text: "0006. Reads never run gated operations",
        link: "/docs/adr/0006-data-plane-read-path-never-runs-gated-operations",
      },
      {
        text: "0007. Composer-injected L1 filters",
        link: "/docs/adr/0007-composer-injects-l1-filters-from-intent-facets",
      },
      {
        text: "0008. MCP write tools default to approve",
        link: "/docs/adr/0008-mcp-write-tools-default-to-approve-tier",
      },
      {
        text: "0009. LLM base URL is the vendor root",
        link: "/docs/adr/0009-llm-base-url-is-the-vendor-api-root",
      },
      {
        text: "0010. No sampling parameters (TS claude)",
        link: "/docs/adr/0010-ts-claude-path-sends-no-sampling-parameters",
      },
      {
        text: "0011. Python keeps full parity",
        link: "/docs/adr/0011-python-keeps-full-parity-with-typescript",
      },
      {
        text: "0012. Generated init version table",
        link: "/docs/adr/0012-init-version-table-is-generated-from-the-pnpm-catalog",
      },
    ],
  },
];

export const SIDEBAR_JA: SidebarGroup[] = [
  {
    text: "まずここから",
    items: [
      { text: "なぜ kohaku か", link: "/ja/docs/why-kohaku" },
      { text: "パス (a): MCP Apps だけ", link: "/ja/docs/paths/mcp-apps" },
      { text: "パス (b): React ダッシュボードだけ", link: "/ja/docs/paths/react-dashboard" },
      { text: "パス (c): フル構成", link: "/ja/docs/paths/full-stack" },
    ],
  },
  {
    text: "ガイド",
    items: [
      { text: "用語集", link: "/ja/docs/glossary" },
      { text: "ユーザーガイド", link: "/ja/docs/user-guide" },
      { text: "実装設計書", link: "/ja/docs/design" },
      { text: "仕様書", link: "/ja/docs/specification" },
      { text: "Python 実装", link: "/ja/python/README" },
    ],
  },
  {
    text: "プロトコル",
    items: [{ text: "Kohaku Protocol v0.1", link: "/ja/spec/SPEC" }],
  },
  {
    text: "Runbooks",
    items: [{ text: "リリース", link: "/ja/docs/runbooks/release" }],
  },
  {
    text: "設計判断の記録 (ADR)",
    items: [
      { text: "ADR テンプレート", link: "/ja/docs/adr/0000-template" },
      { text: "0001. 判断を ADR として記録する", link: "/ja/docs/adr/0001-record-architecture-decisions" },
      {
        text: "0002. 依存の更新は lockfile のみ",
        link: "/ja/docs/adr/0002-update-dependencies-lockfile-only-with-cooldown",
      },
      {
        text: "0003. sampling parameter を送らない(Python claude)",
        link: "/ja/docs/adr/0003-python-claude-adapter-sends-no-sampling-parameters",
      },
      {
        text: "0004. capability のテナントを正とする",
        link: "/ja/docs/adr/0004-capability-tenant-is-authoritative-on-the-data-plane",
      },
      {
        text: "0005. storage の compare-and-set は任意",
        link: "/ja/docs/adr/0005-storage-compare-and-set-is-an-optional-extension",
      },
      {
        text: "0006. 読み取りは gated な操作を実行しない",
        link: "/ja/docs/adr/0006-data-plane-read-path-never-runs-gated-operations",
      },
      {
        text: "0007. L1 のフィルタは composer が注入",
        link: "/ja/docs/adr/0007-composer-injects-l1-filters-from-intent-facets",
      },
      {
        text: "0008. MCP の書き込みは既定で approve",
        link: "/ja/docs/adr/0008-mcp-write-tools-default-to-approve-tier",
      },
      {
        text: "0009. LLM の base URL はベンダーの根",
        link: "/ja/docs/adr/0009-llm-base-url-is-the-vendor-api-root",
      },
      {
        text: "0010. sampling parameter を送らない(TS claude)",
        link: "/ja/docs/adr/0010-ts-claude-path-sends-no-sampling-parameters",
      },
      {
        text: "0011. Python は完全な対応を保つ",
        link: "/ja/docs/adr/0011-python-keeps-full-parity-with-typescript",
      },
      {
        text: "0012. init の版表は catalog から生成",
        link: "/ja/docs/adr/0012-init-version-table-is-generated-from-the-pnpm-catalog",
      },
    ],
  },
];

export function sidebarLinks(groups: readonly SidebarGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.link));
}
