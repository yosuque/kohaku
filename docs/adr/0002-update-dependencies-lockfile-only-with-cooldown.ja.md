# 0002. 依存の更新は lockfile のみとし、7 日のクールダウンを置く

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 運用

## コンテキストと課題

TypeScript の依存バージョンの大半は `pnpm-workspace.yaml` の `catalog:` ブロックに集約されている。そのため catalog の範囲指定は、このリポジトリがテストする版を決めるだけのものではない。パック時に公開パッケージの dependency・peer の範囲として書き込まれ、`kohaku init` が生成プロジェクトに書く版を定めた `cli/src/init/versions.ts`(`EXTERNAL_VERSIONS`)とも一致していなければならない。したがって catalog の下限を上げる(`^2.1.1` → `^2.1.6`)と、リポジトリ内に新しい版を必要とするコードがなくても、利用者がインストールできる範囲が狭まる。

Dependabot の npm の既定戦略(`auto`。アプリケーションの requirement では下限を引き上げる)は、まさにこの引き上げを行った。2026 年 11 月には npm の Dependabot PR がすべて catalog の下限を上げており(#95〜#99 と、数日後に作られた #101・#102・#106)、`EXTERNAL_VERSIONS` を手で合わせるまでどれも `cli/test/init/render.test.ts` で CI に落ちた。

方針を決める制約はほかに二つある。一つは、週に何度もリリースされるパッケージ(`ai`、`@ai-sdk/*`)では、数日前の版がすぐ次のパッチで置き換わることが多い点である。もう一つは、乗っ取られたパッケージが発見されて取り下げられるのは公開直後の期間であることが多く、公開からの経過日数でゲートをかけるのはこの危険に備えるためである点である。

同じ方針は、3 回の更新作業(2026 年 10 月の #84・#92、11 月の #103・#107)ですでに手作業で適用してきた。この ADR はそれを明文化する。

## 検討した選択肢

- **選択肢A**: Dependabot による下限の引き上げを毎月受け入れ、PR ごとに `EXTERNAL_VERSIONS` と init のゴールデンを手で合わせる
- **選択肢B**: lockfile だけを更新して下限は据え置き、7 日のクールダウンを置く。下限を上げるのは下記の例外に限る。Dependabot の npm の `versioning-strategy` を `increase-if-necessary` にして、PR も同じ規則に従わせる
- **選択肢C**: 選択肢B と同じだが、Dependabot は `versioning-strategy: lockfile-only` にする
- **選択肢D**: 選択肢B からクールダウンを除く

## 決定

採用: **選択肢B**

1. 更新作業は、実施日の 7 日前を cutoff とする。pnpm では `pnpm update -r --no-save --config.minimumReleaseAge=10080` を実行する。uv では `uv lock --upgrade` を実行したあと、cutoff より新しい版を `uv lock --upgrade-package <pkg>==<version>` で戻す。`--exclude-newer` は lock に記録されてしまうので使わない。
2. catalog の `^` 範囲、package.json の範囲、pyproject の下限は据え置く。例外は次の 3 つである。
   - **exact pin**(react、react-dom、typescript、vitepress、`@biomejs/biome`)は新しい版に上げる。
   - **新しい挙動にコードが依存するパッケージ**は、その挙動が入った最初の版まで下限を上げる(例: #85 での MCP SDK の `^2.3.1`)。
   - **セキュリティ修正**は、クールダウンと下限据え置きの両方の例外とする。下限を修正版まで上げ、利用者や生成プロジェクトが脆弱な版に解決されないようにする(例: #108 での GHSA-jpvv-r467-5p4w に対する `@hono/node-server` の `^2.1.6`)。
3. major の新版は定例の更新では取り込まず、個別に検討する。たとえば anthropic Python SDK 2.x は送信する API バージョンが変わったため、先に [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.ja.md) の対応が必要だった。
4. Dependabot の npm の設定は `versioning-strategy: increase-if-necessary` とする。それでも下限を上げてくる Dependabot PR は、置き換え先の PR をコメントに書いてから close する。
5. catalog を変えたら `EXTERNAL_VERSIONS` を合わせ、`KOHAKU_UPDATE_INIT_GOLDEN=1` でゴールデンを再生成する。公開物(`kohaku init` が生成する内容を含む)が変わる場合は changeset を付ける。

### 理由

- **公開する範囲は理由があるときだけ変わる。** 下限を動かすのを exact pin・挙動への依存・セキュリティ修正の 3 つに限れば、利用者はコードが実際に対応している最も広い範囲を使い続けられる。
- **Dependabot の役に立つ部分は残る。** `increase-if-necessary` は、新しい版を既に許容している requirement は変えずに解決版だけを更新し、exact pin は上げる。この戦略は catalog にも効く。Dependabot の npm の `RequirementsUpdater` は、requirement がどのファイルにあっても同じ戦略を適用し、pnpm workspace の updater がその結果を `pnpm-workspace.yaml` に書き込むからである。選択肢C を退けたのは、lockfile-only の戦略ではマニフェストの変更を要する更新が無視され、react・typescript・Biome の PR がいつまでも作られないからである。
- **クールダウンは頻繁な更新と公開直後の危険を避ける。** 選択肢D では数日で次のパッチに置き換わる PR が作られ、不良なリリースが見つかるまでの猶予もなくなる。
- 選択肢A では Dependabot の PR のたびに手作業が要り、機能上の利点がないまま公開範囲が狭まる。

## 結果(トレードオフ)

- 良い影響: 公開パッケージの dependency・peer の範囲が安定する。`^` 範囲に対する Dependabot PR は lockfile だけの変更になり、手作業なしで CI を通る。毎月の定例作業は、衝突し合う PR の束ではなく 1 回の lockfile 更新で済む。
- 受け入れるコスト / 悪い影響: セキュリティ以外の修正は最大 7 日遅れて lockfile に入る。CI は最新の解決版でテストするため、下限の版そのものはテストされず、下限の版を使う利用者が CI で見えない不具合に当たる可能性がある。`increase-if-necessary` は修正版を既に許容している範囲を変えないので、セキュリティ修正のための下限の引き上げは手作業のまま残る。Dependabot は `EXTERNAL_VERSIONS` を編集できないので、exact pin を上げる PR には引き続き手での同期が要る。
- 見直し条件: Dependabot の pnpm catalog の扱い、または `increase-if-necessary` の挙動が変わったとき。下限の版に起因する不具合が利用者から報告されたとき(その場合は下限の版をインストールする CI ジョブを検討する)。セキュリティ以外の、早く入れる必要がある修正をクールダウンが妨げたとき。

## 参考

- PR: #84・#85・#92・#103・#107・#108(この方針を適用した更新)。置き換えて close した Dependabot PR: #95〜#99・#101・#102・#106
- [.github/dependabot.yml](../../.github/dependabot.yml) の「Catalog and the versioning strategy」の注記
- Dependabot の `versioning-strategy`: https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- dependabot-core: `npm_and_yarn/lib/dependabot/npm_and_yarn/update_checker/requirements_updater.rb` と `file_updater/pnpm_workspace_updater.rb`
- [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.ja.md): この方針で別途検討に回した anthropic SDK 2.x の major
