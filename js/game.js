/**
 * 試合画面（ドキドキベースボール）
 * 描画・入力・投球アニメーションを担当。試合ロジックは engine.js に委譲する。
 *
 * export function createGameScreen(el, ctx)
 *   → { start(), handleKey(key), handleKeyUp(key), isCapturingEsc(), destroy() }
 *   key: 'up'|'down'|'left'|'right'|'z'|'x'|'enter'|'esc'
 *   ctx: { teams, userTeamId, go(name, payload), onGameOver(state),
 *          settings?: { innings:3|6|9, difficulty:'easy'|'normal'|'hard', sound:boolean },
 *          sound?: { play(name) }, music?: { duck(bool) } }
 *
 * 打球（本塁打以外）は js/fielding.js の守備ビューで再生し、結果を engine.resolveBattedBall に渡す。
 * 采配（選手交代）は js/subs.js のメニュー（ヘッダーの「さいはい」ボタン / 投球前の Esc）。
 */
import * as engine from './engine.js';
import { rank, RANK_COLORS, PITCH_TYPES } from './data.js';
import { createFieldingView } from './fielding.js';
import { openSubsMenu } from './subs.js';

// ---- レイアウト定数（1280x720 ステージ座標） ----
const ZONE_LEFT = 520;
const ZONE_TOP = 404;
const CELL = 80;
const ZONE_CX = ZONE_LEFT + CELL * 1.5; // 640
const ZONE_CY = ZONE_TOP + CELL * 1.5;  // 524
const PITCHER_X = 640;
const PITCHER_Y = 300;
const BALL_HALF = 12;
// 難易度ごとの投球時間とタイミング許容幅（easy はゴースト表示あり）
const DIFFICULTY = {
  easy: { flight: 900, timing: 400, ghost: true },
  normal: { flight: 700, timing: 300, ghost: false },
  hard: { flight: 550, timing: 220, ghost: false },
};
const HIT_FLY_MS = 800;
const PLATE_X = 640;
const PLATE_Y = 610;
const TAKE_GRACE_MS = 150;
const RESULT_MS = 900;
const CHANGE_MS = 1200;
const GAMESET_MS = 1500;
const CPU_PITCH_DELAY_MS = 1100;
const BATTER_SCALE = 0.9;
const BATTER_LEFT_R = 396; // 右打者（三塁側 = 画面左）。transform-origin は左上
const BATTER_LEFT_L = 1280 - BATTER_LEFT_R; // 左打者（一塁側）= 鏡像（scaleX 負で左へ伸びる）
const BATTER_TOP = 404;
const SWING_MS = { meet: 350, power: 420 };
const SWING_CONTACT_MS = 90;   // スイング開始からバットがゾーンを横切るまで
const FIELD_OPEN_MS = 380;     // 打球音・火花のあと守備ビューを開くまで
const SUB_OVERLAY_MS = 1100;
const SUB_LABEL = { pitcher: 'ピッチャー交代', pinch_hit: '代打', pinch_run: '代走', defense: '守備交代' };

const POS_NAMES = { 投: '投手', 捕: '捕手', 一: '一塁手', 二: '二塁手', 三: '三塁手', 遊: '遊撃手', 左: '左翼手', 中: '中堅手', 右: '右翼手', 指: '指名打者' };

/** 実況テキストから打球方向（ステージ x 座標）を推定 */
const DIR_X = [
  ['三遊間', 450], ['一二塁間', 830], ['左中間', 450], ['右中間', 830], ['レフト線', 200], ['ライト線', 1080],
  ['レフト', 300], ['ライト', 980], ['センター', 640], ['ショート', 520], ['セカンド', 760], ['サード', 390],
  ['ファースト', 890], ['ピッチャー', 640],
];
function hitDirX(text) {
  const t = String(text ?? '');
  for (const [k, x] of DIR_X) if (t.includes(k)) return x;
  return 360 + Math.random() * 560;
}

const REQUIRED = ['createGame', 'getBatter', 'getPitcher', 'pitchContact', 'resolveBattedBall', 'autoField', 'choosePitch', 'chooseSwing', 'isGameOver', 'lineupView', 'summary'];

/** HTML エスケープ */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const CHIBI_HEAD = '<div class="chibi-head"><div class="chibi-cap"></div><div class="chibi-cap-button"></div><div class="chibi-brim"></div><div class="chibi-eye l"><i class="chibi-shine"></i></div><div class="chibi-eye r"><i class="chibi-shine"></i></div><div class="chibi-cheek l"></div><div class="chibi-cheek r"></div><div class="chibi-mouth"></div></div>';

function chibiHTML(extraClass, color, number) {
  return `<div class="chibi ${extraClass}" style="--team:${esc(color)}">${CHIBI_HEAD}<div class="chibi-body">${esc(number)}</div><div class="chibi-legs"><i></i><i></i></div></div>`;
}

/*
 * 打者ちびキャラ（捕手視点）。右打者の向きで組み、左打者は .chibi-batter 自体を scaleX(-1)。
 * 右打者は本塁の左（三塁側）に立ち、胸は本塁（画面右）、左肩は投手（画面奥）、顔は投手へ向く
 * ＝ カメラからは背中（背番号）と後頭部が見える 3/4 後ろ姿。
 * 腕は 上腕 + 前腕 の 2 関節（肩・肘で回転）。手（グリップ）の位置とバットの向きをポーズとして与え、
 * 2 リンク IK で肘角を解く（肘は人間の向きにしか曲がらない: 屈曲側を固定、伸び切りでのみ切替）。
 * バットはグリップ（下の手）を支点に 3D 回転: rotateX(カメラ俯角) rotateY(φ: 水平方向) rotateZ(-ε: 仰角)。
 *   φ=0 本塁方向（画面右）/ 90 投手方向（奥）/ 180 三塁側（画面左）/ 270 捕手方向（手前）。
 * 座標は .bt-rig 内の px（128×176、肩幅などはちび体型）。
 */
const BT = {
  L1: 31, L2: 31,            // 上腕・前腕の長さ
  SHOULDER: 20,              // 肩の半幅
  GRIP: 13,                  // 下の手 → 上の手の距離（バット軸方向）
  TORSO_PIVOT: [62, 134],    // 胴の回転中心（腰）
  TILT_X: -20,               // カメラ俯角（バットの奥行きを少し上へ投影）
};
const BT_PARTS = ['legF', 'shoeF', 'legB', 'shoeB', 'armF', 'foreF', 'torso', 'numw', 'head', 'batw', 'bat', 'armB', 'foreB', 'handF', 'handB', 'trail'];

/* ポーズの制御点（t: ms）。G=下の手（グリップ）, phi/eps=バット, r=体の回転（0=構え〔胸は本塁〕, 1=胸が投手）,
   tilt=胴の傾き（後ろ肩が下がる = 正）, ff=前足の踏み込み[x,y], lift=前足の上げ, bk=後ろ膝の送り, heel=後ろかかと,
   fe=前腕の肘の屈曲側（+1: 構え〜インパクト, -1: フォロー）, bz=バットの奥行き（3=体の奥, 6=手前）,
   back=腕・手が胸の前（体の奥）に回ったか（0/1）, trail=強振の軌跡の不透明度,
   sw=ステップ値（fe/bz/back）を直前の区間のどこで切り替えるか（既定 0.5） */
const STANCE = { G: [106, 52], phi: 160, eps: 50, r: 0, tilt: 0, ff: [0, 0], lift: 0, bk: 0, heel: 0, fe: 1, bz: 3, back: 0, trail: 0 };
const pose = (t, o) => ({ ...STANCE, t, ...o });
const SWING_KEYS = {
  meet: [
    pose(0, {}),
    pose(28, { G: [106, 50], phi: 164, eps: 58, r: -0.06, ff: [-2, -2], lift: 6 }),                       // ① 溜め: 前足を上げ、手は後ろに残す
    pose(58, { sw: 0.85, G: [102, 88], phi: 262, eps: 30, r: 0.45, tilt: 5, ff: [-5, -3], lift: 0, bk: 6, bz: 6 }), // ② 腰→肩の回転、手はトップから下へ、後ろ肘を腰へ
    pose(90, { G: [98, 104], phi: 368, eps: 2, r: 0.8, tilt: 6, ff: [-5, -3], bk: 12, heel: 14, bz: 3 }), // ③ インパクト: レベルに振り抜く
    pose(125, { G: [106, 94], phi: 438, eps: -14, r: 1.05, tilt: 3, ff: [-5, -3], bk: 15, heel: 22, fe: -1, back: 1 }), // 腕が伸び切る
    pose(165, { G: [66, 66], phi: 512, eps: 20, r: 1.14, tilt: 0, ff: [-5, -3], bk: 16, heel: 26, fe: -1, back: 1 }),  // ④ リストを返す
    pose(215, { G: [33, 60], phi: 588, eps: 28, r: 1.18, tilt: -2, ff: [-5, -3], bk: 16, heel: 28, fe: -1, back: 1, bz: 6 }), // 前肩の上へフィニッシュ
    pose(250, { G: [34, 62], phi: 590, eps: 30, r: 1.16, tilt: -2, ff: [-5, -3], bk: 15, heel: 26, fe: -1, back: 1, bz: 6 }),
    pose(300, { G: [64, 50], phi: 560, eps: 30, r: 0.5, ff: [-2, -1], bk: 5, heel: 8, fe: -1, back: 1, bz: 3 }), // 頭の後ろを通って戻す
    pose(350, { phi: 520 }),                                                                              // ⑤ 構えに戻る
  ],
  power: [
    pose(0, {}),
    pose(34, { G: [107, 49], phi: 166, eps: 62, r: -0.12, ff: [-3, -3], lift: 9 }),
    pose(62, { sw: 0.85, G: [103, 88], phi: 260, eps: 30, r: 0.45, tilt: 6, ff: [-9, -5], lift: 0, bk: 8, bz: 6 }),
    pose(90, { G: [98, 106], phi: 368, eps: 1, r: 0.85, tilt: 8, ff: [-9, -5], bk: 15, heel: 18, bz: 3, trail: 0.85 }),
    pose(130, { G: [108, 94], phi: 448, eps: -14, r: 1.12, tilt: 4, ff: [-9, -5], bk: 18, heel: 26, fe: -1, back: 1, trail: 0.6 }),
    pose(175, { G: [64, 62], phi: 528, eps: 22, r: 1.22, tilt: 0, ff: [-9, -5], bk: 20, heel: 30, fe: -1, back: 1, trail: 0.15 }),
    pose(235, { G: [31, 58], phi: 594, eps: 32, r: 1.3, tilt: -3, ff: [-9, -5], bk: 20, heel: 32, fe: -1, back: 1, bz: 6 }),
    pose(290, { G: [32, 60], phi: 596, eps: 34, r: 1.26, tilt: -3, ff: [-9, -5], bk: 18, heel: 30, fe: -1, back: 1, bz: 6 }),
    pose(355, { G: [64, 50], phi: 570, eps: 30, r: 0.5, ff: [-3, -2], bk: 6, heel: 8, fe: -1, back: 1, bz: 3 }),
    pose(420, { phi: 520 }),
  ],
  // prefers-reduced-motion: 体・足は動かさず、腕とバットだけの短いスイング
  simple: [
    pose(0, {}),
    pose(100, { G: [98, 104], phi: 368, eps: 2, r: 0.6, bz: 3 }),
    pose(170, { sw: 0.25, G: [40, 62], phi: 588, eps: 26, r: 0.9, fe: -1, back: 1, bz: 6 }),
    pose(240, { G: [64, 50], phi: 560, eps: 30, r: 0.4, fe: -1, back: 1, bz: 3 }),
    pose(300, { phi: 520 }),
  ],
};
const STEP_KEYS = ['fe', 'bz', 'back'];

/** 制御点を Catmull-Rom で補間（ステップ値は区間の sw〔既定 0.5〕で切り替え） */
function sampleKeys(keys, t) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const u = clamp((t - k1.t) / (k2.t - k1.t || 1), 0, 1);
  const cr = (a, b, c, d) => {
    const m1 = (c - a) / ((k2.t - k0.t) || 1) * (k2.t - k1.t);
    const m2 = (d - b) / ((k3.t - k1.t) || 1) * (k2.t - k1.t);
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * b + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * c + (u3 - u2) * m2;
  };
  const out = { t };
  for (const key of Object.keys(STANCE)) {
    if (STEP_KEYS.includes(key)) { out[key] = (u >= (k2.sw ?? 0.5) ? k2 : k1)[key]; continue; }
    if (Array.isArray(STANCE[key])) out[key] = [0, 1].map((j) => cr(k0[key][j], k1[key][j], k2[key][j], k3[key][j]));
    else out[key] = cr(k0[key], k1[key], k2[key], k3[key]);
  }
  out.trail = clamp(out.trail, 0, 1);
  return out;
}

/** 2 リンク IK。side=+1/-1 で肘の屈曲側を選ぶ（届かない時は伸び切り）。CSS rotate 角（下向き 0°）を返す */
function solveArm(S, T, side) {
  const { L1, L2 } = BT;
  const dx = T[0] - S[0], dy = T[1] - S[1];
  const d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 1, L1 + L2 - 0.01);
  const ux = dx / (Math.hypot(dx, dy) || 1), uy = dy / (Math.hypot(dx, dy) || 1);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a)) * side;
  const E = [S[0] + a * ux - h * uy, S[1] + a * uy + h * ux];
  const ang = (vx, vy) => Math.atan2(-vx, vy) * 180 / Math.PI;
  const a1 = ang(E[0] - S[0], E[1] - S[1]);
  let a2 = ang(T[0] - E[0], T[1] - E[1]) - a1;
  a2 = ((a2 + 540) % 360) - 180;
  return { a1, a2 };
}

/** バット軸（単位長）の画面投影 [x, y] */
function batVec(phi, eps) {
  const p = phi * Math.PI / 180, e = eps * Math.PI / 180, tx = BT.TILT_X * Math.PI / 180;
  const y1 = -Math.sin(e), z1 = -Math.cos(e) * Math.sin(p);
  return [Math.cos(e) * Math.cos(p), y1 * Math.cos(tx) - z1 * Math.sin(tx)];
}

const r1 = (v) => Math.round(v * 10) / 10;
/** ポーズ → 各パーツの { transform, zIndex?, opacity? } */
function poseStyles(p) {
  const r = p.r, rc = clamp(r, 0, 1);
  const tx = -2 + 4 * r;
  const [px, py] = BT.TORSO_PIVOT;
  const rot = (pt) => {
    const th = p.tilt * Math.PI / 180, x = pt[0] - px, y = pt[1] - py;
    return [px + tx + x * Math.cos(th) - y * Math.sin(th), py + x * Math.sin(th) + y * Math.cos(th)];
  };
  // 肩: 胸の向き β（0=本塁, 90=投手）。構え β=30° では肩が前後に重なり、回転すると左右に開く（後ろ肩が本塁側へ）。
  // 奥（投手側）の肩はカメラ俯角で少し上に見える
  const beta = (30 + 60 * r) * Math.PI / 180, R = BT.SHOULDER;
  const Sb = rot([62 + R * Math.sin(beta), 82 + 0.2 * R * Math.cos(beta)]);
  const Sf = rot([62 - R * Math.sin(beta), 82 - 0.2 * R * Math.cos(beta)]);
  const [bx, by] = batVec(p.phi, p.eps);
  const Hf = p.G, Hb = [p.G[0] + BT.GRIP * bx, p.G[1] + BT.GRIP * by];
  const armB = solveArm(Sb, Hb, 1);        // 後ろ腕: 構えで肘が上、振り出しで腰へ畳む（同じ屈曲側のまま）
  const armF = solveArm(Sf, Hf, p.fe);     // 前腕: インパクトで伸び切り、フォローで反対側へ畳む
  const back = p.back > 0;
  return {
    legF: { transform: `translate(${r1(p.ff[0])}px,${r1(p.ff[1] - p.lift)}px) rotate(${r1(p.lift * 1.6)}deg)` },
    shoeF: { transform: `rotate(${r1(-p.lift * 1.2)}deg)` },
    legB: { transform: `rotate(${r1(-p.bk)}deg)` },
    shoeB: { transform: `rotate(${r1(-p.heel)}deg)` },
    armF: { transform: `translate(${r1(Sf[0])}px,${r1(Sf[1])}px) rotate(${r1(armF.a1)}deg)` },
    foreF: { transform: `rotate(${r1(armF.a2)}deg)` },
    torso: { transform: `translateX(${r1(tx)}px) rotate(${r1(p.tilt)}deg) scaleX(${r1((0.86 + 0.14 * rc) * 100) / 100})` },
    numw: { transform: `translateX(${r1(-11 + 11 * rc)}px)` },
    head: { transform: `translate(${r1(tx * 0.5)}px,${r1(Math.max(0, p.tilt) * 0.3)}px) rotate(${r1(p.tilt * 0.3)}deg)` },
    batw: { transform: `translate(${r1(p.G[0])}px,${r1(p.G[1])}px)`, zIndex: p.bz },
    bat: { transform: `rotateX(${BT.TILT_X}deg) rotateY(${r1(p.phi)}deg) rotateZ(${r1(-p.eps)}deg)` },
    armB: { transform: `translate(${r1(Sb[0])}px,${r1(Sb[1])}px) rotate(${r1(armB.a1)}deg)`, zIndex: back ? 2 : 7 },
    foreB: { transform: `rotate(${r1(armB.a2)}deg)` },
    handF: { transform: `translate(${r1(Hf[0])}px,${r1(Hf[1])}px)`, zIndex: back && p.bz < 6 ? 3 : 8 },
    handB: { transform: `translate(${r1(Hb[0])}px,${r1(Hb[1])}px)`, zIndex: back && p.bz < 6 ? 3 : 8 },
    trail: { opacity: r1(p.trail * 100) / 100 },
  };
}

/** スイングのキーフレーム（パーツ別、WAAPI 用）。モジュール読み込み時に 1 回だけ計算 */
function buildSwing(keys) {
  const dur = keys[keys.length - 1].t;
  const times = [];
  for (let t = 0; t < Math.min(dur, 260); t += 10) times.push(t);
  for (let t = 260; t < dur; t += 20) times.push(t);
  times.push(dur);
  const frames = Object.fromEntries(BT_PARTS.map((k) => [k, []]));
  for (const t of times) {
    const st = poseStyles(sampleKeys(keys, t));
    for (const k of BT_PARTS) frames[k].push({ offset: t / dur, ...st[k] });
  }
  return { dur, frames };
}
const SWINGS = Object.fromEntries(Object.entries(SWING_KEYS).map(([k, keys]) => [k, buildSwing(keys)]));
const STANCE_STYLE = poseStyles({ t: 0, ...STANCE });
const styleAttr = (part) => {
  const s = STANCE_STYLE[part];
  return `transform:${s.transform}${s.zIndex != null ? `;z-index:${s.zIndex}` : ''}${s.opacity != null ? `;opacity:${s.opacity}` : ''}`;
};

/** 打者のちびキャラ HTML（data-bt="パーツ名" をアニメーション対象にする） */
function batterHTML(color, number) {
  const P = (part, cls, inner = '') => `<div class="${cls}" data-bt="${part}" style="${styleAttr(part)}">${inner}</div>`;
  const arm = (side) => P(`arm${side}`, `bt-arm bt-arm-${side.toLowerCase()}`, P(`fore${side}`, 'bt-fore'));
  return `<div class="chibi chibi-batter" style="--team:${esc(color)}"><div class="bt-rig">`
    + P('legF', 'bt-leg bt-leg-f', P('shoeF', 'bt-shoe'))
    + P('legB', 'bt-leg bt-leg-b', P('shoeB', 'bt-shoe'))
    + arm('F')
    + P('torso', 'bt-torso', P('numw', 'bt-numw', `<span class="bt-num">${esc(number)}</span>`) + '<i class="bt-belt"></i>')
    + P('head', 'bt-head', '<i class="bt-neck"></i><i class="bt-skull"></i><i class="bt-ear"></i><i class="bt-hair"></i><i class="bt-helmet"></i><i class="bt-flap"></i><i class="bt-logo"></i>')
    + P('batw', 'bt-batw', P('bat', 'bt-bat', '<i class="bt-handle"></i><i class="bt-barrel"></i><i class="bt-knob"></i>'))
    + arm('B')
    + P('handF', 'bt-hand bt-hand-f') + P('handB', 'bt-hand bt-hand-b')
    + P('trail', 'bt-trail')
    + '</div></div>';
}

/** イベントから安打の塁打数を推定（1..3、不明なら 1） */
function hitBases(event) {
  const n = Number(event.bases ?? event.hitBases ?? event.totalBases);
  if (n >= 1 && n <= 3) return n;
  const s = String(event.hit ?? event.result ?? event.outcome ?? event.detail ?? '').toLowerCase();
  if (s.includes('triple')) return 3;
  if (s.includes('double')) return 2;
  if (s.includes('single')) return 1;
  const t = String(event.text ?? '');
  if (/スリーベース|三塁打/.test(t)) return 3;
  if (/ツーベース|二塁打/.test(t)) return 2;
  return 1;
}

function overlayFor(event) {
  switch (event.kind) {
    case 'ball': return 'ボール';
    case 'strike': return 'ストライク！';
    case 'foul': return 'ファウル';
    case 'hit': return ['ヒット！', 'ツーベース！', 'スリーベース！'][hitBases(event) - 1];
    case 'hr': return event.ball && !event.ball.isHomeRun ? 'ランニングホームラン！' : 'ホームラン！';
    case 'out': return 'アウト';
    case 'double_play': return 'ゲッツー！';
    case 'error': return 'エラー！';
    case 'fielders_choice': return 'フィルダースチョイス';
    case 'sac_fly': return '犠牲フライ';
    case 'strikeout': return '三振！';
    case 'walk': return '四球';
    default: return '';
  }
}

/** 打席結果チップ用の短いラベル（打席完了イベントのみ） */
function chipFor(event) {
  switch (event.kind) {
    case 'hit': return ['安打', '二塁打', '三塁打'][hitBases(event) - 1];
    case 'hr': return '本塁打';
    case 'out': return '凡退';
    case 'double_play': return '併殺';
    case 'error': return '失策出塁';
    case 'fielders_choice': return '野選';
    case 'sac_fly': return '犠飛';
    case 'strikeout': return '三振';
    case 'walk': return '四球';
    default: return null;
  }
}

const CONTACT_KINDS = ['foul', 'hit', 'out', 'hr', 'double_play', 'error', 'fielders_choice', 'sac_fly'];
const OUT_KINDS = ['out', 'double_play', 'fielders_choice', 'sac_fly'];

export function createGameScreen(el, ctx) {
  const missing = REQUIRED.filter((k) => typeof engine[k] !== 'function');
  if (missing.length) {
    throw new Error(`game.js: engine.js に必要な関数がありません: ${missing.join(', ')}`);
  }
  if (!el) throw new Error('game.js: 描画先要素 el がありません');

  const rng = Math.random;
  let state = null;
  let userTeam = null;
  let cpuTeam = null;
  let phase = 'idle'; // idle | ready | menu | pitching | fielding | resolve | change | over
  let cursor = { x: 1, y: 1 };   // 打撃カーソル
  let aim = { x: 1, y: 1 };      // 投球の狙い
  let pitchIdx = 0;              // ユーザー投手の球種インデックス
  let tickerText = '';
  let rafId = 0;
  const timers = new Set();
  const listeners = [];
  const atBatChips = {};         // playerId → ['安打', ...]
  let flight = null;             // 投球アニメ情報
  let lastBatting = null;
  let destroyed = false;
  let dom = {};
  let diff = DIFFICULTY.normal;
  let hitRaf = 0;
  let autoPitchTimer = 0;
  let swingTimer = 0;
  let duckTimer = 0;
  let fieldView = null;          // 守備ビュー（fielding.js）
  let subsMenu = null;           // 采配メニュー（subs.js）
  let logSeen = 0;               // 表示済みの state.log の長さ（交代イベント検出用）

  /** サウンド呼び出し（ctx.sound 未定義・未知の名前でも安全） */
  const play = (name) => { try { ctx.sound?.play?.(name); } catch (e) { /* ignore */ } };
  /** BGM を一時的に下げる（ctx.music 未定義でも安全） */
  const duckMusic = (ms) => {
    try { ctx.music?.duck?.(true); } catch (e) { /* ignore */ }
    clearTimeout(duckTimer);
    duckTimer = setTimeout(() => { duckTimer = 0; try { ctx.music?.duck?.(false); } catch (e) { /* ignore */ } }, ms);
  };

  // ---------- helpers ----------
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
    timers.add(id);
    return id;
  };
  const cancel = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };
  const clearTimers = () => { timers.forEach(clearTimeout); timers.clear(); autoPitchTimer = 0; };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const battingSide = (s = state) => {
    const b = engine.summary(s)?.batting;
    if (b === 'away' || b === 'home') return b;
    return s.half === 'top' ? 'away' : 'home';
  };
  const fieldingSide = (s = state) => (battingSide(s) === 'away' ? 'home' : 'away');
  const userSide = () => state.userSide || 'away';
  const userBatting = () => battingSide() === userSide();

  const inningLabel = (s = state) => engine.summary(s)?.inningLabel || `${s.inning}回${s.half === 'top' ? '表' : '裏'}`;
  const scores = () => engine.summary(state)?.score || { away: 0, home: 0 };

  const userPitches = () => {
    const p = engine.getPitcher(state);
    const list = (p?.pitching?.pitches || []).map((q) => ({ type: q.type, name: q.name || PITCH_TYPES[q.type]?.name || q.type, level: q.level }));
    if (!list.some((q) => q.type === 'fastball')) list.unshift({ type: 'fastball', name: PITCH_TYPES.fastball?.name || 'ストレート', level: null });
    else list.sort((a, b) => (a.type === 'fastball' ? -1 : b.type === 'fastball' ? 1 : 0));
    return list;
  };

  const breakOf = (type, pitcher) => {
    const t = PITCH_TYPES[type] || { dx: 0, dy: 0 };
    const flip = pitcher?.throws === '左' ? -1 : 1;
    return { dx: (Number(t.dx) || 0) * flip, dy: Number(t.dy) || 0 };
  };

  /** 投球位置（セル単位、中心0）→ ボール左上 px */
  const locToPx = (loc) => ({ left: ZONE_CX + loc.x * CELL - BALL_HALF, top: ZONE_CY + loc.y * CELL - BALL_HALF });
  const predictLoc = (pitch) => {
    const b = breakOf(pitch.type, engine.getPitcher(state));
    return { x: clamp(pitch.zone.x - 1 + b.dx, -2.2, 2.2), y: clamp(pitch.zone.y - 1 + b.dy, -2.2, 2.2) };
  };
  const validLoc = (l) => l && Number.isFinite(Number(l.x)) && Number.isFinite(Number(l.y));

  // ---------- template ----------
  function template() {
    const away = state.teams.away;
    const home = state.teams.home;
    const cells = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) cells.push(`<div class="zone-cell" data-x="${x}" data-y="${y}"></div>`);
    const lamps = (cls, n) => Array.from({ length: n }, () => `<i class="lamp ${cls}"></i>`).join('');
    const pitcher = engine.getPitcher(state);
    return `
<div class="game">
  <div class="game-field"><div class="gf-sky"></div><div class="gf-stand"></div><div class="gf-vision"><b>DOKIDOKI</b><span>STADIUM</span></div><div class="gf-fence"><span>ドキドキ食堂</span><span>ベースボールソーダ</span><span>ナイスバッティング</span></div><div class="gf-grass"></div><div class="gf-infield"></div><div class="gf-mound"></div><div class="gf-dirt"></div><div class="gf-lines"></div><div class="gf-plate"></div></div>
  <header class="game-header">
    <div class="hteam away"><span class="team-badge" style="background:${esc(away.color)}">${esc(away.short)}</span><span class="team-name">${esc(away.name)}</span><span class="score-num" data-score="away">0</span></div>
    <div class="inning" data-ref="inning"></div>
    <div class="hteam home"><span class="score-num" data-score="home">0</span><span class="team-name">${esc(home.name)}</span><span class="team-badge" style="background:${esc(home.color)}">${esc(home.short)}</span></div>
    <div class="lamps">
      <div class="lamp-row"><b>B</b><span data-lamps="b">${lamps('lamp-b', 3)}</span></div>
      <div class="lamp-row"><b>S</b><span data-lamps="s">${lamps('lamp-s', 2)}</span></div>
      <div class="lamp-row"><b>O</b><span data-lamps="o">${lamps('lamp-o', 2)}</span></div>
    </div>
    <div class="runners"><i class="base b2" data-base="1"></i><i class="base b3" data-base="2"></i><i class="base b1" data-base="0"></i></div>
    <div class="gh-btns">
      <button type="button" class="menu-btn subs-btn" data-ref="subs" title="選手交代（Esc）">さいはい</button>
      <button type="button" class="menu-btn" data-ref="menu">メニュー</button>
    </div>
  </header>

  <aside class="panel panel-left" data-ref="pitcher-panel">
    <div class="panel-head"><span class="role-chip">投手</span><span class="panel-name" data-ref="p-name"></span><span class="hand-chip" data-ref="p-meta"></span></div>
    <div class="velo-row"><span class="lbl">球速</span><b data-ref="p-velo">-</b><small>km/h</small></div>
    <div class="stamina-row"><span class="lbl">スタミナ</span><div class="stamina-bar"><i data-ref="p-stamina"></i></div><b data-ref="p-stamina-num">100</b></div>
    <ul class="pitch-list" data-ref="p-pitches"></ul>
    <div class="pitch-count"><span>投球数</span><b data-ref="p-count">0</b></div>
  </aside>

  <aside class="panel panel-right" data-ref="batter-panel">
    <div class="panel-head"><span class="role-chip is-bat">打者</span><span class="panel-name" data-ref="b-name"></span><span class="hand-chip" data-ref="b-hand"></span></div>
    <div class="order-line" data-ref="b-meta"></div>
    <div class="abilities" data-ref="b-abilities"></div>
    <div class="today"><div class="today-title">本日の成績</div><div class="today-chips" data-ref="b-today"></div></div>
  </aside>

  ${chibiHTML('chibi-pitcher', teamColor('field'), pitcher?.number ?? '')}
  <div data-ref="batter-wrap">${batterHTML(teamColor('bat'), '')}</div>

  <div class="zone">${cells.join('')}</div>
  <div class="ghost" data-ref="ghost"></div>
  <div class="cursor" data-ref="cursor"></div>
  <div class="ball-shadow" data-ref="ball-shadow"></div>
  <div class="ball" data-ref="ball" style="opacity:0"></div>
  <div class="spark" data-ref="spark"></div>

  <div class="ticker"><span class="ticker-tag">実況</span><span class="ticker-text" data-ref="ticker"></span></div>

  <div class="dpad">
    <button type="button" class="dpad-btn up" data-key="up" aria-label="上">▲</button>
    <button type="button" class="dpad-btn left" data-key="left" aria-label="左">◀</button>
    <button type="button" class="dpad-btn right" data-key="right" aria-label="右">▶</button>
    <button type="button" class="dpad-btn down" data-key="down" aria-label="下">▼</button>
  </div>
  <div class="action-btns">
    <button type="button" class="btn-x" data-key="x" aria-label="X"><b>X</b><small data-ref="x-label">強振</small></button>
    <button type="button" class="btn-z" data-key="z" aria-label="Z"><b>Z</b><small data-ref="z-label">ミート</small></button>
  </div>

  <div class="overlay" data-ref="overlay"><div class="overlay-big" data-ref="overlay-big"></div><div class="overlay-sub" data-ref="overlay-sub"></div></div>
</div>`;
  }

  function teamColor(which) {
    const side = which === 'bat' ? battingSide() : fieldingSide();
    return state.teams[side]?.color || '#E5484D';
  }

  function cacheDom() {
    const q = (s) => el.querySelector(s);
    dom = {
      root: q('.game'),
      scoreAway: q('[data-score="away"]'),
      scoreHome: q('[data-score="home"]'),
      inning: q('[data-ref="inning"]'),
      lampsB: el.querySelectorAll('[data-lamps="b"] .lamp'),
      lampsS: el.querySelectorAll('[data-lamps="s"] .lamp'),
      lampsO: el.querySelectorAll('[data-lamps="o"] .lamp'),
      bases: [q('[data-base="0"]'), q('[data-base="1"]'), q('[data-base="2"]')],
      menu: q('[data-ref="menu"]'),
      subs: q('[data-ref="subs"]'),
      pName: q('[data-ref="p-name"]'),
      pMeta: q('[data-ref="p-meta"]'),
      pVelo: q('[data-ref="p-velo"]'),
      pStamina: q('[data-ref="p-stamina"]'),
      pStaminaNum: q('[data-ref="p-stamina-num"]'),
      bHand: q('[data-ref="b-hand"]'),
      ghost: q('[data-ref="ghost"]'),
      spark: q('[data-ref="spark"]'),
      ballShadow: q('[data-ref="ball-shadow"]'),
      pPitches: q('[data-ref="p-pitches"]'),
      pCount: q('[data-ref="p-count"]'),
      bName: q('[data-ref="b-name"]'),
      bMeta: q('[data-ref="b-meta"]'),
      bAbilities: q('[data-ref="b-abilities"]'),
      bToday: q('[data-ref="b-today"]'),
      pitcherChibi: q('.chibi-pitcher'),
      batterChibi: q('.chibi-batter'),
      batterNum: q('.chibi-batter .bt-num'),
      cells: el.querySelectorAll('.zone-cell'),
      cursor: q('[data-ref="cursor"]'),
      ball: q('[data-ref="ball"]'),
      ticker: q('[data-ref="ticker"]'),
      overlay: q('[data-ref="overlay"]'),
      overlayBig: q('[data-ref="overlay-big"]'),
      overlaySub: q('[data-ref="overlay-sub"]'),
      xLabel: q('[data-ref="x-label"]'),
      zLabel: q('[data-ref="z-label"]'),
    };
  }

  function bindInputs() {
    const on = (node, type, fn, opts) => { if (!node) return; node.addEventListener(type, fn, opts); listeners.push([node, type, fn, opts]); };
    el.querySelectorAll('.game > .dpad [data-key], .game > .action-btns [data-key]').forEach((btn) => {
      on(btn, 'pointerdown', (e) => { e.preventDefault(); handleKey(btn.dataset.key); });
      on(btn, 'pointerup', () => handleKeyUp(btn.dataset.key));
      on(btn, 'contextmenu', (e) => e.preventDefault());
    });
    on(dom.menu, 'click', (e) => { e.preventDefault(); if (!subsMenu) ctx.go?.('title'); });
    on(dom.subs, 'click', (e) => {
      e.preventDefault();
      dom.subs.blur();
      if (canOpenSubs()) openSubs();
      else if (!subsMenu) { tickerText = '采配は投球の合間にできます'; render(); }
    });
  }

  // ---------- render (patch) ----------
  function abilityBadge(label, value, r) {
    const color = RANK_COLORS[r] || '#9E9E9E';
    const fg = r === 'C' ? '#1C2B4B' : '#fff';
    return `<div class="ability"><span class="ability-label">${esc(label)}</span><span class="ability-badge" style="background:${esc(color)};color:${fg}">${esc(r)}</span><span class="ability-value">${esc(value)}</span></div>`;
  }

  /** 投手の残りスタミナ（state.stamina は playerId → 残量、満タン = pitching.stamina） */
  function staminaOf(pitcher) {
    const max = Number(pitcher?.pitching?.stamina) || 0;
    const cur = state.stamina?.[pitcher?.id];
    const c = typeof cur === 'number' ? cur : max;
    return { cur: c, ratio: max > 0 ? clamp(c / max, 0, 1) : 0 };
  }

  function render() {
    if (!state || !dom.root) return;
    const sc = scores();
    dom.scoreAway.textContent = sc.away;
    dom.scoreHome.textContent = sc.home;
    dom.inning.textContent = inningLabel();
    const b = state.balls ?? 0, s = state.strikes ?? 0, o = state.outs ?? 0;
    dom.lampsB.forEach((l, i) => l.classList.toggle('on-b', i < b));
    dom.lampsS.forEach((l, i) => l.classList.toggle('on-s', i < s));
    dom.lampsO.forEach((l, i) => l.classList.toggle('on-o', i < o));
    const bases = state.bases || [null, null, null];
    dom.bases.forEach((n, i) => n && n.classList.toggle('on', !!bases[i]));

    // pitcher panel
    const fSide = fieldingSide();
    const pitcher = engine.getPitcher(state);
    const userPitching = !userBatting();
    if (pitcher) {
      dom.pName.textContent = pitcher.name;
      dom.pMeta.textContent = `${pitcher.throws}投`;
      dom.pVelo.textContent = pitcher.pitching?.velocity ?? '-';
      const st = staminaOf(pitcher);
      dom.pStamina.style.width = `${Math.round(st.ratio * 100)}%`;
      dom.pStamina.classList.toggle('low', st.ratio < 0.3);
      if (dom.pStaminaNum) dom.pStaminaNum.textContent = Math.round(st.cur);
      const list = userPitches();
      dom.pPitches.innerHTML = list.map((p, i) => `<li class="pitch-item${userPitching && i === pitchIdx ? ' selected' : ''}" data-type="${esc(p.type)}" title="${esc(p.name)}"><span>${esc(p.name)}</span>${p.level ? `<b>${esc('★'.repeat(Math.min(5, p.level)))}</b>` : ''}</li>`).join('');
      dom.pCount.textContent = state.pitchCount?.[fSide] ?? 0;
      if (dom.pitcherChibi) {
        dom.pitcherChibi.style.setProperty('--team', state.teams[fSide]?.color || '#1E88E5');
        const body = dom.pitcherChibi.querySelector('.chibi-body');
        if (body) body.textContent = pitcher.number;
      }
    }

    // batter panel
    const bSide = battingSide();
    const batter = engine.getBatter(state);
    if (batter) {
      const view = engine.lineupView(state, bSide).find((l) => l.id === batter.id);
      const order = view ? view.slot + 1 : ((state.batterIndex?.[bSide] ?? 0) % 9) + 1;
      const pos = view?.pos || batter.pos || '';
      dom.bName.textContent = batter.name;
      dom.bMeta.innerHTML = `<b>${order}番</b>・${esc(POS_NAMES[pos] || pos)}`;
      if (dom.bHand) dom.bHand.textContent = `${batter.bats}打`;
      const traj = clamp(Number(batter.trajectory) || 1, 1, 4);
      dom.bAbilities.innerHTML = [
        abilityBadge('弾道', traj, ['D', 'C', 'B', 'A'][traj - 1]),
        abilityBadge('ミート', batter.contact, rank(batter.contact)),
        abilityBadge('パワー', batter.power, rank(batter.power)),
        abilityBadge('走力', batter.speed, rank(batter.speed)),
      ].join('');
      const st = state.stats?.[batter.id];
      const chips = [];
      if (st) {
        chips.push(`${st.ab ?? 0}打数${st.h ?? 0}安打`);
        if (st.hr) chips.push(`${st.hr}本塁打`);
        if (st.rbi) chips.push(`${st.rbi}打点`);
      }
      (atBatChips[batter.id] || []).forEach((c) => chips.push(c));
      if (!chips.length) chips.push('第1打席');
      dom.bToday.innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');

      if (dom.batterChibi) {
        const lefty = batter.bats === '左';
        dom.batterChibi.style.setProperty('--team', state.teams[bSide]?.color || '#E5484D');
        dom.batterChibi.style.left = `${lefty ? BATTER_LEFT_L : BATTER_LEFT_R}px`;
        dom.batterChibi.style.top = `${BATTER_TOP}px`;
        dom.batterChibi.style.transform = lefty ? `scale(-${BATTER_SCALE}, ${BATTER_SCALE})` : `scale(${BATTER_SCALE})`;
        dom.batterChibi.classList.toggle('lefty', !!lefty);
        if (dom.batterNum) dom.batterNum.textContent = batter.number;
      }
    }

    // zone / cursor
    const batting = userBatting();
    dom.cells.forEach((c) => {
      const x = Number(c.dataset.x), y = Number(c.dataset.y);
      c.classList.toggle('target', !batting && x === aim.x && y === aim.y);
    });
    if (dom.cursor) {
      dom.cursor.style.display = batting ? '' : 'none';
      dom.cursor.style.left = `${ZONE_LEFT + cursor.x * CELL + CELL / 2 - 48}px`;
      dom.cursor.style.top = `${ZONE_TOP + cursor.y * CELL + CELL / 2 - 28}px`;
    }
    if (dom.xLabel) dom.xLabel.textContent = batting ? '強振' : '球種';
    if (dom.zLabel) dom.zLabel.textContent = batting ? 'ミート' : '投げる';
    if (dom.subs) dom.subs.classList.toggle('is-disabled', !canOpenSubs() && !subsMenu);
    dom.ticker.textContent = tickerText;
  }

  // ---------- overlay ----------
  function showOverlay(big, sub, ms, then, cls = '') {
    dom.overlayBig.textContent = big;
    dom.overlaySub.textContent = sub || '';
    dom.overlay.className = `overlay show ${cls}`.trim();
    later(() => {
      dom.overlay.className = 'overlay';
      if (then) then();
    }, ms);
  }

  // ---------- swing animation ----------
  let swingAnims = [];
  /** スイング（キー押下・CPU 打者共通）。パーツ別の WAAPI キーフレーム（SWINGS）を再生 */
  function swingAnim(mode) {
    const n = dom.batterChibi;
    if (!n) return;
    const kind = mode === 'power' ? 'power' : 'meet';
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sw = SWINGS[reduce ? 'simple' : kind];
    const cls = `swing-${kind}`;
    swingAnims.forEach((a) => { try { a.cancel(); } catch (e) { /* ignore */ } });
    swingAnims = [];
    n.classList.remove('swing-meet', 'swing-power');
    void n.offsetWidth; // reflow して再生し直す
    n.classList.add(cls);
    if (typeof n.animate === 'function') {
      n.querySelectorAll('[data-bt]').forEach((part) => {
        const frames = sw.frames[part.dataset.bt];
        if (frames) swingAnims.push(part.animate(frames, { duration: sw.dur, easing: 'linear' }));
      });
    }
    clearTimeout(swingTimer);
    swingTimer = setTimeout(() => { n.classList.remove(cls); swingTimer = 0; }, Math.max(sw.dur, SWING_MS[kind]) + 40);
  }

  // ---------- flow ----------
  function readyHint() {
    return userBatting()
      ? '←→↑↓:カーソル  Z:ミート  X:強振  Enter:見送り  Esc:さいはい'
      : '←→↑↓:コース  X:球種変更  Z:投げる  Esc:さいはい';
  }

  function enterReady() {
    if (destroyed) return;
    phase = 'ready';
    flight = null;
    resetBall();
    const list = userPitches();
    if (pitchIdx >= list.length) pitchIdx = 0;
    render();
    scheduleAutoPitch();
  }

  function scheduleAutoPitch() {
    cancel(autoPitchTimer);
    autoPitchTimer = 0;
    if (!userBatting() || phase !== 'ready') return;
    autoPitchTimer = later(() => { autoPitchTimer = 0; if (phase === 'ready' && !subsMenu) startCpuPitch(false); }, CPU_PITCH_DELAY_MS);
  }

  /** ボール・影・ゴーストを初期状態へ */
  function resetBall() {
    if (hitRaf) { cancelAnimationFrame(hitRaf); hitRaf = 0; }
    if (dom.ball) { dom.ball.style.opacity = '0'; dom.ball.classList.remove('flying'); }
    if (dom.ballShadow) dom.ballShadow.style.opacity = '0';
    if (dom.ghost) dom.ghost.classList.remove('show');
  }

  function startFlight(pitch, finalLoc, onArrive) {
    const start = now();
    const ms = diff.flight;
    const aimLoc = { x: pitch.zone.x - 1, y: pitch.zone.y - 1 };
    flight = { pitch, start, arrival: start + ms, aimLoc, finalLoc, swung: false, batInput: null, take: false, onArrive, done: false };
    play('pitch');
    if (dom.ball) { dom.ball.classList.remove('flying'); dom.ball.style.opacity = '1'; }
    if (dom.ghost) {
      const show = diff.ghost && userBatting();
      if (show) {
        const g = locToPx(finalLoc);
        dom.ghost.style.left = `${g.left + BALL_HALF}px`;
        dom.ghost.style.top = `${g.top + BALL_HALF}px`;
      }
      dom.ghost.classList.toggle('show', show);
    }
    const step = () => {
      if (destroyed || !flight) return;
      const t = clamp((now() - flight.start) / ms, 0, 1);
      const sx = PITCHER_X, sy = PITCHER_Y;
      const tgt = locToPx(flight.aimLoc);
      const fin = locToPx(flight.finalLoc);
      // 直線的に狙いへ向かい、終盤に変化（t^2.5）で最終位置へ寄せる
      const brk = Math.pow(t, 2.5);
      const left = (sx - BALL_HALF) + (tgt.left - (sx - BALL_HALF)) * t + (fin.left - tgt.left) * brk;
      const top = (sy - BALL_HALF) + (tgt.top - (sy - BALL_HALF)) * t + (fin.top - tgt.top) * brk;
      if (dom.ball) {
        dom.ball.style.left = `${left.toFixed(1)}px`;
        dom.ball.style.top = `${top.toFixed(1)}px`;
        dom.ball.style.transform = `scale(${(0.4 + 0.6 * t).toFixed(3)})`;
      }
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        rafId = 0;
        if (!flight.done) { flight.done = true; flight.onArrive(); }
      }
    };
    rafId = requestAnimationFrame(step);
  }

  /** CPU 投球（ユーザー打撃）。take=true は Enter による明示的見送り */
  function startCpuPitch(take) {
    if (phase !== 'ready' || subsMenu) return;
    cancel(autoPitchTimer);
    autoPitchTimer = 0;
    phase = 'pitching';
    let pitch = engine.choosePitch(state, rng);
    let finalLoc = null;
    // 到達位置を先に確定させ（pitchContact は pitch.loc を優先）、アニメとゴーストを一致させる
    if (typeof engine.pitchLocation === 'function') {
      try {
        const loc = engine.pitchLocation(state, pitch, rng);
        if (validLoc(loc)) { pitch = { ...pitch, loc }; finalLoc = { x: Number(loc.x), y: Number(loc.y) }; }
      } catch (e) { /* fall back */ }
    }
    tickerText = `${engine.getPitcher(state)?.name ?? '投手'}、投げた！`;
    render();
    startFlight(pitch, finalLoc || predictLoc(pitch), () => {
      // 到着後 TAKE_GRACE_MS までスイングを受け付ける
      later(() => {
        if (phase !== 'pitching' || !flight) return;
        if (!flight.swung) finishPitch(pitch, null);
      }, TAKE_GRACE_MS);
    });
    flight.take = !!take;
  }

  function userSwing(mode) {
    if (!flight || flight.swung || flight.take) return;
    const t = now();
    if (t > flight.arrival + TAKE_GRACE_MS) return;
    flight.swung = true;
    play('swing');
    swingAnim(mode);
    const timing = clamp((t - flight.arrival) / diff.timing, -1, 1);
    const batInput = { zone: { x: cursor.x, y: cursor.y }, mode, timing };
    const pitch = flight.pitch;
    const wait = Math.max(0, flight.arrival - t);
    later(() => { if (phase === 'pitching') finishPitch(pitch, batInput); }, wait);
  }

  /** ユーザー投球 */
  function userThrow() {
    if (phase !== 'ready' || userBatting()) return;
    const list = userPitches();
    const type = list[pitchIdx]?.type || 'fastball';
    const pitchInput = { type, zone: { x: aim.x, y: aim.y } };
    const batInput = engine.chooseSwing(state, pitchInput, rng) || null;
    phase = 'pitching';
    const prev = state;
    const res = engine.pitchContact(state, pitchInput, batInput, rng);
    const evLoc = res?.event?.pitch?.loc ?? res?.event?.location;
    const loc = validLoc(evLoc) ? { x: Number(evLoc.x), y: Number(evLoc.y) } : predictLoc(pitchInput);
    tickerText = `${engine.getPitcher(prev)?.name ?? '投手'}、${list[pitchIdx]?.name ?? ''}を投げた！`;
    render();
    // CPU 打者もキー入力と同じスイング（バットがゾーンを横切る瞬間 = 到達時）
    if (batInput) {
      later(() => { if (phase === 'pitching') { play('swing'); swingAnim(batInput.mode); } }, Math.max(0, diff.flight - SWING_CONTACT_MS));
    }
    startFlight(pitchInput, loc, () => handleContact(prev, res));
  }

  function finishPitch(pitch, batInput) {
    if (phase !== 'pitching') return;
    const prev = state;
    const res = engine.pitchContact(state, pitch, batInput, rng);
    const evLoc = res?.event?.pitch?.loc ?? res?.event?.location;
    if (validLoc(evLoc) && dom.ball) {
      const px = locToPx({ x: Number(evLoc.x), y: Number(evLoc.y) });
      dom.ball.style.left = `${px.left}px`;
      dom.ball.style.top = `${px.top}px`;
    }
    handleContact(prev, res);
  }

  /** pitchContact の結果を振り分け: 打球（本塁打以外）は守備ビューへ、それ以外は即結果表示 */
  function handleContact(prev, res) {
    if (destroyed) return;
    if (res?.ball && !res.ball.isHomeRun && res.state?.pending) startInPlay(prev, res);
    else applyResult(prev, res);
  }

  // ---------- 打球 → 守備ビュー ----------
  function startInPlay(prev, res) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    phase = 'fielding';
    state = res.state;
    const wasUserBatting = battingSide(prev) === (prev.userSide || 'away');
    const batter = engine.getBatter(prev);
    if (dom.ghost) dom.ghost.classList.remove('show');
    play('hit');
    const c = wasUserBatting && dom.cursor
      ? { x: ZONE_LEFT + cursor.x * CELL + CELL / 2, y: ZONE_TOP + cursor.y * CELL + CELL / 2 }
      : ballCenter();
    sparkAt(c.x, c.y);
    tickerText = `${batter?.name ?? ''}、打った！`;
    render();
    later(() => openFieldView(prev, res.ball, wasUserBatting), FIELD_OPEN_MS);
  }

  function buildFielders(side) {
    const team = state.teams[side];
    return engine.lineupView(state, side).map((l) => {
      const p = l.player || {};
      return { id: l.id, name: l.name, pos: l.pos, speed: p.speed, fielding: p.fielding, arm: p.arm, catching: p.catching, color: team.color };
    });
  }

  function openFieldView(prev, ball, wasUserBatting) {
    if (destroyed || phase !== 'fielding') return;
    resetBall();
    const fSide = fieldingSide();
    const bSide = battingSide();
    const batter = engine.getBatter(state);
    const userFielding = fSide === userSide();
    let done = false;
    const onDone = (result) => {
      if (done) return;
      done = true;
      // onDone は守備ビューのフレーム処理中に呼ばれるので、破棄は次のタスクで行う
      later(() => finishInPlay(prev, ball, result, wasUserBatting), 0);
    };
    try {
      fieldView = createFieldingView(dom.root, {
        state, ball, side: fSide, userControlled: userFielding,
        fielders: buildFielders(fSide),
        runners: engine.summary(state).runners,
        batterSpeed: batter?.speed,
        positions: engine.DEFAULT_POSITIONS, field: engine.FIELD,
        runnerColor: state.teams[bSide]?.color,
        batterId: batter?.id, batterName: batter?.name,
        sound: ctx.sound,
        onDone,
      });
      fieldView.start();
    } catch (e) {
      console.error(e);
      fieldView = null;
      finishInPlay(prev, ball, null, wasUserBatting);
    }
  }

  function finishInPlay(prev, ball, result, wasUserBatting) {
    if (destroyed) return;
    let res = null;
    try {
      res = engine.resolveBattedBall(state, ball, result ?? engine.autoField(state, ball, rng), rng);
    } catch (e) {
      // ユーザー守備の結果が不正な場合は CPU 守備で処理
      console.warn(e);
      res = engine.resolveBattedBall(state, ball, engine.autoField(state, ball, rng), rng);
    }
    if (fieldView) { try { fieldView.destroy(); } catch (e) { /* ignore */ } fieldView = null; }
    applyResult(prev, res, { fromField: true, wasUserBatting });
  }

  // ---------- batted-ball / swing feedback (purely visual) ----------
  function ballCenter() {
    const l = parseFloat(dom.ball?.style.left), t = parseFloat(dom.ball?.style.top);
    return Number.isFinite(l) && Number.isFinite(t) ? { x: l + BALL_HALF, y: t + BALL_HALF } : { x: PLATE_X, y: PLATE_Y };
  }

  function restartAnim(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth; // reflow して再生し直す
    node.classList.add(cls);
  }

  function sparkAt(x, y) {
    if (!dom.spark) return;
    dom.spark.style.left = `${x}px`;
    dom.spark.style.top = `${y}px`;
    restartAnim(dom.spark, 'go');
  }

  function animateBattedBall(event) {
    if (!dom.ball) return;
    const o = event.kind === 'hr' ? 'hr' : 'foul';
    const s0 = ballCenter();
    let tx = event.kind === 'hr' && event.ball ? clamp(640 + Number(event.ball.dirDeg || 0) * 9, 300, 980) : hitDirX(event.text);
    let ty, arc, endScale, ms = HIT_FLY_MS;
    if (o === 'hr') { tx = clamp(tx, 380, 900); ty = -70; arc = 220; endScale = 0.3; ms = 900; } else {
      tx = Math.random() < 0.5 ? -60 : 1340; ty = 140 + Math.random() * 120; arc = 150; endScale = 0.6;
    }
    const start = now();
    const ball = dom.ball, shadow = dom.ballShadow;
    ball.classList.add('flying');
    ball.style.opacity = '1';
    let shook = false;
    if (shadow) shadow.style.opacity = '0';
    if (hitRaf) cancelAnimationFrame(hitRaf);
    const step = () => {
      if (destroyed) return;
      const t = clamp((now() - start) / ms, 0, 1);
      const e = 1 - Math.pow(1 - t, 2);
      const gx = s0.x + (tx - s0.x) * e;
      const gy = s0.y + (ty - s0.y) * e;
      const y = gy - arc * 4 * t * (1 - t);
      const sc = 1 + (endScale - 1) * e;
      ball.style.left = `${(gx - BALL_HALF).toFixed(1)}px`;
      ball.style.top = `${(y - BALL_HALF).toFixed(1)}px`;
      ball.style.transform = `scale(${sc.toFixed(3)})`;
      if (o === 'hr' && !shook && y < 200) { shook = true; restartAnim(dom.root, 'shake'); }
      if (t < 1) hitRaf = requestAnimationFrame(step);
      else { hitRaf = 0; ball.style.opacity = '0'; }
    };
    hitRaf = requestAnimationFrame(step);
  }

  /** 大きなプレー（BGM を下げて歓声・効果音を聞かせる） */
  function isBigPlay(event) {
    return event.kind === 'hr' || event.kind === 'double_play' || (event.kind === 'hit' && hitBases(event) >= 2)
      || (event.runs || 0) >= 2 || /サヨナラ/.test(event.text || '');
  }

  /** 結果に応じた効果音と演出 */
  function feedback(event, wasUserBatting, fromField) {
    const kind = event.kind;
    if (dom.ghost) dom.ghost.classList.remove('show');
    if (isBigPlay(event)) duckMusic(kind === 'hr' ? 3200 : 2000);
    if (CONTACT_KINDS.includes(kind)) {
      if (!fromField) {
        play('hit');
        if (kind === 'foul') play('foul');
        const c = wasUserBatting && dom.cursor
          ? { x: ZONE_LEFT + cursor.x * CELL + CELL / 2, y: ZONE_TOP + cursor.y * CELL + CELL / 2 }
          : ballCenter();
        sparkAt(c.x, c.y);
        animateBattedBall(event);
      }
      if (kind === 'hr') play('homerun');
      if (OUT_KINDS.includes(kind)) later(() => play('out'), fromField ? 60 : 350);
      if (kind === 'hit' || kind === 'hr' || kind === 'error' || event.runs > 0) later(() => play('cheer'), fromField ? 80 : 300);
      return;
    }
    play('catch');
    if (event.swing && wasUserBatting) restartAnim(dom.cursor, 'miss');
    if (kind === 'ball' || kind === 'walk') play('ball');
    else if (kind === 'strike') play('strike');
    else if (kind === 'strikeout') { play('strike'); later(() => play('strikeout'), 300); }
    if (event.runs > 0) later(() => play('cheer'), 300);
  }

  /** state.log に増えた交代イベント（CPU 采配・自動登板） */
  function takeNewSubs() {
    const log = state.log || [];
    const out = log.slice(logSeen).filter((e) => e && e.kind === 'sub');
    logSeen = log.length;
    return out;
  }

  function applyResult(prev, res, opts = {}) {
    if (destroyed) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    phase = 'resolve';
    const event = res?.event || { kind: 'ball', text: '' };
    const batterBefore = engine.getBatter(prev);
    const wasUserBatting = opts.wasUserBatting ?? (battingSide(prev) === (prev.userSide || 'away'));
    state = res?.state || state;
    const chip = chipFor(event);
    if (chip && batterBefore) (atBatChips[batterBefore.id] ||= []).push(chip);
    tickerText = event.text || overlayFor(event);
    const subs = takeNewSubs();

    render();
    feedback(event, wasUserBatting, !!opts.fromField);
    const sub = event.runs ? `${event.runs}点！` : '';
    const big = overlayFor(event);
    const cls = event.kind === 'hr' ? 'is-hr' : ['double_play', 'error'].includes(event.kind) ? 'is-big' : '';
    const ms = event.kind === 'hr' ? RESULT_MS + 600 : RESULT_MS;
    showOverlay(big, sub, ms, () => showSubs(subs, afterResult), cls);
  }

  /** 交代イベントを短いオーバーレイで順に表示 */
  function showSubs(subs, then) {
    if (!subs.length) { then(); return; }
    const [ev, ...rest] = subs;
    if (dom.overlay) dom.overlay.className = 'overlay';
    resetBall();
    const label = SUB_LABEL[ev.subType] || '選手交代';
    const team = state.teams[ev.side];
    tickerText = `${team?.short ? `[${team.short}] ` : ''}${ev.text || label}`;
    render();
    play('select');
    showOverlay(label, ev.text || '', SUB_OVERLAY_MS, () => showSubs(rest, then), 'is-sub');
  }

  function afterResult() {
    if (destroyed) return;
    resetBall();
    if (engine.isGameOver(state)) {
      phase = 'over';
      play('gameset');
      duckMusic(GAMESET_MS + 400);
      tickerText = '試合終了！';
      render();
      showOverlay('GAME SET', `${state.teams.away.name} ${scores().away} - ${scores().home} ${state.teams.home.name}`, GAMESET_MS + 400, null);
      later(() => ctx.onGameOver?.(state), GAMESET_MS);
      return;
    }
    const batting = battingSide();
    if (batting !== lastBatting) {
      lastBatting = batting;
      phase = 'change';
      render();
      const team = state.teams[batting];
      showOverlay(`${inningLabel()} ${team?.name ?? ''}の攻撃`, '', CHANGE_MS, () => {
        tickerText = readyHint();
        enterReady();
      });
      return;
    }
    enterReady();
  }

  // ---------- 采配（選手交代） ----------
  function canOpenSubs() {
    return !!state && phase === 'ready' && !subsMenu && !fieldView && !state.pending && !flight
      && !engine.isGameOver(state) && typeof openSubsMenu === 'function';
  }

  function openSubs() {
    if (!canOpenSubs()) return;
    cancel(autoPitchTimer);
    autoPitchTimer = 0;
    phase = 'menu';
    play('select');
    try {
      subsMenu = openSubsMenu(el, {
        state, side: userSide(), engine,
        mode: userBatting() ? 'batting' : 'fielding',
        onApply(newState, text) {
          if (!newState) return;
          state = newState;
          logSeen = (state.log || []).length; // 自分の交代はオーバーレイ不要
          tickerText = text || '選手交代';
          render();
        },
        onClose() {
          subsMenu = null;
          if (destroyed) return;
          phase = 'ready';
          enterReady();
        },
      });
    } catch (e) {
      console.error(e);
      subsMenu = null;
      phase = 'ready';
      enterReady();
      return;
    }
    render();
  }

  // ---------- input ----------
  function handleKey(key) {
    if (destroyed || !state) return;
    if (subsMenu) { subsMenu.handleKey(key); return; }
    if (fieldView) { fieldView.handleKey(key, true); return; }
    if (phase === 'over' || phase === 'idle') return;
    if (key === 'esc') { if (canOpenSubs()) openSubs(); return; }
    const batting = userBatting();
    if (batting) {
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
        if (key === 'up') cursor.y = clamp(cursor.y - 1, 0, 2);
        if (key === 'down') cursor.y = clamp(cursor.y + 1, 0, 2);
        if (key === 'left') cursor.x = clamp(cursor.x - 1, 0, 2);
        if (key === 'right') cursor.x = clamp(cursor.x + 1, 0, 2);
        render();
        return;
      }
      if (key === 'z' || key === 'x') {
        if (phase === 'pitching') userSwing(key === 'z' ? 'meet' : 'power');
        return;
      }
      if (key === 'enter' && phase === 'ready') startCpuPitch(true);
      return;
    }
    // ユーザー投球
    if (phase !== 'ready') return;
    if (key === 'up') aim.y = clamp(aim.y - 1, 0, 2);
    else if (key === 'down') aim.y = clamp(aim.y + 1, 0, 2);
    else if (key === 'left') aim.x = clamp(aim.x - 1, 0, 2);
    else if (key === 'right') aim.x = clamp(aim.x + 1, 0, 2);
    else if (key === 'x') {
      const n = userPitches().length;
      pitchIdx = n ? (pitchIdx + 1) % n : 0;
    } else if (key === 'z' || key === 'enter') {
      userThrow();
      return;
    } else return;
    render();
  }

  /** キーを離した（守備ビューの移動キー用） */
  function handleKeyUp(key) {
    if (destroyed) return;
    if (fieldView && !subsMenu) fieldView.handleKey(key, false);
  }

  /** Esc を試合画面で使うか（采配メニュー表示中・開ける状態・守備中） */
  function isCapturingEsc() {
    if (destroyed || !state) return false;
    return !!subsMenu || !!fieldView || canOpenSubs();
  }

  // ---------- lifecycle ----------
  function start() {
    const teams = ctx.teams || [];
    userTeam = teams.find((t) => t.id === ctx.userTeamId) || teams[0];
    cpuTeam = teams.find((t) => t !== userTeam);
    if (!userTeam || !cpuTeam) throw new Error('game.js: チームデータが2チーム分ありません');
    const st = ctx.settings || {};
    const innings = [3, 6, 9].includes(Number(st.innings)) ? Number(st.innings) : 9;
    diff = DIFFICULTY[st.difficulty] || DIFFICULTY.normal;
    state = engine.createGame(cpuTeam, userTeam, { innings, userSide: 'away' });
    if (!state) throw new Error('game.js: engine.createGame が GameState を返しませんでした');
    if (!state.userSide) state = { ...state, userSide: 'away' };
    logSeen = (state.log || []).length;
    phase = 'idle';
    cursor = { x: 1, y: 1 };
    aim = { x: 1, y: 1 };
    pitchIdx = 0;
    el.innerHTML = template();
    cacheDom();
    bindInputs();
    lastBatting = battingSide();
    tickerText = 'プレイボール！';
    render();
    phase = 'change';
    showOverlay(`${inningLabel()} ${state.teams[lastBatting]?.name ?? ''}の攻撃`, 'プレイボール！', CHANGE_MS, () => {
      tickerText = readyHint();
      enterReady();
    });
  }

  function destroy() {
    destroyed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (hitRaf) cancelAnimationFrame(hitRaf);
    hitRaf = 0;
    clearTimers();
    clearTimeout(swingTimer);
    swingAnims.forEach((a) => { try { a.cancel(); } catch (e) { /* ignore */ } });
    swingAnims = [];
    if (duckTimer) { clearTimeout(duckTimer); duckTimer = 0; try { ctx.music?.duck?.(false); } catch (e) { /* ignore */ } }
    if (fieldView) { try { fieldView.destroy(); } catch (e) { /* ignore */ } fieldView = null; }
    if (subsMenu) { const m = subsMenu; subsMenu = null; try { m.close(); } catch (e) { /* ignore */ } }
    listeners.forEach(([n, t, f, o]) => n.removeEventListener(t, f, o));
    listeners.length = 0;
    flight = null;
  }

  return { start, handleKey, handleKeyUp, isCapturingEsc, destroy };
}
