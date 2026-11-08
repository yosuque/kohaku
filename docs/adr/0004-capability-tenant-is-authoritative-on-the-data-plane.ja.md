# 0004. データ面では capability トークンのテナントを正とする

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 設計

## コンテキストと課題

`KOHAKU_AUTHZ=jwt` のとき、REST のデータ面(`/binding/resolve`、`/binding/action`)は意図的に JWT ミドルウェアの外にある。そこで `Authorization` に載るのは JWT ではなく capability トークンだからである。その結果、`/binding/*` では `deps.auth` も `deps.tenant` も何も解決されなかった。これは 2026-10-17 のレビューで残っていた穴で、次の三つの問題を生んでいた。`"approve"` tier の Action が一度も実行できなかった(承認トークンは承認者のテナントに束縛される(design.md #63)が、invoke にはテナントが無かった)。監査レコードにテナントが無かった。`/binding/*` のレート制限が匿名のデモ用 principal をキーにしていて、全員が一つのバケットを共有していた。

capability は、compose とデータ面の境界をまたいで呼び出し元の ID を運べる唯一の成果物である。そのためテナントをどこに持たせるか、capability とリクエストが食い違ったときにどちらを信じるかを決める必要があった。

## 検討した選択肢

- **選択肢A**: capability トークンに、署名された任意の `tenant` クレームを足す。発行側は、ホスト自身のリクエスト解決が得たテナントを入れる。データ面は capability のテナントを正とし、別に解決したテナントが食い違うリクエストは拒否する。
- **選択肢B**: JWT リゾルバが JWS でないトークンも許すようにし、データ面でも他のルートと同じく `Authorization` からテナントを解決する。design.md #76 は、capability は JWT ではないという線引きがあいまいになるとして、これを採らなかった。
- **選択肢C**: テナントをリクエストから解決し続け、capability と食い違ったときはどちらか一方を信じて調停する。design.md #76 は、どちらの向きの調停も採らない。リクエストヘッダは攻撃者が自由に作れる値だからで、食い違いは調停せずに拒否する。

関連して、SPEC での要求の強さも選択肢だった。実装計画はデータ面の半分を MUST と書いていたが、実装では採用せず SHOULD にした(「理由」を参照)。

## 決定

採用: **選択肢A**

- **トークン**: 署名された任意の `tenant` クレームを足す(HMAC の payload は `{sub, scopes, exp, jti, tenant?}` になる)。`AuthzPort.issueCapability(principal, scopes, { ttlSeconds?, tenant? })`、`VerifyResult.tenant?`、`InvocationContext.tenant?` はいずれも後方互換な追加である。クレームは短い識別子(256 文字以内、制御文字なし)とする。不正な値は発行時に例外、検証時には不正な payload として扱う。明示的な `null` も同じ。空文字列はテナント無しを表す。
- **発行**: REST は、リクエストが自分で解決したテナントだけを束縛し、body に書かれたテナントは使わない。対象は `/compose`、`/events`、`/compose/stream`(skeleton と final の両イベント)、promotion のプレビュー用 capability である。
- **データ面**: `/binding/resolve` と `/binding/action` では `verdict.tenant` がテナントになる。`deps.tenant` がそれと違えば `403 CAPABILITY_DENIED` とする。テナントを持たない capability は `deps.tenant` にフォールバックするので、この変更以前に発行したトークンも有効なままである。
- **レート制限**: `/binding/*` の制限を、パスのミドルウェアから各ハンドラーの中へ、検証の後ろに移した。キーは `(capability のテナント, capability の sub, routeClass)` である。body を読む前に bearer の有無を確かめる。
- **MCP**: MCP プロファイルは引き続き自分ではテナントを解決も発行もしないが、データ面のツールは、検証済みの capability に束縛されたテナントを `domain.invoke`、action gate(つまり承認の束縛)、監査に渡す。REST が発行した capability を MCP で使っても、テナントは保たれる。
- **厳格化**: `createHmacAuthzPort({ requireTenant })` と `createJwtAuthzPort({ requireCapabilityTenant })` は、テナントの無いトークンを拒否する。sample-api は、`KOHAKU_AUTHZ=jwt` のときにこの要求を有効にする(`KOHAKU_JWT_REQUIRE_TENANT=0` のときを除く)。テナントを解決しない sample-mcp では無効のままである。
- **SPEC**: CAP-TEN-001(発行)と CAP-TEN-002(データ面)を、どちらも SHOULD [Draft] で追加した。

### 理由

- テナントを capability に持たせたのは、compose とデータ面の境界をまたいで ID を運ぶ場所が、すでにここ一つだけだからである。approve tier の失敗、監査のテナント欠落、レート制限バケットの共有を、JWT ミドルウェアのトークンの扱いを変えずにまとめて解消できる。
- 正とするのは署名された値で、リクエストヘッダではない。食い違いは両方向とも拒否する(fail-closed)。テナントの無いトークンは引き続き使えるので、発行側を先に更新しても既存のトークンは失効しない。
- 検証の後でレート制限を取るから、キーが信頼できる。
- SPEC の要求を MUST でなく SHOULD にしたのは、MCP プロファイルがテナントを解決せず(design.md #63 で先送りした判断)、テナントの無い capability を発行するのが正当だからである。MCP でテナントを解決するかは別の判断として残る。これは、MCP は claim を通すだけにするというメンテナーの指示とも合う。

## 結果(トレードオフ)

- 良い影響: JWT 方式でも approve tier の Action が最後まで実行できる(jwt の e2e で固定)。監査レコードにテナントが入り、`/binding/action` のレート制限キーは JWT の subject とテナントになる。変更は追加のみで、テナントの無いトークン、`deps.tenant` の無いホスト、オプションを無視するポートは従来どおり動く。
- 受け入れるコスト / 悪い影響:
  - `/binding/*` への未認証の大量リクエストは `bodyLimit` でしか抑えられず、429 ではなく 401、403、400 として現れる。
  - Python の `AuthzPort.issue_capability` Protocol に `tenant` キーワードが増えたので、古いシグネチャで書いたカスタム Python ポートは型検査で失敗する。実行時には、ホストがシグネチャを一度だけ調べ、テナント無しで発行し、`on_error`(`capability.tenant_unsupported`)に一度だけ報告する。ポートを更新するまで、束縛は黙って付かない。
  - MCP は引き続きテナントの無い capability を発行する。
  - `KOHAKU_JWT_REQUIRE_TENANT=0` は単一テナント運用の指定で、capability の要求も外れる。その場合はプロファイルごとに別の capability 秘密鍵を使う。要求を有効にするときは二段階で行う。先にすべての発行側を更新する。
- 見直し条件: MCP プロファイルがテナントを解決するようになったとき(またはサポートするすべてのプロファイルがテナント束縛の capability を発行するようになったとき)。その時点で、データ面の半分を MUST に上げられる。また、`KOHAKU_JWT_REQUIRE_TENANT=0` が capability の要求まで外す結び付きを、独立した環境変数にすべきか(どちらも wp-e8a のレポートで未決のままになっている)。

## 参考

- PR: #122(この変更、TS と Python)
- design.md の決定 #76(MCP のテナントの判断は #63)、SPEC §5 の CAP-TEN-001 / CAP-TEN-002
- [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.ja.md): 同じ run で足したもう一つのデータ面の守り。監査レコードに検証済みの principal とテナントが載ることに依存する
