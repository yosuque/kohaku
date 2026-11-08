# 0014. Action の結果が不明なときは 503 と固定の文言で返す

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

`/binding/action` は `DomainPort.invoke` の失敗をすべて 404 `REF_NOT_FOUND` にし、MCP は汎用のツールエラーにまとめていた。`@kohaku-ui/domain-mcp` は統制付きの Action を上流の MCP サーバーへ転送する。このとき書き込みがタイムアウトしたり、要求を送った後に接続が切れたりすることがある。その場合、上流ではすでに書き込みが実行されているかもしれない。

マージ後の Codex(gpt-6-astra)レビューは、指摘 C11 と修正中の追加指摘で、この状態の問題を挙げた。

- クライアントには「参照が見つからない」と伝わる。
- 「タイムアウトした書き込みは『効果不明』として報告される」という user guide の記述が事実と合わない。
- ステートレス承認(既定)では、同じ承認トークンを再送すると書き込みが二重に実行されうる。

課題は、wire の契約を壊さずに「結果は不明、再試行の前に確認せよ」をどう伝えるかである。

## 検討した選択肢

- **選択肢A**:新しい wire エラーコード(`OUTCOME_UNKNOWN` のような `HostErrorCode`)を足す。必要なら `error.outcome` フィールドも足す。
- **選択肢B**:503 `INTERNAL` を再利用し、規範としての固定の文言を返す。前例として design.md #71(`LLM_PROVIDER_UNAVAILABLE_MESSAGE`)と、ACT-RD-001 の固定文言 `gated operation is not readable` がある。
- **選択肢C**:一律の 404 は変えず、文書だけを直す。

## 決定

採用:**選択肢B**(PR #134)。

- **分類**
  - DomainPort は、文字列の `code` の末尾が `_OUTCOME_UNKNOWN` のエラーで「結果不明」を知らせる。
  - host-core の `classifyHostError` はこれを `outcomeUnknown`(Python は `outcome_unknown`)に分類する。
  - この規約は、spec-core の DomainPort 契約と Python の `python/kohaku/src/kohaku/spec/ports.py` に記載した。host-rest には domain-mcp 専用の分岐を置かない。
- **REST**:`/binding/action` は **503 `INTERNAL`** と `the action's outcome is unknown; verify before retrying` を返す。この文言は `OUTCOME_UNKNOWN_MESSAGE` として export している。
- **MCP**:`kohaku_action` は同じ文言をツールエラーとして返す。
- **エラーの報告**:実際のエラーは引き続き `onError` に届く。
- **SPEC**
  - 新たに **ACT-OUT-001**(SHOULD、[Draft])を定めた。固定の文言を判別子とし、クライアントは `/binding/action` の 503 を自動では再試行しない。
  - `@kohaku-ui/data-binding` の `invokeAction` が再試行しないことはテストで固定している。
  - conformance manifest の SHOULD は 18 件(全体 55 件)になった。
- **domain-mcp**
  - 書き込みが期限を過ぎた場合は、abort と reject のどちらが先に起きても `McpTimeoutError`(`code: "MCP_OUTCOME_UNKNOWN"`)になる。
  - 要求を送った後のその他の失敗は、`McpOutcomeUnknownError` で包み、元のエラーを `cause` に入れる。対象は次のとおり。
    - TS:SDK の `CONNECTION_CLOSED` / `SEND_FAILED` / `REQUEST_TIMEOUT`、fetch の `TypeError`、`ECONNRESET`
    - Python:SDK がローカルで出す -32000 / -32001
  - サーバーが返した JSON-RPC エラーと、送信前に起きたローカルのエラーは、そのまま投げ直す。
  - 読み取りは包まない。読み取りのタイムアウトの扱いは従来のままである。

### 理由

- **A はプロトコル変更になる。** SPEC のエラー表、JSON Schema、クライアント SDK、Python のミラー、各 conformance 実装のすべてに影響する。今のところ一つのアダプタでしか起きない状態のためには大きすぎる。
- **B は、固定の文言を機械可読な判別子にする前例が既に 2 つある。** スキーマの変更も要らない。応答も、再試行してよさそうに見える 404 から、明示的な「先に確認せよ」に変わる。
- **C では、実行されたかもしれない書き込みを「見つからない」と報告し続ける。** これは二重書き込みを招く。
- **末尾が `_OUTCOME_UNKNOWN` のコードという規約を採った理由。** アダプタごとの名前空間(`MCP_…`)を保ったまま、host-core がアダプタを知らずに分類できる。
- **サーバーが返したエラーは包まない。** サーバーが結果を伝えているので、結果は確定している。

## 結果(トレードオフ)

- **良い影響**
  - 実行されたかもしれない書き込みを「見つからない」と報告しなくなった。
  - 「Connection closed」のような SDK の文言が、MCP を通してモデルに渡らなくなった。
  - 将来の DomainPort アダプタも、この規約に乗れば同じ扱いを受けられる。
- **コスト・悪い影響**
  - `/binding/action` の 503 `INTERNAL` が 3 種類になり、文言でしか区別できない。3 種類とは、gate を判定できない場合、capability を検証できない場合、結果不明の場合である。再送が危険なのは最後の一つだけである。
  - host-core、host-rest、host-mcp-apps は minor の更新になる。`HostErrorClass` の union が広がり、status が 404 から 503 に変わるためである。
  - **既知の制約**:lineage には呼び出し前の `action.invoked` しか記録されず、結果不明は `onError` にしか届かない。承認者が lineage を見ても、結果不明かどうかは分からない。専用の lineage イベントは後続の課題とする。
- **見直す条件**:二つ目のアダプタがこの区別を必要としたとき。または、クライアントが文字列の照合なしに分岐する必要が出たとき。その時点で、プロトコル変更として wire のエラーコード(選択肢A)に格上げする。

## 参考

- PR:#121(domain-mcp)、#134(この決定)
- SPEC の ACT-OUT-001、design.md #71(固定の文言の前例)と #75
- [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.ja.md):固定の文言による判別子のもう一つの例である ACT-RD-001
- [ADR-0008](0008-mcp-write-tools-default-to-approve-tier.ja.md):domain-mcp の書き込みツール
