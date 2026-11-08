# 0019. L1 の固定化は配信時に現在のフィルタ descriptor と照合する

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

固定化された Spec は、固定されたままの形で配信される。その `data.bind` の値は注入されたフィルタも含め、配信のたびに新しい capability に署名される。固定化の配信時に確かめていたのは次の 4 つで、フィルタの descriptor は照合していなかった。

- catalog の fingerprint
- intent のハッシュ
- 構造のハッシュ
- 最初の変種の ref のずれ

そのため、facet から選択肢を削除した後でも、注入済みの固定化された Spec は、削除された範囲の capability を受け取り続けた。これはマージ後の Codex(gpt-6-astra)レビューの指摘 C8 で、検証者も確認した。

最初の修正は、レビューでさらに 3 つの問題を明らかにした。

- **L0 の誤った stale 判定**:検査がすべての bind に掛かっていた。その結果、テンプレートが手書きのクロスフィルタ bind を持つ承認済みの L0 固定化は、何もずれていないのに stale と判定され、無効化された。
- **エラー時の fail-open**:`describeFilters` が例外を投げると検査を通過扱いにし、pin の bind にそのまま署名していた。署名の範囲が広がってしまう。
- **再固定化によるすり抜け**:固定化の配信結果は `tier: "L0", cache: "fixated"` を報告する。そのため、固定化済みの intent をもう一度固定化すると、その配信結果が注入済みの bind ごと L0 として pin された。以後、L1 だけを対象とする検査はその pin を永久に飛ばす。

## 検討した選択肢

- **検査の対象**
  - **(a)** すべての bind を検査する。
  - **(b)** 注入の id の命名規則で見分けた bind だけを検査する。
  - **(c)** `provenance.tier === "L1"` の pin だけを検査する。その中では、現在の descriptor に支配されない bind をずれとみなす。
- **descriptor の取得元が例外を投げたとき**:fail-open にする(pin を配信する)、固定化を無効化する、固定化を壊さない「unavailable」という結果にする、のいずれか。
- **再固定化**:エラーで拒否するか、既存のレコードをそのまま返して冪等にするか。

## 決定

採用(PR #135、TS と Python):

- **(c) の tier による絞り込み**
  - 配信時に、L1 の pin の bind の値が、同じ `queryParam` と path を持つ現在の descriptor の選択肢の部分集合になっているかを確かめる。外れていれば、その pin を `stale`(「filter options drifted」)とし、通常の自己修復を走らせる。
  - ハッシュではなく部分集合で比べる。ラベルの変更や選択肢の追加だけなら、fresh のままである。
  - `describeFilters` を持たない port は検査しない。このことは文書に記載している。
  - L0 の pin は対象外である。その bind はテンプレートが管理している。
- **新しい `unavailable` の結果**
  - `describeFilters` が例外を投げると、`materializeFixation` は `cause` を付けた `unavailable` を返す。
  - これを受けて `settleFixation` は、その要求を通常の compose に回す。固定化は無効化せず、bind にも署名しない。
  - 失敗は `onSelfHealError` で `fixation.check` として報告する。
- **再固定化を冪等にする**
  - lineage の `fixate` は、固定化の配信結果(`provenance.cache === "fixated"`)を pin しない。既存のレコードをそのまま返し、書き込みも `intent.fixated` の監査イベントも発生させない。
  - その間にレコードが削除されていた場合は `FixationNotAllowedError("fixated-delivery")` を投げ、REST の両ホストが 409 `CONFLICT` を返す。

### 理由

- 注入が行われるのは L1 だけである。また、注入以外で bind が入ることもない。
  - モデルは `data.bind` を出力できない。生成スキーマが禁じており、prompt-JSON の経路でも `BIND_STATE_UNKNOWN` で弾かれる。
  - A2UI の取り込みも bind を作らない。

  したがって tier は、注入された bind の信頼できる目印になる。
- (b) は命名のヒューリスティックに頼ることになり、L0 の作者がつけた名前と衝突しうる。
- `policy.l1Filters` で絞り込むのは誤りである。policy が on だった間に作られた pin は、off にした後も bind に署名し続けるからである。
- エラー時の各案はどれも難点がある。
  - fail-open にすると署名の範囲が広がる。
  - 一時的なエラーで無効化すると、人が承認した固定化を壊してしまう。
  - `unavailable` は、何も壊さずに fail-closed にできる。
- 再固定化を冪等にすれば、承認の再試行を壊さずに、すり抜けの経路を両ホストが共有する一点で塞げる。

## 結果(トレードオフ)

- **良い影響**
  - フィルタの選択肢を削除すると、固定化された L1 の画面にも次回の配信で反映される。
  - 承認済みの L0 固定化は影響を受けない。
  - descriptor の取得元が落ちても、署名しすぎるのではなく、通常の compose に縮退する。
- **コスト・悪い影響**
  - プロダクトの `extraRules`(PostRule)が L1 に bind を足す場合、その bind も検査の対象になる。このことは文書に記載している。
  - `settleFixation` の結果が 3 種類になり、すべてのホストプロファイルが扱わなければならない。host-core が一か所で処理し、Python はホストの endpoint の対応表に `fixation.check` を加えた。
  - 再固定化は、pin し直す代わりに既存の pin を返すようになった。
- **見直す条件**:L0 の bind についてもテンプレートとのずれを検出する必要が出たとき。または、固定化のレコードに、作成時の descriptor の fingerprint を持たせるようになったとき。

## 参考

- PR:#128(L1 フィルタ)、#135(この決定)
- [ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.ja.md)、[ADR-0017](0017-l1-filter-descriptors-are-vetted-against-the-intent-params.ja.md)
- design.md #78 と固定化の行
