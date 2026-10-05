# パス (a): MCP Apps だけ

[English](mcp-apps.md) | 日本語

kohaku は、LLM が生成した UI を本番で統制下に置きます。同じ要求には、同じデータ版である限り同じ画面を返し、行データはモデルに渡らず、モデルが発明したものは、正式な部品になる前にレビューを通ります。

**対象:** 自分の MCP サーバーのツールに、文字の壁ではなく*画面*で答えさせたい(Claude Desktop / claude.ai / ChatGPT で)、そしてその画面が毎回同じであってほしい MCP サーバー作者。Web アプリは要りません。チャットホストが UI です。

**所要時間目安:** 呼べるデータ API があれば、ウィジェットを描画する型付きツールまで約 20 分。すでにデータファイルがあるなら `npx @kohaku-ui/cli init --mcp --from data.csv --out app` が一発で全部生成します — 下の「もっと速く: CSV から」参照。

## 最初のコード

```bash
npm install @kohaku-ui/host @kohaku-ui/host-mcp-apps @kohaku-ui/intents @kohaku-ui/llm @kohaku-ui/mcp-renderer @kohaku-ui/spec-core @modelcontextprotocol/server zod
npm install -D tsx
npm pkg set type=module                            # server.ts はトップレベル await を使うので ESM が必要
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # DomainPort と Intent カタログを埋めるためのファイル
```

`scaffold ports` は `@hono/node-server` 上の REST ホストである `kohaku/server.ts` も書き出します(上ではインストールしていません)。このパスでは使いません — 下の MCP サーバーがその代わりです — ので、削除するか放置してください。起動はしないでください。

```ts
import { createKohakuHost } from "@kohaku-ui/host";
import { attachKohakuMcp } from "@kohaku-ui/host/mcp";
import { intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { loadRendererHtml } from "@kohaku-ui/mcp-renderer";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { intents } from "./kohaku/intents.js"; // your hand-written Intent catalog (defineIntent)
import { domainPort as domain } from "./kohaku/ports.js"; // your DomainPort (kohaku scaffold ports)

const host = createKohakuHost({
  domain,
  querySource: "my-product", // must equal the `source` of every Intent in intents.ts
  llm: createLlmFromEnv(),
  intents: intents.map((i) => i.toIntentDef()),
  dataVersion: () => "my-product@1",
});
const server = new McpServer({ name: "my-product", version: "0.1.0" });
attachKohakuMcp(server, host, {
  // Pre-built, dependency-free core renderer bundle -- swap for your own build once you have
  // product-specific component implementations to bake in (see @kohaku-ui/mcp-renderer's README).
  rendererHtml: loadRendererHtml,
  // One typed MCP tool per Intent (sales.summary → sales_summary), input schema derived from the Zod params.
  intentTools: intentToolsFromCatalog(intents.map((i) => i.toToolSource())),
});
await server.connect(new StdioServerTransport());
```

`server.ts` として保存します。自分で起動する必要はありません。チャットを開くたびに、MCP ホストが子プロセス(stdio)として起動します。

**最初の呼び出しの前に、次の 2 つを揃えます。**

- **ソース名。** `querySource` は `intents.ts` の全 Intent の `source` と一致させます。一致しないと、ウィジェットのデータ読み出しが `SOURCE_MISMATCH` で拒否されます(エラーメッセージにはホストが担当するソース名が入ります)。`kohaku scaffold ports` が書くプレースホルダは `"example"`、スニペットは `"my-product"` です。名前を 1 つ決めて両方のファイルで使ってください。
- **capability のシークレット。** capability トークンは `KOHAKU_CAPABILITY_SECRET` で署名され、未設定だと `createKohakuHost` は例外を投げます。下の登録設定に、長いランダム文字列(`openssl rand -base64 32`)を渡してください。手元で試すだけなら、`createKohakuHost` に `dev: true` を足す方法もあります。プロセス限りの一時シークレットを生成して stderr に警告を出します。本番では使わないでください。`KOHAKU_LLM_PROVIDER` とプロバイダのキーが要るのは、Intent がモデルに届く場合(L1/L2)だけで、L0 の経路ではモデルを呼びません。

**ホストへの登録。** 各 Intent のツール名は、正規名のドットをアンダースコアに置き換えたものです(スニペットの `sales.summary` → `sales_summary`、scaffold のプレースホルダ `example.summary` → `example_summary`)。

- **Claude Code:** `claude mcp add --env KOHAKU_CAPABILITY_SECRET=<secret> my-product -- npx tsx ./server.ts`
- **Claude Desktop** は `claude mcp add` を読みません。`claude_desktop_config.json`(macOS: `~/Library/Application Support/Claude/`、Windows: `%APPDATA%\Claude\`)を編集して、Claude Desktop を再起動します。シェルの `PATH` は引き継がれないので `npx` も解決できません。tsx 自身のエントリポイントを `node` で起動し、パスはすべて絶対パスにしてください(`kohaku init --mcp` も同じ形式を生成します)。

```json
{
  "mcpServers": {
    "my-product": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/node_modules/tsx/dist/cli.mjs", "/absolute/path/to/server.ts"],
      "env": { "KOHAKU_CAPABILITY_SECRET": "<secret>" }
    }
  }
}
```

あとはモデルに `sales_summary`(カタログから生成されたツール名)を呼ばせます。ホストは UI Spec とテキスト要約を受け取り、MCP Apps 対応ホスト(Claude Desktop / claude.ai / ChatGPT)は同梱レンダラーで Spec を iframe に描画し、iframe を描画できないターミナルホスト(Claude Code / Codex CLI)はテキストのフォールバックを受け取ります。`kohaku_render_snapshot`(そうしたホスト向けの自己完結 HTML ファイル)は、`attachKohakuMcp` に `snapshotWriter` を渡したときだけ登録されます — 上のスニペットは渡していないので、有効にするには追加してください(HTML をどこかへ書き出してそのパスを返す関数。`kohaku init --mcp` が生成するサーバーが実例です)。

この 3 つの正体:

- **`ports.ts`** — あなたが自分で書き続ける唯一の Port: `domain`(あなたのデータ API: `listOperations` / `invoke`)。他の 3 つ(インメモリの `storage`、HMAC の `authz`、下の `intents.ts` から組み立てる `semantic`)は `createKohakuHost` が既定を用意します — 既定を超えたら差し替えてください([`@kohaku-ui/host` の README](https://github.com/yosuque/kohaku/tree/main/packages/host#readme))。`kohaku scaffold ports` が TODO 付きのファイルを書き出します。既定が置き換えている 4 つの Port の歩き方は[ユーザーガイド §6 Step 0](../user-guide.ja.md#step-0--llm-なしの-server-driven-ui)。
- **`intents.ts`** — こちらも `kohaku scaffold ports` が書き出す Intent カタログです: Intent ごとに `defineIntent` を 1 回: 正規名、Zod の `params`、NL の `examples`、`queries`。MCP ツール・その入力スキーマ・`createKohakuHost` の既定 SemanticPort はすべてこの単一定義から導出されます。
- **`createLlmFromEnv()`** — `KOHAKU_LLM_PROVIDER` とプロバイダのキー(Claude / OpenAI / Gemini / Ollama / llama.cpp)を読みます。`createKohakuHost` の `policy` オプションに固定 Spec を登録すれば、その Intent はモデルにまったく届かず、それでもウィジェットは描画されます。

## レンダラー

iframe には共有レンダラーが**自己完結の HTML 1 ファイル**として必要です(`rendererHtml`)。`@kohaku-ui/mcp-renderer` の `.` エントリポイント(上で使った `loadRendererHtml`)がまさにそれを提供します: ビルド済みで、kohaku のコアコンポーネント一式を持ち、**npm の依存が一切ありません** — 自分でビルドするものは何もありません。プロダクト固有のコンポーネント実装を焼き込みたくなったら(Web アプリ自身のレンダラーが使うのと同じレジストリのオーバーレイ)、代わりに `@kohaku-ui/mcp-renderer/boot` の `bootMcpRenderer` を使って自分のバンドルを再ビルドしてください — そのパッケージの README、または実例として `apps/sample-mcp/renderer/main.tsx` を参照。そして `rendererHtml: () => readFile("./dist/renderer.html", "utf8")`(そのビルドをどこから配信するかに応じた同等のローダー)を渡します。

## 何もしなくても得られるもの

- **同一表示**: 同じ Intent は、`sales_summary` の引数から来ても `kohaku_compose` の自然言語から来ても同じ Spec になります — キャッシュされ、2 回目は `provenance.cache: "hit"`。
- **モデルのコンテキストにデータが入らない**: Spec が運ぶのは `query://` 参照で、ウィジェットはその参照にスコープされた capability を使い、app-only の `kohaku_resolve_binding` ツール経由で行データを取得します。モデルに戻るのは「ユーザーが今見ているもの」のテキスト要約だけです。
- **ホストのテーマに追従**: ホストが `hostContext.theme` や標準の `--color-*` スタイル変数を提供していれば、ウィジェットは設定なしでそれを取り込みます。提供していなければ kohaku のデフォルトのライトテーマにフォールバックします。

## もっと速く: CSV から

ライブ API ではなくデータファイル(CSV / JSON / SQLite)がすでにあるなら、上のすべてを飛ばせます:

```bash
npx @kohaku-ui/cli init --mcp --from data.csv --out app
npm --prefix app run mcp:claude-desktop
# Claude Desktop を再起動
```

これで DomainPort、Intent カタログ、stdio と Streamable HTTP の両 MCP サーバー(上の手書き例とまったく同じく `@kohaku-ui/mcp-renderer` のコアレンダラーに配線済み)、そして `claude_desktop_config.example.json` が生成されます — `mcp:claude-desktop` がそれを Claude Desktop 自身の設定にマージします(既存の設定は先に `.bak` としてバックアップします。`-- --print` なら書き込まずにマージ結果だけプレビューできます)。あとは Claude Desktop を再起動するだけです。生成されたプロジェクトの README には `npm run mcp:http`(claude.ai / ChatGPT 向け)と、ターミナルホスト向けの `kohaku_render_snapshot` フォールバックが説明されています。

## 次のステップ

- 同じ Spec を Web アプリにも配信する: [パス (b)](react-dashboard.ja.md)(React レンダラー)— 上の `host.app` はすでに REST ホストです(内部は `@kohaku-ui/host-rest`)。`@hono/node-server` の `serve()` でそのままマウントできます。
- カタログの範囲内でモデルに合成させ、モデルの発明を統制する: [パス (c)](full-stack.ja.md)。
- リモートホスト向け Streamable HTTP、ターミナル向け `kohaku_render_snapshot`、レガシーの `ui://` リソース: [ユーザーガイド §5](../user-guide.ja.md#5-外部チャットmcpから使う)。参照配線は `apps/sample-mcp/src/setup.ts`。
