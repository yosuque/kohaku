# kohaku User Guide

English | [日本語](user-guide.ja.md)

| Item | Details |
|---|---|
| Last updated | 2026-09-27 |
| Audience | ① People who want to run the sample app and experience the concepts; ② People who want to embed kohaku into their own product |
| Related | For how it works, see [design.md](design.md); for API details, see [specification.md](specification.md) |

---

## Choose your path

kohaku serves three kinds of readers, and each has a one-page start with its first code in 30 lines or fewer. Read [Why kohaku](why-kohaku.md) first if you are deciding whether it fits.

| You are… | Start with | What you get | Then |
|---|---|---|---|
| **An MCP server author** who wants tools to answer with a screen | [Path (a): MCP Apps only](paths/mcp-apps.md) | Typed MCP tools from your Intent catalog, a widget that renders the same in Claude Desktop / claude.ai / ChatGPT | [§5](#5-using-it-from-an-external-chat-mcp) |
| **A product team** that wants Server-Driven UI now and LLM composition later (or never) | [Path (b): React dashboard only](paths/react-dashboard.md) | L0 fixed Specs rendered by `@kohaku-ui/renderer-react`, data by reference, no model | [§6 Step 0](#step-0--server-driven-ui-without-an-llm) |
| **A team putting model-composed UI into production** | [Path (c): Full stack](paths/full-stack.md) | L1 / L2 composition, the promotion pipeline, fixation, the Admin governance plane | [§6 Steps 1–2](#step-1--l1-declarative-synthesis-and-chat), [§7](#7-operational-tips) |

The rest of this guide is the long form: setting up the bundled sample (§2), a tour of its screens (§3), eight demos (§4), MCP hosts (§5), embedding (§6), operations (§7), troubleshooting (§8) and FAQ (§9). Prefer to start from the concepts rather than from a persona? [§1](#1-what-is-this) below introduces them in three stages, each pointing at the [glossary](glossary.md).

## 1. What is this

kohaku is a framework that **merges "natural-language questions" and "GUI narrowing operations" into the same normalized Intent**, generates the **same declarative UI Spec**, and renders it with the **same renderer**. A sales-analytics app (API + Web + MCP server) ships with it as a sample.

The rest of this section introduces that in three stages, each building on the last. The [glossary](glossary.md) has a short, plain-language definition of every term below; come back to it whenever a word is unfamiliar.

### Stage 1 — Intent, Spec, `$ref`: the first screen

Three concepts get a screen on the page, with or without an LLM. A chat question and a GUI action both normalize into an **Intent** — kohaku's one request format (`sales.quarterly_summary` plus params, for instance). Composing an Intent returns a **UI Spec**: a JSON document describing the screen, not code, and it never carries a single data value — only a `$ref` a component resolves later, directly against your own API. `createKohakuHost` wires this up in one call, and `npx @kohaku-ui/cli init` generates it from a data file with no Port code to write first.

→ Glossary: [Intent, UI Spec, `$ref`](glossary.md#terms). Next: the [Zero-Port quickstart](#zero-port-quickstart-from-your-own-data-no-port-code) puts this on screen in one command.

### Stage 2 — L0 / L1 / L2 and the cache: the same request, the same screen

Once a screen needs the model, a request climbs one of three tiers to get there. **L0** is a fixed template or a pinned structure that never touches the LLM. **L1** is the LLM selecting known catalog parts and filling their typed props. **L2** is free generation in a sandbox, for a request the catalog cannot express yet. Whichever tier answers a request, the result is cached by Intent, so the same request always returns the same Spec — "identical display" (R5) is a cache guarantee, not a hope that the model behaves the same way twice.

→ Glossary: [L0 / L1 / L2](glossary.md#terms). Next: [§3, Walking through the screens](#3-walking-through-the-screens) shows the tiers in the sample's own ProvenanceBadge.

### Stage 3 — Governance: what happens to what the model invents

An L2 artifact is not the end of the story: it is recorded in **lineage**, and once it earns enough use it becomes a **promotion** candidate that a human reviews before it joins the catalog as a native part. A frequent, structurally stable L1 Intent can likewise be **fixated** to L0, so it stops going through the LLM entirely. Every read or write a rendered component performs is scoped by a short-lived **capability** token rather than a standing credential, and `kohaku explain` (or its DevTools panel) turns any `requestId` into the full story of tier, cache and lineage behind one screen.

→ Glossary: [promotion, fixation, lineage, capability](glossary.md#terms). Next: [§4, Demo walkthroughs](#4-demo-walkthroughs-8) walks through promotion and fixation end to end, and [§6, Step 2](#step-2--l2-promotion-and-fixation-complete-form) wires them into your own product.

## 2. Setup

Prerequisites: Node >= 22 (>= 22.13 for SQLite input), pnpm 12 (`npm i -g pnpm`). CI verifies on Node 22 and 24. The minimum requirement is the `engines` field in `package.json` (`node >= 22`); the conformance and Python jobs run on Node 24 only. `.node-version` (currently 25.7.0) specifies the version for the local development environment (read by nodenv and the like) and is intentionally different from the version CI uses — as long as you meet the minimum, any version works. If a version manager errors with something like "version not installed" because you don't have that exact version, install it (e.g. `nodenv install 25.7.0` / `fnm install 25.7.0`) or use any Node >= 22 you already have instead — the pin is left as-is by design, not a bug to fix. The pnpm version is pinned via `packageManager` in `package.json`.

```bash
git clone https://github.com/yosuque/kohaku.git && cd kohaku
cp .env.example .env     # configure the LLM from the table below
pnpm install
pnpm seed                # (optional) only when regenerating the sales seed (the output is git-tracked and deterministic, 576 records; dev works without it)
pnpm dev                 # API :8787 + Web :5173
```

→ Open http://localhost:5173. If `LLM: <provider> / <model> ●` appears at the top right of the header, the connection to the API is established.

### Choosing an LLM provider

Example `.env` settings:

| What you want to use | Configuration |
|---|---|
| Claude (default) | `KOHAKU_LLM_PROVIDER=claude` + `ANTHROPIC_API_KEY=sk-…` |
| OpenAI | `KOHAKU_LLM_PROVIDER=openai` + `OPENAI_API_KEY=…` |
| Gemini | `KOHAKU_LLM_PROVIDER=gemini` + `GOOGLE_GENERATIVE_AI_API_KEY=…` |
| **Ollama (no key needed, local)** | `KOHAKU_LLM_PROVIDER=ollama` + `KOHAKU_LLM_MODEL=gemma4:e4b`, etc. (the default when no model is specified is `llama3.3`) |
| llama.cpp / vLLM, etc. | `KOHAKU_LLM_PROVIDER=llama` + `KOHAKU_LLM_BASE_URL=http://…/v1` + `KOHAKU_LLM_MODEL=…` |

Install the provider SDK next to `@kohaku-ui/llm`: Claude → `@ai-sdk/anthropic`, OpenAI → `@ai-sdk/openai`, Gemini → `@ai-sdk/google`, Ollama / llama.cpp → `@ai-sdk/openai-compatible` (optional peer dependencies; nothing is installed for providers you do not use).

> **Note on Ollama**: We recommend non-reasoning instruct models. Reasoning models (qwen3.5, etc.) may spend their output tokens on reasoning, making UI synthesis slow or empty. Also, llama.cpp-family backends can be unstable when producing structured output for large schemas, but the default `KOHAKU_LLM_STRUCTURED_MODE=auto` automatically falls back to the prompt-JSON method.

> **Trying it without an LLM**: Even without configuring a key, the four standard views on the Dashboard (L0-fixated) work fully. The LLM is only needed for natural language in Chat and for trend/product ranking (L1) and free-form requests (L2).

### Demonstrating the non-React renderer (Web Components / zero React)

This is a demonstration page (`apps/sample-wc`) that renders the same UI Spec with `<kohaku-surface>` (Custom Elements + Shadow DOM), **using no React at all**. It shows that "the declarative UI Spec is renderer-independent" by drawing the same Spec used by the React version (sample-web) with a different renderer. It is not folded into the root `pnpm dev`, so it starts independently (in a separate terminal):

```bash
pnpm --filter @kohaku-ui-sample/api dev   # host (:8787). If the pnpm dev above is already running, keep it as is
pnpm --filter @kohaku-ui-sample/wc dev    # demo page (:5174; /api proxies to :8787)
```

→ Open http://localhost:5174. Changing the region select is a client-side re-resolve without a compose round-trip (A1 cross-filter); clicking a table row flows through `/events` to server-side re-composition. No LLM is needed (quarterly_summary is a deterministic fixed-Spec path). For details, see `apps/sample-wc/README.md`.

### Running the Python sample (proof that the backend language is independent)

A **full Python port** (`python/kohaku`; REST via FastAPI, MCP via the MCP Apps profile) of the same protocol (Kohaku Protocol v0.1) ships as well. It is wire-compatible with the TS implementation, and its conformance is CONFORMANT. It is proof that "the same UI on Web and MCP" does not depend on the backend language. Prerequisites are Python 3.12+ + [uv](https://docs.astral.sh/uv/).

```bash
cd python
uv sync                             # install dependencies (uv workspace)
uv run python -m sales_api          # Python sample REST host (:8790; the default is a deterministic pseudo-LLM = no key needed)
```

> **Unlike the TS sample, the Python sample does not read the repository-root `.env`** (`sales_api/__main__.py` has no `.env`-loading step). Configure it via shell environment variables, or inline on the command (as in the ollama example below).

- The default is a deterministic pseudo-LLM (`KOHAKU_LLM_PROVIDER=fake`), so **all paths work without an LLM key**. To run with a real LLM (local ollama): `KOHAKU_LLM_PROVIDER=ollama KOHAKU_LLM_MODEL=gemma4:e4b uv run python -m sales_api`.
- After startup, you can run the TS-side CLI's black-box check **from the repository root** (this CLI runs the TS implementation via tsx, so `pnpm install` must have completed at the root):

  ```bash
  node cli/bin/kohaku.js conformance --rest http://localhost:8790/api/kohaku
  ```

- The MCP server has two entry points: stdio (`uv run python -m sales_api.mcp_main`; Claude Desktop, etc.) and Streamable HTTP (`uv run python -m sales_api.mcp_http`, :8791; for claude.ai / ChatGPT, via a public tunnel, no-auth demo). The `ui://` resource serves the shared renderer built on the TS side (a placeholder if not yet built; run `pnpm --filter @kohaku-ui-sample/mcp build:renderer` first). Just like the TS sample, the fixation short-circuit, lineage recording, write side-effect declaration, and the `KOHAKU_MCP_LEGACY_UI=1` opt-in are all wired up.
- The persistence directory can be swapped via the environment variable `KOHAKU_DATA_DIR`: TS sample-api and both Python entry points (REST and MCP, stdio + Streamable HTTP) all read it. `sample-mcp` (TS) is the one exception — it always uses a fixed path relative to `apps/sample-api/.data` and does not read this variable. For setup, verification, and known differences from TS, see [../python/README.md](../python/README.md).

## 3. Walking through the screens

> **About display language**: The demo runs in **English by default**. Selecting **JA** on the header **EN/JA toggle** switches the whole sample-web app: the page chrome (nav, chat, admin), the Spec renderer's messages and formatting locale (via `RendererProvider.messages` / `locale`), the dashboard facet labels (bilingual overlays baked into `facet-views.json`), **and the generated content itself** — the toggle rides `session.locale` on every API call, and the server selects a per-session `ComposePolicy` (JA sets `outputLanguage: "Japanese"` plus Japanese L0 fixed specs, with caches separated per language via a `/ja` generatorVersion token).
>
> The dashboard re-composes on toggle; existing chat bubbles keep the language they were composed in (the next question follows the new language).
>
> Known limits: data cell values inside charts/tables (region/channel names) stay English (`query://` results are language-neutral by invariant), and so do column headers, KPI labels, and KPI notes coming from the DomainPort (e.g. "Total revenue", "Revenue (JPY)", "No target set") — bilingualizing those DomainPort-sourced labels is a future item.
>
> A Spec fixated from EN traffic is not served to JA sessions (they fall through to normal compose). sample-wc still takes `?lang=ja` and switches renderer messages only.

### Dashboard (GUI surface)

In the left panel, you select a **view** (= normalized Intent), and when you change the **filters** (fiscal year, quarter, region, aggregation axis), a GuiAction → normalized Intent → compose runs each time and the screen is assembled.

- The **ProvenanceBadge** at the top tells you "why this screen appeared": tier (L0 = blue / L1 = green / L2 = orange), cache (HIT/MISS/FIXATED), intentHash (click to copy), model, data version.
- "Show Spec JSON" lets you inspect the raw UI Spec. Note that `data` contains only `$ref`.
- The Intent is synced to the URL, so reload, sharing, and "open from chat" all work.
- The **"Add a note" button in the "Records" view** demonstrates the write loop. Opening and closing the confirmation dialog (`overlay.dialog`) is established **by declaration alone** using `$state` + `emit:"state.set"` + `visibleWhen` (with a focus trap and focus return to the invoker), and submitting the note goes `presentForm` → directly to the API (with a capability token, not via the LLM), so **only the table below re-fetches the latest version without swapping the Spec** (small loop). For the steps, see Demo 5.

> **The "Tenant" selector in the top bar** (default / tenant-a / tenant-b) is shared across all pages. The selection rides on every API call as `x-kohaku-tenant`, and the governance/audit plane (Lineage, promotion, fixation) is separated by tenant. The generated result (Spec) is tenant-independent — switching does not change the Dashboard display (the invariant in §6.1: `query://` references are tenant-neutral and do not mix the tenant into the cache key).

> **The "Role" selector in the top bar** (admin / reviewer / approver / viewer) is also shared across all pages. The selection rides on every API call as `x-kohaku-role`, and the server-side declarative RBAC (`createGovernancePolicy`) branches the authorization of governance routes. `admin` permits everything, `reviewer` permits promotion review + Lineage viewing, `approver` permits only issuing approval tokens for governed Actions (Admin › Approvals) plus Lineage / Analytics viewing, and `viewer` permits reading only. **Changing the role re-composes the Dashboard's current view**, because the capability a compose returns is issued to the role that composed it (the requester of every governed action on that page). **Switching to `viewer` (or `reviewer`) makes Admin's approval and deletion operations, and also the "Simulate data update (bump)" button (`admin.bumpDataVersion` — admin only), return 403, and a red error banner appears.** With `admin` (the default), no header is sent and, as before, all operations pass. The role is substituted with a demo header, but in production, resolving it from an authentication foundation (JWT/OIDC, etc.) is a product responsibility.

> **The "☀️ Light / 🌙 Dark" toggle in the top bar** switches the theme mode. The initial value follows the OS's `prefers-color-scheme`, and once you explicitly choose one, it is persisted to `localStorage`. **Parts (the KPI, chart, table, and form that the Spec renders) follow via theme tokens, and the page chrome (header, cards, background, Admin) follows via CSS variables.** The dark palette is measured and adjusted to meet WCAG AA (body text ≥ 4.5:1 / UI ≥ 3:1). In the same mode, the rendering of Web (React) and Web Components (sample-wc) is pixel-identical (§7.2).

### Chat (NLUI surface)

When you ask in natural language, a **normalization chip** (canonical / params / hash) is shown first, and then the screen is synthesized by the same Composition Service. If you ask a question with the same content as on the Dashboard, the hashes match and it becomes `cache:HIT`. The "Open in Dashboard →" link lets you re-experience the identical display.

On slow-generating paths (such as the first time for L1), a loading skeleton appears immediately, and **parts are rendered progressively as they become ready from the LLM's partial output** (progressive streaming — only when the provider supports a native structured-output stream; on the prompt-JSON fallback, it becomes a two-stage skeleton → finalized form).

### Admin (governance plane)

The five tabs below are the published **`@kohaku-ui/admin-react`** console; `apps/sample-web/src/pages/AdminPage.tsx` is a thin wrapper that injects the sample's client (tenant / role headers), theme, dictionary and sales-catalogue draft defaults. See §6 "Embedding the governance console" to drop the same console into your own product.

- **View Lineage**: Event Sourcing of the UI Spec. Every compose / operation / promotion / fixation is visible as an event sequence.
- **Analytics**: An overview aggregated from the raw event sequence (`GET /api/kohaku/analytics/summary`). It displays the fallback rate, tier distribution (L0/L1/L2), cache breakdown (hit/miss/bypass/fixated), latency quantiles (p50/p95/p99), top frequent intents, and the number of promotion/fixation events as a table with inline bars. It states clearly at the top of the screen that **the aggregation is based on a window of the most recent 200 events (default)**, and if the window cap is reached, that note appears too (not a silent cap). Authorization is a read operation (`analytics.read`), so admin/reviewer/approver/viewer can all view it. Two sections are derived from the same window: **Usage by day** (per-day, per-tenant compositions, cache hits/misses, composes served from a fixation, L2 generations that succeeded, LLM tokens and fixation operations; a sample, not a metering source — see "Metering from lineage" in §7) and **Catalog gaps**, which shows where the catalog falls short: the Intents that went to free-form L2 generation (generations that succeeded, and fallbacks; an Intent whose L2 only ever fails shows 0 generated), the schemas reviewers corrected most (grouped by the final component type, with the most-changed fields), and the number of promotion candidates still awaiting action (candidate through schema_proposed, counted with one `GET /promotions?status=` per pending status rather than from the sampled window, shown as "—" when the role may not list promotions (401 / 403), and announced once with a notice for any other failure).
- **Promotion review (L2→L1)**: A candidate list of freely generated parts. Check the HTML source + **"▶ Preview" renders the actual review target itself** (mounting the recorded artifact directly into the same isolated iframe as the chat surface — the identity between the approval target and what is displayed is guaranteed by sha256) → finalize the schema (componentType / intentName / description) → "Approve and register". **The `status` selector at the top lets you filter by state**, and every state — including "All" — is read-only via `GET /promotions?status=`; digging up new candidates is a separate, explicit **"Extract candidates" toolbar button** that calls `POST /promotions/evaluate`. On a candidate card, **"Request changes (send back)" drops it to `changes_requested`**, and after fixing it, **"Re-submit and approve" returns it to candidate and restores it up through publish** (the recovery path from a send-back). In `changes_requested`, no rejection is offered, and abandonment is unified into "withdraw".

  **When the host wires a schema extractor** (sample-api's `index.ts` does by default: `createSchemaExtractor({ llm, timeoutMs })` — set `KOHAKU_PROMOTION_SCHEMA_SUGGEST=0` to disable this wiring entirely, e.g. to shed this LLM spend without shedding compose itself; `KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS` overrides the per-call budget, default 20000ms — §9 of specification.md), a fresh candidate card arrives with the form **prefilled from a machine-extracted proposal** — componentType / intentName / description / props schema / data wiring — labelled with the model and its confidence. Edit anything you disagree with: each field shows *unchanged* or *was: …* against the proposal, and the **"I have reviewed the proposed schema against the preview" checkbox must be ticked before "Approve and register" enables**. Your edits are recorded in lineage (`component.schemaEdited`), and the Analytics tab shows the review turnaround and how many proposals were accepted as-is. If extraction fails, the card falls back to the empty form and the failure is logged (`promotion.suggest.schema`).

  Corrections feed back: when `createSchemaExtractor({ llm, timeoutMs, examples })` is given `examples: schemaEditExamples(storage, { limit: 2 })` (from `@kohaku-ui/lineage`; sample-api wires it), the most recent proposals a reviewer changed are added to the extractor's prompt as "Reviewer-corrected examples" (the final draft, the replaced proposal and the head of the HTML), so later proposals follow the conventions reviewers keep enforcing. The provider reads `SchemaExtractionInput.tenant`: pass the candidate's tenant when you call `extract` and only that tenant's corrections are reused, with no tenant only tenant-less records are (design.md #73). The read has its own budget, `examplesTimeoutMs` (default `min(3000, timeoutMs / 4)` ms): a slow source costs the suggestion its examples, not the suggestion itself. `extractorVersion` is `0.2`.
- **Fixation (L1→L0)**: Candidates from frequent L1 Intents (usage count, structural stability) → "Fixate to L0".
- **Approvals**: the approver's inbox for `"approve"`-tier governed Actions, derived from the Lineage tail (`action.approvalRequested` minus later `action.approved`; Demo 5). **Approve** mints a bearer token (`POST /approvals`) to copy and hand to the requester. Needs `action.approve` and `lineage.read`, i.e. the `admin` or `approver` role.
- "Simulate data update (bump)": Advances the dataVersion to reproduce cache invalidation. `POST /api/kohaku/admin/bump-data-version` sits behind identity + the same governance RBAC as every other Admin action (`admin.bumpDataVersion`, admin only); under `KOHAKU_AUTHZ=jwt` the route itself is disabled unless the server sets `KOHAKU_DEMO_ADMIN_ROUTES=1` (§7), in which case the button's request fails with 404 and a red error banner.
- All five tabs are scoped by the **tenant** selected in the top bar (switching re-fetches each list, and you can see that they are separated per tenant). The Analytics tab's aggregation also targets only the events of the selected tenant.
- Setting the role to `viewer` makes not only the approval/deletion operations but also **the preview of promotion candidates return 403** (because it involves issuing a data read capability; viewing is possible). For the full sequence of RBAC behavior, see Demo 7.

## 4. Demo walkthroughs (8)

### Demo 1 — Same-content request → identical display (R5)

1. Dashboard: "Quarterly Summary" + FY2026 / Q3 / By region → the badge is `L0 cache:MISS`, and intentHash is `13ea0aa…`
2. Chat: "**FY2026 Q3 sales by region as a chart**" (the Japanese "2026年度Q3の地域別売上をグラフで" normalizes the same way) → the normalization chip's hash **matches at `#13ea0aa…`**, and it becomes `cache:HIT`. The chart and table are identical to the Dashboard (same Spec, same renderer, same theme tokens)
3. Admin → View Lineage: the `view.composed` events with the same intentHash line up on both the `web` and `chat` surfaces
4. Admin → bump → re-operate the Dashboard → it returns to `MISS` (cache key = intent + dataVersion)

### Demo 2 — Pass-by-reference (the plumbing and the water)

1. In any view, "Show Spec JSON" → confirm there is not a single number
2. DevTools → Network → the `/binding/resolve` request has `Authorization: Bearer …` and a response of several hundred lines
3. Direct access without a capability is 401:
   ```bash
   node -e "fetch('http://localhost:8787/api/kohaku/binding/resolve?ref=query%3A%2F%2Fsales%2Fsummary%3Ffy%3D2026%26groupBy%3Dregion%26q%3D3').then(r=>console.log(r.status))"
   ```

### Demo 3 — L2 free generation → promotion (the true forte of this framework)

> **There are two paths for a custom part to appear on screen.** A catalog-registered **contribution part** (`CatalogContribution`'s `sales.kpiCard`) appears normally on the screen of a known Intent such as "**List the KPIs**" (`sales.kpi_overview`) (since it merges into the catalog, it becomes an LLM selection candidate even in L1 generation). What this demo demonstrates is the other one: the L2 path where **a part not in the catalog is created on the spot**. The entry condition is that it is "**a visualization request that matches none of the known Intents**" — NL normalization (SemanticPort) falls back to the catch-all Intent `sales.custom`, retains the original request text in `params.request`, and `routeTier` skips L1 and goes straight to L2. "**Show monthly sales as a waterfall chart**" (the Japanese "月次売上をウォーターフォールで見たい" works the same way) similarly enters L2. Conversely, "FY2026 Q3 sales by region as a chart" rides on a known Intent, so it becomes L0/L1 + core parts and does not enter L2.

1. Chat: "**Sales as a calendar heatmap**" (the Japanese "売上をカレンダーヒートマップで" works the same way) → since it is a request not in the catalog, `sales.custom` → **L2 (orange)**. The generated HTML runs in a network-blocked iframe, and data is fetched via the parent bridge (only what passes static lint + **server-side smoke verification** before delivery — executed on jsdom to confirm it reaches ready — arrives, and failures are sent back to the auto-repair loop)
2. Ask the same question again (a different phrasing is fine as long as it normalizes to `sales.custom`) → two uses satisfy the promotion-candidate threshold (demo setting)
3. Admin → Promotion review: on the candidate card, **verify the appearance and behavior with "▶ Preview (rendered in an isolated iframe)"** and check the code with "Generated HTML source" → componentType `sales.calendarHeatmap` / intentName `sales.calendar_heatmap` (**prefilled from the extractor's proposal when the API runs with a real LLM; the heuristic prefill for a heatmap request otherwise**) → tick the acknowledgement → **"Approve and register"** (Preview returns 403 in the `viewer` role — because it involves issuing a data read capability)
   - Behind the scenes, an LLM-as-Judge (7 aspects) → human approval (this click) → schema finalization → publish runs, and each step is recorded in Lineage.
4. Ask the same question in Chat → this time it normalizes to `sales.calendar_heatmap` and is rendered as **L1 (green) + native implementation**. **The promotion persists even if you restart the API**: the snapshot (`apps/sample-api/.data/promotions.json`) is authoritative, and a startup reconcile rebuilds the catalog/Intent projection from it
5. The same "creation" can be triggered from an external chat (MCP) too (→ §5). Uses via `kohaku_compose` are also tallied into the same promotion counter (reflected after the API server restarts — see §5)

### Demo 4 — Interaction loop and fixation

1. In the Quarterly Summary table, click the "Japan" row → `intent.patch` → it switches to the "Japan × by product" view (`view.interacted` in Lineage)
2. Display the "Trend" view (L1) three or more times → Admin → a candidate appears in Fixation (structural stability 100%) → approve → thereafter it is **`L0 cache:FIXATED`** (does not pass through the LLM, structure fixed, data always up to date via pass-by-reference)

### Demo 5 — Write loop (small loop = only the table updates in place)

1. Dashboard: in the left panel, select the **"Records" view** → an **"Add a note" button** appears above the table → pressing it opens a confirmation dialog (`overlay.dialog`) with a note form inside (opening/closing is declaration-only, `state.set` + `visibleWhen`)
2. Enter a note (e.g., "Check North America's growth") → **"Save"**. `annotate` is a `"confirm"`-tier governed action (design.md #62/#63), so a native `window.confirm` prompt appears first (renderer-react's default `confirm` hook — see "Governed actions: tiers" below); accepting it sends a single `/binding/action` (`Authorization: Bearer …`, body `{action:"annotate", confirmed:true, payload:{note, refs}}`)
3. **The Spec is not swapped**, and only the table below re-hits `/binding/resolve` with a new data version (the badge's data version advances). A completion banner at the top of the page
4. The write goes part → directly to the API, and **never flows into the LLM's context** (the generating LLM is the "plumbing," the written data is the "water"). Since the capability returned by compose covers not only read (`$ref`) but also the declared write (`annotate`), it fires without issuing an additional token
5. The same view also has a **"Publish" button**, wired to an `"approve"`-tier action (`publish`). The demo runs the whole approval round trip end to end, and the **requester carries the token** (stateless, design.md #72 — the server keeps no pending store). Use **two browser tabs**: the requester stays in the first, the approver works in a second one. (Up to 0.4.0 the Publish button's action name was dropped by the compose post-processing, so the button never reached the approval gate from the UI; the name now travels in the event payload, `{ action: "publish" }`.)
   1. **Tab 1 (the requester).** Switch the role to **viewer** *first*, then select the "Records" view. The capability that compose issues, and therefore the requester id, belongs to the role that composed (`demo-viewer`); an `admin` approving an `admin`-composed action is refused as a self-approval (`400`). Changing the role re-composes the current view, so the Records view is always composed as whichever role is selected. Press **Publish**. The request goes to the server without a token; the server records `action.approvalRequested` in Lineage (with the payload, because the sample wires `recordPayload: true` — see the risks below) and answers `403 APPROVAL_REQUIRED` (the `"awaitingApproval"` phase), so the renderer shows a status line next to the button ("The action is waiting for approval before it can run (request `<requestId>` · payload `<12 hex digits>`)", overridable through `RendererMessages.actionAwaiting` / `actionAwaitingApprovalDetail`). Note the request id and the payload hash.
   2. **Tab 2 (the approver).** Open the app in a new tab at `/admin`, switch the role to **approver**, and open **Approvals**: the pending request is listed with its action, requester, payload hash and the recorded payload. Press **Approve** → the approval token appears → **Copy**. (The `approver` role holds `action.approve`, `lineage.read` and `analytics.read` only.) Do this in a second tab, not in tab 1: moving to Admin unmounts the Dashboard, and coming back re-composes it and resets the button to idle, losing the "awaiting approval" state the next step relies on. For the same reason do not reload tab 1 afterwards (the selected role is kept in `localStorage`, so a reload would pick up `approver`).
   3. **Back in tab 1** (still the viewer), press **Publish** again → renderer-react's default `requestApproval` hook, now that the action is awaiting approval, opens a `window.prompt` ("Paste the approval token for "publish" …") → paste the token → the write succeeds (`published: 1`), and Lineage gains `action.approved` (`approverId: demo-approver`, `requesterId: demo-viewer`). In tab 2 the row leaves the Approvals list at its next reload (**Refresh**). Cancelling the prompt re-sends without a token, which simply leaves the action awaiting approval.
   - Known limits and risks of this demo: **the token is a bearer secret** (anyone holding it can use it for that exact `(action, payload, requester, tenant)` within its 300 s TTL), and it is **single-use** (this demo wires an in-process `ApprovalStore`, so a used token cannot be replayed: to run the action again the requester presses **Publish** again, which records a new request, and an approver issues a new token — **Re-issue** does the same for a row whose own token has expired); an issued but unused token is **not visible after a reload** (the console keeps it only in the row's local state: copy it, or press **Re-issue** once the 300 s have passed); the inbox is **derived from the Lineage tail** (the last 24 hours, at most 1000 `action.approvalRequested` / `action.approved` events, with a notice when that cap is reached), so a very old request can fall out of it; `recordPayload: true` is **sample-only and a deviation from SPEC LIN-ACT-001** (SHOULD: the audit event carries `payloadHash` but never the payload's field values) — business data lands in Lineage, a PII trade-off, so production keeps the default hash-only recorder and shows the approver the payload from the requester's own system; the `approver` role's `lineage.read` shows that role the **whole event log**; and `window.prompt` is **not available inside a sandboxed iframe** (e.g. an MCP host's widget), where the default quietly degrades to the old behavior (the action stays gated until the product wires its own `requestApproval`)

   A rejected payload (the `"invalid"` phase) is shown the same way as an alert through `RendererMessages.actionInvalid`, on `action.button` and `presentForm` in both renderers. The end-to-end proof that an `"approve"`-tier write actually requires a bound token lives in `apps/sample-api/test/api.e2e.test.ts`, which calls `POST /approvals` as a different principal and replays the resulting token against `POST /binding/action`

#### Governed actions: tiers (`"auto"` / `"confirm"` / `"approve"`)

A `DomainPort` operation may declare `tier` and `paramsSchema` (design.md #62/#63/#64; SPEC §5's ACT-PRM-001/ACT-APR-001/ACT-CNF-001). A payload that fails `paramsSchema` is rejected before the tier is even checked (`422 ACTION_PARAMS_INVALID`, carrying `error.issues`). Above that:

- **`"auto"`** (the default, equivalent to omitting `tier`): invoked immediately, same as before this feature existed.
- **`"confirm"`**: a misclick-prevention gate the same principal satisfies unilaterally. The request must carry `confirmed: true` in the same body, or it is rejected with `403 APPROVAL_REQUIRED`. `renderer-react`'s `useInvokeAction` ships a default `confirm` hook backed by `globalThis.confirm`; `renderer-wc` and `mcp-renderer` require a product-supplied hook (`SurfaceContext.confirm` / `RenderRuntime.confirm`) since there is no framework default outside React.
- **`"approve"`**: a genuine authorization boundary between two principals. The request must carry a bound `approval` token minted by `POST /approvals` (REST) — issued by a principal other than the requester, scoped to the exact `(action, payloadHash, requesterId, tenant)`, and rejected with `403 APPROVAL_REQUIRED` (carrying `error.approval: {requestId, action, tier, payloadHash}`) when missing, expired, mismatched, or (with an `ApprovalStore` configured) already consumed. Approval stays stateless (design.md #72): the **requester carries the token**. An `"approve"`-tier action is always sent to the server first, without a token, so the pending-approval record (and its `requestId` / `payloadHash` descriptor, surfaced in the `"awaitingApproval"` phase and in the status line) exists for an approver; the approver mints a token (the admin console's **Approvals** tab, `@kohaku-ui/admin-react`, derives its inbox from the lineage `action.approvalRequested` events minus the later `action.approved` ones, and calls `POST /approvals`), and the requester presents it on the next attempt. `renderer-react`'s `useInvokeAction` ships a default `requestApproval` hook for that second step — a `globalThis.prompt` asking the requester to paste the token, consulted only once the node is already in the `"awaitingApproval"` phase (a cancelled prompt, or an environment without a usable `prompt` such as SSR or a sandboxed iframe, sends the request without a token as before); pass your own `requestApproval` to replace it. `renderer-wc` has no such default, so a product wires its own hook there; `mcp-renderer` runs on renderer-react, so the default applies in its widgets too (subject to the sandboxed-iframe limit above). The default hook only runs on a surface that carries an Action manifest (the Dashboard passes the compose response's `actions` to `SpecSurface`): on a surface without one, such as Chat, the invoke goes to the server directly and a second press is sent without a token as well. A server-side pending store and an `action.approvalIssued` lineage event (so an issued but unused token could be listed again after a reload) are deliberately left to a later protocol change. **Over MCP, `"approve"` works only for approvals issued without a tenant binding**: `POST /approvals` binds the resolved tenant into the token, the MCP `${prefix}_action` never resolves a tenant, and the tenant comparison is exact — so on a deployment where REST resolves a tenant (`deps.tenant` wired), a REST-issued approval is rejected on MCP (fail-closed; the caller sees "approval token was rejected" and the `action.denied` audit event records "approval is bound to a different tenant"); use the REST `POST /binding/action` for approve-tier writes there. **A host with no `ApprovalPort` configured at all denies every `"approve"`-tier invoke unconditionally** — whether or not the caller even presents a token — with a `403` whose message says so plainly ("no ApprovalPort is configured for this host"), on both REST and MCP; this is deliberately distinct from the missing-token case above (which at least implies a retry could succeed) since no token could ever verify, and `POST /approvals` itself would refuse (with a `501`) to mint one on such a host. **`POST /approvals` also refuses (`501`) on a host that has not wired the `authorizeGovernance` hook**, unlike the other governance routes, which allow every request when it is unwired: issuing an approval is a privileged act, so the host must say which principals may approve (operation kind `action.approve`) rather than let any authenticated principal other than the requester do it (SPEC ACT-APR-001 (e)). The hook receives the action being approved as `operation.action`, so a product can scope approvers per action. A token that was presented but not accepted is answered with the fixed message "approval token was rejected"; the `ApprovalPort`'s own reason (which binding mismatched) is kept in the `action.denied` audit event only. **What the approver sees:** by default the lineage `action.approvalRequested` record and the 403 descriptor carry only `payloadHash`, never the payload, so an approval UI must show the approver the payload itself and recompute `actionPayloadHash` from what it displays before calling `POST /approvals` (otherwise the approver signs a hash they cannot read) — or the deployment enables the recorder's `recordPayload` option so the payload is available from lineage, accepting that the payload's field values (possibly PII) are then stored in lineage and evidence exports (the console's Approvals tab shows a recorded payload and flags one that no longer hashes to the `payloadHash`). `requesterId` for `POST /approvals` is the requester's principal id — the actor of that `action.approvalRequested` record (the 403 descriptor does not carry it).

Every write surface — REST's `POST /binding/action`, MCP's `${prefix}_action`, and the client-side `preflightAction` check `renderer-core` runs before either — enforces the same rules; MCP expresses a gate failure as a structured tool error (`structuredContent.error.code`) rather than an HTTP status. A compose response optionally carries an **Action manifest** (`actions?` on REST, `_meta["kohaku/actions"]` on MCP) mapping each governed action name to `{tier, paramsSchema?, confirmMessage?}` — placed outside the Spec itself, next to the capability, so it never affects `specHash` or the cache key (a schema-only change never forces a fixation-breaking Spec change). A host that records action outcomes to lineage does so under a distinct `action.*` event family (`action.invoked` / `action.denied` / `action.approvalRequested` / `action.approved`), carrying `payloadHash` and, by default, never the payload's own field values (SPEC LIN-ACT-001; a host can opt in with the recorder's `recordPayload` option, which the sample does for the Approvals demo — a sample-only deviation).

### Demo 6 — Tenant separation (governance plane)

1. Switch the **tenant** in the top bar to `tenant-a`
2. Operate the Dashboard / Chat a few times → Admin → View Lineage: only the `tenant-a` entries line up
3. Switch the tenant to `tenant-b` → the same Admin tab becomes **empty** (or a different set) = promotion candidates, fixations, and Lineage are separated by tenant
4. Returning to `default` (unspecified) shows all entries as before (no header = equivalent to a single tenant). **The Dashboard display itself does not change with the switch** — what is separated is the audit/governance, not the generated result (the compose cache is tenant-independent)

### Demo 7 — Role-based governance authorization (RBAC)

1. Leaving it as `admin` (default), Admin → display candidates in Promotion review (the state where the "Approve and register" button appears)
2. Switch the **role** in the top bar to `viewer` (the candidate list is retained at this point)
3. **Press "Approve and register" → a red 403 error banner** ("The current role is not permitted to 'approve promotions'"). The Fixation tab's "Fixate to L0" and "Unfixate" likewise return 403
4. **View Lineage can be viewed even as `viewer`** (reading is permitted). Switching to `reviewer` lets promotion operations pass, but deletion of a fixation returns 403 (out of scope)
5. Returning to `admin` lets all operations pass. Authorization is decided by the server-side declarative policy (`createGovernancePolicy`), and a denial is returned as 403 `CAPABILITY_DENIED` (the client distinguishes it via `KohakuHostError.code` in `@kohaku-ui/client`)

### Demo 8 — Two-way binding (cross-filter = in-client re-resolve without compose)

1. Dashboard: in "Quarterly Summary", select **Group by = By product** and **Region = Japan** → since these are facet operations in the left panel, **compose runs only once here** (`/compose`), and a Spec with a region switch (`control.select` + `data.bind`) is returned
2. Switch the **"Region" selector** that appears within the screen to "Europe", "APAC", etc. → **the chart and table instantly change to the by-product breakdown of a different region**
3. If you look at DevTools → Network, for this in-screen selector operation **not a single `/compose` is sent — only `/binding/resolve`** runs with the new region's effective ref (`…&region=europe`, etc.). The state (`$state.region`) is closed within the Renderer and not sent to the server
4. How it works: `data.bind` swaps the `region` parameter of `$ref` with `$state.region` and re-resolves in the client (the Spec is immutable = zero re-composition). Since the capability issued by compose covers all variants of `values` (the region enum) in read scope, switching to any region is authorized. **A region outside the enumeration (a forgery) returns 403 + `REF_NOT_FOUND`**, so the client cannot slip past authorization with an arbitrary filter (the no-forgery rule in §5)
5. "Show Spec JSON" lets you check the initial value of `state.region`, `components[].data.bind`, and the options of `control.select` (the left-panel facet compose path still remains as before, and you can also change the region via a compose round-trip — the difference between the two is the highlight)

### When you want to reset

```bash
trash apps/sample-api/.data   # initialize promotions, fixations, and Lineage (use rm -rf if using rm)
```

## 5. Using it from an external chat (MCP)

You can deliver the same Spec and the same rendering code as the Web to MCP Apps-capable hosts. However, **the connection and rendering path splits into three depending on the host's UI-rendering support**.

**Fastest path, from a data file:** `npx @kohaku-ui/cli init --mcp --from data.csv --out app` generates a project with both a REST front door and this MCP front door (stdio + Streamable HTTP servers, wired onto `@kohaku-ui/mcp-renderer`'s pre-built core renderer -- no build step of your own), plus a `claude_desktop_config.example.json`; `npm --prefix app run mcp:claude-desktop` registers it with Claude Desktop (backing up its existing config to `.bak` first). Restart Claude Desktop and you are done -- see [docs/paths/mcp-apps.md](paths/mcp-apps.md) for the walkthrough. The rest of this section documents the reference wiring (`apps/sample-mcp`) that pattern is built from.

### Host support table

| Host | Connection method | Rendering |
|---|---|---|
| **Claude Desktop** | Local stdio (`start`) | Same rendering as Web via MCP Apps (iframe) |
| **claude.ai / ChatGPT** | Streamable HTTP (`start:http`) + remote connector via a public tunnel | Same rendering as Web via MCP Apps (iframe). ChatGPT requires enabling **developer mode**. In ChatGPT, on re-open, the previous view is instantly restored from widgetState. On fullscreen-capable hosts, a fullscreen toggle appears at the top right of the widget |
| **Terminals such as Claude Code / Codex CLI** | Local stdio / Streamable HTTP | iframe rendering is not possible → received via the **self-contained HTML** of `kohaku_render_snapshot` |
| **mcp-ui legacy hosts (LibreChat / Smithery / Nanobot, etc.)** | stdio / Streamable HTTP + `KOHAKU_MCP_LEGACY_UI=1` | Even without SEP-1865 support, statically renders the `ui://` UIResource (self-contained snapshot) attached to the tool result. Because it becomes **about 1 MB per result**, do not enable it on modern hosts (Claude / ChatGPT) |

On any path, build the shared renderer in advance for UI display (both iframe rendering and the snapshot use the same bundle). This sample bakes its own sales-domain component implementations into that build (`apps/sample-mcp/renderer/main.tsx`, a thin call to `@kohaku-ui/mcp-renderer/boot`'s `bootMcpRenderer`); a project generated by `kohaku init --mcp` needs no build step at all here, since it wires `@kohaku-ui/mcp-renderer`'s pre-built, dependency-free core bundle (`loadRendererHtml`) directly.

```bash
pnpm --filter @kohaku-ui-sample/mcp build:renderer    # self-contained build of the shared renderer
```

**Exposed tools** (the same on either the stdio or HTTP entry):

- `kohaku_compose` (model-visible, natural language) and the typed tool group auto-generated from the Intent catalog (`sales_quarterly_summary` / `sales_trend` / `sales_kpi_overview`, etc.). The canonical name (`sales.quarterly_summary`) is normalized to the MCP naming constraint (→ `sales_quarterly_summary`). The typed tools are generated by `intentToolsFromCatalog(intentCatalog.list())` (the Zod params → inputSchema conversion is done by the SDK). Promotions are static at startup: an Intent promoted on the REST plane after the MCP starts merges into the tool group on this MCP process's restart.
- **Display language**: every UI-producing tool additionally accepts an optional `locale` argument (e.g. `"ja"`). The tool description tells the calling LLM to set it to the user's conversation language, so a Japanese conversation on claude.ai / ChatGPT automatically gets Japanese titles and labels in the composed UI (fixed specs, L1/L2 generation — the same per-session output-language mechanism as the Web's EN/JA toggle; caches are separated per language server-side). Omitted = English.
- `kohaku_render_snapshot` (model-visible) — generates self-contained HTML for terminal hosts (described below).
- `kohaku_resolve_binding` / `kohaku_event` / `kohaku_action` (**app-only**; called only from the iframe). Data fetching, events, and writes go through this path, and **bulk data does not flow into the model's context**. `kohaku_action` (`{action, payload?, capability}` → `{result, invalidates?, refVersions?}`) is the direct write path for presentForm submit / action.button, symmetric with REST's `POST /binding/action` (Demo 5). It verifies a write-scope (`{kind:"write", ref:action}`) capability, and a denial is returned as a tool error (`invalidates` / `refVersions` ride only when the side-effect declaration is wired; if unwired, only `{result}`).
- Every tool result comes with a text summary readable on UI-incapable hosts (`content[0]`) (the fallback-mandatory philosophy).
- Operations inside the widget (facet changes, writes) go via app-only tools and are invisible to the model, but after the operation, **only the summary text of the current view** is fed back to the model via `ui/update-model-context` (only on capable hosts; bulk data does not flow) — the model can continue the conversation while knowing "what the user currently sees".
- **The widget follows the host's theme**: on a host that provides `hostContext.theme` (light/dark) and/or `hostContext.styles.variables` (the host's standard `--color-*` CSS variables), the widget picks the matching kohaku default theme and overlays any recognized host style variables onto it — no configuration needed. On a host that provides neither, the widget falls back to kohaku's default light theme.
- Persistence is shared with the Web (`sample-api/.data`), but each process loads it at startup and there is **no live cross-process propagation**: parts promoted on the Web are used on the MCP side from this MCP process's next restart (the promotions note above), and likewise the running API server picks up MCP-side lineage on its own next restart.

### Claude Desktop / terminal (local stdio)

```bash
claude mcp add kohaku-sales -- pnpm --dir <absolute path>/apps/sample-mcp start
```

Claude Desktop renders the same as the Web in an iframe. A terminal host like Claude Code cannot draw an iframe, so use `kohaku_render_snapshot` (described below).

⚠️ With `KOHAKU_AUTHZ=jwt`, only the Streamable HTTP profile (below) can authenticate: it derives the caller's principal from the HTTP request's own bearer token. The stdio profile has no transport-level place to carry one, so under `jwt` every stdio tool call fails closed (a structured tool error). Use `KOHAKU_AUTHZ=hmac` (the default) for stdio.

### claude.ai / ChatGPT (Streamable HTTP + public tunnel)

claude.ai / ChatGPT cannot connect to local stdio and can only connect via a **remote MCP connector (Streamable HTTP)**. Start the HTTP entry, expose the URL with a public tunnel, and register it with the connector.

```bash
pnpm --filter @kohaku-ui-sample/mcp start:http        # listens on the default :8788 (path is /mcp)
# To use a different port: KOHAKU_MCP_HTTP_PORT=9000 pnpm --filter @kohaku-ui-sample/mcp start:http
cloudflared tunnel --url http://localhost:8788      # open a public tunnel in a separate terminal (ngrok, etc. also work)
```

The server validates the `Host` and `Origin` headers (DNS-rebinding / CSRF protection), and only `localhost` / `127.0.0.1` / `[::1]` pass by default. A tunnel changes the Host to its own domain, so start the server with that hostname added, once the tunnel has printed it:

```bash
KOHAKU_MCP_PUBLIC_URL=https://<random>.trycloudflare.com \
KOHAKU_MCP_ALLOWED_HOSTS=<random>.trycloudflare.com \
  pnpm --filter @kohaku-ui-sample/mcp start:http
```

Register the URL — the `https://<random>.trycloudflare.com` the tunnel hands out with `/mcp` appended — with the host's custom connector (claude.ai) / MCP server (ChatGPT's developer mode). `KOHAKU_MCP_ALLOWED_ORIGINS` (comma-separated hostnames, no scheme or port) additionally allows a browser-based caller's origin; a request with no `Origin` (the connectors' own server-side calls, Claude Desktop) needs nothing.

> ⚠️ **This is a no-auth demo.** This HTTP entry has no authentication whatsoever. Once exposed via a public tunnel, **anyone who knows the URL can view and operate the sales data**. Hand the URL only to trusted parties, and do not put sensitive data on it. When you stop it, close the tunnel too. DNS rebinding protection, which rejects Host spoofing and cross-site requests from a browser, is on by default (Host and Origin must be a localhost name unless you list more with `KOHAKU_MCP_ALLOWED_HOSTS` / `KOHAKU_MCP_ALLOWED_ORIGINS`, as above; the CORS response echoes only a validated Origin, never `*`); the older `KOHAKU_MCP_HTTP_ALLOWED_HOSTS` still works as a deprecated alias of `KOHAKU_MCP_ALLOWED_HOSTS`. The Python sample (`sales_api.mcp_http`) behaves the same.
>
> To wire real authentication, resolve the caller's identity per tool call via `McpHostDeps.resolvePrincipal` (TS) / `resolve_principal` (Python) — e.g. reading a bearer token off the request and looking up the corresponding `Principal` — rather than a single static `McpHostDeps.principal`, since every connection on a shared HTTP server shares one `McpHostDeps` and a static `principal` would give every caller the same identity.

### For terminal hosts: `kohaku_render_snapshot` (self-contained snapshot)

On hosts that cannot draw an iframe (Claude Code / Codex CLI, etc.), passing a natural-language question to `kohaku_render_snapshot` generates **self-contained HTML that renders with the same shared renderer as the Web**. Since the UI Spec and resolved data are embedded in a single file, no external communication is needed, and the path to the generated artifact is returned (the HTML body is not placed in the model's context because it is about 1 MB).

- Usage: either **open the file at the returned path directly in a browser**, or **publish it as an Artifact** to use for display. If the model builds its own UI from the tool result, the rendering diverges from the Web, so the point is to use the generated HTML as is.
- The artifacts are consolidated under `sample-api/.data/snapshots/snapshot-<intentHash>.html` (the same display is the same file).
- **It is a static snapshot**: since it renders with the embedded Spec + resolved data, **re-fetch and re-composition events from operating parts are disabled** (no-op). Do interaction-based checks on an iframe-capable host or on the Web surface.

### Conditions under which "same Spec → same rendering" holds

**Pixel-identical rendering** by the same renderer for a same-content request → same Spec as the Web holds when the host **supports MCP Apps (SEP-1865, finalized 2026-01-26)**. On unsupported hosts, the `_meta` UI declaration is ignored and a degradation can occur where the model draws **its own UI from the tool result**. The catch for that degradation is `kohaku_render_snapshot` (delivers the same rendering as the Web in a single file regardless of the host's UI support).

The UI declaration `_meta` is written in **both** modern (nested `_meta.ui.{resourceUri,visibility}`) and legacy (flat `_meta["ui/resourceUri"]` / `_meta["ui/visibility"]`) forms, so it is recognized as a UI tool by hosts that look at either format (ChatGPT, etc. look at modern first).

### Troubleshooting when nothing renders

Even when the protocol is correct, there are reported cases where the iframe does not render due to **host-side UI rollout restrictions** (modelcontextprotocol/ext-apps issue #671). To distinguish "the server is correct but the host does not draw" from "the server's declaration is wrong":

1. Connect with an MCP inspector such as **MCPJam inspector** and check whether the `ui://kohaku/renderer.html` resource is returned as `text/html;profile=mcp-app` and whether each tool's `_meta` carries a UI declaration (modern + legacy). If it is correct up to here, server-side conformance is established (= the host-side rollout restriction is the suspect).
2. When the host does not draw an iframe, fall back to `kohaku_render_snapshot` (it can be displayed regardless of the host's UI support).

The server's protocol conformance (resource MIME / `_meta`'s modern+legacy / text fallback) is automatically verified by `pnpm vitest run --project host-mcp-apps`. Actual rendering on a host is a manual check.

### Asymmetry of custom parts (L2)

- **The "creation" of a custom part (L2 free generation) can be triggered from MCP too**: asking an MCP host something like "**Show me sales as a calendar heatmap**" (the Japanese "売上をカレンダーヒートマップで見せて" works the same way) calls `kohaku_compose` (or `kohaku_render_snapshot`), and with the same NL normalization as the Web's Chat, it enters `sales.custom` → L2. Usage is appended to the same lineage store (shared persistence), but the API server tallies the lineage loaded at its own startup plus its own process's events — an MCP-side use becomes visible to the promotion counter after the API server restarts. After that restart, one use each from MCP and Web reaches the demo threshold (2 uses), and a candidate lines up in Admin's promotion review (from there it is the same as Demo 3, steps 3–4).
- **However, there is an asymmetry in displaying custom parts**: the shared renderer (`apps/sample-mcp/renderer/main.tsx`) registers the core parts plus the sample's own sales-domain implementations (`registerSalesImpls`, so `sales.kpiCard` / `sales.calendarHeatmap` do render), but does not inject the sandbox renderer (`renderSandbox`). Therefore, on the MCP side, an L2-generated part becomes a "the sandbox renderer needs to be injected" notice, and any contribution/promotion part whose implementation is not baked into that renderer build becomes an "unimplemented part type" notice (since sample-mcp does not declare `SurfaceCapabilities`, the server-side degradation to fallback〈negotiate〉 does not run either). For the full display of custom parts (sandbox iframe, native implementation), check on the Web surface.

## 6. Embedding it into your own product

If you have not yet, pick one of the three one-page starts in ["Choose your path"](#choose-your-path) — they are the short form of the steps below, each with a compilable first snippet. This section is the long form, in the order of the adoption ladder.

You can adopt it in stages along the adoption ladder (design doc §12 "Design of the sample implementation").

**Dependency method**: `@kohaku-ui/*` packages are published to npm. In a standalone app, `npm install @kohaku-ui/host @kohaku-ui/llm @ai-sdk/anthropic zod` (`@kohaku-ui/host`'s `createKohakuHost()` is the one-call facade over `@kohaku-ui/host-rest` — see below; its `@kohaku-ui/host/mcp` subpath additionally needs `@kohaku-ui/host-mcp-apps` and `@modelcontextprotocol/server`, both optional peers not installed by the command above — see [Path (a)](paths/mcp-apps.md); `@ai-sdk/anthropic` is the provider SDK for Claude — an optional peer dependency of `@kohaku-ui/llm`; swap it for `@ai-sdk/openai` / `@ai-sdk/google` / `@ai-sdk/openai-compatible` depending on the provider you configure) (add `@kohaku-ui/composer`, `@kohaku-ui/renderer-react react react-dom`, etc. as you reach the later steps below) and import them normally — each package's `publishConfig` points `exports` at its `dist` build, so this works outside the monorepo with no extra setup.

If you are instead building your app **inside this monorepo** (e.g. to contribute back, or to iterate against `src` without a publish step), add it under `apps/<your-app>`, reference the packages as `workspace:*` in its `package.json`, and run it with `tsx` (packages export `.ts` directly in that case — there is no `dist` build to consume from outside the workspace). The generated `server.ts` below assumes the npm-install path; swap the comment's dependency line for `workspace:*` if you took the monorepo path instead.

### Zero-Port quickstart (from your own data, no Port code)

```bash
mkdir my-app && cd my-app
npx @kohaku-ui/cli init --from ../sales.csv     # or a .json array / a .sqlite file (Node >= 22.13 for SQLite)
npm run dev                                      # API :8787 + web :5173
```

`init` reads the file, infers which columns are categories (→ vocabularies), measures (→ metrics) and time (→ granularity), and generates a project that only depends on the published `@kohaku-ui/*` packages: a DomainPort over the data (sum / avg / count × group by × time window; `describeShape` exposes column metadata only — rows never enter the model), an Intent catalog (`defineVocabulary` / `defineIntent`), an L0 fixed Spec for `<source>.summary`, a Dashboard + Chat web app and a golden regression test — all wired together with `@kohaku-ui/host`'s `createKohakuHost()` (design doc #52), which supplies the SemanticPort (`@kohaku-ui/semantic-llm`), storage (`@kohaku-ui/storage-memory`) and capability tokens (`@kohaku-ui/authz-hmac`) as defaults.

`init` also writes a `.env` with a freshly generated capability secret, so add only a provider key to it — never copy `.env.example` over it. `npm run dev` runs in development mode (one startup warning line instead of the two production warnings about the unwired `auth` / `authorizeGovernance`); the generated README's "Before production" section lists what to wire first (see §7 "Development mode and the production warnings"). The **Summary** view renders with no LLM configured; set a provider in `.env` for Chat and the L1 views.

After `npm install`, `init` runs the generated golden test once in update mode (deterministic, no LLM) to write the fixture's `expected`, so `npm test` is green from the start. If that step fails, `init` still succeeds and prints the one command to run by hand (`KOHAKU_GOLDEN_UPDATE=1 npm test`); `--no-install` skips it.

Chat answers only within the generated Intent catalog and returns `NO_MATCH` for anything outside it (widen it by passing `fallbackIntent` — an Intent name in your catalog that takes a `request` param — to `createKohakuHost` in `server/ports.ts`). Everything generated is a starting point — the DomainPort remains your product's responsibility (design doc §2), and each file says what else to replace (`createKohakuHost`'s other defaults included).

No data at hand? Try [`cli/test/init/fixtures/sales.csv`](../cli/test/init/fixtures/sales.csv).

**Recognized date formats**: only a year-first date is treated as unambiguous and becomes the time column — `YYYY-MM-DD`, `YYYY-MM`, or the same with `/` separators, zero-padded or not (`2026-04-01`, `2026-4-1`, `2026/4`). A day/month-first date such as US `MM/DD/YYYY` or European `DD/MM/YYYY` is deliberately **not** guessed — the two are indistinguishable for any day of the month ≤ 12, and guessing wrong would silently mis-date rows, which is worse than no chart at all. If your data has one of these, `init`'s summary prints a warning naming the column; convert it to `YYYY-MM-DD` and run `init` again to get a time column and a Trend view.

**Measuring "time to first compose"** (the quickstart's KPI, target ≤ 15 minutes): start a stopwatch before `npx @kohaku-ui/cli init`, stop it when the Dashboard shows the Summary view (L0) and, with a key configured, when the first Chat answer renders (L1). Record both on a clean machine with a warm npm cache; the CI `pack-smoke` job runs the same generation end to end (`scripts/pack-smoke.mjs`, step 7b).

### Step 0 — Server-Driven UI without an LLM

```bash
npx @kohaku-ui/cli scaffold ports --out ./my-app/kohaku
```

Implement the one Port `createKohakuHost()` (`@kohaku-ui/host`) does not default for you, in the generated `ports.ts`, and your Intent catalog in `intents.ts`:

1. **DomainPort** (yours — no default exists): implement aggregation queries as `op` (returning TabularData is recommended). Pass it as `createKohakuHost({ domain, ... })`.

The other three Ports have working defaults; override any of them by passing your own once you outgrow the default:

2. **SemanticPort** (default: `@kohaku-ui/semantic-llm`'s `createLlmSemanticPort`, built from `intents.ts` + `dataVersion`/`describeShape`): `normalize` is only the deterministic mapping of GUI operations; `resolveQuery` is Intent → a `query://` handle. Pass your own as `createKohakuHost({ semantic, ... })` — `intents` / `dataVersion` / `describeShape` are then ignored.
3. **AuthzPort** (default: `@kohaku-ui/authz-hmac`'s `createHmacAuthzPort(secret)`, `secret` resolved from `capabilitySecret` or the `KOHAKU_CAPABILITY_SECRET` environment variable). For a JWT / OIDC deployment, pass `authz: createJwtAuthzPort({ key: { jwksUrl }, issuer, audience, capabilitySecret })` (`@kohaku-ui/authz-jwt`) instead — it keeps the same capability tokens and adds `identity.fromAuthorizationHeader(...)`, which resolves `Principal` (id / name / roles) and the tenant from the token's claims for your `KohakuHostDeps.auth` / `tenant` hooks — pass those as `createKohakuHost({ routes: { auth, tenant } })`, and MCP's `resolvePrincipal` as `attachKohakuMcp(server, host, { deps: { resolvePrincipal }, ... })` (see §7 "Production adapters"). `routes` accepts every other `KohakuHostDeps` field too (`approvals`, `actionEffects`, `rateLimiter`, `authorizeGovernance`, …); the facade already wires `recorder` and `actionAuditRecorder` (lineage over its own storage; `false` disables either) and `onError` for you. It also accepts `observer` (an extra `ComposeObserver`, e.g. `createOtelComposeObserver(...)`, combined with the console reporter through `composeObservers`) and `policyFor` (e.g. a Policy as Code runtime's `policyFor`). The governance fields you pass in `routes` (`approvals`, `rateLimiter`, `actionEffects`, `onRateLimited`) are exposed as `host.governance`, and `attachKohakuMcp` uses them as its defaults, so one rate limit or approval port applies to REST and MCP alike (`deps` overrides; an approval token issued with a tenant binding is still rejected on MCP, which resolves no tenant). Without your own `onRateLimited`, a rate-limited request logs one line through the console error reporter.
4. **StoragePort** (default: `@kohaku-ui/storage-memory`'s `createMemoryStoragePort()`). For more than one host instance, pass `storage: createRedisStoragePort(...)` / `createPostgresStoragePort(...)` (`@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres`) so the Spec cache is shared (§7).

If you register fixed Spec templates (the sample is `apps/sample-api/src/intents/fixed-specs.ts`) in `createKohakuHost`'s `policy.fixedSpecs` option, a Server-Driven UI via renderer-react works **without an LLM** actually being called — `llm` is still a required argument (`createKohakuHost` never defaults it), but nothing invokes it as long as every Intent you compose resolves through `fixedSpecs`.

### Step 1 — L1 declarative synthesis and chat

- **Define the Intent catalog in a single place (`@kohaku-ui/intents`)**: with `defineIntent`, make it 1 Intent = 1 definition (sample: `apps/sample-api/src/intents/catalog.ts`). Unify value sets into a single source with `defineVocabulary("region", { japan: "Japan", north_america: "North America", ... })`, and when you declare `params` (Zod) / `examples` (NL example sentences) / `facets` (params to expose to the GUI) / `queries` (a template or callback), the same definition derives `.toIntentDef()` (for SemanticPort), `.toFacetView()` (GUI facet), `.toToolSource()` (MCP tool), and `.parseParams()` (coerce + default). The facets to expose to the GUI are written out to `facet-views.json` by codegen (`pnpm intents:emit`), and the web imports it as data (the web stays independent of server code).
- `@kohaku-ui/semantic-llm`'s `createLlmSemanticPort` is the default (the sample wires its sales rules through `rules` / `fallbackIntent`; `apps/sample-api/src/ports/semantic-port.ts`)
- Implementing `describeShape` makes the deterministic post-processing of chart-type rules and default sorting take effect
- Implementing `validateIntent` (optional) makes a directly-specified Intent (`POST /compose`'s `{intent}` body, `/events`, fixation approval, and the MCP profile's compose-family tools / `kohaku_event`) get rejected with 422 `INTENT_INVALID` on an unknown canonical or invalid params, instead of reaching `finalizeIntent` unchecked — `@kohaku-ui/semantic-llm`'s default port already implements it; a hand-written `SemanticPort` that omits it keeps a directly-specified Intent unvalidated (see design.md decision #51)
- Contribute domain parts with `CatalogContribution` (`defineComponent` + the renderer implementation's `registry.register`)

### Step 2 — L2, promotion, and fixation (complete form)

- `policy.allowL2: true` + a catch-all Intent (`*.custom`) + `routeTier`
- Inject `createLineage` / `createPromotions` (implement the reflection into the catalog and Intent in `onPublish`) / `createFixations` into host-rest's deps
- Adjust the promotion threshold and the judge's passing score via policy (human review cannot be removed)

### Applying a design system to L2

A four-step set (the third of which is optional: bring your own design kit) for making your product's design system take effect on L2 free generation (custom components). The generated artifact is written not with hardcoded colors but with token references `var(--kohaku-*)`, and the values are injected at render time, so it **follows light/dark switching and brand changes without regeneration**.

1. **Define the design system and wire it to the compose policy** (sample: `apps/sample-api/src/design-system.ts`):

```ts
import { DEFAULT_KIT_VOCABULARY, type DesignSystemGuide } from "@kohaku-ui/composer";

const designSystem: DesignSystemGuide = {
  // custom tokens added to the default token vocabulary (the full KnownThemeTokens), and description overrides (optional)
  tokens: { "brand.accent": "accent color (badges, highlights)" },
  // the design kit vocabulary (kit classes + utilities the model composes with); the built-in kit
  // shown here, or bring your own — see step 3
  kit: DEFAULT_KIT_VOCABULARY,
  // natural-language style rules (typography, spacing, tone, etc.) — never a concrete value (a color, a
  // px number); values belong only in tokens/kit, see apps/sample-api/src/design-system.ts
  guidelines: [
    "Style table header rows with the k-table class (muted header on the surface color).",
    "When indicating increases/decreases, use k-kpi-delta with is-up / is-down (or var(--kohaku-color-positive) / var(--kohaku-color-negative)) and also show a symbol like ▲▼ (do not rely on color alone).",
  ],
  // lint send-back for hardcoded colors (default true; set false if repair does not converge on a small model)
  // enforceTokenColors: false,
};

const policy = {
  allowL2: true,
  designSystem,
  // toggling designSystem on/off or changing its content changes the prompt content → always advance the version (generational separation of the cache)
  generatorVersion: `${defaultGeneratorVersion(llm)}/ds1`,
};
```

2. **Pass the theme to the renderer** (supplying the values; for a custom token, put a value into the theme under the same name):

```tsx
// React: pass theme to SandboxFrame (see sample-web's SpecSurface)
<SandboxFrame node={node} spec={spec} theme={buildTheme(mode)} bridge={bridge} />
// WC: just set it on <kohaku-surface>'s context.theme (or the theme property)
```

3. **(Optional) Bring your own kit**: pass your vocabulary as `designSystem.kit` (`{ id, version, classes, utilities, namespaces }`) and your stylesheet as `kit` (a `DesignKitStylesheet` — `{ id, version, css }` — passed to the `SandboxFrame` prop / `mountSandbox`'s option / `context.sandbox.kit` on `<kohaku-surface>`; the older `kitCss: string` option still works and is not going away, but carries no version identity — see "Detecting a stale kit" below). The class names in `classes`/`utilities` and the class names your CSS actually defines selectors for must match **one-to-one** in both directions: a vocabulary class with no matching CSS selector renders unstyled (the model was told it exists but nothing draws it), and a CSS class the vocabulary never lists cannot be caught by the `L2_UNKNOWN_CLASS` lint (the lint only ever checks what the model wrote against the vocabulary, never the CSS). `namespaces` are the prefixes (`"k-"`, `"gap-"`, …) the lint treats as "this looks like a kit class" — a class starting with one of them but absent from `classes`/`utilities` is sent back for repair; a class outside every namespace is always ignored by the lint, kit or not. Also supply `skeleton` (a body fragment using your own classes) — without it, no Skeleton section appears in the prompt at all (the built-in kit's own skeleton, written in `k-*` class names your kit may not define, never leaks through: `designKitPromptFragment` only ever shows a kit's own declared `skeleton`, with no fallback to the built-in one). `packages/sandbox/test/design-kit-contract.test.ts` is the template for pinning your own vocabulary/CSS pair the same way the built-in kit pins itself. Write the CSS so every colour is a `var(--kohaku-color-*)` reference, `currentColor`, or the keyword `transparent` — no raw colour values. Dimensions should be tokens too, except for deliberate literals like the built-in kit's own (hairline 1px borders, the 2px focus ring, the 480px grid breakpoint, SVG chart geometry); layout and effects such as `display:flex`, `color-mix()`, and `filter` are unrestricted — the shipped kit uses all three. Brand web fonts can be embedded as `@font-face` data URIs. An empty CSS string (`kit: ""` or `kitCss: ""`) disables the built-in kit entirely. Bump `version` (and `generatorVersion`) when class semantics change.

4. **Verify**: L2 generation (e.g., a free-form request in chat) → if the generated HTML uses `var(--kohaku-color-*)` and the header's theme switch makes the custom component's palette follow, it is OK. If hardcoded colors slip in, they are automatically retried for repair as `L2_RAW_COLOR`; an unrecognized kit-namespaced class name is retried the same way as `L2_UNKNOWN_CLASS`.

Even without specifying a theme, a default light theme is always injected into the sandbox, so `var()` never falls to undefined. The Python implementation (`python/kohaku`) has the same feature too (`ComposePolicy(designSystem=DesignSystemGuide(...))`) (sample: `python/examples/sales-api/src/sales_api/design_system.py`). Python has no sandbox runtime, so everything below this point (the `kit` receiver, the mismatch check, the rollback resolver) is TS-only; the Python side's contribution is stamping `provenance.generatorVersion` / `provenance.kit` on the composed Spec (see below), which a TS-hosted sandbox still reads the same way.

**Detecting a stale kit (SPEC-KIT-001)**: composer stamps the *composed* Spec's `provenance.generatorVersion` / `provenance.kit` (`{id, version}`) from `ComposePolicy.generatorVersion` / `designSystem.kit` whenever either is set — on every tier, and preserved as-is through a cache hit or an L1→L0 fixation (a fixated Spec keeps reporting the kit it was pinned under, not whatever the policy says today). Passing a versioned `kit` (the `DesignKitStylesheet` form, not a bare string) lets the sandbox compare its own `id`/`version` against the Spec's own `provenance.kit`: on a mismatch it reports `bridge.onTelemetry({ componentId, kind: "kit-mismatch", detail })` but **still renders** (fail-open — a stale kit is unstyled or subtly-wrong markup, not a security fault, so this is an observability signal, not a block). Wire `onTelemetry` to your own logging/metrics to catch a rollout where the render-side kit and the compose-side vocabulary have drifted apart.

**Rolling a kit change back per artifact (M-2)**: `kit` also accepts a **resolver**, `(node, spec) => DesignKitStylesheet | string | undefined`, called with that node's own `ComponentNode`/`UISpec` — `SandboxFrame`'s prop on React, `context.sandbox.kit` on `<kohaku-surface>` (WC; both renderers offer the same hook). Reading `spec.provenance.kit` inside the resolver lets a host pick the CSS matching *each artifact's own* compose-time kit, rather than one CSS for the whole surface:

```tsx
<SandboxFrame
  node={node}
  spec={spec}
  bridge={bridge}
  kit={(node, spec) =>
    spec.provenance.kit?.version === "1" ? { id: "acme", version: "1", css: KIT_V1_CSS } : KIT_V2_CSS
  }
/>
```

Before this hook existed, the only rollback lever was `kitCss: ""` (or reverting the whole surface's `kitCss` string), which is all-or-nothing: silencing a regression in newly generated v2 artifacts also strips styling from every v1 artifact already cached, fixated, or promoted, and getting v1 artifacts their styling back means every v2 artifact loses it in turn. A resolver keyed on `provenance.kit` instead serves each artifact the stylesheet it was actually written against, so a rollback of the surface-wide default does not force a choice between the two.

**Upgrade note**: the built-in kit's CSS is injected into every sandbox mount, including artifacts already in the compose cache, already fixated, and already promoted into a catalog — an empty CSS string (`kit: ""` / `kitCss: ""`, the `SandboxFrame` prop / `mountSandbox`'s option / `<kohaku-surface>`'s `context.sandbox.kit`) is the per-surface opt-out if that shift in already-generated artifacts is not wanted, and the resolver form above is the finer-grained alternative once `designSystem.kit` is versioned.

To eyeball the kit without an LLM, the sample app's Admin → Gallery tab (`apps/sample-web/src/pages/admin/GalleryTab.tsx`) renders a hand-written showcase artifact (`gallery-showcase.ts`) through the real `SandboxFrame`, exercising every kit class; a checkbox toggles the kit on and off, re-mounting the preview so the difference can be compared, and a paste box below it previews any generated L2 artifact the same way. It follows the app header's light/dark setting, and since its data is canned fixtures, the tab needs neither the API nor a model.

### Calling it from a client (the typed host client SDK)

When calling the REST host from the frontend (or Node), using `@kohaku-ui/client` instead of hand-written fetch lets you handle responses (`{spec, capability}`, etc.) and error codes in a typed way. `fetch` is a transport DI, and in tests it can be swapped for an in-memory host (works in both browser and Node).

```ts
import { createKohakuClient, isKohakuHostError } from "@kohaku-ui/client";

const client = createKohakuClient({
  baseUrl: "/api/kohaku",
  // extra headers that ride on every request (the multi-tenant x-kohaku-tenant, etc.); it is a function, so it is evaluated each time.
  headers: () => ({ "x-kohaku-tenant": currentTenant() }),
  // transport?: DI for fetch (defaults to global fetch when omitted; in tests, inject app.request)
});

// synthesis (deterministic path). The response is { spec: UISpec, capability: string }.
const { spec, capability } = await client.compose({
  input: { kind: "gui", action: "view.select", params: { intent: "sales.trend" } },
  session: { surface: "web" },
});

// errors are discriminable exceptions. Branching by code can be written type-safely (HostErrorCode).
try {
  await client.compose({});
} catch (e) {
  if (isKohakuHostError(e) && e.code === "BAD_REQUEST") { /* e.status / e.requestId can also be referenced */ }
}

// streaming synthesis (SSE; §6.1.1) is consumed as a typed async iterator.
for await (const ev of client.composeStream({ intent: { canonical: "sales.trend", params: {} } })) {
  if (ev.kind === "spec") renderSkeletonOrFinal(ev.spec, ev.final);
  else if (ev.kind === "patch") applyPatch(ev.patch);      // REST-STR-002: folding it up matches /compose
  else if (ev.kind === "error") showError(ev.error);        // REST-STR-003: terminates with done or error
}
```

- **A disconnected stream is a failure, not a silent success**: if the connection closes before a `done` or `error` event (REST-STR-003), `composeStream`'s iteration throws `KohakuHostError` (`code: "INTERNAL"`) instead of the `for await` loop just ending.
- **Pass-by-reference binding**: `client.binding({ capability })` composes `@kohaku-ui/data-binding`'s `BindingClient` together with the SDK settings (baseUrl / headers) (`createBindingClient` is also re-exported from the SDK).
- **Governance**: `client.catalog()` / `client.lineage()` / `client.telemetry()` / `client.promotions.*` / `client.fixations.*` are typed. `client.lineagePages(query)` walks `GET /lineage?order=asc` exhaustively (an async generator of pages) rather than `lineage()`'s tail window.
- **"Why did this view come out this way"**: every successful `compose()` / `sendEvent()` response (and the stream's `done` event) carries `requestId` — read from the `X-Request-Id` response header, not the wire body. Pass it to `client.explain(requestId)` to get an `ExplainReport` (provenance, the cache-key breakdown, the decision flow, capability scopes, and the raw lineage events) built from `lineagePages({correlationId: requestId})` — see "Kohaku DevTools and `kohaku explain`" below.
- **The fetch thunk to pass to renderer-react's `useSpecStream`** is obtained via `client.composeStreamRequest(req)`.
- **Routes outside the SPEC** (your own `/health`, etc.) are called via the escape hatch `client.request(path, init?)` (the headers hook works, but JSON parsing and error conversion do not).
- The sample's wiring is `apps/sample-web/src/kohaku/client.ts` (a thin wrapper around the SDK to match the sample-specific call shapes).

### Embedding the governance console (`@kohaku-ui/admin-react`)

The Admin page's five tabs ship as React components. They need nothing but a `KohakuClient`; RBAC, tenant scoping and
approval stay on the host (`createGovernancePolicy`, the governance routes), so embedding the console does not change
who may approve what — a 403 `CAPABILITY_DENIED` is rendered as a red banner naming the operation.

```tsx
import { KohakuAdmin, useAdminNotice } from "@kohaku-ui/admin-react";
import { createKohakuClient } from "@kohaku-ui/client";

const client = createKohakuClient({
  baseUrl: "/api/kohaku",
  // Tenant AND role both ride on this client's own headers hook — the console never sets either itself.
  // Resolve both from your auth layer in production.
  headers: () => ({ "x-kohaku-tenant": currentTenant(), "x-kohaku-role": currentRole() }),
});

export function GovernancePage() {
  return (
    <KohakuAdmin
      client={client}
      tenant={currentTenant()}        // remount key: switching tenant re-fetches every tab. Role is NOT a
                                       // remount key — changing role only changes what the next request is
                                       // allowed to do, so an already-loaded list survives a role switch.
      theme={myThemeTokens}           // renderer-core ThemeTokens → --kohaku-color-* (light fallbacks when omitted)
      messages={myAdminMessages}      // AdminMessages; defaultAdminMessages is English
      promotionDefaults={{            // your query source's queryTemplate.path choices and draft prefill
        queryPaths: ["", "trend"],
        initialDraftFor: (candidate) => ({ /* DraftForm */ }),
      }}
      toolbar={<MyControls />}        // rendered in the tab bar; may call useAdminNotice()
      hiddenTabs={["approvals"]}      // built-in tabs to leave out (here: a host that wires no ApprovalPort)
    />
  );
}
```

`hiddenTabs` takes any of the built-in tab keys (`"lineage"`, `"analytics"`, `"promotions"`, `"fixations"`,
`"approvals"`); a host with no `ApprovalPort` hides `"approvals"` rather than show a tab whose `POST /approvals`
answers 501.

Each tab (`LineageTab` / `AnalyticsTab` / `PromotionsTab` / `FixationsTab` / `ApprovalsTab`) and the hooks behind them
(`useLineage` / `useAnalyticsSummary` / `usePromotions` / `useFixations` / `useApprovalInbox`) are exported too, for products that compose
their own shell around `AdminProvider`. The package depends on `client`, `renderer-core`, `sandbox` and `spec-core`
only — never on `renderer-react` or `host-rest` (`packages/admin-react/test/boundary.test.ts` pins the manifest and
every `src` import against that list).

The package root carries only this domain API (`KohakuAdmin`, the tabs, the hooks, `AdminMessages`, and the
`NoticeKind` / `NotifyFn` types used by `onNotice`). The generic UI primitives the tabs are built from — `card`,
`Field`, `Empty`, `StatCard`, `StatusBadge`, `BarRow`, `ErrorBanner`, and the rest — live on a separate
`@kohaku-ui/admin-react/ui` subpath instead, so embedding `KohakuAdmin` in an app that already has its own `Field`
or `card` never forces an aliased import; reach for `/ui` only when composing your own shell around `AdminProvider`
and wanting the same primitives.

The console's colors come entirely from `ThemeTokens`, resolved through `adminThemeStyle` the same way
`themeTokensToCssVars` resolves them for a renderer: pass your `ThemeTokens` as the `theme` prop and every
`--kohaku-color-*` variable the console reads follows it, with renderer-core's default light values as the
fallback when a token is omitted. Two of those variables are not part of `KnownThemeTokens` itself —
`color.subtle` (de-emphasized text, distinct from `color.muted`) and `color.track` (a flat neutral track
background) — and a product that supplies both gets the console's full color palette in both light and dark mode
(the sample does this in `apps/sample-web/src/theme/tokens.ts`'s `buildTheme(mode)`); omit them and those two
spots fall back to the package's own light-mode default regardless of theme.

### Kohaku DevTools and `kohaku explain`

"Why did this view come out this way" — tier, cache hit/miss, the cache key's individual components,
which L1/L2 attempts ran and why they failed, capability-negotiation downgrades, and the lineage events a
request produced — is answerable from a `requestId` alone (a compose's `X-Request-Id` response header, or an
MCP tool call's `mcp:<sessionId or per-call uuid>:<jsonrpc id>` correlation id, which the MCP host returns in the
compose-family tool result's `_meta["kohaku/requestId"]` — it is not derivable from the JSON-RPC id alone, because
a session-less transport gets a per-call uuid) two ways. Both need a host that
**records lineage** (`createKohakuHost` wires a recorder by default; a hand-built `createKohakuRoutes` host needs
`recorder` set) and, for the CLI, a running **REST host** to read it from:

**From the CLI**, against any running REST host:

```bash
npx @kohaku-ui/cli explain <requestId> --rest http://localhost:8787/api/kohaku   # inside this repository: node cli/bin/kohaku.js explain …
# --json for the raw ExplainReport JSON instead of formatted text
# --header "x-kohaku-tenant:acme" (repeatable) for tenant/auth headers
# --spec spec.json to additionally show capability scopes (collectCapabilityScopes)
```

**As a floating panel** (`@kohaku-ui/admin-react/devtools`, a separate subpath decoupled from
`AdminProvider`/`KohakuAdmin` — see the boundary note above, which applies here too: client / renderer-core /
sandbox / spec-core only, never `renderer-react`):

```tsx
import { KohakuDevTools, withDevToolsCapture } from "@kohaku-ui/admin-react/devtools";
import { createKohakuClient } from "@kohaku-ui/client";

// withDevToolsCapture wraps onResponse so the panel's "recent requests" quick-pick fills itself in —
// wire it once, at client construction time, wherever your app already builds its KohakuClient.
const { config, capture } = withDevToolsCapture({ baseUrl: "/api/kohaku" });
const client = createKohakuClient(config);

function DevToolsMount() {
  // A devtool must never render by accident: `enabled` is required and explicit (gate it behind
  // `import.meta.env.DEV` or an equivalent dev-only check, the way apps/sample-web's
  // src/kohaku/DevToolsMount.tsx does — a literal `if (import.meta.env.DEV)` around the dynamic
  // import, not only a runtime check inside JSX, so Vite/Rollup's dead-code elimination drops the
  // whole module from a production bundle).
  return <KohakuDevTools enabled client={client} capture={capture} />;
}
```

Both surfaces build on the same pure function, `@kohaku-ui/client`'s `buildExplainReport(events, spec?)`, fed
by `client.explain(requestId, {spec?})` — which itself is nothing more than `lineagePages({correlationId:
requestId})` (design.md #53's forward-paging filter) plus that function. There is no dedicated `/explain`
REST route (design.md #55).

- **CORS, for a browser-hosted client talking to a cross-origin host**: reading the `X-Request-Id` response
  header from `fetch`'s `Response.headers` requires the host to send
  `Access-Control-Expose-Headers: X-Request-Id` — a plain CORS response does not expose custom headers to
  client-side JavaScript by default. Same-origin deployments (the sample's Vite dev-server proxy, a
  same-origin production deployment) are unaffected.
- **Events recorded before this shipped have no `correlationId`**: `view.composed` / `component.generated` /
  `component.used` / `view.fallback`'s `correlationId` (and `view.composed`'s `cacheKey` / `cacheKeyParts` /
  `decision`) are additive fields — an event recorded by an older kohaku version, or by a host whose
  `StoragePort` predates forward paging (`design.md` #53), simply has none of them, and `kohaku explain` /
  DevTools report "no view.composed event found" for that request id rather than a stale/partial one.
- **A reused request id returns more than one compose**: an `X-Request-Id` you (or a proxy in front of your
  host) supply is not guaranteed unique — `ExplainReport.composes` can hold more than one entry, and both the
  CLI and DevTools render each one rather than assuming a single result.
- **`decision` never contains a provider's own error text**: when an L1/L2 attempt fails by a thrown exception
  (a provider outage, a network error, a misconfiguration — anything an `LlmError`/an unexpected exception's
  own `.message` might name, which can carry a hostname, URL, or account detail), `decision.attempts[].issues`
  records only a fixed, non-sensitive message keyed by a closed `errorCode` vocabulary (`CONFIG` /
  `INVALID_OUTPUT` / `PROVIDER` / `ABORTED` / `UNKNOWN`) — never the exception's own text. This applies only to
  a *thrown* attempt; a validation-failed attempt's `issues` (schema/catalog issues describing the model's own
  structural output, e.g. an unknown component type) are still the real messages, still capped to 5 entries of
  200 characters each. For the exception's actual message, use your own `ComposeObserver.onError` /
  `KohakuHostDeps.onError` hook (§7's `KOHAKU_DEBUG` bullet) — a `lineage.read` principal reading `/lineage`,
  `kohaku explain`, or DevTools never sees it.

### Adding a part

```ts
export const myCard = defineComponent({
  type: "myapp.card", version: "1.0.0",
  description: "Displays ~ (the LLM reads this to select it; be specific)",
  propsSchema: z.object({ title: z.string() }),
  capabilities: { events: [], data: "required", children: "none" },
  fallback: { type: "presentMarkdown", mapProps: () => ({ markdown: "(unsupported)" }) },
});
// API side: resolveCatalog(coreCatalog, { components: [myCard] })
```

`myCard` is the single source of truth for `{type, version, propsSchema}` — define it once (e.g. in a shared
package your server and every renderer both import) rather than re-typing `"myapp.card"` / `"1.0.0"` as string
literals at each registration site; a typo or version drift between them would otherwise go undetected until
runtime (design.md #68).

React (`@kohaku-ui/renderer-react`): `implement(def, Component)` infers `Component`'s `props` from
`def.propsSchema`, so `node.props["title"] as string` casts are unnecessary, and `ImplRegistry.use(entry)`
registers the result under `def`'s own type/version:

```tsx
import { implement, ImplRegistry, type TypedImplProps } from "@kohaku-ui/renderer-react";

function MyCardComponent({ props }: TypedImplProps<z.infer<typeof myCard.propsSchema>>) {
  return <div>{props.title}</div>; // props.title: string
}

const registry = new ImplRegistry().use(implement(myCard, MyCardComponent));
```

Web Components (`@kohaku-ui/renderer-wc`): `<kohaku-surface>` exposes a public `registerPart(type, version,
builder)`, and `implementWc(def, builder)` is its typed counterpart:

```ts
import { implementWc } from "@kohaku-ui/renderer-wc";

const entry = implementWc(myCard, (rt, parent, node, props) => {
  const el = document.createElement("div");
  el.textContent = props.title; // props.title: string
  parent.appendChild(el);
  return () => el.remove();
});
surface.registerPart(entry.type, entry.version, entry.builder);
```

`registerPart` replacing an already-registered `type` (most easily one of the 16 core-catalog parts, by typo
or an intentional override) warns via `console.warn` unless you pass `{ override: true }` as a 4th argument —
silent shadowing of a core part is an easy way to lose it by accident.

Both `implement` and `implementWc` always run `def.propsSchema.safeParse` on the node's props — in every
environment — so a `.default()`-ed value the Spec omits is materialized regardless of whether the diagnostic
below is on; on a mismatch, the raw (unvalidated) props are used instead of failing the node.

Only the **diagnostic** (the `console.warn` on a mismatch) is gated by environment: on by default outside a
`NODE_ENV=production` build, off inside one — pass `{ validate: false }` / `{ validate: true }` to override
either way regardless of environment. A build that never actually sets `process.env.NODE_ENV` (a bare
esbuild invocation without `--define:process.env.NODE_ENV='"production"'`, or a bundler config that never
switches to its production mode) leaves the diagnostic on — the same convention React's own bundled builds
use, and the safe side to default to, since it costs nothing beyond an extra `console.warn` call on the rare
mismatch path.

The untyped `ImplRegistry.register` / a plain `PartBuilder` registered via `registerPart` both
keep working unchanged for a part that has no static `ComponentDefinition` (e.g. a promoted part whose schema
is generated per-artifact from the approval draft — see `apps/sample-api/src/intents/promoted.ts`).

Validation: `npx @kohaku-ui/cli component validate <definition.json>`. The minimal definition.json that passes validation (`type` is a dot-separated identifier, `version` is semver, `propsSchema` is a JSON Schema of `type: "object"`, and `capabilities.data` requires one of `none | optional | required`):

```json
{
  "type": "myapp.card",
  "version": "1.0.0",
  "description": "Displays a card with a title (the LLM reads this to select it)",
  "propsSchema": {
    "type": "object",
    "properties": { "title": { "type": "string" } },
    "required": ["title"]
  },
  "capabilities": { "events": [], "data": "required", "children": "none" }
}
```

### Deprecating a part and migrating off it

Mark a part `deprecated` (naming what replaces it) instead of deleting it outright: validation of Specs
already fixated on it still passes, but L1 generation stops offering it, and the catalog fingerprint
changes so the compose cache separates cleanly (design.md #65):

```ts
export const myCard = defineComponent({
  type: "myapp.card", version: "1.0.0",
  // … description / propsSchema / capabilities as before …
  deprecated: { reason: "superseded by myapp.cardV2", replacedBy: { type: "myapp.cardV2" } },
  migrateProps: (props) => ({ title: props.title }), // TS-only: rewrites props for `kohaku migrate`
});
```

Rewrite every fixated (L0) Spec still using the deprecated part onto its replacement with the `migrate` CLI
(two steps — plan is read-only, apply commits it):

```bash
npx @kohaku-ui/cli migrate plan --data-dir ./.data --catalog ./catalog.ts --out plan.json
# Inspect plan.json: rewrites / steps (ready to apply) / blocked (needs manual attention — e.g. an
# incompatible props shape after the rewrite). Then, with any host process sharing --data-dir stopped
# (the file-backed StoragePort is not safe for concurrent writers):
npx @kohaku-ui/cli migrate apply --plan plan.json --approver you@example.com --data-dir ./.data --catalog ./catalog.ts
```

The CLI reads and writes a **file** data directory only (`--data-dir` is opened with `createFileStoragePort`). If your fixations live in memory, Redis or Postgres, call host-core's `planCatalogMigration` / `applyCatalogMigration` against your own `StoragePort` instead — the CLI is a thin wrapper over them, and `applyCatalogMigration` applies the same live-catalog checks:

```ts
import { applyCatalogMigration, planCatalogMigration } from "@kohaku-ui/host-core";

// `storage` is your StoragePort; `fixations = createFixations({ lineage, storage, catalogFor })`
// (`@kohaku-ui/lineage`); `catalogFor` is the same `(tenant?) => ResolvedCatalog` your host uses.
const plan = await planCatalogMigration({ storage, catalogFor }); // read-only; inspect plan.steps / plan.blocked
const result = await applyCatalogMigration({ plan, fixations, approver: { id: "you@example.com" }, catalogFor });
```

`--catalog` (required on both `plan` and `apply`) points at an ESM module whose default export is
`(tenant?: string) => ResolvedCatalog` — the same shape your host's `ComposeContext.catalogFor` already
takes, so it's usually the same module (or a thin re-export of it). `apply` re-resolves this catalog and
checks it against what the plan recorded before writing anything: a step whose target catalog has drifted
since planning (a part added/removed/further deprecated, or even just a part's `propsSchema` tightened in
place without a version bump) is refused and reported instead of applied, so re-running `plan` right before
`apply` — or pointing both at the exact same catalog snapshot — is the safe default. The published CLI does not bundle a TypeScript loader, so a `.ts` `--catalog` needs tsx installed in your project and `NODE_OPTIONS="--import tsx"` set on the command (or point `--catalog` at a built `.js` file).

#### Rolling out a catalog version gradually

To stage a migrated catalog behind a canary before flipping every tenant over, wrap your two catalog
versions with `stagedCatalogFor` instead of switching `catalogFor` all at once:

```ts
import { resolveCatalog, stagedCatalogFor } from "@kohaku-ui/registry";

const ROLLOUT_TENANTS = new Set(["acme"]); // grow this list as confidence builds

const catalogFor = stagedCatalogFor({
  stable: resolveCatalog(coreCatalog, myContribution),          // pre-migration
  next: resolveCatalog(coreCatalog, myMigratedContribution),    // post-migration (myCard deprecated)
  inRollout: (tenant) => ROLLOUT_TENANTS.has(tenant),
});
```

Tenant-neutral traffic (no tenant resolved at all) always gets `stable`, so a canary rollout can never
affect it — `inRollout` is never even called for it. `stagedCatalogFor` only chooses between the two
catalogs you give it; it does not merge in a per-tenant promoted-component contribution itself. A product
that also promotes components per tenant applies that layering *after* this choice — build `stable` /
`next` from `resolveCatalog(coreCatalog, ..., promotedEntries)` per tenant, the way `apps/sample-api/src/app.ts`'s
`buildCatalog` does, the same way you already would without staging.

### Getting started with golden regression

Fix the "structure" of input Intent → generated Spec as a regression. Generate a template:

```bash
npx @kohaku-ui/cli scaffold golden --out ./my-app/test   # golden.test.ts + golden/README.md
```

Wire your product's `ComposeContext` into the generated `golden.test.ts`'s `makeContext`, place `{name,input,drafts,expected:null}` JSON under `golden/`, and generate `expected` with `KOHAKU_GOLDEN_UPDATE=1 <run the test>`. Subsequent tests are deterministic and LLM-free, because `@kohaku-ui/evals`'s `runGolden` normalizes the jitter of provenance / intent.hash / dataVersion / refVersions and component IDs and compares only the structure (responses feed `drafts` to the FakeLlm; if you need a live recording, use FixtureLlm's record/replay). A working example is `apps/sample-api/test/golden.test.ts` (fixing the L1 generation of `sales.trend`). If you intentionally change the UI, regenerate `expected` with the same update procedure, review the git diff, and commit.

### A2UI ingest (governance proxy for a third-party agent's surface) [Draft]

`@kohaku-ui/host-a2ui`'s inbound side (`fromA2ui` / `createA2uiIngest` / `toA2uiClientAction`) lets you render a **third-party** A2UI agent's surface inside your own kohaku-based product and bring it under the same governance you already get for your own generated views: the ingested content becomes an ordinary L1 `UISpec` (`provenance.composedBy: "a2ui-ingest"`), so it is cached, appears in View Lineage, and is eligible for the same L1→L0 fixation as anything else. No LLM is called anywhere in this path.

```ts
import { createA2uiIngest } from "@kohaku-ui/host-a2ui";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { createLineage, createViewRecorder, createFixations } from "@kohaku-ui/lineage";

const storage = createFileStoragePort("./.data");
const lineage = createLineage({ storage });
const ingest = createA2uiIngest({
  storage,
  recorder: createViewRecorder(lineage),
  fixations: createFixations({ lineage, storage }),
  agentId: "vendor-checkout-agent", // from your own auth, never from the message payload
});

// Forward the vendor agent's raw A2UI messages (createSurface / updateComponents / updateDataModel / deleteSurface)
// as they arrive; ingest() schema-validates them and returns the current UISpec for that surface.
const { spec, cache, losses } = await ingest.ingest(vendorMessages, {
  // Recommended: pass an explicit Intent (see the governance-proxy note below).
  intent: { canonical: "vendor.checkout", params: { orderId } },
});
```

**Pass an explicit `intent`.** Without one, `ingest()` derives a default canonical name from `surfaceId` (`a2ui.<agent_slug>.<surface_slug>`) — and a real agent typically mints a fresh `surfaceId` per session/connection, so that default almost never repeats and the Spec cache almost never hits. An explicit, product-meaningful Intent (e.g. `{canonical: "vendor.checkout", params: {orderId}}`, keyed by something that's actually stable across requests for "the same logical view") is what makes repeated ingests of the same live surface share one cache entry, participate in fixation-proposal aggregation, and show up coherently in the Lineage / Analytics views.

When the user interacts with the rendered surface, your renderer fires an ordinary kohaku `GuiAction` (kohaku synthesizes an `EventBinding` from the agent's own `action.event` during ingest, so this is a real interaction, not just a static reconstruction); route it back to the originating agent with `toA2uiClientAction(guiAction)`, which recovers the agent's own event name and context.

**Security: never register `A2UI_FORWARD_ACTION` as a real operation.** The `EventBinding` kohaku synthesizes for an ingested interaction always carries `payload.action: A2UI_FORWARD_ACTION` — never the agent's own data — because spec-core's `collectWriteActions` (what decides which write capability your host issues for a Spec) reads exactly that field, and an A2UI event's `context` is otherwise a wholly agent-controlled dictionary a malicious agent could use to name a real operation of yours. Your dispatcher has to recognize `A2UI_FORWARD_ACTION` and route it to `toA2uiClientAction` *before* ever considering a `DomainPort` call, and you must never register it as an actual operation. This routing is your product's responsibility: no reference host does it for you (`host-rest` and `host-mcp-apps` know nothing about A2UI), so wire it yourself — see the wiring recipe in `packages/host-a2ui/README.md`. `createA2uiIngest` always treats ingested content as untrusted this way; only call `fromA2ui` directly with `trust: "trusted"` (which also restores a `KohakuSidecar`'s original events verbatim) for content you can prove is kohaku's own prior output re-ingested, e.g. in a test.

Unmappable content (a component type your catalog doesn't recognize, a data-bound repeated template, a computed function-call value) becomes a deterministic placeholder by default (`unmappable: "fallback"`, the default) — never a fresh LLM regeneration — or fails the whole ingest (`unmappable: "reject"`) if you'd rather surface the error immediately. See `packages/host-a2ui/README.md` and [spec/SPEC.md](../spec/SPEC.md)'s §6.3 "Inbound A2UI (ingest)" for the full mapping table, the write-action forwarding security note, and the loss policy (out of conformance scope, like the rest of the A2UI profile).

## 7. Operational tips

- **Development mode and the production warnings (`dev`)**: with neither `auth` nor `authorizeGovernance` wired, `createKohakuRoutes` logs two `console.warn` lines at startup (every request is the shared ANONYMOUS principal; the governance/audit routes are open). That is right for production, noisy for local work, so `KohakuHostDeps.dev: true` folds them into a single `console.warn` line naming whatever is unwired and the matching consequence (nothing at all when both are wired; it stays on stderr so a stdio MCP server's stdout remains JSON-RPC only); behavior is identical, only the log differs, and without `dev` the two warnings are unchanged. `createKohakuHost({ dev })` (`@kohaku-ui/host`) forwards it (`routes.dev` overrides) and additionally allows a temporary capability secret when none is configured (only when no secret is given; a project that always sets `KOHAKU_CAPABILITY_SECRET` is unaffected). `kohaku init`'s generated `server/ports.ts` passes `routes: { dev: process.env["NODE_ENV"] !== "production" }` (the npm convention; no new variable). It uses `routes.dev` rather than the top-level `dev` on purpose, so the temporary-secret fallback stays off and a missing `KOHAKU_CAPABILITY_SECRET` still fails fast. Before production, wire `routes.auth` (`Principal` is `{ id, roles }`) and `routes.authorizeGovernance` (`governancePolicyFromRoles` is re-exported from `@kohaku-ui/host`), fix `KOHAKU_CAPABILITY_SECRET`, and set `NODE_ENV=production`; the generated project's README ("Before production") and `server/ports.ts` carry a commented starting point.
- **Cache and data updates**: The Spec cache key is intent + dataVersion + catalog fingerprint (+ an optional generatorVersion). The granularity of `SemanticPort.dataVersion` (whole / per-table / event-driven) directly becomes the invalidation strategy. The sample is whole-at-once + bump.
- **Cache invalidation and cap**: Since the key includes dataVersion / catalog fingerprint / generatorVersion, data updates, part publication, and prompt revisions automatically become separate entries via key changes. Therefore, active cache invalidation (deletion) is in principle unnecessary. The TTL is not freshness control but insurance for memory reclamation; if unspecified, entries are held indefinitely. The sample's `StoragePort` is an in-memory Map, and when the entry cap (default 500) is exceeded, the least recently referenced key is dropped by LRU. Set the cap high enough to cover "the set of simultaneously live intent × dataVersion combinations"; if you need permanent retention or a large number of entries, `@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres` (below) keep entries on the backend instead.
- **Cache backend failures (`ComposePolicy.cacheFailure`)**: If the `StoragePort` backing the Spec cache is itself unavailable (a Redis outage, say), `getSpecCache`/`putSpecCache` throwing is fail-open by default (`cacheFailure` unset, equivalent to `"open"`): a lookup failure is treated as a miss and a store failure is skipped, so generation still proceeds and a Spec is still delivered; each occurrence is reported to `observer.onError` with `phase:"cache"`. Set `cacheFailure: "closed"` when the identical-display guarantee must be strict and a cache outage should fail the request instead of silently degrading.
- **Production adapters (`@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres` / `@kohaku-ui/authz-jwt`)**: the sample's file `StoragePort` keeps the Spec cache in one process, so two instances behind a load balancer do not share it and the identical-display guarantee only holds per instance. The two storage adapters implement the whole `StoragePort` (Spec cache with TTL, append-only lineage with indexed filters, promotion state and fixations keyed by `(tenant, id)`) on a shared backend, so the second instance serves an Intent the first composed as `provenance.cache: "hit"` (proven by `apps/sample-api/test/storage-backends.e2e.test.ts`). Both are **reference adapters**: the contract stays `ports.ts`, the drivers (`ioredis`, `pg`) are peer dependencies you install and can share (`client` / `pool` injection), and the cross-process concurrency contract is unchanged (the host still serializes its own read-modify-write per `(tenant, key)`; §4.4 of specification.md). All options — timeouts, pool/connection size, `onError`, and injecting your own client/pool — are documented in `packages/storage-postgres/README.md` and `packages/storage-redis/README.md`.
  - Redis: `createRedisStoragePort({ url, keyPrefix })`. Redis Cluster is not supported (standalone / Sentinel only — see the README's "Not supported" note). Keys are `{prefix}:spec:{key}` (with `EX` when a TTL is given), `{prefix}:lineage:*` (a hash of events plus sorted-set indexes by type / tenant / intentHash / artifactId / specHash), and `{prefix}:{tenant}:promotion|fixation:{id}` with per-tenant and all-tenants index sets (tenant-neutral records use `%` as the tenant segment). Everything multi-key is written under `MULTI`. **Fail-fast, not hang**: a `url`-constructed client is built with `lazyConnect: true` and `enableOfflineQueue: false` — without those, a command issued while Redis is unreachable would otherwise queue silently and hang the caller forever (this stack has no request-level timeout of its own). Every method awaits `ready()` first, which turns "unreachable" into a rejection bounded by `connectTimeoutMs` (default 5000ms; `maxRetriesPerRequest` defaults to 3); `ready()` is memoized but a failed attempt clears the memo (mirroring `storage-postgres`'s `ready()` below), so a transient outage doesn't permanently strand the port. The sample calls `await storageFromEnv.ready()` (via `StorageFromEnv.ready`, `apps/sample-api/src/ports/from-env.ts`) at startup in both `sample-api` and the `sample-mcp` HTTP entry, so an unreachable backend exits with a clear error instead of hanging or only surfacing on the first request. An injected `client`'s options are never overridden — for the same behavior, construct it yourself with `enableOfflineQueue: false`; `ready()` then resolves immediately if it is already `"ready"`, otherwise waits for that client's own `ready` / `error` event bounded by `connectTimeoutMs`.
  - Postgres: `createPostgresStoragePort({ connectionString, schema, migrate })`. Five tables (`kohaku_spec_cache`, `kohaku_lineage`, `kohaku_promotion_state`, `kohaku_fixation`, `kohaku_capability_revocation` — see "Capability revocation" below) created by an idempotent script (`postgresSchemaSql(schema)`, run once on first use unless `migrate: false`). The four Spec/lineage/promotion/fixation tables store their JSON payload as `text`, not `jsonb`: Postgres's `jsonb` re-serializes object keys (by length, then lexicographically) instead of preserving the byte order they were written in, which broke the exact-equality read-back the identical-display guarantee depends on — `text` round-trips the exact bytes (the revocation table carries no JSON payload, so this choice doesn't apply to it). Expired cache rows are misses on read; `sweepExpiredSpecCache()` deletes them (run it from a cron). Rows use `''` as the tenant-neutral tenant. `ready()` records the schema version in `kohaku_schema_meta` and fails fast on a mismatch; migrating a database deployed before this versioning existed follows the "Migrating from a pre-release schema" section of `packages/storage-postgres/README.md`.
  - JWT: `createJwtAuthzPort({ key: { secret } | { jwks } | { jwksUrl }, issuer, audience, claims, capabilitySecret })`. Capability tokens are `@kohaku-ui/authz-hmac`'s unchanged, including revocation (below); `identity` verifies a bearer JWT (jose; HS256 for a secret, RS256 / ES256 / EdDSA for a JWK set) and maps `sub` / `name` / `roles` (array or space-separated) / `tenant` to `{ principal, tenant }` (claim names and the whole mapping are overridable). `key.secret` must be at least 32 bytes (UTF-8; enforced at construction) and, with a third-party `jwksUrl`, setting `issuer` alongside the required `audience` is recommended (the JWKS URL is already per-issuer, so the risk is low without it, but `issuer` makes the `iss` check explicit rather than implicit). The sample wires it as a Hono middleware that answers 401 (`CAPABILITY_DENIED`) for a missing or invalid token and feeds `KohakuHostDeps.auth` / `tenant` from the verified claims (`apps/sample-api/src/app/request-identity.ts`'s `createJwtRequestIdentity`, wired from `ports.identity` in `apps/sample-api/src/index.ts`); the MCP HTTP entry resolves the principal per tool call from the request's own `Authorization` header (`extra.http.req`). `authz-jwt` delegates `issueCapability` / `verify` / `revokeCapability` to `@kohaku-ui/authz-hmac` unchanged.
  - **Capability revocation (`CapabilityRevocationStore`, `ports.ts`)**: a capability token can now be revoked before its `exp`. Every token `@kohaku-ui/authz-hmac` issues carries a `jti`; `HmacAuthzOptions.revocations` (passed through unchanged by `authz-jwt`'s `JwtAuthzOptions.revocations`) is consulted on every `verify`, and the returned port's `revokeCapability(token)` verifies the token's signature first (so a caller cannot revoke a `jti` it merely guessed) before recording it. The default store (`createMemoryRevocationStore`, `@kohaku-ui/authz-hmac`) is process-local, same caveat as the file `StoragePort`; a multi-instance deployment should inject `createRedisRevocationStore({ url, keyPrefix })` (a key per `jti` carrying its own `SET … EX` expiry — Redis drops it itself once the token would have expired anyway) or `createPostgresRevocationStore({ connectionString, schema })` (one row per `jti` in `kohaku_capability_revocation`, filtered by `expires_at > now()` on read; `sweepExpiredRevocations()` deletes stale rows for a cron, same treatment as `sweepExpiredSpecCache()`). The sample follows the storage selection for this too — `KOHAKU_STORAGE=redis|postgres` wires the matching revocation store into whichever `KOHAKU_AUTHZ` port is active (`apps/sample-api/src/ports/from-env.ts`'s `createAuthzFromEnv`); `memory`/`file` both get the in-memory store. **Operationally important**: a token minted before this feature existed carries no `jti` and therefore still cannot be revoked — it verifies exactly as before and simply expires on its own (deliberate, so a rolling deploy doesn't invalidate an older instance's already-issued tokens). Nothing logs a jti-less token being accepted, so the only way to know a fleet is safe to rely on revocation for is to know it has fully rolled onto a `jti`-issuing version.
  - The sample switches with `KOHAKU_STORAGE=file|memory|redis|postgres` (+ `KOHAKU_REDIS_URL` / `KOHAKU_POSTGRES_URL`) and `KOHAKU_AUTHZ=hmac|jwt` (+ `KOHAKU_JWT_SECRET` or `KOHAKU_JWT_JWKS_URL`, `KOHAKU_JWT_ISSUER`, `KOHAKU_JWT_AUDIENCE`, `KOHAKU_JWT_REQUIRE_TENANT`); see §9 of specification.md. Their test suites need a backend: set `KOHAKU_TEST_REDIS_URL` / `KOHAKU_TEST_POSTGRES_URL`, or have Docker running (testcontainers), otherwise they skip; CI runs them against job services with `KOHAKU_ADAPTER_TESTS=require`. `apps/sample-api/src/ports/from-env.ts`'s `createPortsFromEnv` (used by both sample-api's `index.ts` and sample-mcp's `setup.ts`) opens exactly one redis client / pg Pool per process and injects it into both the StoragePort and the revocation store via their `client` / `pool` options — calling `createStorageFromEnv` and `createAuthzFromEnv` separately (kept as thin wrappers for callers that only need one side) opens one connection each instead.
  - **Demo admin routes (`KOHAKU_DEMO_ADMIN_ROUTES`)**: `POST /api/kohaku/admin/bump-data-version` (the Admin page's "Simulate data update" button) is a demo-only cache-buster — reachable by anyone able to reach it, it is free leverage to force repeated LLM generation (a cost/DoS lever), so it is behind identity + the same governance RBAC as the rest of Admin (`admin.bumpDataVersion`, admin role only) and, under `KOHAKU_AUTHZ=jwt`, the route is not registered at all (404) unless `KOHAKU_DEMO_ADMIN_ROUTES=1` is set. Under the default `KOHAKU_AUTHZ=hmac` demo identity the route stays on by default (unchanged demo behavior). A product that keeps this route in production should treat it the same as any other governance-plane write: gate it behind a real `admin` role, not just "the JWT verified".
- **Operating promotions**: Becoming a candidate is automatic from usage logs; approval is always human. The judge can be selected by policy to be "advisory" (send to review even on failure) or "blocking". A published part changes the catalog fingerprint, so it does not mix with the old cache.
- **Exporting fixated Specs as a distillation dataset**: a `FixationRecord.pinnedSpec` is a human-approved `{components, events}` pair for its Intent — the best available teacher example for distilling a smaller model on catalog-constrained declarative UI generation. `npx @kohaku-ui/cli dataset export --fixations <fixations.json> [--golden <dir>] [--tenant <id>] --out <file.jsonl>` (inside this repository: `node cli/bin/kohaku.js dataset export …`; the `evidence` commands below take the same form) reads a `fixations.json` snapshot (sample-api's `.data/fixations.json` can be passed directly; the on-disk shape is `{key -> FixationRecord}`, one entry per (tenant, intentHash) — see `packages/storage-memory/src/file-storage-port.ts`) plus, optionally, golden regression Specs from a directory (`--golden`, accepting either `scaffold golden`'s `{name, input, drafts, expected}` fixture files or plain `UISpec` JSON files — a fixture whose `expected` has not been generated yet is silently skipped), and writes one canonical-JSON line per Spec to the given path: `{intent, refs, shape?, target: {components, events}, source: "fixation"|"golden", meta: {fixatedAt?, structureHash?, tenant?, catalogFingerprint?}}`. `kohaku` (the protocol-envelope version), `provenance`, and `dataVersion` are deliberately excluded — they are filled in by composer around the model's actual output, not something a distilled model should learn to reproduce. `--tenant <id>` restricts the export to that tenant's fixations (golden Specs carry no tenant and are always included); without it, the output spans every tenant present in `--fixations`, distinguishable afterward only via each line's `meta.tenant`. An entry that fails `FixationRecordSchema` (e.g. hand-edited or pre-migration) is skipped rather than aborting the whole export — the skipped count is reported on stderr and in the command's output, so one bad entry no longer blocks the rest of the dataset. Entries are sorted by `(intentHash, source)` ascending — a `fixation` entry orders before a `golden` entry sharing the same intentHash — so re-running the export is byte-identical (see `@kohaku-ui/evals`'s `exportDistillationDataset` / `kohaku.evals.export_distillation_dataset` for programmatic use, e.g. to supply a `describeShape` callback for column metadata or a `tenant` filter).
- **Metering from lineage (`kohaku usage export`)**: per-day, per-tenant usage (compositions, cache outcomes, tiers, L2 generations, fallbacks, LLM tokens from `view.composed`'s `decision.usage`, fixations) is derived from the lineage log, not from the budget guard's daily-token ledger (design.md #74). `npx @kohaku-ui/cli usage export --data-dir <dir> --since 2026-09-01 --until 2026-09-30 [--tenant <id>] [--format csv|json] [--out <file>]` (or `--rest <baseUrl> --header "x-kohaku-tenant:<id>"`) pages the **whole** log in the window and prints a CSV with a fixed header (`day,tenant,composed,cache_hit,…,tokens_in,tokens_out,fixated,unfixated`; an unrecorded tenant is an empty field). The admin Analytics tab's "Usage by day" table and `GET /analytics/summary`'s `summary.usage` show the same rows, but only over the most recent ≤ 1000 events, so treat them as a sample; the CLI's exhaustive paging is the source of record. A REST export is scoped by the `x-kohaku-tenant` header (run it once per tenant header; a host that sends no header, a legacy unscoped one, returns every tenant), while `--data-dir` covers every tenant at once.

  Columns: `composed` counts `view.composed` records; `cache_*` is their cache outcome (`cache_fixated` = served from a fixation); `l0` / `l1` / `l2` is the tier a Spec was delivered as, so `l2` includes L2 Specs served from the cache and fallback Specs that kept the L2 label; `l2_generated` is the subset that actually generated an L2 Spec and succeeded (a fallback Spec of a failed or budget-skipped generation and a single-flight follower are not counted; a negotiation downgrade of a Spec that was generated is, because its tokens were spent), the number that tracks L2 spend; `fallbacks` counts the composes that carry a fallback (read off `view.composed` rather than `view.fallback`: the REST and the MCP profile both record both, so counting both would double-count); `tokens_in` / `tokens_out` sum `decision.usage`; and `fixated` / `unfixated` count fixation **operations** (`intent.fixated` / `intent.unfixated`), not composes served from a fixation. Lines end in LF, and a tenant that starts with `=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet does not read it as a formula. `--data-dir` reads the file layout of `createFileStoragePort` only (a Redis or Postgres deployment is exported through `--rest`), and a path that does not exist exits 2 rather than producing an empty file.
- **Cost/token budget guard (a safety valve against runaway cost)**: Wiring `ComposePolicy.budget` judges the budget right before calling the LLM (before L1 generation, before repair, before L2), and on a denial it gives up the repair retry and L2 escalation and degrades to a deterministic fallback (`presentMarkdown`). `perCompose.stopAfterTokens` is a **cumulative token threshold that stops additional calls**, not a hard cap on total tokens (an overrun on a single call cannot be stopped in advance and is recorded after the fact in `trace.usage`). `check()` is a hook for a global budget that the product side holds (per-day, per-tenant, etc.) (**the framework does not decide where the state is held** — a Redis counter, etc. is a product implementation). The degraded Spec is not cached, and it can be observed via `observer.onError` (`budgetExceeded:true` with `phase:"fallback"`). When the budget hook `check()` `throw`s, it leans toward passing through (fail-open) while transcribing that firing to `observer.onBudgetCheckError`, so a failure of the budget hook is not left unobserved. If `budget` is unspecified, both behavior and performance are completely unchanged.

  ```ts
  import { compose, type ComposeContext } from "@kohaku-ui/composer";

  // Example: stop additional calls once the cumulative 8000 tokens is reached + manage the tenant's daily budget on the product side
  const ctx: ComposeContext = {
    catalog, semantic, storage, llm,
    policy: {
      allowL2: true,
      budget: {
        // not a hard cap but a "stop subsequent LLM calls once this is reached" threshold (a single-call overrun is detected after the fact)
        perCompose: { stopAfterTokens: 8_000 },
        // make it an idempotent read with no side effects (it may be called multiple times in one compose). throw is treated as allow.
        check: () => {
          const spent = dailyBudget.get(currentTenant()); // ← where it is held is a product responsibility (Redis, etc.)
          return spent.remaining > 0
            ? { allow: true }
            : { allow: false, reason: `daily budget for tenant ${currentTenant()} exceeded` };
        },
      },
    },
    observer: {
      onError: (c) => {
        if (c.budgetExceeded) metrics.increment("compose.budget_degraded", { reason: c.reason });
      },
      // do not leave a failure of the budget hook check() (throw = fail-open) unobserved. it is a monitoring signal, not a failure notification.
      onBudgetCheckError: (c, error) => {
        metrics.increment("compose.budget_check_error", { tier: c.tier });
      },
    },
  };
  await compose(input, ctx);
  ```
- **Policy as Code and rate limiting (design.md #69/#70)**: a declarative JSON file layers per-tenant overrides — `allowL2`, `budget.dailyTokens`, `rateLimits` (per route class: `compose`/`action`/`resolve`), `governance.roles` — on top of the base `ComposePolicy` your code supplies, without a code change or redeploy. **Scope boundary**: only the JSON-expressible subset of `ComposePolicy` lives in the file; every function-shaped field (`routeTier`, `fewShot`, `designSystem`, `fixedSpecs`, `l2Smoke`, `selectComponents`, `extraRules`) has no schema field at all and always comes from your base policy (design.md #69) — the runtime layers the file's data onto it, never replaces it.
  - **Wiring** (`@kohaku-ui/host-core`): `loadPolicyFile(path)` (Node-only; a separate `./policy-node` subpath so importing the rest of host-core never pulls in `node:fs`) reads and validates a file against `KohakuPolicyFileSchema`, returning `{file, policyId}`. `createPolicyRuntime({file, basePolicyFor, ledger, rateLimitStore, audit})` builds the runtime: `basePolicyFor(tenant)` is your base `ComposePolicy` (a single stable object, reused across calls — see the caveat below); `ledger` (`createDailyTokenLedger()`) backs `compose.budget.dailyTokens`; `rateLimitStore` (`createMemoryRateLimitStore()`, or your own `RateLimitStore`) backs `rateLimits`; `audit` fires with a `PolicyAppliedEvent` once for the starting file and on every effective change (see "Audit" below). **`ledger` / `rateLimitStore` are required whenever the file declares `dailyTokens` / `rateLimits`**: `createPolicyRuntime` (and `reload`, which keeps the previous policy) throws a configuration error instead of accepting a limit that would silently never be enforced. The returned `PolicyRuntime` exposes `policyFor(session)` (wire into `ComposeContext.policyFor`), `rateLimiter` (wire into `KohakuHostDeps.rateLimiter`), `rolesFor(tenant)` (wire into `governancePolicyFromRoles` for live-reloading RBAC), `policyId`, and `reload(file, actor?)`.
  - **`dailyTokens` is a soft limit under concurrency**: the ledger-backed `check`/`onUsage` pair (design.md #69) reads the day's running total before generation and records into it only after generation completes, with no reservation step in between — a `ComposeBudget.check` must stay synchronous and side-effect-free, so it cannot reserve a slice of the budget on the caller's behalf. N composes for the same tenant in flight at once can therefore all observe the same pre-usage total and all pass `check`, before any of them calls `onUsage` — the day's total can overshoot `dailyTokens` by at most `(concurrent in-flight generations) × (the per-compose token ceiling)`. Set `compose.budget.perCompose.stopAfterTokens` to bound that ceiling (and so the worst-case overshoot) if you need the effective daily cap tighter under load; `dailyTokens` alone is not a hard cap when calls overlap. Two more scope limits: the ledger is **in-process only** (its interface is synchronous, so it cannot front a shared store), so the budget applies **per host instance**, not across a multi-instance deployment; and only generation attempts spend it — the tokens an NL question's Intent normalization spends (`POST /intent/normalize`, the SemanticPort's LLM) are not counted.
  - **One-time cache miss on adoption**: `allowL2`/`routeTier` availability is folded into the compose cache key's fingerprint (`policyFingerprint`'s `tierGate` component; design.md #70 / SPEC **CMP-DET-002** — this is what stops a cache entry produced under an L2-permissive tenant/policy from ever being served to a session where L2 is disallowed). A policy file whose `defaults`/every tenant section leaves `allowL2` unset and declares no `routeTier`-affecting fields is byte-identical to not having Policy as Code at all — no cache impact. The **first** compose call after introducing (or changing) an explicit `allowL2: true` or a `routeTier` configuration for a tenant is a cache miss (the fingerprint changed); every call after that hits normally.
  - **Rate limiting**: when `rateLimiter` is wired, the compose-family routes (`POST /intent/normalize`, `/compose`, `/compose/stream`, `/events` as route class `compose`; `/binding/action` as `action`; `/binding/resolve` as `resolve`) are checked before doing any work — `/intent/normalize` is limited because, for a natural-language question, it calls the SemanticPort's LLM. REST returns `429` with the `RATE_LIMITED` error envelope (carrying the request's `requestId`) and, when the limiter reports one, an HTTP `Retry-After` header (seconds); the MCP Apps profile has no HTTP status/headers, so the same information travels in a structured tool error's `structuredContent.error` (`code: "RATE_LIMITED"`, `retryAfterMs?`). `KohakuHostDeps.onRateLimited` / `McpHostDeps.onRateLimited` (fire-and-forget) observe every denial. The bucket key is `(tenant, principal, routeClass)`; MCP never resolves a tenant, so its key is `(principal, routeClass)` only, where the principal component is, in order, `rateLimitKey(extra)` (when wired), the resolved principal's id (when `resolvePrincipal` is wired), (TS) the transport's session id, then the literal `"anonymous"` (Python: a per-connection id instead of the last two). **On the stateless Streamable HTTP serving and stdio there is no session id, so without `rateLimitKey` or `resolvePrincipal` every MCP caller shares the one `"anonymous"` bucket** (`attachKohakuToMcpServer` warns once about that configuration; a client can also shed a session-id key by opening a new session on the legacy stateful transport, so wire `rateLimitKey` or `resolvePrincipal` in production) — see `@kohaku-ui/host-mcp-apps`'s `McpHostDeps.rateLimiter` doc comment. A `RateLimitStore` failure is fail-open (the request proceeds), same policy as a Spec-cache backend failure; so is a store that does not answer within the limiter's timeout (default 250 ms, `rateLimitTimeoutMs`), and the `onRateLimitError` hook is not awaited.
  - **Audit**: `createPolicyRuntime` fires `audit` once for the starting file (`previousPolicyId` absent, no actor; Python: `await runtime.audit_startup()`). `PolicyRuntime.reload(file, actor?)` replaces the effective file and, only when the resulting `policyId` actually differs from the current one (a reload with the same canonical content is a no-op — no event, no cache impact), fires `audit` with `{policyId, previousPolicyId, version, label, changedPaths, tenants}` **before** committing the new policy: if `audit` rejects, `reload` rejects and the previous policy stays in force, so a retry records the event. Wire it to `@kohaku-ui/lineage`'s `Lineage.policyApplied(event, actor?, tenant?)` to get a `policy.applied` audit trail (visible in Admin's Lineage / `GET /api/kohaku/lineage`) of every policy change, who made it, and exactly which dot-separated paths changed.
  - **Identity is the actual security boundary**: rate limits and daily-token budgets are only as strong as the identity they key on. `createMemoryRateLimitStore`/`createDailyTokenLedger` cap their own memory (`maxEntries`, default 10,000, LRU-evicted) so an unbounded number of distinct keys cannot exhaust the process's memory — but that cap protects the *process*, not any individual tenant's fairness. The bucket/ledger key itself is built from `session.tenant`/the caller's principal, both ultimately resolved by `deps.tenant`/`deps.auth` (or their MCP equivalents). Without real authentication wired to those, an untrusted caller that can vary the header/session value it sends is effectively choosing its own key — it can rotate to a fresh bucket (or a fresh daily-token entry) at will, defeating both the rate limit and the budget. Treat header-derived identity with no `deps.auth` verifying it as convenience routing, never as an isolation guarantee, in any deployment where callers cannot be trusted not to do this.
  - **Try it**: `apps/sample-api/policy/kohaku.policy.json` (Python: `python/examples/sales-api/policy/kohaku.policy.json`) ships `tenant-a: {allowL2: false}` / `tenant-b: {budget: {dailyTokens: 0}}` as a live demo — compose against the sample with `x-kohaku-tenant: tenant-a` and a request that would otherwise reach L2 (e.g. a free-form question) to see it fall back instead, or `tenant-b` to see every call budget-fall-back immediately (`dailyTokens: 0` denies pre-flight, before any LLM call). `KOHAKU_POLICY_FILE` overrides the path the sample loads at startup; the literal value `"0"` opts out entirely.
  - **Out of scope for this release**: YAML policy files, file-watching auto-reload (call `reload()` yourself, e.g. from your own config-management hook), a policy-editing UI, a Redis-backed rate-limit store (bring your own `RateLimitStore` implementation if you need one shared across instances), and MCP-side tenant resolution (the MCP Apps profile never resolves a tenant, by design — see specification.md's MCP profile section).
- **Compose-wide deadline (a safety valve against a slow/hung LLM call)**: the sample wires `ComposePolicy.budget.deadlineMs` via `KOHAKU_COMPOSE_DEADLINE_MS` (`apps/sample-api/src/app/compose-context.ts`'s `composeDeadlineMs`; default 240000ms), so a single `compose`/`composeStream` call can never hang indefinitely — on expiry it aborts the in-flight LLM call and downgrades to the deterministic fallback exactly like a `perCompose` token-budget overage. The default covers one straight-to-L2 run (`sales.custom`'s ~180s L2 timeout under the default 3× `outputBudgetFactor` widening of `KOHAKU_LLM_TIMEOUT_MS`) plus headroom for a repair retry; widen it if your own L2 prompts routinely run longer. The Python sample mirrors this via `ComposePolicy(budget=ComposeBudget(deadline_ms=...))` in `python/examples/sales-api/src/sales_api/app.py`.
- **Measure before touching prompt caching or `refConstraint`**: kohaku's default `data.$ref` enforcement (`ComposePolicy.refConstraint: "schema"`) pins `data.$ref` to a per-Intent enum in the L1 generation schema — which also means a provider that caches structured-output grammar compilation (Anthropic) recompiles on nearly every distinct Intent rather than reusing a prior compile. Two independent, opt-in escape hatches exist, both defaulted off, and neither should be flipped without first measuring your own model/provider/traffic mix:
  - `KOHAKU_LLM_PROMPT_CACHE=1` (Anthropic `claude` only; no-op for other providers) marks the byte-stable prefix of the L1/L2 prompt (everything but the trailing repair-feedback section) with `cache_control`, so a repair re-attempt within the same compose call can reuse the cached prefix instead of reprocessing it. Anthropic silently ignores a cache breakpoint placed on a prefix shorter than a per-model minimum (roughly a thousand tokens and up, depending on the model) — harmless, but on a small catalog with no few-shot examples the cacheable prefix may fall under that minimum, in which case enabling the flag has no measurable effect at all. Check the prefix's actual token count against your model's minimum before concluding the flag "doesn't work."
  - `ComposePolicy.refConstraint: "validate"` relaxes the generation schema's `data.$ref` to a plain string (an Intent-independent grammar reusable across composes, not just repair retries) and instead validates set-membership explicitly after generation (`DATA_REF_UNRESOLVED`, fed into the existing repair loop).
  - Run `KOHAKU_LLM_PROVIDER=claude KOHAKU_LLM_MODEL=<your model> ANTHROPIC_API_KEY=<your key> pnpm --filter @kohaku-ui-sample/api run measure-grammar-latency` (`apps/sample-api/scripts/measure-grammar-latency.ts`) against your actual model before deciding whether either escape hatch is worth turning on for your deployment — this script calls a real LLM and is intentionally excluded from `pnpm test`. Every row is expected to read `provenance.cache: "bypass"` — that is not a comparison axis, it is a check that the LLM path actually ran; without a valid API key the `claude` provider only warns at startup and falls through to the deterministic fallback, so a missing key shows up as a much *faster* run with the `tier` column reading `L0`/fallback instead of `L1` rather than as an error — always check `tier` before trusting the latency numbers. See the script's own header comment for how to read the table (the 24h Anthropic grammar cache means the first-vs-second call of the *same* Intent does not separate the two modes) and [design.md#prompt-caching](design.md#prompt-caching) for the full trade-off.
- **Audit**: "Why this screen appeared" can be traced via specHash / intentHash in Admin's Lineage or `GET /api/kohaku/lineage`.
- **Compliance Evidence Pack and AI-generation disclosure**: `kohaku evidence` (built on `@kohaku-ui/lineage`'s `evidence` module) assembles and Ed25519-signs a directory of normalized lineage/promotion/fixation records plus the referenced component artifacts, for handing to an auditor or a compliance team. **This is not legal advice.** Whether and how this evidence helps satisfy a given jurisdiction's transparency obligations for AI-generated content (for example, EU AI Act Article 50's requirement to disclose to natural persons that content is AI-generated or manipulated) depends on your own deployment, audience, and legal counsel — the pack is evidentiary raw material (which tier composed which view, when a human reviewed/fixated it, the artifact content itself), not a compliance certificate, and kohaku makes no claim of conformance with any specific regulation.
  - **Generate a keypair**: `npx @kohaku-ui/cli evidence keygen --out-dir <dir> [--force]` writes `evidence-private-key.pem` (mode 0600 — keep it secret; never commit it, and never place it under a `StoragePort` data directory) and `evidence-public-key.pem`, and prints the derived `keyId`. Refuses to overwrite either file that already exists (each is created with an exclusive OS-level flag, so a concurrent run cannot race the check) unless `--force` is also given, in which case both files are overwritten and `keyId` rotates.
  - **Export a pack**: `npx @kohaku-ui/cli evidence export (--data-dir <dir> | --rest <baseUrl> [--header k:v]) [--tenant <id>] --since <iso8601> --until <iso8601> --private-key <pem> --out <dir> [--allow-incomplete]`. `--data-dir` reads a local `StoragePort` data directory directly (a complete export). `--rest` reads over the existing `KohakuClient` REST surface instead, and — because `GET /fixations`'s response does not carry enough fields to reconstruct a full `FixationRecord` — leaves `fixations.jsonl` empty with a warning recorded on the manifest **and marks the whole manifest `complete: false`**, since an auditor reading `complete` alone (without cross-referencing `warnings`) must not be told this pack is whole; use `--data-dir` against the host's own data directory when you need fixation records included. Pass `--allow-incomplete` only when the backing `StoragePort` has no `pageLineage` (a host that answers `order=asc` with 501); the resulting manifest is marked `complete: false` rather than silently omitting events. **`--tenant` only labels `scope.tenant`; it does not by itself scope a `--rest` export** — the actual scope is whatever the request headers carry. In `--rest` mode, `--tenant` must therefore match a same-valued `--header x-kohaku-tenant:<id>` (case-insensitive header name) you also pass; a conflicting value is rejected, and omitting `--tenant` derives the manifest's tenant label from the header instead. (`x-kohaku-tenant` is a convention of `apps/sample-api`'s `request-identity.ts`, not a protocol-level guarantee — a differently configured host may not honor it at all, so treat the resulting `scope.tenant` label accordingly.)
  - **Size cap**: no single pack file (`events.jsonl`, an artifact, …) may exceed 64 MiB — the same cap `evidence verify` enforces, so a pack that exports always verifies. An export whose window would produce a larger file fails immediately with an error naming the file; narrow `--since` / `--until` (or `--tenant`) and export the range in several packs instead.
  - **Window (`--since` / `--until`)**: each is an ISO 8601 date (`YYYY-MM-DD`) or a timestamp with a `Z` / `±hh:mm` offset; anything else (a time with no offset, `July 9, 2026`, an impossible date, `--since` later than `--until`) exits with code 2 before any key or storage is touched. Values are canonicalized to UTC before they reach the store, so `+09:00` offsets compare correctly. A date-only value is a whole UTC day: `--since 2026-09-01` starts at `00:00:00.000Z`, and `--until 2026-09-30` **includes all of September 30th** (it ends at `23:59:59.999Z`). The manifest's `scope.since` / `scope.until` record the resolved instants. This differs from the REST `GET /lineage` route on purpose: there a date-only `until=2026-09-30` is the instant `2026-09-30T00:00:00.000Z` (so it excludes most of that day), while the same route (and `/analytics/summary`) rejects an impossible date such as `2026-02-30` with 400, just as the CLI does.
  - **`--rest` packs are always incomplete, by design**: over REST `fixations.jsonl` is always empty (`GET /fixations` returns only `{intentHash, canonical, fixatedAt}`, and kohaku does not fabricate the rest of a `FixationRecord` for a compliance artifact), so the manifest is always `complete: false` with a warning, and there is deliberately no dedicated export route to close the gap. For a complete pack, run the export with `--data-dir` against the host's own data directory, or build it in-process from a `StoragePort` with `buildEvidencePack`.
  - **Verify a pack**: `npx @kohaku-ui/cli evidence verify <dir> --public-key <pem>` checks the signature (over the parsed `manifest.json` value, with duplicate object keys rejected — so a field added, removed or retyped after signing fails, and two parsers cannot read different manifests out of the same bytes), the manifest against its strict schema, every listed file's hash, that no signed `*.jsonl` line is unparseable, and independently re-derives each embedded artifact's hash. Exit code 0 = valid, 1 = invalid (tampered or corrupted), 2 = a usage error (bad paths, conflicting flags, a missing or unknown option). Hardened against a tampered or hostile pack directory: `manifest.files[].path` is restricted at parse time to one of the four fixed `*.jsonl` names or `artifacts/<sha256>.html` (no `..`, absolute path, or backslash survives parsing); verification stops immediately — without reading any other file — the moment the signature itself fails to verify; a symlink, FIFO or device node planted at any listed path is refused rather than followed or read; and a pack directory containing any file not listed in `manifest.files` (nor `manifest.json`/`manifest.sig` themselves) fails verification as an unexpected file (a FIFO or device node counts too).
  - **Concurrent writes**: an export walks the lineage log with a forward cursor over the storage backend's sequence numbers. Appends that are sequential, or already committed when a page is read, are never missed or repeated. An append that is still in flight while the export runs (in Postgres, a `bigserial` value handed out but not yet committed; in Redis, an `INCR` value whose `EXEC` has not run) can become visible behind a cursor that has already passed it, and that export will not include it. For a complete pack from a host that is taking writes, set `--until` to a time safely in the past (longer than the slowest in-flight write, for example a few minutes) rather than to "now".
  - **Showing AI-generation disclosure in a rendered view** (off by default): `SpecView`'s `disclosure` prop (renderer-react) or `<kohaku-surface>`'s `disclosure` attribute (renderer-wc) — `"off"` (default, no DOM change), `"attributes"` (machine-readable `data-kohaku-disclosure` / `data-kohaku-tier` / `data-digital-source-type` only, no visible text), or `"label"` (the same attributes plus a visible, localized label — override `RendererMessages.disclosureAiGenerated` / `disclosureAiReviewed` for your own locale/wording). The level is always derived from `spec.provenance`, never carried on the wire (a generation-exhausted fallback is never labeled; a capability-negotiation fallback does not remove the label from a generated Spec) — see [design.md #66](design.md) for the exact derivation rule.
  - **PII caution**: an Intent's `params`, and for a free-text Intent like `sales.custom`, the request string itself, can carry whatever an end user typed (names, account numbers, anything). This text already flows into your lineage log today; the evidence pack exports it verbatim into `events.jsonl` / `approvals.jsonl`, it does not add any new PII exposure by itself. Review your own Intent catalog's `params` shapes and any free-text fields before sharing an exported pack outside your organization — this feature does not redact, hash, or otherwise scrub any field for you (PII redaction is explicitly out of scope for v1; see [design.md #67](design.md)).
- **Correlating logs via `x-request-id`**: every response of the mounted kohaku routes carries an `X-Request-Id` header (echoing the inbound `x-request-id` request header when the caller sends one and it is well-formed, otherwise a freshly generated id). The same id appears on every error envelope's `error.requestId` and is passed to `KohakuHostDeps.onError`, so a support ticket's client-visible id, your server logs, and the `onError` hook's records all line up on one value without extra wiring. Override the resolution via `KohakuHostDeps.requestId` (TS) / `request_id` (Python) if your infrastructure already has its own correlation-id convention to defer to. Feed that same id to `kohaku explain <requestId>` or admin-react's DevTools (§6 "Kohaku DevTools and `kohaku explain`") to see the compose it produced end to end — tier, cache, the cache-key breakdown, the decision flow, and every lineage event.
- **`KOHAKU_DEBUG` (verbose failure logging)**: a project generated by `kohaku init` wires `@kohaku-ui/host-core`'s `createConsoleErrorReporter()` into both `KohakuHostDeps.onError` and the compose observer's `onError` (the generated `server/ports.ts` passes `debug: process.env["KOHAKU_DEBUG"] === "1"` to `createKohakuHost`, which wires it). By default (`KOHAKU_DEBUG` unset, see the generated `.env.example`) each failure logs a one-line summary; `KOHAKU_DEBUG=1` logs the full cause chain instead (`formatErrorChain`/`format_error_chain`, walking `Error.cause`/`__cause__`) plus the stack trace/traceback. `apps/sample-api` and `python/examples/sales-api` wire the same env var into their own logging without changing the default (unset) output. A related, always-on signal regardless of `KOHAKU_DEBUG`: `ComposeErrorContext.failure` (`"transient" | "invalid" | "budget" | "aborted"`) on every `observer.onError` fallback call lets you tell a provider outage apart from a validation failure programmatically, without parsing `reason` — see the troubleshooting row below.
- **Trace context / OTel**: `host-rest` reads an incoming `traceparent` / `tracestate` request header pair (W3C Trace Context) and `host-mcp-apps` reads a tool call's `_meta.traceparent` / `_meta.tracestate` (MCP 2026-07-28 / SEP-414); both feed `ComposeOptions.traceContext`, riding along `ComposeTrace` / `ComposeErrorContext` the same way `correlationId` does — purely additive, no-op if the caller sends neither header. `@kohaku-ui/otel`'s `createOtelComposeObserver()` turns `ComposeObserver` calls into spans (`kohaku.compose`, with `gen_ai.*`/`kohaku.*` attributes — see [design.md#trace-context-otel](design.md#trace-context-otel)) and restores that `traceContext` as the span's parent, so the compose nests under the caller's own trace instead of always starting a fresh root. **kohaku ships no exporter or SDK initialization** — that stays your process's own responsibility (a normal `@opentelemetry/sdk-node` / `@opentelemetry/sdk-trace-node` setup registered once at process start, before any compose runs). A minimal wiring:

  ```ts
  // Your own process bootstrap (not part of kohaku): register a TracerProvider + exporter once,
  // before importing/using anything that calls trace.getTracer(...).
  import { NodeSDK } from "@opentelemetry/sdk-node";
  import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

  const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
  sdk.start();
  ```

  ```ts
  // apps/sample-api's own wiring (compose-context.ts): only when KOHAKU_OTEL=1, combine the OTel
  // observer with the product's own observer via composer's composeObservers.
  import { composeObservers } from "@kohaku-ui/composer";
  import { createOtelComposeObserver } from "@kohaku-ui/otel";

  const observer =
    process.env.KOHAKU_OTEL === "1"
      ? composeObservers(myObserver, createOtelComposeObserver())
      : myObserver;
  ```

  With `KOHAKU_OTEL` unset (or no `TracerProvider` registered), `createOtelComposeObserver`'s default tracer is a no-op — spans are created and immediately discarded, which is a harmless, fully-supported configuration for local development. Every `gen_ai.*` / `kohaku.*` attribute **key name** is independently overridable via `createOtelComposeObserver({ attributes })`, since OpenTelemetry's GenAI semantic conventions are still "Development" status (not a stability guarantee this repo can make on their behalf).

  **To actually try this against sample-api**: the repo carries only `@opentelemetry/api` as a dependency, so first `pnpm add -D @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http` (or swap in a console exporter for a no-infra smoke test). Save the first snippet above as e.g. `otel-bootstrap.ts` inside `apps/sample-api/`, then start sample-api with `NODE_OPTIONS='--import ./otel-bootstrap.ts' KOHAKU_OTEL=1 pnpm --filter @kohaku-ui-sample/api dev` — sample-api runs via tsx, which honors `--import` for a bootstrap module loaded before the app's own code. Success looks like one `kohaku.compose` span per compose call showing up in your exporter's output (console, or your OTLP backend of choice) once you trigger a compose (e.g. load the demo web app or run a `kohaku_compose` MCP call).
- **Body size limits are the product's responsibility; rate limiting is opt-in**: `@kohaku-ui/host-rest` imposes no request body size cap of its own (a library concern belongs one layer up — a reverse proxy, API gateway, or the product's own middleware). Rate limiting is available but off by default: wire `KohakuHostDeps.rateLimiter` (typically `PolicyRuntime.rateLimiter`, see "Policy as Code and rate limiting" above) to get 429 `RATE_LIMITED` on the compose-family routes, or keep it in a proxy instead. The sample wires a 1 MiB cap on `/api/kohaku/*` via Hono's `bodyLimit` middleware (`apps/sample-api/src/app.ts`); an oversized body is rejected with `413` and the standard error envelope before it reaches Intent resolution. Size the cap to your actual payloads (an NL question or an Intent + params is typically well under 1 KiB).
- **Graceful shutdown**: on `SIGINT`/`SIGTERM` the TS samples (sample-api / sample-mcp) stop accepting new connections and let in-flight ones (including open SSE streams) drain for up to `KOHAKU_SHUTDOWN_GRACE_MS` (default 30s; see §9 of [specification.md](specification.md)) before force-exiting. sample-api additionally flips `GET /api/health` to `503 {ok:false, reason:"shutting down"}` immediately on the signal — ahead of the drain window — so a load balancer stops routing new traffic here while the drain proceeds. The Python sample relies on `uvicorn`'s own graceful shutdown, with `timeout_graceful_shutdown=30` passed in code.
- **Conformance check**: after changing the implementation, `node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku`. **When you change spec-core's Zod schemas, regenerate `spec/schemas` with `pnpm --filter @kohaku-ui/spec run generate-schemas` and commit it** (CI checks for drift). GitHub Actions CI (`.github/workflows/ci.yml`) automatically runs `pnpm test`, `pnpm typecheck`, `conformance --self`, and a JSON Schema drift check (fails if the `spec/schemas` regenerated from Zod shows a diff) on every push / PR.

## 8. Troubleshooting

| Symptom | Cause and remedy |
|---|---|
| "Could not render this request" on screen (presentMarkdown) | A deterministic fallback where L1 generation failed validation on both attempts. Check the LLM settings (key, model). For ollama, change to a non-reasoning model. **When the budget guard (`ComposePolicy.budget`) is wired, budget exceedance results in the same screen** (distinguish via the English text "budget exceeded" in `fallback.reason` / `budgetExceeded` in `observer.onError`) |
| `fallback.reason` says "the LLM provider was unavailable" | The LLM never answered at all (a transient provider/config error), not "failed catalog/structure validation" (the LLM answered but its output didn't validate). Check `KOHAKU_LLM_PROVIDER` and the provider API key — see `KOHAKU_DEBUG` above and `observer.onError`'s `ComposeErrorContext.failure`/`error` to inspect the underlying cause |
| Chat / `/intent/normalize` answers 503 `INTERNAL` "LLM provider unavailable" | The LLM provider could not serve Intent resolution (API key not set, provider failure, timeout or abort); Intent resolution cannot degrade without an LLM, unlike Spec generation (which falls back to a deterministic Spec). Check `KOHAKU_LLM_PROVIDER` and the provider API key. The cause is in the server log via `onError` / `KOHAKU_DEBUG=1`, tagged with the `requestId` from the response |
| Chat is always L2 (orange) | NL normalization cannot map to a known Intent. Check the match between `/api/health`'s `intents` and the question, and the model quality |
| It never becomes `cache:HIT` | Check whether the params match exactly (compare the chip's hash). After a bump, dataVersion changes, so a MISS is correct |
| Only the data portion says "data is being updated" | STALE_VERSION (the Spec is old). Re-operating switches to a Spec of the new dataVersion |
| 401 / 403 appears | The capability expired (TTL 600s) → re-compose. Access to an out-of-scope ref is 403 as specified |
| Sporadic failures / extremely slow on ollama | Using a reasoning model / sporadic 400 on structured output. Check `KOHAKU_LLM_MODEL=gemma4:e4b`, etc. + `KOHAKU_LLM_STRUCTURED_MODE=auto` (default) |
| Immediate failure on rate limit (429) / transient 5xx | PROVIDER faults are retried with exponential backoff up to 2 times by default (`KOHAKU_LLM_RETRY_MAX`; within the `KOHAKU_LLM_TIMEOUT_MS` budget). To be aggressive, raise the count and the initial wait (`KOHAKU_LLM_RETRY_INITIAL_MS`). Disable with `0` |
| MCP shows only text, no UI | That itself is by design (fallback). To show UI, a pre-built renderer and an MCP Apps-capable host are needed |
| An MCP custom part becomes an "unimplemented part type" / "the sandbox renderer needs to be injected" notice | By design (the display asymmetry in §5). The MCP shared renderer registers only core parts and does not inject the sandbox. Check the full display on the Web |
| Port conflict (8787 / 5173) | Stop the existing process, or change `PORT` (sample-web/sample-wc's Vite dev proxy reads it from `.env` or the shell — either works — and follows it automatically). If the API runs on a different host than `localhost`, set `KOHAKU_API_URL` (e.g. `http://localhost:9000`) instead — it takes priority over `PORT` for the proxy target |

## 9. FAQ

**Q. Won't the LLM create a different UI every time for the same question?**
A. The first generation can waver, but from the second time on the cache returns the same Spec, so the display does not waver (the body of determinism is the cache). The quality of the first time is also kept in check by deterministic post-processing (chart-type rules, sorting, ID normalization) and golden regression.

**Q. Isn't the sales data (numbers) being passed to the LLM?**
A. It is not. What the LLM sees is only the Intent, the catalog, and **the column metadata (column names and types)**, and the schema enforces that only a `$ref` can be written in the Spec (fixed enum).

**Q. Is the L2 generated HTML safe?**
A. It runs only inside layered defenses: an opaque iframe with `allow-scripts` only, a nonce-only CSP that blocks network I/O, execution in a dedicated Worker with no `document`/assignable `location`/`window.open` of its own (so DOM effects reach the real page only through an allowlisted mutation channel), and an exact-match allowlist for the bridge + quotas. The only path for data is the auditable postMessage bridge.

**Q. My product page sets its own Content-Security-Policy — does the sandbox need anything from it?**
A. The sandbox's `<iframe srcdoc>` inherits the parent page's CSP in addition to its own meta CSP (the stricter of the two always wins per directive). Because the generated widget now runs in a Worker, a parent CSP that restricts `worker-src` must also allow `blob:` (`worker-src blob:`) — otherwise the sandbox's own Worker fails to boot even though every one of the sandbox's own defenses is satisfied. If your page's CSP does not set `worker-src` at all, no change is needed (it falls back to `default-src`, which is typically permissive enough, but check yours).

**Q. Can I use a custom theme / dark mode?**
A. You can. kohaku has **semantic design tokens** (a vocabulary of colors), and `@kohaku-ui/renderer-core` exports the default light/dark themes as `defaultLightTheme` / `defaultDarkTheme`. The Spec is theme-independent (SPEC-ENV-003), so just swapping the tokens takes effect on all parts.

When applying a brand, the standard practice is **"spread the base theme → layer the brand diff on top"** (the sample's `apps/sample-web/src/theme/tokens.ts` follows this form):

```ts
import { defaultDarkTheme, defaultLightTheme } from "@kohaku-ui/renderer-core";
import type { ThemeTokens } from "@kohaku-ui/spec-core";

// place only the mode-independent, safe diff (fixing a mode-specific color here would clobber the dark base)
const brand: ThemeTokens = { "color.primary": "#7c3aed" };

export function buildTheme(mode: "light" | "dark"): ThemeTokens {
  const base = mode === "dark" ? defaultDarkTheme : defaultLightTheme;
  return { ...base, ...brand }; // spread the base first (prevents missing/broken dark keys)
}
```

Pass this to `RendererProvider`'s `theme` (React) / `surface.theme` (Web Components). The color token vocabulary is `color.background` / `color.surface` / `color.text` / `color.muted` / `color.primary` / `color.on-primary` / `color.positive[.surface/.text/.border]` / `color.negative[.surface/.text/.border]` / `color.warning.*` / `color.info.*` / `color.scrim` / `chart.axis` / `chart.palette`, plus the deprecated alias `color.danger`→negative and the reserved `color.focus`→primary.

`color.scrim` (the modal dialog backdrop) has its own light/dark value like any other listed token — it is simply not part of the *L2 generation* vocabulary the model sees, since the sandbox never renders a dialog backdrop (design.md §7.2 has the full default-value table).

You can freely add custom tokens (keys outside the vocabulary) too (`ThemeTokens` is an open type). Non-color tokens (`font.family.*`, `font.size.*`, `space.*`, `radius.*`, `shadow.*`, `motion.*`) are part of the vocabulary too and take CSS strings with units (e.g. `"radius.md": "4px"` for a squarer brand). See design doc §7.2 for the full list of both, their default values, and the dark AA policy.

Non-color tokens shape the built-in parts too (e.g. `"radius.md": "2px"` squares every button and input); the `L2 SANDBOXED` badge can be hidden with `badge="hidden"` on `SandboxFrame` / `context.sandbox.badge` — but hide it only on a surface that signals sandboxing some other way, and if a brand theme overrides `color.warning.surface` / `color.warning.text` (the pill's background/text pair), keep the two readable together, since the badge is the only consumer of that pairing today.

## 10. Static playground

`apps/playground` is a server-free build of the same sample-web UI (`App`, unforked) that runs sample-api's own host entirely inside the browser tab: a fetch shim intercepts every same-origin `/api/*` call and routes it straight to `app.fetch()` running in that tab, backed by an in-memory `StoragePort`, a WebCrypto-backed `AuthzPort` (not `@kohaku-ui/authz-hmac` itself — that package calls `node:crypto`, unavailable in a browser — see design.md decision #57), and a replay-only LLM (`@kohaku-ui/evals/replay`'s `ReplayLlm`) that answers from pre-recorded responses instead of calling a real model. Nothing you do in it reaches a server, and no BYO API key is ever asked for or used.

Today only the Dashboard's 4 L0 fixed-spec views (Quarterly summary, KPI overview, Sales records, Target attainment) actually work end to end, because they never call the LLM at all. The toolbar above the page also lists the L1 / NL / L2 / promotion / fixation scenarios `apps/playground/src/scenarios.ts` defines, each disabled and labeled "awaiting recording" until a matching file exists under `apps/playground/fixtures/`; composing one of them anyway (e.g. by typing a free-form question in Chat that no example button covers) does not break the screen — composer's own deterministic fallback delivers a Spec regardless — but the toolbar shows a one-line notice explaining that the result is a fallback, not a real generation.

Recording those fixtures needs a real LLM once, offline, never from a browser: `apps/playground/scripts/record-fixtures.ts` builds the exact same host (same seed, same fixed clock) with `@kohaku-ui/evals`'s `FixtureLlm` in record mode in front of whatever provider `createLlmFromEnv()` resolves, e.g.

```bash
KOHAKU_LLM_PROVIDER=ollama KOHAKU_LLM_MODEL=gemma4:e4b pnpm --filter @kohaku-ui-sample/playground run record-fixtures
```

and writes `apps/playground/fixtures/<scenario id>.json`. Re-run it for every scenario whose recorded response could be affected whenever you change a prompt-building file (`apps/sample-api/src/design-system.ts`, `apps/sample-api/src/fewshot.ts`, `intents/{catalog,fixed-specs}.ts`, `ports/semantic-port.ts`, or `@kohaku-ui/composer`'s own prompt construction) — a stale fixture does not fail loudly; it just quietly replays yesterday's answer to today's prompt, or (once the two no longer line up at all) falls back the same way an unrecorded one does. `pnpm vitest run --project playground-drift` replays every fixture that does exist against a fresh host (no real LLM) and fails if a recorded response no longer produces the outcome it was recorded for.

To run the playground itself locally: `pnpm --filter @kohaku-ui-sample/playground run dev` (a Vite dev server); `pnpm --filter @kohaku-ui-sample/playground run build` produces the static site (and fails the build outright if anything in it still imports a Node-only module — see that package's `vite/forbid-node-builtins.ts`). It is not deployed anywhere public yet: the GitHub Pages workflow that would publish it exists only as a manual `workflow_dispatch` trigger, not yet enabled.
