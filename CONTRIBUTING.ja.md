# kohaku へのコントリビュート

[English](CONTRIBUTING.md) | 日本語

kohaku に興味を持っていただきありがとうございます。本書は外部コントリビュータ向けの入口です。日々の開発規約・落とし穴(AI コーディングエージェントが参照するものと同じガイド)は [AGENTS.md](AGENTS.md) を参照してください。繰り返し発生する変更手順は `docs/runbooks/`(例: [protocol-change.md](docs/runbooks/protocol-change.md)、[add-component.md](docs/runbooks/add-component.md)、[python-mirror.md](docs/runbooks/python-mirror.md))にまとまっています。本書は方針レベルにとどめ、手順の詳細はそちらにリンクします。

## 1. コントリビュートの方法

- **バグ報告** — *Bug report* テンプレートで Issue を作成してください。
- **機能要望** — *Feature request* テンプレートで Issue を作成してください。
- **Conformance レポート** — Kohaku Protocol の別実装(別言語・別ホスト)を保守している場合、`kohaku conformance --rest <url>` の実行結果を *Conformance report* テンプレートで報告してください。これは実装間の互換性を議論するための窓口です。検査対象の規範文書は [spec/SPEC.md](spec/SPEC.md) です。
- **Pull Request** — [10 節](#10-コミットと-pull-request)を参照してください。

Issue テンプレートはすべて `.github/ISSUE_TEMPLATE/` にあります。

## 2. 前提条件

- Node >= 22、pnpm 12(`package.json` の `engines` で宣言している下限)。`.node-version` はローカル開発用に 25.7.0 を指定しており、CI は宣言下限の Node 22 と Node 24 の両方で検証します。
- [uv](https://docs.astral.sh/uv/) — `python/` 配下を触る場合のみ必要です。

## 3. セットアップ

```bash
cp .env.example .env    # LLM プロバイダ設定。キーは任意
pnpm install
pnpm test
```

LLM キーが無くても始められます。L0 の固定 Spec(`pnpm test` が検査する範囲すべて)はキー無しで完全に動作します。キーが必要になるのは、実プロバイダで L1/L2 の生成パスを試すときだけです。

## 4. 検証の作法

- 変更後は必ず **リポジトリルート**から `pnpm test && pnpm typecheck && pnpm check:ci` を実行してください。最後の 1 つは Biome(整形 + リント)で、CI でも同じものが走ります。自動修正できる分は `pnpm check` が適用します。パッケージ内に `cwd` を置くとそのパッケージだけが走ります。
- 単一パッケージのテスト: `pnpm vitest run --project <name>`(名前は各パッケージの `vitest.config.ts` の `name` から取得)。
- `python/` 配下を触った場合:
  ```bash
  cd python && uv run ruff check && uv run mypy && uv run lint-imports && uv run pytest
  ```
- 仕様(`spec/`)に触れた場合はセルフチェックを実行してください: `node cli/bin/kohaku.js conformance --self`。

## 5. 生成物

このリポジトリのいくつかのファイルは手書きではなく生成物です。CI は各生成物を再生成し、差分があればビルドを失敗させます(`git diff --exit-code`)。**再生成が必要な変更は、再生成した出力を同じコミットに含めてください。** 下表の生成物を手で編集しないでください。

| コマンド | 出力 | 必要になるタイミング |
|---|---|---|
| `pnpm --filter @kohaku-ui/spec run generate-schemas` | `spec/schemas/` | `packages/spec-core/src/schema/*.ts` の Zod スキーマを変えたとき |
| `pnpm --filter @kohaku-ui/registry run export-core-catalog` | `python/kohaku/src/kohaku/registry/_data/core-catalog.json` | `packages/registry/src/core/*` を変えたとき |
| `pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures` | `spec/test/fixtures/cross-language-canonical.json` | canonical JSON / hash / cacheKey / sanitize 許可リストを変えたとき |
| `pnpm intents:emit` | `apps/sample-web/src/generated/facet-views.json` | `apps/sample-api/src/intents/catalog.ts` の facet を変えたとき |
| `pnpm seed` | `apps/sample-api/src/domain/seed/` | seed 生成器を変えたとき |

複数が該当する場合は次の順で実行してください(後段の手順はワークスペースがインストール済みであることに依存するため、まず install から始めます)。

```
pnpm install
pnpm --filter @kohaku-ui/spec run generate-schemas
pnpm --filter @kohaku-ui/registry run export-core-catalog
pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures
pnpm intents:emit
pnpm seed
```

## 6. バイリンガルドキュメント

英語(無印)がすべての文書の正本であり、`.ja.md` の対訳は同じ変更で更新してください。対象は `README.md`、`docs/design.md`、`docs/specification.md`、`docs/user-guide.md`、`spec/SPEC.md`、`python/README.md`、そして `CONTRIBUTING.md` 自身です。

## 7. テストのルール

- **テストから実 LLM を呼び出さないでください。** `FakeLlm`(`@kohaku-ui/llm/fake`、スクリプト応答)または `FixtureLlm`(`@kohaku-ui/evals`、record/replay)を使ってください。
- 永続化を伴うテストは `apps/sample-api/.data/` に触れず、`mkdtemp` の一時ディレクトリを渡してください(このディレクトリはローカルの実行時状態であり、テストフィクスチャではありません)。
- UI の表示を意図的に変えた場合は `KOHAKU_GOLDEN_UPDATE=1` で golden Spec を再生成し、diff をレビューしてからコミットしてください。

## 8. 依存方向

パッケージの依存方向(逆流禁止)は次の 3 箇所で同時に守られています。

- `spec/test/dependency-direction.test.ts` の `LAYERS` 配列(TS)
- `python/pyproject.toml` の `[tool.importlinter]` セクション(Python)
- `AGENTS.md` の依存方向の記述(ドキュメント)

新しいパッケージ、または層をまたぐ import を追加する場合は 3 つとも更新してください。

新しいワークスペースディレクトリには必ず独自の `vitest.config.ts` が必要です(その `name` が `--project` の選択対象になります)。これが無いとルートの Vitest 設定が自分自身に再帰して失敗します。テストがまだ無いパッケージでも最小限の `passWithNoTests: true` の設定を置いてください。

## 9. AI コーディングエージェントとの協働

[AGENTS.md](AGENTS.md) がエージェント向けガイド(コマンド・規約・落とし穴)の単一の正です。`CLAUDE.md` と `.github/copilot-instructions.md` はこれを指すポインタであり、内容を複製したものではありません。更新は `AGENTS.md` に対して行ってください。

繰り返し発生する変更手順は `docs/runbooks/` にあり、`.claude/skills/` はそれを参照する薄いラッパーです。独立した指示のソースではありません。

このリポジトリには `.mcp.json` が同梱されており、`kohaku-sales` MCP サーバをそのまま使えます。プレースホルダではなく実際にレンダリングされた UI を見るには、事前に共有レンダラーをビルドしてください: `pnpm --filter @kohaku-ui-sample/mcp build:renderer`。`start:http` の HTTP エントリは**認証のないデモ**です。公開トンネルに載せないでください。

## 10. コミットと Pull Request

- 1 コミット 1 論点。
- コミットメッセージは英語の Conventional Commits(`feat(scope): ...` / `fix: ...` / `docs: ...` / `ci: ...` / `chore: ...`。正確な書式は `git log` を確認してください)。
- Pull Request テンプレートのチェックリストを埋めてください。
- L1/L2 プロンプト(`packages/composer/src/prompt.ts`)を変更した場合は `PROMPT_REVISION` を上げてください。これはコンポーズキャッシュをプロンプト世代で分離するための運用値で、チェックリスト項目はレビューでの見落としを防ぐためにあります。
- **CLA も DCO も要求しません。** Apache-2.0 の §5 に従い、提出されたコントリビュートは同ライセンスの下で受け入れられます。

## 11. リリース

リリースは `main` から Changesets 経由で行います。公開される挙動を変える PR には changeset を添えてください:

```bash
pnpm changeset
```

`@kohaku-ui/*` の 20 パッケージは**常に同一バージョン**です。1 つのワイヤプロトコルの 1 実装であり、バージョンが割れると利用者のツリーに互換性のない `spec-core` が 2 つ入りうるためです。詳細は [.changeset/README.md](.changeset/README.md)。**開発者のマシンから publish することはありません。**

## 12. 依存関係

- 依存関係の更新は Dependabot の PR 経由で行われます。
- CI の `pnpm audit --prod --audit-level=high` は現状 report-only(非ブロッキング)です。
- `zod` は全パッケージで peerDependency です。バージョンの引き上げは `pnpm-workspace.yaml` の `catalog:` エントリだけで行い、パッケージ個別には行わないでください。
