# Why kohaku

English | [日本語](why-kohaku.ja.md)

kohaku is not a faster way to generate screens. It is a way to put LLM-generated UI **into production under control**: the same request always shows the same screen, the model never touches your data, and whatever the model invents has to pass review before it becomes part of your product.

If you evaluate Generative UI on "how quickly can the model draw something", most tools look alike. kohaku is built for the questions that come after the demo: *Will it show the same thing tomorrow? Can I audit what it showed? What happens when the model is wrong?*

## The three guarantees

### 1. Identical display is structural, not statistical

Chat questions and GUI operations are both normalized into one **canonical Intent** (`sales.quarterly_summary` + sorted params). The Intent, the data version and the component-catalog fingerprint form the cache key of a **UI Spec** — a JSON document, not code. Same request → same key → the same Spec, byte for byte, whether it came from a chat bubble or a facet panel, and on every renderer (React, Web Components, an MCP Apps widget). Temperature 0 helps; the cache is the guarantee. Screens people use often are **fixated** to L0 and stop involving the model at all.

### 2. The model builds the plumbing; the water never flows through it

A Spec carries only `query://` **references**. Components fetch bulk data themselves, directly from your API, with a short-lived capability token the host issued for exactly those references. No numbers pass through the model, so there is nothing to transcribe wrongly, nothing to leak into a prompt, and no row of your data in a model provider's logs. Your DomainPort remains the single place where authorization and invariants live.

### 3. Freedom is allowed, then governed

Requests outside the catalog are generated freely (**L2**) inside a sandbox (opaque iframe, CSP, an allow-listed bridge). What the model produced is recorded in lineage; when it is used enough and judged well, it becomes a **promotion candidate**. A human reviews it — sees the rendered artifact itself, identical by sha256 to what users saw — and approves a schema. From then on it is an official **L1** part with a typed contract, and the model selects it instead of re-inventing it. Governance is the product, not an afterthought.

## Where kohaku sits

| If you need… | Consider | kohaku's position |
|---|---|---|
| The fastest path from a prompt to a one-off screen | Prompt-to-code generators, "vibe coding" tools | Not the goal. kohaku spends effort on determinism and review, which slows the first draw down |
| A chat UI component library | Chat SDKs and widget libraries | Complementary. kohaku produces the *content* of the widget as data; the chat host renders it |
| A protocol for agents to talk to UIs | A2UI / AG-UI / MCP Apps | kohaku implements MCP Apps today and ships an A2UI-compatible profile skeleton; the Spec is the payload, the protocol is the transport |
| Generated UI that must behave the same in production every day, with an audit trail | **kohaku** | Identical display + pass-by-reference + promotion pipeline, all in the reference implementation and conformance-tested in TypeScript and Python |

## When not to use it

- You need free-form, one-off screens with no reuse — the review loop is overhead you will not recoup.
- Your data can safely live inside prompts and you do not need an audit trail — a simpler prompt-to-UI tool will do.
- You cannot expose a query API for your data — pass-by-reference needs an endpoint components can call.

## Next step

Pick the path that matches you: the [User guide's "Choose your path"](user-guide.md#choose-your-path) lists three one-page starts (MCP Apps only, React dashboard only, full stack). The mechanism behind each guarantee is in the [design document](design.md).
