# エンジン API（js/engine.js）— 選手交代・打球/守備・走塁

`docs/SPEC.md` のエンジン API の拡張版です。すべて **純粋関数**（入力 state は変更せず新しい state を返す）、DOM 非依存、乱数は引数 `rng`（既定 `Math.random`）で注入します。
従来の API（`createGame` `getBatter` `getPitcher` `resolvePitch` `choosePitch` `chooseSwing` `pitchLocation` `isGameOver` `summary` `boxScore` `simulateGame` `changePitcher`）はそのまま使えます。

> state 内のログイベント・選手オブジェクト・打球（`ball`）は新旧 state で**共有される不変データ**です。UI 側でこれらを書き換えないでください。

---

## 1. データ（js/data.js）

```js
Team = {
  id, name, short, color,
  lineup:   [9 ids],          // 打順。9番は先発投手。守備位置は player.pos（投手は '投'）
  pitchers: [6 ids],          // 先発, 先発, 中継ぎ, 中継ぎ, 中継ぎ, 抑え
  bench:    [5 ids],          // 控え野手: 代打の切り札, 代走要員, 控え捕手, ユーティリティ×2
  players:  [19 Player],
}
Player += {
  positions: ['遊','二','三'],  // 守れる守備位置（先頭 = 本職 = pos）。投手は ['投']
  pitching: { role: 'starter'|'reliever'|'closer', velocity, control, stamina, pitches },  // 投手のみ
  model: '…',                  // 能力値のモデルにした実在選手タイプ（実名なし）
}
```

| | レッドスターズ | ブルーウェーブス |
|---|---|---|
| 代打の切り札 | r9 桜井 光（右/左/一） | b9 千早 陸（左/一/右） |
| 代走 | r16 疾風 走（走力95） | b16 韋駄 天馬（走力93） |
| 控え捕手 | r17 岩永 守 | b17 堀 慎之介 |
| ユーティリティ | r18 宮坂 誠（遊二三）, r19 森 健吾（三一左右） | b18 真田 凌（二遊三一）, b19 大河内 武（一三右） |
| 追加の中継ぎ | r14 柏木 隼人, r15 早瀬 圭 | b14 橘 涼介, b15 小早川 楓 |

## 2. GameState の追加・変更フィールド

```js
state.bases       = [id|null, id|null, id|null]   // 一塁・二塁・三塁の走者 id（truthy = 走者あり。旧UIの判定もそのまま動く）
state.positions   = { away: { [playerId]: '投'|'捕'|'一'|'二'|'三'|'遊'|'左'|'中'|'右' }, home: {...} }  // 打順の9人の現在の守備位置
state.removed     = { away: [ids], home: [ids] }  // 交代で退いた選手（再出場不可）
state.provisional = { away: id|null, home: id|null } // 自動登板した投手（1球も投げる前なら changePitcher で替えても removed にならない）
state.pending     = null | { ballId, ball, batterId, pitcherId, event }  // pitchContact 後、resolveBattedBall 前の打球
state.teams[side].lineup / pitchers / bench       // 交代で書き換わる（pitcherIndex は pitchers 内の位置）
```

`summary(state)` の追加:

```js
summary(state).bases    // [bool, bool, bool]（従来どおり）
summary(state).runners  // [{ id, name, speed } | null] ×3
summary(state).pending  // boolean（打球処理待ち）
```

## 3. 定数・ヘルパー

```js
POSITIONS  = ['投','捕','一','二','三','遊','左','中','右']
POS_NAMES  = { 投:'ピッチャー', 捕:'キャッチャー', 一:'ファースト', 二:'セカンド', 三:'サード', 遊:'ショート', 左:'レフト', 中:'センター', 右:'ライト' }
FIELD = {
  home: {x:0,y:0},
  bases: { 1:{x:19.4,y:19.4}, 2:{x:0,y:38.8}, 3:{x:-19.4,y:19.4}, 4:{x:0,y:0} },  // 4 = 本塁
  mound: {x:0,y:18.4}, baseDistance: 27.4, fenceLine: 98, fenceCenter: 122, foulAngle: 45,
}
// 座標はメートル。本塁 (0,0)、+y = センター方向、+x = 一塁（ライト）側。
DEFAULT_POSITIONS = {   // 通常守備の定位置
  投:{x:0,y:18.4}, 捕:{x:0,y:-1.5}, 一:{x:17,y:25}, 二:{x:11,y:38}, 三:{x:-17,y:25},
  遊:{x:-11,y:38}, 左:{x:-28,y:80}, 中:{x:0,y:92}, 右:{x:28,y:80},
}
fenceDistance(dirDeg) → m        // 両翼98m〜中堅122m（角度で線形補間）
battingSideOf(state) / fieldingSideOf(state) → 'away'|'home'
ballPositionAt(ball, t) → {x,y,z} // 打球の時刻 t（打った瞬間=0 秒）の位置（path を線形補間）
fielderParams(player, pos) → { react, runSpeed, reachGround, reachAir, catchHeight, arm, fld, eligible }
  // 守備 AI と同じ能力換算。UI で野手を動かす速度（runSpeed m/s）・反応時間（react 秒）・捕球半径（reach m）に使える。
  // 本職でない守備位置（eligible=false）は守備力 -25。投手は反応 +0.35 秒・守備範囲 ×0.6。
throwTimeFor(state, fielderId, from:{x,y}, base:1|2|3|4) → 秒（握り替え＋送球。CPU と同じ式）
```

## 4. 選手交代

すべて新しい state を返し、違反時は日本語メッセージの `Error` を throw します。打球処理中（`state.pending`）や試合終了後は不可。
成功すると `state.log` に `{ kind:'sub', subType, side, text, inId, outId, ... }` が追加されます。

| 関数 | 説明 |
|---|---|
| `availableBench(state, side)` → `Player[]` | 未出場の控え野手（退いた選手・出場中を除く） |
| `availablePitchers(state, side)` → `Player[]` | 未登板の投手（現在の投手・退いた投手を除く） |
| `lineupView(state, side)` → `[{ slot, id, name, pos, isPitcher, eligible, player }]` | 現在の打順（0始まり slot）と守備位置。eligible=本職の守備位置か |
| `changePitcher(state, side, playerId \| index?)` | 投手交代（**守備中のチームのみ**）。新投手は旧投手の打順に入り、スタミナは満タン。旧API の index（pitchers の番号）も可、省略時は CPU と同じ選択。`subType:'pitcher'`、text `'ピッチャー、青山に代わりまして藤代。'` |
| `pinchHit(state, side, playerId)` | 代打（攻撃中のチーム、次の投球前ならカウント途中でも可。カウントは引き継ぐ）。打順と守備位置を引き継ぐ。`subType:'pinch_hit'`、text `'代打、赤城に代わりまして桜井。'` |
| `pinchRun(state, side, baseIndex 0..2, playerId)` | 代走（その塁に走者が必要）。`state.bases[baseIndex]` と打順を置き換え、守備位置を引き継ぐ。`subType:'pinch_run'` |
| `defensiveSwap(state, side, changes)` | `changes = [{ playerId, pos, replaces? }]`。出場中の選手なら守備位置の変更、控え（野手・未登板投手）なら途中出場。途中出場の選手は、変更後に守備位置を奪われた選手の打順に入る（`replaces` で退く選手を明示可）。結果が9つの守備位置ちょうど1人ずつでなければエラー。途中出場は守備中のチームのみ（位置の入れ替えはいつでも）。'投' が別の選手になれば投手交代として扱う。`subType:'defense'` |
| `cpuManage(state, rng)` → `{ state, events[] }` | CPU 側（`userSide` でないチーム）の采配。打席終了ごとに `resolvePitch` / `pitchContact` / `resolveBattedBall` が**自動で呼ぶ**ので通常 UI から呼ぶ必要はない |

退いた選手（`state.removed`）は二度と出場できません。

**投手に代打・代走を出した場合**: そのチームが守備につく時（攻守交代時）に、エンジンが未登板の投手を自動登板させ（`subType:'pitcher', auto:true` のログ、イベント text にも追記）、代打/代走の選手は退きます。ユーザー側はその投手が1球も投げる前なら `changePitcher` で別の投手に替えられ、自動登板の投手は控えに戻ります（`state.provisional`）。

**CPU 采配**（ユーザー側には何もしない）:
- 投手交代: スタミナ 25 未満、8回以降の先発、9回以降 1〜3点リードで抑え（中継ぎ→先発→抑えの順に未登板から）
- 代打: 7回以降・点差2以内で、投手または弱い打者（ミート+パワー < 108、捕手以外）に控えの強打者（控え捕手・代走要員は温存）
- 代走: 8回以降、同点/勝ち越しの走者が鈍足（走力 < 55）なら俊足（走力 ≥ 80）の控え
- 守備固め: 代打・代走の選手が本職でない守備位置に就いたら、攻守交代時に控えの本職と交代

## 5. 打球と守備（分割 API）

```
pitchContact ──(ball=null)───────────────────────────→ 完了（ボール/ストライク/ファウル/四球/三振）
     │
     ├─(ball.isHomeRun)──────────────────────────────→ 完了（state 進行済み、ball.path でアニメ）
     │
     └─(ball, state.pending)→ ユーザー守備 or autoField → resolveBattedBall → 完了
```

### `pitchContact(state, pitchInput, batInput, rng)` → `{ state, event, ball }`

- 打球なし: `resolvePitch` と同じ（`ball = null`、event も従来どおり、state 進行済み）。
- 本塁打: 即時に反映（state 進行済み）。`event.kind = 'hr'`、`ball.isHomeRun = true`、`ball.path` あり。
- それ以外の打球: **アウト・走者・得点は未処理**。投球数・スタミナのみ更新し `state.pending = { ballId, ... }`。`event = { kind:'inplay', text:'打った！', ball, pitch, batter, pitcher, ... }`。
  この state のまま次の `pitchContact` / `resolvePitch` を呼ぶとエラー。選手交代も不可。

### Ball

```js
{
  id: 'ball-12',
  type: 'grounder' | 'liner' | 'fly' | 'popup' | 'hr',
  dirDeg,            // -45 = 三塁線 … 0 = センター … +45 = 一塁線
  exitSpeed,         // 打球速度 km/h
  launchDeg,         // 打球角度（ゴロ以外）
  landing: {x, y},   // 最初の着地点（ゴロは誰も捕らなかった場合に止まる地点）
  rest: {x, y},      // 最終的に止まる地点（フェンスで止まる。本塁打は着地点）
  distance,          // 着地点（ゴロは停止点）までの距離 m
  hangTime,          // 最初の着地までの秒数（ゴロは 0）
  endTime,           // path の最後の時刻
  path: [{ t, x, y, z }],  // 0.05 秒ごと、打った瞬間 t=0 から停止まで。z = 高さ m（ゴロは小さなバウンド）
  isFoul: false, isHomeRun, batterId,
  intendedOutcome,   // 打撃判定の結果 'groundout'|'flyout'|'single'|'double'|'triple'|'hr'
  runAggro,          // この打球での走者の積極性（-0.3〜0.3、内部用）
}
```

打球は「CPU 守備（エラー・送球誤差なし）で処理すると intendedOutcome になる軌跡」を棄却サンプリングで選んでいます。
そのためユーザーが CPU より上手く守ればヒット性の当たりをアウトにでき、下手なら凡打がヒットになります。

### `autoField(state, ball, rng)` → fielding（CPU の守備）

最も早く打球に追いつく野手を計算（定位置・反応時間・走力・捕球半径・捕球可能高さ 2.8m）。ノーバウンドで届けば `caughtInAir: true`。
送球先は CPU 判断（ゴロ: 封殺できる先頭の塁→無理なら一塁、外野: 本塁を狙う走者など）。`rng` でエラー判定（約 0.5 個/試合）。

```js
{ caughtInAir, fielderId, fielderPos, fieldedAt:{x,y}, fieldTime, throwTo: 1|2|3|4|null, error, auto: true, estThrowTime? }
```

ユーザーが打撃中のプレーの CPU 守備にも使えます（`fieldedAt` / `fieldTime` で野手アニメ、`event.runnerResults` で走者アニメ）。

### `resolveBattedBall(state, ball, fielding, rng)` → `{ state, event }`

`state` は pitchContact が返した pending あり state、`ball` は同じ打球。

```js
fielding = {
  caughtInAir: boolean,      // ノーバウンド捕球
  fielderId: string,         // 打球を処理した野手（守備中のチームの打順の9人のいずれか）
  fieldedAt: {x, y},         // 捕球・処理した地点（省略時 ball.landing）
  fieldTime: number,         // 打った瞬間から確保までの秒数
  throwTo: 1|2|3|4|null,     // 送球先（4=本塁）。null=投げない
  throwArriveAt?: number,    // 送球が塁に届く時刻（打った瞬間からの秒）。あれば最優先
  throwTime?: number,        // 送球にかかる秒数（arrive = fieldTime + throwTime）
  error?: boolean,           // エラー（捕球ミス: 処理が 1.5 秒遅れ、送球によるアウトなし、安打にならない）
  // diving, throwStartAt など他のフィールドは無視される
}
// throwArriveAt も throwTime も無ければ、野手の肩・距離から計算（+ 送球誤差 σ0.2 秒）
```

**走塁モデル**
- 打者の一塁到達: 4.9 秒（走力1）〜 4.6 秒（走力99）、以降の塁間 約3.6〜4.5 秒（+ 回り込み 0.2 秒）
- 走者: 7.0〜8.6 m/s、最初の塁間はリード 4m 分短い
- スタート: 打者は打った瞬間。走者はゴロなら打った瞬間（内野ゴロで封殺されない走者は帰塁、2死なら全員スタート、右方向のゴロなら二塁走者は三塁へ）、ライナー 0.5 秒後、フライは様子を見て `0.25×hangTime`（最大 1.2 秒）後、2死なら全員打った瞬間。ノーバウンド捕球ならタッチアップ（捕球時刻からリードなしでスタート）。
- 進塁判断（送球前に決定）: 次の塁への到達時刻 + 余裕（0.2 秒、2死は 0、打球ごとの積極性 ±0.3）が「野手が直接送球した場合の到達時刻 + タッチ 0.15 秒」より早ければ進む。前の走者は追い越さない。
- 送球先の走者: フォースなら `走者到達 > 送球到達` でアウト、タッチプレーは +0.15 秒。
- 併殺: 内野ゴロで一塁以外でフォースアウトを取り、打者が一塁へ走っていれば自動で一塁へ転送（中継: 二塁は遊撃/二塁手、三塁は三塁手、本塁は捕手）。転送が打者より早ければダブルプレー。
- 外野からの本塁・三塁送球の間に、打者走者は空いていれば次の塁へ（`runnerResults` の `to` が増える）。
- 3アウト目がフォースアウト／打者の一塁アウト／フライ捕球なら得点なし。タッチアウトならそれより先に生還した走者の得点は有効。

**event**

```js
{
  kind: 'hit' | 'out' | 'double_play' | 'error' | 'fielders_choice' | 'sac_fly' | 'hr',  // 'hr' = ランニングホームラン
  text: '霧島 健、ライト前ヒット！ 二塁ランナー一気にホームイン！ 1点追加！',
  runs,                // このプレーの得点
  bases,               // 安打の塁打数 1-3（4 = ランニングHR）、安打以外は 0
  outsMade,            // このプレーで増えたアウト数
  outcome,             // 'single'|'double'|'triple'|'hr'|'groundout'|'flyout'（旧 UI のアニメ用）
  intendedOutcome, ballId, ball, fielding,
  fielderId, fielderPos, throwTo, throwArrive,     // throwArrive = 送球到達時刻（秒）
  doublePlay, sacFly, error,                       // 旧形式のフラグ
  runnerResults: [{ id, from: 0|1|2|3, to: 1|2|3|4|null, out, arrive }],  // from 0 = 打者。to null = アウト。arrive = 目標の塁への到達時刻
  pitch, batter, pitcher, swing, dist, band, mode,
  endHalf?, pitcherChange?, subs?: [subイベント],   // 打席終了処理（チェンジ・CPU 采配）の結果
}
```

成績: 安打（ab/h、塁打）、凡打・併殺・野選・エラー（ab）、犠飛（ab なし・打点）、打点は併殺・エラー以外の得点、エラーは `state.errors[守備側]`（boxScore の E）。エラーでの失点は自責点にしない。
アウト・得点・イニング交代・サヨナラ・試合終了は従来と同じ処理です。

### UI 用ヘルパー（任意）

```js
makeFielding(state, ball, { fielderId, fieldTime, throwTo?, throwTime?, error?, caughtInAir? }) → fielding
  // fieldTime 時点の打球位置を fieldedAt にし、滞空中かつ高さ <= 2.8m なら caughtInAir=true。
  // throwTo を省略すると suggestThrow の結果。
suggestThrow(state, ball, fielding) → 1|2|3|4|null   // その守備結果で CPU が選ぶ送球先
```

### `resolvePitch(state, pitchInput, batInput, rng)`（従来 API）

`pitchContact` → 打球なら `autoField` → `resolveBattedBall` を一度に行うラッパー。pending を残しません。CPU 同士のシミュレーションや従来の UI はこれだけで動きます。

## 6. バランス（tests/balance.mjs、CPU 同士 50 試合平均、両軍合計）

| 項目 | 目標 | 結果（SEED 20261004） |
|---|---|---|
| 得点 | 6〜9 | 7.40 |
| 安打 | 16〜20 | 17.82 |
| 三振 | 10〜14 | 13.24 |
| 四球 | 4〜7 | 5.40 |
| 本塁打 | 1〜3 | 1.22 |

（他シードでも得点 7.4〜7.8、安打 17.8〜18.7。併殺 約2個/試合、エラー 約0.5個/試合、二塁走者の単打での生還 約70%、三塁打はまれで多くは二塁打になる。）
調整係数は `TUNING`（打球・守備・走塁の係数を含む）。`TUNE='{"pivot":1.6}' node tests/balance.mjs` で一時上書きできます。
