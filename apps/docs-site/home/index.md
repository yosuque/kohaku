---
layout: home
hero:
  name: kohaku
  text: An AI-native GUI library
  tagline: UI as data. Generation separated from rendering. The same request produces the same screen, from chat or from the GUI.
  actions:
    - theme: brand
      text: Why kohaku
      link: /docs/why-kohaku
    - theme: alt
      text: User guide
      link: /docs/user-guide
    - theme: alt
      text: GitHub
      link: https://github.com/yosuque/kohaku
features:
  - title: Identical display, structurally
    details: Chat and GUI converge on one canonical Intent and one cached UI Spec. Temperature 0 is an aid, not the guarantee.
  - title: Pass-by-reference data
    details: The Spec carries query:// references, never numbers. The LLM builds the plumbing; the water never flows through it.
  - title: Governed generation
    details: L0 fixed ⇄ L1 declarative ⇄ L2 free-form, with a promotion pipeline that solidifies what works into official parts.
---

## Choose your path

| You are… | Start with | First code |
|---|---|---|
| An MCP server author | [Path (a): MCP Apps only](/docs/paths/mcp-apps) | one `attachKohakuToMcpServer` call |
| A product team that wants Server-Driven UI now, LLM later | [Path (b): React dashboard only](/docs/paths/react-dashboard) | a hand-written Spec + `<SpecView>` |
| A team putting model-composed UI into production | [Path (c): Full stack](/docs/paths/full-stack) | a governed REST host in 30 lines |
