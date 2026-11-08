# 0003. Python の claude ネイティブアダプタは sampling parameter を送らない

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

Python 版の `claude` ネイティブアダプタ(`python/kohaku/src/kohaku/llm/adapters/anthropic_native.py`)は、`AsyncAnthropic.messages.create` に `temperature=` を渡していた。しかし anthropic Python SDK には、`claude` extra の下限である 1.5.0 から 1.15.0 までのどの版にも、2.x にも、この引数がない。そのため既定の経路では、すべてのリクエストが `TypeError: AsyncMessages.create() got an unexpected keyword argument 'temperature'` で失敗していた。公開済みの `kohaku-ui` 0.5.0 も同じ状態である。これに気付けなかった理由は二つある。テストは常に `AnthropicTransport` を注入するので、SDK の経路が一度も実行されなかった。また、mypy は `params: dict[str, Any]` を展開した `create(**params)` の中身を検査できない。

この不具合は、lock を anthropic 1.15.0 から 2.3.0 に上げる Dependabot #93 を確認する途中で見つかった。SDK 2.x は既定で `anthropic-version` を `2023-06-01` ではなく `2026-10-21` として送る。この API バージョンでは、`temperature`・`top_p`・`top_k` のいずれかを含むリクエストは既定値であっても 400 になる。また Claude 4.7 以降のモデルは、もともと既定のサンプリングしか受け付けない。

kohaku の「同じ表示」の保証は Spec キャッシュによるもので、temperature 0 は補助にすぎない(AGENTS.md の「Composer caching」)。TypeScript の `@kohaku-ui/llm` は `@ai-sdk/anthropic` 経由で `temperature` を送っており、`@ai-sdk/anthropic` は 4.0.99 時点でも `anthropic-version: 2023-06-01` を送っている。

## 検討した選択肢

- **選択肢A**: Python の claude ネイティブ経路では `temperature`(およびほかの sampling parameter)を送らない
- **選択肢B**: `extra_body` 経由で送り続け、既定ヘッダで `anthropic-version: 2023-06-01` に固定する。TypeScript と振る舞いが揃う
- **選択肢C**: extra を `anthropic<2` に制限し、`temperature` を `extra_body` 経由で送る
- **選択肢D**: アダプタを現状のままにする

## 決定

採用: **選択肢A**

### 理由

- extra が許容するすべての SDK 版(1.x と 2.x)と、現行の API バージョンで動く。`KOHAKU_LLM_TEMPERATURE` や呼び出しごとの `temperature` はポートとしては引き続き受け付けるが、Anthropic には転送しない。
- kohaku が保証する内容は、このパラメータに依存していない。表示の同一性はキャッシュが担い、Claude 4.7 以降のモデルは既定のサンプリングしか受け付けない。
- 選択肢B では、アダプタが古い API バージョンに留まる。SDK の型(`messages.create` にこの引数はない)に逆らう実装になり、`2023-06-01` が将来廃止された場合や、新しいバージョンを要する機能が必要になった場合に再び壊れる。
- 選択肢C では、効果が補助的なパラメータを残すために、`claude` extra のすべての利用者が SDK を更新できなくなる。
- 選択肢D では、実際の呼び出しがすべて失敗したままになる。

## 結果(トレードオフ)

- 良い影響: Python の claude 経路が再び動く(#104)。新しい回帰テスト(`python/kohaku/tests/llm/test_anthropic_native_sdk.py`)は、本物の SDK クライアントを `httpx2.MockTransport` 越しに動かす。呼び出しが `TypeError` を出さないこと、リクエスト本文に sampling parameter が含まれないことを確かめ、anthropic 1.15.0 と 2.3.0 の両方で通る。この変更のあとで Dependabot #93(anthropic 2.3.0)をマージできた。
- 受け入れるコスト / 悪い影響: 既定以外の値を受け付けるモデル(Claude Sonnet 4.6 以前)では、temperature 0 で出力を安定させる効果が失われる。Python と TypeScript は、Anthropic に送るリクエストパラメータが意図的に異なることになる。この違いは `python/README*.md` と `docs/specification*.md` に記載した。修正が PyPI に届くのは次のリリースからである。
- 見直し条件: `@ai-sdk/anthropic` が `anthropic-version: 2026-10-21` に移ったとき(TypeScript の経路も同じ 400 に当たるので、そちらでも sampling parameter を送らないようにし、両実装の振る舞いを揃え直す)。Anthropic が出力の安定性を制御する代わりの手段を用意したとき。
- この決定の対象外: SDK 2.x は API キーを `X-Api-Key` ではなく `Authorization: Bearer` で送る。`x-api-key` を読む独自のゲートウェイを `KOHAKU_LLM_BASE_URL` に指定していると 401 になる可能性がある。これは別の課題として扱う。

## 参考

- PR: #104(修正)、#93(lock を anthropic 2.3.0 に更新)
- Anthropic「Migrating to API version 2026-10-21」の「Sampling parameters are removed」: https://platform.claude.com/docs/en/api/migration-2026-10-21
- [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.ja.md): 2.x の major を別途検討に回した更新方針
