# ドキドキベースボール 開発仕様（v0.1）

GitHub Pages で配信する静的 HTML/CSS/JS の野球ゲーム。ビルド不要、外部依存なし（Google Fonts のみ）。
デザイン: https://claude.ai/artifact/6eSALzd4dFwWdR2sJDuwjq （1280×720 固定ステージ、ウィンドウに合わせ拡縮）

## ファイル構成と担当

```
index.html          ステージ(#stage 1280x720)と各画面の <section> を持つ。script は type=module で js/main.js のみ読む
css/style.css       配色トークン・画面レイアウト（デザイン4画面を再現）
js/data.js          チーム・選手データ（export const TEAMS）
js/engine.js        試合ロジック（純粋関数・DOM非依存）
js/game.js          試合画面の描画と入力（ストライクゾーン、カーソル、投球アニメ）
js/screens.js       タイトル / チーム / 結果 画面の描画
js/main.js          画面遷移・状態保持・キー/タッチ入力の配線
.github/workflows/pages.yml  GitHub Pages デプロイ
```

## 配色トークン（CSS変数）
--sky #3D8BE8 / --grass #4CAF50 / --grass-dark #3E9142 / --dirt #C9955F / --navy #1C2B4B / --navy-2 #34476E
--accent #FFD54A / --red #E5484D / --blue #1E88E5 / --paper #EAF2FB / --muted #5B6B8A / --muted-light #B8C4DB
ランク色: S #FF4FA3, A #E53935, B #F57C00, C #FDD835(文字navy), D #43A047, E #1E88E5, F #757575, G #9E9E9E
フォント: 'M PLUS Rounded 1c'

## データモデル (js/data.js)

```js
export const TEAMS = [
  {
    id: 'red', name: 'レッドスターズ', short: 'R', color: '#E5484D',
    lineup: [ /* 9人 playerId の順 = 打順。守備位置は player.pos */ ],
    pitchers: [ /* 先発→中継ぎ→抑え の playerId */ ],
    players: [ Player ... ]
  }, { id: 'blue', ... }
];
// Player
{ id:'r1', name:'速水 翔', number:1, pos:'中', bats:'右', throws:'右', age:24,
  trajectory:2,                      // 弾道 1-4
  contact:72, power:85, speed:48, arm:60, fielding:52, catching:63,   // 1-99
  pitching: null | { velocity:148, control:55, stamina:70,
                     pitches:[{type:'slider',name:'スライダー',level:3}, ...] },
  skills:['チャンス◎','パワーヒッター'] }
export function rank(v)   // 数値→'S'..'G'  (90+ S, 80 A, 70 B, 60 C, 50 D, 40 E, 20 F, else G)
```

## エンジン API (js/engine.js) — すべて純粋関数、Math.random は引数 rng で注入可能

```js
export function createGame(homeTeam, awayTeam, { innings = 9 } = {})  // GameState
export function getBatter(state)      // 現在の打者 Player
export function getPitcher(state)     // 現在の投手 Player
export function resolvePitch(state, pitchInput, batInput, rng = Math.random)
  // pitchInput: { type:'fastball'|'slider'|'fork'|'curve', zone:{x:0-2,y:0-2} }  CPU側は choosePitch(state,rng) で生成
  // batInput:   null(見送り) | { zone:{x,y}, mode:'meet'|'power', timing:-1..1 }
  // 戻り値: { state(新), event } event = { kind:'ball'|'strike'|'foul'|'hit'|'out'|'hr'|'walk'|'strikeout', text:'実況テキスト', runs:n, ... }
export function choosePitch(state, rng)      // CPU投手の配球
export function chooseSwing(state, pitch, rng) // CPU打者のスイング
export function isGameOver(state)
export function boxScore(state)  // { innings:[[away..],[home..]], R:[a,h], H:[a,h], E:[a,h], mvp:Player, pitchers:{win,lose,save} }
// GameState
{ inning:1, half:'top'|'bottom', outs:0, balls:0, strikes:0, bases:[bool,bool,bool],
  score:{away:[], home:[]}, hits:{away:0,home:0}, errors:{away:0,home:0},
  batterIndex:{away:0,home:0}, pitcherIndex:{away:0,home:0}, pitchCount:{away:0,home:0},
  stats:{ [playerId]: { ab, h, hr, rbi, so, bb, ip_outs, er, k } }, log:[event...], over:false,
  teams:{ away:Team, home:Team }, userSide:'away'|'home' }
```

## 画面遷移 (js/main.js)
title → (たいせん) game → result → title / game。title → team → game。
入力: 矢印キー=コース移動、Z=ミート/投球、X=強振/変化球、Enter=決定、Esc=戻る。タッチボタンも同じハンドラを呼ぶ。
ユーザーは先攻（away, レッドスターズ）を操作。攻撃時は打撃、守備時は投球（球種選択→コース→Z）。
