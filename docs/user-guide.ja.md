# kohaku ユーザーガイド

[English](user-guide.md) | 日本語

| 項目 | 内容 |
|---|---|
| 最終更新 | 2026-09-11 |
| 対象 | ① サンプルアプリを動かして概念を体験したい人 ② 自分のプロダクトに kohaku を組み込みたい人 |
| 関連 | 仕組みの解説は [design.ja.md](design.ja.md)、API の詳細は [specification.ja.md](specification.ja.md) |

---

## 1. これは何か

kohaku は「自然言語の質問」と「GUI の絞り込み操作」を**同じ正規化 Intent に合流**させ、**同じ宣言的 UI Spec** を生成して、**同じレンダラー**で描画するフレームワークです。サンプルとして売上分析アプリ(API + Web + MCP サーバー)が同梱されています。

体験できる核心は 4 つ:

1. チャットで聞いても GUI で絞り込んでも**同一の画面**が出る(R5)
2. UI Spec には**データが載らない**(参照渡し。LLM は数値を扱わない)
3. カタログ外の要求は**サンドボックス**で自由生成され(L2)、レビューを通って**正式な部品に昇格**する(L1)
4. 頻出の画面は**固定化**され LLM を一切通らなくなる(L0)

## 2. セットアップ

前提: Node >= 22、pnpm 12(`npm i -g pnpm`)。下限要件は `package.json` の `engines`(`node >= 22`)で、GitHub Actions CI はテストと型検査のジョブを、宣言下限である Node 22 と Active LTS の Node 24 の両方で実行します(conformance ジョブと Python ジョブは Node 24)。`.node-version`(現在 25.7.0)はローカル開発環境用のバージョン指定(nodenv などが読む)で、CI が使う版とは意図的に別です — 下限さえ満たしていればどの版でも動きます。バージョンマネージャがそのバージョンを持っておらず「version not installed」等で失敗する場合は、そのバージョンをインストールする(例: `nodenv install 25.7.0` / `fnm install 25.7.0`)か、手元にある Node >= 22 をそのまま使ってください — この固定はあえてそのままにしている仕様で、直すべきバグではありません。pnpm のバージョンは `package.json` の `packageManager` で固定しています。

```bash
git clone https://github.com/yosuque/kohaku.git && cd kohaku
cp .env.example .env     # ↓の表から LLM を設定
pnpm install
pnpm seed                # (任意)売上シードを作り直すときだけ(生成物は git 管理下・決定的 576 件。dev は無くても動く)
pnpm dev                 # API :8787 + Web :5173
```

→ http://localhost:5173 を開く。ヘッダー右上に `LLM: <provider> / <model> ●` が出ていれば API と接続できています。

### LLM プロバイダの選択

`.env` の設定例:

| 使いたいもの | 設定 |
|---|---|
| Claude(既定) | `KOHAKU_LLM_PROVIDER=claude` + `ANTHROPIC_API_KEY=sk-…` |
| OpenAI | `KOHAKU_LLM_PROVIDER=openai` + `OPENAI_API_KEY=…` |
| Gemini | `KOHAKU_LLM_PROVIDER=gemini` + `GOOGLE_GENERATIVE_AI_API_KEY=…` |
| **Ollama(キー不要・ローカル)** | `KOHAKU_LLM_PROVIDER=ollama` + `KOHAKU_LLM_MODEL=gemma4:e4b` 等(モデル未指定時の既定は `llama3.3`) |
| llama.cpp / vLLM 等 | `KOHAKU_LLM_PROVIDER=llama` + `KOHAKU_LLM_BASE_URL=http://…/v1` + `KOHAKU_LLM_MODEL=…` |

> **Ollama の注意**: 非思考(non-reasoning)のインストラクトモデルを推奨します。思考モデル(qwen3.5 等)は推論で出力トークンを使い切り、UI 合成が遅い・空になることがあります。また llama.cpp 系は大きなスキーマの構造化出力が不安定なことがありますが、既定の `KOHAKU_LLM_STRUCTURED_MODE=auto` が自動でプロンプト JSON 方式にフォールバックします。

> **LLM なしで試す**: キーを設定しなくても Dashboard の定番 4 ビュー(L0 固定)は完全動作します。LLM が必要なのは Chat の自然言語と、推移/製品ランキング(L1)・自由要求(L2)です。

### 非 React レンダラーの実演(Web Components / React ゼロ)

同一の UI Spec を **React を一切使わない** `<kohaku-surface>`(Custom Elements + Shadow DOM)で描画する実演ページ(`apps/sample-wc`)です。「宣言的 UI Spec はレンダラー非依存」を、React 版(sample-web)と同じ Spec を別レンダラーで描いて示します。ルートの `pnpm dev` には混ぜていないので、独立起動します(別ターミナル):

```bash
pnpm --filter @kohaku-ui-sample/api dev   # ホスト(:8787)。上の pnpm dev を起動中ならそのままでよい
pnpm --filter @kohaku-ui-sample/wc dev    # 実演ページ(:5174。/api は :8787 にプロキシ)
```

→ http://localhost:5174 を開く。地域セレクトの変更は compose 往復なしのクライアント再解決(A1 クロスフィルタ)、表の行クリックは `/events` でサーバー再合成に流れます。LLM は不要(quarterly_summary は決定的な固定 Spec 経路)。詳細は `apps/sample-wc/README.md`。

### Python 実装のサンプルを動かす(バックエンド言語非依存の実証)

同じプロトコル(Kohaku Protocol v0.1)の **Python フル移植**(`python/kohaku`。REST は FastAPI・MCP は MCP Apps プロファイル)も同梱されています。TS 実装とワイヤ互換で、conformance は CONFORMANT。「Web と MCP で同じ UI」がバックエンド言語に依らないことの実証です。前提は Python 3.12+ + [uv](https://docs.astral.sh/uv/)。

```bash
cd python
uv sync                             # 依存インストール(uv workspace)
uv run python -m sales_api          # Python サンプル REST ホスト(:8790。既定は決定的擬似 LLM = キー不要)
```

> **TS サンプルと異なり、Python サンプルはリポジトリ直下の `.env` を読みません**(`sales_api/__main__.py` に `.env` 読み込み処理はありません)。シェルの環境変数か、下の ollama 例のようにコマンド行内で指定してください。

- 既定は決定的な擬似 LLM(`KOHAKU_LLM_PROVIDER=fake`)なので、**LLM のキーなしで全経路が動きます**。実 LLM(ローカル ollama)で動かすなら `KOHAKU_LLM_PROVIDER=ollama KOHAKU_LLM_MODEL=gemma4:e4b uv run python -m sales_api`。
- 起動後、TS 側 CLI の黒箱検査を**リポジトリルートで**当てられます(この CLI は tsx 経由で TS 実装を実行するため、ルートで `pnpm install` 済みであること):

  ```bash
  node cli/bin/kohaku.js conformance --rest http://localhost:8790/api/kohaku
  ```

- MCP サーバーは stdio(`uv run python -m sales_api.mcp_main`。Claude Desktop 等)と Streamable HTTP(`uv run python -m sales_api.mcp_http`、:8791。claude.ai / ChatGPT へは公開トンネル経由・認証なしデモ)の 2 エントリ。`ui://` リソースは TS 側ビルドの共有レンダラーを配信します(未ビルドならプレースホルダ。先に `pnpm --filter @kohaku-ui-sample/mcp build:renderer`)。TS サンプルと同じく固定化短絡・lineage 記録・書き込み副作用宣言・`KOHAKU_MCP_LEGACY_UI=1` の opt-in も配線済みです。
- 永続化ディレクトリは環境変数 `KOHAKU_DATA_DIR` で差し替えられます: TS sample-api、Python の両エントリ(REST・MCP〈stdio + Streamable HTTP〉)がすべて対応しています。唯一の例外は `sample-mcp`(TS)で、常に `apps/sample-api/.data` 相対の固定パスを使い、この変数を読みません。セットアップ・検証・TS との既知の差異は [../python/README.ja.md](../python/README.ja.md) を参照してください。

## 3. 画面の歩き方

> **表示言語について**: デモは**英語が既定**です。ヘッダーの **EN/JA トグル**で **JA** を選ぶと sample-web アプリ全体が切り替わります: ページクローム(ナビ・チャット・管理)、Spec レンダラーのメッセージと書式ロケール(`RendererProvider.messages` / `locale`)、ダッシュボードのファセットラベル(`facet-views.json` に焼き込まれた二言語オーバーレイ)、**そして生成内容そのもの** — トグルはすべての API 呼び出しに `session.locale` を載せ、サーバーがセッションごとの `ComposePolicy` を選択します(JA は `outputLanguage: "Japanese"` と日本語の L0 固定スペックを持ち、`/ja` の generatorVersion トークンでキャッシュが言語別に分離されます)。ダッシュボードはトグルで再 compose され、チャットの既存バブルは生成時の言語のまま残ります(次の質問から新言語)。既知の制限: チャート/表内のデータセル値(地域・チャネル名)は英語のまま(`query://` の結果は不変条件として言語中立)で、DomainPort 由来の列見出し・KPI ラベル・KPI 注記(例:「Total revenue」「Revenue (JPY)」「No target set」)も同様に英語です — これら DomainPort 由来ラベルの二言語化は将来課題です。EN トラフィックから固定化された Spec は JA セッションには配信されません(通常 compose に落ちます)。sample-wc は従来どおり `?lang=ja` でレンダラーメッセージのみ切り替えます。

### Dashboard(GUI サーフェス)

左のパネルで**ビュー**(= 正規化 Intent)を選び、**絞り込み**(年度・四半期・地域・集計軸)を変えると、その都度 GuiAction → 正規化 Intent → compose が走って画面が組み上がります。

- 上部の **ProvenanceBadge** が「なぜこの画面が出たか」: tier(L0=青 / L1=緑 / L2=橙)、cache(HIT/MISS/FIXATED)、intentHash(クリックでコピー)、モデル、データ版。
- 「Spec JSON を表示」で生の UI Spec を確認できます。`data` に `$ref` しかないことに注目してください。
- URL に Intent が同期されるので、リロード・共有・「チャットから開く」が成立します。
- **「Records」ビューの「Add a note」ボタン**は書き込みループの実演です。確認ダイアログ(`overlay.dialog`)の開閉は `$state` + `emit:"state.set"` + `visibleWhen` の**宣言だけ**で成立し(フォーカストラップ・起動元へのフォーカス返還つき)、注記の送信は `presentForm` → API 直結(capability token 付き・LLM 非経由)で、**下の表だけが Spec 差し替えなしで最新版を取り直します**(小ループ)。手順はデモ 5 を参照してください。

> **上部バーの「Tenant」セレクタ**(default / tenant-a / tenant-b)は全ページ共通です。選択は全 API 呼び出しに `x-kohaku-tenant` として載り、統制/監査プレーン(Lineage・昇格・固定化)がテナントで分離されます。生成結果(Spec)はテナント非依存 — 切り替えても Dashboard の表示は変わりません(§6.1 の不変条件: query:// 参照はテナント中立でキャッシュキーに tenant を混ぜない)。

> **上部バーの「Role」セレクタ**(admin / reviewer / viewer)も全ページ共通です。選択は全 API 呼び出しに `x-kohaku-role` として載り、サーバー側の宣言的 RBAC(`createGovernancePolicy`)が統制ルートの認可を分岐します。`admin` は全許可、`reviewer` は昇格レビュー + Lineage 閲覧、`viewer` は読み取りのみ。**`viewer` に切り替えると Admin の承認・削除系操作が 403 になり、赤いエラーバナーが出ます**。`admin`(既定)ではヘッダを送らず、従来どおり全操作が通ります。ロールはデモ用のヘッダで代替していますが、実運用では認証基盤(JWT/OIDC 等)から解決するのがプロダクト責務です。

> **上部バーの「☀️ Light / 🌙 Dark」トグル**でテーマモードを切り替えられます。初期値は OS の `prefers-color-scheme` に連動し、明示的に選ぶと `localStorage` に永続化されます。**部品(Spec が描画する KPI・チャート・表・フォーム)はテーマトークンで、ページ chrome(ヘッダ・カード・背景・Admin)は CSS 変数で追従**します。ダーク配色は WCAG AA(本文 ≥ 4.5:1 / UI ≥ 3:1)を満たすよう実測調整しています。同じモードなら Web(React)と Web Components(sample-wc)の描画はピクセル一致します(§7.2)。

### Chat(NLUI サーフェス)

自然言語で質問すると、まず**正規化チップ**(canonical / params / hash)が表示され、それから同じ Composition Service で画面が合成されます。Dashboard と同じ内容の質問ならハッシュが一致し `cache:HIT` になります。「ダッシュボードで開く →」リンクで同一表示を追体験できます。

生成が遅い経路(L1 の初回など)ではローディングのスケルトンが即時に出て、**LLM の部分出力から部品が揃った順に逐次描画**されます(逐次ストリーミング。プロバイダがネイティブ構造化出力ストリームに対応するときのみ — プロンプト JSON フォールバック時はスケルトン → 確定形の 2 段になります)。

### Admin(統制面)

- **View Lineage**: UI Spec の Event Sourcing。全 compose / 操作 / 昇格 / 固定化がイベント列で見えます。
- **分析**: 生イベント列を集計した俯瞰(`GET /api/kohaku/analytics/summary`)。fallback 率・tier 分布(L0/L1/L2)・cache 内訳(hit/miss/bypass/fixated)・レイテンシ分位(p50/p95/p99)・頻出 intent 上位・昇格/固定化イベント数を、表 + インラインバーで表示します。**集計は直近 200 件(既定)の窓に基づく**旨を画面上部に明記し、窓上限に到達した場合はその注記も出ます(silent cap にしない)。認可は read 系(`analytics.read`)なので admin/reviewer/viewer とも閲覧できます。
- **昇格レビュー(L2→L1)**: 自由生成部品の候補一覧。HTML ソース確認 + **「▶ プレビュー」でレビュー対象そのものを実描画**(チャット面と同じ隔離 iframe に記録済み artifact を直接マウント — 承認対象と表示物の同一性は sha256 で保証)→ スキーマ(componentType / intentName / description)を確定 → 「承認して登録」。**上部の `status` セレクタで状態別に絞れます**(「すべて」は候補を掘り起こす `POST /promotions/evaluate`、特定の状態は読み取り専用の `GET /promotions?status=`)。候補カードの**「変更を要求(差し戻し)」で `changes_requested` に落とし**、修正のうえ**「再申請して承認」で candidate に戻して publish まで復帰**できます(差し戻しからの復帰導線)。`changes_requested` では却下は出さず、放棄は「取り下げる(withdraw)」に一本化しています。
- **固定化(L1→L0)**: 頻出 L1 Intent の候補(利用回数・構造安定度)→ 「L0 に固定化」。
- 「データ更新を模擬(bump)」: dataVersion を進めてキャッシュ無効化を再現します。
- 4 タブとも上部バーで選択中の**テナント**でスコープされます(切り替えると各一覧が再取得され、テナント別に分離されていることが見えます)。分析タブの集計も選択テナントのイベントのみが対象です。
- ロールを `viewer` にすると、承認・削除系の操作に加えて**昇格候補のプレビューも 403** になります(データ read capability の発行を伴うため。閲覧は可能)。RBAC の一連の動きはデモ 7 を参照してください。

## 4. デモウォークスルー(8 本)

### デモ 1 — 同内容のリクエスト → 同一表示(R5)

1. Dashboard: 「Quarterly Summary」+ FY2026 / Q3 / By region → バッジは `L0 cache:MISS`、intentHash は `13ea0aa…`
2. Chat: 「**FY2026 Q3 sales by region as a chart**」(日本語「2026年度Q3の地域別売上をグラフで」でも同じく正規化される)→ 正規化チップのハッシュが **`#13ea0aa…` で一致**し、`cache:HIT`。チャートも表も Dashboard と同一(同じ Spec・同じレンダラー・同じテーマトークン)
3. Admin → View Lineage: 同一 intentHash の `view.composed` が `web` と `chat` の両サーフェスで並ぶ
4. Admin → bump → Dashboard を再操作 → `MISS` に戻る(キャッシュキー = intent + dataVersion)

### デモ 2 — 参照渡し(配管と水)

1. 任意のビューで「Spec JSON を表示」→ 数値が 1 つもないことを確認
2. DevTools → Network → `/binding/resolve` リクエストに `Authorization: Bearer …` と数百行のレスポンス
3. capability なしの直接アクセスは 401:
   ```bash
   node -e "fetch('http://localhost:8787/api/kohaku/binding/resolve?ref=query%3A%2F%2Fsales%2Fsummary%3Ffy%3D2026%26groupBy%3Dregion%26q%3D3').then(r=>console.log(r.status))"
   ```

### デモ 3 — L2 自由生成 → 昇格(このフレームワークの真骨頂)

> **カスタム部品が画面に出る経路は 2 つ**あります。カタログ登録済みの**寄与部品**(`CatalogContribution` の `sales.kpiCard`)は「**List the KPIs**」等の既知 Intent(`sales.kpi_overview`)の画面に普通に現れます(カタログに合流するので L1 生成でも LLM の選択候補になります)。このデモで実演するのはもう 1 つの、**カタログに無い部品がその場で作られる** L2 経路です。入口の条件は「**既知のどの Intent にも当てはまらない可視化要求**」であること — NL 正規化(SemanticPort)が受け皿 Intent `sales.custom` に倒して元の要求文を `params.request` に保持し、`routeTier` が L1 をスキップして L2 へ直行させます。「**Show monthly sales as a waterfall chart**」(日本語「月次売上をウォーターフォールで見たい」でも同様)も同様に L2 に入ります。逆に「FY2026 Q3 sales by region as a chart」は既知 Intent に載るため L0/L1 + コア部品になり、L2 には入りません。

1. Chat: 「**Sales as a calendar heatmap**」(日本語「売上をカレンダーヒートマップで」でも同様)→ カタログにない要求なので `sales.custom` → **L2(橙)**。生成 HTML がネットワーク遮断の iframe で動き、データは親ブリッジ経由で取得される(配信前に静的 lint + **サーバー側スモーク検証** — jsdom 上で実行して ready 到達を確認 — を通過したものだけが届き、不合格は自動修復ループに差し戻されます)
2. もう一度同じ質問(別の言い回しでも `sales.custom` に正規化されれば OK)→ 利用 2 回で昇格候補の閾値(デモ設定)を満たす
3. Admin → 昇格レビュー: 候補カードの **「▶ プレビュー(隔離 iframe で実描画)」で見た目と動作を確認**し、「生成 HTML ソース」でコードも確認 → componentType `sales.calendarHeatmap` / intentName `sales.calendar_heatmap`(ヒートマップ要求ならプリフィル済み)→ **「承認して登録」**(プレビューは `viewer` ロールでは 403 — データ read capability の発行を伴うため)
   - 裏で LLM-as-Judge(5 観点)→ 人間承認(このクリック)→ スキーマ確定 → publish が走り、各ステップが Lineage に残ります
4. Chat で同じ質問 → 今度は `sales.calendar_heatmap` に正規化され **L1(緑)+ ネイティブ実装**で描画。**API を再起動しても昇格は残ります**: スナップショット(`apps/sample-api/.data/promotions.json`)が正であり、起動時の reconcile がそこからカタログ/Intent への射影を再構築します
5. 同じ「作成」は外部チャット(MCP)からも起こせます(→ §5)。`kohaku_compose` 経由の利用も同じ昇格カウンタに合算されます(反映は API サーバー再起動後 → §5)

### デモ 4 — インタラクションループと固定化

1. Quarterly Summary の表で「Japan」行をクリック → `intent.patch` → 「Japan × By product」ビューに差し替わる(Lineage に `view.interacted`)
2. 「Trend」ビュー(L1)を 3 回以上表示 → Admin → 固定化に候補(構造安定度 100%)→ 承認 → 以後は **`L0 cache:FIXATED`**(LLM 不通過、構造固定、データは参照渡しで常に最新)

### デモ 5 — 書き込みループ(小ループ = 表だけ in-place 更新)

1. Dashboard: 左パネルで **「Records」ビュー**を選ぶ → 表の上に **「Add a note」ボタン**が出る → 押すと確認ダイアログ(`overlay.dialog`)が開き、中に注記フォームが出る(開閉は `state.set` + `visibleWhen` の宣言だけ)
2. 注記(例「Check North America's growth」)を入力 → **「Save」**。DevTools → Network に `/binding/action`(`Authorization: Bearer …`、ボディ `{action:"annotate", payload:{note, refs}}`)が 1 本
3. **Spec は差し替わらず**、下の表だけが `/binding/resolve` を新しいデータ版で叩き直す(バッジのデータ版が進む)。ページ上部に完了バナー
4. 書き込みは部品 → API 直結で、**LLM のコンテキストには一切流れません**(生成する LLM は「配管」、書き込むデータは「水」)。compose が返す capability が read($ref)だけでなく宣言された write(`annotate`)も覆うので、追加のトークン発行なしで発火します

### デモ 6 — テナント分離(統制プレーン)

1. 上部バーの**テナント**を `tenant-a` に切り替える
2. Dashboard / Chat をいくつか操作 → Admin → View Lineage: `tenant-a` の分だけが並ぶ
3. テナントを `tenant-b` に切り替える → 同じ Admin タブが**空**(または別集合)になる = 昇格候補・固定化・Lineage がテナントで分離されている
4. `default`(未指定)に戻すと従来どおり全件(ヘッダなし = 単一テナント相当)。**Dashboard の表示自体は切替で変わりません** — 分離されるのは監査/統制であって生成結果ではない(compose キャッシュはテナント非依存)

### デモ 7 — ロールベースの統制認可(RBAC)

1. `admin`(既定)のまま Admin → 昇格レビューで候補を表示しておく(「承認して登録」ボタンが出る状態)
2. 上部バーの**ロール**を `viewer` に切り替える(このとき候補一覧は保持される)
3. **「承認して登録」を押す → 403 の赤いエラーバナー**(「現在のロールでは『昇格の承認』は許可されていません」)。固定化タブの「L0 に固定化」「解除」も同様に 403
4. **View Lineage は `viewer` でも閲覧できる**(読み取りは許可)。`reviewer` に切り替えると昇格系は通るが固定化の削除は 403(域外)
5. `admin` に戻すと全操作が通る。認可はサーバー側の宣言的ポリシー(`createGovernancePolicy`)が判定し、拒否は 403 `CAPABILITY_DENIED` で返る(クライアントは `@kohaku-ui/client` の `KohakuHostError.code` で判別)

### デモ 8 — 双方向バインディング(クロスフィルタ = compose なしのクライアント内再解決)

1. Dashboard: 「Quarterly Summary」で **Group by = By product**、**Region = Japan** を選ぶ → 左パネルのファセット操作なので**ここは 1 回だけ compose が走り**(`/compose`)、地域切替つきの Spec(`control.select` + `data.bind`)が返る
2. 画面内に現れた**「Region」セレクタ**を「Europe」「APAC」…と切り替える → **グラフと表が即座に別地域の製品別内訳に変わる**
3. DevTools → Network を見ると、この画面内セレクタ操作では **`/compose` は 1 本も飛ばず、`/binding/resolve` だけ**が新しい地域の effective ref(`…&region=europe` 等)で走る。状態(`$state.region`)は Renderer 内に閉じ、サーバーへは送られない
4. 仕組み: `data.bind` が `$ref` の `region` パラメータを `$state.region` で差し替えてクライアント内で再解決する(Spec は不変 = 再合成ゼロ)。compose が発行する capability は `values`(地域 enum)の全 variant を read スコープで覆うので、どの地域に切り替えても認可済み。**列挙外の地域(偽造)は 403 + `REF_NOT_FOUND`** になり、client が任意フィルタで認可をすり抜けられない(§5 の偽造禁止)
5. 「Spec JSON を表示」で `state.region` の初期値・`components[].data.bind`・`control.select` の options を確認できる(左パネルのファセット compose 経路は従来どおり残っており、compose 往復で地域を変えることもできる — 両者の違いが見どころ)

### リセットしたいとき

```bash
trash apps/sample-api/.data   # 昇格・固定化・Lineage を初期化(rm の場合は rm -rf)
```

## 5. 外部チャット(MCP)から使う

Web と同一の Spec・同一の描画コードを、MCP Apps 対応ホストに配信できます。ただし**ホストの UI 描画対応状況によって接続と描画の経路が 3 つに分かれます**。

### ホスト対応表

| ホスト | 接続方式 | 描画 |
|---|---|---|
| **Claude Desktop** | ローカル stdio(`start`) | MCP Apps(iframe)で Web と同一描画 |
| **claude.ai / ChatGPT** | Streamable HTTP(`start:http`)+ 公開トンネル経由のリモートコネクタ | MCP Apps(iframe)で Web と同一描画。ChatGPT は **developer mode** の有効化が必要。ChatGPT では再オープン時に widgetState から前回ビューを即時復元。fullscreen 対応ホストでは widget 右上に全画面トグルが出る |
| **Claude Code / Codex CLI 等ターミナル** | ローカル stdio / Streamable HTTP | iframe 描画は不可 → `kohaku_render_snapshot` の**自己完結 HTML** で受ける |
| **mcp-ui レガシーホスト(LibreChat / Smithery / Nanobot 等)** | stdio / Streamable HTTP + `KOHAKU_MCP_LEGACY_UI=1` | SEP-1865 未対応でも、ツール結果に併記される `ui://` UIResource(自己完結スナップショット)を静的描画。**約 1MB/結果**になるため modern ホスト(Claude / ChatGPT)では有効化しないこと |

いずれの経路でも、UI 表示には事前に共有レンダラーをビルドしておきます(iframe 描画も snapshot も同じバンドルを使う)。

```bash
pnpm --filter @kohaku-ui-sample/mcp build:renderer    # 共有レンダラーの self-contained ビルド
```

**露出されるツール**(stdio / HTTP のどちらのエントリでも同じ):

- `kohaku_compose`(モデル可視・自然言語)と、Intent カタログから自動生成される型付きツール群(`sales_quarterly_summary` / `sales_trend` / `sales_kpi_overview` 等)。canonical 名(`sales.quarterly_summary`)は MCP 命名制約へ正規化される(→ `sales_quarterly_summary`)。型付きツールは `intentToolsFromCatalog(intentCatalog.list())` で生成する(Zod params → inputSchema は SDK が変換)。昇格分は起動時静的: MCP 起動後に REST 面で昇格した Intent は、この MCP プロセスの再起動でツール群に合流する。
- **表示言語**: UI を生成する全ツールは追加で optional な `locale` 引数(例 `"ja"`)を受け付けます。ツール説明が「利用者の会話言語に合わせて設定する」よう呼び出し側 LLM に指示するため、claude.ai / ChatGPT で日本語で会話していれば、構成される UI のタイトル・ラベルも自動的に日本語になります(固定 Spec・L1/L2 生成とも。Web の EN/JA トグルと同じセッション単位の出力言語機構で、キャッシュはサーバー側で言語別に分離)。省略時は英語。
- `kohaku_render_snapshot`(モデル可視)— ターミナルホスト向けの自己完結 HTML 生成(後述)。
- `kohaku_resolve_binding` / `kohaku_event` / `kohaku_action`(**app 専用**。iframe からのみ呼ばれる)。データ取得・イベント・書き込みはこの経路を通り、**モデルのコンテキストにバルクデータは流れません**。`kohaku_action`(`{action, payload?, capability}` → `{result, invalidates?, refVersions?}`)は presentForm submit / action.button の書き込み直結路で、REST の `POST /binding/action`(デモ 5)と対称。write スコープ(`{kind:"write", ref:action}`)の capability を検証し、拒否はツールエラーとして返します(`invalidates` / `refVersions` は副作用宣言の配線時のみ載り、未配線なら `{result}` のみ)。
- どのツール結果も UI 非対応ホストで読めるテキスト要約(`content[0]`)付き(フォールバック必須思想)。
- widget 内の操作(ファセット変更・書き込み)は app 専用ツール経由でモデルから不可視ですが、操作後に**現在ビューの要約テキストだけ**が `ui/update-model-context` でモデルへ還流されます(対応ホストのみ。バルクデータは流れない)— モデルが「いまユーザーに何が見えているか」を把握した状態で会話を続けられます。
- **widget はホストのテーマに追従します**: `hostContext.theme`(light/dark)や `hostContext.styles.variables`(ホスト標準の `--color-*` CSS 変数)を提供するホストでは、widget が対応する kohaku の既定テーマを選び、認識できたホスト側スタイル変数をその上に重ねます(設定不要)。いずれも提供しないホストでは kohaku の既定ライトテーマにフォールバックします。
- 永続化は Web と共有(`sample-api/.data`)しますが、各プロセスは起動時に読み込み、**プロセス間のライブ反映はありません**: Web で昇格した部品が MCP 側で使われるのはこの MCP プロセスの再起動後(上記 promotions の注記参照)で、逆に MCP 側の lineage を API サーバーが取り込むのも API サーバー自身の再起動後です。

### Claude Desktop / ターミナル(ローカル stdio)

```bash
claude mcp add kohaku-sales -- pnpm --dir <絶対パス>/apps/sample-mcp start
```

Claude Desktop は iframe で Web と同一描画になります。Claude Code のようなターミナルホストは iframe を描けないため、後述の `kohaku_render_snapshot` を使ってください。

### claude.ai / ChatGPT(Streamable HTTP + 公開トンネル)

claude.ai / ChatGPT はローカル stdio に繋げず、**リモート MCP コネクタ(Streamable HTTP)**経由でしか接続できません。HTTP エントリを起動し、公開トンネルで URL を露出してコネクタに登録します。

```bash
pnpm --filter @kohaku-ui-sample/mcp start:http        # 既定 :8788 で待受(パスは /mcp)
# 別ポートにするなら KOHAKU_MCP_HTTP_PORT=9000 pnpm --filter @kohaku-ui-sample/mcp start:http
cloudflared tunnel --url http://localhost:8788      # 別ターミナルで公開トンネルを張る(ngrok 等でも可)
```

トンネルが払い出した `https://<ランダム>.trycloudflare.com` に `/mcp` を付けた URL を、ホストのカスタムコネクタ(claude.ai)/ MCP サーバー(ChatGPT の developer mode)に登録します。

> ⚠️ **認証なしのデモです。** この HTTP エントリには一切の認証がありません。公開トンネルで露出すると、**URL を知る誰もが売上データを閲覧・操作できます**。信頼できる相手にのみ URL を渡し、機微データを載せないでください。停止したらトンネルも閉じます。ブラウザからの Host 偽装を弾く DNS リバインディング保護は `KOHAKU_MCP_HTTP_ALLOWED_HOSTS`(カンマ区切り)を渡したときのみ有効化されますが、公開トンネル経由では Host がトンネルのドメインになるため既定では無効です。実際の認証を組み込むには、単一の静的な `McpHostDeps.principal` ではなく、呼び出し単位で識別情報を解決する `McpHostDeps.resolvePrincipal`(TS)/ `resolve_principal`(Python)を配線してください(例: リクエストからベアラートークンを読み取り対応する `Principal` を引く)。共有 HTTP サーバーではすべての接続が 1 つの `McpHostDeps` を共有するため、静的な `principal` では全呼び出し元が同一の識別情報になってしまいます。

### ターミナルホスト向け: `kohaku_render_snapshot`(自己完結スナップショット)

iframe を描けないホスト(Claude Code / Codex CLI 等)では、`kohaku_render_snapshot` に自然言語の質問を渡すと、**Web と同一の共有レンダラーで描画する自己完結 HTML** を生成します。UI Spec と解決済みデータを 1 ファイルに埋め込むため外部通信は不要で、生成物のパスが返ります(HTML 本文はモデルのコンテキストに載せません。約 1MB あるため)。

- 使い方: 返されたパスのファイルを**そのままブラウザで開く**か、**Artifact として公開**して表示に使います。ツール結果からモデルが独自 UI を自作すると Web と描画が食い違うため、生成された HTML をそのまま使うのが要点です。
- 生成物は `sample-api/.data/snapshots/snapshot-<intentHash>.html` に集約されます(同一表示は同一ファイル)。
- **静的スナップショットです**: 埋め込み済みの Spec + 解決済みデータで描画するため、部品の操作による**再取得・再合成イベントは無効**(no-op)です。インタラクションを伴う確認は iframe 対応ホストか Web サーフェスで行ってください。

### 「同一 Spec → 同一描画」が成立する条件

同内容のリクエスト → Web と同一 Spec → 同一レンダラーによる**ピクセル一致**は、ホストが **MCP Apps(SEP-1865。2026-01-26 正式化)に対応している**ときに成立します。非対応ホストでは、`_meta` の UI 宣言が無視されてモデルがツール結果から**独自 UI を描く縮退**が起こりえます。その縮退の受け皿が `kohaku_render_snapshot`(ホストの UI 対応に依らず Web と同一描画を 1 ファイルで届ける)です。

UI 宣言 `_meta` は modern(ネスト `_meta.ui.{resourceUri,visibility}`)と legacy(フラット `_meta["ui/resourceUri"]` / `_meta["ui/visibility"]`)を**併記**しており、どちらの形式を見るホスト(ChatGPT 等は modern を第一に見る)でも UI ツールとして認識されます。

### 描画されないときの切り分け

プロトコルが正しくても、**ホスト側の UI ロールアウト制限**で iframe が描画されない事例が報告されています(modelcontextprotocol/ext-apps issue #671)。「サーバーは正しいのにホストが描かない」のか「サーバーの宣言が誤っている」のかを切り分けるには:

1. **MCPJam inspector** 等の MCP インスペクタで接続し、`ui://kohaku/renderer.html` リソースが `text/html;profile=mcp-app` で返るか、各ツールの `_meta` に UI 宣言(modern + legacy)が載っているかを確認する。ここまで正しければサーバー側の準拠は取れている(= ホスト側のロールアウト制限が疑わしい)。
2. ホストが iframe を描かないときは `kohaku_render_snapshot` にフォールバックする(ホストの UI 対応に依らず表示できる)。

サーバーのプロトコル準拠(リソース MIME / `_meta` の modern+legacy / テキストフォールバック)は `pnpm vitest run --project host-mcp-apps` で自動検証されています。ホスト上の実描画は手動確認です。

### カスタム部品(L2)の非対称

- **カスタム部品の「作成」(L2 自由生成)も MCP から起こせます**: MCP ホストに「**Show me sales as a calendar heatmap**」(日本語「売上をカレンダーヒートマップで見せて」でも同様)のように頼むと `kohaku_compose`(または `kohaku_render_snapshot`)が呼ばれ、Web の Chat と同じ NL 正規化で `sales.custom` → L2 に入ります。利用イベントは同じ lineage ストアに追記されます(永続化共有)が、API サーバーが集計するのは自身の起動時に読み込んだ lineage + 自プロセスのイベントです — MCP 側の利用が昇格カウンタに見えるのは API サーバーの再起動後です。再起動後は MCP と Web で 1 回ずつでもデモ閾値(2 回)に到達し、Admin の昇格レビューに候補が並びます(以降はデモ 3 の手順 3〜4 と同じ)。
- **ただしカスタム部品の表示には非対称があります**: 共有レンダラー(`apps/sample-mcp/renderer/main.tsx`)はコア部品の実装だけを登録し、sandbox レンダラー(`renderSandbox`)も注入していません。そのため MCP 面では L2 生成部品は「sandbox レンダラーの注入が必要」という通知に、寄与部品・昇格部品(`sales.kpiCard` / `sales.calendarHeatmap`)は「未実装の部品タイプ」という通知になります(sample-mcp は `SurfaceCapabilities` を宣言していないため、fallback へのサーバー側降格〈negotiate〉も走りません)。カスタム部品の完全な表示(sandbox iframe・ネイティブ実装)は Web サーフェスで確認してください。

## 6. 自分のプロダクトに組み込む

導入ラダー(設計書 §12「サンプル実装の設計」)に沿って段階導入できます。

**依存方法**: `@kohaku-ui/*` パッケージは npm に公開済みです。単体アプリでは `npm install @kohaku-ui/host-rest @kohaku-ui/registry @kohaku-ui/llm zod`(後続ステップに進んだら `@kohaku-ui/composer` や `@kohaku-ui/renderer-react react react-dom` なども追加)して通常どおり import するだけで動きます — 各パッケージの `publishConfig` が `exports` を `dist` ビルドへ向けているため、モノレポ外でも追加設定なしで動作します。逆に**このモノレポの中**でアプリを組む(本体への貢献や、ビルドを挟まず `src` に対して直接開発したい)場合は、`apps/<your-app>` に自分のアプリを追加し、その `package.json` で各パッケージを `workspace:*` として参照し、`tsx` で実行します(この場合パッケージは `.ts` を直接 export します — `dist` ビルドはモノレポ外からの消費専用です)。以下で生成される `server.ts` は npm install 経路を前提にしています。モノレポ経路を取る場合はコメントの依存関係の行を `workspace:*` に読み替えてください。

### Step 0 — LLM なしの Server-Driven UI

```bash
node cli/bin/kohaku.js scaffold ports --out ./my-app/kohaku
```

生成された `ports.ts` の 4 つの Port を実装します。最初は:

1. **DomainPort**: 集計クエリを `op` として実装(戻りは TabularData 推奨)
2. **SemanticPort**: `normalize` は GUI 操作の決定的マッピングだけ、`resolveQuery` は Intent → `query://` ハンドル
3. **AuthzPort**: サンプルの HMAC 実装(`apps/sample-api/src/ports/authz-port.ts` 約 50 行)を流用可
4. **StoragePort**: まずインメモリで十分(ファイル永続化の見本は `apps/sample-api/src/ports/storage-port.ts`)

composer の `policy.fixedSpecs` に固定 Spec テンプレート(`apps/sample-api/src/intents/fixed-specs.ts` が見本)を登録すれば、**LLM なしで** renderer-react による Server-Driven UI が動きます。

### Step 1 — L1 宣言的合成とチャット

- **Intent カタログを単一定義する(`@kohaku-ui/intents`)**: `defineIntent` で 1 Intent = 1 定義にします(見本: `apps/sample-api/src/intents/catalog.ts`)。値集合は `defineVocabulary("region", { japan: "Japan", north_america: "North America", ... })` で単一源化し、`params`(Zod)/ `examples`(NL 例文)/ `facets`(GUI に出す param)/ `queries`(テンプレート or コールバック)を宣言すると、同じ定義から `.toIntentDef()`(SemanticPort 用)・`.toFacetView()`(GUI ファセット)・`.toToolSource()`(MCP ツール)・`.parseParams()`(coerce + default)が導出されます。GUI に出すファセットは codegen(`pnpm intents:emit`)で `facet-views.json` に書き出し、web はそれをデータ import します(web は server コード非依存を保つ)。
- `SemanticPort.normalize` の NL 側を `@kohaku-ui/llm` で実装(見本: `apps/sample-api/src/ports/semantic-port.ts` — Intent カタログをプロンプトに転写し、構造化出力でマップ。失敗は `*.custom` に倒す)
- `describeShape` を実装すると、チャート種別規則・既定ソートの決定的後処理が効くようになります
- ドメイン部品は `CatalogContribution` で寄与(`defineComponent` + renderer 実装の `registry.register`)

### Step 2 — L2・昇格・固定化(完全形)

- `policy.allowL2: true` + 受け皿 Intent(`*.custom`)+ `routeTier`
- `createLineage` / `createPromotions`(`onPublish` でカタログ・Intent への反映を実装)/ `createFixations` を host-rest の deps に注入
- 昇格閾値・judge の合格点はポリシーで調整(人間レビューは外せません)

### L2 にデザインシステムを適用する

L2 自由生成(カスタムコンポーネント)にプロダクトのデザインシステムを効かせる 3 点セット(加えて、独自のデザインキットを持ち込む任意の 4 番目のステップ)。生成物は色を直書きせずトークン参照 `var(--kohaku-*)` で書かれ、値は描画時に注入されるため、ライト/ダーク切替・ブランド変更に**再生成なしで追従**します。

1. **デザインシステムを定義して compose policy に配線**(サンプル: `apps/sample-api/src/design-system.ts`):

```ts
import { DEFAULT_KIT_VOCABULARY, type DesignSystemGuide } from "@kohaku-ui/composer";

const designSystem: DesignSystemGuide = {
  // 既定のトークン語彙(KnownThemeTokens 全網)に足す独自トークン・説明の上書き(任意)
  tokens: { "brand.accent": "アクセント色(バッジ・ハイライト)" },
  // デザインキット語彙(モデルが組み立てに使うコンポーネントクラス + ユーティリティ)。ここでは組み込みキットを
  // 指定しているが、独自キットを持ち込む場合はステップ 3 を参照
  kit: DEFAULT_KIT_VOCABULARY,
  // 自然言語のスタイル規則(タイポグラフィ・余白・トーンなど)— 具体値(色や px 数値)は書かないこと。値が
  // 属するのはトークン/キットだけ。apps/sample-api/src/design-system.ts を参照
  guidelines: [
    "テーブルのヘッダー行は k-table クラスでスタイルする(サーフェス色の背景に、控えめな配色のヘッダーになる)。",
    "増減を示すときは k-kpi-delta を is-up / is-down とともに使う(または var(--kohaku-color-positive) / var(--kohaku-color-negative))。さらに ▲▼ のような記号も表示し、色だけに頼らないこと。",
  ],
  // 色直書きの lint 差し戻し(既定 true。小型モデルで修復が収束しないなら false)
  // enforceTokenColors: false,
};

const policy = {
  allowL2: true,
  designSystem,
  // designSystem の on/off・内容変更はプロンプト内容の変化 → 必ず版を進める(キャッシュの世代分離)
  generatorVersion: `${defaultGeneratorVersion(llm)}/ds1`,
};
```

2. **レンダラーに theme を渡す**(値の供給。独自トークンは同名でテーマにも値を入れる):

```tsx
// React: SandboxFrame に theme を渡す(sample-web の SpecSurface 参照)
<SandboxFrame node={node} spec={spec} theme={buildTheme(mode)} bridge={bridge} />
// WC: <kohaku-surface> の context.theme(または theme プロパティ)に設定するだけ
```

3. **(任意)独自キットを持ち込む**: 語彙を `designSystem.kit`(`{ id, version, classes, utilities, namespaces }`)として、スタイルシートを `kitCss`(`SandboxFrame` の prop / `<kohaku-surface>` の `context.sandbox.kitCss`)として渡す。色はすべて `var(--kohaku-color-*)` 参照か `currentColor` で書き、色の直書きはしないこと。寸法もトークンで書くが、組み込みキット自身が使っているような意図的なリテラル(1px のヘアラインボーダー、2px のフォーカスリング、480px のグリッドブレークポイント、SVG チャートの寸法)は例外とする。`display:flex`・`color-mix()`・`filter` のようなレイアウトやエフェクトは制限されない(組み込みキットもこの 3 つを使っている)。ブランドの Web フォントは `@font-face` の data URI として埋め込める。`kitCss: ""` で組み込みキットを完全に無効化できる。クラスの意味を変更したら `version`(および `generatorVersion`)を bump する。

4. **確認**: L2 生成(例: チャットで自由形式の要求)→ 生成 HTML に `var(--kohaku-color-*)` が使われ、ヘッダのテーマ切替でカスタムコンポーネントの配色が追従すれば OK。色直書きが混ざると `L2_RAW_COLOR` として、語彙にないキット名前空間のクラス名が混ざると同様に `L2_UNKNOWN_CLASS` として自動で修復再試行されます。

theme 未指定でも既定ライトテーマが sandbox に常時注入されるため、`var()` が未定義に落ちることはありません。Python 実装(`python/kohaku`)も同一機能(`ComposePolicy(designSystem=DesignSystemGuide(...))`)を持ちます(サンプル: `python/examples/sales-api/src/sales_api/design_system.py`)。

### クライアントから叩く(型付きホストクライアント SDK)

フロントエンド(または Node)から REST ホストを叩くときは、手書き fetch の代わりに `@kohaku-ui/client` を使うと、応答(`{spec, capability}` 等)とエラーコードが型付きで扱えます。`fetch` はトランスポート DI で、テストではインメモリのホストに差し替えられます(ブラウザ / Node 両用)。

```ts
import { createKohakuClient, isKohakuHostError } from "@kohaku-ui/client";

const client = createKohakuClient({
  baseUrl: "/api/kohaku",
  // 全リクエストに載る追加ヘッダ(マルチテナントの x-kohaku-tenant 等)。関数なので毎回評価される。
  headers: () => ({ "x-kohaku-tenant": currentTenant() }),
  // transport?: fetch の DI(省略時はグローバル fetch。テストで app.request を注入)
});

// 合成(決定的経路)。応答は { spec: UISpec, capability: string }。
const { spec, capability } = await client.compose({
  input: { kind: "gui", action: "view.select", params: { intent: "sales.trend" } },
  session: { surface: "web" },
});

// エラーは判別可能例外。コード別分岐が型安全に書ける(HostErrorCode)。
try {
  await client.compose({});
} catch (e) {
  if (isKohakuHostError(e) && e.code === "BAD_REQUEST") { /* e.status / e.requestId も参照可 */ }
}

// ストリーミング合成(SSE。§6.1.1)は型付き async iterator で消費する。
for await (const ev of client.composeStream({ intent: { canonical: "sales.trend", params: {} } })) {
  if (ev.kind === "spec") renderSkeletonOrFinal(ev.spec, ev.final);
  else if (ev.kind === "patch") applyPatch(ev.patch);      // REST-STR-002: 畳み込むと /compose と一致
  else if (ev.kind === "error") showError(ev.error);        // REST-STR-003: done か error で終端
}
```

- **切断されたストリームは正常終了ではなく失敗として扱う**: `done` / `error` イベント(REST-STR-003)より前に接続が切れた場合、`composeStream` の反復は `for await` ループが単に終わるのではなく `KohakuHostError`(`code: "INTERNAL"`)を throw する。
- **参照渡しバインディング**: `client.binding({ capability })` が `@kohaku-ui/data-binding` の `BindingClient` を SDK 設定(baseUrl / headers)ごと合成する(`createBindingClient` は SDK からも再エクスポート)。
- **統制系**: `client.catalog()` / `client.lineage()` / `client.telemetry()` / `client.promotions.*` / `client.fixations.*` が型付き。
- **renderer-react の `useSpecStream`** に渡す fetch サンクは `client.composeStreamRequest(req)` で得られる。
- **SPEC 対象外のルート**(独自の `/health` 等)はエスケープハッチ `client.request(path, init?)`(headers フックは効くが JSON パース・エラー変換はしない)で叩く。
- サンプルの配線は `apps/sample-web/src/kohaku/client.ts`(SDK を薄く包んで sample 固有の呼び出し形に合わせている)。

### 部品を追加する

```ts
export const myCard = defineComponent({
  type: "myapp.card", version: "1.0.0",
  description: "〜を表示する(LLM がこれを読んで選択します。具体的に)",
  propsSchema: z.object({ title: z.string() }),
  capabilities: { events: [], data: "required", children: "none" },
  fallback: { type: "presentMarkdown", mapProps: () => ({ markdown: "(非対応)" }) },
});
// API 側: resolveCatalog(coreCatalog, { components: [myCard] })
// Web 側: registry.register("myapp.card", "1.0.0", MyCardComponent)  // useBoundData でデータ取得
```

検証: `node cli/bin/kohaku.js component validate <definition.json>`。検証が通る最小の definition.json(`type` はドット区切り識別子、`version` は semver、`propsSchema` は `type: "object"` の JSON Schema、`capabilities.data` は `none | optional | required` が必須):

```json
{
  "type": "myapp.card",
  "version": "1.0.0",
  "description": "タイトル付きカードを表示する(LLM がこれを読んで選択します)",
  "propsSchema": {
    "type": "object",
    "properties": { "title": { "type": "string" } },
    "required": ["title"]
  },
  "capabilities": { "events": [], "data": "required", "children": "none" }
}
```

### Golden 回帰を始める

入力 Intent → 生成 Spec の「構造」を回帰として固定します。雛形を生成:

```bash
node cli/bin/kohaku.js scaffold golden --out ./my-app/test   # golden.test.ts + golden/README.md
```

生成された `golden.test.ts` の `makeContext` にプロダクトの `ComposeContext` を配線し、`golden/` に `{name,input,drafts,expected:null}` の JSON を置いて `KOHAKU_GOLDEN_UPDATE=1 <テスト実行>` で `expected` を生成します。以降のテストは `@kohaku-ui/evals` の `runGolden` が provenance / intent.hash / dataVersion / refVersions とコンポーネント ID の揺らぎを正規化して構造だけを比較するため、LLM 不要で決定的です(応答は `drafts` を FakeLlm に流す。ライブ記録が要るなら FixtureLlm の record/replay)。動く実例は `apps/sample-api/test/golden.test.ts`(`sales.trend` の L1 生成を固定)。意図的に UI を変えたら同じ更新手順で `expected` を再生成し、git diff をレビューしてコミットします。

## 7. 運用の勘どころ

- **キャッシュとデータ更新**: Spec キャッシュのキーは intent + dataVersion + カタログ指紋(+ 任意の generatorVersion)。`SemanticPort.dataVersion` の粒度(全体 / テーブル単位 / イベント駆動)がそのまま無効化戦略になります。サンプルは全体一括 + bump。
- **キャッシュの無効化と上限**: キーに dataVersion / カタログ指紋 / generatorVersion が入るため、データ更新・部品公開・プロンプト改訂はキー変化で自動的に別エントリになります。したがって能動的なキャッシュ無効化(削除)は原則不要です。TTL は鮮度制御ではなくメモリ回収の保険で、指定しなければ無期限に保持します。サンプルの `StoragePort` はインメモリ Map で、エントリ上限(既定 500)を超えると最も長く参照されていないキーから LRU で落とします。上限の目安は「同時に生きている intent × dataVersion の組」を十分覆う値にし、恒久保持や大量エントリが必要ならプロダクト側で Redis / DB 実装に差し替えてください。
- **キャッシュバックエンド障害(`ComposePolicy.cacheFailure`)**: Spec キャッシュを支える `StoragePort` 自体が使えない場合(Redis 障害など)、`getSpecCache`/`putSpecCache` の例外送出は既定で fail-open(`cacheFailure` 未指定 = `"open"` 相当)です。lookup の失敗はミス扱い、store の失敗はスキップとして扱われ、生成は継続して Spec は配信されます。発生ごとに `observer.onError` に `phase:"cache"` で通知されます。同一表示保証を厳密にし、キャッシュ障害時にリクエストを失敗させたい場合は `cacheFailure: "closed"` を指定してください。
- **昇格の運用**: 候補化は利用ログから自動、承認は必ず人間。judge はポリシーで「助言」(不合格でもレビューに回す)か「ブロッキング」を選べます。公開後の部品はカタログ指紋を変えるので、古いキャッシュと混ざりません。
- **固定化 Spec を蒸留データとして書き出す**: `FixationRecord.pinnedSpec` は、その Intent に対して人間がすでに承認済みの `{components, events}` そのものであり、カタログ拘束の宣言的 UI 生成において小型モデルを蒸留する際の最良の教師データになります。`node cli/bin/kohaku.js dataset export --fixations <fixations.json> [--golden <dir>] [--tenant <id>] --out <file.jsonl>` は `fixations.json` スナップショット(sample-api の `.data/fixations.json` をそのまま渡せます。オンディスクの形は `{key -> FixationRecord}` で、(tenant, intentHash) ごとに 1 エントリです — `apps/sample-api/src/ports/storage-port.ts` 参照)と、任意でディレクトリ内の golden regression Spec(`--golden`。`scaffold golden` の `{name, input, drafts, expected}` フィクスチャファイルと素の `UISpec` JSON ファイルの両方を受け付け、`expected` が未生成のフィクスチャは黙ってスキップします)を読み、Spec 1 件につき 1 行の canonical JSON を指定パスに書き出します: `{intent, refs, shape?, target: {components, events}, source: "fixation"|"golden", meta: {fixatedAt?, structureHash?, tenant?, catalogFingerprint?}}`。`kohaku`(プロトコル版数)・`provenance`・`dataVersion` は意図的に除外しています — composer がモデルの実際の出力の周りに埋めるものであり、蒸留対象として学習させるべきものではないためです。`--tenant <id>` を指定するとそのテナントの fixation だけに絞り込みます(golden Spec はテナントを持たないため常に含まれます)。指定しない場合、出力は `--fixations` に含まれる全テナントにまたがり、後から見分けるには各行の `meta.tenant` を見るしかありません。`FixationRecordSchema` の検証に失敗したエントリ(手編集や移行前の古いレコードなど)は書き出し全体を中断せずスキップされ、スキップ件数は標準エラー出力とコマンドの戻り値の両方で報告されます — これにより 1 件の不正なレコードがデータセット全体をブロックすることはなくなりました。エントリは `(intentHash, source)` 昇順にソートされ(同じ intentHash を共有する場合は `fixation` が `golden` より先に並びます)、再実行してもバイト同一になります(プログラムから使う場合は `@kohaku-ui/evals` の `exportDistillationDataset` / `kohaku.evals.export_distillation_dataset` を参照。列メタデータ用の `describeShape` コールバックやテナント絞り込み用の `tenant` を渡せます)。
- **コスト/トークン予算ガード(暴走コストの安全弁)**: `ComposePolicy.budget` を配線すると、LLM を呼ぶ直前(L1 生成前・修復前・L2 前)に予算を判定し、拒否時は修復再試行・L2 昇格を諦めて決定的フォールバック(`presentMarkdown`)へ降格します。`perCompose.stopAfterTokens` は**追加の呼び出しを止める累積トークン閾値**で、合計トークンのハード上限ではありません(単一呼び出しの超過は事前に止められず `trace.usage` に事後記録)。`check()` は日次/テナント別などプロダクト側で保持するグローバル予算のフックです(**状態の保持先はフレームワークが決めない** — Redis のカウンタ等はプロダクト実装)。降格 Spec はキャッシュされず、`observer.onError`(`phase:"fallback"` の `budgetExceeded:true`)で観測できます。予算フック `check()` が `throw` したときは素通し(fail-open)に倒しつつ、その発火を `observer.onBudgetCheckError` に転写するので、予算フックの故障を無観測にしません。`budget` 未指定なら挙動・性能とも完全不変。

  ```ts
  import { compose, type ComposeContext } from "@kohaku-ui/composer";

  // 例: 累積 8000 トークンに達したら追加呼び出しを止める + テナント日次予算をプロダクト側で管理
  const ctx: ComposeContext = {
    catalog, semantic, storage, llm,
    policy: {
      allowL2: true,
      budget: {
        // ハード上限ではなく「これに達したら以降の LLM 呼び出しを止める」閾値(単一呼び出しの超過は事後検知)
        perCompose: { stopAfterTokens: 8_000 },
        // 副作用のない冪等な読み取りにする(1 compose 中に複数回呼ばれ得る)。throw は allow 扱い。
        check: () => {
          const spent = dailyBudget.get(currentTenant()); // ← 保持先はプロダクト責務(Redis 等)
          return spent.remaining > 0
            ? { allow: true }
            : { allow: false, reason: `テナント ${currentTenant()} の日次予算超過` };
        },
      },
    },
    observer: {
      onError: (c) => {
        if (c.budgetExceeded) metrics.increment("compose.budget_degraded", { reason: c.reason });
      },
      // 予算フック check() の故障(throw = fail-open)を無観測にしない。失敗通知ではなく監視シグナル。
      onBudgetCheckError: (c, error) => {
        metrics.increment("compose.budget_check_error", { tier: c.tier });
      },
    },
  };
  await compose(input, ctx);
  ```
- **compose 全体のデッドライン(遅延/ハングした LLM 呼び出しへの安全弁)**: サンプルは `KOHAKU_COMPOSE_DEADLINE_MS` 経由で `ComposePolicy.budget.deadlineMs` を配線しており(`apps/sample-api/src/app/compose-context.ts` の `composeDeadlineMs`。既定 240000ms)、1 回の `compose`/`composeStream` 呼び出しが無期限にハングすることはない — 期限超過時は実行中の LLM 呼び出しを中断し、`perCompose` のトークン予算超過と全く同じ決定的フォールバックへ降格する。既定値は L2 直行 1 回分(`sales.custom` の、既定の 3 倍 `outputBudgetFactor` で広がった `KOHAKU_LLM_TIMEOUT_MS` による ~180 秒の L2 タイムアウト)+ repair 再試行分の余白を見込んだもの。自分の L2 プロンプトが常態的にこれより長くかかるなら広げること。Python サンプルは `python/examples/sales-api/src/sales_api/app.py` の `ComposePolicy(budget=ComposeBudget(deadline_ms=...))` で同様にミラーする。
- **プロンプトキャッシュ・`refConstraint` に触る前に計測する**: kohaku の既定の `data.$ref` 強制(`ComposePolicy.refConstraint: "schema"`)は L1 生成スキーマで `data.$ref` を intent ごとの enum に固定する — これは同時に、構造化出力の文法コンパイルをキャッシュするプロバイダ(Anthropic)がほぼ全ての異なる intent で再コンパイルし、以前のコンパイル結果を再利用できないことも意味する。独立した 2 つの opt-in の逃げ道があり、どちらも既定 off で、自分のモデル/プロバイダ/トラフィックの組み合わせで計測せずに切り替えるべきではない:
  - `KOHAKU_LLM_PROMPT_CACHE=1`(Anthropic の `claude` のみ。他プロバイダは no-op)は L1/L2 プロンプトのバイト不変な接頭辞(末尾の修復フィードバック節を除く全体)に `cache_control` を付け、同一 compose 内の修復再試行がそのキャッシュ済み接頭辞を再処理せず再利用できるようにする。Anthropic はモデルごとの最小サイズ(モデルにもよるがおおよそ 1,000 トークン前後以上)に満たない接頭辞へのキャッシュブレークポイントを黙って無視する — 無害ではあるが、few-shot 例を含まない小さなカタログではキャッシュ対象の接頭辞がその最小値を下回ることがあり、その場合フラグを有効にしても効果が全く測定されない。「効果が無い」と判断する前に、自分のモデルの最小値と実際の接頭辞トークン数を確認すること。
  - `ComposePolicy.refConstraint: "validate"` は生成スキーマの `data.$ref` をプレーンな文字列に緩和し(修復再試行間だけでなく compose 間でも再利用可能な intent 非依存の文法になる)、代わりに生成後に明示的に集合所属を検証する(`DATA_REF_UNRESOLVED`。既存の修復ループに送り返す)。
  - 実際のモデルに対して `KOHAKU_LLM_PROVIDER=claude KOHAKU_LLM_MODEL=<自分のモデル> ANTHROPIC_API_KEY=<自分のキー> pnpm --filter @kohaku-ui-sample/api run measure-grammar-latency`(`apps/sample-api/scripts/measure-grammar-latency.ts`)を実行してから、自分のデプロイでどちらの逃げ道を有効にする価値があるか決める — このスクリプトは実際の LLM を呼ぶため、意図的に `pnpm test` から除外されている。すべての行が `provenance.cache: "bypass"` になることを期待している — これは比較軸ではなく、LLM 経路が実際に走ったことの確認である。有効な API キーが無いと `claude` プロバイダは起動時に警告を出すだけで決定的フォールバックへ落ちるため、キー未設定はエラーにならず「`tier` 列が `L1` ではなく `L0`/フォールバックになった、明らかに速い実行」として現れる — レイテンシの数値を信じる前に必ず `tier` 列を確認すること。表の読み方(Anthropic の文法キャッシュは 24 時間有効なので、同一 intent の初回/2 回目の呼び出しでは 2 モードを区別できない)はスクリプト自身のヘッダコメントを参照し、トレードオフの全体は [design.ja.md#prompt-caching](design.ja.md#prompt-caching) を参照。
- **監査**: 「なぜこの画面が出たか」は Admin の Lineage か `GET /api/kohaku/lineage` で specHash / intentHash を辿れます。
- **`x-request-id` によるログ突合**: マウントされた kohaku ルートのすべての応答は `X-Request-Id` ヘッダを持つ(呼び出し側が送った `x-request-id` リクエストヘッダが存在し正しい形式ならそれをエコーし、なければ新規発番する)。同じ ID はすべてのエラーエンベロープの `error.requestId` にも現れ、`KohakuHostDeps.onError` にも渡されるので、サポートチケットに載るクライアント側の ID・サーバーログ・`onError` フックの記録が追加配線なしで一つの値で揃う。既存の相関 ID 規約がある場合は `KohakuHostDeps.requestId`(TS)/ `request_id`(Python)でこの解決を丸ごと上書きできる。
- **Trace context / OTel**: `host-rest` は受信した `traceparent` / `tracestate` リクエストヘッダ(W3C Trace Context)を、`host-mcp-apps` はツール呼び出しの `_meta.traceparent` / `_meta.tracestate`(MCP 2026-07-28 / SEP-414)を読み取り、両方とも `ComposeOptions.traceContext` へ充填する。`correlationId` と同じ経路で `ComposeTrace` / `ComposeErrorContext` に乗る — 純粋な追加で、呼び出し側がどちらのヘッダも送らなければ no-op。`@kohaku-ui/otel` の `createOtelComposeObserver()` は `ComposeObserver` の呼び出しをスパン(`kohaku.compose`。`gen_ai.*`/`kohaku.*` 属性 — 詳細は [design.ja.md#trace-context-otel](design.ja.md#trace-context-otel))へ変換し、その `traceContext` をスパンの親として復元するので、compose は常に新しいルートトレースを開始するのではなく呼び出し側自身のトレースの子として記録される。**kohaku 自体は exporter も SDK 初期化も一切出荷しない** — それは各自のプロセス自身の責務のまま(プロセス起動時に一度、compose が動く前に登録する通常の `@opentelemetry/sdk-node` / `@opentelemetry/sdk-trace-node` セットアップ)。最小構成の配線例:

  ```ts
  // 自分のプロセス起動処理(kohaku の一部ではない): TracerProvider + exporter を一度だけ登録する。
  // trace.getTracer(...) を呼ぶものを import/使用する前に済ませておくこと。
  import { NodeSDK } from "@opentelemetry/sdk-node";
  import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

  const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
  sdk.start();
  ```

  ```ts
  // apps/sample-api 自身の配線(compose-context.ts): KOHAKU_OTEL=1 のときだけ、composer の
  // composeObservers で OTel observer をプロダクト自身の observer と束ねる。
  import { composeObservers } from "@kohaku-ui/composer";
  import { createOtelComposeObserver } from "@kohaku-ui/otel";

  const observer =
    process.env.KOHAKU_OTEL === "1"
      ? composeObservers(myObserver, createOtelComposeObserver())
      : myObserver;
  ```

  `KOHAKU_OTEL` 未設定(または `TracerProvider` が未登録)のときは `createOtelComposeObserver` の既定 tracer が no-op になる — スパンは生成された瞬間に捨てられるだけで、ローカル開発では害のない、完全にサポートされた構成である。`gen_ai.*` / `kohaku.*` のあらゆる属性**キー名**は `createOtelComposeObserver({ attributes })` で個別に差し替え可能 — OpenTelemetry の GenAI semantic conventions がまだ "Development" ステータスであり、本リポジトリがそれらの代わりに安定性を保証できるものではないため。

  **実際に sample-api で試す手順**: このリポジトリが持つ依存は `@opentelemetry/api` だけなので、まず `pnpm add -D @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http` を実行する(インフラ無しですぐ確認したいだけならコンソール exporter に差し替えてもよい)。上の最初のスニペットを例えば `apps/sample-api/otel-bootstrap.ts` として保存し、`NODE_OPTIONS='--import ./otel-bootstrap.ts' KOHAKU_OTEL=1 pnpm --filter @kohaku-ui-sample/api dev` で sample-api を起動する — sample-api は tsx 経由で動くため、アプリ自身のコードより先に読み込むブートストラップモジュールとして `--import` を解釈する。成功の目印は、compose を 1 回起こす(デモの Web アプリを開く、または `kohaku_compose` の MCP 呼び出しを実行する)たびに、exporter の出力(コンソールまたは任意の OTLP バックエンド)に `kohaku.compose` スパンが 1 本ずつ現れることである。
- **ボディサイズ上限とレート制限はプロダクト責務**: `@kohaku-ui/host-rest` 自体はリクエストボディのサイズ上限もレート制限も課さない(ライブラリの関心事ではなく、一段上のリバースプロキシ・API ゲートウェイ・プロダクト自身のミドルウェアが担うべき責務)。サンプルは Hono の `bodyLimit` ミドルウェアで `/api/kohaku/*` に 1 MiB の上限を配線しており(`apps/sample-api/src/app.ts`)、超過したボディは Intent 解決に届く前に `413` と標準エラーエンベロープで拒否される。実際のペイロード(NL の質問や Intent + params は通常 1 KiB を大きく下回る)に合わせて上限を調整し、必要ならレート制限も同じ層に追加すること。
- **グレースフルシャットダウン**: `SIGINT`/`SIGTERM` を受けると TS サンプル(sample-api / sample-mcp)は新規接続の受け付けを止め、進行中の接続(開いている SSE ストリーム含む)を `KOHAKU_SHUTDOWN_GRACE_MS`(既定 30 秒。[specification.ja.md](specification.ja.md) §9 参照)まで待ってドレインさせてから強制終了する。sample-api はさらにシグナル受信と同時に(ドレイン窓より前に)`GET /api/health` を `503 {ok:false, reason:"shutting down"}` に切り替え、ドレイン中もロードバランサが新規トラフィックをこのインスタンスへ送らないようにする。Python サンプルは `uvicorn` 自体のグレースフルシャットダウンに委ね、`timeout_graceful_shutdown=30` をコードで渡している。
- **適合検査**: 実装を変えたら `node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku`。**spec-core の Zod スキーマを変更したときは `pnpm --filter @kohaku-ui/spec run generate-schemas` で `spec/schemas` を再生成してコミットしてください**(CI がドリフトを検査します)。GitHub Actions CI(`.github/workflows/ci.yml`)が push / PR ごとに `pnpm test`・`pnpm typecheck`・`conformance --self`・JSON Schema ドリフト検査(Zod から再生成した `spec/schemas` に差分が出たら失敗)を自動実行します。

## 8. トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| 画面に「Could not render this request」(presentMarkdown) | L1 生成が 2 回とも検証に落ちた決定的フォールバック。LLM 設定(キー・モデル)を確認。ollama なら非思考モデルへ変更。**予算ガード(`ComposePolicy.budget`)配線時は予算超過でも同じ画面**になる(`fallback.reason` の英語文言「budget exceeded」/ `observer.onError` の `budgetExceeded` で判別) |
| Chat が常に L2(橙)になる | NL 正規化が既知 Intent にマップできていない。`/api/health` の `intents` と質問の噛み合わせ、モデル品質を確認 |
| `cache:HIT` にならない | params が完全一致しているか(チップの hash を比較)。bump 後は dataVersion が変わるので MISS が正しい |
| データ部分だけ「データが更新されています」 | STALE_VERSION(Spec が古い)。再操作で新しい dataVersion の Spec に切り替わる |
| 401 / 403 が出る | capability の期限切れ(TTL 600s)→ 再 compose。スコープ外 ref へのアクセスは仕様どおり 403 |
| ollama で散発的に失敗・極端に遅い | 思考モデルを使っている / 構造化出力の散発 400。`KOHAKU_LLM_MODEL=gemma4:e4b` 等 + `KOHAKU_LLM_STRUCTURED_MODE=auto`(既定)を確認 |
| レート制限(429)・一時的な 5xx で即失敗する | PROVIDER 障害は既定で 2 回まで指数バックオフ再試行する(`KOHAKU_LLM_RETRY_MAX`。`KOHAKU_LLM_TIMEOUT_MS` の予算内)。攻めるなら回数・初期待機(`KOHAKU_LLM_RETRY_INITIAL_MS`)を上げる。`0` で無効化 |
| MCP で UI が出ずテキストだけ | それ自体は仕様(フォールバック)。UI を出すには renderer の事前ビルドと MCP Apps 対応ホストが必要 |
| MCP でカスタム部品が「未実装の部品タイプ」/「sandbox レンダラーの注入が必要」の通知になる | 仕様(§5 の表示の非対称)。MCP の共有レンダラーはコア部品のみ登録で sandbox 未注入。完全表示は Web で確認 |
| ポート競合(8787 / 5173) | 既存プロセスを停止するか `PORT` を変更(sample-web / sample-wc の Vite 開発プロキシは `.env` でもシェルでも読み取り — どちらでも可 — `PORT` に自動追従します)。API が `localhost` 以外のホストで動く場合は `KOHAKU_API_URL`(例: `http://localhost:9000`)を直接設定してください — プロキシ先の決定では `PORT` より優先されます |

## 9. FAQ

**Q. LLM が同じ質問に毎回違う UI を作りませんか?**
A. 初回生成は揺れ得ますが、2 回目以降はキャッシュが同一 Spec を返すため表示は揺れません(決定性の本体はキャッシュ)。初回の質も決定的後処理(チャート種別規則・ソート・ID 正規化)と Golden 回帰で抑えています。

**Q. LLM に売上データ(数値)が渡っていませんか?**
A. 渡っていません。LLM が見るのは Intent・カタログ・**列メタデータ(列名と型)だけ**で、Spec には `$ref` しか書けないようスキーマで強制されています(enum 固定)。

**Q. L2 の生成 HTML は安全ですか?**
A. 何層もの防御の中だけで動きます: allow-scripts のみの opaque iframe、ネットワークを遮断する nonce のみの CSP、自前の `document`・代入可能な `location`・`window.open` を持たない専用 Worker での実行(DOM への効果は許可リスト付きの変更チャネル経由でしか実ページに届かない)、そしてブリッジの完全一致 allowlist + クォータ。データの唯一の経路は監査可能な postMessage ブリッジです。

**Q. 自社ページで独自の Content-Security-Policy を設定していますが、サンドボックス側から何か必要ですか?**
A. サンドボックスの `<iframe srcdoc>` は自身の meta CSP に加えて親ページの CSP も継承します(ディレクティブごとに厳しい方が勝つ)。生成ウィジェットは今や Worker 内で実行されるため、`worker-src` を制限する親 CSP では `blob:` も許可する必要があります(`worker-src blob:`)— さもないと、サンドボックス自身の防御はすべて満たしていても Worker 自体が起動できません。ページの CSP がそもそも `worker-src` を設定していなければ変更は不要です(`default-src` にフォールバックし、通常はそれで十分寛容ですが、念のため確認してください)。

**Q. 独自テーマ / ダークモードにできますか?**
A. できます。kohaku は**セマンティックデザイントークン**(色の語彙)を持ち、既定の light/dark テーマを `@kohaku-ui/renderer-core` が `defaultLightTheme` / `defaultDarkTheme` として export します。Spec はテーマ非依存(SPEC-ENV-003)なので、トークンを差し替えるだけで全部品に効きます。

ブランドを当てるときは**「基底テーマを spread → ブランド差分を重ねる」**のが定石です(サンプルの `apps/sample-web/src/theme/tokens.ts` がこの形):

```ts
import { defaultDarkTheme, defaultLightTheme } from "@kohaku-ui/renderer-core";
import type { ThemeTokens } from "@kohaku-ui/spec-core";

// モード非依存で安全な差分だけを置く(モード固有の色をここに固定すると dark の基底を潰す)
const brand: ThemeTokens = { "color.primary": "#7c3aed" };

export function buildTheme(mode: "light" | "dark"): ThemeTokens {
  const base = mode === "dark" ? defaultDarkTheme : defaultLightTheme;
  return { ...base, ...brand }; // 基底を先に spread(dark のキー欠落・崩れを防ぐ)
}
```

これを `RendererProvider` の `theme`(React)/ `surface.theme`(Web Components)に渡します。色トークン語彙は `color.background` / `color.surface` / `color.text` / `color.muted` / `color.primary` / `color.on-primary` / `color.positive[.surface/.text/.border]` / `color.negative[.surface/.text/.border]` / `color.warning.*` / `color.info.*` / `chart.axis` / `chart.palette`、および非推奨 alias `color.danger`→negative・予約 `color.focus`→primary です。独自トークン(語彙外のキー)も自由に足せます(`ThemeTokens` は開いた型)。非色トークン(`font.family.*` / `font.size.*` / `space.*` / `radius.*` / `shadow.*` / `motion.*`)も語彙に含まれ、単位付きの CSS 文字列を取ります(角ばった印象のブランドなら `"radius.md": "4px"` のように指定)。両方の全一覧・既定値・dark の AA 方針は設計書 §7.2 を参照してください。非色トークンは組み込み部品にも反映されます(例: `"radius.md": "2px"` にするとすべてのボタンと入力欄が角ばります)。`L2 SANDBOXED` バッジは `SandboxFrame` の `badge="hidden"` / `context.sandbox.badge` で非表示にできます。
