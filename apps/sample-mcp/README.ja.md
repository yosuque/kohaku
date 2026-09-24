# @kohaku-ui-sample/mcp — MCP サーバーデモ(MCP Apps プロファイル)

[English](README.md) | 日本語

Web と同じ UI Spec・同じ共有レンダラーを、MCP Apps 対応チャットホスト(Claude Desktop / claude.ai /
ChatGPT)に届けるデモ。運用の詳細(ホスト別の描画経路、ツール一覧、スナップショットフォールバック、
トンネル)は[ユーザーガイド §5](../../docs/user-guide.ja.md) を正とし、この README はこのフォルダに
着地した人向けの最小の道標です。

## 前提(初回のみ)

```bash
pnpm --filter @kohaku-ui-sample/mcp build:renderer   # 共有レンダラーの単一ファイルビルド
```

## エントリポイント

```bash
pnpm --filter @kohaku-ui-sample/mcp start        # stdio(Claude Desktop / ローカルホスト)
pnpm --filter @kohaku-ui-sample/mcp start:http   # Streamable HTTP :8788(claude.ai / ChatGPT は公開トンネル経由)
```

⚠️ HTTP エントリは**認証なしのデモ**です — トンネル利用時の注意と環境変数
(`KOHAKU_MCP_HTTP_PORT` / `KOHAKU_MCP_PUBLIC_URL` / `KOHAKU_MCP_HTTP_ALLOWED_HOSTS` など)は
ユーザーガイドを参照してください。

⚠️ `KOHAKU_AUTHZ=jwt` では、認証できるのは Streamable HTTP プロファイル(bearer トークン)だけです。
stdio プロファイルにはトランスポート層での identity がなく、すべてのツール呼び出しを拒否します
(fail-closed)。stdio では `KOHAKU_AUTHZ=hmac`(既定値)を使ってください。

## 最初に知っておくこと

- **ホストにより描画経路は 3 つ**: MCP Apps iframe(Web と同じ描画)/ `kohaku_render_snapshot` の
  自己完結 HTML(ターミナルホスト)/ モデル描画のフォールバックテキスト。
- **永続化は sample-api と共有**(`../sample-api/.data`)。各プロセスは起動時に読み込むため、
  プロセス間の変更(昇格・lineage)の反映は再起動後です。
- 構成: `src/index.ts`(stdio)/ `src/http.ts`(Streamable HTTP)/ `src/setup.ts`(共通配線)/
  `renderer/`(iframe 用の共有レンダラービルド)。
