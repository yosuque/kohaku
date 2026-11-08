# 0013. revision を持たないレコードを空の revision の番兵で保護する

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

[ADR-0005](0005-storage-compare-and-set-is-an-optional-extension.ja.md) で、compare-and-set を `StoragePort` の任意拡張にした。そのときの `expectedRevision` は次の 3 値である。

- 省略:無条件に書く
- `null`:レコードが存在してはならない
- 文字列:保存済みの revision と一致しなければならない

`revision` が導入される前に書かれた `PromotionState` や fixation には revision がない。そのため、こうしたレコードを読み込んだ呼び出し元は「省略」を渡し、そのレコードへの書き込みは毎回無条件になっていた。

マージ後に Codex(gpt-6-astra)でレビューした際、この問題が見つかった(指摘 C3)。独立した検証者も再現している。これで CAS が効かなくなるのは 1 回の書き込みだけではなく、そのレコードがある限りずっとである。

- 再現した状況:revision のない `in_review` レコードを 2 つのインスタンスが読むと、却下と承認の両方が成功し、確定済みの却下を古い承認が上書きした。
- これは全インスタンスを新版に上げた状態でも起きた。
- それなのに、当時の user guide はこの危険を「旧版のままの書き手がいる場合」の話としてしか書いていなかった。

## 検討した選択肢

- **選択肢A**:`expectedRevision` に 4 つ目の状態として空文字列 `""` を加える。意味は「レコードは存在するが revision を持たない」。すべての CAS ポートがこれと比較し、呼び出し元は revision のないレコードを読み込んだときにこれを渡す。
- **選択肢B**:3 値のままにする。複数インスタンスを起動する前に、単一インスタンスで一度だけバックフィルを必ず実行する運用にする。revision のない promotion と fixation のレコードすべてに revision を付ける作業で、user guide もそのように直す。
- **選択肢C**:挙動はそのままにして、文書化だけする。

## 決定

採用:**選択肢A**(2026-11-08 にメンテナーが番兵方式を承認した。PR #133)。

- **比較規則**:すべての CAS ポートで同じ規則にする。
  - レコードが存在する場合は、`normalise(stored.revision) === expected` が成り立てば一致とする。
    - 正規化では、文字列でない revision(無い、`null`、数値、真偽値、オブジェクト)を `""` とみなす。
  - レコードが存在しない場合、`""` は競合になる(`ifPresent` 付きなら何もしない)。
- **対象のポート**:
  - TS:memory、redis、postgres。TS の file ポートは引き続き CAS を宣言しない(ADR-0005)。
  - Python:memory、file、redis、postgres。
  - Postgres は `CASE WHEN jsonb_typeof(payload::jsonb -> 'revision') = 'string' THEN … ELSE '' END` で比較する。
  - キーと DDL は変えていないので、TS と Python は同じバックエンドを共有したまま互換を保つ。
- **呼び出し元**:revision を持たないレコードには `""` を渡す。
  - promotion の candidate store(act と一括 nomination)
  - fixation サービス(unfixate、replace、invalidate、refreshFingerprint、self-heal)
- **契約テストと文書**:
  - `@kohaku-ui/port-contracts` の `requireCompareAndSet` と Python の `_contract.py` にケースを足した。文字列でない revision のケースも含む。
  - TS ⇄ Python の interop テストで、`""` を両方向に確かめている。
  - SPEC §6.1 と付録 12、specification、design #79、user guide(EN と JA)を更新した。

### 理由

- **A は運用の手間なしに、すべてのレコードの穴を塞ぐ。** スケールアウトの前に移行手順を覚えておく必要がない。
- **B は手順が実行されることに依存する。** さらに、最初の CAS 付き書き込みより前にレコードを読んでいたインスタンスは、それでも保護されない。
- **C は、更新が黙って失われる経路を残す。** それこそ ADR-0005 が取り除こうとしたものである。
- **番兵には `""` がふさわしい。**
  - revision は空でないトークンとして生成されるので、実在の revision と衝突しない。
  - 既存の文字列型のフィールドにスキーマ変更なしで収まる。
- **文字列でない revision を正規化すると、ポート間の挙動がそろう。**
  - 正規化する前は、`revision: 5` を持つ壊れた行の扱いがポートごとに違っていた。memory と postgres では永久に競合し、redis と Python の file では自然に直っていた。
  - revision なしとみなせば全ポートの挙動が一致し、その行は次の CAS 付き書き込みで直る。

## 結果(トレードオフ)

- **良い影響**
  - revision のないレコードでも、同時の却下と承認は、成功 1 件と 409 が 1 件になる。revision のあるレコードと同じ結果である。
  - 最初の書き込みで revision が付き、それ以降は通常のレコードになる。
  - 移行作業も DDL の変更も要らない。
- **コスト・悪い影響**
  - `expectedRevision` が 4 状態になり、独自の CAS アダプタはすべてこれを実装しなければならない。契約テストがこれを固定している。
  - #127 より前の版の書き手は無条件に書くので、user guide の「CAS に頼る前に全ての書き手を更新する」はそのまま残る。
- **見直す条件**:スキーマ移行などのために、バックフィルの仕組みがどのみち用意されたとき。その時点で番兵をやめ、「すべてのレコードに revision がある」前提に切り替えられる。

## 参考

- PR:#127(CAS 拡張)、#129(Python の redis/postgres ポート)、#133(この決定)
- [ADR-0005](0005-storage-compare-and-set-is-an-optional-extension.ja.md):この ADR が補正する任意の CAS 拡張
- design.md の決定 #79
