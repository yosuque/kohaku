# kohaku 仕様書(実装リファレンス)

[English](specification.md) | 日本語

| 項目 | 内容 |
|---|---|
| バージョン | v0.1 |
| 最終更新 | 2026-09-11 |
| 位置づけ | 実装の**具体的な契約**(スキーマ・API・Port)のリファレンス。プロトコルの規範(MUST/SHOULD・conformance 要件)は [../spec/SPEC.ja.md](../spec/SPEC.ja.md) が正 |
| 読者 | kohaku を組み込む・kohaku に対して実装するアプリケーション開発者 |

---

## 1. UI Spec フォーマット

正準例: [../spec/examples/quarterly-sales.spec.json](../spec/examples/quarterly-sales.spec.json)。Zod スキーマ: `packages/spec-core/src/schema/`。

### 1.1 エンベロープ

| フィールド | 型 | 説明 |
|---|---|---|
| `kohaku` | `"0.1" \| "0.2"` | プロトコルバージョン。発行は `"0.2"`・受理は `{0.1, 0.2}`。新機能は 0.2 のみ(機能ゲート) |
| `intent` | CanonicalIntent | この Spec を生んだ正規化 Intent(§2) |
| `dataVersion` | string | データ版。複数ハンドル時は各 ref の `uri=version` ペアをソートしてハッシュ化した `multi:<hash16>` に合成(どの URI がどのバージョンを持つかが入れ替わっても同じキーに潰れない) |
| `refVersions` | `Record<string,string>`? | `$ref` URI → 単体 dataVersion。`multi:` 時に Renderer が参照単位で突合する(SPEC-DATA-002)。handles が 1 件以上なら常に充填 |
| `state` | `Record<stateKey, JsonValue>`? | クライアントローカル状態の初期値(kohaku >= 0.2)。Renderer 内に閉じサーバー非送信。`stateKey` = `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`。visibleWhen 参照キーは初期値必須 |
| `components` | ComponentNode[] | フラットリスト(1 個以上) |
| `events` | EventBinding[] | 部品 → ホストのイベント宣言 |
| `provenance` | Provenance | 来歴(§1.4) |

### 1.2 ComponentNode

| フィールド | 型 | 制約 |
|---|---|---|
| `id` | string | `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`。一意。`"root"` が必須 |
| `type` | string | カタログの部品 type(例 `presentChart`)。L2 は予約型 `sandbox.html` |
| `version` | string? | 解決済みカタログ semver(composer が充填) |
| `props` | JsonObject | 型付き props(カタログの propsSchema に適合) |
| `children` | string[]? | ID 参照。root を根とする非循環 DAG |
| `data` | `{ $ref: "query://…", bind? }`? | **参照渡しのみ**。バルクデータの埋め込みはスキーマ違反。`bind` は双方向バインディング(下記) |
| `artifact` | `{ inline?, uri?, sha256 }`? | L2 のみ。inline / uri のどちらか一方 + sha256(実行前検証) |
| `visibleWhen` | `{ ref, <比較> } \| { all } \| { any } \| { not }`? | 条件表示(kohaku >= 0.2)。リーフは `{ ref: "$state.<key>", <比較> }` で、比較は `eq` / `ne` / `in` / `gt` / `lt` / `gte` / `lte` / `exists` の**ちょうど 1 つ**(`gt`/`lt`/`gte`/`lte` は数値比較で state 値が非数値なら偽、`exists` は state 値が null/undefined 以外かの真偽)。複合は `{ all: [述語…] }`(論理積)/ `{ any: [述語…] }`(論理和)/ `{ not: 述語 }`(否定)で再帰・入れ子可(深さ 8・`all`/`any` の要素数 16 が上限)。偽なら subtree ごと unmount |

**双方向バインディング `data.bind`(kohaku >= 0.2 [Draft]、A1)**: `data.bind = { <param>: { $state: "<key>", values: string[] } }`。`$state` の値を `$ref` の当該クエリパラメータへ差し込み、compose(サーバー往復・LLM)なしでクライアント内で再解決する(クロスフィルタ)。`$ref` は束縛パラメータを**初期 `$state` 値で埋めた初期 variant の具体正準 URI**で、初期状態では effective ref = `$ref`。`values` は束縛値域の静的列挙(離散文字列)で、これが capability 列挙の唯一の正(§5)。純関数は `resolveBoundRef(dataRef, state)`(effective ref)/ `enumerateBindVariants(dataRef)`(直積 variant)。

構造検証のエラーコード(安定): `DUPLICATE_ID` / `MISSING_ROOT` / `DANGLING_CHILD` / `CYCLE` / `ORPHAN_COMPONENT`(警告) / `UNKNOWN_EVENT_TARGET` / `STATE_REF_UNKNOWN` / `STATE_SET_INVALID` / `VERSION_FEATURE_MISMATCH`(いずれも state 機能の検証。最後の 3 つは kohaku >= 0.2 関連)。bind の検証(kohaku >= 0.2): `BIND_STATE_UNKNOWN` / `BIND_PARAM_MISSING` / `BIND_VALUE_INVALID`(初期 `$ref` 値 = `spec.state[key]` = `values` 要素の三者一致)/ `BIND_PARAM_RESERVED`(`_` 始まり)/ `BIND_VARIANT_LIMIT`(variant 総数 256 超)。

### 1.3 EventBinding

```json
{ "on": "table1.rowClick", "emit": "intent.patch", "payload": { "drilldown": "$row.region" } }
```

- `on` = `<componentId>.<eventName>`。対象 ID は存在必須。部品の capabilities.events に宣言された名前のみ有効。
- `emit` = `intent.patch` | `intent.replace` | `action.invoke` | `state.set`(kohaku >= 0.2)
- payload テンプレート: `"$row.<key>"`(クリック行の値)/ `"$value"`(部品の現在値)/ `"$value.<field>"`(`$value` がオブジェクトのときその 1 フィールド)。描画側がランタイム解決してからホストへ送る。`$value` は常にスカラーとは限らない: `presentSpreadsheet` の `sortChange` は `{field, dir}`、`cellEdit` は `{column, value, previousValue, rowIndex}` を運ぶ(§7)。
- `state.set`(kohaku >= 0.2)は payload に静的な `key`(`spec.state` の宣言済みキー)+ 設定値 `value` を持つ。**Renderer 内で完結しサーバーへ送らない**(クライアントローカル状態。visibleWhen で他部品と連動)。

### 1.4 Provenance

| フィールド | 値 | 意味 |
|---|---|---|
| `tier` | `L0` / `L1` / `L2` | 固定 / 宣言的合成 / 自由生成 |
| `composedBy` | string | 例 `composer@0.1.0`、固定 Spec は `fixed-spec-template` 等 |
| `model` | string? | L1/L2 の生成モデル ID |
| `cache` | `hit` / `miss` / `bypass` / `fixated` | `fixated` = L1→L0 固定化配信 |
| `fallback` | `{from, reason, kind?}`? | capability 交渉・L1 失敗の降格痕跡。`kind` は `generation`(L1/L2 生成が尽きた決定的フォールバック)/ `negotiation`(capability 交渉降格)。両方発生時は last-writer-wins で `negotiation` |
| `generatorVersion` | string? | 合成時点で有効だったホストの生成器 identity(composer の `ComposePolicy.generatorVersion`。設定時のみ)。tier を問わず刻まれ、キャッシュヒットや L1→L0 固定化をまたいでも変化しない |
| `kit` | `{id, version}`? | 生成されたマークアップが書かれた対象の design kit(composer の `DesignSystemGuide.kit`。設定時のみ)。SPEC-KIT-001(SHOULD): design kit のスタイルシートを注入する surface は自身の identity をこれと突合し、無スタイルのまま黙って描画するのではなく不一致を(fail-open で)通知することが望ましい — 詳細は [user-guide.ja.md](user-guide.ja.md) の design kit 節を参照 |

## 2. CanonicalIntent と正規化

```json
{ "canonical": "sales.quarterly_summary", "params": { "fiscalYear": 2026, "groupBy": "region", "quarter": 3 },
  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5" }
```

- `canonical`: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`
- `hash` = `sha256(canonicalStringify({canonical, params}))`。canonicalStringify = オブジェクトキーの深い昇順ソート + undefined 除去の JSON。**params のキー順が違っても同一ハッシュ**になる。
- キャッシュキー: `kohaku:0.2:<intentHash>:<dataVersion>:<catalogFingerprint>[:<generatorVersion>][:<policyFingerprint>]`(版成分は発行版 `0.2`。既存 `0.1` fixation の配信キーは不変)。`generatorVersion` は任意(MAY)で、プロンプト改版・モデル変更で生成物を世代分離する成分。**指定時のみ第 6 成分として末尾**に付き、未指定なら従来の 5 成分キーと完全一致する(後方互換)。既定値は composer の `defaultGeneratorVersion(llm) = "p<PROMPT_REVISION>/<modelId>"`。`policyFingerprint` は任意の第 7 成分で、ワイヤ上には現れない内部専用の値(プロセス外から観測されない)— composer の `policyFingerprint` が `ComposePolicy.outputLanguage` / `designSystem` / `fewShot.id` / `selectComponents.id` / `refConstraint`(`"validate"` 指定時のみ。既定 `"schema"` は未指定と同一に畳み込まれる)/ `effort`(何らか設定時のみ)/ `ComposeContext.llmByTier` のモデルのうち基底 `llm` と実際に異なるものの識別(`llmByTier` が異なるモデルへ配線されているときのみ。[design.ja.md#per-tier-llm](design.ja.md#per-tier-llm) 参照)から導出するハッシュで、これらを変えるポリシー・コンテキストに対し手動の `generatorVersion` bump なしにキャッシュを自動分離する。ポリシーも `llmByTier` もこれらのいずれにも触れなければ空(= 未指定と同義)になり、`generatorVersion` なしでこれだけ指定されたときは第 6 スロットに `-` プレースホルダを入れて両者が位置的に衝突しないようにする。詳細は [design.ja.md#cache-key](design.ja.md#cache-key)。

## 3. query:// URI と TabularData

```
query://<source>/<path>?<params>     例: query://sales/summary?fy=2026&groupBy=region&q=3
```

- `source`: `^[a-z0-9_-]+$`(ホストの `querySource` と一致しないと 404)
- 正準形: クエリパラメータをキー昇順ソート + URL エンコード。`parseQueryRef` / `formatQueryRef` が変換する。
- `path` がそのまま `DomainPort.invoke(op, …)` の op、params が引数(文字列)になる。

データ応答の共通封筒 **TabularData**:

```json
{ "columns": [{ "key": "region", "label": "Region", "type": "string" }],
  "rows": [{ "region": "Japan", "revenue": 530750000 }],
  "dataVersion": "sales@seed-20260610.1+3f2a9c1e8b04#bump-0" }
```

`type` = `string` | `number` | `boolean` | `date`。`dataVersion` は不透明な実装定義の文字列で、サンプル自身の形式は `sales@<seedTag>[+<contentHash12>]#bump-N`(`<seedTag>` は手動更新のシードバージョンタグ、任意の `+<contentHash12>` はシード内容のハッシュ先頭 12 桁の16進文字列で `<seedTag>` の更新を忘れてもシードデータの変更を拾えるようにするもの、`bump-N` はデモのキャッシュ無効化ウォークスルー用に手動でインクリメントするカウンタ — design.md §12「サンプル実装の設計」参照)。`dataVersion` が Spec と不一致なら BindingClient は `STALE_VERSION` を投げる。`total?: number`(DomainPort 実装が安価に算出できるときの全体行数)は同じ封筒上の別の任意フィールドで、上の例では省略している(全ての `TabularData` 応答が持つわけではないため。もう一つの任意フィールドである `nextCursor` については同節のサーバーサイドページングの説明を参照)。

**server-side ページング/ソート**: `_` 始まりのクエリパラメータは予約名前空間(`_cursor` / `_limit` / `_sort` / `_dir`)。クライアントは `BindingClient.resolve(ref, { page: {cursor?, limit?}, sort: {key, dir} })` で指定し、これらが予約パラメータに写って ref に合流・再正準化される(未指定なら ref 不変 = 後方互換)。応答に続きがあれば **`TabularData.nextCursor`**(不透明カーソル)が返り、次要求の `page.cursor` にそのまま渡す。`$ref` 自体に `_` 始まりパラメータを含めると `BAD_REF`。**capability 検証は予約パラメータを除いた base ref に対して行う**(`splitReservedParams` — 検証は base ref との完全一致で行う。既知キー以外の `_` パラメータは `assertKnownReservedParams` が 400 で拒否する)。予約パラメータは base のパラメータと合流して `DomainPort.invoke` に渡る(`_` 名前空間規約 — DomainPort シグネチャ不変。予約パラメータで capability スコープは回避できない)。

## 4. Port インターフェース(プロダクトが実装する 4 つ)

定義: `packages/spec-core/src/ports.ts`。実装見本: `apps/sample-api/src/ports/`。

### 4.1 DomainPort — 業務 API(プロダクトの本体)

```ts
interface DomainPort {
  listOperations(): Promise<OperationDescriptor[]>;          // 操作列挙(LLM 向け文書を兼ねる)
  invoke(op: string, args: JsonObject, ctx: InvocationContext): Promise<unknown>; // 読み書き実行
}
```
不変条件(整合性)はこの背後のドメインモジュールで守る。`invoke` の戻りは読み取り系なら TabularData を推奨。**`listOperations` は `query://` 読み取りだけでなく書き込み操作(`action.invoke` 経由で呼ばれるもの。例: サンプルの `annotate`)も列挙しなければならない**: ホストは合成された capability の write スコープを、ここが返す名前に制限する(下記「capability の発行スコープ」参照)。合成 UI が宣言した `action.invoke` のアクション名がここに列挙されていない場合、そのスコープは黙って落とされる。

### 4.2 SemanticPort — Intent 正規化と決定的クエリ解決

```ts
interface SemanticPort {
  normalize(input: NLQuery | GuiAction, ctx: SessionContext): Promise<CanonicalIntent>; // hash は空でよい(ホストが finalizeIntent)
  resolveQuery(intent: CanonicalIntent): Promise<QueryHandle | QueryHandle[]>;          // Intent → query:// ハンドル
  dataVersion(handle: QueryHandle): Promise<string>;                                    // キャッシュキー成分
  describeShape?(handle: QueryHandle): Promise<DataShape>;   // 任意。列メタのみ(行データ禁止)
}
```
契約: GUI 操作(`GuiAction {action, params, current?}`)は **LLM を通さず決定的に**正規化する。`current` は既存ビューへの操作(drilldown 等)の基点。

**参照実装のカタログ生成(`@kohaku-ui/intents`)**: サンプルは `defineVocabulary`(値集合 + ラベルの単一源)と `defineIntent`(単一 Intent 定義)から、この `SemanticPort` が使う `IntentDef`・GUI ファセット記述子(`FacetView`。`pnpm intents:emit` で `facet-views.json` に emit)・MCP ツール入力・client coerce の `valueType` を導出する。`SemanticPort` 契約と `CanonicalIntent` のワイヤ形は不変で、DSL は正規化の**決定性部分(値域・coerce・ファセット導出)の単一定義**を提供するだけ。

**テナント不変条件(マルチテナント契約)**: `query://` 参照は**テナント中立**に保つ。テナントによるデータ絞り込みは `DomainPort.invoke` が `InvocationContext.principal` / `capability` で行い、`resolveQuery` / `dataVersion` はテナントに依存しない。したがって**キャッシュキーに `tenant` は含めない**(構造が同じ Spec はテナント間でキャッシュ共有するのが正しい)。テナント別のカタログ寄与があれば `catalogFingerprint` がキー成分なので自然に世代分離される。統制プレーン(lineage / 昇格集計 / 固定化)のテナント分離は `SessionContext.tenant`(下記)で行う。本格的なストレージ分離(RLS 等)はプロダクト側の責務。

### 4.3 AuthzPort — capability token

```ts
interface AuthzPort {
  issueCapability(principal, scopes: {kind: "read"|"write", ref: string}[], opts?): Promise<string>;
  verify(token, req: {kind, ref}): Promise<{ ok, principal?, reason? }>;
}
```
ホストは compose 後に Spec 内の全 `$ref` を read スコープで発行し、`/binding/resolve` で検証する。発行者に明示的な `ttlSeconds` が渡されないときの既定 TTL(600 秒)は `DEFAULT_CAPABILITY_TTL_SECONDS` であり、`@kohaku-ui/spec-core` で一度だけ定義され、`@kohaku-ui/host-core` と `@kohaku-ui/authz-hmac` は後方互換のため再 export している。

### 4.4 StoragePort — 永続化

Spec キャッシュ(get/put)、Lineage(append/list)、昇格状態(get/put/list)、固定化(get/put/list)。参考実装: `@kohaku-ui/storage-memory`(`createMemoryStoragePort` / `createFileStoragePort`)。オプショナル拡張 `deleteFixation`(未実装なら `unfixate` は fail-fast で失敗し、監査イベント `intent.unfixated` も記録されない)。

**テナント引数**: `getFixation(intentHash, tenant?)` / `listFixations(tenant?)` / `deleteFixation?(intentHash, tenant?)` は optional 第 2 引数で `tenant` を受け、`putFixation` は `record.tenant` を見て固定化を `(tenant, intentHash)` にキー分離する(シグネチャ不変)。`listLineage` の `LineageFilter.tenant` は一致イベントのみを返す(未指定は全件 = 従来挙動。`tenant` 未記録の旧イベントは無指定フィルタでのみ現れる)。**tenant 非対応のストレージは第 2 引数を無視してよく、その場合テナント間で固定化が共有される(fail-open)** — 本格的なテナント分離は RLS 等プロダクト側の責務。サンプルの `createFileStoragePort` は合成キー(`tenant` なしは `intentHash` そのもの)で分離するため、旧 `fixations.json`(`tenant` なし)は変換なしで互換ロードできる。

**参考実装**: `@kohaku-ui/storage-memory`(インメモリ / ファイル)、`@kohaku-ui/storage-redis`、`@kohaku-ui/storage-postgres` はいずれもこのインタフェースを、オプショナルな `putPromotionStates` / `deleteFixation` と `putFixation` の `ifPresent` も含めて完全実装している。これらは契約に何も追加しない — プロダクトが `StoragePort` を直接実装してもよい。上記の並行性契約はこれらによって変わらない。

### 4.5 LlmPort(フレームワーク内部 Port)

```ts
interface LlmPort {
  provider: string; modelId: string;
  generateObject<T>(req: { schema: ZodType<T> | {jsonSchema}, system?, prompt, temperature?, … }): Promise<{object, usage, model}>;
  generateText(req): Promise<{text, usage}>;
  // 任意。逐次ストリーミングの供給源: 累積 partial を onPartial に通知しつつ最終結果は generateObject と同一。
  // partial は best-effort(プロンプト JSON フォールバック等では通知なし)。消費側は毎回ゼロから組み直す。
  streamObject?<T>(req: GenerateObjectRequest<T> & { onPartial: (partial: unknown) => void }): Promise<{object, usage, model}>;
}
```
実装: `createLlmFromEnv()`(環境変数 §9)。テスト用: `@kohaku-ui/llm/fake` の FakeLlm(`partials` スクリプトで streamObject の partial 列を再現)、`@kohaku-ui/evals` の FixtureLlm。

### 4.6 ThemeTokens(テーマ非依存の色語彙。B2)

Spec エンベロープは**テーマを持たない**(SPEC-ENV-003 — UI Spec は構造のみ)。テーマは Renderer 側で解決する。関連する型と値の住処:

- **型**: `packages/spec-core/src/ports.ts` の `KnownThemeTokens`(既知トークンの語彙。全キー optional)+ `ThemeTokens = KnownThemeTokens & Record<string, string | number>`(開いた index signature で独自トークンも許容 = 後方互換)。
- **既定値**: `@kohaku-ui/renderer-core` の `defaultLightTheme` / `defaultDarkTheme`(spec-core は環境中立なので値を持たない)。解決は `resolveToken(theme, name[, fallback])` が `theme[name] → alias 表 → 明示 fallback(第 3 引数)→ defaultLightTheme` の順にフォールバックする(明示 fallback を既定網より先に置くのは「既定と異なる fallback を尊重する」旧 API 意味論の維持。fallback を省いた 2 引数は既定網へ落ちる)。型は 2 引数版が `keyof KnownThemeTokens`(既知トークン。既定網か alias で必ず解決)、任意文字列トークンは fallback 必須の 3 引数版のみ許可する(2 引数経路の undefined 漏れを型で塞ぐ)。両レンダラー(React `useToken` / WC `tokenStr`)が同一の既定網を引くため、同一 `ThemeTokens` なら React=WC がピクセル一致する(SPEC-A2 parity)。
- **alias**: `color.danger`→`color.negative`、`color.focus`→`color.primary`(既定テーマに実体を持たず alias 表のみで解決)。
- 全トークンの一覧・light/dark 既定値・dark の WCAG AA 方針は [design.ja.md §7.2](design.ja.md) を参照。アプリは `{ ...defaultDarkTheme, ...brand }` の形で基底 + ブランド差分を合成して使う。

## 5. REST API リファレンス(host-rest)

マウント例: `app.route("/api/kohaku", createKohakuRoutes(deps))`。エラーは全ルート共通の封筒:

```json
{ "error": { "code": "CAPABILITY_DENIED", "message": "…" } }
```

コード: `BAD_REQUEST`(400)/ `INTENT_INVALID`(422)/ `CAPABILITY_REQUIRED`(401)/ `CAPABILITY_DENIED`(403)/ `REF_NOT_FOUND`(404)/ `SOURCE_MISMATCH`(404)/ `NOT_FOUND`(404)/ `PROMOTION_INVALID`(422)/ `PROMOTION_NOT_PUBLISHED`(409)/ `COMPOSE_FAILED`(500)/ `INTERNAL`(500)/ `NOT_IMPLEMENTED`(501)。`NOT_FOUND` / `PROMOTION_INVALID` / `PROMOTION_NOT_PUBLISHED` は統制系(promotions)の named ルート用(§5.4)。

コード集合はワイヤ契約なので、型 `HostErrorCode` / `ErrorEnvelope` は **`@kohaku-ui/spec-core` が定義元**(host-rest はサーバー側生成ヘルパ `errorBody` を残しつつ後方互換で再エクスポート)。クライアント側はこれらを型付きで扱う **`@kohaku-ui/client`**(型付きホストクライアント SDK)を使うと、`{spec, capability}` 等の応答と `{error:{code,message}}` を判別可能例外 `KohakuHostError`(`code: HostErrorCode` / `status` / `requestId`)として受け取れる(手書き fetch でコードが文字列に潰れるのを避ける)。SDK の使い方はユーザーガイド §6「クライアントから叩く」を参照。

`ErrorEnvelope.error` は省略可能な **`status`** も持つ。これは 409 `PROMOTION_NOT_PUBLISHED` エンベロープにのみ現れ、バッチ遷移が止まったプロモーション状態(例: `"judge_failed"`)を示す — **応答自体の HTTP ステータスコードとは別物**。クライアント SDK はこれを `KohakuHostError.promotionStatus` として公開する(HTTP ステータスを表す `KohakuHostError.status` と混同しないよう別名にしている)。

**予期しない失敗に対するエラーメッセージ方針**: 500(`INTERNAL` / `COMPOSE_FAILED`)応答、および生の `DomainPort.invoke` の失敗がマップされる 404 `REF_NOT_FOUND` は、元の例外のメッセージをクライアントにそのまま返さない(SQL の断片・スタックトレース・下流ライブラリの文言など内部情報が漏れる可能性があるため)。代わりに固定のホスト側文言を返す。ホスト自身のコードが生成した「型付き」エラー(`SpecError` / `ComposeError` / `QueryRefError`、または `@kohaku-ui/host-core` の `isTypedHostError` が認識する `code` 付きの例外)はメッセージがそのまま通る。元の例外は常に `onError`(上述)には届き、応答が運ぶのと同じ `requestId` で突合できるので、診断に必要な情報は失われない。MCP Apps プロファイルもツールエラーのテキストに同じ方針を適用する。

> ⚠️ **本番配線の注意(認証・認可)**。`createKohakuRoutes(deps)` は認証ミドルウェアを内蔵しない。フレームワークは配線点(Port・フック)を規定するだけで、認証・認可の実体はプロダクト責務である。以下 2 点は**未配線だと fail-open**(誰でも到達可能)になるため、本番配備では配線か外部ミドルウェア(リバースプロキシ / API Gateway 等)での保護が必須:
>
> 1. **データ面(`/compose`・`/events`・`/binding/resolve` 等)**: Principal 抽出フック `KohakuHostDeps.auth`(§5.1)は**未配線だとデモ用 anonymous principal** になる。`/compose` はその principal に対し Spec 内の全 `$ref`(および `data.bind` variant)を覆う read capability を発行し、`/binding/resolve` はその capability を検証して `DomainPort.invoke` に到達する。したがって auth 未配線のままだと**匿名 principal に発行された capability でデータ面へ到達しうる**。テナント / 認可でデータを絞るには `auth`(principal 解決)・`AuthzPort`(capability 発行・検証)・`DomainPort`(principal / capability でのデータ絞り込み)を配線する。
> 2. **統制 / 監査面(`/lineage`・`/analytics/summary`・`/telemetry`・`/promotions` 系・`/fixations` 系)**: 認可フック `KohakuHostDeps.authorizeGovernance`(§5.4)は**未配線だと認可がかからず、統制プレーンを誰でも読み書きできる**(fail-open)。参照実装の宣言的 RBAC 評価器 `createGovernancePolicy`(§5.4)の配線か外部ミドルウェアでの保護が本番では必須。`GET /catalog`(公開部品カタログの読み取り)はこの認可の対象外。

**相関 ID / `X-Request-Id`(運用)**: マウントされた kohaku ルートへのすべてのリクエストには相関 ID がスタンプされる。リクエストごとに一度だけ解決され、受信側の `X-Request-Id` リクエストヘッダが存在し正しい形式(トリム後 128 文字以内・印字可能 ASCII のみ。それ以外は破棄して置き換え)ならそれを使い、なければ新規発番する。同じ ID はすべての応答(成功・失敗を問わず)に `X-Request-Id` 応答ヘッダとしてエコーされ、すべてのエラーエンベロープの `error.requestId` に使われ、後述の `onError` にも渡される——これは `onError` の配線有無にかかわらず成り立つので、配線しなくてもリクエスト相関が「タダで」手に入る。ホストは `KohakuHostDeps.requestId`(TS)/ `request_id`(Python)でこの解決を丸ごと上書きでき、例えば上流インフラの既存の相関 ID 規約に従わせることができる。この相関 ID は無条件に上記のリクエストごとの ID であり、本プロファイルでも MCP Apps プロファイルでも、後述のトレースコンテキストから導出されることは無い。

**トレースコンテキスト伝播(`traceparent` / `tracestate` リクエストヘッダ、運用)**: `/compose` と `/compose/stream`(および共有の fixation セルフヒール経路経由で `/events` / `/fixations/approve`)は、標準の [W3C Trace Context](https://www.w3.org/TR/trace-context/) の `traceparent` / `tracestate` リクエストヘッダも読む。`traceparent` が存在し厳密に整形式(`00-<32 桁の小文字 hex>-<16 桁の小文字 hex>-<2 桁の小文字 hex>`、trace-id・parent-id のいずれも全ゼロでない——どちらも W3C 仕様上は無効)であれば `ComposeOptions.traceContext` へパースされ(配信される `ComposeTrace.traceContext`、失敗/劣化した compose の `ComposeErrorContext.traceContext` にも現れる)、プロダクト側の `ComposeObserver`(例: `@kohaku-ui/otel` の `createOtelComposeObserver`)がその compose を呼び出し側自身のトレースの子スパンとして記録できるようになる。`tracestate` は存在すれば最大 512 文字(W3C 推奨の上限)まで不透明なまま伝わり、それを超えると破棄される(`traceparent` は残る)。`traceparent` が欠落・不正な場合は常にエラーではなく `traceContext` が単に未設定になるだけ(fail-open)——ヘッダを剥ぎ取るリバースプロキシに到達できない場合と同じ扱いになる。デプロイの手前のリバースプロキシがカスタムヘッダを剥ぎ取っていてトレースが繋がらなくなったとき、最初に確認すべきはこのヘッダである。`traceContext` が observer に一切届かないなら、`traceparent` がそもそも届いていない。MCP Apps プロファイル側の対応物はツール呼び出しの `_meta.traceparent` / `_meta.tracestate`(後述 §6)——両プロファイルとも同じ共有パーサで検証する。

**失敗経路の可観測性**: `KohakuHostDeps.onError({ endpoint, requestId, error })`(プロダクト責務。実装はログ/メトリクスを持つ)を配線すると、合成系ハンドラ(`/intent/normalize`・`/compose`・`/compose/stream`・`/events`・`/fixations/approve`)が失敗をエラーエンベロープに変換する前に呼ばれる。渡される `requestId` は応答の `error.requestId` および `X-Request-Id` 応答ヘッダと一致する(ログとクライアントのエラーを突合できる)。フックの `throw` / `reject` は握りつぶしてエラー応答に波及させない。composer を直接組み込む場合は `ComposeObserver.onError(ctx, error)` が同じ役割を担い、`phase:"hard"`(例外送出)/ `phase:"fallback"`(生成失敗の決定的降格)/ `phase:"cache"`(Spec キャッシュバックエンドが例外を投げた。後述の `ComposePolicy.cacheFailure` を参照)を通知する(いずれも観測専用の optional。未配線なら無音)。

### 5.1 合成系

| ルート | リクエスト | レスポンス |
|---|---|---|
| `POST /intent/normalize` | `{ input: NLQuery\|GuiAction, session? }` | `{ intent: CanonicalIntent, source: "llm"\|"deterministic" }` |
| `POST /compose` | `{ intent: {canonical, params} }` または `{ input, session? }` | `{ spec: UISpec, capability: string }` |
| `POST /compose/stream` | `/compose` と同一 | SSE: `event: spec {spec, capability, final}` → `event: patch {patch}` → `event: done {specHash, tier, cache}`(または `event: error`)。SPEC §6.1.1 [Draft] |
| `POST /events` | `{ intent: {canonical, params}, event: {on, payload}, session? }` | `{ spec, capability }`(イベント → GuiAction → 再合成) |

- `session` = `{ surface: "web"\|"chat"\|…, sessionId?, locale? }`(lineage に記録される。`locale` は `"en"` / `"ja"` のような任意の言語タグ — `SessionContext.locale` へ透過され、NL 正規化ヒントと、サンプルではセッション単位の出力言語 policy に使われる。後述「生成テキストの出力言語」参照)
- **`NLQuery.locale` と `session.locale` の違い**: `{input}` NLQuery 自身が持つ任意の `locale` フィールドは NL 正規化のヒントに過ぎない — 存在する場合、その用途に限り `session.locale` より優先される(サンプルの `normalizeNl` は `input.locale ?? ctx.locale` を解決する)。出力言語の選択(下記 `ComposePolicy` / `policyFor`)と固定化短絡の言語ゲート(`fixationLookup`)はいずれも `session.locale` のみで駆動され、呼び出しごとの `NLQuery.locale` はどちらの代わりにもならない。
- **テナント**: `SessionContext.tenant` はリクエストボディでなく `KohakuHostDeps.tenant(c)`(プロダクト責務。サンプルは `x-kohaku-tenant` ヘッダ)が解決する。解決値は lineage 記録・固定化短絡・統制系の集計スコープに伝播する。省略時は単一テナント相当(従来挙動)。**キャッシュキーには含めない**(§4.2 の不変条件)
- `/compose` は固定化短絡(`fixationLookup`)→ Spec キャッシュ → composer の順で解決。
- `/compose/stream` はスケルトン(`ui.loading`)を即時に返し、**生成中の暫定 patch(0..N 回。`LlmPort.streamObject` 実装時のみ — LLM の部分出力から組んだ暫定 Spec への差分)**と確定形への `patch` を後送する。受信側は受信順に `applyPatch` するだけでよい(各適用結果は常に構造検証済みの Spec)。速い経路(cache hit / L0 / 固定化)は `final: true` の 1 イベントで完結し、その `capability` は `/compose` と同じ規則(下記「capability の発行スコープ」— 最終 Spec が宣言する `action.invoke` の write スコープを含む)に従い**最終 Spec 自体から発行する**。スケルトン(`final: false`)はまだ `$ref` を持たないため、代わりに解決済みの ref から read 専用で発行する。`data.bind`(双方向バインディング [Draft])は最終 Spec にのみ宣言され L1/L2 生成には開放されないため、スケルトンは bind variant を運ばず、後続の patch で届く L1/L2 生成 Spec も write スコープを持たない(ストリーム越しに `action.invoke` を運べるのは単一イベントで完結する `final: true` 応答のみ — 既知の制約)。途中形(スケルトン・暫定 Spec)はキャッシュ・固定化・lineage 記録の対象外(最終 Spec に対してのみ記録)。
- **capability の発行スコープ**: `/compose`・`/events`・`/compose/stream` の `final: true` 経路は Spec の宣言に合わせて発行する。read は全 `data.$ref`。`data.bind`(双方向バインディング [Draft])を持つ部品は `values` の直積で到達しうる effective ref を `enumerateBindVariants` で列挙し、各 variant を read スコープで発行する(初期 variant = `$ref` を含む)。write は宣言済み `action.invoke` の action 名を**`DomainPort.listOperations()` が列挙する名前と積集合を取ったもの**——DomainPort が列挙していないアクションの write スコープは発行前に落とされ(L1/L2 生成が捏造・注入した `action.invoke` アクション名がベアラ型の write スコープになることへの防御)、発行元ルートを endpoint として `onError` に `WriteScopeDroppedError` として通知される。それでも capability 自体はそのスコープを欠いたまま発行される(fail-open)。read スコープはこのフィルタの影響を受けない。これにより client が `$state` を変えて再解決しうる ref だけが認可され、`values` 外は 403(偽造禁止)。variant 総数の上限は 256 で、発行経路によらず適用される(stream の `final: true` 経路での超過は `/compose` の 500 `COMPOSE_FAILED` に対応する `event: error COMPOSE_FAILED` になる)。
- **クライアント切断の伝播**: `/compose`・`/compose/stream`・`/events` は `c.req.raw.signal` を `ComposeOptions.abort` として composer に渡し、L1/L2 の LLM 生成(修復ループ含む)へ貫通させる。放棄されたリクエストのフル生成を打ち切り、`AbortSignal.timeout` と合成される。中断で投げられる例外(`ABORTED`)は transient な provider 障害とは別に分類され、修復再試行せず・L2 昇格せず即フォールバックに落ちる(`SemanticPort.normalize` への貫通は現状スコープ外)。生成されたフォールバック Spec は `trace.cancelled:true` を持ち(`provenance.fallback.kind` は `"generation"` のまま — キャンセルは新しい fallback kind ではない)、`ComposeObserver.onError` には `phase:"fallback"` ではなく `phase:"cancelled"` として通知される。ホストはキャンセル済み compose に対して lineage 記録(`view.composed`/`view.fallback`)をスキップするため、放棄されたリクエストが実際の生成失敗と同じように fallback レート分析を押し上げることはない。
- **コスト/トークン予算ガード**: `ComposePolicy.budget` を配線すると、composer は LLM を呼ぶ直前(L1 生成前・修復前・L2 前)に予算を判定し、拒否時は修復再試行・L2 昇格をスキップして決定的フォールバック(`presentMarkdown`)へ降格する。`perCompose.stopAfterTokens` は**追加の LLM 呼び出しを止める累積トークン閾値**(合計のハード上限ではない)、`check()` はプロダクト供給のグローバル予算フック(副作用のない冪等な読み取り。`throw` は fail-open で `ComposeObserver.onBudgetCheckError` に転写)。降格 Spec は `provenance.fallback`(`kind:"generation"`)の `reason` で予算超過が判別でき、**キャッシュしない**(`ComposeObserver.onError` に `budgetExceeded:true`)。**`budget` 未指定なら挙動・性能とも完全不変**。詳細は [design.ja.md#budget-guard](design.ja.md#budget-guard)。
- **compose 全体のデッドライン**: `ComposeBudget.deadlineMs`(compose 開始からの経過ミリ秒)は `perCompose` の兄弟概念で、単一の LLM 呼び出しではなく `compose`/`composeStream` 呼び出し全体を縛る — トークン予算と同じポイントで判定し、さらにデッドラインが実行中の呼び出しの途中で経過した場合はその呼び出しを中断させる。デッドラインによる実行中中断は、呼び出し元によるキャンセルとしてではなく、呼び出し間スキップと同じ扱い(`ctx.budgetExceeded:true`。`trace.cancelled` は立てない)に分類されるため、オペレーターが監視する fallback レート分析に加算される。既定は未設定で、一度も設定しなければ挙動・性能とも不変。詳細は [design.ja.md#deadline-guard](design.ja.md#deadline-guard)。
- **L2 へのデザインシステム適用**: `ComposePolicy.designSystem`(`DesignSystemGuide = { tokens?, guidelines?, enforceTokenColors?, kit?, enforceKitClasses? }`)を配線すると、L2 生成プロンプトに「デザインシステム」節が挿入され、生成物はトークン参照 `var(--kohaku-*)` でスタイルを書く契約になる(値は描画時に sandbox が注入 — SPEC-ENV-003 のテーマ非依存を維持)。`enforceTokenColors`(既定 true)は色直書きを `L2_RAW_COLOR` lint(§8)で修復差し戻しする。`kit`(`DesignKitVocabulary`。組み込みは `DEFAULT_KIT_VOCABULARY`)を配線すると「デザインキット」節にキットクラス・ユーティリティ語彙が追加提示され、対になる `enforceKitClasses`(既定 true)が語彙にないキット名前空間のクラス名を `L2_UNKNOWN_CLASS` lint(§8)で差し戻す。**内容の変更・on/off はプロンプト内容の変化なので `generatorVersion` を必ず bump する**(few-shot と同じ運用)。未指定なら挙動・出力バイトとも完全不変。詳細は design.md §8「L2 へのデザインシステム適用」。
- **生成テキストの出力言語**: `ComposePolicy.outputLanguage`(言語名の文字列。既定 `"English"`)は、LLM が生成する表示文言 — L1 の見出しタイトルと L2 ウィジェット文言(`<title>`・ラベル・注記)— の言語を、両生成プロンプトに「Output language」節を挿入して選ぶ(プロンプト自体の言語に関係なく出力が指定言語に従う)。レンダラーの i18n 上書き(ライブラリ既定 UI 文言を差し替えるだけ)とは直交する。**プロンプト内容の変化なので `generatorVersion` を必ず bump する**(few-shot / designSystem と同じ運用)。未指定ならプロンプトのバイト列は完全不変。セッション単位の選択: `session.locale` + `ComposeContext.policyFor` がセッションごとの policy に差し替える(サンプルの EN/JA 対 — JA は `outputLanguage: "Japanese"`・JA の L0 固定スペック・`…/ja` の generatorVersion トークンを持ち、キャッシュが言語別に分離される。固定化ショートカットは EN セッションのみ)。詳細は [design.ja.md#output-language](design.ja.md#output-language)。
- **`data.$ref` の制約段階**: `ComposePolicy.refConstraint: "schema" | "validate"`(既定 `"schema"`)は CMP-GEN-001(SPEC §4)をどこで強制するかを選ぶ。`"schema"`(既定・不変)は L1 生成スキーマ自体で `data.$ref` を解決済み QueryHandle 集合の enum に固定する。`"validate"` はスキーマ側ではプレーンな文字列に緩和し(生成文法が intent 非依存になる — トレードオフは [design.ja.md#prompt-caching](design.ja.md#prompt-caching) 参照)、生成後に明示的に集合所属を検査して、L1 が catalog/構造検証の失敗に既に使っている同じ修復ループへ `DATA_REF_UNRESOLVED` の所見を送り返す。`policyFingerprint` へは `"validate"` 指定時のみ参加する — 既定の `"schema"`(明示指定でも未指定でも)は既存のキャッシュキーを動かさない。
- **推論エフォート**: `ComposePolicy.effort?: { l1?: LlmEffort; l2?: LlmEffort }`(`LlmEffort = "low"|"medium"|"high"|"xhigh"|"max"`)が、L1/L2 の LLM 呼び出しへ `GenerateObjectRequest`/`GenerateTextRequest.effort` として独立に渡される。tier を未指定にすると `effort` を一切送らない(プロバイダ既定)。対応オプションの無いポート/プロバイダは無視する(プロバイダごとの配線は [design.ja.md#reasoning-effort](design.ja.md#reasoning-effort) を参照)。`policyFingerprint` へは何らか設定時のみ参加し、未指定はこの機能導入前とバイト同一。
- **tier ごとの LLM**: `ComposeContext.llmByTier?: { L1?: LlmPort; L2?: LlmPort }` は単一の `llm: LlmPort` を tier ごとに上書きする(必須の `llm` は上書きされない tier のフォールバックのまま)— 例えば `kohaku dataset export` でファインチューニングした小型モデルを L1 に回しつつ L2 には大型モデルを維持する用途。基底モデルと実際に異なる tier ごとのモデル識別を `policyFingerprint` の追加素材へ畳み込むため、キャッシュは自動的に分離される。未設定(または基底モデルと一致するエントリのみ)はこの機能導入前とバイト同一。詳細は [design.ja.md#per-tier-llm](design.ja.md#per-tier-llm)。

```bash
# 例
curl -s -X POST http://localhost:8787/api/kohaku/compose \
  -H 'content-type: application/json' \
  -d '{"intent":{"canonical":"sales.quarterly_summary","params":{"fiscalYear":2026,"quarter":3,"groupBy":"region"}}}'
```

### 5.2 データ系

| ルート | 認可 | 内容 |
|---|---|---|
| `GET /binding/resolve?ref=<encoded query://…>` | `Authorization: Bearer <capability>` 必須 | TabularData を返す。401(なし)/ 403(スコープ外)/ 404(未知 source/op)。`_` 予約パラメータ(ページング/ソート)は base ref で capability 検証し、DomainPort に合流させる |
| `POST /binding/action` `{action, payload}` | Bearer(write スコープ) | 書き込み直結路(presentForm submit 等)→ `{result, invalidates?, refVersions?}` |

`POST /binding/action` の応答は `{result, invalidates?, refVersions?}`。`invalidates` は書き込みが陳腐化させた `query://` URI(完全一致)の配列、`refVersions` は参照単位の新しいデータ版(`§2` の refVersions と同義)。`KohakuHostDeps.actionEffects(action, payload, result)` フックが供給する(未配線なら `{result}` のみ = 後方互換)。クライアント(`BindingClient.invokeAction`)は成功時に `invalidates` をデータ無効化バスへ流し、離れた表を in-place 再解決させる(**小ループ**。§6 参照)。`DomainPort` は不改変で、書き込み実体は `domain.invoke`、副作用の「宣言」だけを `actionEffects` に分離する。

### 5.3 カタログ・監査系

| ルート | 認可 | 内容 |
|---|---|---|
| `GET /catalog` | —(公開読み取り) | `{ components: [{type, version, description, capabilities, implementation, propsSchema(JSON Schema)}], catalogVersion }` |
| `GET /lineage?type=&intentHash=&artifactId=&specHash=&since=&until=&limit=` | `authorizeGovernance`(配線時) | `{ events: LineageEventRecord[] }`。`since` / `until` は ISO8601(`/analytics/summary` と同一の正規化・境界解釈)、`limit` は上限 1000 |
| `GET /analytics/summary?since=&until=&limit=` | `authorizeGovernance`(配線時。`analytics.read`) | `{ window, summary }`。lineage の生イベント列を集計した俯瞰サマリ(下記)。**参照実装レベルの拡張**(本書 §11 の必須集合外) |
| `POST /telemetry` | `authorizeGovernance`(配線時) | `{ events: [{kind:"rendered", specHash,…} \| {kind:"componentUsed", artifactId, outcome}] }` → `{ok}` |

**利用分析(`GET /analytics/summary`。参照実装の拡張ルート)**: 運用者が fallback 率・tier 分布・レイテンシを俯瞰するための集計面。`KohakuHostDeps.analyticsSummarizer`(`@kohaku-ui/lineage` の純関数 `summarizeLineage` を注入。host-rest は lineage 非依存のまま構造型で受ける)を配線したときのみ有効で、未配線なら 501 `NOT_IMPLEMENTED`。集計は `StoragePort.listLineage` の**読み取りだけ**で実装し、**Lineage イベントスキーマは変更しない**(既存 payload の `tier` / `cache` / `durationMs` / `intentHash` / `canonical`、`view.fallback` の `kind` を数えるのみ)。認可 `operation.kind` は `analytics.read`(read 系。サンプルは admin/reviewer/viewer とも許可)。テナントは他の統制面と同じく**セッション(`KohakuHostDeps.tenant`)由来**でスコープする(クライアント申告でなくサーバー解決)。**集計窓は既定 200 件 / 上限 1000 件**(`/lineage` と同じ制約)で、応答の `window: { limit, truncated, since?, until?, tenant? }` にクランプ後の窓を明示する(silent cap にしない。`truncated` は storage が窓上限ちょうどを返し、より古いイベントが窓外に落ちうることを示す)。`since` / `until` は **`LineageFilter` として `listLineage` へ渡し、時刻の絞り込みを `limit` の tail slice より前に適用する** — 窓は `[since, until]` の最新 `limit` 件になる(`until` を tail slice の後に掛けると、最新 `limit` 件が `until` で全除外され窓がほぼ空になるため)。`summarizeLineage` 側にも同じ `until` 後段フィルタを残すが、これは冪等な防御で、実際の窓絞りは storage 段で完結する。`summary` は `{ events, composed, tiers{L0,L1,L2}, cache{hit,miss,bypass,fixated,other}, fallback{total, byKind{generation,negotiation,unspecified}, rate}, durationMs{count,p50,p95,p99,max}, topIntents[{intentHash,canonical,count}], promotions{generated,used,nominated,schemaSuggested,judged,reviewed,schemaEdited,published,withdrawn}, fixations{fixated,unfixated}, review{count, durationMs{p50,p95,max}, acceptedAsIs} }`。`fallback.rate = total / (composed + total)`(分母 0 なら 0)、`durationMs` 分位は `durationMs` を持つ `view.composed` のみを母集団とする nearest-rank(取れる範囲での集計)。`review` は人間によるレビューの所要時間を計測する: 各候補の `component.nominated` と、その次に来る decision が approve か reject の `component.reviewed` とを(`(tenant, artifactId)` 単位で)対にする(`requestChanges` は対を閉じない)。`acceptedAsIs` は `changed` が空 **かつ** `acknowledged` が `true` の `component.schemaEdited` レコード数(機械提案が無編集で承認され、かつレビュアーが確認済みとしたもの)を数える。`acknowledged` フィールドが無い記録や `acknowledged: false` の記録は数えない。

### 5.4 統制系(promotions / fixations 注入時のみ。未注入は 501)

| ルート | 認可 | 内容 |
|---|---|---|
| `GET /promotions` | `authorizeGovernance`(配線時) | `{ candidates: PromotionCandidate[] }`。**副作用なしの読み取り専用**(自動候補化はしない)。**任意の `?status=<PromotionStatus>` で状態別に絞れる**: 指定時は `listByStatus`(スナップショット投影 `listPromotionStates` を索引に使い、全 `component.generated` スキャンを避ける)で引く。`status=in_use` だけは永続状態を持たないためイベントスキャンに委ねる。各候補は加法的な optional `suggestion`(`{ draft, events, confidence, model, extractorId, extractorVersion, suggestedAt }`)を持ちうる: ホストの `suggestSchema` フック(参照実装では `@kohaku-ui/evals` の `createSchemaExtractor`)が自動候補化時に付与する、機械抽出による登録提案。あくまで助言であり(`approve` はレビュアー自身の `draft` を採る)、extractor が未配線または抽出に失敗した場合は不在になる(fail-open。promotions の `onError` フックへ endpoint `promotion.suggest.schema` として報告される) |
| `POST /promotions/evaluate` | `authorizeGovernance`(配線時) | 利用ログ閾値で **自動候補化(nominate)** を実行し `{ candidates }` を返す(GET から分離した副作用ルート) |
| `POST /promotions/reconcile` | `authorizeGovernance`(配線時; kind `promotion.reconcile`) | オペレータ用の逃げ道: 起動時と同じ**スナップショット権威からの投影復旧**をオンデマンドで実行し `{ summary: { published, withdrawn, skipped } }` を返す。1 artifact・1 テナントに限定されない(全テナント横断で走査する)ため、`promotionTransition` の `:artifactId` 用骨格ではなく promotion ロックのテナント無し用バケットで直列化する — このバケットは*テナント指定の* approve/withdraw とは直列化しないため、このルートの走査とその候補ごとのロードの間にそれが割り込みうる。`reconcile()` 自身がそのロード直後に各候補の最新 status を再確認し、陳腐化したエントリには黙って手を出さない(design.md 参照)ため、既に状態が動いた候補に対して投影変更を適用することはない。`PromotionsApi.reconcile` 未実装なら `501 NOT_IMPLEMENTED` |
| `GET /promotions/:artifactId` | `authorizeGovernance`(配線時) | `{ candidate }`。不在は 404 `NOT_FOUND` |
| `POST /promotions/:artifactId/preview` | `authorizeGovernance`(配線時) | `{ preview: { html, sha256, ref?, capability? } }`。**レビュー対象そのもの(`component.generated` に記録済みの artifact)の再現マウント材料**を返す。再 compose はしない(キャッシュ落ち時に LLM が別内容を再生成し「承認対象と違うもの」を見せる事故を防ぐ — 同一性は `sha256` で保証)。生成時のデータ参照 `ref` が記録されていれば、**当該 1 参照限定の read capability** を発行して同梱する(書き込みスコープなし。トークンを新規発行するため POST)。認可 `operation.kind` は **`promotion.preview`** — 閲覧(`promotion.get`)と別権限にし、データ read 権の発行を閲覧ロールに開かない。html 未記録・不在は 404 `NOT_FOUND` |
| `POST /promotions/:artifactId/approve` | `authorizeGovernance`(配線時) | body `{ draft, acknowledgedSuggestion? }`(zod 検証)→ judge → 人間承認 → schema 確定 → publish の一括 → `{ candidate }`。`acknowledgedSuggestion`(追加・任意の boolean)はレビュアーが「提案を確認した」チェックボックスにチェックしたかを記録する。`component.schemaEdited` に `acknowledged` として記録されるのみでサーバー側の強制はしない(未指定は `acknowledged: false`)。`draft` は配線済みの judge にも context として渡され、機械提案だけでなく実際に登録される schema そのものを採点できるようにする。**`changes_requested`(差し戻し)または `judge_failed`(ブロッキングなジャッジ失敗)からも nominate 経由で candidate に戻して同一チェーンへ復帰する(修正して再承認・再ジャッジ)**。既に **published** の候補への再 approve は冪等: nominate/judge/review を繰り返さず、投影フック(`onPublish`)だけを再実行してそのまま返す — 先行する部分的失敗で反映されなかった投影を、次の `reconcile` を待たずに収束させる |
| `POST /promotions/:artifactId/reject` | `authorizeGovernance`(配線時) | `{ candidate }`(nominate → review.start → review.reject) |
| `POST /promotions/:artifactId/withdraw` | `authorizeGovernance`(配線時) | body `{ reason? }` → published なら unpublish(published→withdrawn)、非終端なら withdraw → `{ candidate }` |
| `POST /promotions/:artifactId/actions` | `authorizeGovernance`(配線時。kind スコープ認可あり。後述) | body `{ action }`(`PromotionActionSchema` の discriminatedUnion で検証)→ `{ candidate }` |
| `GET /fixations` / `GET /fixations/proposals` | `authorizeGovernance`(配線時) | 固定化済み一覧 / 候補(uses・sessions・構造安定度) |
| `POST /fixations/approve` | `authorizeGovernance`(配線時) | `{ intent: {canonical, params} }` → 現在の合成結果を pin → `{ fixation }`。結果が決定的フォールバック Spec の場合は 422 `COMPOSE_FAILED`(生成失敗を L0 として固定化してはならない)、L2 自由形式 Spec の場合は 400 `BAD_REQUEST`(固定化ではなく昇格パイプラインの管轄) |
| `POST /fixations/:intentHash/remove` | `authorizeGovernance`(配線時) | 固定化解除 → `{ok}` |

**統制プレーンの認可(`authorizeGovernance`)**: 監査・統制系ルート(§5.3 の `GET /lineage`・`GET /analytics/summary`・`POST /telemetry` と本節の promotions / fixations 一式)は、`KohakuHostDeps.authorizeGovernance` フック(オプショナル)の配線時に各リクエスト前で認可判定を通し、拒否時は 403 `CAPABILITY_DENIED` を返す。未配線時は fail-open(§5 冒頭「本番配線の注意」参照)。`GET /catalog` はこの認可の対象外。

**参照実装の宣言的 RBAC 評価器(`createGovernancePolicy`)**: `@kohaku-ui/host-rest` は `authorizeGovernance` の代表的実装として、ロール → 許可 operation のマトリクスを宣言的に書ける評価器 `createGovernancePolicy(policy)` を供給する。`policy.roles` は「ロール名 → 許可パターン配列」で、パターンは完全一致の `operation.kind`(例 `promotion.approve`)、`<域>.*`(域内全許可。例 `promotion.*`)、`*`(全許可)をサポートする。`operation.kind` の実在集合は `GOVERNANCE_OPERATION_KINDS` として型 `GovernanceOperationKind` に反映され、ルート側・ポリシー側双方のタイポをコンパイル時に弾く。評価器は `(principal, operation, tenant?) → boolean` の**純関数**で、principal(ロール)の解決は配線側(`KohakuHostDeps.auth`)の責務 — RBAC のロール解決はプロダクトの認証基盤に委ねる、という分業に沿う。なお同梱評価器は**ロールのみで判定し `tenant` を無視する**(ロールを持つ principal はホストが解決した任意テナントに操作できる)。テナント境界まで強制する場合は principal↔tenant の紐づけを検証する独自評価器を供給する。既定は **deny-by-default**(どのロールのパターンにも一致しない operation、未知ロール、ロールなしはすべて拒否)。複数ロールは権限の和集合。サンプル(`apps/sample-api`)は `x-kohaku-role` ヘッダ(デモ用。実運用は認証基盤から解決)でロールを解決し、`admin`(全許可)/ `reviewer`(`promotion.*` + `lineage.read` + `analytics.read`)/ `viewer`(読み取りのみ。`lineage.read` / `analytics.read` を含む)の 3 ロールを配線する。**ヘッダ無し(既定)は `admin`** とし、未配線時の従来デモ挙動(統制面が誰でも通る)を保つ。

**汎用アクションルートの kind スコープ認可**: `POST /promotions/:artifactId/actions` はまず上表の一括 `promotion.act` を検査し、その後、検証済みの `action.kind` に応じて実行前にもう 1 つ追加の kind を検査する — これにより `promotion.act` だけを持つロールが、named ルート(`/approve`・`/reject`・`/withdraw`)がそれぞれ自分の kind で守っている遷移に到達できないようにする。対応表: `review.approve` / `publish` / `schema.propose` → `promotion.approve`。`review.reject` → `promotion.reject`。`withdraw` / `unpublish` → `promotion.withdraw`。`judge.result` → **`promotion.judge`**(judge 判定の記録 — 専用の approve フローが信頼する値 — を、`promotion.act` しか持たない呼び出し元に詐称されないよう新設した kind)。`nominate` / `judge.start` / `review.start` / `review.requestChanges` は対応する named ルートが無いため追加 kind 不要。`promotion.*` や `*` パターンで付与されたロールは `promotion.judge` も自動的にカバーする。個別に governance kind を列挙するポリシーでは、汎用ルート経由で judge 判定を記録させたいロールに明示的に追加する必要がある。

**昇格の検証・エラー規約**:

- `reviewer` / `by`(`Principal`)は**クライアント申告を受けず、サーバー側 principal(`KohakuHostDeps.auth` → 既定 anonymous)を注入する**。approve/reject/withdraw/actions すべてに適用。
- zod parse 失敗 → 400 `BAD_REQUEST`(action.kind 不正、`publish` の version 欠落、approve の draft 欠落など)。
- artifact 不在 → 404 `NOT_FOUND`(`get` で事前判定)。
- 遷移拒否(`TransitionError`)→ 422 `PROMOTION_INVALID`。
- approve が published に到達しなかった(judge 不合格等)→ 409 `PROMOTION_NOT_PUBLISHED`(`{error:{code, message, status}}`)。
- `PromotionsApi` の `list?` / `get?` / `listByStatus?` / `reconcile?` は optional(未実装の独自ホストでは GET /promotions が `evaluateAndList` にフォールバックし、GET /promotions/:id は 501、POST /promotions/reconcile も 501)。`?status=` は `listByStatus` 非対応なら `list`/`evaluateAndList` の結果を状態でクライアント側フィルタして縮退互換する。`approve` / `reject` / `withdraw` は required(外部実装には破壊的変更)。
- **`changes_requested` / `judge_failed` からの復帰**: 状態機械の遷移表は不変(`changes_requested --nominate--> candidate` と `judge_failed --nominate--> candidate` は既存)。サービス層 `approve()` の入口を `in_use` に加えて `changes_requested` と `judge_failed` でも nominate するよう広げ、差し戻された(またはジャッジ失敗した)候補を candidate に戻して judge → 人間承認 → publish の同一チェーンへ再合流させる — ブロッキングなジャッジ失敗で `judge_failed` に留まった候補を、専用の復帰 API なしに再 approve だけで再ジャッジできる。`reject()` の復帰対象は現状 `in_use`/`candidate`/`in_review` のみで、`changes_requested`/`judge_failed` からの却下はサービス層の復帰対象外(放棄は `withdraw` へ一本化。sample-web の管理面もそれに合わせてそれらの状態では reject を出さない)。
- **`reconcile()` は起動時に限らずオンデマンドで呼べる**: 上記 `POST /promotions/reconcile` により、オペレータはいつでも投影復旧パス(published/withdrawn の再適用 + 監査バックフィル)を強制でき、実施内容の要約 `{ published, withdrawn, skipped }` を受け取れる。published スナップショットの投影を再構築できなかった件(スナップショット自身の複製した `html` も `component.generated` も無い)は `skipped` に計上され、`onError` 監視フックでも個別に報告される。

**テナントスコープ**: 統制面(`GET /promotions`・`POST /promotions/evaluate`・`GET /fixations`・`GET /fixations/proposals`・`POST /fixations/approve`・`POST /fixations/:intentHash/remove`)のテナントは**クエリパラメータでなくセッション(`KohakuHostDeps.tenant`)由来**に統一する(取り違え防止)。`list` / `evaluateAndList` / `proposals` は `scope.tenant` で集計を絞り、`fixate` は当該テナントに固定化を刻む。昇格の状態機械アクション(`approve` / `reject` / `withdraw` / `act`)も末尾の `scope`(`{ tenant? }`)引数で解決済みテナントを受け取り、候補の帰属テナント(`component.generated` のテナント)と照合する — 不一致は「存在しない」扱いとなり、呼び出し元には 404 が返る(テナント越境の漏洩ではない)。固定化短絡(`fixationLookup(intentHash, session)`)と自己修復(`invalidate` / `refreshFingerprint`)も `session.tenant` を伝播する。

**固定化の陳腐化検出**: 固定化配信の前に、固定化時点の**カタログ指紋**(`FixationRecord.catalogFingerprint`、optional = 旧 `fixations.json` 互換)を現行カタログ指紋と突合する。

- **fresh**(指紋一致): 構造は不変とみなし再検証を省いてそのまま配信(`cache:"fixated"` 不変)。
- **revalidated**(指紋不一致/欠落だが現行カタログで `pinnedSpec` を再検証して通過): そのまま配信し、`FixationsApi.refreshFingerprint?` で現行指紋を刻み直して以後を fast path 化する(旧レコードの自然移行。失敗しても配信は止めない)。
- **stale**(検証不通過): 固定化を配信せず、`FixationsApi.invalidate?(intentHash, "stale", { detail?, tenant?, guard? })` で自己修復無効化(`deleteFixation` → `intent.unfixated` を `actor:{kind:"system"}`・`reason:"stale"` で記録)し、通常 compose にフォールバックする。`deleteFixation` 未実装で無効化が失敗しても配信は継続する(固定化が残り毎回 revalidate 失敗→フォールバックの縮退運転)。`guard` は `{ ifCatalogFingerprint?: string; ifFixatedAt?: string }`。`ifFixatedAt` は常に渡され(stale 判定時点の固定化の `fixatedAt` と突合し、カタログ指紋を持たない旧レコードも並行再承認から守る)、`ifCatalogFingerprint` は固定化が指紋を持つ場合に追加される。
- **参照集合の突合(fresh / revalidated 共通の追加判定)**: カタログ指紋の判定を通過した固定化でも、配信前に固定化 Spec が表す**解決済み参照 URI の集合**(`refVersions` のキー集合。`refVersions` を持たない旧レコードは pin 済み部品の `data.$ref` の集合)が、現行 Intent を `resolveQuery` で解決した URI 集合と一致することを確認する。URI の追加・削除・差し替えで集合が食い違えば、指紋一致(fresh)でも **stale** 扱いとして同じく通常 compose にフォールバックする。カタログ指紋は部品の型/props 由来で query 写像に非依存なため、同一 Intent でもコード改版・semantic 層の変更で参照集合がドリフトすると指紋判定だけでは捕捉できない。ドリフトしたまま配信すると `refVersions`(SPEC-DATA-002)の参照単位突合が壊れる(削除された参照は常時 STALE 表示、追加された参照は対応部品が無いまま配信される)ため、安全側に倒す。

判定は composer の `materializeFixation` が `{result, check}` で返し(`check: "fresh" | "revalidated" | "stale"`)、lineage 記録(自己修復イベント)は依存方向の都合で host 層が行う。MCP Apps プロファイル(host-mcp-apps)も同じ挙動を持つ(`McpHostDeps.fixations?` 配線時)。

### 5.5 サンプル固有ルート(host-rest 外)

`GET /api/health`(LLM・シード・カタログ版・intent 一覧)/ `POST /api/kohaku/admin/bump-data-version`(デモ用のキャッシュ無効化ルート。identity + governance RBAC 配下で、operation は `admin.bumpDataVersion`、admin のみ許可。host-rest のマウントより前に登録され、同じ `bodyLimit` / `identity.middleware` の対象になる。JWT では `KOHAKU_DEMO_ADMIN_ROUTES=1` を指定しない限り無効。§9 参照)。

昇格の承認/却下/取り下げは host-rest の named ルート(§5.4 の `POST /promotions/:id/approve|reject|withdraw`)に一級化した。以前あった `POST /api/admin/promotions/:id/approve|reject` は削除し、sample-web の管理面もそちらを叩く(reviewer はサーバー側 principal を注入するので、クライアントは承認者を申告しない)。

## 6. MCP Apps プロファイル(host-mcp-apps)

| 要素 | 値 |
|---|---|
| リソース | `ui://kohaku/renderer.html`、mimeType `text/html;profile=mcp-app`。リソース側 `_meta.ui` に csp を空 allowlist(`{connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: []}` = 外部オリジン不要)で明示宣言(`resourceUiMeta()`。resources/list と read contents の両方・contents 優先)。csp / permissions はツール側 `_meta.ui` には置けない(SEP-1865) |
| `legacyUiResource`(AttachOptions・既定 off) | mcp-ui レガシーホスト互換。有効時、compose 系ツール結果の content[] に自己完結スナップショット HTML を `{type:"resource", resource:{uri:"ui://kohaku/view/<intentHash>", mimeType:"text/html", text}}` で後置(静的表示・fail-open・約 1MB/結果 — modern ホストでは無効のまま)。sample-mcp は env `KOHAKU_MCP_LEGACY_UI=1` で opt-in |
| ツール `_meta`(UI 宣言) | **modern と legacy を併記**。modern(ネスト)= `_meta.ui.{resourceUri, visibility}`(SEP-1865 正式化 2026-01-26 以降の正。ChatGPT 等はこちらを第一に見る)。legacy(フラット)= `_meta["ui/resourceUri"]` / `_meta["ui/visibility"]`(`["model"]` or `["app"]`。旧ホスト後方互換)。値は同一。定数は `packages/host-mcp-apps/src/meta.ts`(`UI_META_KEY` / `RESOURCE_URI_META_KEY` / `VISIBILITY_META_KEY`) |
| `kohaku_compose` | model 可視。`{question, locale?}` → content[0] = テキストフォールバック、structuredContent = `{spec}`。capability トークンは `_meta["kohaku/capability"]` に載る(MCPAPP-CAP-001。`structuredContent` ではない — bearer な書き込みトークンをモデルのコンテキストに入れないため) |
| `kohaku_render_snapshot` | model 可視(`snapshotWriter` 配線時のみ登録)。`{question, locale?}` → Web と同一の共有レンダラーで描画する自己完結 HTML を書き出し、パスを返す。Spec の各 data を初期 `$ref` + 全 bind variant で事前解決してレンダラーの `#kohaku-snapshot`(`{spec, data}`)に埋め込む。UI 非対応ホスト(CLI 等)で iframe に依らず表示するための静的スナップショット(再合成イベントは無効) |
| `kohaku_resolve_binding` | **app 専用**。`{ref, capability}` → `{data: TabularData}` |
| `kohaku_event` | **app 専用**。`{intent, on, payload, locale?}` → structuredContent = `{spec}`、capability は `kohaku_compose` と同様 `_meta["kohaku/capability"]` |
| `kohaku_action` | **app 専用**(書き込み直結路)。`{action, payload?, capability}` → `{result, invalidates?, refVersions?}`。capability 検証の前に `action` を `DomainPort.listOperations()`(host-core の `createAllowedActions`。capability 発行と共有)と突き合わせ(未知の action は `isError`)、`payload` を canonical JSON 64KB で上限を課す(超過も `isError`。`OperationDescriptor.paramsSchema` によるフル検証は後続課題)。そのうえで write スコープ(`{kind:"write", ref:action}`)の capability を検証する。`invalidates` / `refVersions` は副作用宣言(`McpHostDeps.actionEffects`)配線時のみ載り、未配線なら `{result}` のみ = 後方互換 |
| intentTools | `attachKohakuToMcpServer` の opts で型付きツールを追加可能。`intentToolsFromCatalog(defs)`(host-mcp-apps)が `{name, description, params: ZodObject}` の配列から機械生成する。canonical 名は MCP 命名制約([A-Za-z0-9_-])へ正規化(`sales.quarterly_summary` → `sales_quarterly_summary`)、正規化後の衝突は起票時にエラー |
| `locale`(共有ツール引数) | UI を生成する全ツール(`kohaku_compose` / `kohaku_render_snapshot` / 生成 intent ツール群 / `kohaku_event`)は optional な `locale`(言語タグ。例 `"ja"`)を受け付ける。呼び出し側 LLM が利用者の環境・会話言語に合わせて設定し(ツール説明に明記)、ホストは `SessionContext.locale` — REST の `session.locale` と同じノブ — へ写す。NL 正規化・固定化ゲート(`fixationLookup(hash, session)`。サンプルは固定 Spec を EN のみに配信)・セッション単位の出力言語 policy がすべてこれに追従する。名前は予約語: intent params へ入る前に取り除かれ(intent ハッシュの安定性)、`locale` param を宣言する intent は登録時に拒否される |
| `resolvePrincipal`(McpHostDeps、TS)/ `resolve_principal`(Python) | **1 回のツール呼び出し**の `Principal` を解決する(TS はその呼び出しの `ServerContext` から、Python は mcp SDK の `RequestContext` から)。ツール呼び出しごとにハンドラ内で 1 回だけ解決される。到達先: capability 発行(`issueCapabilityForSpec` の principal)、`SessionContext.principal`(`SemanticPort.normalize` / `ComposeContext.policyFor` / 固定化ルックアップ — `SessionContext.locale` と同じ経路)、初期データ事前解決の `domain.invoke` 呼び出し(単なる read。capability は検証しない)、`AuthzPort` の `verify` が principal を返さないときに `kohaku_resolve_binding` / `kohaku_action` が使う `verdict.principal ?? principal` フォールバック。フォールバック順: `resolvePrincipal(extra)` → `McpHostDeps.principal` → 組み込みの anonymous principal。**throw/raise は fail-closed**: その呼び出しは構造化されたツールエラー(`isError`)を返し、失敗は `onError` に報告される — `principal` や anonymous へ黙って後退することはない。共有 Streamable HTTP デプロイでは(未配線だと全接続が単一の静的 `principal` を共有してしまうため)必須、またはリクエスト/セッション単位の `McpHostDeps` ファクトリで代替する。両言語とも sync / async のどちらでもよい |
| `resultType`(全ツール結果) | MCP 2026-07-28(SEP-2322): 全ツール結果 — 成功も `isError` も — に追加で `resultType: "complete"` が載る(本プロファイルは MRTR の `"input_required"` 中間形状を一切生成しない)。**または** Tasks 拡張(下の行)にオプトインしたタスク対応ツール呼び出しでは `"task"`。TS(SDK v2)・Python(`mcp` 1.x。パススルー結果スキーマ)のどちらでも完全に加算的 |
| MCP Tasks 拡張(`io.modelcontextprotocol/tasks`、2026-07-28 dated-stable、**TS のみ**) | `kohaku_compose` と生成された intent tools は**`AttachOptions.tasksEnabled` が設定されているとき(既定 `false`)に限り**タスク対応になる — 下の行を参照。オンのとき、リクエストごとの `_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]` でこの拡張を宣言したリクエストには、同期のパッケージ済み結果の代わりに `CreateTaskResult`(`resultType: "task"`、`taskId`、`status: "working"`、`createdAt`、`lastUpdatedAt`、`ttlMs: 600000`、`pollIntervalMs: 2000`)が返り、compose はバックグラウンドで継続する。宣言しなかったリクエストには今までどおりの同期結果がそのまま返る(仕様の MUST: サーバはそのリクエストで拡張を宣言していないクライアントに `CreateTaskResult` を返してはならない)。`kohaku_render_snapshot` / `kohaku_resolve_binding` / `kohaku_event` / `kohaku_action` は決してタスク対応にしない(理由は docs/design.md §11 参照)。`tasks/get` と `tasks/cancel` は実装済み(`tasks/update` は意図的に未実装 — compose は途中入力を取らない)。**`tasks/get`/`tasks/cancel` は導入済みの `@modelcontextprotocol/server` 2.0.0 では現状ワイヤ越しに到達不能** — kohaku 側のバグではなく検証済みの SDK バージョン上のギャップであり、詳細(再確認手順つき)は docs/design.md §11 に記載。`tasks/cancel` の効果(実際にディスパッチされる場合、またはタスクストアに直接働きかける場合のいずれも)は、直接キャンセルされたツール呼び出しがすでに使っているのと同じクライアント abort 経路(`trace.cancelled`)である |
| `AttachOptions.tasksEnabled`(既定 `false`) | 上記 Tasks 拡張全体のキルスイッチで、仕様自体のリクエストごとのオプトインの上に重ねてある。オフの間(出荷時の既定): サーバは `ServerCapabilities.extensions` に拡張を宣言せず、`tasks/get`/`tasks/cancel` も登録されず、compose 系はこの拡張が存在する前とバイト単位で不変の同期のままである — リクエスト自身が拡張を宣言していても同じ。根拠: `tasks/get` が到達不能な間(上の行)、`CreateTaskResult` は宣言したクライアントが決して解決できないタスクハンドルであり、無いより悪い |
| 相関 id(ツール呼び出し) | compose 相関 id は**常に**ツール呼び出しの JSON-RPC リクエスト id(TS: SDK v2 の `extra.mcpReq.id`。Python: `mcp` 1.x のリクエスト id)——`_meta.traceparent` が存在してもそこから導出することは無い。W3C の trace-id は 1 つのトレース全体で共有されるため、そこから相関 id を導出すると 1 会話内の全ツール呼び出しが同じ id になってしまい、劣化/失敗した呼び出しの `observer.onError` や fixation self-heal 報告を同じトレース内の他の呼び出しと区別できなくなる。TS: `ComposeOptions.correlationId` / `ComposeTrace.correlationId` と fixation self-heal の相関 id まで、REST プロファイルのリクエスト id と全く同様に到達する。Python: 失敗経路の観測フック(`McpErrorInfo.correlation_id`)にのみ到達する — `compose_with_fixation`/`ComposeOptions` にはまだ相関 id のシンクが無い(既存の TS/Python 間ギャップ) |
| `_meta.traceparent` / `_meta.tracestate`(ツール呼び出し入力) | MCP 2026-07-28(SEP-414): ツール呼び出しの `_meta.traceparent` が整形式の W3C トレースコンテキスト文字列(`00-<32 hex>-<16 hex>-<2 hex>`、trace-id・parent-id とも全ゼロでない)であれば、(+ `_meta.tracestate`、最大 512 文字まで不透明に)`ComposeOptions.traceContext` へパースされる——上記の相関 id には**決してならない**。欠落・不正時は fail-open。TS: `ComposeOptions.traceContext` / `ComposeTrace.traceContext` へ、REST プロファイルの `traceparent` リクエストヘッダ(§5 上記)と全く同様に到達する。Python: 失敗経路の観測フック(`McpErrorInfo.trace_context`)にのみ到達する — 相関 id と同じ既存のシンクギャップ |
| `tools/list` / `resources/list` / `resources/read` の `ttlMs` / `cacheScope` | MCP 2026-07-28(SEP-2549、`CacheableResult`): `tools/list`/`resources/list` は両言語で `ttlMs=60000, cacheScope="private"` を返す(Python の `_list_tools`/`_list_resources`。TS は `packages/host-mcp-apps/src/cache-hints.ts` の `KOHAKU_MCP_LIST_CACHE_HINT` を `apps/sample-mcp/src/setup.ts` が `ServerOptions.cacheHints` へ配線 — このオプションはコンストラクタ時専用で host-mcp-apps 自身は `McpServer` を構築しないため)。共有レンダラーリソース(`ui://kohaku/renderer.html`)の `resources/read` は**TS のみ**さらに `ttlMs=300000, cacheScope="private"` を返す(`RENDERER_RESOURCE_CACHE_HINT`。SDK v2 の登録時オプション `registerResource(..., {cacheHint})` 経由。`AttachOptions.rendererResourceCacheHint` で attach 単位に上書き可能)— Python の `read_resource()` デコレータには完全な結果オブジェクトを返す同等のフックがなく `resources/read` にキャッシュフィールドを持たせられない(`python/README.md` の既知差分一覧を参照)。いずれも modern(2026-07-28)era を交渉済みのクライアントにしか見えない — `docs/design.ja.md` の「MCP 2026-07-28 / SDK v2 移行」参照 |
| トランスポート | サンプル(`apps/sample-mcp`)は 2 エントリを提供。stdio(`start` / `src/index.ts`。Claude Desktop・ターミナルホスト)と Streamable HTTP(`start:http` / `src/http.ts`。claude.ai / ChatGPT へは公開トンネル経由のリモートコネクタで接続。認証なしデモ)。共通セットアップ(Port 群・`.data`・カタログ)は `src/setup.ts` で共有する。HTTP は**ステートレス**(プロトコルバージョン 2026-07-28 がプロトコルレベルのセッションを廃止したため): `createMcpHandler`(TS SDK v2 の `@modelcontextprotocol/server`)が接続ごとではなく **exchange ごと**に新しい `McpServer` を組み立て(まだ 2025-era の旧クライアント向けの内蔵フォールバック付き)、`toNodeHandler`(`@modelcontextprotocol/node`)がそれを `node:http` にアダプトする — `docs/design.ja.md` の「MCP 2026-07-28 / SDK v2 移行」参照 |

iframe 側は `@modelcontextprotocol/ext-apps` の `App` で `ui/notifications/tool-result` を受領し、renderer-react で描画する(`apps/sample-mcp/renderer/main.tsx` が参照実装)。共有レンダラーは 2 モードを持ち、`#kohaku-snapshot` が非 null(`kohaku_render_snapshot` が埋め込んだ `{spec, data}`)のときは**ブリッジに接続せず埋め込みデータで静的描画**する(snapshot モード。操作イベントは no-op)。

widget のホスト統合(feature-detect・非対応ホストは no-op。純ロジックは `renderer/host-integration.ts`):
- **`ui/update-model-context`**: app 専用ツール経由の再合成(`kohaku_event`)・書き込み(`kohaku_action`)の後、現在ビューの要約テキスト(`specToText` — 定義元は spec-core)だけをモデルコンテキストへ還流する(上書き意味論・バルクデータは通さない・初回 tool-result では送らない)。
- **widgetState(ChatGPT 独自)**: `window.openai.setWidgetState / widgetState` を feature-detect し、view 適用ごとに `{kohaku: 1, spec, capability}` を保存・remount 時に即時復元する(initialData は保存しない — データはブリッジで最新を再解決)。
- **displayMode(MCP Apps 標準)**: appCapabilities で `["inline", "fullscreen"]` を宣言し、ホストの `availableDisplayModes` に fullscreen があるときのみ切替トグルを描画(`ui/request-display-mode`)。
- **ホストテーマ追従(MCP Apps / OpenAI Apps SDK 標準)**: `ui/initialize` 時と `ui/notifications/host-context-changed` の都度、`resolveHostTheme(hostContext)`(`renderer/host-integration.ts`)が `hostContext.theme`(light/dark)と `hostContext.styles.variables`(ホスト標準の `--color-*` / `--font-*` CSS カスタムプロパティ。`@modelcontextprotocol/ext-apps` の `McpUiStyleVariableKey`)から `{mode, variables}` を抽出する。`main.tsx` は `mode` に応じて `defaultLightTheme` / `defaultDarkTheme`(`@kohaku-ui/renderer-core`)を基底に選び、`themeFromHostStyles(variables, base)` で上書きしてから `RendererProvider` の `theme` に渡す。`themeFromHostStyles` は `KnownThemeTokens` へ 1:1 対応が付く標準変数の部分集合だけを(エクスポート済みの写像表 `HOST_STYLE_VARIABLE_MAP` 経由で。fill トークンとその foreground トークンは常にペアでのみ写像し、ホストの `-inverse` 系一式は kohaku に対応する「反転面」概念が無いため写像対象外)反映し、それ以外は `base` を維持する。`host-context-changed` の params は変更フィールドのみを含むため、再導出は常に SDK 側で既にマージ済みのフルコンテキスト(`app.getHostContext()`)を読む(通知の params を直接は使わない)。対象外: L2(自由生成 HTML)は v0.1 の MCP 面に露出していない。

## 7. ComponentDefinition とコアカタログ

```ts
defineComponent({
  type: "presentChart", version: "1.1.0",
  description: "…(LLM の選択ガイダンス。生成プロンプトに転写される)",
  propsSchema: z.object({...}),            // Zod が正。JSON Schema は派生
  capabilities: { events: ["pointClick"], data: "required", children: "none", editable?, surfaces? },
  implementation: { kind: "native" } | { kind: "sandbox-template", html },
  fallback: { type: "presentSpreadsheet", mapProps: (props) => ({...}) },  // 降格連鎖。終端 presentMarkdown
})
```

定義時に `z.toJSONSchema(…, {unrepresentable: "throw"})` で JSON 表現不能な props(z.date 等)を fail-fast。federated マージ(`resolveCatalog(core, ...contribs)`)では既存 type の上書きは semver 上昇時のみ。

### コアカタログの部品 props

ランタイム専用の `ui.loading`(スケルトン。`generation:"excluded"`)を除く 15 部品。

| type | props | data | events |
|---|---|---|---|
| `layout.stack` | `direction: vertical\|horizontal = vertical`, `gap: none\|sm\|md\|lg = md` | none | — |
| `layout.grid` | `columns: 1..6 = 2`, `gap = md` | none | — |
| `layout.tabs` | `stateKey`(state キー識別子) | none | select |
| `layout.tab` | `value`, `label` | none | — |
| `text.heading` | `level: 1..6`, `text` | none | — |
| `presentMarkdown` | `markdown` | none | —(全フォールバックの終端) |
| `presentChart`(1.1.0) | `kind: bar\|line\|area\|pie\|scatter`, `x`, `y: string\|string[]`, `series?`, `stacked?`, `title?`, `referenceLines?: [{value, label?, axis?}]` | **required** | pointClick |
| `presentSpreadsheet`(1.1.0) | `editable = false`, `columns?: [{key,label?,type?}]`, `sortBy?: {field, dir}`, `pageSize?: 1..500`, `serverSide = false` | **required** | rowClick / sortChange / cellEdit |
| `presentForm`(1.2.0) | `fields: [{name, label?, type: text\|number\|select\|date\|boolean\|textarea\|radio\|multiselect\|email\|url = text, required?, options?, placeholder?, helpText?, defaultValue?, minLength?, maxLength?, pattern?, min?, max?, step?, message?}]`, `submitLabel?`, `successMessage?`, `action` | optional | submit |
| `presentMetric` | `label`, `valueColumn`, `deltaColumn?`, `format: number\|currency\|percent = number`, `unit?`, `currency?`(既定 "JPY"), `positiveIsGood = true` | **required** | — |
| `presentList` | `gap = sm`, `maxItems?: 1..100`, `emptyText`(既定 `"(No data)"`) | **required** | itemClick |
| `action.button` | `label`, `variant: primary\|secondary\|danger = primary`, `disabled?` | none | press |
| `control.select`(A1) | `options: (string\|{value,label})[]`(最低 1), `value?`, `label?`, `placeholder?` | none | change |
| `overlay.dialog` | `title`, `description?`, `variant: default\|danger = default` | none | close |
| `overlay.toast` | `message`, `tone: info\|success\|error = info`, `durationMs?`(正整数) | none | dismiss |

`presentList` は `children` を各データ行のテンプレートとして扱い、テンプレート内 props の `"$row.<列名>"` を各行の値に置換して並べる(イベント payload も同じ `$row` 文法で行文脈を解決する)。`layout.tabs` はクライアントローカル状態 `$state.<stateKey>`(kohaku >= 0.2)で選択タブを保持し、選択中の `layout.tab` だけを描画する。`control.select`(kohaku >= 0.2)は選択値を `change` イベント(payload `$value`)で発火し、`emit: "state.set"` と組んで `$state` を更新する軽量コントロール。双方向バインディング(`data.bind`)の入力側に使う。`layout.tabs` / `layout.tab` / `control.select` は state / bind が L1 生成に未開放のため `generation:"excluded"`(LLM は構造上出力できず、L0 固定 Spec・手書き Spec・昇格テンプレートで使う)。

`overlay.dialog` / `overlay.toast`(kohaku >= 0.2)はオーバーレイ表示部品。**開閉に専用の状態機構を持たず、既存の `$state` + `emit:"state.set"` + `visibleWhen` だけで宣言的に開閉する**(例: `action.button` の `press` → `state.set(open=true)` → dialog は `visibleWhen: {ref:"$state.open", eq:true}` で表示。「宣言だけで確認フロー」が組める)。`overlay.dialog` は `role="dialog"` + `aria-modal`、開時に最初のフォーカス可能要素へフォーカスを移し、Tab / Shift+Tab をダイアログ内に閉じる(フォーカストラップ)、閉時に起動元へフォーカスを返す。`close` は Esc・×ボタン・背景クリックで発火し、**宣言時のみ**上流へ転送される(統制。通常は `state.set` で open フラグを折って自分で閉じる。未宣言なら破棄され閉じない)。本文は `children` に任意部品(`presentForm` / `action.button` 等)を置く。`overlay.toast` はフォーカスを奪わず(`role="status"`、`error` tone は `role="alert"`)、`durationMs` を指定すると経過後に `dismiss` イベントを発火して自動消滅する(`state.set` 宣言があれば自分で閉じる。省略時は消えない)。両部品とも state 連動のため `generation:"excluded"`。フォールバックは dialog → `layout.stack`(本文をインライン表示)、toast → `presentMarkdown`(`message` を表示)。**`overlay.dialog` の降格では `title` / `description` が失われる**(danger 確認の「問い」が消える): capability 交渉は「props 写像 + `children` 引き継ぎ」までで新しい子ノード(title を載せた text 部品)を注入できず、降格先の `layout.stack` は `title` prop を持たないため。降格先を `presentMarkdown` にすれば title/description は写せるが `presentMarkdown` は `children:"none"` で本文(確認ボタン / 完了フォーム)を丸ごと落とすため、機能的本体(children)を優先して `layout.stack` を採る。フォーカス管理と配色は framework 非依存の共有定義(`@kohaku-ui/renderer-core` の `FOCUSABLE_SELECTOR` / overlay スタイル)を React / WC 両レンダラーが消費する。

`presentForm`(1.2.0)は各 field に宣言的検証を持てる。`required`(未入力を弾く。空の定義は型ごとに異なり、文字列は空文字、`number` は数値化不能/未入力、`multiselect` は空配列、`boolean` は非 true)・`minLength`/`maxLength`(文字列長)・`pattern`(HTML 同様の全一致)・`min`/`max`(`number` の値域)を宣言でき、`message` で違反時の表示文言を上書きできる(未指定なら種別ごとの既定文言。文言はレンダラーの `RendererMessages` で i18n 上書き可)。submit 時にこれらを検証し、違反があれば **送信せず**(a)違反 field に `aria-invalid` + `aria-describedby` でインラインエラー、(b)フォーム先頭に `role="alert"` の集約エラー(件数と各 field への言及)を表示し、最初の違反 field へフォーカスを移す。検証宣言を 1 つも持たない field 群は従来どおり submit され完全後方互換。検証ロジックは framework 非依存の純関数(`@kohaku-ui/renderer-core` の `validateFormValues`)で React / WC 両レンダラーが共有する。

`presentChart`(1.1.0)はデータ点クリックのドリルダウンと参照線を持てる。`events` に `pointClick` を宣言すると各データ点/バーを操作要素にし、クリック時に `$row` 解決済みの payload を forward する(未宣言なら従来どおり完全非対話。統制は共有 `resolveEmit` が門番)。`$row` は「1 論理データ点」の long 形式で、`series` 非指定時は元行(x 列 + 全 y 列)、`series` 指定時は `{ [x], [series]: 系列キー, [y0]: 値 }` を復元する(payload テンプレートは `$row.<x列>` / `$row.<series列>` / `$row.<y列>` で解決)。行/点 → long 行の変換は framework 非依存の純関数(`@kohaku-ui/renderer-core` の `chartPointRow`)で React / WC 両レンダラーが共有し、同一クリックで同一 payload を保証する。pointClick は手書き SVG を描く `bar` / `line` / `area` で配線され、表フォールバックの `pie` / `scatter` では非対話(両レンダラーで揃える)。`referenceLines`(`{value, label?, axis?}` の配列。v1 は y 軸の水平線のみ)は目標値・閾値の破線を引き、値がデータ最大を超えても軸領域を広げて必ず見せる。キーボード操作(Enter/Space)は WC のレンダラーが SVG 点に `role="button"` + `tabindex` で提供する。React(Recharts)は SVG が `aria-hidden` のためポインタ操作に限られ、いずれのレンダラーでも視覚非表示のデータテーブル代替は不変。

`presentSpreadsheet`(1.1.0)は列内ソート・行クリックのドリルダウン・(`editable` 指定時の)セル内編集を持てる。行クリック(`rowClick`)は `presentChart` の `pointClick` と同様、宣言時のみ `$row` 解決済みの payload を forward する。列ヘッダのクリックでソートする(ローカル、あるいは `serverSide` なら `binding.resolve` の `page`/`sort` で再取得)——これ自体は Renderer から一切出ないが、ユーザーのトグルごとに宣言済み `sortChange` イベントも発火でき、その payload は `props.sortBy` と同形: `{ "value": { "field", "dir" } }`(ユーザーのトグルからのみ発火し、Spec 自身の `sortBy` の(再)配信からは発火しない)。`editable`(既定 `false`)は待機中のセルを列名を冠したボタンにし、クリックするとテキスト入力に切り替わる。Enter またはフォーカス喪失(blur)で確定、Escape でキャンセルする。入力文字列は列の宣言済み `type` に従って型変換する: `number`/`boolean` は空文字列が `null` になり、変換不能な値は拒否される(確定されずに `aria-invalid` のまま開いたまま維持)。`date`/`string` は生の文字列をそのまま通す。値が変化した確定は表示へ即座に反映される——現在表示中の行配列に紐づけた楽観的なオーバーレイで、新しいフェッチが取って代わると自動的に破棄される——そして `cellEdit` で配送する: `{ "row": <この編集前の行>, "value": { "column", "value", "previousValue", "rowIndex" } }`。`cellEdit` を `emit:"action.invoke"` で宣言すると `binding.invokeAction` へ直行する(`action.button` の `press` と同じ直接実行経路)。`intent.*` で宣言するとホストの `onEvent` へ forward される。他のイベントと同様、未宣言の `cellEdit` は破棄されるが、ローカルの楽観的な編集はそのまま表示され続ける——**その永続化はホストの責務**(他に書き戻す仕組みは無いため、そのリファレンスの次回フェッチまでしか生き残らない)。`editable` 指定時は `rowClick` 用の行自体のキーボード操作性(`role="button"` + `tabindex` + Enter/Space)を完全に外す。セル自身のボタン/入力が既に操作要素であり、操作要素の中に操作要素を入れ子にすると「操作要素の入れ子禁止」というアクセシビリティ規則に違反するためである。`rowClick` は行へのポインタクリックからは引き続き発火できる(セル自身の操作要素がそのクリックの伝播を止める)が、キーボードからは発火しない。

サンプル寄与: `sales.kpiCard@1.0.0`(props `{label?}`、データ 1 行 `{label, value, format: currency\|percent\|number, note?}`)。

## 8. sandbox ブリッジプロトコル(kohaku-sandbox/0.1)

iframe: `sandbox="allow-scripts"` のみ + meta CSP `default-src 'none'; script-src 'nonce-<mount 毎の nonce>'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src blob:; child-src blob:`。`script-src`/`worker-src`/`child-src`(および `script-src-elem`/`script-src-attr`)は完全にランタイム管理下にあり、`SandboxPolicy.csp` はこれらを既定値の再掲としてすら設定できない(`applyRuntimeNonce` が解決後に mount 毎の nonce を `script-src` へ代入する)。

ハンドシェイク: 信頼された文書自身の runtime → `window.parent` に `{kohaku: "kohaku-sandbox/0.1", method: "handshake.ready", nonce}` → 親が source + ノンス検証 → `handshake.init`(+ MessagePort 移譲)。MessagePort は信頼された文書が保持し、生成スクリプトを実行する Worker には一切渡さない。

| 方向 | メソッド | params | 統制 |
|---|---|---|---|
| guest→host | `binding.fetch` | `{ref}` | 当該ノード `data.$ref` と完全一致のみ。違反 **-32001**。30 req/min・同時 2(超過 **-32002**)・応答 1MiB(超過 **-32003**)・解決 10s 超で打ち切り(**-32004**)。解決失敗は固定文字列 "binding resolution failed" + `-32000` のみが guest に届き、元エラーはホストの `onTelemetry` へ回す |
| guest→host | `event.emit` | `{on, payload}` | Spec 宣言済みイベント名のみ転送。未宣言は破棄 + telemetry。60 回/min・payload 16KiB 超過は破棄 + telemetry(リコンポーズ・ストーム抑止) |
| guest→host | `ui.ready` / `ui.resize {height}` / `telemetry.report {kind, detail?}` | | height は maxHeightPx(4096)にクランプ。resize 120 回/min 超過は無言破棄、telemetry 60 回/min 超過は破棄(窓あたり初回のみ denied 通知) |
| host→guest | `rpc.result {id, result?, error?}` / `props.update {props}` / `data.invalidate {ref}` / `destroy` | | |

上表は親ページと信頼された iframe 文書との間のワイヤプロトコルであり、Worker 化によって変わっていない。**内部的には**、信頼された文書はさらに、生成スクリプトを実際に実行する Worker との間で別の非ワイヤプロトコルを中継している(`packages/sandbox/src/guest/dom-applier.ts` ⇄ `guest/worker-shim.ts`): 短配列の DOM 変更 op(`["c",id,tag,ns?]` 生成 / `["a",...]` 追加 / `["s",...]` setAttribute / `["p",...]` スタイルプロパティ 等)、中継される実 DOM イベント、そしてこの内部チャネル向けに再表現された同じ `binding.fetch` / `event.emit` / `telemetry.report` / `ui.ready` 相当のプリミティブである。この内部プロトコルは上記の kohaku-sandbox/0.1 ワイヤ契約には含まれず、プロトコルバージョンの upgrade なしに変わりうる — sandbox パッケージが SBX-EXEC-001 を満たすための純粋な実装詳細である。

生成コードから使える唯一の API(L2 生成 HTML が使ってよい唯一の口): `self.kohaku`(`window.kohaku` としても参照可能)`.fetchData(ref)` / `.emit(on, payload)` / `.onProps(cb)` / `.ready()`。この 4 つが全てで、composer は生成 HTML を契約 lint(`collectL2Issues`)で検査し、不合格は修復ループで差し戻す。L2 の生成は JSON ラップではなく素の HTML 文書を `generateText` で出力させる(小型モデルは長大な HTML の JSON 埋め込みで系統的に壊れるため。表示タイトルは `<title>` から導出)。検査項目: 未知メソッド参照(`L2_UNKNOWN_API`)/ `ready()` 欠落(`L2_READY_MISSING`)/ `<script>` の JS 構文エラー(`L2_SCRIPT_SYNTAX` — `new Function` によるコンパイルのみの検査。動的コード生成不可の環境ではスキップ)/ `</html>` 欠落 = 出力途中切れ(`L2_TRUNCATED`)/ `Math.random()` による非決定的描画・値の捏造(`L2_NONDETERMINISM`)/ 利用不能な外部ライブラリの痕跡 — D3・Chart.js 等の参照や DOM に無い `.attr()` チェーン(`L2_LIB_UNAVAILABLE`)/ ナビゲーション試行 — `<meta http-equiv=refresh>`・`location.href` への代入・`location.assign()` / `location.replace()`・`window.open()`(`L2_NAVIGATION` — ナビゲーション API はサンドボックスランタイムに存在しない。SBX-EXEC-001 の Worker が既にこの種の試行を構造的に無害化しているため、この lint は実行時に TypeError で発覚するより 1 回分の修復往復を節約するだけの早期シグナルである)/ applier が常に拒否するマークアップ — 拒否要素(`<iframe>`/`<object>`/`<embed>`/`<form>`/`<base>`/`<link>`/`<frame>`/`<applet>`)・`on*=` 属性やプロパティ代入・`javascript:` URL・`<script src=...>`(`L2_UNSAFE_MARKUP`)/ Worker DOM シムに存在しない API — canvas `getContext`・`document.write`・`alert`/`confirm`/`prompt`・`localStorage`/`sessionStorage`/`indexedDB`・`document.cookie`・`MutationObserver`/`IntersectionObserver`(`L2_UNSUPPORTED_DOM`)/ 色の直書き `#hex` / `rgb()` / `hsl()`(`L2_RAW_COLOR` — **`ComposePolicy.designSystem` 配線時のみ**。トークン参照 `var(--kohaku-*)` への置換を差し戻す)/ `DesignSystemGuide.kit` の語彙にないキット名前空間のクラス名(`L2_UNKNOWN_CLASS` — **`ComposePolicy.designSystem.kit` 配線時のみ**。該当クラス名の一覧を添えて、キット自身のクラス/ユーティリティへの置換か、キットの名前空間の外にある独自クラス名への変更を差し戻す)。

信頼された文書の applier が Worker から中継された op に対して課す DOM 形状の上限: `SandboxPolicy.maxDomNodes`(既定 20000)・`maxDomDepth`(既定 64)・`mutationsPerMinute`(既定 6000)。`maxDomNodes` は**現在ドキュメントに接続している**追跡ノード数の上限(`Node.isConnected` を使い、アタッチ・デタッチのたびにサブツリー単位で加算・解放する)であり、これまでに生成したノードの累積数ではない。ノードを除去すれば予算が解放されるため、`innerHTML` / `textContent` による再描画を繰り返すウィジェットも、生存ツリーが上限内に収まっている限り動作し続ける。除去されたノードの追跡レコードは削除されない(生成側 JS がその id をまだ保持していて、新たな作成操作なしに再アタッチすることがありうるため)ので、生涯にわたって多数の異なる id を使い回すウィジェットのメモリを抑えるために、ノード数とは別に「追跡レコード数」に対する `10 × maxDomNodes` のより大きな生涯上限を設けている。いずれかを超える op は破棄され、窓あたり 1 回のみ `telemetry.report kind:"denied"` で報告される。(注: `mountSandbox` の現行実装は、これらの `SandboxPolicy` フィールドの値に関わらず常に spec-core の既定値で srcdoc を構築する — `buildSrcdoc` の外部シグネチャには mount 毎の上書きを通す引数がまだ無いため。これらのフィールドは将来互換のために解決されているに留まる。)

テーマトークンの注入: `MountSandboxOptions.theme`(React は `SandboxFrame` の `theme` prop、WC は `context.theme`)を渡すと、mount が renderer-core の `sandboxThemeCss(theme)`(既定ライトテーマとマージ + `chart.palette` を `--kohaku-chart-palette-1..7` に分解)を srcdoc の `<head>` に `<style>:root{--kohaku-*: …}</style>` として注入する。theme 未指定でも既定ライトテーマが常時注入されるため、生成 HTML の `var(--kohaku-*)` 参照が未定義に落ちることはない。artifact(sha256 対象)は値を持たずテーマ非依存のまま(注入は mount 時の srcdoc 合成であって artifact の書き換えではない)。

boot(`ui.ready` 到達)前に guest の実行時エラー(`telemetry.report kind:"error"`。Worker は同期 `error` と `unhandledrejection` の両方を報告し、信頼された文書自身も Worker 起動失敗や `messageerror` を報告する)が届いた場合、mount は `bootTimeoutMs`(既定 5000ms)を待たずに実エラーの内容で `error` 状態へ遷移する。ready 後のエラーでは状態遷移しない(telemetry 観測のみ)。

## 9. 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `KOHAKU_LLM_PROVIDER` | `claude` | `claude` / `openai` / `gemini` / `ollama` / `llama` — 選択したプロバイダの SDK は `@kohaku-ui/llm` の任意 peer dependency であり別途インストールが必要。[user-guide.md](user-guide.ja.md) の「LLM プロバイダの選択」節を参照 |
| `KOHAKU_LLM_MODEL` | プロバイダ別既定(claude-sonnet-5 / gpt-4.1 / gemini-2.5-flash / llama3.3) | `llama` は必須指定 |
| `KOHAKU_LLM_BASE_URL` | ollama: `http://localhost:11434/v1` | `llama`(OpenAI 互換)は必須 |
| `KOHAKU_LLM_API_KEY` | — | 最優先キー。なければ `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` |
| `KOHAKU_LLM_TEMPERATURE` / `KOHAKU_LLM_MAX_OUTPUT_TOKENS` | 0 / 4096 | L2 自由生成は `outputBudgetFactor=3` により上限が 3 倍(既定 12288)に拡大される |
| `KOHAKU_LLM_STRUCTURED_MODE` | `auto` | `auto`(ネイティブ→失敗時プロンプト JSON)/ `strict` / `prompt` |
| `KOHAKU_LLM_TIMEOUT_MS` | 60000 | LLM 1 回の呼び出しのタイムアウト(ms)。L2 自由生成(フル HTML の長出力)は `outputBudgetFactor=3` により 3 倍(既定 180s)に拡大される |
| `KOHAKU_LLM_RETRY_MAX` / `KOHAKU_LLM_RETRY_INITIAL_MS` | 2 / 250 | PROVIDER 障害(429/5xx)のジッター付き指数バックオフ再試行。`0` で無効。全体で `KOHAKU_LLM_TIMEOUT_MS` を超えない |
| `KOHAKU_LLM_PROMPT_CACHE` | `0`(off) | `1` で `claude` プロバイダのみ Anthropic プロンプトキャッシュ(`cache_control`)に opt-in する(他プロバイダは no-op。呼び出し側が `GenerateObjectRequest`/`GenerateTextRequest.promptParts` を渡さない場合も no-op)。[design.ja.md#prompt-caching](design.ja.md#prompt-caching) と下記の `ComposePolicy.refConstraint` を参照 |
| `KOHAKU_CAPABILITY_SECRET` | `dev-secret-change-me` | サンプルの HMAC capability 署名鍵 |
| `KOHAKU_STORAGE` | `file` | `file` / `memory` / `redis` / `postgres` — TS サンプルが組み立てる StoragePort 実装(`apps/sample-api/src/ports/from-env.ts`) |
| `KOHAKU_REDIS_URL` | — | `KOHAKU_STORAGE=redis` で必須(ioredis の URL) |
| `KOHAKU_STORAGE_KEY_PREFIX` | `kohaku` | Redis のキープレフィックス |
| `KOHAKU_POSTGRES_URL` | — | `KOHAKU_STORAGE=postgres` で必須(pg の接続文字列) |
| `KOHAKU_POSTGRES_SCHEMA` | `public` | kohaku のテーブルを置くスキーマ(なければ作成) |
| `KOHAKU_AUTHZ` | `hmac` | `hmac` / `jwt` — AuthzPort とリクエスト identity の方式。`jwt` はデモの `x-kohaku-role` / `x-kohaku-tenant` ヘッダをトークンのクレームに置き換え、有効な bearer トークンがなければ 401 を返す |
| `KOHAKU_DEMO_ADMIN_ROUTES` | 未設定 | `1` で `KOHAKU_AUTHZ=jwt` のもとでも `POST /api/kohaku/admin/bump-data-version`(§5.5)を登録する(デフォルトでは無効)。有効な bearer トークン + admin ロールは引き続き必須で、これはルートの存在自体だけを切り替える。デフォルトの `hmac` 方式では常にルートが登録される(`apps/sample-api/src/index.ts` の `demoAdminRoutes: … \|\| authzFromEnv.identity == null`) |
| `KOHAKU_JWT_SECRET` / `KOHAKU_JWT_JWKS_URL` | — | `KOHAKU_AUTHZ=jwt` ではどちらか一方が必須(HS256 共有鍵、または OIDC JWKS エンドポイント) |
| `KOHAKU_JWT_ISSUER` / `KOHAKU_JWT_AUDIENCE` | — | `iss` 検証は任意。`KOHAKU_JWT_JWKS_URL` を使う場合は `KOHAKU_JWT_AUDIENCE` が必須(JWKS 経由の発行者は他のオーディエンス向けトークンも発行しうるため。省略すると `@kohaku-ui/authz-jwt` はコンストラクタ時点で例外を投げる) |
| `KOHAKU_TEST_REDIS_URL` / `KOHAKU_TEST_POSTGRES_URL` / `KOHAKU_ADAPTER_TESTS` | — | テスト専用: アダプタ系スイートが使うバックエンド(未指定なら testcontainers 経由の Docker、それも無ければスキップ)。`require` はスキップを禁止する |
| `KOHAKU_OTEL` | `0`(off) | **sample-api(TS)のみ。** `1` にすると `@kohaku-ui/otel` の `createOtelComposeObserver()` を `@kohaku-ui/composer` の `composeObservers` でデモのコンソール observer と束ねる(`apps/sample-api/src/app/compose-context.ts`)。未設定・それ以外の値のときはこのオプション導入前と全く同じ observer オブジェクトを返す(挙動が不変であることを保証)。exporter/SDK の初期化は一切行わない — その手順は [user-guide.md](user-guide.ja.md) の「Trace context / OTel」節を参照。`TracerProvider` が未登録でもスパンは単に捨てられるだけ(安全な no-op) |
| `KOHAKU_COMPOSE_DEADLINE_MS` | 240000 | サンプルの compose 全体デッドライン(ms)。`ComposePolicy.budget.deadlineMs` に渡す(`apps/sample-api/src/app/compose-context.ts` の `composeDeadlineMs`)。ひとつの `compose`/`composeStream` 呼び出し全体(L1 生成〜repair 再試行〜L2)を束縛し、期限超過時は実行中の LLM 呼び出しを中断して `perCompose` のトークン予算超過と同じ決定的フォールバックへ降格する([user-guide.md](user-guide.ja.md) §7 の「compose 全体のデッドライン」参照)。既定値(240 秒)は L2 直行 1 回分(`sales.custom` の `KOHAKU_LLM_TIMEOUT_MS` で 3 倍された ~180 秒の L2 タイムアウト)+ repair 再試行分の余白を見込んだもの。数値化できない値・`0` 以下は既定値にフォールバックする。Python サンプルは `python/examples/sales-api/src/sales_api/app.py` の `ComposePolicy(budget=ComposeBudget(deadline_ms=...))` で同様にミラーする |
| `PORT` | 8787 | sample-api(Python サンプルは 8790) |
| `KOHAKU_API_URL` | `http://localhost:${PORT ?? 8787}` | sample-web / sample-wc の Vite 開発サーバーが `/api` リクエストをプロキシする先の base URL(`apps/sample-web/vite.config.ts` / `apps/sample-wc/vite.config.ts`)。プロキシ先の決定では `PORT` より優先される — sample-api がポート違いではなくホスト違いで動く場合(ポート違いだけなら `PORT` だけでカバーできる)に設定する |
| `KOHAKU_SHUTDOWN_GRACE_MS` | 30000 | TS サンプル(sample-api / sample-mcp)のグレースフルシャットダウン猶予窓(ms)。SIGINT/SIGTERM を受けるとプロセスは新規接続の受け付けを止め、進行中の接続をドレインさせる。猶予窓が先に切れた場合は、まだ開いている接続数をログに出して強制終了する(正常終了の 0 ではなく終了コード 1)。数値化できない値・`0` 以下は既定値にフォールバックする。sample-api はさらにシグナル受信と同時に(ドレインより前に)`GET /api/health` を `503 {ok:false, reason:"shutting down"}` に切り替え、ロードバランサがこのインスタンスへの新規トラフィックを止められるようにする。Python サンプルは環境変数ではなく相当する `uvicorn` オプション(`timeout_graceful_shutdown=30`)をコードで渡す |
| `KOHAKU_SHUTDOWN_PRESTOP_MS` | 0 | **sample-api(TS)のみ対応**。SIGINT/SIGTERM 受信時、`GET /api/health` を not-ready に切り替えてから実際にサーバーを閉じるまでの追加待機(ms)。既定の 0 では、ロードバランサの次のヘルスチェックが `server.close()` と同一 tick で競合し、意図した `503` の代わりに `ECONNREFUSED` を観測してしまうことがある。ロードバランサのヘルスチェック間隔(かそれ以上)に設定すると、接続停止前に少なくとも 1 回の `503` が観測されることを保証できる。数値化できない値・負値は 0 にフォールバック |
| `KOHAKU_DATA_DIR` | TS: `apps/sample-api/.data`。Python: `python/examples/sales-api/.data` | 永続化ディレクトリ(昇格・固定化・Lineage)。TS sample-api(`apps/sample-api/src/index.ts`)、および Python REST(`python -m sales_api`)/ MCP(`python -m sales_api.mcp_main`)の両サンプルが読む(`__main__.py` / `mcp_main.py`)。CI の `conformance-ts` / `conformance-python` ジョブはそれぞれ一時ディレクトリを渡し、黒箱検査がチェックアウト済みリポジトリのローカルデモ状態に触れないようにする。sample-mcp(TS)は固定パスで**非対応** |
| `KOHAKU_SALES_SEED_DIR` | `apps/sample-api/src/domain/seed`(リポジトリルートから解決) | **Python サンプルのみ対応**(`sales_api/domain.py`)。Python サンプルが売上シード JSON を読むディレクトリを上書きする — TS サンプルに対応する環境変数は無い(常にチェックアウト済みの `apps/sample-api/src/domain/seed` を読む) |
| `KOHAKU_L2_JS` | (未設定=Node 併設時オン) | **Python サンプルのみ対応**。`off` で L2 検証の JS サイドカー委譲を無効化(`sales_api/app.py`)。未設定かつ Node 併設時は CLI(`kohaku smoke-l2`)へ委譲し、非併設なら未配線(従来挙動)。TS サンプルはプロセス内 `@kohaku-ui/sandbox` を使うため**非対応** |
| `KOHAKU_L2_JS_CLI` | —(自動探索) | **Python のみ**(`kohaku.composer.l2_js_sidecar`)。サイドカーが `kohaku smoke-l2` の実行に使うリポジトリの `cli/bin/kohaku.js` ランチャーへのパスを明示的に上書きする。未設定時はインストール済みパッケージ自身のファイル位置とカレントディレクトリの両方から上方向へ探索し、`cli/bin/kohaku.js` と `node_modules` ディレクトリの両方を持つ祖先(依存関係インストール済み = Node 併設)を探す。その探索でモノレポルートが見つからない場合(このチェックアウト外にスタンドアロンで Python をインストールした場合や、独自の Node インストール構成の場合など)に設定する |
| `KOHAKU_ALLOW_L2` | `1`(オン) | **Python サンプルのみ対応。** `0` にすると `sales.custom` を L2 自由生成へルーティングするのをオプトアウトする(`sales_api/app.py` の `allowL2` ゲート。TS サンプル自身の L2 ルーティング既定に合わせている)。TS サンプルには対応するオプトアウトが無い |
| `KOHAKU_MCP_HTTP_PORT` | 8788 | sample-mcp の Streamable HTTP エントリ(`start:http` / `src/http.ts`)の待受ポート。**Python サンプル**(`python -m sales_api.mcp_http`)の既定は **8791**(TS :8788 と共存するため別ポート。`mcp_http.py`) |
| `KOHAKU_MCP_HTTP_HOST` | `127.0.0.1` | sample-mcp の Streamable HTTP エントリの bind アドレス。既定はローカルループバック(同一マシンのみ接続可)。LAN や公開へ広げるときのみ明示指定する(認証なしデモのため、外部公開は `KOHAKU_MCP_PUBLIC_URL` + トンネル導線を推奨) |
| `KOHAKU_MCP_HTTP_ALLOWED_HOSTS` | —(未指定=保護オフ) | カンマ区切りの DNS リバインディング保護の許可ホスト。指定したときのみ保護を有効化する(localhost 限定運用向け。例 `localhost:8788,127.0.0.1:8788`。公開トンネル経由では Host がトンネルのドメインになるため列挙しない限り弾かれる) |
| `KOHAKU_MCP_PUBLIC_URL` | `http://localhost:{port}` | sample-mcp HTTP のスナップショット静的配信(`/snapshots`)の base URL。`kohaku_render_snapshot` が返す URL の起点。公開トンネル(ngrok / cloudflared 等)経由時はトンネル URL を設定する(未設定だとローカル URL が返り外部から開けない) |
| `KOHAKU_MCP_SNAPSHOT_TTL_MS` | 86400000(24h) | `.data/snapshots` 配下のスナップショット HTML ファイルを定期掃除で削除するまでの保持 TTL(ms)(自己完結スナップショットは 1 件あたり約 1MB で、従来は無制限に蓄積していた)。数値化できない値・`0` 以下は既定値にフォールバック(`apps/sample-mcp/src/setup.ts`) |

## 10. Lineage イベント型一覧

| type | 主な payload | 発生点 |
|---|---|---|
| `view.composed` | specHash, structureHash, intentHash, canonical, params, tier, cache, surface, sessionId?, model?, artifactId? | compose 成功時(recorder) |
| `view.rendered` / `view.interacted` | specHash / componentId, on, payload | telemetry / events ルート |
| `view.fallback` | specHash, reason, surface, kind(generation/negotiation), intentHash | REST 面の compose/events 応答が `provenance.fallback` を含むとき記録(SHOULD)。MCP 面は recorder 未配線のため未記録 |
| `component.generated` | artifactId, artifactSha256, html, ref?, request?, intentHash, specHash, model | L2 初回合成。`ref` は生成時の `data.$ref`(昇格レビューのプレビューが同じデータで再現マウントするための材料) |
| `component.used` | artifactId, surface, sessionId?, outcome | L2 合成ごと + telemetry |
| `component.nominated/judged/reviewed/schemaProposed/published/withdrawn` | 昇格の各遷移(却下は `component.reviewed` の decision:"reject" として記録) | promotions |
| `component.schemaSuggested` | artifactId, suggestion(`{draft, events, confidence, model, extractorId, extractorVersion, suggestedAt}`) | `component.nominated` の直後に **model actor** で記録される。ホストの `suggestSchema` フック(助言的なスキーマ抽出)が配線されていて成功した場合のみ |
| `component.schemaEdited` | artifactId, reviewer, extractorId, extractorVersion, changed(`DraftFieldChange[]`), unchanged(`DraftDiffField[]`), acknowledged(boolean) | `approve` 経路で `component.schemaProposed` の直後に **user actor** で記録される。承認された候補が `component.schemaSuggested` を持っていた場合のみ。`changed` はレビュアーが提出した draft が提案と食い違うフィールドの一覧(空 = そのまま承認)、`unchanged` は残りのフィールド。`acknowledged` は approve リクエストの `acknowledgedSuggestion` をそのまま写す(未指定は `false` として記録)— 監査目的のみで強制はしない |
| `intent.fixated` / `intent.unfixated` | intentHash, canonical, structureHash, approver | fixations |
| `intent.observed` | — | 型カタログ上の予約(v0.1 では記録されない) |

## 11. conformance(適合検査)

要件一覧(機械可読): [../spec/conformance/manifest.ts](../spec/conformance/manifest.ts) — MUST 33 件(件数・区分は manifest を正とする)。

```bash
node cli/bin/kohaku.js conformance --self                # SPEC-* 9 件(Spec フォーマット自己検査)
node cli/bin/kohaku.js conformance --rest <baseUrl> \
  [--intent '{"canonical":"…","params":{…}}']             # + REST-* MUST 9 件 + SHOULD 6 件・LIN-PRM-001(黒箱検査・任意の実装に適用可)
```

MCP(MCPAPP-*)・sandbox(SBX-*)の要件、および黒箱検査に馴染まない文書規範 5 件(SPEC-ENV-003 テーマ非依存・SPEC-EVT-002 未宣言イベント転送禁止・SPEC-DATA-002 参照単位の版突合・CMP-DET-001 合成決定性の一般形・CMP-GEN-001 生成コンポーネントの `data.$ref` QueryHandle 集合制約)は内部不変条件で、それぞれ `packages/host-mcp-apps/test` / `packages/sandbox/test` / `packages/renderer-wc/test/parity` + `packages/renderer-core/test` / `packages/composer/test` のテストが参照実装に対して固定している(黒箱検査対象外。manifest の `verification: "reference"`)。lineage の LIN-PRM-001 は `GET /lineage` の黒箱検査(published に人間の approve が時系列先行することを確認)に格上げ済みで `--rest` に含まれ、`packages/lineage/test`(状態機械)でも重ねて担保している。
