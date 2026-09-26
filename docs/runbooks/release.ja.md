# Runbook: kohaku のリリース

これは、常に足並みを揃えて動く 27 個の `@kohaku-ui/*` npm パッケージと `kohaku-ui` PyPI 配布物
([.changeset/README.md](../../.changeset/README.md) 参照)をカット・公開する手順です。コントリビュータ向け
の短い版は [CONTRIBUTING.ja.md §11](../../CONTRIBUTING.ja.md) を参照してください。本 runbook はリリースを
実行する人向けの運用詳細です。

## 1. 概要

リリースは 2 ワークフローで駆動される 2 段階です。「バージョンが確定した」ことと「バージョンが公開された」
ことを別々の、監査可能な瞬間として分離し、その間に人による承認ゲートを置くためです:

```
changeset 付き PR ──merge──▶ main push ──▶ .github/workflows/version.yml
                                            ├─ changeset が残っている → 「chore(release): version packages」
                                            │  PR を作成/更新
                                            └─ changeset が無く & 現バージョンにタグが無い → 下書き
                                               GitHub Release vX.Y.Z を作成
                                               (target = マージコミット、本文 = scripts/release-notes.mjs)

人: .github/workflows/release.yml をドライラン(workflow_dispatch、dry_run=true)──▶ 緑
人: 下書きを公開 ──▶ GitHub がタグ vX.Y.Z を作成 ──▶ `release: published` イベント
                                                    ──▶ .github/workflows/release.yml
                                                        verify → npm(env `npm`、OIDC)
                                                               → pypi(env `pypi`、OIDC)
                                                               → summary
```

- **`version.yml`** は `main` への push でのみ動きます。公開処理は一切行わず、version PR を維持するか、
  (そのマージ後に changeset が残っていなければ)*下書き* の GitHub Release を作るだけです。レジストリには
  一切触れません。
- **`release.yml`** は公開ワークフローです。人が下書き Release を公開したとき(GitHub の
  `release: published` イベント。下書きの作成・編集では発火せず、公開でのみ発火)、または
  `workflow_dispatch` によるドライラン・失敗した公開の再実行として起動します。すべての処理はリリースタグから
  checkout したツリーに対して行われ、公開前にそのツリー上で typecheck・テスト・pack smoke を再検証します。
- **ファイル名 `release.yml` は挙動を左右する制約です。** npm と PyPI 双方の Trusted Publisher がこのファイル
  名に厳密に束縛されて登録されています——リネームすると両方を登録し直す必要があります(§2 参照)。
- 2 つの **Environment**(`npm` と `pypi`)は、各レジストリの OIDC 信頼範囲を絞り、実行画面に公開先レジストリ
  の URL を出すためだけに存在します。どちらも required reviewers は付けていません——この設計における人の
  承認ゲートは、ワークフロー実行の承認ではなく下書き Release の公開そのものだからです。

## 2. 一度きりのセットアップ

これはコードではなくインフラの設定であり、リポジトリと 2 つのパッケージレジストリの管理者が一度だけ行い
ます。PR の一部にはなりません。

- [ ] **GitHub → Settings → Actions → General**: 「Allow GitHub Actions to create and approve pull
  requests」を有効化する。これが無いと `version.yml` は version PR をそもそも開けません(この設計での最初の
  実行が実際にここで失敗しました)。
- [ ] **GitHub → Settings → Environments**: environment `npm` を新規作成する。Deployment branches and
  tags は「Selected branches and tags」で、ブランチ `main` **と** タグ `v*` の両方を許可する。両方必要な
  理由: ドライランはタグがまだ無い状態で `main` から `npm` environment にデプロイし、実公開はリリースタグ
  からデプロイするためです。シークレットは不要(OIDC のみ、`NPM_TOKEN` 無し)。required reviewers は任意
  ——付けるとドライランも承認待ちになります。
- [ ] **GitHub → Settings → Environments**: 既存の `pypi` environment はそのままで良い(任意で同じ `main` +
  `v*` ポリシーを付けても良い——build ステップはドライランでも `main` から走ります)。PyPI 側にコード変更は
  不要です。
- [ ] **npmjs.com、以下の 27 パッケージそれぞれ**: Settings → Publishing access → Trusted publisher →
  GitHub Actions で、次を設定する:
  - Organization or user: `yosuque`
  - Repository: `kohaku`
  - Workflow filename: `release.yml`(拡張子込みで完全一致)
  - Environment name: `npm`

  対象パッケージ: `@kohaku-ui/admin-react`, `authz-hmac`, `authz-jwt`, `cli`, `client`, `composer`,
  `data-binding`, `evals`, `host-a2ui`, `host-core`, `host-mcp-apps`, `host-rest`, `intents`, `lineage`,
  `llm`, `otel`, `registry`, `renderer-core`, `renderer-react`, `renderer-wc`, `sandbox`, `semantic-llm`,
  `spec`, `spec-core`, `storage-memory`, `storage-postgres`, `storage-redis`。
  `release.yml` の `npm` ジョブのドライランはこの 27 件全てをプローブし、未登録のものを列挙します(§4 参照)。
  (`@kohaku-ui/port-contracts` は private のためここには現れません。)
- [ ] **初回の OIDC 公開が成功したら**: リポジトリシークレット `NPM_TOKEN` を削除し、npmjs.com 上で対応する
  トークンを revoke する(この変更以降、ワークフローはこのシークレットを参照しません)。任意で各パッケージの
  「Require two-factor authentication and disallow tokens」を有効化しても良い。
- [ ] **PyPI**: 変更不要。`kohaku-ui` の既存 Trusted Publisher(`yosuque/kohaku` / `release.yml` /
  environment `pypi`)がそのまま使えます。

## 3. version PR

changeset 付きの PR が `main` にマージされると、`version.yml` が `chore(release): version packages` という
タイトルの PR を作成・更新します。他の PR と同様にマージ前にレビューしてください:

- 27 パッケージのマニフェスト全てが同じバージョンに上がっている(fixed グループ)。
- 27 件の `CHANGELOG.md` それぞれに新しい `## <version>` 節が追加されている。
- `python/kohaku/pyproject.toml` と `python/kohaku/src/kohaku/__init__.py` が同じバージョンに上がっている
  ——Python 側がバージョンを保持する 2 箇所であり、`release.yml` の `verify` ジョブが後でタグとの一致を
  検査します。`python/uv.lock` の `kohaku-ui` エントリも同時に上がります(lock が古いと CI の
  `uv lock --check` が失敗します)。
- ロックファイルが更新されている(changeset の削除とバージョン上げの両方が影響します)。

この PR をマージしても**公開はされません**。マージされた changeset が消えるだけで、それによって
`version.yml` の次回実行が「changeset が残っていない」ことに気づき、下書き Release を作成できるようになり
ます。

## 4. 公開前チェックリスト

下書き Release を公開する前に:

- [ ] 下書きを生んだマージコミット(下書き Release の `target` が指すコミットと同じ)で CI が緑であること。
- [ ] 下書き Release の本文(`scripts/release-notes.mjs` が CHANGELOG から生成)の内容が正しいこと——公開
  前に手で編集して文言を直すことも可能。
- [ ] ドライランが緑であること: `main` から `gh workflow run release.yml -f dry_run=true` を実行する
  (ドライランでは `tag` 入力を付けない——実行を開始したブランチをそのまま検証します)。これは npm ジョブの
  Trusted Publisher プローブも実行し、27 パッケージ全てが `ok` と報告されなければなりません。
- [ ] 自動化されたカバレッジでは拾えない、このバージョン固有の手動確認を済ませていること(例: `records` の
  ページングを実際に触る、MCP ホストを実機で動かす、など)——CI の自動テストは実際のリリース候補を人が見る
  代わりにはなりません。
- [ ] `npm` と `pypi` の Environment デプロイポリシーが §2 のとおり(ブランチ `main` とタグ `v*`)になって
  いて、ドライラン・実公開のどちらも想定外にブロックされないこと。

## 5. 公開

下書き Release を GitHub の UI(Releases → 該当の下書き → Edit → Publish release)から公開するか、または:

```bash
gh release edit vX.Y.Z --draft=false
```

これにより GitHub が下書きの target コミットにタグ `vX.Y.Z` を作成し、`release: published` を発火させ、
`release.yml` が実際に(このトリガーでは `dry_run` は暗黙に `false`)動き出します。実行を見守ってください:
`verify` がタグ付きツリー上でバージョン一致・typecheck・テスト・pack-smoke を再検証し、続いて `npm` ジョブが
OIDC trusted publishing + provenance で 27 パッケージを公開し、`pypi` ジョブが wheel/sdist を公開します。
`summary` ジョブのステップサマリには、その実行で実際に公開されたパッケージの一覧、npm パッケージページ・
PyPI プロジェクトページ・GitHub Release へのリンクが載ります。

## 6. 失敗した公開の再実行

部分的な失敗(例: ある npm パッケージだけ Trusted Publisher が未登録だった)は再実行して安全です:

```bash
gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z -f dry_run=false
```

`pnpm -r publish` はレジストリにまだ無いバージョンのパッケージだけを公開するため、既に公開済みのパッケージ
はスキップされ、再実行は冪等です。PyPI 側のアップロードステップも同じ理由で `skip-existing` を使っています。
部分公開がどこまで進んだかを診断するには:

```bash
npm view @kohaku-ui/<pkg> versions
```

## 7. 取り消し

単一の「取り消し」操作はありません。必要に応じて:

- **npm**: 27 パッケージ全てに対する `npm deprecate @kohaku-ui/<pkg>@<version> "<reason>"` が通常の対処法
  です——インストールしようとする人に警告を出しつつ、既にそのバージョンに固定している人を壊しません。
  `npm unpublish` は公開から 72 時間以内で、かつ他の何もそのバージョンに依存していない場合のみ可能です。
  27 パッケージが相互依存する以上、新バージョンへの依存が広がった後は実質使えないと考えてください。
- **PyPI**: リリースを yank する(pypi.org → 対象プロジェクト → 対象バージョン → "Yank")。yank された
  リリースは正確なバージョン指定でのインストールは可能なままですが、既定の依存解決からは外れます。
- **GitHub**: リリースノートを編集して事情を書く。タグは残す——タグは実際に何がビルド・公開されたかの
  監査証跡なので削除しません。

## 8. トラブルシュート

- **「GitHub Actions is not permitted to create or approve pull requests」**: §2 のリポジトリ設定
  (「Allow GitHub Actions to create and approve pull requests」)が無効です。`version.yml` はブランチを
  push できても PR を開けません。
- **「Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE」**: 該当の npm パッケージに Trusted Publisher が登録され
  ていません(リポジトリ・ワークフローファイル名・environment が厳密に一致している必要があります。§2 参照)。
  `npm` ジョブはこれをトークンへの静かなフォールバックにはせず、そのままハードエラーにします——もはやフォール
  バック先のトークンが存在しないためです。
- **「still a draft」**(`release.yml` の `verify` ステップに `tag` 入力を渡したとき): 指定した Release は
  存在するがまだ公開されておらず、タグもまだ存在しません。下書きを公開する(§5)か、`tag` 入力を付けずに
  ドライランして現在の ref を検証してください。
- **`Branch "main" is not allowed to deploy to npm`**: `npm` Environment のデプロイ対象ブランチ/タグ
  ポリシー(§2)に `main` が含まれていません——タグがまだ存在しないドライランに必要です。
