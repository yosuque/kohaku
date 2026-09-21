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
    text: "Guides",
    items: [
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
];

export const SIDEBAR_JA: SidebarGroup[] = [
  {
    text: "ガイド",
    items: [
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
];

export function sidebarLinks(groups: readonly SidebarGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.link));
}
