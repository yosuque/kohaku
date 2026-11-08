# 0008. ラップした MCP サーバーの書き込みツールは、既定で approve tier にする

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 設計

## コンテキストと課題

`@kohaku-ui/domain-mcp`(Python のミラーは `kohaku.domain_mcp`)は、既存の MCP サーバーを kohaku の `DomainPort` にする。MCP サーバーを持つチームが、その前に kohaku のガバナンスを置けるようにするためである。このパッケージは、MCP が公開する情報だけで、どのツールが読み取りで、どれが書き込みかを決めなければならない。使えるのは、サーバー自身が付けるいくつかの annotation だけである。サーバーからの書き込みは、直接呼び出さずに、kohaku の承認 gate と監査を通したい。加えて、MCP はデータのバージョンを公開しない。また、MCP ツールの `inputSchema` は、gate が検証する閉じた `ActionParamsSchema` のサブセットより表現力が高い。

## 検討した選択肢

- **選択肢A**: 一つのヒントで分類する。`annotations.readOnlyHint === true` のツールは `query://` の操作にする。それ以外は、annotation が無いツールも含めて(このヒントの MCP の既定値は false)、`tier: "approve"` の Action にする。tier は `tierFor` で上書きできる。
- **選択肢B**: ヒントをそのまま信頼し、分類を上書きする手段を持たない。wp-o5a のレビューがこれを退けた(指摘 S-2)。ヒントは信頼できないので、`isReadOnly(tool)` による上書きと、目立つ場所の「信頼できるサーバーだけに使う」という注意書きを加えた。

## 決定

採用: **選択肢A**。`isReadOnly`、`include`、`tierFor` を明示的な上書き手段として持つ。

- **読み取り**: `createMcpIntents` は、読み取り専用ツールの Intent だけを作る。書き込みツールは、読み取り capability の対象になれない(読み取り capability は、Intent が解決した ref にだけ発行される)。クエリ結果は `TabularData` になる(`structuredContent`、なければ最初の JSON テキストブロックから。リスト、`{rows}`、ラップされた単一のリストを受け付ける)。
- **書き込み**: ツールの `inputSchema` は、閉じた `ActionParamsSchema` のサブセットに射影する。annotation、`pattern`、`format` は落とし、`onSchemaProjection` で報告する。落とした制約の数は、承認者向けの操作の説明に追記する。nullable な二分岐の `anyOf`(Pydantic の `Optional[X]`)は、任意のプロパティにする。それ以外の `anyOf` / `oneOf` / `$ref`、`additionalProperties: true`、未知のキーワードを使うスキーマは、丸ごと省く。その場合、承認者は生のペイロードを見て判断する。
- **引数**: ref の param は文字列なので、`inputSchema` の型に合わせて変換する。`_cursor`、`_sort`、`_dir` は渡さない。`_limit` は capability が署名した ref の外にあるので、署名された `limit` を下げることしかできず(小さい方が勝つ)、結果は `maxLimit`(1000)で頭打ちになる。変換エラーのコードは `MCP_ARGUMENT_INVALID` で(action 経路の `ACTION_PARAMS_INVALID` ではない)、読み取りでのすべての `domain.invoke` の失敗と同様に、REST には `404 REF_NOT_FOUND` として届く。
- **上限**: `callTimeoutMs` は 30 秒(中断し、再試行しない。タイムアウトした書き込みは「効果は不明」と報告する)、`maxRows` は 10 000、`maxResultBytes` は 10 MiB、ツール一覧の取得は 100 ページまで。ツール名は `[A-Za-z0-9_.-]{1,128}` に合うものに限る。読み取り専用か書き込みかが食い違う同名のツールは、すべて落とす(fail closed)。
- **データバージョン**: `mcpDataVersion` は時間バケット(`mcp:<floor(now / 300 s)>`、上書き可能)で、ポートが返すデータにも同じ値を付ける。
- **意図的に範囲外**: `tools/list_changed` に追従しない(操作 index はメモ化され、更新は再起動で行う)。呼び出し元の principal を MCP サーバーに渡さない(クライアントのトランスポートが認証するので、上流の資格情報は一つである)。MCP クライアントは構造的な `McpToolClientLike` として外から渡すので、パッケージは SDK を import しない。
- 射影、型変換、表形式への変換、shape の推定は純関数で、言語間の golden が TS と Python の一致を固定する。

### 理由

- 安全側に倒すため。ヒントを省くサーバーは MCP の既定値 false になるので、そのツールは書き込みとして扱われ、承認が要る。読み取りになるのは、明示的な `readOnlyHint: true`(または `isReadOnly` による上書き)だけである。
- 射影できないスキーマは、近似せずに省く。gate が、サーバーのスキーマと意味の違うスキーマで検証するのを避けるためで、代わりに承認者が生のペイロードを見ることになる。
- `_limit` と `maxLimit` により、URL レベルのパラメータが、署名された読み取りを広げられないようにする。
- 変換エラーは、読み取りでの `domain.invoke` の失敗は 404 にして本文を隠す、という host-rest の既存の慣習に合わせた。型付きのドメインエラーを 4xx に対応づけるかは、別の Port 契約の判断である。

## 結果(トレードオフ)

- 良い影響: ラップした MCP サーバーの書き込みが、承認 gate と監査を通る。実際のプロセス内 MCP サーバーを使った e2e が、compose、resolve、`403 APPROVAL_REQUIRED` になる書き込み、`POST /approvals` の後の成功までを、lineage のイベントも含めて確かめる。
- 受け入れるコスト / 悪い影響:
  - `readOnlyHint` は信頼できないヒントである。書き込みツールを読み取り専用と宣言するサーバーは、approve gate を迂回できる。そのためアダプタは「信頼できるサーバーだけに使う」と文書化し、`isReadOnly` と `include` で分類を統制できるようにした。これとは別に、`tierFor` が `"auto"` を返す書き込みツールは、読み取り ref から読めてしまい、[ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.ja.md) のホスト側の読み取りガードでも守られない。文書はそうしないよう指示している。
  - オブジェクトを `additionalProperties: false` で閉じるので、gate がサーバーより厳しくなることがある。
  - バケットの境界の直前に compose した Spec は、一度だけ古くなる。書き込みをしても、次のバケットまでバージョンは変わらない。
  - 呼び出し元ごとの認可は上流に届かない。ツール一覧の更新には再起動が要る。
  - 変換エラーは、検証エラーの 4xx でなく 404 として REST に届く。
- 見直し条件: 型付きのドメインエラーを 4xx に対応づけることが、Port 契約の判断として扱われるとき(wp-o5a のレビューで ADR の候補として記録された)。

## 参考

- PR: #121(TS と Python)。上限と、信頼に関する条件はパッケージの README に書いてある
- design.md の決定 #75
- [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.ja.md)
