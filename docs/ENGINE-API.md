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
  pitchers: [6 ids],          // 先発, 先発, セットアッパー, 中継ぎ, 中継ぎ, 抑え
  bench:    [5 ids],          // 控え野手: 代打の切り札, 代走要員, 控え捕手, ユーティリティ×2
  players:  [19 Player],
}
Player += {
  positions: ['遊','二','三'],  // 守れる守備位置（先頭 = 本職 = pos）。投手は ['投']
  pitching: { role: 'starter'|'setup'|'reliever'|'closer', velocity, power, control, stamina, pitches },  // 投手のみ
  //   power = 球威 1〜99（9 章。未設定のデータは球速から推定: pitchPowerOf）
  //   'setup' = セットアッパー（各チーム1人: r12 / b12 / g12 / y12。8回の勝ちパターン）
  //   pitches: [{ type, name, level }]  level = 変化量 0〜7（0 = 覚えているがほぼ曲がらない）
  model: '…',                  // 能力値のモデルにした実在選手タイプ（実名なし）
  skills: ['盗塁◎', …],        // 1〜4個。SKILLS のキーのみ
}
```

`TEAMS` は4チーム: `red` レッドスターズ（#E5484D、現役NPBスター軍）, `blue` ブルーウェーブス（#1E88E5、MLB日本人＆MLBスター軍）, `green` グリーンファイターズ（#2E9E55、昭和レジェンドOB軍、id g1〜g19）, `yellow` イエローサンダース（#F2B705、平成OB・名手軍、id y1〜y19）。全選手が実在選手のオマージュ（名前は架空。詳細は docs/ROSTER-HOMAGE.md）。各19人、同じ形（打順9・投手6・控え5）。
data.js の追加 export: `SKILLS`, `PITCH_DIRECTIONS`, `playerCost`（engine.js からも再 export）。`PITCH_TYPES` に `twoseam` `cutter` `splitter` `palm` `sinker` を追加（各 `fastballFamily?`）。

| | レッドスターズ | ブルーウェーブス |
|---|---|---|
| 代打の切り札 | r9 桜井 光（三/一） | b9 千早 陸（左/一） |
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
- 投手交代（3 段の継投、8.6 参照）: 最終回の前の回（8回）の頭に 1〜3 点リードならセットアッパー、最終回以降 1〜3 点リードで抑え、
  スタミナ残り 20% 未満、8回以降の先発は残り 58% 未満で交代（通常は中継ぎ→セットアッパー→先発→抑えの順に未登板から）。
  `state.autoUserPitcher = true` ならユーザー側にも同じ継投を行う
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
- 打者の一塁到達: 4.6 秒（走力1）〜 4.1 秒（走力99）、以降の塁間 約3.6〜4.5 秒（+ 回り込み 0.2 秒）
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
  kind: 'hit' | 'out' | 'double_play' | 'error' | 'fielders_choice' | 'sac_fly' | 'sac_bunt' | 'hr',  // 'hr' = ランニングホームラン、'sac_bunt' は 7.5
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

## 6. バランス（tests/balance.mjs、CPU 同士、両軍合計 / 試合）

CPU 打者は `chooseSwing` が返す **ミートカーソル入力（pos）** で打ち、調子・特殊能力・失投・死球・暴投・敬遠・CPU 送りバント・CPU 盗塁込み。
目標は **NPB 2023〜2025 の 1 試合平均**（docs/BALANCE.md）。`node tests/balance.mjs 200`（4 カード × 200 試合、SEED 20261004）:

| 項目 | 目標 | 結果 | 項目 | 目標 | 結果 |
|---|---|---|---|---|---|
| 得点 | 6.5〜7.8 | 7.31 | 盗塁 / 盗塁死 | 0.7〜1.3 / 0.3〜0.55 | 1.13 / 0.49（69.7%） |
| 安打 | 15.5〜17.5 | 16.73 | 犠打 | 0.9〜1.7 | 1.21 |
| 本塁打 | 1.0〜1.7 | 1.39 | 併殺 | 1.0〜1.6 | 1.23 |
| 三振 | 13.0〜15.5 | 14.90 | 失策 | 0.6〜1.2 | 0.81 |
| 四球 | 4.8〜6.3 | 5.60 | 暴投・捕逸 | 0.3〜0.6 | 0.41 |
| 死球 | 0.5〜0.9 | 0.65 | 投球数 | 260〜300 | 272.0（先発 89.4 球） |

打率 .245 / 出塁率 .307 / 長打率 .356。調整係数は `TUNING`（`TUNE='{"sigmaBase":0.68}' node tests/balance.mjs [1カードの試合数] [先攻-後攻 ...]` で一時上書き）。

---

## 7. パワプロ系システム（特殊能力・調子・ミートカーソル・バント・盗塁・球種・コスト）

### 7.1 新しい export 一覧

```js
// data.js（engine.js からも再 export）
SKILLS            = { [name]: { type:'gold'|'blue'|'red', target:'batter'|'pitcher'|'any', desc } }
PITCH_DIRECTIONS  = { fastball:'↑', twoseam:'→', slider:'←', cutter:'←', curve:'↙', fork:'↓', splitter:'↓', palm:'↓', shoot:'→', sinker:'↘', changeup:'↓' }
playerCost(player) → 1..15
// engine.js
CONDITIONS        = { 絶好調:{label,mult:1.10,arrow:'↑',color:'#FF4FA3',weight:10}, 好調:{1.05,'↗','#F57C00',25}, 普通:{1.00,'→','#FDD835',35},
                      不調:{0.95,'↘','#1E88E5',20}, 絶不調:{0.90,'↓','#7E57C2',10} }   // キーの順 = 良い順
CONDITION_LABELS  = ['絶好調','好調','普通','不調','絶不調']
CONDITION_CANCEL_RED, CONDITION_KEEP_BLUE   // 調子による特殊能力の打ち消し（7.3）
SKILL_FX          = { [name]: { when?, strike?, foul?, go?, fo?, single?, double?, triple?, hr?, hits?, …その他の数値 } }
conditionOf(state, playerId) → '絶好調'|…|'普通'
activeSkills(state, player) → string[]       // 調子で打ち消された後の有効な特殊能力
meetCursor(batter, mode, state?) → { rx, ry, coreR }
pitchBreak(pitcher, type) → { dx, dy, level, dir, nobi }
pitchDirection(type, throws) → '←'|'↙'|'↓'|'↘'|'→'|'↑'
attemptSteal(state, side, baseIndex) → state
cancelSteal(state) → state
cpuSteal(state, rng?) → { state, attempted }
stealChance(state, baseIndex) → 0..1      // 成功率の目安（UI 表示・CPU 判断用）
swingProbabilities(…, fat, ctx?)          // 9番目の引数 ctx を追加、dist は小数可
// NPB 準拠の追加（8 章）
effectiveStats(state, player, ctx?) → { contact, power, trajectory, speed, arm, fielding, catching, velocity, control, stamina, pitchPower, condition, fatigue, powerFatigue, mods }
pitchPowerOf(pitcher) → 1..99 | null   // 素の球威（9 章）
powerRank(v) → 'S'|'A'|…|'G'            // 球威のランク（rank() と同じ区切り）
staminaOf(state, pitcherOrId) → { pct, gauge, max, legacy }
intentionalWalk(state, rng?) → { state, event }        // event.kind = 'ibb'
cpuWantsIntentionalWalk(state, rng?) → boolean
pitchFlightMs(pitcher|kmh, type?, difficulty?, opts?) → ms
PITCH_COST, PITCH_SPEED, FLIGHT_DIFFICULTY, SKILL_RENAMES
```

`state` の追加フィールド: `state.condition = { [playerId]: '絶好調'|… }`, `state.pendingSteal = null | { side, baseIndex, runnerId, cpu? }`, `state.stealChecked`（内部用）。
`state.stats[id]` に `sb`（盗塁）, `cs`（盗塁死）, `sh`（犠打）, `hbp`（死球）, `ibb`（申告敬遠。`bb` にも含む）, `wp`（暴投、投手）を追加。`summary(state).steal` = pendingSteal の写し or null。
`pitchContact` の戻り値に `steal`（成功/失敗の steal イベント or null）を追加。

### 7.2 特殊能力（SKILLS / SKILL_FX）

打席結果の重み（OUTCOMES 順: strike=空振り, foul, go=ゴロアウト, fo=フライアウト, single, double, triple, hr、hits=安打4種）に乗算してから正規化します。
`swingProbabilities` の `ctx.state` があれば状況依存（when）の能力も判定します（無ければ when 付きのうち 対左・球種・低め以外は発動しない）。

| 特殊能力 | 種 | 発動条件 (when) | 効果 |
|---|---|---|---|
| チャンス◎ | 青 | 得点圏（二・三塁に走者） | **加算** ミート+15・パワー+10 |
| チャンス× | 赤 | 得点圏 | **加算** ミート−12・パワー−8 |
| 対左投手◎ | 青 | 左投手 | **加算** ミート+15・パワー+10 |
| パワーヒッター | 青 | 常時 | hr×1.30, fo×1.10, go×0.90、打球角度 +0.15 |
| アベレージヒッター | 青 | 常時 | single×1.12, double×1.08 |
| 広角打法 | 青 | 常時 | hr×1.10, double×1.05、引っ張り方向の偏り（±7°）なし |
| 流し打ち | 青 | 常時 | single×1.06、タイミングが遅い時さらに逆方向へ 8° |
| 初球○ | 青 | 0-0 | **加算** ミート+15・パワー+10 |
| 粘り打ち | 青 | 2ストライク | foul×1.40、**加算** ミート+10 |
| 三振 | 赤 | 2ストライク | **加算** ミート−20 |
| 併殺 | 赤 | 一塁走者あり・2死未満 | go×1.15、一塁到達 +0.12 秒 |
| 天才打者 | 金 | 常時 | strike×0.80, hits×1.15, foul×1.10、ミートカーソル ×1.10 |
| 怪力 | 金 | 常時 | hr×1.60, double×1.15 |
| 選球眼 | 青 | 常時 | CPU のボール球スイング率 ×0.75 |
| バント◎ | 青 | バント | ファウル率 -0.10、小フライ率 -0.03、打球が弱く両ラインへ |
| 盗塁◎ | 青 | 盗塁 | スタート -0.12 秒、CPU の盗塁判断で走力 +10 |
| 走塁◎ | 青 | 走塁・盗塁 | 走力 +10、進塁判断の余裕 -0.10 秒（積極的） |
| 送球◎ | 青 | 守備・捕手 | 送球速度 +3 m/s、握り替え -0.08 秒（盗塁阻止にも） |
| キャッチャー◎ | 青 | 捕手 | 盗塁阻止の握り替え -0.06 秒 |
| エラー | 赤 | 守備 | エラー率 ×2 |
| ノビ◎ | 青 | ストレート | strike×1.25, fo×1.10, hits×0.92（`event.pitch.nobi = true`） |
| キレ◎ | 青 | 変化球（ストレート系以外） | strike×1.20 |
| 奪三振 | 青 | 2ストライク | strike×1.15 |
| 対ピンチ◎ | 青 | 得点圏 | hits×0.88, strike×1.10 |
| 重い球 | 青 | 常時 | **加算** 球威+15（9 章。旧 hr×0.70・double×0.85・go×1.10 は廃止） |
| 軽い球（新） | 赤 | 常時 | **加算** 球威−15（9 章） |
| 打たれ強さ◎ | 青 | 走者あり | hits×0.94 |
| 低め◎ | 青 | 球が低め（y>0.5）/ 低めを狙う | go×1.10 / 制球誤差 ×0.85（zone.y=2 を狙う時） |
| 対左打者◎ | 青 | 左打者 | hits×0.90, strike×1.08 |
| クイック◎ | 青 | 盗塁 | 投球動作 -0.15 秒 |
| 牽制◎ | 青 | 盗塁 | 走者のリード -0.8 m |
| 一発 | 赤 | 常時 | hr×1.40、失投率 ×2 |
| 四球 | 赤 | 常時 | **加算** コントロール−20 |
| スロースターター | 赤 | 1〜2回 | **加算** コントロール−15・球速−2km/h |
| 失投回避（新） | 青 | 常時 | 失投率 ×0.5 |
| 剛球無双（旧名 怪物球威） | 金 | 常時 | strike×1.20, hits×0.88, hr×0.60 |

**加算**の能力は `SKILL_FX[name].add`（`{ contact, power, control, velocity, … }`）で、`effectiveStats` が能力値に足す（UI で「ミート+15」と表示できる）。
同じ能力に打席結果の重みの倍率は付けない（二重に数えない）。打球傾向（パワーヒッター等）・投手の決め球系（ノビ◎・キレ◎・奪三振・対ピンチ◎ など、
このモデルでは球速の数 km/h が結果にほとんど効かないもの）は従来どおり倍率。

### 7.3 調子（CONDITIONS）

- `createGame(home, away, { rng?, seed?, conditions? })`: 全選手に 絶好調/好調/普通/不調/絶不調 を重み 10/25/35/20/10 で抽選し `state.condition[playerId]` に保存。
  乱数は `rng` → `seed`（mulberry32）→ どちらも無ければ **チーム id から決まる固定シード**（同じ対戦なら同じ調子）。毎試合変えたい UI は `{ rng: Math.random }` を渡すこと。`conditions` で一部の選手を上書き。`simulateGame` は自身の rng を渡す。
- 効果（**加算**、`effectiveStats`。`CONDITIONS[c].bat` / `.pit`）:

  | 調子 | 打者 ミート・パワー | 弾道 | 投手 球速 | 制球 | スタミナ | 球威 |
  |---|---|---|---|---|---|---|
  | 絶好調 | +15 | +1 | +3 km/h | +10 | +25 | +8 |
  | 好調 | +10 | 0 | +2 | +5 | +12 | +4 |
  | 普通 | 0 | 0 | 0 | 0 | 0 | 0 |
  | 不調 | −10 | 0 | −2 | −5 | −8 | −4 |
  | 絶不調 | −15 | −1 | −3 | −10 | −15 | −8 |

  打者の値はパワプロ（2022 以降の検証値）、投手は独自値。走力・肩・守備・捕球は変わらない。`meetCursor`・`swingProbabilities`・`pitchLocation`・
  `chooseSwing`・バント・弾道（打球角度）はすべて実効値を使う。`mult` は旧方式の倍率で、表示と `swingProbabilities` の `ctx.batterCond / pitcherCond`（互換）にだけ使う。
- 特殊能力の打ち消し（`activeSkills`）: **絶好調** は赤特 `三振` `チャンス×` `四球` `スロースターター` `一発` `軽い球` を無効化。**絶不調** は青特・金特を無効化（ただし走塁・守備系 `盗塁◎` `走塁◎` `送球◎` `キャッチャー◎` `クイック◎` `牽制◎` `バント◎` は有効のまま）。

### 7.4 ミートカーソル（連続座標の打撃入力）

```js
batInput = { mode: 'meet'|'power'|'bunt', pos: { x, y }, timing: -1..1, zone? }
// pos: セル単位の連続座標。ゾーン中心 (0,0)、+x = 画面右、+y = 画面下、ゾーンは |x|,|y| <= 1.5（範囲の目安 -2..2）
// pos が無ければ従来どおり zone（0..2 のセル）で判定。timing は負 = 早い（振り遅れは正）
```

`meetCursor(batter, mode, state)`: `rx = 0.35 + 0.50 × (実効ミート − 1)/98`（effectiveStats、調子・状況の能力込み）（ミート1 → 0.35、99 → 0.85）、天才打者 ×1.10、強振 ×0.7、バント ×1.1。`ry = rx × 0.75`、`coreR = rx × 0.3`（芯の円）。

判定（ボールの到達位置 loc とカーソル中心 pos の差 dx, dy）:
1. `nd = √((dx/rx)² + (dy/ry)²)`。**nd > 1 → 空振り**（ただし nd ≤ 1.15 の縁はファウルチップ: 50% でファウル）。
2. 接触の質 `event.contactTier`: `'shin2'`（真芯: 距離 ≤ coreR/2）/ `'shin'`（芯: ≤ coreR）/ `'other'`。zone 入力は同じセル = 'shin'、それ以外 'other'。
3. 従来の距離帯（0/1/2）へ連続的に写す: 真芯 → 0、それ以外 `dist = 1.9 × clamp((nd − 0.15)/0.85, 0, 1)`（0..1.9、係数表の隣り合う距離帯を線形補間）。真芯は安打 ×1.12・空振り ×0.85。
4. 上下: **ボールがカーソル中心より上（dy < 0）→ バットがボールの下側に当たりフライ、下 → ゴロ**。`lift = −dy/ry` に弾道 `(trajectory−2)×0.15`、パワーヒッター +0.15 を足し、ゴロアウト ×exp(−0.45·lift)・フライアウト ×exp(+0.45·lift)（カーソル入力のみ）、打球の種類（ゴロ/ライナー/フライ）の選択もずらす。
5. 方向: タイミングが早い → 引っ張り（`引っ張り側 × −timing × 20°`）、遅い → 流し。カーソルの横ずれ `dx/rx × 10°`（画面右へずれたボールは右方向）。早め（−0.6 < timing < −0.1）で内角を引っ張ると double/hr ×1.1。
6. event に `dist`（小数）, `band`, `mode`, `contactTier`, `cursor: {rx,ry,coreR}`, `nd` が付く。

CPU（`chooseSwing`）は `{ zone, pos, mode, timing }` を返す。`pos = 実際の位置 + 正規乱数 × (0.02 + (100 − 実効ミート)/100 × 0.32)`。

### 7.5 バント（mode: 'bunt'）

- カーソルは ×1.1。nd > 1 は空振り（縁ではファウル 70%）。当たれば ファウル率 `0.22 + 0.22·nd − 0.10·c − バント◎0.10 (+タイミング帯1: 0.04 / 帯2: 0.12、ボール球 +0.10)`、小フライ率 `0.05 + 0.07·nd − バント◎0.03`、残りがフェアのバント（c = (実効ミート−50)/49）。
- 打球: ゴロ（`ball.bunt = true`、方向 ±30°、打球速度 約32〜60 km/h、バント◎ 28〜45 km/h で両ラインへ）または捕手・投手付近の小フライ。通常どおり `autoField` / `resolveBattedBall` で処理（pitchContact の event は `kind:'inplay', text:'バント！', bunt:true`）。
- 走者: フォースの走者は進み、二塁走者（フォースでない）も三塁へ、三塁走者は自重。
- **送りバント**: 打者が一塁でアウト・走者アウトなし・2死未満・走者が進塁 → `event.kind = 'sac_bunt'`（`sacBunt: true`、打数に数えず `stats.sh += 1`）。テキスト「送りバント成功！」。打者がセーフなら 'hit'（バントヒット）。
- 2ストライク後のバントファウル → 三振（`kind:'strikeout'`, `buntFoulOut: true`、「スリーバント失敗！」）。

### 7.6 盗塁・走塁

- `attemptSteal(state, side, baseIndex)`: 0 = 一塁走者が二塁へ、1 = 二塁走者が三塁へ。攻撃中のチームのみ。走者がいない・次の塁が埋まっている・`state.pending`・試合終了なら throw。`state.pendingSteal` を設定（次の1球で解決）。`cancelSteal(state)` で取り消し。
- 次の `pitchContact`（`resolvePitch`）:
  - **見送り/空振り（ボール・ストライク）**: 走者と捕手の送球の競争。`event.steal = { kind:'steal'|'caught_stealing', side, runnerId, catcherId, from, to, safe, runnerTime, throwTime, text }`（'盗塁成功！' / '刺した！ 盗塁失敗。'）。pitch の event テキストにも追記、`state.log` には pitch イベントの直後に steal イベントが入る。戻り値 `steal` にも同じもの。
    - 走者: `0.30（盗塁◎ −0.12）+ (27.4 − リード) / (7.0 + 1.6·走力/99) + 0.10`、リード 一塁 3.6 m / 二塁 5.5 m（牽制◎ −0.8 m）、走塁◎ 走力 +10
    - 守備: `投球 1.28（クイック◎ −0.15、変化球 +0.10）+ 握り替え 0.80 − 0.25·捕球/99（送球◎ −0.08、キャッチャー◎ −0.06）+ 距離/(24 + 12·肩/99 [+3 送球◎]) + タッチ 0.15`（大きく外れた球 +0.25）。両者 σ0.22 秒の誤差（成功率 約70% にするため）。
    - 三振と同時の盗塁死（三振ゲッツー）あり。盗塁死で3アウト目なら打者は打順を進めずに次の回の先頭（カウントはリセット）、`event.endHalf = true`。
    - 四球（`steal_cancelled`, reason 'walk'。押し出しの走者は進む）、2死からの三振（'inning_over'）は盗塁なし。
  - **ファウル**: 走者は戻る（`event.steal.kind = 'steal_cancelled'`, reason 'foul'）。
  - **打球**: エンドラン状態（`event.steal.kind = 'running'`、`ball.running = [runnerId]`）。打った瞬間にスタート済み・リード +6 m で進塁しやすい（フライ捕球時は帰塁扱い）。
- CPU（`userSide` でない攻撃側）は `pitchContact` の中で自動で盗塁を判断（`pitchInput.noSteal: true` で抑止）。条件: 2ストライク未満・3ボール未満・3点差以内、走力（盗塁◎ +10）≥ 66（三盗は 76、2死未満）、`stealChance ≥ 0.39`、1球あたり確率 `min(0.8, 1.4 × (走力 − 70)/30)`。CPU 同士で成功率 約70%（盗塁 1.1・盗塁死 0.5 / 試合）。投球前に走者のスタートを見せたい UI は先に `cpuSteal(state, rng)` を呼ぶ（その state では pitchContact は再判断しない）。

### 7.7 球種（PITCH_DIRECTIONS / pitchBreak）

- 変化方向はパワプロ表記（投手目線）で、変化球は `←` `↙` `↓` `↘` `→` の5方向、ストレートは `↑`（ノビ）。左投手は左右反転（`pitchDirection(type, '左')`）。
  スライダー ←, カットボール ←（小）, カーブ ↙, フォーク ↓, スプリット ↓, パーム ↓, チェンジアップ ↓, シンカー ↘, シュート →, ツーシーム →（小）。
- 画面上の実際の変化（`dx, dy`、打者カメラ視点で +x = 右、+y = 下）は矢印と左右が逆（例: 右投手のスライダー '←' は dx > 0）。
- `pitchBreak(pitcher, type)` = PITCH_TYPES の dx/dy × `(0.7 + 0.1 × level)`（level 0 は ×0.4、ストレートは変化なし）、左投手は dx 反転。`pitchLocation`・CPU の配球/打撃予想はこの値を使う。**UI で球の軌道を描く場合も pitchBreak を使うこと**（PITCH_TYPES の dx/dy は level 3 の値）。
- 見切り難度: `read + 0.025 × (level − 3)`。変化量は 0〜7（data.js の旧 1〜4 は 2/3/5/6 に換算済み）。
- スタミナ消費は球種別（`PITCH_COST`、8.5）。CPU は3ボールでストレート系を増やし、2ストライクで変化球を増やす。
- `nobi`: ノビ◎ の投手のストレート（`pitchBreak().nobi`, `event.pitch.nobi`）。

### 7.8 選手コスト（playerCost）

表示用の 1〜15 の整数（チームコストモードの上限は撤廃済み）。

```
野手: 総合 = ミート×0.30 + パワー×0.30 + 走力×0.14 + 守備×0.12 + 肩×0.07 + 捕球×0.07
投手: 総合 = 球速能力×0.40 + コントロール×0.40 + スタミナ×0.15 + 変化量合計×1.2 + 6   （球速能力 = (km/h − 120)/50 × 99）
特殊能力: 金 +6、青 +1.5、赤 −2.5（野手は野手用、投手は投手用の能力のみ）
コスト = clamp(round((総合 − 40) / 3.2), 1, 15)
```

各チーム19人の合計は 157〜160（25人換算 約207〜211）。主力野手 7〜11、控え 3〜6、エース・抑え 12〜15。

---

## 8. NPB 準拠の試合システム（実効能力・失投・死球・暴投・敬遠・CPU 送りバント・スタミナゲージ・継投・到達時間）

既存の export と event の形はそのまま（フィールドの追加のみ）。

### 8.1 `effectiveStats(state, player, ctx?)` — 実効能力（加算式）

```js
effectiveStats(state, player, { batter?, pitcher?, type?, loc?, condition?: false, skills?: false, fatigue?: false })
→ { contact, power, trajectory, speed, arm, fielding, catching,      // 野手（投手の打撃も）
    velocity, control, stamina,                                      // 投手のみ（野手は null）。velocity は km/h
    pitchPower,                                                      // 投手のみ: 実効球威（9 章）。power は打撃のパワーのまま
    condition: '絶好調'|…, fatigue: 0..1, powerFatigue: 0..1,       // powerFatigue = 球威の疲労（スタミナ 50% 未満）
    mods: [{ source: '絶好調'|'チャンス◎'|'疲労'|…, add: { contact: 15, … } }] }   // UI の「ミート+15」表示用
```

- 調子（7.3 の表）＋ 状況で発動する加算の特殊能力（`SKILL_FX[name].add`、`when` は打席の状況・対戦相手で判定）＋ 投手の疲労
  （スタミナ残り 15% 未満で 0→1、球速 最大 −4 km/h・制球 最大 −30）。`batter` / `pitcher` を省略すると state の現在の打者・投手。
- 範囲: ミート・パワー・制球 1〜110（99 を超える加算も効く）、弾道 1〜4。state が null なら調子・状況の能力なし（素の値）。
- エンジン内部では `meetCursor`・`swingProbabilities`・`pitchLocation`・`chooseSwing`（スイング・カーソル誤差・タイミング・強振）・
  バント・打球角度（弾道）・スタミナの満タン値がこれを通る。

### 8.2 失投（甘い球）

`pitchLocation` で確率 `p = 0.04 + 0.08 × (1 − 実効制球/99)`（`TUNING.mistakeBase / mistakeK`）、赤特 **一発 ×2**、青特 **失投回避 ×0.5**、
疲労で最大 ×2。失投は狙いが真ん中へ寄り（狙い ×0.25 ＋ σ0.3）、変化は半分、制球誤差なし。結果に `loc.mistake = true`。
`pitchContact` は `pitchInput.loc.mistake` を引き継ぎ **`event.pitch.mistake = true`**。打撃判定では見切りやすく（d −0.08）、本塁打 ×1.3、球威 −20（9 章）。
CPU 同士で 約 6% / 球。

### 8.3 死球（kind `'hbp'`）

- `pitchLocation`: 打者の**内角**（右打者は −x、左打者は +x、両打ちは投手の逆）に `|x| > 1.95`、高さ `|y| < 1.9` の球の 5.5% に `loc.hbp = true`。
- `pitchContact`: `loc.hbp` で**見送った**（`batInput = null`）とき死球。CPU 打者（`chooseSwing`）はその球を振らない。スイングした場合は通常の判定。
- event: `{ kind: 'hbp', hbp: true, outcome: 'hbp', runs, text: 'あっとデッドボール！ ストレートが○○に当たってしまった…一塁へ。' }`。
  打者は一塁、押し出しの走者だけ進む（満塁なら 1 点・打点あり）。`stats.hbp`、打数なし。盗塁の予約は `steal_cancelled`（reason `'hbp'`）。
- CPU 同士で 約 0.65 / 試合。

### 8.4 暴投・捕逸（`event.wildPitch`）

- `pitchLocation`: **走者がいるとき**、低めに大きく外れた球（`y > 1.85`）で `0.022 × (1.5 − 制球/99) × (フォーク・スプリット・パームは ×1.7) × (外れ方)`、
  横に大きく外れた球（`|x| > 2.1`）はその半分の確率で `loc.wildPitch = 'wild_pitch' | 'passed_ball'`（捕逸は約 2 割、捕手の捕球が低いほど多い）。
- `pitchContact`: その球が**ボールまたはストライク（打席が終わらない）**で、盗塁の予約がないとき、走者がそれぞれ 1 つ進む（三塁走者は生還）。
  打者の結果はなし（カウントは進んだまま、打席は続く）。event の kind は `'ball'` / `'strike'` のまま、追加フィールド:
  ```js
  event.wildPitch = { kind: 'wild_pitch'|'passed_ball', runners: [{ id, from, to }], runs, text, pitcherId }
  // event.runs にも得点を加算。event.text に「あっとワイルドピッチ！ 三塁ランナー生還！ ランナーはそれぞれ進塁。」を追記
  ```
  打点はつかない。暴投の失点は自責点、捕逸は自責点にしない。投手の `stats.wp`、`state.passedBalls[side]`。サヨナラもありうる（`state.over`）。
- CPU 同士で 約 0.4 / 試合。

### 8.5 申告敬遠（kind `'ibb'`）

```js
intentionalWalk(state, rng?) → { state, event }      // 守備側の采配（ユーザー操作・CPU どちらでも）
cpuWantsIntentionalWalk(state, rng?) → boolean       // CPU の判断（rng を渡すと 75% の確率、省略時は条件のみ）
choosePitch(state, rng) → { type, zone, intentional: true }   // CPU が敬遠を選んだ打席の初球
pitchContact / resolvePitch(state, { …, intentional: true }, …) // 投球なしで敬遠（pitchLocation も intentional なら乱数を使わず外角の位置を返す）
```

- event: `{ kind: 'ibb', intentional: true, outcome: 'ball', pitch: null, runs, text: '申告敬遠。○○は△△との勝負を避けました。△△は一塁へ。' }`。
  **投球数・スタミナは変わらない**。`stats.bb` と `stats.ibb` に加算。押し出しの走者だけ進む。
- CPU の条件（`cpuWantsIntentionalWalk`）: 守備側の投球を CPU が受け持つ（CPU 側、または `autoUserPitcher` のユーザー側）、打席の初球前、7回以降、
  守備側から見て −1〜+1 点、一塁が空いていて得点圏に走者、打者の実効（ミート＋パワー）≥ 140 かつ次打者より 25 以上高い。CPU 同士で 約 0.17 / 試合。
- UI: `choosePitch` の結果に `intentional` があれば投球アニメを省略して `pitchContact` を呼べばよい。

### 8.6 CPU の送りバント

`chooseSwing` が `{ mode: 'bunt', pos, zone, timing }` を返す（既存のバントの仕組みで処理、成功すれば `kind: 'sac_bunt'`）。
条件: 無死一塁 / 無死一二塁（三塁が空き）、2ストライク未満、打者が投手または実効（ミート＋パワー）< 122、または 7回以降の同点〜1点ビハインドで 7〜9 番。
その打席の 85% で狙う（打席ごとに決まる）。ストライクだけバントし、ボール球は見送る。CPU 同士で 犠打 約 1.2 / 試合。

### 8.7 スタミナゲージ（出来事で減る）

```js
state.staminaGauge[id]  // 残りゲージ
state.staminaMax[id]    // 満タン = 実効スタミナ（調子込み）× 32 ＋ 先発 1500
state.staminaPct[id]    // 残り 0〜100（UI 用、小数1桁）
state.stamina[id]       // 旧来の単位（満タン = pitching.stamina）。常に staminaPct と同期。外部から書き換えるとゲージもそれに合わせる
state.pitchesBy[id]     // 投手ごとの投球数
staminaOf(state, pitcherOrId) → { pct, gauge, max, legacy }
```

消費（ゲージ単位、`TUNING.staminaCostMul` で一括調整）:

| 出来事 | 消費 |
|---|---|
| 1 球（`PITCH_COST`） | ストレート 27、ツーシーム・カット 37、スライダー・カーブ・パーム 33、フォーク・スプリット 38、チェンジアップ・シンカー 36、シュート 35 |
| 走者 | 一塁のみ +3、得点圏 +7、二三塁・満塁 +10（1 球ごと） |
| 先発の 7 回以降 | +9 / 球 |
| 被安打 | 単打 30・二塁打 45・三塁打 60・本塁打 80 |
| 失点 | 1 点 40（同点にされる 60、勝ち越される 80） |
| エラーで出塁 | 70 |
| 7 回以降に 6 点以上リード | 消費 ×1/2 |

- 疲労: 残り 15% 未満で球速・制球が落ち、失投が増える（8.1）。
- CPU 同士で先発は平均 約 89 球（80〜115 球に分布）、5.9 回。

### 8.8 継投（先発 → セットアッパー → 抑え）

`cpuManage`（打席終了ごとに自動）。守備側が CPU、または `autoUserPitcher` のユーザー側。sub イベントに `reason: 'setup'|'closer'|'tired'` と `role` を追加。

1. 最終回以降に 1〜3 点リード → 抑え（`role: 'closer'`）
2. 最終回の前の回（9 回制なら 8 回）の**頭**（0 アウト・走者なし）に 1〜3 点リード → セットアッパー（`role: 'setup'`。チームに設定がなければ最も能力の高い中継ぎ）
3. スタミナ残り 20% 未満、または 8 回以降の先発で残り 58% 未満 → 交代（勝ちパターンの場面ならセットアッパー、それ以外は中継ぎ → セットアッパー → 先発 → 抑え の順）

`changePitcher(state, side)`（id 省略）も中継ぎ優先で選ぶ。

### 8.9 `pitchFlightMs(pitcher, type, difficulty, opts?)` — 投球の到達時間（UI 用）

```js
pitchFlightMs(pitcherOrKmh, type = 'fastball', difficulty = 'normal'|'easy'|'hard'|倍率, { state?, kmh? }) → ミリ秒（整数、250〜2000）
ms = 620 × 145 / (球速 km/h × PITCH_SPEED[type]) × (ノビ◎のストレート 0.97) × FLIGHT_DIFFICULTY[difficulty]
FLIGHT_DIFFICULTY = { easy: 1.35, normal: 1.0, hard: 0.82 }
PITCH_SPEED = { fastball 1.0, twoseam .97, cutter .95, slider .89, curve .80, fork .90, splitter .92, palm .80, shoot .93, sinker .90, changeup .85 }
```

実際の野球では 150 km/h ≈ 440 ms（18.44 m、減速込み）だが速すぎるので約 1.36 倍に伸ばし、`normal` の 145 km/h ストレート = 620 ms。
球速に反比例（速いほど短い。単調）。例（normal）: 155 km/h 580 ms、135 km/h 666 ms、145 km/h の投手のカーブ 775 ms。
`opts.state` で調子・疲労込みの実効球速、`opts.kmh` でその球の球速（`loc.kmh` / `event.pitch.kmh`）を直接使う。
`pitchLocation` の戻り値と `event.pitch` に **`kmh`**（その球の球速、実効球速 × 球種比 ± 1.2 km/h）を追加。

### 8.10 特殊能力の名称の点検（改名）

| 旧名 | 新名 | 理由 |
|---|---|---|
| 怪物球威 | **剛球無双** | パワプロの金特と同名（「怪物」は実在投手の愛称に由来する名前） |

- `SKILL_RENAMES = { 怪物球威: '剛球無双' }`: 保存済みのチーム（チームエディタ）に旧名が残っていてもエンジンは新名として効果を出す。UI の表示は新名を使うこと。
- 新しい青特 **失投回避**（投手、失投率 ×0.5）を追加（パワプロの「逃げ球」に相当するが独自名）。r11・b12・g10・y11 が所持。
- そのほかの能力名（チャンス◎、対左投手◎、盗塁◎、走塁◎、送球◎、パワーヒッター、アベレージヒッター、広角打法、流し打ち、初球○、粘り打ち、バント◎、選球眼、
  キャッチャー◎、チャンス×、三振、併殺、エラー、天才打者、怪力、ノビ◎、キレ◎、奪三振、対ピンチ◎、重い球、クイック◎、牽制◎、打たれ強さ◎、低め◎、
  対左打者◎、一発、四球、スロースターター）は一般的な野球用語で、実在選手の愛称に由来する名前と完全一致するものはない
  （「ドクターK」「精密機械」「鉄腕」「安打製造機」「アーチスト」「威圧感」など、人物の愛称や固有の名前は使っていない。tests/systems.test.mjs で禁止語を確認）。

### 8.11 その他の変更

- `TUNING` に追加: 結果の基礎重み（`strikeBase` `singleBase` `doubleBase` `tripleBase` `hrBase` `goBase` `foBase`）、失投・死球・暴投・敬遠・送りバント・スタミナ・継投の係数（docs/BALANCE.md）。
- 打者の一塁到達 4.1〜4.6 秒（走力順）。併殺の中継 `pivot 1.2`。エラー率 `errBase 0.026`（約 0.8 個 / 試合）。
- `tests/balance.mjs [1カードの試合数] [先攻-後攻 ...]`: 複数カードを回し、全項目（得点〜先発の球数、打率・出塁率・長打率、盗塁成功率、敬遠、失投率）を表示。
  `gameStats` / `runBalance` / `TARGETS` を export。

## 9. 球威（pitching.power / effectiveStats().pitchPower）

**球威 = 打者が芯で捉えにくい「球の重さ」**。球速（velocity）が「空振りを取る力」なのに対し、球威は「当てられても押し返す力」で、
バットに当たった後の結果を **強い当たり → 詰まった当たり** へずらす。球速と相関するが別物（148 km/h のシンカー投手でも球威は高く、
回転の綺麗な“伸びる”152 km/h の直球は空振りは取れても球威は控えめ。各投手の値は docs/ROSTER-HOMAGE.md）。

### 9.1 データと実効値

- `player.pitching.power`（1〜99、全 24 投手）。未設定（チームエディタの旧データなど）は `pitchPowerOf(p)` が球速から推定: `50 + (km/h − 145) × 1.5`（30〜80）。
- `effectiveStats(state, pitcher).pitchPower`（小数 1 桁、1〜110）＝ 素の球威 ＋ 調子（+8/+4/0/−4/−8）＋ 特殊能力（**重い球 +15**、**軽い球 −15**）
  − 疲労（スタミナ残り 50% 未満で `20 × (50 − 残り%) / 50`、残り 0% で −20。`mods` に `'疲労（球威）'`、`powerFatigue` 0〜1）。
  ※ `power` は従来どおり**打撃のパワー**（投手も打席に立つため。UI の `{ ...player, ...effectiveStats() }` が壊れないよう別名 `pitchPower` にした）。
- **失投**はその球の球威 −20（`TUNING.mistakePower`）。
- `event.pitch.power` = その球の実効球威（投球前のスタミナで計算、失投込み）。見送り・ボールでも入る。
- `powerRank(v)` = 球威のランク（`rank()` と同じ: 90 S / 80 A / 70 B / 60 C / 50 D / 40 E / 20 F / それ未満 G）。

### 9.2 打撃結果への効果（`swingProbabilities`）

```
w = (実効球威 − 50) / 49                 // 球威 99 → +1.0、50 → 0、30 → −0.41
b = clamp((打者の実効パワー − 50) / 49, 0, 1)
P = w > 0 ? w × (1 − 0.5 × b) : w        // 球威の優位。パワー 99 の打者は優位を半分打ち消す（押し負けない）
重み × exp(係数 × P)  → 正規化
```

| 結果 | 係数（`TUNING`） | P = +1（球威 99 対 パワー 50） | P = −0.41（球威 30） |
|---|---|---|---|
| 本塁打 | `powerHr −0.55` | ×0.58 | ×1.25 |
| 二塁打・三塁打 | `powerXbh −0.40` | ×0.67 | ×1.18 |
| 単打 | `powerSingle −0.12` | ×0.89 | ×1.05 |
| ゴロアウト | `powerGo +0.10` | ×1.11 | ×0.96 |
| フライアウト（内野フライ） | `powerFo +0.15` | ×1.16 | ×0.94 |
| ファウル | `powerFoul +0.10` | ×1.11 | ×0.96 |
| 空振り | `powerStrike +0.05`（小さい。空振りの主役は球速・ノビ◎・キレ◎） | ×1.05 | ×0.98 |

`ctx.pitchPower` でその球の球威を直接渡せる（省略時は `effectiveStats`、`ctx.state` があれば疲労込み、`loc.mistake` なら −20）。

### 9.3 詰まらせた（`event.jammed`）と打球速度

- スイングの結果が **ゴロアウト / フライアウト** で `P ≥ 0.1` のとき、確率 `min(0.6, 0.6 × P)` で **詰まった当たり**: `event.jammed = true`
  （UI の実況「詰まらせた！」用。`pitchContact` の inplay イベントと `resolveBattedBall` の最終イベントの両方に残る）。
- 詰まった打球は弱い: ゴロは **ボテボテ 70〜105 km/h**（通常 80〜150）、フライアウトは 80% が **内野フライ**（残りは浅い外野フライ）。
  → 球威が高いほど `ball.exitSpeed` の平均が下がる。
- 実測（ど真ん中のストレートを 8000 回スイング、ミート 65・パワー 60 の打者、`tests/power.test.mjs` と同条件）:

  | 球威 | 安打/打球 | 長打/打球 | 本塁打/打球 | 平均打球速度 | 詰まらせた/打球 |
  |---|---|---|---|---|---|
  | 30 | 38.4% | 8.9% | 1.9% | 123.6 km/h | 0% |
  | 50 | 37.0% | 8.3% | 1.3% | 123.5 km/h | 0% |
  | 75 | 32.5% | 5.9% | 1.2% | 117.5 km/h | 17% |
  | 99 | 29.8% | 5.3% | 1.2% | 111.1 km/h | 37% |
  | 99（パワー 99 の打者） | 31.3% | 8.2% | 2.1% | 116.4 km/h | 19% |

### 9.4 特殊能力との関係

- **重い球**（青）= 球威 +15 の加算だけ（旧来の hr×0.70・double×0.85・go×1.10 の倍率は廃止＝二重に数えない）。絶不調で無効。
- **軽い球**（赤、新規）= 球威 −15。絶好調で打ち消される。現在のロースターに所持者はいない（チームエディタ用）。
- **剛球無双**（金）は従来どおりの倍率（strike×1.20, hits×0.88, hr×0.60）で、球威とは別に効く（所持者 b13・g11 は球威自体も高い）。

