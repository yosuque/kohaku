# 0005. compare-and-set は StoragePort の任意の拡張とする

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 設計

## コンテキストと課題

複数のホストインスタンスが一つの redis または postgres を共有すると、二つのインスタンスが promotion 状態や fixation の更新を黙って失うことがあった。プロセス内の keyed mutex が順序づけられるのは同じプロセスの中の呼び出しだけで、SPEC 付録 12 は compare-and-swap を対象外としていた。メンテナーは、失われた書き込みを `409 CONFLICT` として見せ、ホストは自分では再試行しないと決めた。残る問いは二つあった。既存のアダプタを壊さずに、これを `StoragePort` の契約にどう加えるか。そして各バックエンドが、これをどう正しく実装するか。

## 検討した選択肢

- **選択肢A**: 任意で、宣言する拡張にする。ポートが `supportsCompareAndSet: true` を宣言し、`putPromotionState`、`putFixation`、`deleteFixation` の三値の `expectedRevision`(省略 = 無条件、`null` = 存在してはならない、文字列 = 一致しなければならない)を守る。不一致のときは書き込まずに `StorageConflictError` を投げる。
- **選択肢B**: すべての `StoragePort` に compare-and-set を必須とする。
- **選択肢C**: ホスト側の分散ロックを使う。

wp-e8b のレポートは、選択肢Aを「必須の CAS 契約や、ホスト側の分散ロックの代わりに」採ったと記録している。BとCを採らなかった理由は、下の「理由」に書いた以上のことは記録されていない。

採らなかった案が記録されている、次の下位の判断もある。

- **file ポート**: 拡張を宣言する(レビューで退けた)か、しないか。
- **一括の nomination**: バッチの `putPromotionStates` に項目ごとの expectation を持たせる(退けた)か、候補ごとに条件付き書き込みをするか。
- **Redis(TypeScript)**: 共有接続上のすべての `MULTI` を直列化する(退けた)か、専用の接続で `WATCH` を使うか。

## 決定

採用: **選択肢A**

- **契約**: `StoragePort.supportsCompareAndSet`、`PromotionState.revision?`(既存の `FixationRecord.revision?` に並ぶ)、三値の `expectedRevision`、spec-core の `StorageConflictError`(`code: "STORAGE_CONFLICT"`)。バッチの `putPromotionStates` には expectation を持たせない。
- **ホスト**: `StorageConflictError` は `409 CONFLICT` と固定メッセージ `the resource was modified concurrently; reload and retry` になる。storage エラー自身の文面は載せない。ホストは再試行しない。MCP は同じ固定メッセージをツールエラーとして返す。REST は競合のたびに `onError` へ `storage.conflict` として報告する。SPEC では REST-CONF-001(SHOULD [Draft]、参照実装のテストで検証)として定めた。
- **memory ポート**: 拡張を宣言し、`singleProcess: true` も持つ。
- **file ポート**: `expectedRevision` は守る(プロセス内ロックの中で、ディスクから読み直したスナップショットと比べる)が、`supportsCompareAndSet` は宣言しない。同じプロセスの中の呼び出しだけを順序づけるロックは、プロセスをまたぐと原子的でなく、`sample-api` と `sample-mcp` が一つの `.data` を共有する構成が文書化されているからである。代わりに `singleProcess: true` を持つ。`createKohakuHost` は、どちらも宣言しないカスタムポートに対して一度だけ警告する。
- **Redis(TS)**: 専用の、遅延して開く接続で `WATCH` / `GET` / `MULTI` / `EXEC` を使う(Lua は使わない)。接続は `enableOfflineQueue: false`、`autoResendUnfulfilledCommands: false` とし、mutex で直列化する。`EXEC` の直前に `ready` イベントの epoch を確かめ、再接続でサーバー側の `WATCH` が黙って失われた場合は競合として扱う。
- **Redis(Python、PR #129)**: `Pipeline.watch` を使う。トランザクションの間、プールした接続を一本占有するので、プロセス全体の mutex も epoch も要らない。競合になるのは `EXEC` が null を返すとき(redis-py の "Watched variable changed")だけである。WATCH 中の通信エラーは再送出する。`EXEC` が適用された後に起きた可能性があり、それを「競合、何も変更していない」と報告するのは誤りだからである。
- **Postgres**: DDL は足さない。条件付きの `UPDATE ... WHERE (payload::jsonb ->> 'revision') = $n` / `INSERT ... ON CONFLICT DO NOTHING` / `DELETE` を一つ実行し、`rowCount` で判定する。SQLSTATE `40001` も同じ競合に対応づける。
- **Promotion**: `nominateEligible` は、スキャンで読んだ revision(状態が無ければ `null`)を条件に、候補ごとに `putPromotionState` で書く。競合に負けた候補は飛ばし、その候補の `component.nominated` は記録しない。`act()` は、監査イベントを記録する直前に保存済みの revision を読み直す。「監査が先、状態が後」の順序は保つ。
- **Fixation**: `unfixate`、`replace`、`invalidate`、`refreshFingerprint` は、読んだ revision を渡す。自己修復の二つ(`invalidate`、`refreshFingerprint`)は、競合に負けたら何もしない。他のインスタンスがすでに直したからである。`unfixate` と `replace` は人の判断なので、競合を呼び出し元に見せる。`fixate` は引き続き、人が行う無条件の上書きである。

### 理由

- 任意で宣言する拡張にすれば、既存のアダプタとフェイクのポートはそのまま有効で(オプションを無視する)、共有バックエンド用のアダプタだけがこの穴を塞げる。
- ホストが再試行しないのは、競合が、その間に人か別のインスタンスが何かを決めたことを意味するからである。同じ遷移を機械的にやり直すと、取り下げの上から公開してしまうおそれがある。
- 一括の nomination ではバッチ書き込みを使えない。無条件のバッチは、スキャンの後で別のインスタンスが記録した approve を巻き戻してしまう。`putPromotionStates` に項目ごとの expectation を持たせる案もあったが、安価で繰り返せる処理のために、すべてのアダプタのバッチ経路を複雑にしてしまう。そのため候補ごとの条件付き書き込みを選んだ。
- 共有のパイプライン接続では、`WATCH` の状態が接続に属し、ほかの `MULTI` の `EXEC` がそれを消してしまう。専用の接続にするのはそのためである。
- file ポートが拡張を宣言しないのは、宣言すると、持っていない原子性を主張することになるからである。

## 結果(トレードオフ)

- 良い影響: 共有の redis / postgres 上の同時書き込みは、成功が一件、409 が一件になる(一つの CAS ストアに二つのアプリを置くテストで確認。TS と Python)。既存のアダプタは変更なしで動く。プロセス内の mutex は残り、同じプロセスの中の直列化は引き続き担う。
- 受け入れるコスト / 悪い影響:
  - **孤立したイベントは、許容して文書化した。直してはいない。** `act()` の読み直しで窓は狭まるが、閉じることはできない。approve の条件付き保存が競合に負けて適用されなかった(呼び出し元には 409 が返る)場合でも、その approve の `component.reviewed` イベントが記録されていることがある。reconcile はスナップショットだけを読むので、これを無視する。evidence-pack や分析の読み手は、イベントではなくスナップショットを正として扱わなければならない。
  - ローリングアップグレード: `revision` より前の(または読めない)レコードは、最初の一回だけ無条件に書かれ、そのとき revision が付く。古い版のままの書き込み側は無条件に上書きするので、拡張に頼る前にすべての書き込み側を更新する必要がある。
  - file ポートで一つの `.data` ディレクトリを複数のプロセスが共有すると、更新を失うことが引き続きありうる。
  - 古い `StoragePort` のシグネチャを使うカスタム Python ポートは、キーワード専用の `expected_revision` 引数が増えたため型検査で失敗する。ただし実行時は動く。lineage のサービスは、`supports_compare_and_set` を宣言したポートにしかそのキーワードを渡さないからである。
  - Python の redis アダプタは、TS の設計と意図的に異なる(専用接続も mutex も epoch も使わない)。条件付き書き込みの間、プールした接続を一本持つ。
- 見直し条件: 孤立した `component.reviewed` を打ち消すイベントが必要になったとき(wp-e8b で ADR の候補として記録された)。

## 参考

- PR: #127(拡張本体、TS と Python)、#129(Python の redis / postgres アダプタ)
- design.md の決定 #79、SPEC 付録 12 と REST-CONF-001
