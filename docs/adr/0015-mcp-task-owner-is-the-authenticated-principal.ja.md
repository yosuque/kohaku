# 0015. MCP タスクの所有者を認証済みの principal にする

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

MCP Tasks 拡張(任意、`tasksEnabled`)では、バックグラウンドのタスクごとに所有者を結び付ける。そのタスクに `tasks/get` と `tasks/cancel` を実行できるのは所有者だけである。`tasks/get` は結果を返し、その `_meta` には bearer capability が含まれる。所有者のキーは `mcpRateLimitKey` から取っており、この関数は `principal.id` よりもプロダクトの `rateLimitKey` を優先していた。

文書では `rateLimitKey` の例としてクライアントの IP を挙げている。この構成では、同じ NAT の内側にいる別々の認証済み principal が同じ所有者になる。そのため、相手のタスク ID を知りさえすれば、互いのタスクを読み取ることもキャンセルすることもできた。

マージ後の Codex(gpt-6-astra)レビューが、これを指摘 C12 として挙げた。独立した検証者が Python で再現し、TS も同じ論理になっていた。

## 検討した選択肢

- **選択肢A**:専用の所有者キーを設け、優先順を逆にする。
  1. `principal.id`(`resolvePrincipal` が配線され、既定以外の principal を解決した場合)
  2. 上がなければ `rateLimitKey`
  3. それもなければ session(TS は `sessionId`、Python は接続 ID)
  4. 最後は `"anonymous"`
- **選択肢B**:常に `principal.id` を使う。
- **選択肢C**:レート制限キーのまま、危険を文書化する。

## 決定

採用:**選択肢A**(PR #120 → #131)。TS は `mcpTaskOwnerKey`、Python は `_mcp_task_owner_key` として実装した。

- 所有者キーは、タスクの作成時と、`tasks/get` / `tasks/cancel` の判定に使う。
- `mcpRateLimitKey` は変えず、レート制限にだけ使う。
- `resolvePrincipal` が既定の principal(ゲストや匿名)を解決した場合は、レート制限キー、次に session に戻る。こうしてゲスト全員が一つの所有者にまとまらないようにした。
- `resolvePrincipal` は呼び出し元ごとに異なる id を返さなければならない。この点は、型、`tasks.ts` / `tasks.py`、design.md(EN と JA)に記載した。

### 理由

- 認証された識別子は、ホストが持つ中で最も強いキーである。レート制限キーは流量を抑えるための単位であり、IP やテナントのように意図的に共有されることがある。
- B は、`resolvePrincipal` が無い構成で状況を悪化させる。この場合 `principal.id` は定数の匿名 id になるので、全員が一つの所有者になる。
- ゲストのときのフォールバックは、レビューを受けて足した。未認証の呼び出しに共有のゲスト principal を返すプロダクトでは、フォールバックが無いと、それまであった IP ごとの分離が失われるからである。
- C では、文書化された構成で、他人の bearer capability を読める経路が残る。

## 結果(トレードオフ)

- **良い影響**
  - NAT のキーを共有する別々の principal は、互いのタスクの get と cancel を拒否される。
  - 同じ principal なら、別の IP から再接続しても自分のタスクに触れられる。以前は失われていた。
- **コスト・悪い影響**
  - `resolvePrincipal` が無い構成では、所有権は従来どおりレート制限キーか session の強さにとどまる。
  - `resolvePrincipal` が既定以外の共有 id を返すと、その呼び出し元たちは一つの所有者にまとまってしまう。そうしないことを契約で求めている。
- **見直す条件**:プロダクトの `resolvePrincipal` に頼らなくても、ホストがリクエストごとの識別子を使えるような標準が MCP にできたとき。

## 参考

- PR:#120(MCP Tasks と、タスクの所有者への結び付け)、#131(この決定)
- design.md の MCP Tasks の節
- [ADR-0016](0016-mcp-data-plane-rate-limit-is-taken-after-capability-verification.ja.md):同じ修正で決めた、レート制限の順序に関する判断
