# Kohaku Protocol 仕様 v0.1(Draft)

[English](SPEC.md) | 日本語

アプリケーション非依存の汎用プレゼンテーション部品を、GUI 操作からも自然言語からも対等に駆動するためのオープン仕様。実装された姿の設計解説は [docs/design.ja.md](../docs/design.ja.md) を参照。各章末尾の **[Normative]** / **[Draft]** / **[Reserved]** はステータス。

要件キーワード MUST / SHOULD / MAY は RFC 2119 に従う。機械可読の要件一覧は [conformance/manifest.ts](conformance/manifest.ts)、参照実装は本リポジトリの `packages/*`。

---

## 1. 概要と用語 [Normative]

| 用語 | 定義 |
|---|---|
| **UI Spec** | UI の構造とセマンティクスを記述する宣言的 JSON。コードではなくデータ |
| **Surface** | 入力受付と描画のホスト(web / chat / mcp-app / …) |
| **Intent(正規化 Intent)** | 自然言語と GUI 操作を同一表現に正規化したもの。キャッシュキーの源泉。ワイヤ名は `CanonicalIntent`(§6.1) |
| **Intent catalog** | アプリケーションが宣言する登録済み Intent 定義(正準名・param スキーマ・query 写像)の集合 — 下記の **Catalog**(UI *部品* の集合)とは別概念。参照実装は `IntentCatalog`(`apps/sample-api/src/intents/catalog.ts`) |
| **Catalog** | 型付き UI 部品(ComponentDefinition)の集合。federated にマージされる(§3) |
| **Binding** | `query://` URI による参照渡しデータ解決 |
| **Lineage** | View(なぜこの画面が出たか)と Component(部品来歴)の監査記録 |
| **昇格 / 固定化** | L2→L1(部品のカタログ登録)/ L1→L0(頻出 Intent の構造固定) |
| **Surface capabilities** | サーフェスが申告する `supports: { type: semverRange }` — どの部品型/版を描画できるか(§3.2「Surface capability negotiation」)。名前は似るが下記の bearer トークンとは別概念 |
| **Capability token** | Spec ごとに発行される bearer トークン。その Spec の `data.$ref` 群と宣言済み `action.invoke` 名への on-behalf-of 権限をスコープする(§5) |

アーキテクチャ原則: **生成(Composition)と描画(Rendering)の完全分離**。同内容のリクエストに対する同一表示は、Composition Service の一本化と Spec キャッシュ(キー = intentHash + dataVersion + catalogFingerprint + 任意の generatorVersion(MAY))で構造的に保証する。generatorVersion はプロンプト改版・モデル変更で生成物を世代分離する任意成分で、指定時のみキーの末尾成分になる(未指定なら従来キーと同一)。

**プロトコルバージョン戦略**: ホストは現行版 `0.2` を発行する(新規に合成する Spec の `kohaku`)。受理する版は `{0.1, 0.2}` で、既存の `0.1` Spec(固定化 pinnedSpec 等)は valid なまま配信を継続する(MUST)。`0.2` で導入された機能(`state` / `visibleWhen` / `emit: "state.set"` / `data.bind` — [Draft])は `0.2` を宣言する Spec でのみ許可し、`0.1` に含まれてはならない(MUST NOT。参照実装は `VERSION_FEATURE_MISMATCH` で拒否する)。キャッシュキーの版成分は発行版を用いるため、`0.2` 化で新規合成のキーは一度だけ更新される(既存 fixation の配信は不変)。

## 2. UI Spec フォーマット [Normative]

正準例: [examples/quarterly-sales.spec.json](examples/quarterly-sales.spec.json)。JSON Schema: [schemas/ui-spec.schema.json](schemas/ui-spec.schema.json)。

### 2.1 エンベロープ

```json
{ "kohaku": "0.2", "intent": {…}, "dataVersion": "…", "state": {…}?, "components": […], "events": […], "provenance": {…} }
```

- **SPEC-ENV-001** エンベロープは `kohaku` バージョン文字列を持たなければならない(MUST)。値は受理版集合 `{0.1, 0.2}` のいずれか(§1 のバージョン戦略)。
- `state`(MAY、kohaku >= 0.2、[Draft])はクライアントローカル状態の初期値マップ(`stateKey` → JSON 値)。Renderer 内に閉じ、サーバーへ送ってはならない(MUST NOT)。`stateKey` は `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`。
- **SPEC-ENV-002** `intent.hash` は `sha256:<hex64>` 形式で、`{canonical, params}` のキー深ソート JSON(canonical JSON)のハッシュでなければならない(MUST)。
- **SPEC-ENV-003** Spec はテーマ情報を含んではならない(MUST NOT)。トークンは Renderer 側で解決する。
- `provenance` は `tier`(L0|L1|L2)・`composedBy`・`cache`(hit|miss|bypass|fixated)を持つ(MUST)。`model` / `fallback` / `composedAt` は MAY。`fallback` は `{from, reason}` に加えて `kind`(`generation`=L1/L2 生成が尽きた決定的フォールバック / `negotiation`=capability 交渉降格)を MAY で持つ。両方が起きた場合は last-writer-wins で `negotiation` が記録される(1 Spec に降格痕跡は 1 つ)。`composedAt` を持つ場合、秒精度の ISO 8601 UTC(`YYYY-MM-DDTHH:mm:ssZ`。小数秒サフィックスの付加は許容するが、`Z` 指定子と秒までのフィールドは必須 — 素のオフセットや日付のみの形式は不可)でなければならない(MUST)。

### 2.2 コンポーネントモデル

- **SPEC-CMP-001** `components` はフラットリストで、`id` は一意(MUST)。`id: "root"` のノードが存在しなければならない(MUST)。
- **SPEC-CMP-002** `children` は ID 参照の配列で、root を根とする DAG を成し循環してはならない(MUST)。
- ノードは `version`(解決済みカタログ semver)を持つことが望ましい(SHOULD)。
- L2 ノードは `type: "sandbox.html"` + `artifact { inline | uri, sha256 }` で表す。`sha256` は実行前に検証されなければならない(MUST)。
- `visibleWhen`(MAY、kohaku >= 0.2、[Draft]): 表示条件の述語。**リーフ**と**複合**の後方互換 union。偽なら Renderer は当該ノードを subtree ごと描画しない(unmount)。
  - リーフ: `{ ref: "$state.<key>", <比較> }`。比較は `eq` / `ne` / `in` / `gt` / `lt` / `gte` / `lte` / `exists` の**ちょうど 1 つ**。`eq`/`ne`/`in` は JSON 値の正準等価、`gt`/`lt`/`gte`/`lte` は数値比較(state 値が number 以外なら偽)、`exists` は state 値が null/undefined 以外かどうかの真偽(`true`=存在 / `false`=不在)。
  - 複合: `{ all: [述語…] }`(論理積)/ `{ any: [述語…] }`(論理和)/ `{ not: 述語 }`(否定)。再帰・入れ子可。入れ子の深さは 8、`all`/`any` の要素数は 16 を上限とし、超過は検証エラー(MUST)。
  - 述語ツリー中の全リーフの `ref` 参照キーは `spec.state` に初期値を持たなければならない(MUST — 初期描画の決定性保証。`STATE_REF_UNKNOWN`)。
- 状態関連の構造検証エラーコード(kohaku >= 0.2): `STATE_REF_UNKNOWN`(visibleWhen.ref の初期値欠落)/ `STATE_SET_INVALID`(state.set の payload.key が静的キーでない、または未宣言)/ `VERSION_FEATURE_MISMATCH`(`0.1` に state 機能を含む)。いずれも error。

### 2.3 データバインディング(参照渡し)

- **SPEC-DATA-001** バルクデータ(行・集計値)を Spec に埋め込んではならない(MUST NOT)。データは `data.$ref` の `query://<source>/<path>?<params>` 参照のみで表す。
- 参照 URI の正準形はクエリパラメータのキー昇順ソート(MUST)。
- データ応答は表形式封筒 `{ columns: [{key,label?,type}], rows: [...], dataVersion, total? }` を用いる(SHOULD)。`dataVersion` 不一致はクライアントが stale として扱える。
- **SPEC-DATA-002** 複数 `$ref` を持ち版が食い違う Spec は `refVersions`(`$ref` URI → その参照単体の `dataVersion`)を含むべきである(SHOULD)。Renderer は `refVersions` が存在すれば参照単位の版で突合しなければならない(MUST。`refVersions?.[ref] ?? dataVersion`)。合成版 `dataVersion: "multi:<hash>"` はキャッシュキー成分であり、単体の応答版とは決して一致しないため突合には使えない。
- **server-side ページング/ソート [Draft]**: クエリパラメータのうち `_` 始まりは**予約名前空間**で、ページング/ソートのワイヤ表現に使う(`_cursor` / `_limit` / `_sort` / `_dir`)。Spec の `$ref` 自体に予約パラメータを含めてはならない(MUST NOT — クライアントの `resolve(ref, {page, sort})` が付与する)。データ応答は続きがあるとき不透明カーソル `nextCursor` を返してよい(MAY。クライアントは中身を解釈せず次要求の `_cursor` にそのまま渡す)。予約パラメータは capability 検証の対象から外す(§5 参照)— 検証は予約パラメータを除いた base ref(= Spec が宣言した `$ref` の正準形)との**完全一致**で行う。既知の予約キー(`_cursor` / `_limit` / `_sort` / `_dir`)以外の `_` パラメータをホストは拒否すべきである(SHOULD — 認可外のパラメータでデータ範囲を変えられないようにする)。
- **双方向バインディング `data.bind` [Draft](kohaku >= 0.2、A1)**: `data` は `$ref` と並んで `bind: { <param>: { $state: "<key>", values: string[] } }` を持ってよい(MAY)。クライアントローカル状態 `$state` の値を `$ref` の当該クエリパラメータへ差し込み、compose(サーバー往復・LLM)なしでクライアント内で再解決する(クロスフィルタ・連動ダッシュボード)。`$ref` は束縛パラメータを**初期 `$state` 値で埋めた初期 variant の具体正準 URI**であり、初期状態では effective ref = `$ref`。`values` は束縛値域の**静的列挙**(v1 は select 等の離散のみ。自由入力・連続値は対象外)で、これが capability 列挙の唯一の正である(§5)。構造検証エラーコード(kohaku >= 0.2、いずれも error): `BIND_STATE_UNKNOWN`(`bind.<param>.$state` の初期値が `spec.state` に無い)/ `BIND_PARAM_MISSING`(束縛パラメータが `$ref` のクエリに無い)/ `BIND_VALUE_INVALID`(`$ref` の当該値が `values` に無い、または `String(spec.state[key])` と不一致 — 初期 ref = 初期状態 = 認可済み値の三者一致)/ `BIND_PARAM_RESERVED`(束縛パラメータが `_` 始まり)/ `BIND_VARIANT_LIMIT`(variant 総数が上限 256 超)/ `VERSION_FEATURE_MISMATCH`(`0.1` に bind を含む)。

### 2.4 イベントモデル

- **SPEC-EVT-001** `events[].on` は `<componentId>.<eventName>` 形式で、対象 ID は存在しなければならない(MUST)。
- `emit` は `intent.patch` | `intent.replace` | `action.invoke` | `state.set`。
- payload テンプレートの `"$row.<key>"` / `"$value"` は描画側がランタイム値で解決する。
- **SPEC-EVT-002** Renderer は Spec に宣言されていないイベントを上流に転送してはならない(MUST NOT)。
- `state.set`(MAY、kohaku >= 0.2、[Draft]): クライアントローカル状態への書き込み。payload は静的な `key`(`spec.state` に宣言済みのキー)と設定値 `value`(テンプレート可)を持つ。Renderer 内で完結し、サーバーへ送ってはならない(MUST NOT — SPEC-EVT-002 の統制を維持する)。

### 2.5 SpecPatch(差分更新)

インタラクションループ(GUI 操作・イベントによる再合成)の応答は、前 Spec との**意味的差分**を `SpecPatch` として表現できる(全文再送に対する最適化。JSON Patch ではなくコンポーネント単位)。

- パッチは `components` の `upsert`(ID 一致なら置換、無ければ追加)/ `remove`(ID 指定削除)、および `events` / `intent` / `dataVersion` / `refVersions` の差し替えからなる。`refVersions` は全置換で、`null` は削除(次 Spec が `refVersions` を持たない)を表す。任意の `kohaku` はプロトコル版数の変更を運ぶ(`prev.kohaku` と `next.kohaku` が異なるときだけ現れる。例: `state` を導入するパッチで 0.1 Spec を 0.2 に昇格)。無ければ `applyPatch` は対象 Spec の版数を保つ。
- 正準順序は `orderComponents`(root 起点の DFS)とする。パッチ適用結果は、同じ Intent を全文 compose した Spec(決定的後処理込み)と一致しなければならない。
- **SPEC-PATCH-001** `diffSpec(prev, next)` で得たパッチを `applyPatch(prev, …)` に適用した結果は `next` と一致しなければならない(round-trip、MUST)。参照実装: [packages/spec-core](../packages/spec-core)。

## 3. Component Catalog

### 3.1 ComponentDefinition [Normative]

`{ type, version(semver), description, propsSchema(JSON Schema), capabilities { events, data: none|optional|required, children, editable? }, implementation { kind: native | sandbox-template }, fallback?, golden? }`

- props は JSON 表現可能でなければならない(MUST。日時等は文字列で表す)。
- `description` は LLM の選択ガイダンスとして生成プロンプトに転写される(SHOULD は具体的に)。
- **型名の命名規約**: コア型の `type` は `<namespace>.<name>`(例: `layout.stack`、`control.select`)を原則とする。`present*` 系(`presentList` / `presentMetric` / `presentChart` / `presentForm` / `presentSpreadsheet` / `presentMarkdown`)は例外で、v0.1 でワイヤ契約を固定した当時のフラットな camelCase 名をそのまま維持している — 今からリネームすると命名整理では済まずワイヤ契約とカタログフィンガープリントが変わってしまう(破壊的変更)ため。新規のコア型・プロダクト拡張は名前空間付きの名前を使うべき(SHOULD)。

### 3.2 Surface capability negotiation(capability 交渉)とフォールバック [Draft]

サーフェスは `supports: { type: semverRange }` を申告する。非対応部品は定義側の `fallback` 連鎖で降格し、終端は `presentMarkdown`(テキストフォールバック)とする(MUST)。降格は `provenance.fallback` に記録する。

### 3.3 federated 配信 [Draft]

カタログ = コア ⊕ プロダクト寄与 ⊕ 昇格分。既存 type の上書きは semver 上昇時のみ(MUST)。カタログ指紋(`type@version` ソート結合のハッシュ。sandbox-template 分は `#fnv1a64(html)` を付加)はキャッシュキー成分。

## 4. 合成規約 [Normative(後処理規範は Draft)]

- **L0(固定)**: テンプレート/固定化からの決定的生成。LLM を経由しない。
- **L1(宣言的合成)**: LLM の仕事は「カタログからの選択 + 型付き props 充填」に限定(MUST)。エンベロープ(intent / dataVersion / provenance)を LLM に生成させてはならない(MUST NOT)。**CMP-GEN-001** `data.$ref` は解決済み QueryHandle 集合に制約しなければならない(MUST)。スキーマ段階(生成器に提示する列挙(enum)。既定)、または実装が intent 非依存の生成文法を選ぶ場合は生成後の明示検証のいずれかで行う。
- **L2(自由生成)**: サンドボックス限定の脱出口。生成コードはブリッジ API(`window.kohaku`)以外のデータ経路を持ってはならず、サンドボックス文書のナビゲーション・ウィンドウオープン・ネットワーク要求のいずれも行えてはならない: ホストは `document` を持たず、`location` への代入も `window.open` もできない文脈で実行しなければならない(SBX-EXEC-001)。
- **CMP-DET-001** 同一 intentHash + dataVersion + catalogFingerprint に対し、ホストは同一の components / events を返さなければならない(MUST。キャッシュで担保)。
- 決定的後処理(ID 正規化・チャート種別規則・順序正規化・props 正規化)は LLM 出力に対して常に適用する(SHOULD)。

## 5. セキュリティ [Normative]

- **SBX-ATTR-001** L2 iframe の sandbox 属性に `allow-same-origin` を含めてはならない(MUST NOT)。
- **SBX-CSP-001** L2 文書の CSP は `connect-src 'none'` を含み、ネットワーク I/O を遮断しなければならない(MUST)。ホストはいかなる fetch 系ディレクティブ(`img-src` / `font-src` / `media-src` / `script-src` / `style-src` / `worker-src` / `child-src` / `manifest-src`、およびその `-elem`/`-attr` 派生)にも外部オリジンを指定させてはならない — 許容されるのは `'none'`・`data:`・`blob:`、およびインラインキーワードソース(`'unsafe-inline'` / `'unsafe-eval'` / `'unsafe-hashes'` / `nonce-*` / `sha256-*` 系)のみ(MUST NOT)。
- **SBX-EXEC-001** 生成 script は、`document` を持たず、`location` への代入も `window.open` も `importScripts` もネットワークアクセスもできない専用 Worker で実行しなければならない(MUST)。DOM への効果はホストランタイムのミューテーション protocol 経由でのみ適用しなければならず、applier は許可リスト外の要素・属性・スタイルプロパティを拒否しなければならない(MUST)。
- **SBX-NAV-001** サンドボックス文書のナビゲーション(guest 文書の差し替え。`location` への代入・`window.open`・`<meta http-equiv=refresh>`・リンク追従等)は障害として扱わなければならない: ホストは iframe を破棄し、差し替え後の文書で guest を動作させ続けてはならない(MUST)。SBX-EXEC-001 により guest はそもそも自前の `document` も代入可能な `location` も `window.open` も持たないため、これは主たる制御ではなく実行分離が破れた場合の多重防御である。
- **SBX-BRG-001** ブリッジは Spec の当該ノード `data.$ref` と完全一致する参照のみ解決する(MUST)。違反は `-32001` で拒否。クォータ超過(fetch / event / telemetry / resize の毎分回数・同時実行数・応答/payload サイズ)は `-32002`、応答超過は `-32003`、解決タイムアウトは `-32004`。
- capability token は on-behalf-of の権限委譲を表し、Spec 内の `$ref` 集合を覆う read スコープで発行する(MUST)。token を L2 iframe 内に渡してはならない(MUST NOT)— 親側ブリッジが代理する。
- **write スコープの DomainPort 操作への制限**: 宣言された `action.invoke` のアクション名に対して発行する write スコープは、`DomainPort.listOperations()` が列挙する操作に限定すべきである(SHOULD)。列挙にないアクション名は、認可せず発行対象の capability から落とすべきである(SHOULD — L1/L2 生成が捏造・注入した `action.invoke` のアクション名がベアラ型の write スコープになってはならない)。ホストは落としたアクションごとに障害系観測フック(§4 相当の `onError`)へ通知すべきである(SHOULD)。スコープを落とすこと自体で capability 発行を失敗させてはならない(MUST NOT — fail-open。そのスコープを欠いたまま capability は発行される)。
- **予約パラメータの capability 検証 [Draft]**: `/binding/resolve` は受信 ref を base(`_` 始まりの予約パラメータを除いた正準形)と reserved に分割し、**capability 検証は base に対して行う**(MUST)。base は元の `$ref` と一致するので、発行済み read スコープ(§2.3)で覆える。予約パラメータは base のパラメータと合流させて DomainPort に渡す(`_` 名前空間規約 — DomainPort シグネチャ不変)。予約パラメータで capability のスコープを回避できてはならない(MUST NOT — 検証は常に base 基準)。
- **双方向バインディングの variant 列挙 capability [Draft] (A1)**: `data.bind`(§2.3)を持つ部品については、ホストは compose 時に `values` の直積で到達しうる effective ref をすべて列挙し、**各 variant を read スコープで発行しなければならない**(MUST。初期 variant = `$ref` を含む)。理由: 予約パラメータ `_` は「並べ替え・切り出し」で**どのデータを認可するかを変えない**ため検証対象から外せたが、bind の束縛パラメータは**フィルタ = どのデータを返すかを変える**。したがって予約名前空間の除外モデルは流用できず(除外するとクライアントが任意 filter 値で base 認可をすり抜ける)、到達しうる ref の有限集合を compose 時に確定し、そのすべてを認可する。クライアントは `values`(= 認可済み集合)から選んだ値でしか effective ref を作れないため、到達可能 ref 集合は compose 時認可集合に一致する(偽造禁止原則)。`values` 外の値は capability に無く拒否される(MUST)。variant 総数には上限(256)を設け、超過 Spec の capability は発行してはならない(MUST NOT。`BIND_VARIANT_LIMIT`)。
- 監査ログ必須項目: view.composed(specHash / intentHash / tier / cache / surface)、component.generated / used、component.reviewed(承認者)、component.published、intent.fixated。
- **LIN-PRM-001** `component.published` の前に人間による `component.reviewed(approve)` が存在しなければならない(MUST)。自動承認は v0.1 では認めない。

## 6. トランスポートプロファイル

### 6.1 REST プロファイル [Normative]

ベースパス配下に以下を公開する(参照実装: `@kohaku-ui/host-rest`):

| ルート | 要件 |
|---|---|
| `POST /compose` | `{intent}` or `{input}` → `{spec, capability}`。**REST-CMP-001** spec は §2 に適合(MUST)。**REST-CMP-002** 同一 intent の再要求は cache hit かつ components 同一(MUST)。**REST-ERR-001** 不正なボディ(非 JSON、または `input` と `intent` の両方欠落)は下記エラーエンベロープで 400(MUST) |
| `POST /intent/normalize` | **REST-INT-001** `{input}` → `{intent, source}`(MUST) |
| `POST /events` | **REST-EVT-001** `{intent, event{on, payload}}` → `{spec, capability}`(MUST) |
| `GET /binding/resolve?ref=` | **REST-BND-001** capability なしは 401(MUST)。**REST-BND-002** 正当な capability で表形式封筒を返し dataVersion が参照単位の期待版(`refVersions?.[ref] ?? dataVersion`、§2.3)と一致(MUST) |
| `POST /binding/action` | write スコープの capability で書き込みを実行(MUST は認可のみ)。**REST-BND-003** capability なしは 401、必要な write スコープを持たない正当な capability(例: read 専用 capability)は 403(MUST)。応答は `{result, invalidates?, refVersions?}`(SHOULD)。`invalidates` は陳腐化した `query://` URI 完全一致、`refVersions` は参照単位の新版(§2.3)。未対応ホストは `{result}` のみ(後方互換) |
| `GET /catalog` | **REST-CAT-001** ComponentDefinition の直列化一覧 + catalogVersion(MUST) |
| `GET /lineage` `POST /telemetry` `GET/POST /promotions…` `GET/POST /fixations…` | 統制面(SHOULD)。**REST-ERR-002** `/promotions` と `/fixations` の GET は文書化された形か 501 `NOT_IMPLEMENTED` エンベロープ。**REST-LIN-001** `/lineage` は `{events:[]}` 形で `?limit=` を尊重。**REST-GOV-001** `/promotions/:id/actions` は不正ペイロードで 400、未知 artifact への正当な action で 404。**LIN-PRM-001**(§5)も `/lineage` に対して検査する |

エラーエンベロープ: `{ error: { code, message } }`。code は BAD_REQUEST / INTENT_INVALID / CAPABILITY_REQUIRED / CAPABILITY_DENIED / REF_NOT_FOUND / SOURCE_MISMATCH / NOT_FOUND / PROMOTION_INVALID / PROMOTION_NOT_PUBLISHED / COMPOSE_FAILED / INTERNAL / NOT_IMPLEMENTED。**REST-ERR-001** `POST /compose` は非 JSON ボディと `input` / `intent` 双方欠落のボディを HTTP 400 + このエンベロープで拒否しなければならない(MUST)。統制系(promotions)の named ルートは NOT_FOUND(404: artifact 不在)/ PROMOTION_INVALID(422: 遷移拒否)/ PROMOTION_NOT_PUBLISHED(409: 承認が publish に未到達、`error.status` に留まった状態を載せる — このプロモーション状態は**応答自体の HTTP ステータスコードとは別物**)を用いる。SSE ストリーミング(`POST /compose/stream`)は §6.1.1 [Draft] を参照。

`/compose`・`/events` の応答 spec が `provenance.fallback` を含むとき(L1/L2 生成失敗の決定的降格、または capability 交渉による部品降格)、`view.fallback` を lineage に記録する(SHOULD)。payload は specHash / reason / surface / kind(`generation` | `negotiation`)/ intentHash。判定源はキャッシュ命中後も finish で毎回起きうる negotiate 降格を取りこぼさないよう trace ではなく応答 spec とする。

**マルチテナント[Draft]**: ホストは `SessionContext.tenant`(プロダクトがリクエストから解決。参照実装は `KohakuHostDeps.tenant(c)`)で統制プレーン(lineage / 昇格集計 / 固定化)をテナント単位に分離してよい(MAY)。統制系ルート(promotions / fixations)の集計スコープはセッション由来のテナントを用い、クエリパラメータで受けない。**`query://` はテナント中立でありキャッシュキーに `tenant` を含めてはならない(MUST NOT)** — テナント絞り込みは `DomainPort` が `principal` / `capability` で行う(§2.3 / §5)。`tenant` 非対応ストレージは fail-open(テナント間で固定化を共有)、本格的なストレージ分離(RLS 等)はプロダクトの責務。

**セッションロケール [Draft]**: `/compose`・`/compose/stream`・`/events`・`/intent/normalize` の `session` オブジェクトは追加で `locale`(`"en"` / `"ja"` のような言語タグ)を運んでよい(MAY)。ホストはこれを `SessionContext.locale` へ透過し(参照実装は `toSession`)、`SemanticPort.normalize` の NL ヒントに使えるようにすべきである(SHOULD)。さらにホストはセッションごとに生成出力言語を変えてよい(参照実装は `ComposeContext.policyFor` でセッションごとの `ComposePolicy` を解決する)。**その場合、言語の変動はその policy の `generatorVersion` に反映し、キャッシュを言語別に分離しなければならない(MUST)** — キャッシュキー自体はロケール成分を持たず、(`locale` を含め)同一のリクエストは同一のキャッシュキーに対応するため、REST-CMP-002 には影響しない。**`NLQuery.locale` と `session.locale` は別の役割を持ち、互換ではない**: `NLQuery.locale`(`/intent/normalize` / `/compose` に渡す `{input}` 形の任意フィールド)は NL 正規化のヒントに過ぎず、その用途に限り存在時は `session.locale` より優先される(参照実装の優先順位は `input.locale ?? ctx.locale`)。一方、出力言語の選択(上記の `ComposePolicy` / `generatorVersion`)と固定化短絡の言語ゲートはいずれも `session.locale` のみで駆動され、呼び出しごとの `NLQuery.locale` はどちらの代わりにもならない。

**統制プレーンの認可 [Draft]**: 監査・統制系ルート(lineage / telemetry / promotions / fixations)の認可はホストに委ねる(認可の合流点のみを規定し、要件としては定めない)。参照実装はオプショナルフック `KohakuHostDeps.authorizeGovernance` を設け、配線時は各リクエスト前に認可判定し、拒否を 403 `CAPABILITY_DENIED` で返す。未配線時は認可なし(統制面が無防備)となるため、実運用ではフック配線か外部ミドルウェアでの保護がプロダクト責務となる。conformance はこの認可を検査しない(未配線でも conformant)。

### 6.1.1 Compose ストリーミング [Draft]

ホストは `POST /compose/stream` を Server-Sent Events(SSE)で公開してもよい(MAY)。リクエストボディは `/compose` と同一(`{intent}` or `{input, session?}`)。目的は、遅い生成経路(L1/L2)でスケルトン(`ui.loading`)を即時に返し、生成完了後に確定形への差分(SpecPatch)を送ることで初期表示の体感を縮めることにある。公開する場合、以下を満たす — **ルート自体は MAY だが、実装するなら各要件(REST-STR-001〜003)は当該実装に対して MUST**。ただしルートがオプショナル(MAY)であり本プロファイルが [Draft] のため、[conformance/manifest.ts](conformance/manifest.ts) では 3 要件を **SHOULD** として登録・黒箱検査する(未実装なら検査は skip 扱いで conformant を損なわない。実装済みで違反すればレポートに SHOULD 警告として出る)。この「実装すれば MUST・manifest は SHOULD」の条件付き規範により、本文の (MUST) 表記と manifest の `level: "SHOULD"` は矛盾しない:

- **REST-STR-001**(MUST): 最初のイベントは `event: spec`、`data` は `{spec, capability, final}`。`spec` は §2 に適合する。`final: true` ならそれが最終 Spec(速い経路 = キャッシュ hit / L0 / 固定化短絡)。`final: false` ならスケルトンで、この後 `event: patch` が続く。
- **REST-STR-002**(MUST): `event: patch` を受信順に `applyPatch` した結果は、同一 intent への `POST /compose` の Spec と `components` / `events` が一致する(非ストリーム経路との等価性)。
- **REST-STR-003**(MUST): ストリームはちょうど 1 つの `event: done`(`data` は `{specHash, tier, cache}`)または `event: error`(`data` は `{error: {code, message}}`)で終端する。

`patch` は 0..N 回。参照実装は LLM の部分出力から組んだ**暫定 Spec への patch** を生成中に 0 回以上送り(`LlmPort.streamObject` 実装時のみ。部分出力の parse & heal — 完成部品の抽出・children 刈り込み・events 後送 — を経て、常に §2 適合の Spec になる形でだけ送る)、最後に確定形への patch で収束する。受信側は受信順に `applyPatch` するだけでよい(各適用結果は常に構造検証済み = REST-STR-002 の等価性は最終形に対して成立)。途中形(`final: false` のスケルトン、暫定 Spec、および適用前の patch)はキャッシュ・固定化・lineage 記録の対象にしてはならない(MUST NOT)— これらは最終 Spec に対してのみ行う。`capability` は初回 `spec` イベントで 1 回だけ発行する: `final: true`(速い経路 — キャッシュ hit / L0 / 固定化短絡)の場合は、`POST /compose` と同じ規則(§5。最終 Spec が宣言する `action.invoke` の write スコープと `DomainPort.listOperations()` との積集合を含む)に従い**最終 Spec 自体から発行する**。`final: false`(スケルトン)は `$ref` をまだ持たないため、代わりに解決済みの全 QueryHandle URI から read 専用で発行する — `data.bind` は最終 Spec にのみ宣言され L1/L2 生成には開放されないため、スケルトンは bind variant も write スコープも持たず、後続の暫定 Spec・patch も同様である(単一イベントで完結する `final: true` 応答だけが、ストリーム越しに `action.invoke` を運べる)。

ボディ不正はストリーム開始前に通常の 400 エンベロープで返す。ストリーム開始後の生成失敗は HTTP ステータスを変えられないため `event: error` で終端する。再接続は定義しない(`fetch` + `ReadableStream` 前提)。最終 Spec はキャッシュ済みなので、切断時の再リクエストは 1 イベントで返る冪等な経路がリトライ戦略となる。

### 6.2 MCP Apps プロファイル(SEP-1865) [Normative]

- **MCPAPP-RES-001** 共有レンダラーは `ui://` リソースとして `text/html;profile=mcp-app` で配信する(MUST)。
- ツールは `_meta` で UI を宣言する(MUST)。UI 宣言は modern(ネスト `_meta.ui.{resourceUri, visibility}`。SEP-1865 正式化 2026-01-26 以降の正)と legacy(フラット `_meta["ui/resourceUri"]` / `_meta["ui/visibility"]`。旧ホスト後方互換)の**両形式を併記**する(値は同一。どちらを見るホストでも UI ツールとして認識される)。
- **MCPAPP-APP-001** バルクデータ・イベント・書き込み用ツール(resolve_binding / event / action)は `_meta["ui/visibility"] = ["app"]`(modern の `_meta.ui.visibility` にも同値)とし、モデルから不可視にする(MUST)— バルクデータをモデルのコンテキストに通さず、書き込み(action)は capability を持つ widget(iframe)からのみ発火させる。
- **MCPAPP-FBK-001** UI 付きツールの結果は非空のテキストフォールバックを `content[0]` に含む(MUST)。
- **MCPAPP-CAP-001** compose 系ツール呼び出し(`${prefix}_compose` / 生成される intent tools / `${prefix}_event`)の結果は Spec を `structuredContent.spec` に、capability トークンを `_meta["kohaku/capability"]` に持つ(MUST)。`structuredContent` に capability トークンを含めてはならない(MUST NOT)— `_meta` はモデルのコンテキストに入らず `structuredContent` は入るため、bearer な書き込みトークンを `structuredContent` から外すことで、`${prefix}_action` の app-only な `_meta["ui/visibility"]` ヒントを尊重しないホスト(またはプロンプトインジェクション)がモデル自身にトークンを読ませて任意 payload の write を発火させる経路を断つ。
- 共有レンダラーリソースは**リソース側** `_meta.ui` に csp を空 allowlist(`{connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: []}`)で明示宣言する(SHOULD)— single-file バンドル + ブリッジ経由データ取得のため外部オリジンを一切必要とせず、ホストに最も厳しいサンドボックスを適用してよいと伝える。csp / permissions はツール側 `_meta.ui` には置けない(SEP-1865。ツール側は `resourceUri` / `visibility` のみ)。resources/list(リソース記述)と resources/read の contents の両方に同値で載せる(SEP-1865 は contents 側優先)。
- **mcp-ui レガシー UIResource 併記**(任意・既定 off): SEP-1865 未対応で mcp-ui の UIResource(`ui://` プレフィックス検出)だけを描画するホスト向けに、compose 系ツール結果の `content[]` へ `{type:"resource", resource:{uri:"ui://kohaku/view/<intentHash>", mimeType:"text/html", text:<自己完結スナップショット HTML>}}` を後置してもよい(MAY)。`content[0]` のテキストフォールバック(MCPAPP-FBK-001)は不変。スナップショットは静的表示(操作・再合成なし)で、組み立て失敗は握って併記なしの通常応答に落とす(fail-open)。約 1MB/結果になるため modern ホストでは有効化しないこと。
- widget は操作(app 専用ツール経由の再合成・書き込み)の後に `ui/update-model-context` で**現在ビューの要約テキストだけ**をモデルコンテキストへ還流してよい(MAY。ホストが capability を宣言する場合のみ)。バルクデータは載せない(§4.3 の原則は不変)。初回 tool-result では送らない(content[0] が既にモデル可視 — 二重注入回避)。
- L2(sandbox.html)ノードの mcp-app サーフェスでの描画は v0.1 では非対応で、テキストフォールバックで代替する(MCPAPP-FBK-001)。ホストは REST プロファイル(§6.1)と同様に MCP プロファイルにも `ViewRecorder`(リファレンス実装の `McpHostDeps.recorder`)を配線してよい(MAY)。配線した場合、`view.composed` と `view.fallback` は compose 系ツール呼び出しのたびに、`view.interacted` は `${prefix}_event`(再合成前)で記録され、REST プロファイルの記録タイミングと一致する。未配線ならいずれも記録されない。
- 書き込み直結路は app 専用ツール `${prefix}_action`(既定 `kohaku_action`)として v0.1 で対応する(REST の `POST /binding/action` に対称。MCPAPP-APP-001 の app 専用ツールの一つ)。入力は `{action, payload?, capability}`、capability は **write** スコープ(`{kind:"write", ref:action}`)で検証し、応答 `structuredContent` は `{result, invalidates?, refVersions?}`(`invalidates` / `refVersions` は副作用宣言〈`actionEffects`〉の配線時のみ載り、未配線なら `{result}` のみ = 後方互換)。書き込みループ(ActionResult / invalidates / refVersions)は REST・MCP 双方が対応する。`kohaku_resolve_binding` は従来どおり read 専用。
- **ツールロケール [Draft]**: UI を生成する全ツール(compose / render_snapshot / 生成された intent ツール群 / event)は追加で optional な `locale` 引数(`"en"` / `"ja"` のような言語タグ)を受け付けてよい(MAY)— 呼び出し側モデルが利用者の環境・会話言語に合わせて呼び出しごとに設定する。ホストはこれを compose セッションの `SessionContext.locale` へ写すべきである(SHOULD)。REST プロファイルが `session.locale` として運ぶのと同じノブであり(§6.1「セッションロケール」)、NL 正規化・固定化ゲート・セッション単位の `ComposePolicy`(出力言語)のすべてがこれを参照する。引数名 `locale` は**予約語**: 正準 intent params には決して入らず(intent ハッシュの安定性)、その名の param を宣言する intent は登録時に拒否される。
- **MCP コアプロトコルバージョン [Draft]**: 本プロファイルの上記 MUST/SHOULD 要件は **2025-11-25** の MCP コアワイヤプロトコル(ステートフルなセッション・`initialize`/`initialized`・`resultType` フィールドの無い結果)を前提とする。適合ホストは後続の 2026-07-28 プロトコルバージョン経由でも到達可能であってよく、本プロファイルはトランスポート層の全面移行に先立って純粋に加算的な項目のみを先行採用している — 全ツール結果は `resultType: "complete"` を持つ(2025-11-25 ワイヤ上のホストはこのフィールドの欠落を、2026-07-28 対応ホストはその存在を、その changelog 自身の互換規則により同一に扱う)。また、ツール呼び出しの `_meta.traceparent`(SEP-414)が存在し整形式であれば、観測記録を呼び出し元自身のトレースと相関付けるのに用いる。どちらの項目も上記のいずれの MUST/SHOULD も変更せず、クライアントが 2026-07-28 対応である必要も無い。Python リファレンス実装はさらに、SDK がクリーンなフックを提供する範囲(`tools/list` と `resources/list` の結果。`resources/read` は対象外)で `ttlMs`/`cacheScope`(`CacheableResult`)を付与する(TS リファレンス実装はまだ未対応 — 理由は下記の移行計画を参照)。2026-07-28 のセッション廃止・`server/discover`・MRTR の各項目はまだ採用していない(実装状況は `docs/design.ja.md` の「MCP 2026-07-28 / SDK v2 移行計画」節を参照)。

### 6.3 A2UI プロファイル [Draft]

UISpec / SpecPatch を A2UI(隣接リスト形の宣言的 UI メッセージ)へ写すプロファイル。既定の対象は **A2UI v0.9.1**(a2ui.org の現行安定版)。**opt-in の `target: "v1.0"`** を指定すると **A2UI v1.0 RC**(a2ui.org 目標では Q4 2026 安定化予定・現時点で未安定)にも追従できる — 詳細は後述の「v1.0 RC ターゲット(opt-in)」を参照。参照実装は `packages/host-a2ui`(`toA2ui` / `patchToA2ui` / `fromA2uiEvent` / `serializeA2uiLines`)。**Draft のため conformance 検査対象外**(§7)。

エンベロープは `{ "version": "v0.9.1", "<messageKey>": {…} }`(メッセージキーはちょうど 1 つ)。コンポーネントはフラット形 `{id, component: "Text", …props 直置き, children | child, action?}`。ストリーミングは JSONL(1 行 1 メッセージ。`serializeA2uiLines`)。**既定出力(`target` 省略または `"v0.9.1"`)は本プロファイルの旧来出力とバイト同一**(golden テストで固定。`packages/host-a2ui/test/a2ui.test.ts` の "target v0.9.1 (default) output is byte-identical to pre-v1.0 output")。

**設計原則(v0.9.1 追従で改訂)**: A2UI v0.9.1 は strict(コンポーネントは `unevaluatedProperties: false`・メッセージは extra 禁止)で、**ワイヤに `x-kohaku-*` 拡張キーを載せられない**。よってワイヤは v0.9.1 準拠に保ち、kohaku 固有情報(参照渡し `data.$ref`・`data.bind`・`visibleWhen`・intent・provenance・dataVersion・refVersions・state・events・元 type)は**サイドカー(`KohakuSidecar`。ワイヤ外の別建て構造)へ無損失退避**する。`toA2ui` / `patchToA2ui` は `{ messages, sidecar }` を返し、kohaku 対応クライアントは sidecar から完全復元できる。

対応表:

| kohaku | A2UI v0.9.1 | 備考 |
|---|---|---|
| UISpec | `createSurface {surfaceId, catalogId}` + `updateComponents {surfaceId, components}` | surfaceId = `kohaku-<hex64>`(intent.hash の `sha256:` を除いた hex)。catalogId 既定 = kohaku 独自カタログ(basic 外の型を verbatim で載せるため) |
| `components`(フラットリスト + id) | `updateComponents.components`(隣接リスト) | **同型**。id 参照(`children`)もそのまま |
| `data.$ref` / `data.bind` / `visibleWhen` / intent / provenance / dataVersion / refVersions / state / events / 元 type | **サイドカー**(`KohakuSidecar`) | v0.9.1 strict のためワイヤ不可。既定で落とさず sidecar に温存(round-trip 可能) |
| データインライン展開(opt-in) | `updateDataModel {surfaceId, path, value}` | `resolveData` 注入時のみ(喪失変換)。データモデルは `{refs: {"<ref>": TabularData}}` 形、path は RFC 6901 エスケープで `/refs/<ref>` |
| `EventBinding {on: "<id>.<ev>"}` | 発火元 component の `action: {event: {name: on, context: {}}}` | A2UI はコンポーネント側に action を持つ。emit / payload は sidecar events が温存 |
| `SpecPatch`(upsert のみ) | `updateComponents`(id 一致 upsert) | v0.9.1 に明示 delete は無い |
| `SpecPatch`(remove を含む) | `updateComponents` に適用後 components を**全量再送** | 削除は親の children 更新で表現する仕様のため(`patchToA2ui(patch, appliedSpec)`) |
| A2UI client `action {name, surfaceId, sourceComponentId, timestamp, context}` | `GuiAction`(逆変換) | `fromA2uiEvent`: `{kind:"gui", action: name, params: context}`(name は `<componentId>.<eventName>` 形) |

コア部品対応表(それ以外は `component` に kohaku type verbatim + sidecar 温存。汎用 A2UI クライアントは basic 外を非対応として扱う):

| kohaku type | A2UI component | 写像 |
|---|---|---|
| `layout.stack`(vertical) | `Column` | children 保持・justify/align 写像 |
| `layout.stack`(horizontal) | `Row` | 同上 |
| `text.heading` | `Text` | `level` → `variant: "h{level}"` |
| `presentMarkdown` | `Text` | markdown → text(A2UI Text は markdown を解釈) |
| `action.button` | `Button` | 子 `Text`(`<id>__label`)を合成して `child` に。`action.event.name = "<id>.press"` |
| `layout.grid` | (対応なし) | v0.9.1 basic カタログに Grid が無いため verbatim + sidecar 温存に降格 |

**v1.0 RC ターゲット(opt-in、`target: "v1.0"`)**: `toA2ui(spec, {target: "v1.0"})` / `patchToA2ui(patch, appliedSpec, {target: "v1.0"})` は v0.9.1 の代わりに A2UI v1.0 RC に追従する。RC の JSON Schema(`a2ui-project/a2ui@main:specification/v1_0/json/` の `agent_to_renderer.json` / `common_types.json` / `renderer_to_agent.json`)と https://a2ui.org/specification/v1.0-a2ui/ を直接取得して検証済み。v0.9.1 との差分:

| v0.9.1(既定) | v1.0(opt-in) | 備考 |
|---|---|---|
| `createSurface {surfaceId, catalogId}` + 別建ての `updateComponents`(+ ref ごとの `updateDataModel`) | 単一の `createSurface {surfaceId, catalogId, components, dataModel?}` | `toA2ui` はコンポーネント全木を `createSurface.components` に同梱し、`resolveData` 指定時のみ解決済みデータを `createSurface.dataModel`(`{refs: {"<ref>": TabularData}}`。ref は JSON Pointer のパスセグメントでなく素のオブジェクトキーなのでエスケープ無し)に同梱する。初回サーフェスに対して別建ての `updateComponents` / `updateDataModel` メッセージは発行しない |
| `createSurface.theme?`(本プロファイルは常に未出力) | `theme` フィールド無し | v1.0 RC で廃止(「Decoupled Branding」: 見た目のスタイリングをレンダラーのネイティブテーマへ全面委譲) |
| (無し) | `callRendererFunction {functionCallId, callFunction}` / `agentFunctionResponse`(server→client)、`callAgentFunction` / `rendererFunctionResponse`(client→server) | 新設の function-call チャネル(レンダラー側・エージェント側のカタログ関数)。kohaku にはレンダラー関数カタログという概念が無いため `toA2ui`/`patchToA2ui` はこれらを発行しない。型は `packages/host-a2ui/src/types.ts` に完全性のため定義 |
| `SpecPatch` → `updateComponents` | 変更なし | `updateComponents` 自体は 2 つのスキーマ間で変わっていない。発行される `version` 文字列のみが異なる |
| `fromA2uiEvent(action)` → `GuiAction` | 変更なし(同一オーバーロード・同一戻り値形) | `fromA2uiEvent` は追加で `{callAgentFunction}` / `{rendererFunctionResponse}` を受理し、それらには明示的な `{kind: "unsupported", reason}` 結果を返す(function-call チャネルに対応する kohaku 概念が無いため)。既存の `action` → `GuiAction` オーバーロードとその戻り値形は不変 |
| コンポーネント単位の `catalogId` 上書き | 未実装 | v1.0 RC の `ComponentCommon` はコンポーネント単位の `catalogId`(サーフェス既定を上書き)を追加している。本プロファイルは 1 サーフェス 1 カタログのため未出力(今回の対応のスコープ外。混在カタログのサーフェスが必要になった際の将来課題) |

**既定出力は無影響**: `target` 省略、または明示的な `target: "v0.9.1"` は v1.0 以前のプロファイルとバイト同一の出力を生成する(golden テストで固定)。

### 6.4 AG-UI / A2A プロファイル [Reserved]

v0.1 では未定義。UISpec / SpecPatch → AG-UI / A2A イベントへの対応表を将来版で規定する(パッケージは存在しない)。

## 7. Conformance [Normative]

機械可読要件は [conformance/manifest.ts](conformance/manifest.ts)(MUST 33。うち **SPEC-STA-001** は state / visibleWhen / state.set の版宣言・参照整合を、**SPEC-STA-002** は `data.bind` の版宣言・初期 variant 整合(BIND_* エラー無し)を self スイートで検査する。bind は [Draft] のため REST 黒箱 manifest には載せない)。**SPEC-ENV-003**(テーマ非依存)・**SPEC-EVT-002**(Renderer の未宣言イベント転送禁止)・**SPEC-DATA-002**(`refVersions` による参照単位の版突合。§2.3)・**CMP-DET-001**(合成の決定性の一般形)・**CMP-GEN-001**(§4 の、生成コンポーネントの `data.$ref` を QueryHandle 集合に制約する規範)は本文上の文書規範であり、manifest には `verification: "reference"` として載り、参照実装のパッケージテスト(`verifiedBy`。前 3 件は §7.1 のレンダラー適合チェックリストでもある)で担保する — 黒箱スイートで直接検査するのではない(REST ホストに対する決定性は黒箱の **REST-CMP-002** が別途直接検査する)。

各要件は検証区分(`verification`)を 2 つ持つ。**blackbox** は conformance スイート(self / REST 黒箱)が baseUrl だけで直接検査する要件(`SPEC-*` / `REST-*` / `LIN-PRM-001`)。**reference** は黒箱検査に馴染まない内部不変条件(`MCPAPP-*` / `SBX-*`、および上記の文書規範 5 件)で、参照実装のパッケージテスト(manifest の `verifiedBy`)で担保する。レポートは reference 要件を「参照実装テストで担保(黒箱検査対象外)」として、blackbox の未検査(別プロファイルで検査されていない `notCheckedMustIds`)とは区別して表示する — 前者は担保済み、後者は当該スイートの対象外という意味の違いを保つため。「当該スイートの対象外」だけでなく実行時に**検査不能**と判定されることもある: **LIN-PRM-001** は `GET /lineage` 自体が到達不能・エラーを返す場合にこの扱いになる(`component.published` が 0 件で到達はできる場合は空虚な合格として区別する)。この場合、合否の集計から除外され(到達不能な依存先を見かけ上の合格にしてしまうことも、任意の前提条件の失敗で CONFORMANT 判定を止めてしまうこともない)、同じ `notCheckedMustIds` の報告経路に、汎用の「未検査」文言ではなく個別の理由を添えて載る。判定行は `CONFORMANT (N MUST not checked)` と表示される。実行:

```bash
node cli/bin/kohaku.js conformance --self                                   # Spec フォーマット自己検査
node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku # REST ホスト黒箱検査
```

MUST 要件をすべて満たす実装を conformant とする。SHOULD 違反はレポートに警告として出る。

[Draft] / [Reserved] のプロファイルのうち、**§6.3 A2UI** は conformance 検査対象外であり manifest には要件を載せない — 仕様確定前に黒箱要件を固定しないため。ただし **§6.1.1 Compose ストリーミングは例外**で、[Draft] ながら REST-STR-001〜003 を manifest に **SHOULD** として登録し REST 黒箱スイートで検査する(ルート自体は MAY のため MUST でなく SHOULD。未実装なら skip、実装済みで違反なら SHOULD 警告。§6.1.1 の条件付き規範を参照)。ワイヤ形状(先頭 `event: spec` / `event: patch` の等価性 / 単一終端)は Draft の間でも回帰検知したいという判断による。

### 7.1 レンダラー適合チェックリスト [Normative, reference]

レンダラーは REST ホストではない(baseUrl で黒箱検査できない)ため、**新規 blackbox manifest 要件は追加しない**。任意のレンダラー実装(参照実装の `renderer-react` / `renderer-wc` を含む)は、以下の文書規範を満たすべきである。参照実装ではこれらを **reference テスト**(パッケージテスト)で担保する — 具体的には `renderer-core` の共有純関数(`resolveEmit` / `resolveBoundRef` / presenter 群)の単体テストと、React ⇄ WC の **parity ハーネス**(意味的 DOM 等価コーパス + 共有イベント挙動コーパス + axe アクセシビリティコーパス。`packages/renderer-wc/test/parity`)が門番になる。

| 規範 | レンダラーが満たすべきこと | 参照テストの担保 |
|---|---|---|
| **SPEC-EVT-002** | Spec の `events` に宣言された `on` のみを上流へ転送し、未宣言イベントは破棄する。`state.set` は Renderer 内で完結させ上流(サーバー)へ出さない。 | parity のイベント挙動コーパス(未宣言 drop / 宣言済み forward が両レンダラーで同一の `onEvent` 到達列)+ `renderer-core` の `resolveEmit` 単体テスト |
| **SPEC-ENV-003** | Spec はテーマ非依存。トークン(`ThemeTokens`)は Renderer 側で解決し、Spec 構造は色・寸法を持たない。 | parity 構造コーパス(同一トークンを両レンダラーが inline 展開し意味的 DOM 等価)|
| **SPEC-STA-001** | クライアントローカル state(`spec.state`)の意味論 — `visibleWhen` 評価・`state.set` によるローカル更新・`intent.hash` 追従の再初期化。 | parity の state.set → visibleWhen DOM 出現コーパス + `renderer-core` の SpecStateStore 単体テスト |
| **SPEC-DATA-002** | 参照渡しデータの版突合を参照単位(`refVersions[ref] ?? dataVersion`)で行い、書き込みループの再解決は event の版で突合(不明なら突合スキップ)する。A1 の `$state` 由来 variant は突合しない。 | parity の A1 bind 再解決 / 書き込みループコーパス + `renderer-core` の BoundDataController 単体テスト |
| **SPEC-A11Y-001**(SHOULD) | 生成された各部品の DOM は、両レンダラーで axe-core の構造的アクセシビリティルール(ARIA 属性・role の妥当性、name/role/value の意味論、ラベル、見出し階層、テーブルヘッダ、フォーム部品のラベル付け)を満たすべきである(SHOULD)。実際の視覚レイアウトに依存して判定するルール(`color-contrast`・`target-size` 等)や、ページ全体の文書・landmark 構造を前提とするルールは、断片単位でのレンダラー検査には対象外(ホストページの責務であり、個々の部品の欠陥ではない)として除外する — 除外の一覧と理由は `packages/renderer-wc/test/parity/axe-config.ts` を参照。 | parity の axe a11y コーパス(`packages/renderer-wc/test/parity/a11y.test.ts`)。SPEC-ENV-003 と同じ golden Spec コーパスに対して両レンダラーで実行する |

`chart` の視覚描画はレンダラー間で pixel 一致を要求しない(参照実装は Recharts と inline SVG で描画が異なる)。ただし a11y 代替(視覚非表示データテーブル)の内容は意味的に等価であること(parity の chart 意味的等価テストが担保)。

上記 4 件の MUST 規範と異なり、**SPEC-A11Y-001 は SHOULD** である: これを満たさなくても適合性検査は失敗しないが、収斂させることが期待される。manifest の MUST 件数(§7)には影響しない。

## 8. 昇格と Lineage [Normative]

- 昇格状態機械: `in_use → candidate → judging → in_review → approved → schema_proposed → published`(+ judge_failed / changes_requested / rejected / withdrawn)。遷移は [packages/lineage/src/promotion/machine.ts](../packages/lineage/src/promotion/machine.ts) の遷移表を正とする。
- **取り下げ(unpublish)**: `published → withdrawn` は専用アクション `unpublish`(≠ `withdraw`)でのみ許す。遷移先は新状態を作らず `withdrawn` を再利用する — `artifactId` は sha256(内容)由来なので同一 artifact の再公開は監査上「同じもの」を意味してしまい、再公開は新 artifact 経由が正しい。`withdraw` アクションは終端(published/rejected/withdrawn)を弾き続ける(LIN-PRM-001 の構造保証と既存遷移は不変)。unpublish はスナップショット権威 → 監査 → 投影除去の順(publish のスナップショット優先順序と対称)で処理するため、その副作用 `onUnpublish`(カタログ/Intent からの昇格分除去。プロダクトが実装)は常に `withdrawn` が永続化され `component.withdrawn`(`from:"published"` で記録し昇格前の取り下げと区別)がログに乗った後に走る。`onUnpublish` は**冪等でなければならない** — 起動時 `reconcile` が draft を保持したまま published でないスナップショットすべてに再適用し、途中失敗した投影除去を収束させるため。カタログ指紋が変わるため昇格部品を含むキャッシュは「削除」でなく「到達不能化」され、その部品を含む固定化は §8 の陳腐化検出が遅延捕捉する。
- 候補化閾値・judge の合格点・ブロッキング性はポリシーとして可変。ただし人間レビュー(LIN-PRM-001)は不変。
- Lineage イベントは追記専用(append-only)で、`{id, ts, actor{kind: user|model|system}, type, payload}` を持つ(MUST)。マルチテナントではレコードに optional `tenant` を刻んでよく(MAY)、`LineageFilter.tenant` で絞り込む(未指定は全件 = 従来挙動。`tenant` 未記録の旧イベントは無指定フィルタでのみ現れる)。昇格集計(`evaluateAndList` / `list`)・固定化提案(`proposals`)・固定化(`fixate` / `getFixation` / `listFixations` / `deleteFixation`)はテナントスコープで行える。`tenant` 非対応ストレージは fail-open(テナント間で固定化を共有)。
- 固定化(L1→L0)は構造のみを固定し、データは `$ref` 参照渡しで常に最新とする(MUST)。固定化 Spec の配信は `provenance: {tier: "L0", cache: "fixated"}` を表示する。
- **`provenance.fallback` を持つ Spec と tier `L2` の結果は固定化してはならない(MUST NOT)** — fallback は意図した構造ではなく生成失敗または capability 交渉による降格であり、L2 は自由生成でありサンドボックス限定(統制は固定化ではなく昇格パイプラインが担う)。どちらかを L0 として固定すると、壊れた構造または未統制の構造を恒久的な高速経路として凍結してしまう。参照実装は `/fixations/approve` で両方を拒否する(fallback 結果は 422 `COMPOSE_FAILED`、L2 結果は 400 `BAD_REQUEST`)。
- **固定化の陳腐化検出**(SHOULD): 固定化 Spec(`pinnedSpec`)は固定化時点の構造であり、その後カタログ(部品の型/props)が変わると壊れた構造を配信し続けうる。ホストは配信前に陳腐化を検査すべきである。参照実装は「指紋 fast path + 遅延再検証 + 自己修復」方式を採る:
  - 固定化レコードは固定化時点の**カタログ指紋**(`catalogFingerprint`、optional = 旧レコード互換)を保持する。
  - 現行カタログ指紋と一致すれば構造は不変とみなし再検証を省いて配信する(**fresh**)。
  - 不一致/欠落なら現行カタログで `pinnedSpec` を再検証する。通過すれば配信し、現行指紋を刻み直して以後を fast path 化する(**revalidated**)。旧レコードはこの経路で自然移行する(移行スクリプト不要)。
  - 検証不通過なら固定化を配信せず(**stale**)、固定化を自己修復として無効化(`intent.unfixated` を `actor: {kind:"system"}`・`reason: "stale"` で記録)して通常 compose にフォールバックする。無効化の失敗は配信を止めない(固定化が残り毎回 revalidate 失敗→フォールバックの縮退運転)。
  - カタログ指紋の判定(fresh / revalidated)を通過した固定化でも、配信前に**解決済み参照 URI の集合**を突合する。固定化 Spec が表す参照 URI 集合(`refVersions` のキー集合。`refVersions` を持たない旧レコードは pin 済み部品の `data.$ref` の集合)が現行 Intent の `resolveQuery` 解決結果の URI 集合と一致しない(URI の追加・削除・差し替え)場合は **stale** とし、同様に固定化を無効化して通常 compose にフォールバックする。カタログ指紋は部品の型/props 由来で query 写像に非依存なため、同一 Intent でもコード改版・semantic 層の変更で参照集合がドリフトすると fresh / revalidated では捕捉できない。ドリフトしたまま配信すると参照単位の版突合(`refVersions` / SPEC-DATA-002)が壊れる(削除された参照は常時 STALE 表示、追加された参照は対応部品が無いまま鮮度表示される)ため安全側に倒す。
  - fresh 経路の Spec/trace は現行と同一(`REST-CMP-002` 等の決定性検査に影響しない)。

---

## 付記: 設計書からの v0.1 拡張(差分)

1. `SemanticPort.describeShape?(handle)` — チャート種別規則・props 充填に列メタデータ(行データは含まない)が必要なため追加。
2. `StoragePort` に `listLineage` / `putPromotionState` / `listPromotionStates` / `getFixation` / `putFixation` / `listFixations` を追加。
3. キャッシュキーに `catalogFingerprint` を追加(部品改版時の取り違え防止)。
4. `provenance.cache` に `fixated` を追加(L0 固定化配信の可視化)。
5. `component.generated` イベントに artifact html を保持(デモ規模の簡略化。本番は専用 artifact ストアを推奨)。
6. エンベロープに `refVersions?`(`$ref` URI → 単体 dataVersion)を追加。複数 `$ref` で版が食い違う Spec の参照単位突合に使う(SPEC-DATA-002)。optional のため旧受信側は無視して従来どおり `dataVersion` で突合する。
7. キャッシュキーに任意成分 `generatorVersion`(MAY)を追加。プロンプト改版・モデル変更で生成物を世代分離する。指定時のみ末尾成分になり、未指定なら従来の 5 成分キーと同一(後方互換)。
8. `FixationRecord` に任意フィールド `catalogFingerprint?`(固定化時点のカタログ指紋)を追加。固定化配信時の陳腐化検出(指紋 fast path / 遅延再検証 / 自己修復無効化。§8)に使う。optional のため旧 `fixations.json` はそのままロードでき、再検証通過時に指紋が刻まれて以後は fast path に載る。
9. マルチテナント契約: `SessionContext.tenant?` / `LineageEventRecord.tenant?` / `LineageFilter.tenant?` / `FixationRecord.tenant?` と、`StoragePort` の固定化系メソッドの optional 第 2 引数 `tenant?` を追加。すべて optional・additive で、`tenant` を使わない利用者の挙動・永続化フォーマット・シグネチャ互換を完全維持する(キャッシュキーには含めない。§4.2 / §6.1 / §8)。
10. server-side ページング/ソート契約: `TabularData.nextCursor?`、`ResolveOptions.page` / `.sort`、`query://` の `_` 予約パラメータ(`_cursor` / `_limit` / `_sort` / `_dir`)と `splitReservedParams`、`presentSpreadsheet` の `serverSide`(1.1.0 に bump)を追加。すべて opt-in で、予約パラメータ未使用なら resolve のワイヤ・レンダラー挙動は従来と同一(§2.3 / §5)。capability 検証は予約パラメータを除いた base ref に対して行う。
11. 双方向バインディング契約 [Draft] (A1): `data.bind: { <param>: { $state, values[] } }` と純関数 `resolveBoundRef` / `enumerateBindVariants`、軽量コントロール部品 `control.select`(change → state.set)を追加。`$ref` は初期 `$state` 値で埋めた初期 variant の正準 URI。ホストは compose 時に `values` の直積 variant を read スコープで列挙発行し(`issueCapabilityForSpec`)、クライアントは compose 往復なしで effective ref を再解決する。additive で、bind 未使用の 0.2 Spec は valid のまま(§2.3 / §5)。L1 生成には開放しない(generation:excluded)。
12. `StoragePort` の並行性契約を明文化: 同一 (tenant, key) の read-modify-write を直列化するのは**ホスト**の責務である(プロセス単位の single-writer が前提。同一バッキングストアに対する複数インスタンス同時実行は対象外)。この契約のもとで特定の 1 レースだけを狭める additive なフックを 2 つ追加した — `putFixation` の任意 `options?: { ifPresent? }`(キーが既に存在しない限り書き込みを no-op にする。自己修復の `refreshFingerprint` が他の書き手が削除済みの固定化を復活させないために使う)と `FixationRecord.revision?`(プロセス内で単調増加する per-write トークンで、`fixatedAt` の ms 精度タイムスタンプより粒度が細かい。`invalidate` の TOCTOU ガードは存在すればこちらを優先し、無ければ `fixatedAt` にフォールバックする)。いずれも optional・additive で、これらを持たない旧 `StoragePort` 実装・固定化レコードの挙動は不変。
