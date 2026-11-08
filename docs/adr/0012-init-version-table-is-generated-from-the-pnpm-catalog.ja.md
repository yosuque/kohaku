# 0012. `kohaku init` の版表は pnpm catalog から生成する

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

`cli/src/init/versions.ts` は、`kohaku init` が生成するプロジェクトに書き込む、外部依存の版の表である。これまでは `pnpm-workspace.yaml` の `catalog:` ブロックを手で写したもので、`cli/test/init/render.test.ts` のテストで守っていた。Dependabot は catalog を上げられるが `versions.ts` は直せないので、catalog を上げるたびに、誰かが手でファイルを合わせるまでこのテストが赤くなっていた。2026-11-08 の分析(提案 E5)は、直近 50 回の CI 実行で失敗した 9 件のうち 8 件がこれだったと数え、構造的な問題とした。また、CONTRIBUTING §5 は、CI が強制している 17 種の生成物のうち 5 種しか載せていなかった。

## 検討した選択肢

- **選択肢A**: `versions.ts` を catalog から生成し、ずれたら CI を失敗させる。
- **選択肢B**: 手書きの表をテストで守る現状を続ける。

wp-e5 のレポートは、新しい ADR を書く代わりに、[ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.ja.md) に一行を足す案を示した。この変更がその依存方針から導かれるからである。メンテナーは、独立した ADR として記録することを承認した。

## 決定

採用: **選択肢A**

- `scripts/sync-init-versions.ts`(`pnpm init:versions`)が、catalog から `cli/src/init/versions.ts` を書き出す。ファイルの先頭には `GENERATED` の注記を付け、手では編集しない。
- `scripts/lib/read-catalog.mjs` は `catalog:` ブロックを読む厳格なパーサーで、生成スクリプト、`render.test.ts`、`scripts/pack-smoke.mjs` が共有する。空行でもコメント行でもない行を解釈できないときは、行番号を付けて例外を投げる。行末のコメント、引用符付きのキーと値、CRLF は受け付ける。空白を含む引用符なしの値、入れ子のマッピング、複数行の値は拒否する。pack-smoke は、catalog のキーが無いときに `"*"` へフォールバックせず、失敗するようになった。
- CI は生成スクリプトを実行し、`git diff --exit-code -- cli/src/init/versions.ts` で差分を検査する。`render.test.ts` は、値とキーの集合を両方向で確かめ、コミット済みのファイルと生成結果をバイト単位で比べる。
- `pnpm regen` は、すべての生成物を依存の順に再生成し、最初の失敗で止まる。CONTRIBUTING §5(英日)は、CI が強制するすべての生成物と、手で固定する二つを載せる。

### 理由

- catalog が版の唯一の出所になる。catalog を上げた後は、ボットにはできない手作業の編集の代わりに、`pnpm init:versions`(または `pnpm regen`)の一コマンドで済む。
- 厳格なパーサーは、解釈できない catalog の行を、行番号付きのエラーにする。生成されたプロジェクトに、黙って誤った版が入ることを防ぐ。

## 結果(トレードオフ)

- 良い影響: 表が catalog と黙ってずれることがなくなり、手で編集する手順が消えた。切り替えで値は変わっていない。catalog の項目を上げるとテストが赤になり、`pnpm init:versions` で緑に戻る。`versions.ts` を手で編集すると、drift の検査が失敗する。
- 受け入れるコスト / 悪い影響: Dependabot はこのファイルを再生成できない。catalog を上げる Dependabot の PR は、誰かが `pnpm init:versions` を実行して push するまで赤のままである(`dependabot.yml` のコメントに書いてある)。パーサーが受け付ける catalog の書き方は、上に挙げた形に限られる。
- 見直し条件: 厳格なパーサーが拒否する書き方が、catalog に必要になったとき。

## 参考

- PR: #112
- メンテナーの内部資料(2026-11-08 の PM/EM 分析、非公開)の提案 E5
- [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.ja.md): この ADR の土台になっている依存の更新方針
