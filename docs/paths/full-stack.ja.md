# パス (c): フル構成 — L1・L2・昇格・固定化・Admin

[English](full-stack.md) | 日本語

**対象:** 統制されたカタログからモデルに画面を合成させ(L1)、カタログで足りないときは新しい画面を発明させ(L2)、良い発明を正式部品に変えるレビューループを持ちたい — そしてそれを本番で回すための監査証跡がほしいプロダクトチーム。

**所要時間目安:** あなたの LLM で合成する REST ホストまで約 30 分。サンプルで昇格ループを端から端まで歩くのに半日。

## 最初のコード: 統制付き REST ホスト

```bash
npm install @kohaku-ui/host-rest @kohaku-ui/composer @kohaku-ui/registry @kohaku-ui/lineage @kohaku-ui/llm @kohaku-ui/spec-core hono @hono/node-server @ai-sdk/anthropic zod
node node_modules/@kohaku-ui/cli/dist/index.js scaffold ports --out ./kohaku
```

```ts
import { serve } from "@hono/node-server";
import { createKohakuRoutes } from "@kohaku-ui/host-rest";
import { createFixations, createLineage, createPromotions, createViewRecorder } from "@kohaku-ui/lineage";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { Hono } from "hono";
import { fixedSpecs } from "./kohaku/fixed-specs.js"; // L0: screens that never touch the model
import { authz, domain, semantic, storage } from "./kohaku/ports.js"; // your four Ports (kohaku scaffold ports)

const llm = createLlmFromEnv();
const lineage = createLineage({ storage }); // every compose / review / fixation becomes an event
const promotions = createPromotions({ lineage, storage }); // L2 → L1 (add `judge` to score candidates)
const fixations = createFixations({ lineage, storage, policy: { minUses: 3 } }); // L1 → L0
const policy = { fixedSpecs, allowL2: true }; // the L0 shortcut, and permission to generate freely
const app = new Hono().route(
  "/api/kohaku",
  createKohakuRoutes({
    compose: { catalog: resolveCatalog(coreCatalog), semantic, storage, llm, policy },
    domain,
    authz,
    querySource: "my-product",
    auth: async () => ({ id: "demo-admin", roles: ["admin"] }), // resolve from your JWT/OIDC in production
    recorder: createViewRecorder(lineage),
    promotions,
    fixations,
    fixationLookup: (intentHash, session) => storage.getFixation(intentHash, session.tenant),
  }),
);
serve({ fetch: app.fetch, port: 8787 });
```

[パス (b)](react-dashboard.ja.md) の 2 つ目のスニペットをこのホストに向ければダッシュボードが描画されます。次に `POST /compose` に `{ "input": { "kind": "nl", "text": "revenue by region as a bar chart" } }` を送ると、あなたの `SemanticPort.normalize` が文を Intent に写像し(サンプルの LLM 実装は `apps/sample-api/src/ports/semantic-port.ts`)、composer は固定 L0 Spec を返すか、カタログから L1 Spec を合成するか、あなたの SemanticPort が L2 に振る受け皿 Intent(サンプルでは `sales.custom`)ならサンドボックスで動く L2 アーティファクトを生成します。

## 3 つの階層をひとつのホストで

| 階層 | 何が決めるか | 上のコードのどこか |
|---|---|---|
| **L0 固定** | `policy.fixedSpecs.lookup(intent)` がビルダーを返す → モデル呼び出しなし、`cache: "fixated"` / `"hit"` | `fixedSpecs` |
| **L1 宣言的合成** | モデルが `catalog` から部品を選び props を埋める。決定的後処理と修復ループがカタログに対して検証する | `catalog`, `llm` |
| **L2 自由生成** | `policy.allowL2` + L2 に振られた Intent(`routeTier`)→ HTML/JS アーティファクト、ブリッジ契約の lint、サンドボックス描画 | `allowL2: true` |

## 昇格と固定化(統制ループ)

- すべての compose は `recorder` によって **lineage** に記録されます(`view.composed`、`component.used` …)。`GET /lineage` と `GET /analytics/summary` がそれを読み返します。
- 十分に使われた L2 アーティファクトは**昇格候補**になります(`GET /promotions`、`POST /promotions/evaluate`)。レビュアーは記録されたアーティファクトそのものをプレビューし(`POST /promotions/:id/preview` — ユーザーが見たものと sha256 で同一)、スキーマ(`componentType` / `intentName` / `description`)を確定して承認します(`POST /promotions/:id/approve`)。`createPromotions` に `judge` を渡すと、人が見る前に LLM-as-Judge がバージョン付きルーブリックで候補を採点します(`@kohaku-ui/evals` の `createJudge`。サンプルのアダプタは `apps/sample-api/src/app/promotions.ts`)。人間による承認そのものは省略されません。
- publish 時に**あなたの** `onPublish`(`createPromotions` のオプション)が部品をカタログへ、Intent を `SemanticPort` へ追加します — 参照実装は `apps/sample-api/src/intents/promoted-registry.ts`。
- よく使われる L1 Intent は**固定化提案**になります(`GET /fixations/proposals`)。`POST /fixations/approve` が Spec を L0 に固定し、その画面についてモデルはループから外れます。`fixationLookup` が、固定された Spec をホストに配信させる仕組みです。
- `auth` + `authorizeGovernance`(`createGovernancePolicy`、ロール → 操作の行列)が統制ルートに RBAC を載せます。`viewer` は approve / reject / preview で 403 になります。

## Admin

レビュー UI(Lineage / Promotions / Fixations / Analytics のタブ)は現在サンプル Web アプリ `apps/sample-web/src/pages/admin/` にあります。いまはプロダクトへコピーしてください。上のルートには `@kohaku-ui/client` 経由で話します。各タブは[ユーザーガイド §3](../user-guide.ja.md#admin統制面)に、ループの歩き方は[デモ 3](../user-guide.ja.md#デモ-3--l2-自由生成--昇格このフレームワークの真骨頂)にあります。

## 次のステップ

- L2 の出力にデザインシステムを適用する(トークン、モデルが逸脱できないクラス語彙): [ユーザーガイド §6「L2 にデザインシステムを適用する」](../user-guide.ja.md#l2-にデザインシステムを適用する)。
- Intent ごとの golden 回帰で、プロンプトやモデルの変更が画面を黙って変えないようにする: [ユーザーガイド §6「Golden 回帰を始める」](../user-guide.ja.md#golden-回帰を始める)。
- 運用 — キャッシュのサイズ、キャッシュ障害ポリシー、デッドライン、OTel トレース: [ユーザーガイド §7](../user-guide.ja.md#7-運用の勘どころ)。完全な参照配線は `apps/sample-api/src/app.ts`。
- 同じホストを MCP でも: [パス (a)](mcp-apps.ja.md) は `compose`・`domain`・`authz` をそのまま再利用します。
