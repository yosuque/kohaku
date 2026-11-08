# 0010. TypeScript の claude 経路は sampling parameter を送らない

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

[ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.ja.md) は、Python の claude ネイティブアダプタが `temperature` などの sampling parameter を送らないようにした。その結果として、Python と TypeScript が Anthropic に送るリクエストパラメータが異なることをコストとして挙げ、両実装を揃え直す条件として「`@ai-sdk/anthropic` が `anthropic-version: 2026-10-21` に移ったとき」を見直し条件にしていた。

この条件そのものは満たされていない。きっかけは、PR #115 の wire 契約テストが見つけたことである。このテストは、本物の `@ai-sdk/anthropic` を fake transport 越しに動かす。kohaku は AI SDK に `temperature: 0` を渡しているが、現行の claude モデル(テストでは `claude-sonnet-5`)では、`@ai-sdk/anthropic` がこれをリクエスト本文から落とし、呼び出しのたびに stderr へ `AI SDK Warning` を出していた。つまり TypeScript は、これらのモデルではすでに `temperature` を wire に載せていなかったのに、毎回警告を出していた。wp-e4 のレポートはこれを未決の問い 3 として挙げていた。害はないが、避けられる。

ADR-0003 と同じく、表示の同一性の保証は Spec キャッシュによるもので、temperature 0 は補助にすぎない(AGENTS.md の「Composer caching」)。

## 検討した選択肢

- **選択肢A**: TypeScript の claude プロバイダーは、AI SDK に `temperature`(およびほかの sampling parameter)を渡さない。ほかのプロバイダーは変えない。
- **選択肢B**: `temperature` を渡し続け、SDK の警告を抑える。テストの最初の案は、ファイル全体で `AI_SDK_LOG_WARNINGS = false` にしてこうしていた。
- **選択肢C**: アダプタを現状のままにし、claude を呼ぶたびの警告を受け入れる。

## 決定

採用: **選択肢A**

`packages/llm/src/adapters/ai-sdk.ts` の `samplingOptions()` は、`claude` に限って `temperature` を省く。すべての呼び出し箇所は `baseCallOptions` を通して、これを共有する。ollama、llama、openai、gemini は変えない(ollama は引き続き `temperature: 0` を wire に載せる)。テストは claude のリクエスト本文を固定する。`generateObject`、呼び出しごとの上書き、`generateText`、ストリーム経路のいずれでも、`temperature`、`top_p`、`top_k` を含まず、SDK の警告ハンドラは何も記録しない。ファイル全体の警告抑制は取り除いた。

### 理由

- 現行モデルでの wire 上の挙動は変わらない。変わるのは、警告が消えることと、コードが実際に送るものを正しく表すことである。
- ADR-0003 の考え方を TypeScript に広げるものである。kohaku が保証する内容はこのパラメータに依存せず、Claude 4.7 以降のモデルは既定のサンプリングしか受け付けない。
- 選択肢Bでは、SDK が捨てるパラメータを送り続け、その事実を伝える警告を隠すことになる。選択肢Cでは、呼び出しのたびに警告が残る。
- API バージョンの条件を待たずに、ADR-0003 が見込んでいたとおり、二つの実装を揃え直せる。

## 結果(トレードオフ)

- 良い影響: 両実装とも Anthropic に sampling parameter を送らなくなり、ADR-0003 がコストに挙げた差が解消した。呼び出しごとの stderr の警告も無くなった。python/README から「TypeScript は temperature を送る」という記述も消えた。
- 受け入れるコスト / 悪い影響: ほかの値を受け付ける古い Claude モデルでは、Python と同様に TypeScript でも、temperature 0 で出力を安定させる効果が失われる。モデルによる挙動の違いが、TypeScript のリクエストの上に現れなくなる。
- 見直し条件: Anthropic が出力の安定性を制御する代わりの手段を用意したとき(ADR-0003 の二つ目の見直し条件)。

## 参考

- PR: #115
- [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.ja.md): この ADR が TypeScript に広げる。ADR-0003 は supersede されず、編集もしない。
- [ADR-0009](0009-llm-base-url-is-the-vendor-api-root.ja.md): 同じ PR のもう一つの決定
