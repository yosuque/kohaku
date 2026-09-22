<img src="docs/assets/kohaku-icon.png" alt="kohaku" width="112">

# kohaku — AI-Native GUI ライブラリ(リファレンス実装)

[English](README.md) | 日本語

[![CI](https://github.com/yosuque/kohaku/actions/workflows/ci.yml/badge.svg)](https://github.com/yosuque/kohaku/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

UI をコードではなくデータ(宣言的 **UI Spec**)として扱い、生成(Composition)と描画(Rendering)を完全分離する Generative UI 基盤。

**「同内容のリクエストなら、チャットでも Web でも同一表示」**を、UI Composition Service の一本化と Spec キャッシュで構造的に保証します。

```
自然言語(Chat) ─┐                              ┌─ Web(renderer-react)
GUI 操作(Web)  ─┼→ 正規化 Intent → Composition ─┼─ 外部チャット(MCP Apps / 同一バンドル)
                 │   L0 固定 ⇄ L1 宣言合成 ⇄ L2 自由生成(+ 昇格パイプライン)
                 └── データは query:// 参照渡し ── LLM は配管を組む。水(数値)は通さない
```

> **デモドメインについて**: 同梱サンプルは**英語既定**の売上分析デモです。自然言語の例は日英併記で、英語でも日本語でも同じ Intent に正規化されます。デモ UI には **EN/JA トグル**があり(JA を選ぶと i18n 上書きでレンダラーメッセージに日本語が注入されます。sample-wc は `?lang=ja`)。LLM プロンプトは英語で記述され、生成される表示文言の言語は `ComposePolicy.outputLanguage`(既定 English)で指定できます。ライブラリ本体(API・エラーメッセージ・既定 UI 文言)は英語です。

## ドキュメント

| ドキュメント | 内容 | 読者 |
|---|---|---|
| [docs/user-guide.ja.md](docs/user-guide.ja.md) | **ユーザーガイド** — セットアップ・画面の歩き方・デモ 8 本・自プロダクトへの組み込み・運用・FAQ | まず動かしたい人 / 組み込む人 |
| [docs/design.ja.md](docs/design.ja.md) | **実装設計書** — アーキテクチャ・合成パイプライン・サンドボックス・昇格・設計判断記録 | 拡張・保守する開発者 |
| [docs/specification.ja.md](docs/specification.ja.md) | **仕様書** — UI Spec / REST API / Port / 部品カタログ / ブリッジプロトコル / 環境変数のリファレンス | 実装に対して書く開発者 |
| [spec/SPEC.ja.md](spec/SPEC.ja.md) | **Kohaku Protocol v0.1**(規範) — MUST/SHOULD と conformance 要件 | 互換実装を作る人 |
| [python/README.ja.md](python/README.ja.md) | **Python 実装ガイド** — TS とワイヤ互換のフル移植(conformance CONFORMANT)。セットアップ・構成・クロス言語互換の守り方・既知の差異 | Python 実装を読む/使う人 |
| [AGENTS.md](AGENTS.md) | AI コーディングエージェント向け開発ガイド(コマンド・規約・落とし穴)。`CLAUDE.md` はこれを import するポインタ | AI コーディングエージェント |
| [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) | セットアップ・検証・変更の提出方法(英語版: [CONTRIBUTING.md](CONTRIBUTING.md)) | コントリビューター |
| [SECURITY.md](SECURITY.md) | 脆弱性の報告方法とスコープ(`apps/sample-*` のデモ実装はスコープ外) | セキュリティ研究者 |

## インストール

リファレンス実装は npm に `@kohaku-ui/*`(全パッケージ同一バージョン)、PyPI に `kohaku-ui` として公開されています(配布名。import 名は `kohaku` のままです)。

```bash
# REST ホスト + React レンダラ
npm install @kohaku-ui/host-rest @kohaku-ui/renderer-react @kohaku-ui/composer @kohaku-ui/spec-core zod

# 任意の実装をプロトコルに照らして検査(常設インストール不要)
npx @kohaku-ui/cli conformance --rest http://localhost:8787/api/kohaku

# Python 実装
pip install "kohaku-ui[rest]"
```

kohaku 自体を開発する場合は、以下のクイックスタートと [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください。

## クイックスタート(5 分)

前提: Node >= 22、pnpm 12(下限は `package.json` の `engines`。CI は宣言下限の Node 22 と Node 24 の両方で検証、`.node-version` はローカル開発用に 25.7.0 を指定)。

```bash
cp .env.example .env    # LLM プロバイダ設定(下表)
pnpm install
pnpm seed               # (任意)売上シードを作り直すときだけ(生成物は git 管理下・決定的 576 行。dev は無くても動く)
pnpm dev                # API(:8787)+ Web(:5173)同時起動
```

→ http://localhost:5173 — 詳しい手順とデモは [ユーザーガイド](docs/user-guide.ja.md) へ。

| LLM | .env 設定 | 備考 |
|---|---|---|
| Claude(既定) | `KOHAKU_LLM_PROVIDER=claude` + `ANTHROPIC_API_KEY` | |
| OpenAI | `KOHAKU_LLM_PROVIDER=openai` + `OPENAI_API_KEY` | |
| Gemini | `KOHAKU_LLM_PROVIDER=gemini` + `GOOGLE_GENERATIVE_AI_API_KEY` | |
| Ollama(キー不要) | `KOHAKU_LLM_PROVIDER=ollama` + `KOHAKU_LLM_MODEL=gemma4:e4b` 等 | 非思考モデル推奨(モデル未指定時の既定は `llama3.3`) |
| llama.cpp 等 | `KOHAKU_LLM_PROVIDER=llama` + `KOHAKU_LLM_BASE_URL` + `KOHAKU_LLM_MODEL` | OpenAI 互換 |

`@kohaku-ui/llm` と一緒にプロバイダの SDK をインストールしてください: Claude → `@ai-sdk/anthropic`、OpenAI → `@ai-sdk/openai`、Gemini → `@ai-sdk/google`、Ollama / llama.cpp → `@ai-sdk/openai-compatible`(任意の peer dependency。使わないプロバイダの分は何もインストールされません)。

LLM なしでも Dashboard の定番 4 ビュー(L0 固定 Spec)は完全動作します。

## 何が体験できるか([詳細手順](docs/user-guide.ja.md#4-デモウォークスルー8-本))

1. **R5 同一表示** — Chat の質問と GUI 操作が同一 intentHash に合流し `cache:HIT`・ピクセル一致
2. **参照渡し** — Spec JSON に数値ゼロ。データは capability token 付きで部品 → API 直結(なしだと 401)
3. **L2→L1 昇格** — 「カレンダーヒートマップで」→ sandbox 自由生成 → レビュー承認 → 次回から正式部品で L1 描画(再起動後も維持)
4. **インタラクションループと固定化** — 行クリック drilldown / 頻出 L1 を L0 固定化(`cache:FIXATED`、LLM 不通過)

## モノレポ構成

| パス | 内容 |
|---|---|
| `spec/` | Kohaku Protocol 仕様 + 機械可読要件 + conformance スイート |
| `packages/spec-core` | UI Spec スキーマ・Intent 正規化・diff/patch・cacheKey・**Port 型**(フレームワーク境界) |
| `packages/registry` | 部品カタログ(コア 15 部品 + ランタイム専用 `ui.loading`)・federated 解決・capability 交渉・LLM 生成スキーマ変換 |
| `packages/data-binding` | `query://` 参照解決・capability token・STALE 検出 |
| `packages/storage-memory` | StoragePort の参考実装: `createMemoryStoragePort()`(純インメモリ)と `createFileStoragePort(dataDir)`(lineage / 昇格 / 固定化をファイル永続化) |
| `packages/authz-hmac` | AuthzPort の参考実装: `createHmacAuthzPort(secret)`(HMAC-SHA256 capability token) |
| `packages/port-contracts` | **private・test-only。** 全アダプタが通す StoragePort / AuthzPort の共有契約スイート |
| `packages/intents` | Intent DSL(`defineVocabulary` / `defineIntent`)— 値集合とラベルの単一源から SemanticPort 用定義・GUI ファセット・MCP ツール入力を導出(spec-core + data-binding のみの環境中立リーフ) |
| `packages/llm` | LLM プロバイダ抽象(5 種切替・構造化出力の自動フォールバック) |
| `packages/composer` | UI Composition Service(L0/L1/L2・修復ループ・決定的後処理・Spec キャッシュ) |
| `packages/renderer-core` | レンダラー共有核(framework-free / DOM-free の環境中立ロジック: `resolveEmit` / presenter 群)。renderer-react / renderer-wc が同一核を消費 |
| `packages/renderer-react` | Spec→React 描画エンジン + コア部品実装(`./core`) |
| `packages/renderer-wc` | 非 React リファレンスレンダラー(Custom Elements v1 + Shadow DOM の `<kohaku-surface>`。共有核は renderer-core) |
| `packages/sandbox` | L2 隔離実行(3 重防御: opaque iframe / CSP / ブリッジ allowlist) |
| `packages/lineage` | View/Component Lineage・昇格状態機械(L2→L1)・固定化(L1→L0) |
| `packages/evals` | Golden Spec 回帰・LLM-as-Judge・FixtureLlm |
| `packages/host-core` | framework-free な共有ホスト核(固定化配信 + 自己修復、capability 発行、エラーフックヘルパ)。host-rest / host-mcp-apps が同一核を消費する、renderer-core と renderer-react / renderer-wc と同型の関係 |
| `packages/host-rest` / `host-mcp-apps` | REST / MCP Apps(SEP-1865)プロファイル |
| `packages/otel` | 薄い opt-in OpenTelemetry 層(`createOtelComposeObserver`。composer の `composeObservers` で束ねて使う)。依存は composer のみ(peer: `@opentelemetry/api`)、exporter/SDK 配線は無い |
| `packages/host-a2ui` | A2UI 互換プロファイル骨子(UISpec/SpecPatch → A2UI メッセージ。spec-core のみの独立リーフ)[Draft] |
| `packages/client` | 型付きホストクライアント SDK(spec-core + data-binding のみに依存。host-rest 非依存) |
| `apps/sample-api` | サンプル: 売上分析 API(**4 Port 実装の見本**) |
| `apps/sample-web` | サンプル: Dashboard(GUI)/ Chat(NLUI)/ Admin(統制面) |
| `apps/sample-wc` | サンプル: 同一 Spec を React 非依存の `<kohaku-surface>` で描く実演(レンダラー非依存の実証) |
| `apps/sample-mcp` | サンプル: 外部チャット向け MCP サーバー + 共有レンダラー |
| `cli/` | `kohaku conformance / scaffold / component validate` |
| `python/` | **Python 参照実装** — TS `packages/*` のワイヤ互換フル移植(spec / registry / composer / lineage / host-rest / host-mcp)+ サンプル sales-api。conformance CONFORMANT。詳細は [python/README.ja.md](python/README.ja.md) |

## 開発

```bash
pnpm test        # 全テスト(LLM 不要)
pnpm typecheck   # 全パッケージ型検査
node cli/bin/kohaku.js conformance --self                                   # 仕様自己検査
node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku # REST 黒箱検査
```

先に知っておくと踏まずに済む落とし穴:

- 各ワークスペースディレクトリには `vitest.config.ts` が必須(その `name` が `--project` の選択対象になる)— 無いディレクトリがあるとルート設定が自身へ再帰して失敗するため、テストがまだ無いパッケージでも最小限の `passWithNoTests: true` 設定を置く。
- テストは必ずリポジトリルートから実行する — パッケージ内に `cwd` を置くとそのパッケージだけが実行される。単一パッケージだけ実行したいときは `pnpm vitest run --project <name>` を使う(名前は各 `vitest.config.ts` の `name`)。
- テストから本物の LLM を呼び出すコードを書かない。代わりに `FakeLlm`(`@kohaku-ui/llm/fake`。スクリプト化された応答)か `FixtureLlm`(`@kohaku-ui/evals`。record/replay)を使う。

開発規約・落とし穴は [AGENTS.md](AGENTS.md)、v0.1 のスコープ外は [docs/design.ja.md §14](docs/design.ja.md#14-既知の制限と-v02-候補) を参照。

---

Copyright 2026 yosuque. [Apache License, Version 2.0](LICENSE) の下でライセンスされています。
