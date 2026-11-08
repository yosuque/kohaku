# 0018. 結果の形を変える facet は L1 フィルタにしない

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

注入した L1 フィルタが変えるのは `data.bind` だけで、コンポーネントの props(グラフの `x` / `y` の列など)はモデルが生成したままである。サンプルは `l1Filters` を有効にしており、そのうち 3 つの facet は結果の列名を変える。

- `sales.trend` の metric(revenue → units)
- `sales.trend` の granularity(month → quarter)
- `sales.quarterly_summary` の groupBy(region → product)

これらのフィルタを切り替えると、props が存在しなくなった列を指すので、グラフが空になった。これはマージ後の Codex(gpt-6-astra)レビューの指摘 C9 で、検証者が再現した。e2e は 200 が返ることしか確かめていなかったので、どのテストもこれを検出しなかった。

## 検討した選択肢

- **選択肢A**:次の 2 つを組み合わせる。
  - facet ごとに明示的に除外できるようにする。`filterable?: boolean`(既定 true)を設け、`filterable: false` の facet はフィルタにしない。`toFacetView()` には残す。
  - 二重の防御として、composer にガードを入れる。port が既存の任意メソッド `SemanticPort.describeShape` を持つときは、次の descriptor を飛ばす。
    - 変種の列の集合(順序は無視)が、最初の変種と異なるもの
    - 変種の形を取得できないもの
- **選択肢B**:フィルタの状態に応じてコンポーネントの props を書き換え、グラフが新しい列に追従するようにする。
- **選択肢C**:ガードだけにして、除外の宣言は設けない。

## 決定

採用:**選択肢A**(PR #135)。TS と Python の両方に入れた。

- TS と Python のサンプルの catalog では、metric、granularity、groupBy に `filterable: false` を付けた。
- ガードのために port のメソッドを新設してはいない。
- `describeShape` を持たない port や、最初の変種の形が不明な場合は、ガードが働かない。その場合は port の側で、形を変える facet に印を付ける必要がある。このことを design #78 と user guide(EN と JA)に記載した。
- 選択肢の数が `l1FiltersMaxVariants` を超える descriptor は、どのみち注入が打ち切られるので、形を問い合わせる前に飛ばす。
- サンプルの e2e で、注入した変種の行にグラフの列がすべて含まれることを確かめている。あわせて、サンプルの catalog 全体を `shapeOf` で調べるテストも追加した。

### 理由

- facet が結果の形を変えるかどうかは、facet の作者が知っている。`filterable` は、それを安く明示的に宣言する手段である。
- ガードは誤りを決定的に検出する。
  - 呼び出しの回数には上限があり、変種の URI ごとにメモ化している。
  - descriptor のハッシュを取る前に走るので、キャッシュキーには実際に注入される内容が反映される。
- B では、props が状態に依存するようになる。これは全レンダラーにまたがる、Spec の新しい機能になる。修正の範囲を超える。
- C では、`describeShape` を持たない port が守られない。domain-mcp がその例である。形が静的な `outputSchema` から作られるので、ガードは何も落とせない。

## 結果(トレードオフ)

- **良い影響**
  - サンプルの `sales.trend` に残るフィルタは region だけになり、グラフのセルが空になることはない。
  - 形を変える変種には署名しないので、それらの要求は 403 になる。
- **コスト・悪い影響**
  - 既定の params(region が未指定)では、`sales.trend` にフィルタが一つも付かなくなった。それに合わせて `sales-trend.json` の golden を作り直した。
  - domain-mcp を含め、`describeShape` を持たない port では、facet の作者が形を変える facet に印を付けることに頼るしかない。
- **見直す条件**:Spec の props が状態に依存できるようになったとき。そのときは、形を変える facet もフィルタにできる。

## 参考

- PR:#128(L1 フィルタ)、#135(この決定)
- [ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.ja.md)、[ADR-0017](0017-l1-filter-descriptors-are-vetted-against-the-intent-params.ja.md)
- design.md #78
