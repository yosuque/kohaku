# 0017. L1 フィルタの descriptor を Intent の params で検証する

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

composer は Intent の facet 宣言から L1 フィルタを注入する([ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.ja.md))。注入した変種はすべて capability に署名される。ところが `buildFilters` は facet ごとに選択肢を独立に列挙するだけで、選択肢の直積が Intent の params の制約を満たすかは確かめていなかった。

マージ後の Codex(gpt-6-astra)レビューは、これを C7 として指摘し、検証者が再現した。再現した状況は次のとおりである。

- Intent のスキーマはある組み合わせ(たとえば `private` × `detail`)を拒否していた。
- ところが、許可された画面に発行された capability を使えば、その組み合わせを `/binding/resolve` で読めた。

最初の修正では、返した descriptor の直積全体を検証した。しかし、レビューで穴が残っていることが分かった。

- composer は、現在値が ref に無いフィルタや、現在値が選択肢に無いフィルタを注入せずに飛ばす。
- そのため、実際に署名される直積では、その param が検証されていない値のままになっていた。

## 検討した選択肢

- **選択肢A**:`describeFilters`(TS は `createLlmSemanticPort`、Python は `semantic_llm`)の中で、次の順に検証する。
  1. 各選択肢を単独で検証し、通らない選択肢を落とす。
  2. 選択肢が 2 つ未満になったフィルタを落とす。
  3. composer が注入しないフィルタを落とす。判定には `injectFilters` と同じ規則を、選択肢ごとの検証の後に適用する。
  4. 残ったフィルタの直積全体を検証する。

  どこかで失敗したとき、または直積が `maxFilterVariants`(既定 64)を超えたときは、その Intent にはフィルタを返さない。
- **選択肢B**:composer が注入した後に、最終的な bind に対して検証する。
- **選択肢C**:制約の扱いはプロダクトに任せ、この穴は文書に書くだけにする。

## 決定

採用:**選択肢A**(PR #135)。

- 検証は catalog 自身の `validateParams` で行い、それが無ければ `normalizeParams`、それも無ければ params のスキーマを使う。
  - GUI と NL の compose が実際に検証に使っている経路と同じだからである。
  - Python では、項目をまたぐ制約を書ける場所はここしかない。params の DSL に `refine` が無いためである。
- 検証の起点は、検証済みで既定値を埋めた `intent.params` とする。ref は `toQueries(intent.params)` で読むので、ref に入る既定値も検証の対象になる。
- 検証する直積は、署名される直積を含む上位集合になる。その中の組み合わせはすべて検証済みである。
- C7 の保証は `createLlmSemanticPort` が与えるものである。独自の SemanticPort では、`describeFilters` が自分の出力を検証しなければならない。このことを design #78 と specification(EN と JA)に記載した。

### 理由

- `describeFilters` では、Intent の定義と catalog の validator の両方が手に入る。しかもその出力は、キャッシュキーに入る descriptor のハッシュの元になっている。ここで検証すれば、キャッシュキーと実際に注入される内容が一致する。
- B では、Intent のスキーマを知らない composer が、変種ごとに意味層を呼び戻さなければならない。
- 失敗したら「フィルタ無し」に倒す。L1 の Spec は表示されるので画面は使えるままで、検証していない範囲に署名することもない。
- C は、認可の範囲を決めるのはモデルではなく descriptor だ、という ADR-0007 の前提と矛盾する。

## 結果(トレードオフ)

- **良い影響**:署名されるすべての変種が、Intent のリクエストと同じ検証を通る。最初の再現と、「注入されないフィルタ」の再現のどちらでも、禁止された範囲は出てこなくなった(TS と Python の両方で確認)。
- **コスト・悪い影響**
  - 禁止された組み合わせが一つでもある Intent では、問題のあるフィルタだけでなく、すべてのフィルタが落ちる。
  - 数え方が composer と異なる。`maxFilterVariants` は直積全体を数えるが、composer の `l1FiltersMaxVariants` は部品ごとの直積の合計で数える。そのため検証は安全側に倒れ、別々の path に乗るフィルタは、composer なら受け入れる場合でも落ちることがある。
  - 2 つの 64 は互いに独立している。片方だけを上げると、もう片方の上限で作られた pin が stale になりうる。
- **見直す条件**:Intent が部分的なフィルタの組み合わせを必要とするようになったとき。その場合は、許可された組み合わせを明示的に表現する方法を用意し、全部落とす規則と置き換える。

## 参考

- PR:#128(L1 フィルタ)、#135(この決定)
- [ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.ja.md)
- design.md #78
