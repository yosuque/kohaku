<img src="../docs/assets/kohaku-icon.png" alt="kohaku" width="112">

# kohaku Python 実装

[English](README.md) | 日本語

Kohaku Protocol v0.1 の Python 参照実装(TS 参照実装 `packages/*` の対)。
契約の単一ソースはリポジトリの [`spec/`](../spec/SPEC.ja.md)(SPEC.md + JSON Schema)で、
TS 実装とはワイヤ互換 — canonical JSON がバイト一致するため intent.hash / specHash /
キャッシュキー / catalogFingerprint が言語をまたいで一致する。

**conformance**: TS 側 CLI の黒箱検査(`node cli/bin/kohaku.js conformance --rest`)で
**MUST 19/19 = CONFORMANT** を通過済み(SHOULD のストリーミング検査を含む。CI の
`conformance-python` ジョブが毎コミット検査する)。19 は conformance manifest の全 33
MUST のうち黒箱検査可能なもので、残り 14 件の reference MUST(MCPAPP-* / SBX-*、および
TS のレンダラー/composer パッケージテストで担保される文書規範 5 件)は
パッケージテスト(この側では pytest)で担保する。

## セットアップ・検証

前提は Python 3.12+ + [uv](https://docs.astral.sh/uv/) 本体のインストールが必要。

```bash
cd python
uv sync            # 依存インストール(uv workspace)
uv run pytest      # 全テスト(クロス言語 golden 含む。実 LLM 不要で全部通る)
uv run mypy        # 型検査(strict)
uv run ruff check  # lint
uv run lint-imports # レイヤ依存方向(逆流禁止)の契約検査(import-linter)
```

CI(`.github/workflows/ci.yml` の `python` ジョブ)も `ruff check` / `mypy` / `lint-imports` / `pytest` の順で全部を実行する。

## サンプルの起動

```bash
# REST ホスト(:8790。既定は決定的擬似 LLM = KOHAKU_LLM_PROVIDER=fake)
uv run python -m sales_api

# 実 LLM(ローカル ollama)で動かす場合
KOHAKU_LLM_PROVIDER=ollama KOHAKU_LLM_MODEL=gemma4:e4b uv run python -m sales_api

# conformance 黒箱検査(リポジトリルートで。サーバー起動中に)
# ※ この CLI は TS 実装を tsx 経由で実行するため、リポジトリルートで `pnpm install` 済み(node_modules 存在)であること
node cli/bin/kohaku.js conformance --rest http://localhost:8790/api/kohaku

# 売上シードのディレクトリは KOHAKU_SALES_SEED_DIR で上書きできる(既定はリポジトリの
# apps/sample-api/src/domain/seed — Python サンプルはそのシード JSON を直読みする。下の「構成」参照)

# MCP サーバー(stdio。Claude Desktop 等に接続)
uv run python -m sales_api.mcp_main
# MCP サーバー(Streamable HTTP :8791。claude.ai / ChatGPT へは公開トンネル経由。認証なしデモ)
uv run python -m sales_api.mcp_http
# ui:// リソースは TS 側ビルドの共有レンダラーを配信する(未ビルドならプレースホルダ):
#   pnpm --filter @kohaku-ui-sample/mcp build:renderer
```

## 構成

```
python/
├─ kohaku/                # ライブラリ本体(配布名 "kohaku-ui" / import 名 "kohaku")
│  ├─ src/kohaku/
│  │  ├─ spec/             # ← packages/spec-core(スキーマ・正準化・検証・Port 定義)
│  │  ├─ registry/         # ← packages/registry(カタログ。core は TS export の JSON から構築)
│  │  ├─ data_binding/     # ← packages/data-binding(予約パラメータ分割)
│  │  ├─ intents/          # ← packages/intents(Intent DSL)
│  │  ├─ llm/              # ← packages/llm(OpenAI 互換アダプタ / FakeLlm)
│  │  ├─ composer/         # ← packages/composer(L0/L1/L2・single-flight・修復ループ。TS と異なり
│  │  │                    #   tier ladder・single-flight・結果組み立てを compose.py から別モジュール
│  │  │                    #   に分割していない — 挙動は同一で、ファイル構成が粗いだけ)
│  │  ├─ lineage/          # ← packages/lineage(記録・昇格・固定化)
│  │  ├─ evals/            # ← packages/evals(judge / golden / FixtureLlm / 蒸留データセット export)
│  │  ├─ storage/          # FileStoragePort(sample-api の storage-port.ts 相当)
│  │  ├─ host_core/        # ← packages/host-core(framework-free な共有ホスト核)
│  │  ├─ host_rest/        # ← packages/host-rest(FastAPI。SPEC §6.1)
│  │  └─ host_mcp/         # ← packages/host-mcp-apps(MCP Apps プロファイル)
│  └─ tests/
└─ examples/
   └─ sales-api/           # ← apps/sample-api 相当(REST :8790 + MCP stdio / Streamable HTTP :8791)
```

依存方向は TS と同じ: `spec → {registry, data_binding, intents} → {composer(llm), lineage} → host_core → {host_rest, host_mcp} → examples`。
`host_core` は `host_rest` / `host_mcp` が薄いアダプタとして消費する framework-free な共有ホスト核(TS 側の
`packages/renderer-core` と `renderer-react` / `renderer-wc` の関係と同型): 固定化(L1→L0)配信 + 陳腐化自己修復の一連
(`compose_with_fixation` / `resolve_fixated_result` / `settle_fixation`)、生成済み Spec への capability 発行
(`issue_capability_for_spec`。デフォルト TTL 600 秒)、fail-open な観測フックヘルパ(`notify_hook` / `fail_open`)が
一度だけそこに存在する。両プロファイルの違いは自己修復呼び出しのスケジューリング方式のみ(`host_rest` は自身の
テナント別固定化ロックで直列化して await し、`host_mcp` はバックグラウンドタスクとして発火する)。この戦略と各
プロファイル固有のエラーフック文字列は、小さな `FixationDeliveryHost` オブジェクトを介してホスト側が供給する。
read-ref のパース(`host_core.binding_ref.parse_invokable_ref`。REST の `/binding/resolve`、MCP の
`resolve_binding` ツール、MCP の initial-data 事前解決で共有され、verify ステップとエラー→レスポンス変換は各ホスト
側に残る)、書き込み後の effects レスポンス整形(`host_core.action_effects.apply_action_effects`。fail-open —
書き込みは実行済みのため、effects の失敗が成功した書き込みをクライアント向けエラーに見せることはない)、
書き込みアクションの許可集合のメモ化(`host_core.allowed_actions.create_allowed_actions`。ハルシネート/注入された
`action.invoke` アクション名が発行済み capability の write scope に紛れ込むのを防ぐ)も同様にそこへ一度だけ存在し、
それぞれ `host_rest` / `host_mcp` 双方にあった小さな重複を置き換える。fallback ビューの記録
(`host_core.view_recorder.record_view_fallback`。REST の `record_fallback_if_any` と MCP の `_audit_compose` で
共有)もそこに存在する: 判定根拠は compose トレースではなく `spec.provenance.fallback` である — capability
negotiation によるダウングレードはキャッシュヒット時にも再発しうるため、トレースだけではそれを見逃す。

**MCP 2026-07-28**(全体像は `docs/design.ja.md` の「MCP 2026-07-28 / SDK v2 移行」と「Python `mcp` 2.x 移行」
参照): `host_mcp` は `mcp` 2.x SDK(`kohaku-ui[mcp]` の floor `>=2.2`)上で動く — 低レベル `Server` のハンドラ
は `mcp` 1.x が使っていたデコレータではなく `Server.add_request_handler(method, params_type, handler)` で登録
し、各ハンドラはリクエストスコープの contextvar を読む代わりに自身専用の `ServerRequestContext` を受け取る。
全ツール結果はすでに `result_type: "complete"` を実の宣言済み pydantic フィールドとして持つ(2.x の
`CallToolResult` 他の `Result` サブクラスが直接宣言している — TS は自身の SDK バージョン事情で引き続き明示的
にスタンプしているのとは異なり、事後のスタンプ処理は不要)。失敗経路の観測フック(`McpErrorInfo.correlation_id`)
に渡す相関 id は**常にツール呼び出し自身の JSON-RPC リクエスト id であり、`_meta.traceparent`(SEP-414)からは
決して導出しない** — TS と同じルールである。W3C の trace-id は 1 つのトレース全体で共有されるため、そこから相関
id を導出すると 1 会話内の全ツール呼び出しが同じ id に潰れてしまう。この id が到達するのは今のところ
`McpErrorInfo.correlation_id` のみで、`compose_with_fixation` / `ComposeOptions` にはまだ相関 id パラメータが
無い(その修正には `host_core`/`composer` に触る必要がありスコープ外)ため、TS の対応物が
`ComposeTrace.correlationId` にも到達するのとは異なる。ツール呼び出しの `_meta.traceparent`
(+ `_meta.tracestate`)は、整形式であれば別途 `TraceContext`(`kohaku.host_core.trace_context`。TS の
`packages/host-core/src/trace-context.ts` をそのまま移植したもの — 全ゼロの trace-id/parent-id の拒否や
`tracestate` の W3C 推奨 512 文字上限も含む。`host_rest` は同等の `traceparent` / `tracestate` リクエストヘッダ
を読む)として解析され、同じ理由で `McpErrorInfo.trace_context` / `HostErrorInfo.trace_context` にのみ現れ
`ComposeTrace` へは到達しない。トレースの相関はこの `TraceContext` だけが担い、相関 id がその役目を兼ねることは
無い。OTel SDK 自体(スパン生成・エクスポート、`@kohaku-ui/otel`)は TS のみで、この移植の対象外である。さらに
`host_mcp` は `tools/list`・`resources/list`・**そして `resources/read` にも** `ttl_ms`/`cache_scope`
(SEP-2549)を設定する — `mcp` 2.x の `ReadResourceResult` が `CacheableResult` を基底クラスとして得た(1.x で
は持っていなかった)ことで、本ファイルがかつて TS のみと記していたギャップが解消された。これらのフィールドが
配線上に現れるのは 2026-07-28 以降でネゴシエートした接続に限られる(mcp SDK 自身の結果シリアライザが古いプロ
トコルバージョンではそれらを篩い落とす)ため、`kohaku/tests/host_mcp` のキャッシュヒントテストは
`mode="2026-07-28"` で接続している。

Python サンプル(`examples/sales-api`)はシード JSON をリポジトリルートの `apps/sample-api/src/domain/seed` から直読みする(データ二重管理を避けるため)。したがって `python/` サブツリー単独ではなく**フル monorepo チェックアウト**が前提。

**`storage/` の `FileStoragePort` の永続性契約**: これは参照実装・デモ用の `StoragePort` 実装であり、本番向けストレージバックエンドではない。書き込みは OS のページキャッシュを通すのみで、このモジュールには **`fsync` が一切無い**。tmp→rename のパターンにより読み手が書きかけの不完全なファイルを見ることはない(プロセスクラッシュへの耐性)が、rename 後のバイト列が実際にディスクへ到達していることまでは保証されない(電源断・カーネルパニック等では失われ得る)。**単一プロセス前提**でもある: 同一スナップショットファイルへの並行 read-modify-write はプロセス内でのみ直列化される(パスごとの `asyncio.Lock`。TS の `createKeyedMutex` に相当)ため、同じ `data_dir` を指す 2 プロセスは依然として競合し更新を失い得る。本番投入時は、真の永続性・プロセス間の並行安全性・lineage のローテーション/圧縮を備えた DB バックエンドの `StoragePort` 実装に置き換えること。詳細は `kohaku.storage.file` のモジュール docstring を参照。

## クロス言語互換の守り方

- **golden fixture**: `spec/test/fixtures/cross-language-canonical.json` を TS
  (`spec/test/cross-language.test.ts`)と Python
  (`kohaku/tests/spec/test_cross_language_golden.py`)の両方が検証する。
  再生成は `pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures`(TS が正)。
- **core カタログ**: `pnpm --filter @kohaku-ui/registry run export-core-catalog` が
  `kohaku/src/kohaku/registry/_data/core-catalog.json` を emit(CI がドリフト検査)。
  fingerprint(fnv1a64)は TS と同値でキャッシュキーが言語間で一致する。
- **canonical JSON**: JS `JSON.stringify` とバイト互換(ES の数値表記・array index キーの
  数値昇順優先・UTF-16 コードユニット順ソート・孤立サロゲートのエスケープまで再現)。
  実装は `kohaku/src/kohaku/spec/canonical_json.py`。
- **conformance**: CI の `conformance-python` ジョブが Python ホストを起動して
  TS 側 CLI の黒箱検査を実行する。

## 蒸留データセットの書き出し

`kohaku.evals.export_distillation_dataset` は、人間が承認済みの `FixationRecord` 群(任意で
golden regression Spec を追加可能)を JSONL 蒸留データセットに変換する — 1 行 1 Spec の
canonical JSON で、TS 実装の `exportDistillationDataset`(`@kohaku-ui/evals`)とバイト同一に
なる(全フィールドの内訳は `docs/design.md` の蒸留データセットの段落を参照)。

```python
from kohaku.evals import export_distillation_dataset
from kohaku.spec import FixationRecord

fixations: list[FixationRecord] = [...]  # 例: fixations.json スナップショットから読み込む
jsonl = export_distillation_dataset(
    fixations,
    golden=None,  # 任意: 補助教師データとしての golden regression Spec
    tenant="tenant-a",  # 任意: このテナントの fixation だけに絞り込む
)
with open("dataset.jsonl", "w", encoding="utf-8") as f:
    f.write(jsonl)
```

各行は `{intent, refs, shape?, target: {components, events}, source: "fixation"|"golden",
meta}`。`"fixation"` 行では、レコードが持っていれば `meta` に `tenant` / `catalogFingerprint`
も入り、レコードがその項目より前に作られたものであれば `null` としてではなくキーごと省かれる
— JS 側が `undefined` のキーを `JSON.stringify` で落とすのと同じ挙動にして、バイト同一を保つ
ため。Python 側に対応する CLI は無く、TS 側の `kohaku dataset export`(`cli/bin/kohaku.js`)
がファイルベースの既製エントリポイントとして使える(ワイヤ形式が同一なのでどちらの言語の
fixation に対しても動く)。

## opt-in のプロンプトキャッシュ / `refConstraint`(TS と対称)

kohaku のスキーマ段階の `data.$ref` 偽造防止(TS `docs/design.md` §13 の決定 #4)とプロバイダ側の
構造化出力文法キャッシュとの間のトレードオフに対する、独立した 2 つの opt-in の逃げ道を対称に実装している(両方とも既定 off):

- `KOHAKU_LLM_PROMPT_CACHE=1` は `claude` プロバイダを Anthropic プロンプトキャッシュに opt-in させる
  (`kohaku.llm.env.LlmConfig.prompt_cache`。`anthropic_native.py` の `_user_content` が user メッセージを
  2 つの content block に分割し、先頭に `cache_control: {"type": "ephemeral"}` を付ける — 他プロバイダ、
  または呼び出し側が `PromptParts` を渡さない場合は no-op)。
- `ComposePolicy.refConstraint: "schema" | "validate"`(既定 `"schema"`。不変)は `"validate"` で L1
  生成スキーマの `data.$ref` をプレーンな文字列に緩和し(`kohaku.composer.l1_generate` の
  `build_l1_generation_schema`)、代わりに生成後に明示的に集合所属を検証して `DATA_REF_UNRESOLVED` の
  所見を既存の修復ループへ送り返す。

トレードオフの全体と、どちらかを有効にする価値があるか判断するための計測スクリプト
(`apps/sample-api/scripts/measure-grammar-latency.ts`)は、TS の `docs/design.ja.md#prompt-caching`
を参照。

## 推論エフォート / ティアごとの LLM(TS と対称)

TS 側と完全対称な、追加的(additive)な opt-in ノブが 2 つある(両方とも既定 off/未設定。どちらに
触れなくても既存の cacheKey はバイト単位で変わらない):

- **`ComposePolicy.effort: EffortPolicy(l1=..., l2=...)`** は Adaptive Reasoning のエフォート
  レベル(`kohaku.llm.LlmEffort` — `"low" | "medium" | "high" | "xhigh" | "max"`)を L1
  (`l1_generate.py`)と L2(`l2_generate.py`)の生成呼び出しへ、それぞれ独立に
  `GenerateObjectRequest`/`GenerateTextRequest.effort` として渡す。プロバイダごとのアダプタでの
  配線: `claude` は `output_config={"effort": ...}` を送る(インストール済みの `anthropic` SDK の
  `OutputConfigParam` を確認済み — `anthropic_native.py` の `_output_config_params`)。
  `openai`/`ollama`/`llama`(共有の `openai_compat.py` アダプタ)は chat.completions ボディの
  トップレベルに `reasoning_effort` を送る(`@ai-sdk/openai` / `@ai-sdk/openai-compatible` 自身の
  リクエスト構築コードが同じワイヤフィールドを書くことを確認済み)。`gemini` はインストール済みの
  `google-genai` SDK に対応するオプションが無く、黙って無視される。エフォート制御を実装しない
  ポート(`FakeLlm`)はこのフィールドを無視する。`ComposePolicy.effort` が設定されている限り
  `policy_fingerprint` に参加する(上記 `refConstraint` と同じ契約)。
- **`ComposeContext.llmByTier: TierLlm(L1=..., L2=...)`** は基底の `llm` をティアごとに上書きする
  (`resolve_tier_llm`。`l1_generate.py`/`l2_generate.py` から呼ばれる)。上記の蒸留データセットが
  まさに狙う L1 の制約付き生成タスク向けに小さなファインチューン済みモデルを L1 にだけ差し込みつつ
  L2 は大きなモデルのままにする、あるいはその逆ができる。`TierLlmFingerprintMaterial`
  (`tier_llm_fingerprint_material`)が解決済みのティアポートの `{provider, model_id}` を
  `policy_fingerprint` の第 2 引数へ畳み込むが、**設定されたティアのモデルが基底 `llm` と実際に
  異なる場合に限る** — 基底モデルと一致する上書きは何も変えない。
- **TS 側 WP2 から持ち越したバグ修正**: L2 の `TierResult.model`(`ComposeTrace` に現れる)は、
  無条件に基底 `llm` のものではなく、*解決済みの*ティアポートの `model_id` を読むようになった —
  `generate_text` の結果自体には `model` フィールドが無いため、`l2_generate.py` は以前から呼び出し
  ポート自身の `model_id` を代用していたが、`llmByTier.L2` が使われている場合でもそれは以前は基底
  ポートのままだった。
- **`DEFAULT_MODELS["claude"]`**(`kohaku.llm.env`)は TS の `env.ts` に合わせて
  `"claude-sonnet-4-6"` から `"claude-sonnet-5"` へ変更。モデル id は `default_generator_version`
  の一部なので、`KOHAKU_LLM_MODEL` を一度も設定していない運用者にとっては*既定*の cacheKey が変わる。
  `openai`/`gemini`/`ollama`/`llama` の既定値は変更していない。

## compose 全体のウォールクロック期限(TS と対称。in-flight abort を含む)

`ComposeBudget.deadline_ms`(`per_compose_stop_after_tokens` の兄弟)は、`compose`/`compose_stream` の
1 回の呼び出し全体のウォールクロック時間を、compose 開始からの経過ミリ秒で上限を設ける。未設定(既定)
はこのフィールドが存在する前とバイト単位で同一 — タイマーは組まれず、追加のクロック読み取りも無く、
LLM 呼び出しに渡される abort シグナルは `ComposeOptions.abort` そのままになる。

Python の `kohaku.llm.abort` モジュールは既に Web の `AbortSignal`/`AbortController` の表面
(`AbortSignal.timeout` / `AbortSignal.any`。`adapters/_base.py` 全体で使用)を再実装しているため、
この機能は**忠実さを失わずに**移植できた — TS 設計の両方の半分がそのまま持ち越されている:

- **呼び出し間での強制**: `check_budget` はオプションの `elapsed_ms` パラメータを新たに受け取るように
  なった(依然として純粋関数のまま — 呼び出し側が経過時間を渡し、`check_budget` 自身はクロックを読まない)。
  `per_compose_stop_after_tokens` の直後・`check()` フックの直前でチェックされ、トークン閾値の理由と
  区別できる `"...deadline...ms reached..."` という理由文字列を返す。
- **in-flight での強制**: `create_deadline_guard(budget, started_at, caller_signal, now=None)`
  (`budget.py`)が compose 1 回につき 1 回だけ `AbortSignal.timeout(remaining_ms)` を組み(`compose.py`
  の `_run_tier_generation` の中で、初回 L1 呼び出し・すべての修復再試行・L2 で共有)、呼び出し側自身の
  シグナルと `AbortSignal.any` で合成する。これにより、期限が経過した時点で in-flight の呼び出しが実際に
  中断される — 次の呼び出しの開始を単に防ぐだけではない。
- **分類の機微もそのまま持ち越されている**: `create_deadline_guard` は、他の何によっても発火しない、
  より狭い第 2 のシグナル `deadline_signal` を返す。`generate_l1`/`generate_l2` は `ABORTED` の `LlmError`
  を catch した時点で `deadline_signal.aborted` を調べ、`"aborted"` ではなく `failure="budget"`(呼び出し間
  スキップと*同じ*分類。`budgetReason` 付き)として分類する — そのため結果として生じるフォールバックは
  `budgetExceeded=True` となり `trace.cancelled` は**付かない**。一方、呼び出し側自身の `AbortSignal` が
  発火した場合は、以前と全く同じく cancelled として分類される。これがこの機能の核心(運用者が設定した
  期限は generation-fallback レートに算入されるべきだが、クライアント切断はそうではない)であり、Python と
  TS の実装は `kohaku/tests/composer/test_deadline.py`(TS の `deadline.test.ts` の pytest 移植。
  in-flight abort と cancellation の区別のテストを含む)のすべてのケースで一致している。
- **内部的(ワイヤ非露出)な単位の適応が 1 点**: `PreparedCompose.started_at` は既に(TS の `Date.now()`
  ミリ秒ではなく)`time.monotonic()` 秒を使っているため、`create_deadline_guard` の `started_at`/`now`
  もその単位に合わせている — `ComposeBudget.deadline_ms` 自体だけはミリ秒のまま(フィールド名と TS の
  意味に一致)。これは呼び出し側からは見えない差異で、ガード内部の `remaining_ms` の計算方法にのみ影響する。
- タイマーの後始末(`_run_tier_generation` の `finally` で dispose)は TS の `runTierGeneration` と一致。

## TS 実装との既知の差異(意図的・恒久)

- **JS 検証は Node サイドカーへ委譲(スタンドアロン時のみスキップ)**: L2 契約 lint の
  `L2_SCRIPT_SYNTAX`(JS 構文検査)と `ComposePolicy.l2Smoke`(配信前スモーク検証)は、
  リポジトリ同梱の TS CLI(`kohaku smoke-l2`)へのサブプロセス委譲で提供する
  (`kohaku.composer.create_l2_js_sidecar`。sales-api は Node 併設検出で既定オン・
  `KOHAKU_L2_JS=off` で無効化)。検証ロジックは TS 側が単一の正で、二重実装しない。
  **Node 非併設のスタンドアロン配備では従来どおり fail-open スキップ**(仕様の
  「動的コード生成不可の環境ではスキップ」規定)。構文検査の注入点は Python 固有の
  `ComposePolicy.l2ScriptSyntax`(TS では組み込みのため対応フィールドなし)。
- **ストリーミング(`stream_object`)の言語適応**: TS の `streamObject?`(optional メソッド +
  交差型)は Python に対応構文が無いため、`StreamingLlmPort`(別 Protocol)+ `supports_streaming()`
  TypeGuard で optional を表し、`on_partial` はリクエスト合成でなく**第 2 引数**で受ける。
  契約(累積 partial・best-effort・例外握り)とワイヤ挙動は TS と同一。
- **`BindingClient.resolve` は raw payload(JsonObject)を返す**(TS は structural TabularData)。
  Python の `TabularData`(pydantic)は dataVersion が必須で、SPEC が SHOULD(省略可)とする
  客体境界の寛容さを表現できないため。浅い形状検査・STALE 突合ロジックは TS と同一。
- LLM アダプタの実装手段: TS は Vercel AI SDK 経由、Python は各社 SDK / httpx 直叩き
  (openai 互換 = httpx、claude = `anthropic` SDK(`>=1.0`)の強制 tool-use に `strict: true`
  を付けた strict tool use、gemini = google-genai の response_json_schema)。**挙動
  (フォールバック判定・リトライ・エラー分類)は同一**で、差異は実装手段のみ。Anthropic の
  構造化出力の JSON Schema サブセットは、レジストリの生成スキーマに含まれ得るいくつかの
  キーワード(`minLength` / `maxLength` / `pattern` / `minimum` / `maximum` / `multipleOf`
  / 0・1 を超える `minItems` / `maxItems` / `uniqueItems` / 再帰 `$ref`)を拒否し、
  `additionalProperties: false` を要求する。`anthropic_native.py` の
  `_sanitize_for_anthropic` が送信前にこれらの非対応キーワードを除去し、各制約を英語で
  そのノードの `description` に退避する(`@ai-sdk/anthropic` の `sanitizeJsonSchema` と
  同じ変換であり、TS と Python の両アダプタは同じスキーマに対して同じ劣化のしかたをする)。
  返ってきたオブジェクトの検証は、退避前の元のスキーマに対して行われる。
- 内部 API(ワイヤに出ない関数・メソッド)は Python 慣習の snake_case。ワイヤ形状
  (JSON キー・エンドポイント・_meta キー)は TS と完全一致。

> 2026-07-18 更新(解消済みの旧差異): ①昇格のテナント別 reconcile 最小実装 → sales-api に
> PromotedRegistry / 投影 / 起動時 reconcile を完全移植 ②compose ストリーミングの暫定 patch
> (0..N)→ TS とパリティ化 ③LLM アダプタ「OpenAI 互換のみ」→ claude / gemini ネイティブ
> アダプタを追加(`uv sync --package kohaku-ui --extra claude` / `--extra gemini`)④semver レンジ部分実装
> → node-semver 準拠に完全化(比較演算子・空白 AND・`||` OR・hyphen・x-range・tilde/caret・
> prerelease 除外規則。build metadata は比較で無視。不正レンジは fail-closed)⑤BindingClient
> 未移植 → `kohaku.data_binding.create_binding_client` として移植(既定 HTTP フェッチャは
> httpx・optional)⑥クライアント切断の中断伝播 → 配線済み(`request.is_disconnected()`
> の ~250ms ポーリング → AbortSignal → single-flight 中断投票 = TS 実装と対称)⑦lineage の id
> → uuid4 hex から TS と同じ ULID(自前実装・Crockford Base32 26 文字)に変更し、監査の
> 時系列並び(辞書順)が言語間で一致。
