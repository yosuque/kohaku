# 0009. LLM の base URL はベンダー API の根とし、TS と Python で同じように正規化する

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

PR #115 で追加した wire 契約テスト(本物のプロバイダー SDK を fake transport 越しに動かす)は、`KOHAKU_LLM_BASE_URL` について二つの問題を見つけた。一つ目は、TypeScript の claude プロバイダーがこの値を無視していたことである。`config.baseUrl` が `createAnthropic` に渡されていなかった。二つ目は、値を反映するようにすると、同じ値が二つの言語で別の意味になることである。`@ai-sdk/anthropic` の `baseURL` は `/v1` を含む(`https://gw.example/v1` は `/v1/messages` になる)。一方、Python の `anthropic` SDK は `/v1/messages` を自分で付けるので、`https://gw.example/v1` は `/v1/v1/messages` になっていた。Gemini にも `/v1beta` で同じ食い違いがある。

認証にも関係する発見があった。Python の anthropic SDK 2.x は、API キーを `Authorization: Bearer` で送り、`X-Api-Key` はもう送らない。そのため、`x-api-key` だけを読む独自のゲートウェイは 401 を返すかもしれない(ADR-0003 が対象外とした点)。

## 検討した選択肢

base URL の問いを、wp-e4 のレポートは「片方に正規化を入れるか、文書化するか」と整理している。

- **選択肢A**: claude と gemini ではベンダー API の根を正とし、両言語で値を正規化する。根の形でも、バージョン付きの形でも、両言語で同じリクエスト URL になる。
- **選択肢B**: 片方の言語だけで正規化する。
- **選択肢C**: 挙動の違いは放置し、言語ごとの違いを文書化する。

認証については次の二つ。

- **選択肢D**: SDK の `Authorization: Bearer` を保ち、ゲートウェイを設定しているときは `X-Api-Key` も送る。
- **選択肢E**: SDK の既定のままにする。`x-api-key` だけを読むゲートウェイで 401 になるおそれが残る。

## 決定

採用: **選択肢A**と**選択肢D**

- **規約**: claude と gemini では、`KOHAKU_LLM_BASE_URL` はベンダーの根(例: `https://gw.example`、`https://gw.example/anthropic`)とする。正規化では、前後を trim し、末尾のスラッシュと、末尾の `/v1`(claude)または `/v1beta`(gemini)を一つ取り除く。TypeScript は、`@ai-sdk/anthropic` と `@ai-sdk/google` がバージョン付きの base を求めるので、バージョンを付け直す。Python は SDK がバージョンを付けるので、根をそのまま渡す。
- **変更なし**: openai、ollama、llama は OpenAI 互換の規約のままで、値に `/v1` を含め、正規化しない。空または空白だけの値は、どこでも無視する。
- **固定**: 言語間の golden `llmBaseUrl`(20 ケース)が、正規化後の根と、claude と gemini では本物の SDK が叩くべき最終的なリクエスト URL を持つ。TS と Python の wire テストは、同じ fixture を読む。
- **TS の修正**: claude、openai、gemini に `baseURL` を渡すようにした。
- **Python の認証**: claude アダプタは SDK の Bearer を既定のまま保ち、`X-Api-Key` は、base URL が設定されていて、かつ実際のキーが設定されているとき(プレースホルダーの `not-required` ではないとき)だけ、`default_headers` で送る。テストは SDK の major バージョンに依存しない。

### 理由

- ベンダーの根を値にすれば、利用者は両言語に同じ値を渡せて、同じリクエスト URL になる。`/v1` が付いていても、付いていなくても壊れない。
- そうなるのは、両言語で正規化するからである。片方だけで正規化すると、もう片方は値を別の意味に読む。
- ゲートウェイを設定したときだけ `X-Api-Key` を足せば、既定の経路は SDK が送るままに保たれ、`x-api-key` だけを読むゲートウェイも動き続ける。

## 結果(トレードオフ)

- 良い影響: claude と gemini で、一つの値が両言語で通る。`/v1/v1` の失敗は無くなり、Python の claude 経路は `x-api-key` のゲートウェイの背後でも動く。
- 受け入れるコスト / 悪い影響:
  - **挙動の変更**: TypeScript では、この変数が claude、openai、gemini にも効くようになった。ollama 向けに残っていた値は、これらのプロバイダーの送り先も変えてしまう。changeset とユーザーガイドに記載した。
  - 規約がプロバイダーごとに異なる(claude と gemini は根、ほかは OpenAI 互換の形)ので、仕様書とユーザーガイドに書き分ける必要がある。
  - `anthropic-version: 2026-10-21` のもとで、本物の Anthropic API が Bearer で包んだ API キーを受け付けるかは、オフラインでは確かめられなかった。SDK が設計としてそう送ることからは、受け付けると考えられる。
- 見直し条件: 未確認の Bearer の挙動が、本物の API で拒否されるとわかったとき。または SDK の既定の認証ヘッダが変わったとき。

## 参考

- PR: #115
- [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.ja.md): 「この決定の対象外」とした `Authorization: Bearer` の点を、この ADR が解決する
- [ADR-0010](0010-ts-claude-path-sends-no-sampling-parameters.ja.md): 同じ PR のもう一つの決定
