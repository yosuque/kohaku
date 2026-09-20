# kohaku User Guide

English | [日本語](user-guide.ja.md)

| Item | Details |
|---|---|
| Last updated | 2026-09-11 |
| Audience | ① People who want to run the sample app and experience the concepts; ② People who want to embed kohaku into their own product |
| Related | For how it works, see [design.md](design.md); for API details, see [specification.md](specification.md) |

---

## 1. What is this

kohaku is a framework that **merges "natural-language questions" and "GUI narrowing operations" into the same normalized Intent**, generates the **same declarative UI Spec**, and renders it with the **same renderer**. A sales-analytics app (API + Web + MCP server) ships with it as a sample.

There are four core things to experience:

1. Whether you ask via chat or narrow via the GUI, **the same screen** appears (R5)
2. The UI Spec **carries no data** (pass-by-reference; the LLM never handles numbers)
3. Requests outside the catalog are **freely generated in a sandbox** (L2) and, after review, are **promoted into official parts** (L1)
4. Frequently used screens are **fixated** and stop going through the LLM entirely (L0)

## 2. Setup

Prerequisites: Node >= 22, pnpm 12 (`npm i -g pnpm`). The minimum requirement is the `engines` field in `package.json` (`node >= 22`), and GitHub Actions CI runs the test and typecheck job on both Node 22 (so the declared floor is actually exercised) and Active LTS Node 24, which is also what the conformance and Python jobs use. `.node-version` (currently 25.7.0) specifies the version for the local development environment (read by nodenv and the like) and is intentionally different from the version CI uses — as long as you meet the minimum, any version works. If a version manager errors with something like "version not installed" because you don't have that exact version, install it (e.g. `nodenv install 25.7.0` / `fnm install 25.7.0`) or use any Node >= 22 you already have instead — the pin is left as-is by design, not a bug to fix. The pnpm version is pinned via `packageManager` in `package.json`.

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

> **About display language**: The demo runs in **English by default**. Selecting **JA** on the header **EN/JA toggle** switches the whole sample-web app: the page chrome (nav, chat, admin), the Spec renderer's messages and formatting locale (via `RendererProvider.messages` / `locale`), the dashboard facet labels (bilingual overlays baked into `facet-views.json`), **and the generated content itself** — the toggle rides `session.locale` on every API call, and the server selects a per-session `ComposePolicy` (JA sets `outputLanguage: "Japanese"` plus Japanese L0 fixed specs, with caches separated per language via a `/ja` generatorVersion token). The dashboard re-composes on toggle; existing chat bubbles keep the language they were composed in (the next question follows the new language). Known limits: data cell values inside charts/tables (region/channel names) stay English (`query://` results are language-neutral by invariant), and so do column headers, KPI labels, and KPI notes coming from the DomainPort (e.g. "Total revenue", "Revenue (JPY)", "No target set") — bilingualizing those DomainPort-sourced labels is a future item. A Spec fixated from EN traffic is not served to JA sessions (they fall through to normal compose). sample-wc still takes `?lang=ja` and switches renderer messages only.

### Dashboard (GUI surface)

In the left panel, you select a **view** (= normalized Intent), and when you change the **filters** (fiscal year, quarter, region, aggregation axis), a GuiAction → normalized Intent → compose runs each time and the screen is assembled.

- The **ProvenanceBadge** at the top tells you "why this screen appeared": tier (L0 = blue / L1 = green / L2 = orange), cache (HIT/MISS/FIXATED), intentHash (click to copy), model, data version.
- "Show Spec JSON" lets you inspect the raw UI Spec. Note that `data` contains only `$ref`.
- The Intent is synced to the URL, so reload, sharing, and "open from chat" all work.
- The **"Add a note" button in the "Records" view** demonstrates the write loop. Opening and closing the confirmation dialog (`overlay.dialog`) is established **by declaration alone** using `$state` + `emit:"state.set"` + `visibleWhen` (with a focus trap and focus return to the invoker), and submitting the note goes `presentForm` → directly to the API (with a capability token, not via the LLM), so **only the table below re-fetches the latest version without swapping the Spec** (small loop). For the steps, see Demo 5.

> **The "Tenant" selector in the top bar** (default / tenant-a / tenant-b) is shared across all pages. The selection rides on every API call as `x-kohaku-tenant`, and the governance/audit plane (Lineage, promotion, fixation) is separated by tenant. The generated result (Spec) is tenant-independent — switching does not change the Dashboard display (the invariant in §6.1: `query://` references are tenant-neutral and do not mix the tenant into the cache key).

> **The "Role" selector in the top bar** (admin / reviewer / viewer) is also shared across all pages. The selection rides on every API call as `x-kohaku-role`, and the server-side declarative RBAC (`createGovernancePolicy`) branches the authorization of governance routes. `admin` permits everything, `reviewer` permits promotion review + Lineage viewing, and `viewer` permits reading only. **Switching to `viewer` makes Admin's approval and deletion operations return 403, and a red error banner appears.** With `admin` (the default), no header is sent and, as before, all operations pass. The role is substituted with a demo header, but in production, resolving it from an authentication foundation (JWT/OIDC, etc.) is a product responsibility.

> **The "☀️ Light / 🌙 Dark" toggle in the top bar** switches the theme mode. The initial value follows the OS's `prefers-color-scheme`, and once you explicitly choose one, it is persisted to `localStorage`. **Parts (the KPI, chart, table, and form that the Spec renders) follow via theme tokens, and the page chrome (header, cards, background, Admin) follows via CSS variables.** The dark palette is measured and adjusted to meet WCAG AA (body text ≥ 4.5:1 / UI ≥ 3:1). In the same mode, the rendering of Web (React) and Web Components (sample-wc) is pixel-identical (§7.2).

### Chat (NLUI surface)

When you ask in natural language, a **normalization chip** (canonical / params / hash) is shown first, and then the screen is synthesized by the same Composition Service. If you ask a question with the same content as on the Dashboard, the hashes match and it becomes `cache:HIT`. The "Open in Dashboard →" link lets you re-experience the identical display.

On slow-generating paths (such as the first time for L1), a loading skeleton appears immediately, and **parts are rendered progressively as they become ready from the LLM's partial output** (progressive streaming — only when the provider supports a native structured-output stream; on the prompt-JSON fallback, it becomes a two-stage skeleton → finalized form).

### Admin (governance plane)

- **View Lineage**: Event Sourcing of the UI Spec. Every compose / operation / promotion / fixation is visible as an event sequence.
- **Analytics**: An overview aggregated from the raw event sequence (`GET /api/kohaku/analytics/summary`). It displays the fallback rate, tier distribution (L0/L1/L2), cache breakdown (hit/miss/bypass/fixated), latency quantiles (p50/p95/p99), top frequent intents, and the number of promotion/fixation events as a table with inline bars. It states clearly at the top of the screen that **the aggregation is based on a window of the most recent 200 events (default)**, and if the window cap is reached, that note appears too (not a silent cap). Authorization is a read operation (`analytics.read`), so admin/reviewer/viewer can all view it.
- **Promotion review (L2→L1)**: A candidate list of freely generated parts. Check the HTML source + **"▶ Preview" renders the actual review target itself** (mounting the recorded artifact directly into the same isolated iframe as the chat surface — the identity between the approval target and what is displayed is guaranteed by sha256) → finalize the schema (componentType / intentName / description) → "Approve and register". **The `status` selector at the top lets you filter by state** ("All" digs up candidates via `POST /promotions/evaluate`; a specific state is read-only via `GET /promotions?status=`). On a candidate card, **"Request changes (send back)" drops it to `changes_requested`**, and after fixing it, **"Re-submit and approve" returns it to candidate and restores it up through publish** (the recovery path from a send-back). In `changes_requested`, no rejection is offered, and abandonment is unified into "withdraw".
- **Fixation (L1→L0)**: Candidates from frequent L1 Intents (usage count, structural stability) → "Fixate to L0".
- "Simulate data update (bump)": Advances the dataVersion to reproduce cache invalidation.
- All four tabs are scoped by the **tenant** selected in the top bar (switching re-fetches each list, and you can see that they are separated per tenant). The Analytics tab's aggregation also targets only the events of the selected tenant.
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
3. Admin → Promotion review: on the candidate card, **verify the appearance and behavior with "▶ Preview (rendered in an isolated iframe)"** and check the code with "Generated HTML source" → componentType `sales.calendarHeatmap` / intentName `sales.calendar_heatmap` (prefilled for a heatmap request) → **"Approve and register"** (Preview returns 403 in the `viewer` role — because it involves issuing a data read capability)
   - Behind the scenes, an LLM-as-Judge (5 aspects) → human approval (this click) → schema finalization → publish runs, and each step is recorded in Lineage.
4. Ask the same question in Chat → this time it normalizes to `sales.calendar_heatmap` and is rendered as **L1 (green) + native implementation**. **The promotion persists even if you restart the API**: the snapshot (`apps/sample-api/.data/promotions.json`) is authoritative, and a startup reconcile rebuilds the catalog/Intent projection from it
5. The same "creation" can be triggered from an external chat (MCP) too (→ §5). Uses via `kohaku_compose` are also tallied into the same promotion counter (reflected after the API server restarts — see §5)

### Demo 4 — Interaction loop and fixation

1. In the Quarterly Summary table, click the "Japan" row → `intent.patch` → it switches to the "Japan × by product" view (`view.interacted` in Lineage)
2. Display the "Trend" view (L1) three or more times → Admin → a candidate appears in Fixation (structural stability 100%) → approve → thereafter it is **`L0 cache:FIXATED`** (does not pass through the LLM, structure fixed, data always up to date via pass-by-reference)

### Demo 5 — Write loop (small loop = only the table updates in place)

1. Dashboard: in the left panel, select the **"Records" view** → an **"Add a note" button** appears above the table → pressing it opens a confirmation dialog (`overlay.dialog`) with a note form inside (opening/closing is declaration-only, `state.set` + `visibleWhen`)
2. Enter a note (e.g., "Check North America's growth") → **"Save"**. In DevTools → Network there is a single `/binding/action` (`Authorization: Bearer …`, body `{action:"annotate", payload:{note, refs}}`)
3. **The Spec is not swapped**, and only the table below re-hits `/binding/resolve` with a new data version (the badge's data version advances). A completion banner at the top of the page
4. The write goes part → directly to the API, and **never flows into the LLM's context** (the generating LLM is the "plumbing," the written data is the "water"). Since the capability returned by compose covers not only read (`$ref`) but also the declared write (`annotate`), it fires without issuing an additional token

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

### Host support table

| Host | Connection method | Rendering |
|---|---|---|
| **Claude Desktop** | Local stdio (`start`) | Same rendering as Web via MCP Apps (iframe) |
| **claude.ai / ChatGPT** | Streamable HTTP (`start:http`) + remote connector via a public tunnel | Same rendering as Web via MCP Apps (iframe). ChatGPT requires enabling **developer mode**. In ChatGPT, on re-open, the previous view is instantly restored from widgetState. On fullscreen-capable hosts, a fullscreen toggle appears at the top right of the widget |
| **Terminals such as Claude Code / Codex CLI** | Local stdio / Streamable HTTP | iframe rendering is not possible → received via the **self-contained HTML** of `kohaku_render_snapshot` |
| **mcp-ui legacy hosts (LibreChat / Smithery / Nanobot, etc.)** | stdio / Streamable HTTP + `KOHAKU_MCP_LEGACY_UI=1` | Even without SEP-1865 support, statically renders the `ui://` UIResource (self-contained snapshot) attached to the tool result. Because it becomes **about 1 MB per result**, do not enable it on modern hosts (Claude / ChatGPT) |

On any path, build the shared renderer in advance for UI display (both iframe rendering and the snapshot use the same bundle).

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

### claude.ai / ChatGPT (Streamable HTTP + public tunnel)

claude.ai / ChatGPT cannot connect to local stdio and can only connect via a **remote MCP connector (Streamable HTTP)**. Start the HTTP entry, expose the URL with a public tunnel, and register it with the connector.

```bash
pnpm --filter @kohaku-ui-sample/mcp start:http        # listens on the default :8788 (path is /mcp)
# To use a different port: KOHAKU_MCP_HTTP_PORT=9000 pnpm --filter @kohaku-ui-sample/mcp start:http
cloudflared tunnel --url http://localhost:8788      # open a public tunnel in a separate terminal (ngrok, etc. also work)
```

Register the URL — the `https://<random>.trycloudflare.com` the tunnel hands out with `/mcp` appended — with the host's custom connector (claude.ai) / MCP server (ChatGPT's developer mode).

> ⚠️ **This is a no-auth demo.** This HTTP entry has no authentication whatsoever. Once exposed via a public tunnel, **anyone who knows the URL can view and operate the sales data**. Hand the URL only to trusted parties, and do not put sensitive data on it. When you stop it, close the tunnel too. DNS rebinding protection, which rejects Host spoofing from the browser, is enabled only when you pass `KOHAKU_MCP_HTTP_ALLOWED_HOSTS` (comma-separated), but via a public tunnel the Host becomes the tunnel's domain, so it is disabled by default. To wire real authentication, resolve the caller's identity per tool call via `McpHostDeps.resolvePrincipal` (TS) / `resolve_principal` (Python) — e.g. reading a bearer token off the request and looking up the corresponding `Principal` — rather than a single static `McpHostDeps.principal`, since every connection on a shared HTTP server shares one `McpHostDeps` and a static `principal` would give every caller the same identity.

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
- **However, there is an asymmetry in displaying custom parts**: the shared renderer (`apps/sample-mcp/renderer/main.tsx`) registers only the core-part implementations and does not inject the sandbox renderer (`renderSandbox`) either. Therefore, on the MCP side, an L2-generated part becomes a "the sandbox renderer needs to be injected" notice, and contribution/promotion parts (`sales.kpiCard` / `sales.calendarHeatmap`) become an "unimplemented part type" notice (since sample-mcp does not declare `SurfaceCapabilities`, the server-side degradation to fallback〈negotiate〉 does not run either). For the full display of custom parts (sandbox iframe, native implementation), check on the Web surface.

## 6. Embedding it into your own product

You can adopt it in stages along the adoption ladder (design doc §12 "Design of the sample implementation").

**Dependency method**: `@kohaku-ui/*` packages are published to npm. In a standalone app, `npm install @kohaku-ui/host-rest @kohaku-ui/registry @kohaku-ui/llm zod` (add `@kohaku-ui/composer`, `@kohaku-ui/renderer-react react react-dom`, etc. as you reach the later steps below) and import them normally — each package's `publishConfig` points `exports` at its `dist` build, so this works outside the monorepo with no extra setup. If you are instead building your app **inside this monorepo** (e.g. to contribute back, or to iterate against `src` without a publish step), add it under `apps/<your-app>`, reference the packages as `workspace:*` in its `package.json`, and run it with `tsx` (packages export `.ts` directly in that case — there is no `dist` build to consume from outside the workspace). The generated `server.ts` below assumes the npm-install path; swap the comment's dependency line for `workspace:*` if you took the monorepo path instead.

### Step 0 — Server-Driven UI without an LLM

```bash
node cli/bin/kohaku.js scaffold ports --out ./my-app/kohaku
```

Implement the four Ports in the generated `ports.ts`. At first:

1. **DomainPort**: implement aggregation queries as `op` (returning TabularData is recommended)
2. **SemanticPort**: `normalize` is only the deterministic mapping of GUI operations; `resolveQuery` is Intent → a `query://` handle
3. **AuthzPort**: you can reuse the sample's HMAC implementation (`apps/sample-api/src/ports/authz-port.ts`, about 50 lines)
4. **StoragePort**: in-memory is enough at first (a sample of file persistence is `apps/sample-api/src/ports/storage-port.ts`)

If you register fixed Spec templates (the sample is `apps/sample-api/src/intents/fixed-specs.ts`) in composer's `policy.fixedSpecs`, a Server-Driven UI via renderer-react works **without an LLM**.

### Step 1 — L1 declarative synthesis and chat

- **Define the Intent catalog in a single place (`@kohaku-ui/intents`)**: with `defineIntent`, make it 1 Intent = 1 definition (sample: `apps/sample-api/src/intents/catalog.ts`). Unify value sets into a single source with `defineVocabulary("region", { japan: "Japan", north_america: "North America", ... })`, and when you declare `params` (Zod) / `examples` (NL example sentences) / `facets` (params to expose to the GUI) / `queries` (a template or callback), the same definition derives `.toIntentDef()` (for SemanticPort), `.toFacetView()` (GUI facet), `.toToolSource()` (MCP tool), and `.parseParams()` (coerce + default). The facets to expose to the GUI are written out to `facet-views.json` by codegen (`pnpm intents:emit`), and the web imports it as data (the web stays independent of server code).
- Implement the NL side of `SemanticPort.normalize` with `@kohaku-ui/llm` (sample: `apps/sample-api/src/ports/semantic-port.ts` — transcribes the Intent catalog into the prompt and maps it with structured output; failure falls back to `*.custom`)
- Implementing `describeShape` makes the deterministic post-processing of chart-type rules and default sorting take effect
- Contribute domain parts with `CatalogContribution` (`defineComponent` + the renderer implementation's `registry.register`)

### Step 2 — L2, promotion, and fixation (complete form)

- `policy.allowL2: true` + a catch-all Intent (`*.custom`) + `routeTier`
- Inject `createLineage` / `createPromotions` (implement the reflection into the catalog and Intent in `onPublish`) / `createFixations` into host-rest's deps
- Adjust the promotion threshold and the judge's passing score via policy (human review cannot be removed)

### Applying a design system to L2

A three-part set (plus an optional fourth step to bring your own design kit) for making your product's design system take effect on L2 free generation (custom components). The generated artifact is written not with hardcoded colors but with token references `var(--kohaku-*)`, and the values are injected at render time, so it **follows light/dark switching and brand changes without regeneration**.

1. **Define the design system and wire it to the compose policy** (sample: `apps/sample-api/src/design-system.ts`):

```ts
import { DEFAULT_KIT_VOCABULARY, type DesignSystemGuide } from "@kohaku-ui/composer";

const designSystem: DesignSystemGuide = {
  // custom tokens added to the default token vocabulary (the full KnownThemeTokens), and description overrides (optional)
  tokens: { "brand.accent": "accent color (badges, highlights)" },
  // the design kit vocabulary (component classes + utilities the model composes with); the built-in kit
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

3. **(Optional) Bring your own kit**: pass your vocabulary as `designSystem.kit` (`{ id, version, classes, utilities, namespaces }`) and your stylesheet as `kitCss` (`SandboxFrame`'s prop / `context.sandbox.kitCss` on `<kohaku-surface>`). Write the CSS so every colour is a `var(--kohaku-color-*)` reference or `currentColor` — no raw colour values. Dimensions should be tokens too, except for deliberate literals like the built-in kit's own (hairline 1px borders, the 2px focus ring, the 480px grid breakpoint, SVG chart geometry); layout and effects such as `display:flex`, `color-mix()`, and `filter` are unrestricted — the shipped kit uses all three. Brand web fonts can be embedded as `@font-face` data URIs. `kitCss: ""` disables the built-in kit entirely. Bump `version` (and `generatorVersion`) when class semantics change.

4. **Verify**: L2 generation (e.g., a free-form request in chat) → if the generated HTML uses `var(--kohaku-color-*)` and the header's theme switch makes the custom component's palette follow, it is OK. If hardcoded colors slip in, they are automatically retried for repair as `L2_RAW_COLOR`; an unrecognized kit-namespaced class name is retried the same way as `L2_UNKNOWN_CLASS`.

Even without specifying a theme, a default light theme is always injected into the sandbox, so `var()` never falls to undefined. The Python implementation (`python/kohaku`) has the same feature too (`ComposePolicy(designSystem=DesignSystemGuide(...))`) (sample: `python/examples/sales-api/src/sales_api/design_system.py`).

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
- **Governance**: `client.catalog()` / `client.lineage()` / `client.telemetry()` / `client.promotions.*` / `client.fixations.*` are typed.
- **The fetch thunk to pass to renderer-react's `useSpecStream`** is obtained via `client.composeStreamRequest(req)`.
- **Routes outside the SPEC** (your own `/health`, etc.) are called via the escape hatch `client.request(path, init?)` (the headers hook works, but JSON parsing and error conversion do not).
- The sample's wiring is `apps/sample-web/src/kohaku/client.ts` (a thin wrapper around the SDK to match the sample-specific call shapes).

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
// Web side: registry.register("myapp.card", "1.0.0", MyCardComponent)  // fetch data with useBoundData
```

Validation: `node cli/bin/kohaku.js component validate <definition.json>`. The minimal definition.json that passes validation (`type` is a dot-separated identifier, `version` is semver, `propsSchema` is a JSON Schema of `type: "object"`, and `capabilities.data` requires one of `none | optional | required`):

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

### Getting started with golden regression

Fix the "structure" of input Intent → generated Spec as a regression. Generate a template:

```bash
node cli/bin/kohaku.js scaffold golden --out ./my-app/test   # golden.test.ts + golden/README.md
```

Wire your product's `ComposeContext` into the generated `golden.test.ts`'s `makeContext`, place `{name,input,drafts,expected:null}` JSON under `golden/`, and generate `expected` with `KOHAKU_GOLDEN_UPDATE=1 <run the test>`. Subsequent tests are deterministic and LLM-free, because `@kohaku-ui/evals`'s `runGolden` normalizes the jitter of provenance / intent.hash / dataVersion / refVersions and component IDs and compares only the structure (responses feed `drafts` to the FakeLlm; if you need a live recording, use FixtureLlm's record/replay). A working example is `apps/sample-api/test/golden.test.ts` (fixing the L1 generation of `sales.trend`). If you intentionally change the UI, regenerate `expected` with the same update procedure, review the git diff, and commit.

## 7. Operational tips

- **Cache and data updates**: The Spec cache key is intent + dataVersion + catalog fingerprint (+ an optional generatorVersion). The granularity of `SemanticPort.dataVersion` (whole / per-table / event-driven) directly becomes the invalidation strategy. The sample is whole-at-once + bump.
- **Cache invalidation and cap**: Since the key includes dataVersion / catalog fingerprint / generatorVersion, data updates, part publication, and prompt revisions automatically become separate entries via key changes. Therefore, active cache invalidation (deletion) is in principle unnecessary. The TTL is not freshness control but insurance for memory reclamation; if unspecified, entries are held indefinitely. The sample's `StoragePort` is an in-memory Map, and when the entry cap (default 500) is exceeded, the least recently referenced key is dropped by LRU. Set the cap high enough to cover "the set of simultaneously live intent × dataVersion combinations"; if you need permanent retention or a large number of entries, swap in a Redis / DB implementation on the product side.
- **Cache backend failures (`ComposePolicy.cacheFailure`)**: If the `StoragePort` backing the Spec cache is itself unavailable (a Redis outage, say), `getSpecCache`/`putSpecCache` throwing is fail-open by default (`cacheFailure` unset, equivalent to `"open"`): a lookup failure is treated as a miss and a store failure is skipped, so generation still proceeds and a Spec is still delivered; each occurrence is reported to `observer.onError` with `phase:"cache"`. Set `cacheFailure: "closed"` when the identical-display guarantee must be strict and a cache outage should fail the request instead of silently degrading.
- **Operating promotions**: Becoming a candidate is automatic from usage logs; approval is always human. The judge can be selected by policy to be "advisory" (send to review even on failure) or "blocking". A published part changes the catalog fingerprint, so it does not mix with the old cache.
- **Exporting fixated Specs as a distillation dataset**: a `FixationRecord.pinnedSpec` is a human-approved `{components, events}` pair for its Intent — the best available teacher example for distilling a smaller model on catalog-constrained declarative UI generation. `node cli/bin/kohaku.js dataset export --fixations <fixations.json> [--golden <dir>] [--tenant <id>] --out <file.jsonl>` reads a `fixations.json` snapshot (sample-api's `.data/fixations.json` can be passed directly; the on-disk shape is `{key -> FixationRecord}`, one entry per (tenant, intentHash) — see `apps/sample-api/src/ports/storage-port.ts`) plus, optionally, golden regression Specs from a directory (`--golden`, accepting either `scaffold golden`'s `{name, input, drafts, expected}` fixture files or plain `UISpec` JSON files — a fixture whose `expected` has not been generated yet is silently skipped), and writes one canonical-JSON line per Spec to the given path: `{intent, refs, shape?, target: {components, events}, source: "fixation"|"golden", meta: {fixatedAt?, structureHash?, tenant?, catalogFingerprint?}}`. `kohaku` (the protocol-envelope version), `provenance`, and `dataVersion` are deliberately excluded — they are filled in by composer around the model's actual output, not something a distilled model should learn to reproduce. `--tenant <id>` restricts the export to that tenant's fixations (golden Specs carry no tenant and are always included); without it, the output spans every tenant present in `--fixations`, distinguishable afterward only via each line's `meta.tenant`. An entry that fails `FixationRecordSchema` (e.g. hand-edited or pre-migration) is skipped rather than aborting the whole export — the skipped count is reported on stderr and in the command's output, so one bad entry no longer blocks the rest of the dataset. Entries are sorted by `(intentHash, source)` ascending — a `fixation` entry orders before a `golden` entry sharing the same intentHash — so re-running the export is byte-identical (see `@kohaku-ui/evals`'s `exportDistillationDataset` / `kohaku.evals.export_distillation_dataset` for programmatic use, e.g. to supply a `describeShape` callback for column metadata or a `tenant` filter).
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
- **Compose-wide deadline (a safety valve against a slow/hung LLM call)**: the sample wires `ComposePolicy.budget.deadlineMs` via `KOHAKU_COMPOSE_DEADLINE_MS` (`apps/sample-api/src/app/compose-context.ts`'s `composeDeadlineMs`; default 240000ms), so a single `compose`/`composeStream` call can never hang indefinitely — on expiry it aborts the in-flight LLM call and downgrades to the deterministic fallback exactly like a `perCompose` token-budget overage. The default covers one straight-to-L2 run (`sales.custom`'s ~180s L2 timeout under the default 3× `outputBudgetFactor` widening of `KOHAKU_LLM_TIMEOUT_MS`) plus headroom for a repair retry; widen it if your own L2 prompts routinely run longer. The Python sample mirrors this via `ComposePolicy(budget=ComposeBudget(deadline_ms=...))` in `python/examples/sales-api/src/sales_api/app.py`.
- **Measure before touching prompt caching or `refConstraint`**: kohaku's default `data.$ref` enforcement (`ComposePolicy.refConstraint: "schema"`) pins `data.$ref` to a per-Intent enum in the L1 generation schema — which also means a provider that caches structured-output grammar compilation (Anthropic) recompiles on nearly every distinct Intent rather than reusing a prior compile. Two independent, opt-in escape hatches exist, both defaulted off, and neither should be flipped without first measuring your own model/provider/traffic mix:
  - `KOHAKU_LLM_PROMPT_CACHE=1` (Anthropic `claude` only; no-op for other providers) marks the byte-stable prefix of the L1/L2 prompt (everything but the trailing repair-feedback section) with `cache_control`, so a repair re-attempt within the same compose call can reuse the cached prefix instead of reprocessing it. Anthropic silently ignores a cache breakpoint placed on a prefix shorter than a per-model minimum (roughly a thousand tokens and up, depending on the model) — harmless, but on a small catalog with no few-shot examples the cacheable prefix may fall under that minimum, in which case enabling the flag has no measurable effect at all. Check the prefix's actual token count against your model's minimum before concluding the flag "doesn't work."
  - `ComposePolicy.refConstraint: "validate"` relaxes the generation schema's `data.$ref` to a plain string (an Intent-independent grammar reusable across composes, not just repair retries) and instead validates set-membership explicitly after generation (`DATA_REF_UNRESOLVED`, fed into the existing repair loop).
  - Run `KOHAKU_LLM_PROVIDER=claude KOHAKU_LLM_MODEL=<your model> ANTHROPIC_API_KEY=<your key> pnpm --filter @kohaku-ui-sample/api run measure-grammar-latency` (`apps/sample-api/scripts/measure-grammar-latency.ts`) against your actual model before deciding whether either escape hatch is worth turning on for your deployment — this script calls a real LLM and is intentionally excluded from `pnpm test`. Every row is expected to read `provenance.cache: "bypass"` — that is not a comparison axis, it is a check that the LLM path actually ran; without a valid API key the `claude` provider only warns at startup and falls through to the deterministic fallback, so a missing key shows up as a much *faster* run with the `tier` column reading `L0`/fallback instead of `L1` rather than as an error — always check `tier` before trusting the latency numbers. See the script's own header comment for how to read the table (the 24h Anthropic grammar cache means the first-vs-second call of the *same* Intent does not separate the two modes) and [design.md#prompt-caching](design.md#prompt-caching) for the full trade-off.
- **Audit**: "Why this screen appeared" can be traced via specHash / intentHash in Admin's Lineage or `GET /api/kohaku/lineage`.
- **Correlating logs via `x-request-id`**: every response of the mounted kohaku routes carries an `X-Request-Id` header (echoing the inbound `x-request-id` request header when the caller sends one and it is well-formed, otherwise a freshly generated id). The same id appears on every error envelope's `error.requestId` and is passed to `KohakuHostDeps.onError`, so a support ticket's client-visible id, your server logs, and the `onError` hook's records all line up on one value without extra wiring. Override the resolution via `KohakuHostDeps.requestId` (TS) / `request_id` (Python) if your infrastructure already has its own correlation-id convention to defer to.
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

  **To actually try this against sample-api**: the repo carries only `@opentelemetry/api` as a dependency, so first `pnpm add -D @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http` (or swap in a console exporter for a no-infra smoke test). Save the first snippet above as e.g. `apps/sample-api/otel-bootstrap.ts`, then start sample-api with `NODE_OPTIONS='--import ./otel-bootstrap.ts' KOHAKU_OTEL=1 pnpm --filter @kohaku-ui-sample/api dev` — sample-api runs via tsx, which honors `--import` for a bootstrap module loaded before the app's own code. Success looks like one `kohaku.compose` span per compose call showing up in your exporter's output (console, or your OTLP backend of choice) once you trigger a compose (e.g. load the demo web app or run a `kohaku_compose` MCP call).
- **Body size limits and rate limiting are the product's responsibility**: `@kohaku-ui/host-rest` imposes no request body size cap or rate limit of its own (a library concern belongs one layer up — a reverse proxy, API gateway, or the product's own middleware). The sample wires a 1 MiB cap on `/api/kohaku/*` via Hono's `bodyLimit` middleware (`apps/sample-api/src/app.ts`); an oversized body is rejected with `413` and the standard error envelope before it reaches Intent resolution. Size the cap to your actual payloads (an NL question or an Intent + params is typically well under 1 KiB) and add rate limiting at the same layer if you need it.
- **Graceful shutdown**: on `SIGINT`/`SIGTERM` the TS samples (sample-api / sample-mcp) stop accepting new connections and let in-flight ones (including open SSE streams) drain for up to `KOHAKU_SHUTDOWN_GRACE_MS` (default 30s; see §9 of [specification.md](specification.md)) before force-exiting. sample-api additionally flips `GET /api/health` to `503 {ok:false, reason:"shutting down"}` immediately on the signal — ahead of the drain window — so a load balancer stops routing new traffic here while the drain proceeds. The Python sample relies on `uvicorn`'s own graceful shutdown, with `timeout_graceful_shutdown=30` passed in code.
- **Conformance check**: after changing the implementation, `node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku`. **When you change spec-core's Zod schemas, regenerate `spec/schemas` with `pnpm --filter @kohaku-ui/spec run generate-schemas` and commit it** (CI checks for drift). GitHub Actions CI (`.github/workflows/ci.yml`) automatically runs `pnpm test`, `pnpm typecheck`, `conformance --self`, and a JSON Schema drift check (fails if the `spec/schemas` regenerated from Zod shows a diff) on every push / PR.

## 8. Troubleshooting

| Symptom | Cause and remedy |
|---|---|
| "Could not render this request" on screen (presentMarkdown) | A deterministic fallback where L1 generation failed validation on both attempts. Check the LLM settings (key, model). For ollama, change to a non-reasoning model. **When the budget guard (`ComposePolicy.budget`) is wired, budget exceedance results in the same screen** (distinguish via the English text "budget exceeded" in `fallback.reason` / `budgetExceeded` in `observer.onError`) |
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

Pass this to `RendererProvider`'s `theme` (React) / `surface.theme` (Web Components). The color token vocabulary is `color.background` / `color.surface` / `color.text` / `color.muted` / `color.primary` / `color.on-primary` / `color.positive[.surface/.text/.border]` / `color.negative[.surface/.text/.border]` / `color.warning.*` / `color.info.*` / `chart.axis` / `chart.palette`, plus the deprecated alias `color.danger`→negative and the reserved `color.focus`→primary. You can freely add custom tokens (keys outside the vocabulary) too (`ThemeTokens` is an open type). Non-color tokens (`font.family.*`, `font.size.*`, `space.*`, `radius.*`, `shadow.*`, `motion.*`) are part of the vocabulary too and take CSS strings with units (e.g. `"radius.md": "4px"` for a squarer brand). See design doc §7.2 for the full list of both, their default values, and the dark AA policy. Non-color tokens shape the built-in parts too (e.g. `"radius.md": "2px"` squares every button and input); the `L2 SANDBOXED` badge can be hidden with `badge="hidden"` on `SandboxFrame` / `context.sandbox.badge`.
