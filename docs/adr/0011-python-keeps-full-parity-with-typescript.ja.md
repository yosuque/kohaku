# 0011. Python 実装は TypeScript との完全な対応を保ち、凍結はしない

- ステータス: accepted
- 日付: 2026-11-08
- 決定者: yosuque + Claude Code
- フェーズ: 実装

## コンテキストと課題

Python 実装(`python/`)は、TypeScript 実装の wire 互換の完全な移植である(conformance は CONFORMANT)。2026-11-08 の PM・EM 分析は、改善案 E9 としてこれを凍結することを提案した。案の内容は、現在の機能と wire 互換の維持に限り、新機能は TypeScript のみとし、ギャップの一覧を python/README で公開し、E4 の契約テストだけを Python にも入れる、というものだった。根拠は次のとおりである。

- Python は約 67k 行で、2026-10-05 以降のコミットの 27% が `python/` に触れている。
- それでも、本番経路の欠陥(#104、[ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.ja.md) を参照)は防げなかった。
- PyPI のダウンロード数は、実利用の証拠にならない。

メンテナーは 2026-11-08 に E9 を却下し、移植のギャップをすべて埋めるよう求めた。

## 検討した選択肢

- **選択肢A**: 完全な対応を保つ。Python に対応物のある TypeScript の変更は同じ PR で移植し、既存のギャップは埋める。
- **選択肢B**: Python の移植を凍結する(提案 E9)。メンテナーが却下した。

## 決定

採用: **選択肢A**

- **同じ PR で**: Python に対応物のある変更は、`python-mirror` の手順に従い、同じ PR で移植する。挙動の正本は TypeScript のテストである。移植では、そのケースを 1 対 1 で Python のテストに写し、対応は WP のレポートに記録する。
- **既存のギャップを解消**: python/README の「Not yet ported」の項目と、恒久的な差として書かれていた二つ(MCP Tasks、`migrateProps`)は、2026-11 の run でいずれも移植した。`migrate_props`(#117)、`kohaku.semantic_llm`(#119)、MCP Tasks(#120)、promotion レビュー機能(#123)、`kohaku.authz_hmac`(#125)、`kohaku.authz_jwt`(#126)、redis / postgres の StoragePort(#129)である。run のほかの WP(#115、#121、#122、#124、#127、#128)は、それぞれ Python のミラーとともに納めた。
- **決定的な出力**(トークンのバイト列、ストレージのキーと行の形、キャッシュキーと fingerprint の材料、純関数の結果)は、言語間の golden fixture で固定し、両言語で一致させる。
- **構成**: Python に新しいサブパッケージを足すときは、TypeScript の依存の向きに従う層を import-linter の契約に足す。外部ライブラリは extra として足し、下限の版は [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.ja.md) の方針で決める。
- **例外**: Python に対応物の無いものだけが TypeScript 専用に残る。`cli`、`docs-site`、GitHub Actions、`admin-react` である。`admin-react` は React の UI で、wire が同一なので、TypeScript の `admin-react` が Python のホストに対してそのまま動く。

### 理由

- メンテナーの判断である。#104 を完全な対応が防げなかったという提案の指摘には、Python の範囲を減らす代わりに、別の手段で対応した。PR #115 の契約テストが、#104 に欠けていた「本物のプロバイダー SDK を通す検査」を両言語に入れる。
- golden fixture と 1 対 1 のテスト移植があるので、対応が崩れると、後から見つかるずれではなく、失敗するテストとして現れる。

## 結果(トレードオフ)

- 良い影響: python/README のギャップの一覧に残るのは `admin-react` だけになった。Python の redis / postgres アダプタは TypeScript とデータ互換なので、両言語のホストが一つのバックエンドを共有できる。決定的な出力はバイト単位で一致する。
- 受け入れるコスト / 悪い影響:
  - Python に対応物のある TypeScript の変更は、そのたびに、約 67k 行の第二の実装への移植作業を同じ PR で負う。
  - README の `admin-react` の記述は、まだ「Not yet ported」のままである。これを TypeScript 専用に分類し直す作業が残っている。
- 見直し条件: 却下の見直し条件は、資料に記録されていない。E9 の根拠(Python の保守の負荷と、PyPI のダウンロード数しか利用の目安が無いこと)が、この問いを再び開く証拠になる。

## 参考

- `research_notes/pm-analysis-2026-11-08/improvement-proposals.md` の提案 E9(git の管理外で、メンテナーのチェックアウトにある)と、2026-11 実装計画の §11
- PR: #117、#119、#120、#123、#125、#126、#129
- python/README の「Not yet ported」の一覧、AGENTS.md の「Python implementation」
- [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.ja.md)、[ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.ja.md)
