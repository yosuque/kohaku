# 用語集

[English](glossary.md) | 日本語

[ユーザーガイド](user-guide.ja.md)を読み進めるまでに、新規導入者は kohaku 固有の用語を 20 語ほど覚えることになります。規範的な定義は [spec/SPEC.md §1](../spec/SPEC.ja.md#1-概要と用語-normative) にあります。このページはその平易な解説で、各語から正確な定義とガイドの該当節へリンクしています。

## 用語

**A2UI 取り込み** — *他社*エージェントの A2UI サーフェスを自分の kohaku ベースの製品に描画し、kohaku 自身が合成したものと同じキャッシュ・lineage・固定化の対象にする仕組みです。[ユーザーガイド「A2UI 取り込み」](user-guide.ja.md#a2ui-取り込み他社エージェントのサーフェス向け-governance-proxydraft)、[SPEC §6.3](../spec/SPEC.ja.md#63-a2ui-プロファイル-draft) を参照してください。

**導入ラダー** — 既存の製品に kohaku を組み込む段階的な道筋です。Zero-Port quickstart から始め、Step 0(LLM なしの Server-Driven UI)、Step 1(L1 宣言的合成)、Step 2(L2・昇格・固定化)と進みます。次の段に進んでも、それまでの段は動き続けます。[ユーザーガイド §6](user-guide.ja.md#6-自分のプロダクトに組み込む) を参照してください。

**承認(approval)トークン** — `"approve"` tier の統制された Actionを実行可能にする、短命で用途が 1 つに決まったトークンです。第二の principal(承認者。依頼者本人は不可)が `POST /approvals` で発行します。トークンは特定の action・ペイロードのハッシュ・依頼者・テナントに束縛され、既定では 5 分で失効し、単回使用にもできます。capability トークンとは別のトークンドメインなので、どちらも相手として使い回せません。[SPEC §5](../spec/SPEC.ja.md#5-セキュリティ-normative)(ACT-APR-001)、[仕様 §4.7](specification.ja.md#47-任意の統制-portapprovalport--approvalstore--ratelimitstore) を参照してください。

**capability(トークン)** — compose の応答が Spec とともに返す bearer トークンです。どの `data.$ref` を読めるか、どの宣言済みの書き込み(`action.invoke`)を呼べるかを期限付きで絞り込むので、部品は LLM に認証情報を持たせることなく自分のデータを読み書きできます。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative)、[SPEC §5 セキュリティ](../spec/SPEC.ja.md#5-セキュリティ-normative) を参照してください。

**カタログ / catalogFingerprint** — カタログは、ホストが描画できる型付き UI 部品(`ComponentDefinition`)の集合で、コア部品・製品側の寄与部品・昇格済み部品を合わせたものです。`catalogFingerprint` は `type@version` の一覧をソートしてハッシュ化した値で、Spec キャッシュキーの一部になります。そのため新しい部品を publish しても、古いカタログでキャッシュされた Spec とは混ざりません。deprecated な部品はそのエントリに `!deprecated` サフィックスが付くので、部品の deprecated 化でも指紋は変わります。後述の *Intent カタログ*(登録済み Intent の集合)とは別物です。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative)、[§3.3](../spec/SPEC.ja.md#33-federated-配信-draft) を参照してください。

**カタログの deprecated 化と移行** — 部品を置き換え済みとして印を付けること(`ComponentDefinition.deprecated`。任意で `replacedBy` を指定)です。生成はその部品を提示しなくなる一方、すでにその部品で固定化された Spec は検証に通り続けます。別途の「計画してから適用する」ステップ(`kohaku migrate plan` / `apply`)で、それらの固定化を置き換え先の部品に書き換えるので、固定化が古い構造を黙って持ち続けることはありません。[SPEC §3.1](../spec/SPEC.ja.md#31-componentdefinition-normative)、[ユーザーガイド「部品を deprecated にして移行する」](user-guide.ja.md#部品を-deprecated-にして移行する) を参照してください。

**`createKohakuHost`** — あなたが実装する DomainPort と、残り 3 つの Port の動く既定値を組み合わせて REST ホストにする、`@kohaku-ui/host` の one-call ファサードです。Zero-Port quickstart から一歩進んで自分の製品に kohaku を組み込む、最短の経路です。[ユーザーガイド §6 Step 0](user-guide.ja.md#step-0--llm-なしの-server-driven-ui) を参照してください。

**デザインキット** — L2 自由生成が従うクラス名の語彙です(`DesignSystemGuide.kit`。型は `DesignKitVocabulary`)。これを渡すと、生成される部品は独自のクラス名を発明する代わりにこの語彙に従います。この語彙はデザインキットの半分でしかなく、実際の CSS は別の描画側のオブジェクト(renderer-core 組み込みの `defaultDesignKit`、または製品側が sandbox に渡す独自のもの)です。[ユーザーガイド「L2 にデザインシステムを適用する」](user-guide.ja.md#l2-にデザインシステムを適用する) を参照してください。

**開示(disclosure。AI 生成の開示)** — 画面のどこまでをモデルが作ったかを示すために、レンダラーが表示できるラベルです。L1/L2 は `ai-generated`、人が承認した固定化は `ai-assisted-reviewed`、決定的な出力やフォールバックは表示なしです。描画時に `provenance`(`tier` / `cache` / `fallback`)から導出し、Spec のフィールドには決してならないので、ペイロードを作った側が古い値を残したり偽ったりできません。[SPEC §7.1](../spec/SPEC.ja.md#71-レンダラー適合チェックリスト-normative-reference)(SPEC-DISC-001)を参照してください。

**エビデンスパック(evidence pack)** — レビュアーや監査人向けの、署名付きの監査証跡エクスポートです。lineage イベント・承認・昇格・固定化・生成された成果物をまとめたディレクトリに、マニフェストと分離 Ed25519 署名が付き、`kohaku evidence verify` で検証できます。Lineage の上に作られたエクスポート形式であり、ワイヤ上の型ではありません。[ユーザーガイド §7](user-guide.ja.md#7-運用の勘どころ)、design.md の決定 67 を参照してください。

**固定化(fixation)** — 頻出かつ構造が安定した L1 Intent を L0 に昇格させることです。構造が固定され、以後 LLM を一切通らなくなる一方、データは参照渡しのまま最新に保たれます。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative) を参照してください。

**`generatorVersion`** — Spec キャッシュキーの末尾に付く任意の要素で、プロンプトの改訂やモデルの変更をまたいで生成物を世代ごとに分けます。これを上げずにプロンプトやモデルだけを変えると、新しい出力が旧世代用のキャッシュに混ざってしまいます。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative)、[ユーザーガイド §7](user-guide.ja.md#7-運用の勘どころ) を参照してください。

**統制された Action / action tier** — `DomainPort` の操作がゲートの背後に置いた書き込み操作(`action.invoke`)です。**action tier** は `"auto"`(ゲートなし。既定)、`"confirm"`(呼び出し側が `confirmed: true` を送る必要がある)、`"approve"`(先に第二の principal が承認トークンを発行する必要がある)のいずれかです。任意の `paramsSchema` が `DomainPort.invoke` を呼ぶ前にペイロードを検証し、すべての結果は `action.*` の lineage イベントに残ります。**この tier は L0 / L1 / L2(tier ladder) とは無関係**です。後者は Spec がどう作られたかを表し、書き込みがどう認可されるかは表しません。[SPEC §5](../spec/SPEC.ja.md#5-セキュリティ-normative)、[ユーザーガイド「統制された Action」](user-guide.ja.md#統制された-action-tierauto--confirm--approve) を参照してください。

**Intent / CanonicalIntent / intentHash** — チャットの質問も GUI の操作も合流する、単一の正規化された表現が Intent です(例: `sales.quarterly_summary` + ソート済み params)。そのワイヤ形式が `CanonicalIntent` で、`intentHash`(その canonical JSON の `sha256:` 値)が Spec キャッシュキーの軸になります。同じ Intent は常に同じハッシュになるので、同じ画面になります。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative) を参照してください。

**Intent カタログ** — 製品が登録する Intent 定義(正規名・param スキーマ・クエリのマッピング)の集合です。上記のカタログ(UI *部品* の集合)とは別物です。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative) を参照してください。

**`kohaku explain` / DevTools** — 同じ `ExplainReport` を見るための 2 つの入口(CLI コマンドと、フローティングパネル `@kohaku-ui/admin-react/devtools`)です。`requestId` を 1 つ渡すと、どちらも tier・cache のヒット/ミス・キャッシュキーの内訳・実行された生成試行とその失敗理由・その要求が生成した lineage イベントの全体を示します。[ユーザーガイド「Kohaku DevTools と `kohaku explain`」](user-guide.ja.md#kohaku-devtools-と-kohaku-explain) を参照してください。

**L0 / L1 / L2(tier ladder)** — Spec が生成される 3 つの経路です。L0 は決定的な経路で、固定テンプレートか固定化済みの構造を使い LLM を通りません。L1 は宣言的合成で、LLM の仕事はカタログから部品を選んで型付き props を埋めることに限られます。L2 はサンドボックス内での自由生成で、カタログで表現できない要求のための経路です。要求は必要な分だけこの段を上がります。[SPEC §4](../spec/SPEC.ja.md#4-合成規約-normative後処理規範は-draft) を参照してください。

**Lineage** — Spec に起きたすべての出来事(合成・操作・昇格レビュー・固定化)を記録する追記専用の監査ログです。「なぜこの画面が出たか」はここから答えられます。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative) を参照してください。

**MCP Apps** — 同じ Spec と同じ描画コードを、Claude Desktop・claude.ai・ChatGPT などの MCP ホストに、文字の壁ではなく対話的なウィジェットとして届けるためのトランスポートプロファイル(SEP-1865)です。[パス (a): MCP Apps だけ](paths/mcp-apps.ja.md)、[SPEC §6.2](../spec/SPEC.ja.md#62-mcp-apps-プロファイルsep-1865-normative) を参照してください。

**プレイグラウンド**(`apps/playground`) — サンプル Web アプリ全体をブラウザタブの中だけで動かす、サーバー不要のビルドです。ストレージはインメモリの port、LLM は事前収録した fixture から答える再生専用のものに差し替えられており、そこでの操作はサーバーにも API キーにも一切届きません。[ユーザーガイド §10](user-guide.ja.md#10-静的プレイグラウンド) を参照してください。

**ポリシーファイル / レート制限** — コードが与えるコンポーズポリシーの上に、テナント別の上書き(L2 を許すか、トークン予算、ルートごとのレート制限、ロールの権限)を、再デプロイなしで重ねる宣言的な JSON ファイル(`spec/schemas/policy.schema.json`)です。レート制限はテナント・principal・ルートの種類ごとのトークンバケットで、超過したリクエストには再試行の目安付きで 429 `RATE_LIMITED` が返ります。変更したポリシーを再読み込みすると、`policy.applied` の lineage イベントが記録されます。[仕様 §5.6](specification.ja.md#56-ポリシーファイルpolicy-as-code)、[SPEC §6.1](../spec/SPEC.ja.md#61-rest-プロファイル-normative)、[ユーザーガイド §7](user-guide.ja.md#7-運用の勘どころ) を参照してください。

**Port(DomainPort / SemanticPort / AuthzPort / StoragePort)** — kohaku のフレームワーク境界をなす 4 つのインタフェースです。DomainPort はあなたのデータ/クエリ API で、どの製品も自分で書く唯一の Port です。SemanticPort は自然言語と GUI の入力を Intent に正規化します。AuthzPort は capability トークンを発行・検証します。StoragePort は Spec キャッシュ・lineage・昇格・固定化を保存します。[AGENTS.md](../AGENTS.md)、[ユーザーガイド §6 Step 0](user-guide.ja.md#step-0--llm-なしの-server-driven-ui) を参照してください。

**昇格(promotion)** — L2 で生成された部品をレビューし、型付きスキーマを与えてカタログにネイティブな L1 部品として迎え入れることです。人間の承認が常に必要で、自動で昇格することはありません。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative) を参照してください。

**provenance** — Spec のエンベロープのうち、その画面がなぜそう見えるかを記録する部分です。tier・cache の状態・モデル・`generatorVersion`・デザインキットの識別情報、発生した fallback や降格が含まれます。[SPEC §2.1](../spec/SPEC.ja.md#21-エンベロープ) を参照してください。

**QueryHandle** — L1 生成が選択肢として絞り込まれる、解決済みの `query://` 参照の識別子です。これにより LLM は、その Intent について DomainPort が実際に公開しているデータだけを指すことができ、クエリを自分で発明することはできません。[SPEC §4](../spec/SPEC.ja.md#4-合成規約-normative後処理規範は-draft)(CMP-GEN-001)を参照してください。

**`$ref`(参照渡し)** — Spec に載せてよいデータはこれだけです: `query://<source>/<path>?<params>` という URI で、あとから capability トークンを持つ部品が解決します。値そのものは載りません。この仕組みにより、あなたのデータの行がモデルのコンテキストに一切入りません。[SPEC §2.3](../spec/SPEC.ja.md#23-データバインディング参照渡し) を参照してください。

**SpecPatch** — 2 つの Spec の間の、部品単位の差分です。操作の後や、遅い L1/L2 生成をストリーミングしている最中に、Spec 全体を送り直す代わりに増分更新として送られます。[SPEC §2.5](../spec/SPEC.ja.md#25-specpatch差分更新) を参照してください。

**サーフェス(surface)** — 入力を受け取り Spec を描画するホストです。サンプルの Web ダッシュボード・チャットペイン・MCP Apps のウィジェットは、1 つの Composition Service を共有する 3 つのサーフェスです。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative) を参照してください。

**UI Spec** — compose の応答が返す宣言的な JSON 文書です。画面の構造と意味を表すデータであってコードではなく、どのレンダラーが描いても同じようにキャッシュされ描画されます。[SPEC §1](../spec/SPEC.ja.md#1-概要と用語-normative)、[SPEC §2](../spec/SPEC.ja.md#2-ui-spec-フォーマット-normative) を参照してください。

**Zero-Port quickstart** — `npx @kohaku-ui/cli init --from <データファイル>` を実行すると、CSV/JSON/SQLite ファイルから DomainPort・Intent カタログ・L0 固定 Spec・Dashboard + Chat の Web アプリまで一式が生成され、最初に書く Port コードはありません。[ユーザーガイド「Zero-Port quickstart」](user-guide.ja.md#zero-port-quickstart自分のデータからport-コードなしで) を参照してください。
