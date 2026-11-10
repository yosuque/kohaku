# 0020. CI の必須ステータスチェックは `ci-ok` 1 つにする

- ステータス: accepted
- 日付: 2026-11-09
- 決定者: yosuque + Claude Code
- フェーズ: 運用

## コンテキストと課題

`main` の ruleset は、CI の各ジョブと matrix の各実行を必須ステータスチェックとして名前で列挙していた(10 個、のちに 12 個)。f43a74cd で `conformance-python` が `file` / `redis` / `postgres` の matrix になると、素の `conformance-python` という名前のチェックは二度と報告されなくなった。ruleset はそれを待ち続け、リリース PR(#105)は 18 個のチェックがすべて成功しているのに「Expected — Waiting for status」のまま止まった。`gh pr checks --required` は報告されたチェックしか表示しないので、欠けている 1 つは見えなかった。その間の他の PR はすべて `--admin` でマージしていた。`--admin` は ruleset を迂回するので、問題が表に出なかった。

同じ時期、PR 1 件あたりのチェックは 19 個あった。多くの CI ジョブは、数秒の本体処理のためにランナーとサービスコンテナの準備に 20〜50 秒を使っていた。conformance の 6 つの実行は、それぞれ約 3 秒の検査だった。

## 検討した選択肢

- **A. ジョブ名を列挙したまま、ジョブ構成を変えるたびに ruleset を更新する。** 手作業で、守らせる仕組みがない。更新を忘れたことが、まさに #105 が止まった原因だった。
- **B. ジョブを統合するが、引き続き名前で必須にする。** 同期すべき名前は減るが、失敗の仕方は変わらない。
- **C. ジョブを統合し、全ジョブを `needs` に持つ `always()` の集約ジョブを 1 つ置く。必須にするのはその集約ジョブと、別ワークフローである CodeQL の `analyze` 2 つだけにする。**

## 決定

採用: **C**(PR #137。ruleset `main` は 2026-11-09 に更新)。

- `ci.yml` は 4 つの作業ジョブ(`ci`、`python`、`integration`、`build`)と集約ジョブ `ci-ok` で構成する。
  - `integration` は旧 `adapters` ジョブと conformance の 6 つの実行を吸収する。Redis と Postgres のサービスを 1 つずつ立て、(ホスト, ストレージ) の組ごとに 1 ステップで実行する。`scripts/ci-conformance.sh` が組ごとに Redis のキー接頭辞と Postgres のスキーマを分ける。
  - `build` は `pack-smoke`、`docs-site`、報告のみの `changeset-check` を吸収する。
  - `playground-drift` は、fixture が 1 件も記録されておらず何も検査していなかったので ci.yml から外した。`pages.yml` では、デプロイ前に失敗すると止まる扱いで引き続き実行する。
- `ci-ok` は `if: always()` で動き、`needs` の結果がすべて `success` でなければ失敗する。依存ジョブが失敗・キャンセルしても `ci-ok` はスキップではなく失敗になる。スキップだと ruleset はチェックが欠けていると扱ってしまう。
- ruleset が必須にするのは `ci-ok`、`analyze (javascript-typescript)`、`analyze (python)` の 3 つ。最新ブランチを必須にする設定(strict)は変えない。

### 理由

- ruleset がジョブ構成に依存しなくなる。ジョブの名前変更・分割・統合・matrix 化をしても、リポジトリ設定に触れる必要がない。マージを止める対象が変わるのは、`ci-ok` の `needs` にジョブを足したときだけになる。
- 統合でジョブごとの準備時間がなくなり、実行時間も延びない。全体の待ち時間を決めるのは今も `ci`(約 4.5 分)で、`integration` と `build` はその間に終わる。
- リポジトリは public なので、ランナーの実行時間に費用はかからない。得られるのは、読みやすいチェック一覧と、必須の範囲を 1 か所で管理できることである。

## 結果(トレードオフ)

- **良い点:**
  - PR 1 件あたりのチェックは 19 個から 10 個に減り、[ADR-0021](0021-ci-verifies-one-runtime-version-which-is-the-declared-floor.ja.md) の後は 8 個になった。
  - 必須チェックは 12 個から 3 個に減った。
  - 古くなった必須チェック名が、気付かれないままマージを止めることはなくなった。
- **コスト・悪い点:**
  - 失敗は `ci-ok` と失敗したジョブの 2 つとして現れる。`integration` の中でどの実行が落ちたかは、チェック名ではなくステップ名で見分ける。
  - conformance の実行と adapter テストが Redis / Postgres を共有する。互いの分離は、`scripts/ci-conformance.sh` が組ごとに分けるキー接頭辞とスキーマに依存する。
  - `ci-ok` は `ci` ジョブ全体を見るので、その全実行がマージを止める対象になった。以前は必須でなかった Node 24 の実行も含む。
- **見直す条件:** 表示はしたいがマージは止めたくないジョブが出てきたとき(`needs` に入れない)。または CodeQL を ci.yml に取り込むとき(その場合は CodeQL も `ci-ok` の下に置ける)。

## 参考

- PR #137(統合と集約ジョブ)、リリース PR #105(停止した PR)、コミット f43a74cd(チェック名を孤立させた matrix 化)
- [ADR-0021](0021-ci-verifies-one-runtime-version-which-is-the-declared-floor.ja.md)
