# Glossary

English | [日本語](glossary.ja.md)

A newcomer meets around twenty kohaku-specific terms before the [user guide](user-guide.md) starts to read smoothly. The normative definitions live in [spec/SPEC.md §1](../spec/SPEC.md#1-overview-and-terminology-normative); this page is a plain-language on-ramp to the same terms, each linked back to where it is defined precisely and to the guide section that uses it.

## Terms

**A2UI ingest** — Rendering a *third-party* agent's A2UI surface inside your own kohaku-based product, so it gets the same caching, lineage and fixation as anything kohaku composed itself. See [User guide, "A2UI ingest"](user-guide.md#a2ui-ingest-governance-proxy-for-a-third-party-agents-surface-draft) and [SPEC §6.3](../spec/SPEC.md#63-a2ui-profile-draft).

**Adoption ladder** — The staged path for adding kohaku to an existing product: the Zero-Port quickstart, then Step 0 (Server-Driven UI, no LLM), Step 1 (L1 declarative synthesis), and Step 2 (L2, promotion, fixation). Each rung keeps working once you add the next. See [User guide §6](user-guide.md#6-embedding-it-into-your-own-product).

**Capability (token)** — The bearer token a compose call returns next to a Spec. It scopes exactly which `data.$ref`s can be read and which declared writes (`action.invoke`) can be invoked, for a limited time, so a component can fetch and write its own data without the LLM ever holding a credential. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative) and [§5 Security](../spec/SPEC.md#5-security-normative).

**Catalog / catalogFingerprint** — The Catalog is the set of typed UI components (`ComponentDefinition`s) a host can render, assembled from core parts, product contributions and promoted parts. `catalogFingerprint`, a hash of the sorted `type@version` list, is one component of the Spec cache key, so publishing a new part never mixes with Specs cached under the old catalog. This is distinct from the *Intent catalog* (the set of registered Intents, below). See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative).

**`createKohakuHost`** — The one-call facade (`@kohaku-ui/host`) that wires the DomainPort you supply together with working defaults for the other three Ports into a REST host. It is the fastest way to stand up kohaku inside your own product once you outgrow the Zero-Port quickstart. See [User guide §6, Step 0](user-guide.md#step-0--server-driven-ui-without-an-llm).

**Design kit** — The class-name vocabulary a design system declares for L2 free generation (`DesignSystemGuide.kit`, a `DesignKitVocabulary`), so a generated component can follow your product's class names instead of inventing new ones. The vocabulary is only half the picture: the actual CSS is a separate render-side object — renderer-core's built-in `defaultDesignKit`, or a product's own passed to the sandbox. See [User guide, "Applying a design system to L2"](user-guide.md#applying-a-design-system-to-l2).

**Fixation** — Promoting a frequently requested, structurally stable L1 Intent to L0: the structure is pinned and never goes through the LLM again, while its data still updates through pass-by-reference. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative).

**`generatorVersion`** — An optional trailing component of the Spec cache key that separates generated artifacts by generation across prompt revisions and model changes. Changing a prompt or a model without bumping it would otherwise mix new output into a cache built for the old one. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative) and [User guide §7](user-guide.md#7-operational-tips).

**Intent / CanonicalIntent / intentHash** — An Intent is the single normalized representation a chat question and a GUI action both reduce to (e.g. `sales.quarterly_summary` plus sorted params). `CanonicalIntent` is its wire form, and `intentHash` (`sha256:` of that form's canonical JSON) anchors the Spec cache key: the same Intent always hashes to the same value, so it produces the same screen. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative).

**Intent catalog** — The set of Intent definitions a product registers (canonical name, param schema, query mapping) — distinct from the Catalog above, which is a set of UI *components*. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative).

**`kohaku explain` / DevTools** — Two front ends — a CLI command and a floating panel (`@kohaku-ui/admin-react/devtools`) — over the same `ExplainReport`. Given one `requestId`, either shows why a screen came out the way it did: tier, cache hit or miss, the cache-key breakdown, which generation attempts ran and why they failed, and every lineage event that request produced. See [User guide, "Kohaku DevTools and `kohaku explain`"](user-guide.md#kohaku-devtools-and-kohaku-explain).

**L0 / L1 / L2 (the tier ladder)** — The three ways a Spec gets produced. L0 is deterministic: a fixed template or a fixation, never touching the LLM. L1 is declarative composition: the LLM only selects catalog parts and fills their typed props. L2 is free generation inside a sandbox, for a request the catalog cannot express. A request climbs the ladder only as far as it needs to. See [SPEC §4](../spec/SPEC.md#4-composition-rules-normative-post-processing-norms-are-draft).

**Lineage** — The append-only audit log of everything that happens to a Spec: composition, interaction, promotion review, fixation. "Why did this view come out this way" is answered from it. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative).

**MCP Apps** — The transport profile (SEP-1865) kohaku uses to deliver the same Spec and the same rendering code to an MCP host — Claude Desktop, claude.ai, ChatGPT — as an interactive widget instead of a wall of text. See [Path (a): MCP Apps only](paths/mcp-apps.md) and [SPEC §6.2](../spec/SPEC.md#62-mcp-apps-profile-sep-1865-normative).

**Playground** (`apps/playground`) — A server-free build of the sample web app that runs the whole host inside the browser tab, backed by an in-memory storage port and a replay-only LLM answering from pre-recorded fixtures. Nothing run in it reaches a server or needs an API key. See [User guide §10](user-guide.md#10-static-playground).

**Port (DomainPort / SemanticPort / AuthzPort / StoragePort)** — The four interfaces that form kohaku's framework boundary. DomainPort is your data/query API — the one Port every product writes by hand. SemanticPort normalizes NL and GUI input into Intents. AuthzPort issues and verifies capability tokens. StoragePort backs the Spec cache, lineage, promotions and fixations. See [AGENTS.md](../AGENTS.md) and [User guide §6, Step 0](user-guide.md#step-0--server-driven-ui-without-an-llm).

**Promotion** — Reviewing an L2-generated part until it earns a typed schema and joins the Catalog as a native L1 part. A human approval is always required; nothing is promoted automatically. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative).

**Provenance** — The part of a Spec's envelope that records why it looks the way it does: tier, cache status, model, `generatorVersion`, design kit identity, and any fallback or downgrade that occurred. See [SPEC §2.1](../spec/SPEC.md#21-envelope).

**QueryHandle** — The resolved identity of a `query://` reference that L1 generation is constrained to choose among, so the LLM can only ever point at data your DomainPort actually exposes for that Intent, never invent a query of its own. See [SPEC §4](../spec/SPEC.md#4-composition-rules-normative-post-processing-norms-are-draft) (CMP-GEN-001).

**`$ref` (pass-by-reference)** — The one way bulk data may enter a Spec: a `query://<source>/<path>?<params>` URI, resolved later by a component holding a capability token — never the values themselves. This is what keeps a row of your data out of the model's context. See [SPEC §2.3](../spec/SPEC.md#23-data-binding-pass-by-reference).

**SpecPatch** — A component-granular diff between two Specs, sent as an incremental update after an interaction, or while streaming a slow L1/L2 generation, instead of retransmitting the whole Spec. See [SPEC §2.5](../spec/SPEC.md#25-specpatch-incremental-update).

**Surface** — A host that accepts input and renders a Spec. The sample's web dashboard, its chat pane, and an MCP Apps widget are three surfaces sharing one Composition Service. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative).

**UI Spec** — The declarative JSON document a compose call returns: data describing a screen's structure and semantics, not code, cached and rendered identically regardless of which renderer draws it. See [SPEC §1](../spec/SPEC.md#1-overview-and-terminology-normative) and [SPEC §2](../spec/SPEC.md#2-ui-spec-format-normative).

**Zero-Port quickstart** — `npx @kohaku-ui/cli init --from <data file>`, which generates a whole working app — a DomainPort, an Intent catalog, an L0 fixed Spec, a Dashboard-plus-Chat web app — from a CSV/JSON/SQLite file, with no Port code to write first. See [User guide, "Zero-Port quickstart"](user-guide.md#zero-port-quickstart-from-your-own-data-no-port-code).
