# ドキドキベースボール

パワプロ風のブラウザ野球ゲーム。ビルド不要の静的 HTML / CSS / JavaScript で、GitHub Pages で配信します。

- デザイン: https://claude.ai/artifact/6eSALzd4dFwWdR2sJDuwjq
- 仕様: [docs/SPEC.md](docs/SPEC.md)

## 遊び方

| 操作 | キー | タッチ |
| --- | --- | --- |
| コース移動 | 矢印キー | 十字ボタン |
| ミート打ち / 投球 | Z | 黄ボタン |
| 強振 / 球種切替 | X / ←→ | 赤ボタン |
| 決定 / 見送り | Enter | - |
| 戻る | Esc | メニュー |

## ローカルで動かす

```sh
python3 -m http.server 8000
# http://localhost:8000 を開く
```

## テスト

```sh
node --test tests/
```

## GitHub Pages

`main` ブランチへの push で `.github/workflows/pages.yml` が自動デプロイします。
初回のみ、リポジトリの Settings → Pages → Source を「GitHub Actions」にしてください。

## クレジット

- 球審ボイス: VOICEVOX:青山龍星（詳細は [assets/voice/CREDITS.md](assets/voice/CREDITS.md)）
- 音楽・効果音: ブラウザ内で合成したオリジナル
