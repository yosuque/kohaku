# @kohaku-ui-sample/wc — 非 React レンダラーの実演(Vanilla + Web Components)

[English](README.md) | 日本語

`<kohaku-surface>`(`@kohaku-ui/renderer-wc`)で、sample-api の compose 結果を **React ゼロ**で描画する
Vanilla ページ。中核主張「宣言的 UI Spec はレンダラー非依存」を、React 版(sample-web)と同一の Spec を
別レンダラーで描くことで実証する。

## 起動

2 つのプロセスを別ターミナルで起動する(ルートから):

```bash
# 1) ホスト(sample-api、:8787)
pnpm --filter @kohaku-ui-sample/api dev

# 2) この実演ページ(:5174。/api は :8787 にプロキシ)
pnpm --filter @kohaku-ui-sample/wc dev
```

ブラウザで <http://localhost:5174> を開く。ルートの `pnpm dev`(sample-api + sample-web)には混ぜていない
(独立起動)。LLM は不要 — quarterly_summary は決定的な固定 Spec 経路で返る。

ページの chrome と Spec の描画メッセージは既定で英語。URL に `?lang=ja` を付ける
(<http://localhost:5174/?lang=ja>)と、RendererMessages の i18n オーバーライドで Spec のメッセージが
日本語で描画される(i18n デモ。ページの chrome は英語のまま)。

## 見どころ

- **A1 双方向バインディング(クロスフィルタ)**: 地域セレクトを変えると、`control.select` → `state.set` →
  `data.bind` の effective ref がクライアント側で再解決される(compose を撃たない)。capability は初期 compose で
  全 region variant の `/binding/resolve` を通すよう発行済み。
- **サーバー再合成**: 表の行クリック(`intent.patch`)は `/events` に流れ、新しい Spec で再描画される。
- **統制(SPEC-EVT-002)**: Spec の `events` に宣言されたイベントのみが `onEvent` /
  `CustomEvent("kohaku-event")` に届く。`state.set` は Renderer 内で完結し上流に出ない。

## 実装メモ

- 依存は `@kohaku-ui/client`(型付き REST クライアント)・`@kohaku-ui/renderer-wc`・`@kohaku-ui/spec-core` のみ。
  React・ビルドプラグインは使わない。
- テーマトークンは sample-web と同一値(`src/theme.ts`)。両レンダラーが同じ値を inline 展開するため
  chart 以外は見た目が一致する(chart は Recharts vs inline SVG で意味的同等に留める)。
