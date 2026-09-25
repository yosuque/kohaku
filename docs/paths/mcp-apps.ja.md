# パス (a): MCP Apps だけ

[English](mcp-apps.md) | 日本語

**対象:** 自分の MCP サーバーのツールに、文字の壁ではなく*画面*で答えさせたい(Claude Desktop / claude.ai / ChatGPT で)、そしてその画面が毎回同じであってほしい MCP サーバー作者。Web アプリは要りません。チャットホストが UI です。

**所要時間目安:** 呼べるデータ API があれば、ウィジェットを描画する型付きツールまで約 20 分。

## 最初のコード

```bash
npm install @kohaku-ui/host-mcp-apps @kohaku-ui/registry @kohaku-ui/intents @kohaku-ui/llm @kohaku-ui/spec-core @modelcontextprotocol/server zod
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # 4 つの Port を埋めるためのファイル
```

```ts
import { readFile } from "node:fs/promises";
import { attachKohakuToMcpServer, intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { intents } from "./kohaku/intents.js"; // your Intent catalog (defineIntent)
import {
  authzPort as authz,
  domainPort as domain,
  semanticPort as semantic,
  storagePort as storage,
} from "./kohaku/ports.js"; // your four Ports (kohaku scaffold ports)

// The same Composition Service a REST host would use: one Spec per Intent, cached, whoever asks.
const compose = { catalog: resolveCatalog(coreCatalog), semantic, storage, llm: createLlmFromEnv() };
const server = new McpServer({ name: "my-product", version: "0.1.0" });
attachKohakuToMcpServer(
  server,
  { compose, domain, authz, querySource: "my-product" },
  {
    // The shared renderer bundle the host shows in its iframe (built once; see "The renderer" below).
    rendererHtml: () => readFile("./renderer/index.html", "utf8"),
    // One typed MCP tool per Intent (sales.summary → sales_summary), input schema derived from the Zod params.
    intentTools: intentToolsFromCatalog(intents.map((i) => i.toToolSource())),
  },
);
await server.connect(new StdioServerTransport());
```

ホストに登録し(Claude Code / Claude Desktop なら `claude mcp add my-product -- node ./server.js`)、`sales_summary` を呼びます。ホストは UI Spec とテキスト要約を受け取り、MCP Apps 対応ホスト(Claude Desktop / claude.ai / ChatGPT)は同梱レンダラーで Spec を iframe に描画し、iframe を描画できないターミナルホスト(Claude Code / Codex CLI)はテキストのフォールバックと、自己完結 HTML が要るなら `kohaku_render_snapshot` を受け取ります。

この 3 つの正体:

- **`ports.ts`** — 4 つの Port: `domain`(あなたのデータ API: `listOperations` / `invoke`)、`semantic`(Intent → `query://` ハンドルと `dataVersion`)、`authz`(capability トークン。サンプルの約 50 行の HMAC 実装は `apps/sample-api/src/ports/authz-port.ts`)、`storage`(最初はインメモリの Map で十分)。`kohaku scaffold ports` がメソッドごとに TODO 付きのファイルを書き出します。各 Port の歩き方は[ユーザーガイド §6 Step 0](../user-guide.ja.md#step-0--llm-なしの-server-driven-ui)。
- **`intents.ts`** — Intent ごとに `defineIntent` を 1 回: 正規名、Zod の `params`、NL の `examples`、`queries`。MCP ツール・その入力スキーマ・SemanticPort 定義はすべてこの単一定義から導出されます。
- **`createLlmFromEnv()`** — `KOHAKU_LLM_PROVIDER` とプロバイダのキー(Claude / OpenAI / Gemini / Ollama / llama.cpp)を読みます。`policy.fixedSpecs` に固定 Spec を登録すれば、その Intent はモデルにまったく届かず、それでもウィジェットは描画されます。

## レンダラー

iframe には共有レンダラーが**自己完結の HTML 1 ファイル**として必要です(`rendererHtml`)。現状このバンドルはリポジトリのサンプルからビルドします(`pnpm --filter @kohaku-ui-sample/mcp build:renderer` → `apps/sample-mcp/dist/renderer/index.html`。ソースは `apps/sample-mcp/renderer/` にある React ウィジェットで、小さな `apps/sample-mcp/vite.renderer.config.ts`(Vite + `vite-plugin-singlefile`)が `@kohaku-ui/renderer-react` を包んでビルドします)。そのビルド成果物をサーバーの隣にコピーするか、`apps/sample-mcp/renderer/` とその Vite 設定を自分のプロジェクトにコピーしてビルドしてください。ホストごとの詳細(stdio と Streamable HTTP、claude.ai / ChatGPT 用のトンネル、スナップショットのフォールバック)は[ユーザーガイド §5](../user-guide.ja.md#5-外部チャットmcpから使う)にあります。

## 何もしなくても得られるもの

- **同一表示**: 同じ Intent は、`sales_summary` の引数から来ても `kohaku_compose` の自然言語から来ても同じ Spec になります — キャッシュされ、2 回目は `provenance.cache: "hit"`。
- **モデルのコンテキストにデータが入らない**: Spec が運ぶのは `query://` 参照で、ウィジェットはその参照にスコープされた capability を使い、app-only の `kohaku_resolve_binding` ツール経由で行データを取得します。モデルに戻るのは「ユーザーが今見ているもの」のテキスト要約だけです。
- **ホストのテーマに追従**: ホストが `hostContext.theme` や標準の `--color-*` スタイル変数を提供していれば、ウィジェットは設定なしでそれを取り込みます。提供していなければ kohaku のデフォルトのライトテーマにフォールバックします。

## 次のステップ

- 同じ Spec を Web アプリにも配信する: [パス (b)](react-dashboard.ja.md)(React レンダラー)と REST プロファイルの `@kohaku-ui/host-rest`。
- カタログの範囲内でモデルに合成させ、モデルの発明を統制する: [パス (c)](full-stack.ja.md)。
- リモートホスト向け Streamable HTTP、ターミナル向け `kohaku_render_snapshot`、レガシーの `ui://` リソース: [ユーザーガイド §5](../user-guide.ja.md#5-外部チャットmcpから使う)。参照配線は `apps/sample-mcp/src/setup.ts`。
