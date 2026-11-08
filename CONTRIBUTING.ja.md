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

- Node >= 24.22.1、pnpm 12。CI は Node 24 と 26 で検証しています。開発者はローカル開発に `.node-version` の指定(26.12.1)を使って構いません。
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
  cd python && uv run ruff check && uv run ruff format --check && uv run mypy && uv run lint-imports && uv run pytest
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
| `pnpm meta:sync` | 公開パッケージ(`packages/*`、`cli`、`spec`)の `package.json` にある `publishConfig` と共通の公開メタデータ | 公開パッケージの `exports` を追加・変更したとき |
| `pnpm python:version` | `python/kohaku/pyproject.toml`、`python/kohaku/src/kohaku/__init__.py`、`python/uv.lock` | TypeScript 側のバージョンが変わったとき(`pnpm version` が実行します) |
| `pnpm init:versions` | `cli/src/init/versions.ts` | `pnpm-workspace.yaml` の `catalog:` のうち `kohaku init` が固定している版を変えたとき(対象パッケージの一覧は `scripts/lib/init-versions.mjs`) |
| `KOHAKU_UPDATE_INIT_GOLDEN=1 pnpm vitest run --project cli cli/test/init/render-golden.test.ts` | `cli/test/init/__golden__/` | `kohaku init` のテンプレートを意図して変えたとき(テストが生成プロジェクトをバイト単位で比較します。通常版と `--mcp` の両方) |

ほかに 2 つ、テストで固定されているものの手で書く成果物があります。値がソースからの関数ではなく判断によるためです。

- core カタログのフィンガープリント: `packages/registry/test/catalog.test.ts`(TS)と `python/kohaku/tests/registry/test_fingerprint.py`(Python)。core コンポーネントを追加・変更すると変わります。テストを一度走らせ、失敗の差分に出る新しい値を貼ってください([add-component.md](docs/runbooks/add-component.md) を参照)。
- `apps/docs-site/snippets/` の docs スニペット: `docs/paths/*.md` の各ページの最初のコードブロックはここから貼ります(スニペットを編集してから両言語のページへ貼る。不一致は `apps/docs-site/test/snippets.test.ts` が検出します)。

**`pnpm regen` は上の表のコマンドをすべて正しい順で実行し、最初に失敗した時点で止まります**(先に `pnpm install` を実行してください。各手順はワークスペースがインストール済みであることに依存するためです)。手で固定する 2 つの成果物には触れません。該当するものが分かっているなら、そのコマンドだけを実行するほうが速く済みます。自分で実行する場合の順序は次のとおりです。

```
pnpm install
pnpm --filter @kohaku-ui/spec run generate-schemas
pnpm --filter @kohaku-ui/registry run export-core-catalog
pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures
pnpm intents:emit
pnpm seed
pnpm meta:sync
pnpm python:version
pnpm init:versions
KOHAKU_UPDATE_INIT_GOLDEN=1 pnpm vitest run --project cli cli/test/init/render-golden.test.ts
```

## 6. バイリンガルドキュメント

英語(無印)がすべての文書の正本であり、`.ja.md` の対訳は同じ変更で更新してください。対象は `README.md`、`docs/design.md`、`docs/specification.md`、`docs/user-guide.md`、`docs/why-kohaku.md`、`docs/paths/*.md`、`spec/SPEC.md`、`python/README.md`、そして `CONTRIBUTING.md` 自身です。

## 7. テストのルール

- **テストから実 LLM を呼び出さないでください。** `FakeLlm`(`@kohaku-ui/llm/fake`、スクリプト応答)または `FixtureLlm`(`@kohaku-ui/evals`、record/replay)を使ってください。
- 永続化を伴うテストは `apps/sample-api/.data/` に触れず、`mkdtemp` の一時ディレクトリを渡してください(このディレクトリはローカルの実行時状態であり、テストフィクスチャではありません)。
- UI の表示を意図的に変えた場合は `KOHAKU_GOLDEN_UPDATE=1` で golden Spec を再生成し、diff をレビューしてからコミットしてください。
- `storage-redis` と `storage-postgres` のアダプタテストは、利用可能なら Docker(testcontainers 経由)を使い、初回実行時に `redis:7-alpine` / `postgres:16-alpine` を pull します。`KOHAKU_ADAPTER_TESTS=skip` を設定するとこれらを丸ごとスキップできます(Docker が無い環境など)。

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

リリースは `main` から Changesets 経由で、2 段階で行います。公開される挙動を変える PR には changeset を添えてください:

```bash
pnpm changeset
```

changeset を含む PR が `main` にマージされると、Version ワークフローが `chore(release): version packages`
PR を作成・更新します。マージ前にこの PR の diff をレビューしてください: 29 パッケージのマニフェスト全て、28
件の `CHANGELOG.md`、`python/kohaku/pyproject.toml`、`python/kohaku/src/kohaku/__init__.py`、ロックファイルが
変更されます。この PR をマージしても**公開はされません**——下書きの GitHub Release `vX.Y.Z` が現れるだけです
(本文は CHANGELOG から自動生成されます)。公開は別の、意図的な操作です: まず `main` から Release ワークフロー
を `dry_run=true` で実行し、次に下書きを公開し(これがタグを作成します)、その後 Release ワークフローが npm →
PyPI の順に公開するのを見守ります。手順全体と公開前チェックリストは
[docs/runbooks/release.ja.md](docs/runbooks/release.ja.md) を参照してください。

`@kohaku-ui/*` の 29 パッケージは**常に同一バージョン**です。1 つのワイヤプロトコルの 1 実装であり、バージョンが割れると利用者のツリーに互換性のない `spec-core` が 2 つ入りうるためです。詳細は [.changeset/README.md](.changeset/README.md)。**開発者のマシンから publish することはありません。**

## 12. 依存関係

- 依存関係の更新は Dependabot の PR 経由で行われます。
- CI の `pnpm audit --prod --audit-level=high` は現状 report-only(非ブロッキング)です。
- `zod` は全パッケージで peerDependency です。バージョンの引き上げは `pnpm-workspace.yaml` の `catalog:` エントリだけで行い、パッケージ個別には行わないでください。
