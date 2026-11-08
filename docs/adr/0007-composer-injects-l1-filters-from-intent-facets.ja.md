# 0007. L1 のフィルタは、Intent の facet 宣言から composer が決定的に注入する

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 設計

## コンテキストと課題

L0(固定)の画面は、構造化されたサイドカー `data.bind`(design.md #13)により、再 compose もモデル呼び出しもせずにデータを差し替えられる。モデルが生成する画面(L1)には、そのようなフィルタが無かった。design.md #13 は「L1 への開放」を今後の課題として残し、その条件として、モデルに bind を書かせないことを挙げていた。理由は認可である。bind の値域が capability の読み取り scope を決めるので、モデルがそれを決めてはならない。メンテナーは 2026-11-08 にこれを確認した。フィルタは Intent の facet 宣言から注入し、モデルはフィルタを一切出力しない。

## 検討した選択肢

- **選択肢A**: composer が、Intent 定義の facet 宣言から決定的にフィルタを注入する(採用)。
- **選択肢B**: L1 の生成で、モデルにフィルタと bind を出力させる。上の前提から退けた。モデルが認可される範囲を決めることになる。

選択肢Aの中で、採らなかった案が記録されているもの:

- **capability の再発行**: 実装計画は「final の spec イベントで再発行する」ことを想定していた。L1 のストリームにはそのようなイベントが無い(`skeleton → patch* → done`)ので、最後の収束 patch に載せることにした。
- **変種の上限**: 64 か 256 か(「決定」を参照)。

## 決定

採用: **選択肢A**

- **オプトイン**: `ComposePolicy.l1Filters`。既定は off。TS と Python の sales sample では有効にしている。
- **記述子**: spec-core に `FilterDescriptor { param, queryParam, paths, label, options }` と、任意の `SemanticPort.describeFilters(intent, { tenant, locale })` を足した。`@kohaku-ui/intents` が、`IntentDef.filters(locale)` の facet から記述子を導く。対象は、離散的な文字列の `select` facet だけである。`queryParam` がテンプレートの `fixedParams` に現れるフィルタや、同じパス上の別の param と `queryParam` を共有するフィルタは除外する。
- **注入**: composer の `injectFilters` は `normalizeIds` の後に動く。記述子の `queryParam` が、その `paths` のいずれかの data `$ref` に現れるとき、`control.select`、その `state`、`state.set` イベントを足し、対象のコンポーネントにだけ `data.bind` を付ける。現在の値が options のどれでもないときは、何も注入しない。結果が妥当な Spec でなければ、生成されたままの元の Spec を渡す。
- **キャッシュキー**: 実際に使った記述子(label、options、paths)のハッシュを policy fingerprint に含める。そのため、テナント、ロケール、options の変更をまたいで同じキャッシュ済み Spec が共有されることはない。
- **ロケール**: label は `session.locale` に従う(`ja-JP` は `ja` にフォールバックする)。
- **変種の予算**: `ComposePolicy.l1FiltersMaxVariants`。既定は 64 で、fingerprint に含める。上限を超えたときは注入せず、理由は `variant-limit` とする。
- **capability**: 読み取り scope は、実際に注入した変種から作る。ストリームでは、最後の収束 `patch` イベントに、置き換え用の `capability` と `actions` manifest を載せることがある。確定した Spec が `data.bind` を持つときだけである(SPEC §6.1.1、wire には任意の追加)。
- **MCP の初期データ**: すべての初期 ref に加え、重複を除いた初期でない変種を最大 32 件まで事前解決する。`l1Filters` に関わらず適用され、[ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.ja.md) の gated-read ガードがどの変種にも掛かる。
- **ミラー**: Python も同じ内容を実装した。言語間の golden が `injectFilters`(22 ケース)、記述子のハッシュ、fingerprint(14 ケース)を固定する。

### 理由

- フィルタの集合は Intent 定義の決定的な関数で、生成スキーマは閉じたままなので、モデルは注入される `bind`、`state`、`control.select`、`values` に影響できない。wp-o1 のレビューがこれを確認した。
- 記述子は認可される範囲とラベルの言語を決めるので、キャッシュキーに含めるべきである。そうしないと、テナントやロケールに固有の Spec が、別のテナントやロケールにも返される。
- 上限を 256 でなく 64 にしたのは、256 scope の capability が約 35 KB になり、Node のヘッダ上限 16 KiB を超えて、`/binding/resolve` が 431 を返すからである。
- フィルタごとに `paths` で範囲を限り、あいまいなフィルタは除外する。そのため、ある `queryParam` が、宣言されていない ref の意味を黙って変えることはない。

## 結果(トレードオフ)

- 良い影響: L1 画面のフィルタが、追加の compose もモデル呼び出しも無しにデータを差し替える(sample の e2e、TS と Python)。design.md #13 の「L1 への開放」を閉じる。それ以外のストリームは、従来とバイト単位で同一である。
- 受け入れるコスト / 悪い影響:
  - **選んだ値を「すべて」に戻すことはできない。** 空の bind 値が無いためで、L0 のクロスフィルタと同じ制約である。直すには `data.bind` のプロトコル拡張(空の値でクエリパラメータを外す)が要り、今回の範囲外とした。
  - 対象は、離散的な文字列の `select` facet だけである。あいまいなフィルタは、推測せずに落とす。
  - 変種が 64 を超える Spec は、フィルタ無しで渡される。
  - MCP の初期データの変更(最大 32 件の追加の変種)は、フィルタを持つ Spec に限らず、すべての Spec に効く。
- 見直し条件: 選択を解除するための `data.bind` 拡張に取り組むとき(wp-o1 で、後続の課題かつ ADR の候補として記録された)。

## 参考

- PR: #128(TS と Python)
- design.md の決定 #78(と #13)、SPEC §6.1.1 と変更一覧の項目 22
- [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.ja.md)
