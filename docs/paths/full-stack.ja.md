# パス (c): フル構成 — L1・L2・昇格・固定化・Admin

[English](full-stack.md) | 日本語

kohaku は、LLM が生成した UI を本番で統制下に置きます。同じ要求には同じ画面を返し、行データはモデルに渡らず、モデルが発明したものは、正式な部品になる前にレビューを通ります。

**対象:** 統制されたカタログからモデルに画面を合成させ(L1)、カタログで足りないときは新しい画面を発明させ(L2)、良い発明を正式部品に変えるレビューループを持ちたい — そしてそれを本番で回すための監査証跡がほしいプロダクトチーム。

**所要時間目安:** あなたの LLM で合成する REST ホストまで約 30 分。サンプルで昇格ループを端から端まで歩くのに半日。

昇格・固定化が要らないなら、`@kohaku-ui/host` の `createKohakuHost()`([パス (a)](mcp-apps.ja.md))が `authz`・`storage`・`semantic` の 3 つの Port に既定を用意して 1 回の呼び出しで済ませ、compose のたびに lineage へ記録する `recorder` も既定で配線します。このパスはそのファサードをそのまま使い、統治面の部品を `routes` オプションで足します。`routes` はそれ以外の `KohakuHostDeps` のフィールド(`auth`、`tenant`、`authorizeGovernance`、`promotions`、`fixations`、`rateLimiter` など)をそのまま `createKohakuRoutes` へ渡します。昇格・固定化のサービスはホストが記録する先と同じ `storage` と lineage を必要とするため、スニペットは両者を先に作って渡します(`storage`、`recorder`)。ファサードが返す `host.lineage` は、あとで同じ lineage を使いたいとき(たとえば `createActionAuditRecorder`)のためのものです。

## 最初のコード: 統制付き REST ホスト

```bash
npm install @kohaku-ui/host @kohaku-ui/host-rest @kohaku-ui/lineage @kohaku-ui/storage-memory @kohaku-ui/llm @kohaku-ui/composer @kohaku-ui/intents @kohaku-ui/spec-core hono @hono/node-server @ai-sdk/anthropic zod
npx @kohaku-ui/cli scaffold ports --out ./kohaku
```

`kohaku scaffold ports` は `./kohaku` に 3 つのファイルを書き出します: `ports.ts`(埋めるための `domainPort`)、`intents.ts`(Intent カタログ)、`server.ts`(最小の REST ホスト — 下のスニペットがその代わりなので削除してください)。手で書くのは `./kohaku/fixed-specs.ts`(L0 の画面)だけです。`fixedSpecs`(`@kohaku-ui/composer` の `FixedSpecSource`)を export し、その `lookup(intent)` が Spec のビルダーを返します。モデルに届かせたい Intent には `null` を返します — サンプルのものは `apps/sample-api/src/intents/fixed-specs.ts`。L0 の画面がまだなければ、その import を外して `policy: { allowL2: true }` だけを渡してください。残り 3 つの Port はファサードの既定です: インメモリの `storage`、HMAC の `authz`(`KOHAKU_CAPABILITY_SECRET` を設定します。例: `openssl rand -base64 32`。手元で試すだけなら `dev: true`)、`intents.ts` から組み立てる LLM ベースの `semantic`。

```ts
import { serve } from "@hono/node-server";
import { createKohakuHost } from "@kohaku-ui/host";
import { createGovernancePolicy } from "@kohaku-ui/host-rest";
import { createFixations, createLineage, createPromotions, createViewRecorder } from "@kohaku-ui/lineage";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { fixedSpecs } from "./kohaku/fixed-specs.js"; // L0: screens that never touch the model (hand-written)
import { intents } from "./kohaku/intents.js"; // written by kohaku scaffold ports
import { domainPort as domain } from "./kohaku/ports.js"; // written by kohaku scaffold ports

const storage = createMemoryStoragePort(); // the facade's default, created here so the services below share it
const lineage = createLineage({ storage }); // every compose / review / fixation becomes an event
const { app } = createKohakuHost({
  domain,
  storage,
  querySource: "my-product", // must equal the `source` of every Intent in intents.ts
  llm: createLlmFromEnv(),
  intents: intents.map((i) => i.toIntentDef()),
  dataVersion: () => "my-product@1",
  policy: { fixedSpecs, allowL2: true }, // the L0 shortcut, and permission to generate freely
  recorder: createViewRecorder(lineage),
  routes: {
    auth: async (c) => ({ id: "demo-admin", roles: [c.req.header("x-kohaku-role") ?? "admin"] }),
    authorizeGovernance: createGovernancePolicy({ roles: { admin: ["*"], viewer: ["lineage.read"] } }),
    promotions: createPromotions({ lineage, storage }), // L2 → L1 (add `judge` to score candidates)
    fixations: createFixations({ lineage, storage, policy: { minUses: 3 } }), // L1 → L0
    fixationLookup: (intentHash, session) => storage.getFixation(intentHash, session.tenant),
  },
});
serve({ fetch: app.fetch, port: 8787 });
```

`auth` の `x-kohaku-role` ヘッダーはデモ用の簡易実装で、同梱サンプル(`apps/sample-api/src/app/host-deps.ts`)と同じ手法です — 実運用では principal とそのロールをクライアント任せのヘッダーではなく、自前の認証基盤(JWT/OIDC など)から解決してください。

[パス (b)](react-dashboard.ja.md) の 2 つ目のスニペットをこのホストに向ければダッシュボードが描画されます。次に `POST /compose` に `{ "input": { "kind": "nl", "text": "revenue by region as a bar chart" } }` を送ると、`SemanticPort`(ここではファサードの既定で、`intents.ts` から組み立てたもの。サンプルの実装は `apps/sample-api/src/ports/semantic-port.ts`)が文を Intent に写像し、composer は固定 L0 Spec を返すか、カタログから L1 Spec を合成するか、あなたの SemanticPort が L2 に振る受け皿 Intent(サンプルでは `sales.custom`)ならサンドボックスで動く L2 アーティファクトを生成します。

## 3 つの階層をひとつのホストで

| 階層 | 何が決めるか | 上のコードのどこか |
|---|---|---|
| **L0 固定** | `policy.fixedSpecs.lookup(intent)` がビルダーを返す → モデル呼び出しなし、最初の compose は `cache: "miss"`、同一の要求なら `"hit"` | `policy.fixedSpecs` |
| **L1 宣言的合成** | モデルが `catalog` から部品を選び props を埋める。決定的後処理と修復ループがカタログに対して検証する | `llm`(と、ファサードの既定の `catalog`) |
| **L2 自由生成** | `policy.allowL2` + L2 に振られた Intent(`routeTier`)→ HTML/JS アーティファクト、ブリッジ契約の lint、サンドボックス描画 | `policy.allowL2` |

## 昇格と固定化(統制ループ)

- すべての compose は `recorder` によって **lineage** に記録されます(`view.composed`、`component.used` …)。`GET /lineage` と `GET /analytics/summary` がそれを読み返します。
- 十分に使われた L2 アーティファクトは**昇格候補**になります(`GET /promotions`、`POST /promotions/evaluate`)。レビュアーは記録されたアーティファクトそのものをプレビューし(`POST /promotions/:id/preview` — ユーザーが見たものと sha256 で同一)、スキーマ(`componentType` / `intentName` / `description`)を確定して承認します(`POST /promotions/:id/approve`)。`createPromotions` に `judge` を渡すと、人が見る前に LLM-as-Judge がバージョン付きルーブリックで候補を採点します(`@kohaku-ui/evals` の `createJudge`。サンプルのアダプタは `apps/sample-api/src/app/promotions.ts`)。人間による承認そのものは省略されません。
- publish 時に**あなたの** `onPublish`(`createPromotions` のオプション)が部品をカタログへ、Intent を `SemanticPort` へ追加します — 参照実装は `apps/sample-api/src/intents/promoted-registry.ts`。
- よく使われる L1 Intent は**固定化提案**になります(`GET /fixations/proposals`)。`POST /fixations/approve` が Spec を L0 に固定し、その画面についてモデルはループから外れます。`fixationLookup` が、固定された Spec をホストに配信させる仕組みで、その配信には `provenance.cache: "fixated"` が付きます — この値が生まれるのはここだけです。
- `auth` + `authorizeGovernance`(`createGovernancePolicy`、ロール → 操作の行列)が統制ルートに RBAC を載せます。スニペットの `viewer: ["lineage.read"]` はそれ以外すべてを拒否し、`promotion.approve` / `promotion.reject` / `promotion.preview` も含まれます — `viewer` はこれらで 403 になります。`authorizeGovernance` を配線しないままだと統制ルートは誰にでも開いたままになり、ホストは起動時にその旨を警告します。

## Admin

レビュー UI(Lineage / Promotions / Fixations / Analytics のタブ)は公開パッケージ **`@kohaku-ui/admin-react`** として配布されています — `<KohakuAdmin client={...} />` という React コンポーネントで、必要なのは `KohakuClient` だけ、上のルートには `@kohaku-ui/client` 経由で話します。RBAC・テナントスコープ・承認はすべてホスト側に残ります。`apps/sample-web/src/pages/AdminPage.tsx` はサンプルのクライアント・テーマ・辞書を注入する薄いラッパーです — 完全なスニペットは[ユーザーガイド「統制コンソールを組み込む」](../user-guide.ja.md#統制コンソールを組み込むkohaku-uiadmin-react)にあります。各タブは[ユーザーガイド §3](../user-guide.ja.md#admin統制面)に、ループの歩き方は[デモ 3](../user-guide.ja.md#デモ-3--l2-自由生成--昇格このフレームワークの真骨頂)にあります。

## 次のステップ

- L2 の出力にデザインシステムを適用する(トークン、モデルが逸脱できないクラス語彙): [ユーザーガイド §6「L2 にデザインシステムを適用する」](../user-guide.ja.md#l2-にデザインシステムを適用する)。
- Intent ごとの golden 回帰で、プロンプトやモデルの変更が画面を黙って変えないようにする: [ユーザーガイド §6「Golden 回帰を始める」](../user-guide.ja.md#golden-回帰を始める)。
- 運用 — キャッシュのサイズ、キャッシュ障害ポリシー、デッドライン、OTel トレース: [ユーザーガイド §7](../user-guide.ja.md#7-運用の勘どころ)。完全な参照配線は `apps/sample-api/src/app.ts`。
- 同じホストを MCP でも: [パス (a)](mcp-apps.ja.md) は `compose`・`domain`・`authz` をそのまま再利用します。
