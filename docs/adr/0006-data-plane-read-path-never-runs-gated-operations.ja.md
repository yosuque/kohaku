# 0006. データ面の読み取り経路は、confirm / approve の操作を実行しない

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 設計

## コンテキストと課題

データ面の読み取り経路(`GET /binding/resolve`、MCP の `${prefix}_resolve_binding` / `kohaku_resolve_binding` ツール、MCP の初期データの事前解決)は、action gate を通らずに `DomainPort.invoke` を呼ぶ。これまで、`query://` の読み取りが書き込みを実行しないことを支えていたのは、Intent がそのような ref を作らないという前提だけだった。wp-o5a のレビュー(指摘 S-1)で、この穴が見つかった。読み取り用 capability のもとで `"approve"` tier の操作を指す ref を使うと、確認も承認も監査も無しに実行される。capability が束縛するのは ref の文字列で、操作の tier ではない。そのため、書き込みツールを指すように手で書いた Intent や、生成された Spec に含まれる幻覚または注入された `$ref` があれば足りる。

## 検討した選択肢

- **選択肢A**: 読み取り経路にホスト共通の守りを置く。`DomainPort.invoke` の前に、ref が指す操作をメモ化済みの `OperationIndex` で引き、記述子の tier が `"confirm"` または `"approve"` の操作を拒否する。
- **選択肢B**: 既存の前提に頼り、それを文書にする。wp-o5a が自分の範囲で行ったのはこれである。パッケージの README に、`createMcpIntents` は読み取り専用ツールの Intent だけを出すこと、手書きの Intent は action の操作を指してはならないことを書いた。
- **選択肢C**: Aに加えて、`listOperations()` に載っていない操作も拒否する。wp-x1 のレポートが退けた案として記録している。`listOperations()` が query の操作を載せていないホストをすべて壊すためである。

## 決定

採用: **選択肢A**。ただし、index に載っていない操作は読み取り可能なままにする。

- host-core が、共通の述語と守りを持つ(`isGatedOperation`、`runGatedReadGuard`、事前解決用の `createGatedReadGuard`)。結果(`readable` / `gated` / `schemaInvalid` / `indexUnavailable`)は、各ホストが自分の wire に対応づける。SPEC では ACT-RD-001(SHOULD [Draft])とした。
- **拒否の形**: REST は `403 CAPABILITY_DENIED`(メッセージ `gated operation is not readable`)を返す。index が読めないときは fail-closed とし、REST は `503 INTERNAL`(`action gate unavailable`)、MCP は通常のツールエラーにする。事前解決ではその ref を飛ばし、compose の結果は成功のままにする。`paramsSchema` が不正な操作(`schemaError`)は、action 経路と同じく拒否する(REST は 500、MCP はツールエラー)。tier で gated になる操作は、スキーマが不正でも、まず gated として拒否する。
- **監査**: 拒否は、fail-open で `action.denied` として記録する。記述子の tier と、理由 `gated operation is not readable` を載せる。守りは capability の検証後に動くので、記録には検証済みの principal とテナントが入る。
- **読み取り可能なまま**: tier の無い操作、tier が `"auto"` の操作、`listOperations()` に載っていない操作。
- **事前解決**: 事前解決ごとに守りを一つだけ作る。index は一度だけ読み、読めないときの報告と監査も一度だけになる。拒否した ref は `denied` として返すので、スナップショットはそれを再度監査せず、期限内に取れなかった失敗としても扱わない。代わりに `SNAPSHOT_REF_NOT_READABLE` を投げる。
- **`DomainPort` の不変条件**: 守りが依存する次の二つを、spec-core の JSDoc、Python の Protocol、SPEC に書いた。`invoke` は渡された操作名そのままで振り分ける。副作用のあるすべての操作は、tier 付きで `listOperations()` に載せる。

### 理由

- すべての読み取りが通る一点で、action gate がすでに参照しているメモ化済みの index を使って強制すれば、コストは読み取りごとのマップ参照一回で済み、wire の形も `DomainPort` も変えずに済む。
- index に載っていない操作を読み取り可能なままにするのは、読み取りの ref が `DomainPort` の載せなくてよい query 操作を指し、そこには強制すべき tier が宣言されていないからである。拒否すると既存のホストがすべて壊れる(選択肢Cを採らなかった理由)。
- index が読めないときは fail-closed にする。action 経路の ACT-APR-001 と同じである。分類できない読み取りこそ、この守りが対象とする場面だからである。
- [Draft] の間は MUST でなく SHOULD とする。CAP-TEN-002([ADR-0004](0004-capability-tenant-is-authoritative-on-the-data-plane.ja.md))と同じである。

## 結果(トレードオフ)

- 良い影響: 幻覚、注入、手書きのいずれの読み取り ref でも、confirm / approve tier の操作を実行できなくなった。REST、MCP、MCP の初期データの事前解決のすべてで成り立つ。gated な操作を宣言しないホストの挙動は変わらない。
- 受け入れるコスト / 悪い影響:
  - `listOperations()` の障害で、読み取りも止まる(503)。これまでは書き込みと actions manifest だけが影響を受けていた。
  - 守りが知っているのは、載せられた操作だけである。`tierFor` が書き込みツールに `"auto"` を返すと、そのツールは読み取り ref から読み取れてしまう。domain-mcp の README、ユーザーガイド、python/README に記載してあり、そうしないよう指示している([ADR-0008](0008-mcp-write-tools-default-to-approve-tier.ja.md) を参照)。
  - Spec が gated な操作にデータを束縛している compose では、その分は何も埋め込まれない。`legacyUiResource` を使うときはスナップショットが落ち(`SNAPSHOT_REF_NOT_READABLE`、fail-open で報告)、`render_snapshot` はツールエラーになる。
- 見直し条件: ACT-RD-001 を MUST に上げるとき、または守りを、tier を宣言するすべての操作に広げるとき。どちらも wp-x1 のレポートで ADR の候補として未決のままになっている。

## 参考

- PR: #124(TS と Python)。指摘の出所は wp-o5a(PR #121)のレビューの S-1
- design.md の決定 #77、SPEC §5 の ACT-RD-001
- [ADR-0004](0004-capability-tenant-is-authoritative-on-the-data-plane.ja.md)、[ADR-0008](0008-mcp-write-tools-default-to-approve-tier.ja.md)
