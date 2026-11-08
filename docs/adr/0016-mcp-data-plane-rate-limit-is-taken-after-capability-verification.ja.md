# 0016. MCP のデータ面のレート制限は capability の検証後に掛ける

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

SPEC の CAP-TEN-002 は、データ面でレート制限を掛けるホストに、capability を検証した後で、検証済みのテナント(と principal)をキーにして掛けることを SHOULD として求めている。この要件は MCP の対応する操作も対象として明記している。REST はすでにこれを満たしていた(`authorizeAndRateLimit` で、検証してから制限を取る)。

MCP は `action` と `resolve` について、capability を検証する前に制限を確かめ、`take({ principal, routeClass })` をテナントなしで呼んでいた。そのため `tenants.<id>.rateLimits` の規則は MCP では一度も適用されなかった。REST で発行された capability を MCP で使い回すと、テナントのより厳しい制限ではなく既定の制限で通ってしまう。これはマージ後の Codex(gpt-6-astra)レビューの指摘 C1 で、検証者も確認した。

ところが、検証の後に移すと、Codex から別の懸念が出た。不正な capability は制限に届かなくなるので、不正な capability を大量に送られても、ホストの limiter では全く抑えられない。

## 検討した選択肢

- **選択肢A**:`action` / `resolve` は、検証後に `{ tenant: <検証済みテナント>, principal: <従来と同じ MCP のキー>, routeClass }` で制限を取る。
  - `onRateLimited` にもテナントを渡す。
  - `compose` は従来どおりにする。
  - 検証前の大量送信は、HTTP ホストの前段に置く粗い IP の limiter で抑えるよう文書化する。REST はすでにそう文書化している。
- **選択肢B**:A に加えて、検証前にも粗い limiter のチェックを残す。
- **選択肢C**:検証前に、テナントなしで確かめる現状のままにする。

## 決定

採用:**選択肢A**(PR #131)。TS と Python の両方に入れた。

- キーの principal の部分は変えず、capability の `sub` には切り替えない。理由は次の二つである。
  - `resolvePrincipal` が無いと、`sub` は定数の既定 principal になり、全員が一つのバケットになる。
  - REST で発行された capability を MCP で使い回すと、`sub` は REST 側のものになる。
- この点で CAP-TEN-002 の「検証済みのテナントと subject」とは異なるが、意図的な選択であり、文書化した。CAP-TEN-002 は SHOULD なので、この選択は許される。
- 不正な capability は、limiter にも `onRateLimited` にも届かない。検証の前に MCP を抑えるのは、ペイロードの上限と HMAC の検証だけである。user guide(EN と JA)では、ホストの前段に粗い IP かルート単位の limiter を置くよう案内している。

### 理由

- A は REST と同じ挙動になる。同じ capability がどちらのプロファイルでも同じ制限を受け、MCP でも CAP-TEN-002 が成り立つ。
- B では、正当な呼び出しを同じ limiter で二度数えることになり、MCP の挙動が REST と食い違う。検証前の粗い保護はホストの前段に置くべきもので、REST もそれを前提にしている。
- C のままでは、テナント別の制限を MCP で効かせられない。

## 結果(トレードオフ)

- **良い影響**
  - テナントだけを対象にした制限の規則が、MCP でも効く。
  - `onRateLimited` がテナントを報告する。
  - REST と同じ挙動になる。
- **コスト・悪い影響**
  - IP をキーにした `rateLimitKey` で、MCP への不正な capability の大量送信を抑えていた構成では、その保護がなくなる。外部の limiter が必要になることを、changeset と user guide に明記した。
  - 検証前の処理には制限が掛からない。具体的には、パース、ペイロードサイズの確認、`resolvePrincipal`、HMAC の検証である。
- **見直す条件**:両プロファイルで使える、検証前の粗い limiter をホストが内蔵したとき。

## 参考

- PR:#131
- SPEC の CAP-TEN-002。[ADR-0004](0004-capability-tenant-is-authoritative-on-the-data-plane.ja.md)(capability のテナントを正とする)
- [ADR-0015](0015-mcp-task-owner-is-the-authenticated-principal.ja.md):同じ修正で決めた、タスクの所有者に関する判断
