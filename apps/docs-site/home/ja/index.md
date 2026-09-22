---
layout: home
hero:
  name: kohaku
  text: AI ネイティブな GUI ライブラリ
  tagline: UI をデータとして扱い、生成と描画を分離する。チャットからでも GUI からでも、同じ要求は同じ画面になる。
  actions:
    - theme: brand
      text: なぜ kohaku か
      link: /ja/docs/why-kohaku
    - theme: alt
      text: ユーザーガイド
      link: /ja/docs/user-guide
    - theme: alt
      text: GitHub
      link: https://github.com/yosuque/kohaku
features:
  - title: 同一表示の構造的保証
    details: チャットと GUI は同じ正規化 Intent と同じキャッシュ済み UI Spec に収束する。temperature 0 は補助であり保証ではない。
  - title: 参照渡しのデータ
    details: Spec が運ぶのは query:// 参照だけで数値は運ばない。LLM が組むのは配管であり、水は流れない。
  - title: 統制された生成
    details: L0 固定 ⇄ L1 宣言的合成 ⇄ L2 自由生成。うまくいったものを昇格パイプラインで正式部品に固める。
---

## パスを選ぶ

| あなたは… | ここから | 最初のコード |
|---|---|---|
| MCP サーバー作者 | [パス (a): MCP Apps だけ](/ja/docs/paths/mcp-apps) | `attachKohakuToMcpServer` 1 回 |
| Server-Driven UI を今すぐ、LLM は後で、というプロダクトチーム | [パス (b): React ダッシュボードだけ](/ja/docs/paths/react-dashboard) | 手書きの Spec + `<SpecView>` |
| モデルが合成した UI を本番に載せるチーム | [パス (c): フル構成](/ja/docs/paths/full-stack) | 30 行の統制付き REST ホスト |
