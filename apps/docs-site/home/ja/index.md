---
layout: home
hero:
  name: kohaku
  text: AI ネイティブな GUI ライブラリ
  tagline: UI をデータとして扱い、生成と描画を分離する。チャットからでも GUI からでも、同じ要求は同じ画面になる。
  actions:
    - theme: brand
      text: ユーザーガイド
      link: /ja/docs/user-guide
    - theme: alt
      text: 実装設計書
      link: /ja/docs/design
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
