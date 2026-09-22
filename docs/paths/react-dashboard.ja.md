# パス (b): React ダッシュボードだけ(LLM なし)

[English](react-dashboard.md) | 日本語

**対象:** Server-Driven UI を今すぐ使いたく、LLM による合成は後で(あるいは使わない)というプロダクトチーム。UI Spec を手書きするか API から配信し、`@kohaku-ui/renderer-react` が描画します。このパスではモデルを一切呼びません。

**所要時間目安:** 最初の画面まで約 10 分、稼働中のホストからデータを流すまで約 20 分。

## 1. Spec を描画する(サーバーなし)

```bash
npm install @kohaku-ui/renderer-react @kohaku-ui/renderer-core @kohaku-ui/spec-core react react-dom zod
```

```tsx
import { defaultLightTheme } from "@kohaku-ui/renderer-core";
import { RendererProvider, SpecView } from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import type { UISpec } from "@kohaku-ui/spec-core";

// An L0 Spec is data, not code: hand-write it today, serve it from your API tomorrow.
const ZERO_HASH = `sha256:${"0".repeat(64)}`; // a real host computes this from the canonical Intent
const spec: UISpec = {
  kohaku: "0.2",
  intent: { canonical: "demo.welcome", params: {}, hash: ZERO_HASH },
  dataVersion: "static@1",
  components: [
    { id: "root", type: "layout.stack", props: { direction: "vertical" }, children: ["title", "body"] },
    { id: "title", type: "text.heading", props: { level: 2, text: "Hello, kohaku" } },
    { id: "body", type: "presentMarkdown", props: { markdown: "This screen is **data**, not code." } },
  ],
  events: [],
  provenance: { tier: "L0", composedBy: "hand-written", cache: "bypass" },
};

export function Dashboard() {
  return (
    <RendererProvider value={{ impls: createCoreRegistry(), theme: defaultLightTheme }}>
      <SpecView spec={spec} />
    </RendererProvider>
  );
}
```

いつもどおり `createRoot` で `<Dashboard />` をマウントします。いま起きたこと: 画面は `@kohaku-ui/spec-core` が検証する JSON 文書で、15 種の中核部品(`layout.*`、`text.heading`、`presentChart`、`presentSpreadsheet`、`presentForm` …)は `@kohaku-ui/renderer-react/core` に一度だけ実装され、Web Components レンダラーと MCP Apps ウィジェットでも同一に描画されます。テーマはトークンの写像(`defaultLightTheme` / `defaultDarkTheme`)で、トークンを差し替えればすべての部品が追従します。

## 2. ホストから流す(参照渡しのデータ)

チャートや表が運ぶのは `query://` **参照**で、行データではありません。Spec を合成したホストがその参照に対してだけ短命の capability を発行し、部品はそれを使って取得します。同梱のサンプルホスト(リポジトリで `pnpm dev`、API は `:8787`)か自作ホスト([パス (c)](full-stack.ja.md))を起動して:

```bash
npm install @kohaku-ui/client @kohaku-ui/data-binding
```

```tsx
import { createKohakuClient } from "@kohaku-ui/client";
import { createBindingClient } from "@kohaku-ui/data-binding";
import { defaultLightTheme } from "@kohaku-ui/renderer-core";
import { RendererProvider, SpecView } from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import type { UISpec } from "@kohaku-ui/spec-core";
import { useEffect, useState } from "react";

const BASE_URL = "http://localhost:8787/api/kohaku"; // any kohaku REST host (pnpm dev, or your own)
const client = createKohakuClient({ baseUrl: BASE_URL });
const impls = createCoreRegistry();
const intent = { canonical: "sales.quarterly_summary", params: { fiscalYear: 2026, quarter: 3 } };

export function Dashboard() {
  const [view, setView] = useState<{ spec: UISpec; capability: string } | null>(null);
  // A GUI request: the host normalizes it to a canonical Intent and answers with the (cached) Spec.
  useEffect(() => void client.compose({ intent }).then(setView), []);
  if (view == null) return <p>Loading…</p>;
  // Components fetch their own data by reference, with the capability the host issued for this Spec.
  const binding = createBindingClient({ baseUrl: BASE_URL, capability: view.capability });
  return (
    <RendererProvider value={{ impls, binding, theme: defaultLightTheme }}>
      <SpecView spec={view.spec} />
    </RendererProvider>
  );
}
```

ネットワークタブを開くと、`POST /compose` は `{spec, capability}` を返し **Spec の中にデータの値はひとつもありません**。チャートの `GET /binding/resolve` は capability を Bearer トークンとして運び、行データを返します。同じ要求を 2 回送ると 2 回目は `provenance.cache: "hit"` になります — これが同一表示保証の実体です。

## この先

- **自分のデータで自分の L0 画面**: 4 つの Port を実装し(`node cli/bin/kohaku.js scaffold ports` がファイルを生成)、固定 Spec を `policy.fixedSpecs` に登録する — [ユーザーガイド §6 Step 0](../user-guide.ja.md#step-0--llm-なしの-server-driven-ui)。
- **イベントとドリルダウン**: Spec に `events`(`table1.rowClick → intent.patch`)を宣言し、`RendererProvider` に `onEvent` を渡すとホストが再合成する — [ユーザーガイド デモ 4](../user-guide.ja.md#デモ-4--インタラクションループと固定化)。
- **カタログの範囲内でモデルに合成させる(L1)**: [パス (c)](full-stack.ja.md)。
- **React なしで同じ Spec を**: `@kohaku-ui/renderer-wc` の `<kohaku-surface>` — [ユーザーガイド §2](../user-guide.ja.md#非-react-レンダラーの実演web-components--react-ゼロ)。
