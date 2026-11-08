/*
 * スタジアム背景（バックネット裏＝テレビ中継カメラ視点）を 1 枚のインライン SVG で描く。
 *
 * - 1280×720 のステージ座標。ホームベース中心 = (640, 600)、プレート板 ≈ (640, 325)、
 *   二塁 ≈ (640, 259)、外野フェンス（中堅）≈ y 200。ゲーム側の .zone / 投手 / 打者の位置に合わせてある。
 * - フィールド座標（フィート）: X = 一塁側が正、Y = ホームから中堅方向の奥行き、h = 高さ。
 *   ピンホール投影 x = 640 + F·X/Z, y = HZ + F·(CAM_H − h)/Z（Z = Y + CAM_D）。
 *   打席まわり（バッターボックス・ホーム周り）はキャラに合わせて横に誇張している。
 * - 色はすべて class 経由で css/background.css が決める（昼 / .is-night で夜）。
 * - 生成は 1 回だけ（文字列をキャッシュ）。毎フレームの再描画なし・filter なし。
 */

const CAM_D = 35.3;    // カメラ〜ホームベースの距離（ft）
const K = 15372;       // F × CAM_H
const HZ = 164.5;      // 地平線の画面 y
const F = 470;         // 焦点距離（px）
const CAM_H = K / F;   // カメラの高さ（ft）
const CX = 640;

const r1 = (n) => Math.round(n * 10) / 10;

/** フィールド座標 → 画面座標 */
function P(X, Y, h = 0) {
  const Z = Math.max(Y + CAM_D, 4);
  return [CX + (F * X) / Z, HZ + (F * (CAM_H - h)) / Z];
}
const pt = ([x, y]) => `${r1(x)},${r1(y)}`;
const poly = (pts) => pts.map(pt).join(' ');
const pathOf = (pts) => `M${pts.map(pt).join('L')}Z`;

/** 中心 (cx, cy)・半径 (rx, ry) の地面の楕円（フィールド座標）を n 点で */
function groundEllipse(cx, cy, rx, ry, n = 36, h = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(P(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, h));
  }
  return out;
}

/* ---------- 外野フェンスと側壁 ---------- */
const DEG = Math.PI / 180;
const fenceDist = (th) => 328 + 72 * Math.cos(2 * th); // 両翼 100m(328ft) / 中堅 122m(400ft)
const fencePt = (th, inset = 0) => {
  const d = fenceDist(th) - inset;
  return [Math.sin(th) * d, Math.cos(th) * d];
};
const ARC_N = 30;
const arc = (inset = 0) => Array.from({ length: ARC_N + 1 }, (_, i) => fencePt((-45 + (90 * i) / ARC_N) * DEG, inset));
// 一塁側の側壁（ポール → ホーム寄り）。三塁側は X を反転
const SIDE_R = [[200, 180], [160, 112], [128, 52], [114, 8], [108, -18]];
const SIDE_L = SIDE_R.map(([x, y]) => [-x, y]).reverse();
/** 外周の壁（三塁側ホーム寄り → 左翼ポール → 中堅 → 右翼ポール → 一塁側ホーム寄り） */
const WALL = [...SIDE_L, ...arc(), ...SIDE_R];
const WALL_H = 15;   // 外野フェンスの高さ（ft）
const SIDE_H = 7;    // 内野側フェンス

/** 壁の点列 pts を home から scale 倍に押し広げた高さ h の点列 */
const ring = (pts, scale, h) => pts.map(([x, y]) => P(x * scale, y * scale, h));
/** 2 本の点列の間を四角形で埋めた 1 本の path（同色なので重なっても問題なし） */
function band(a, b) {
  let d = '';
  for (let i = 0; i < a.length - 1; i++) d += pathOf([a[i], a[i + 1], b[i + 1], b[i]]);
  return d;
}
/** 壁の高さ: 外野は WALL_H、側壁は SIDE_H */
const wallH = (i) => (i < SIDE_L.length || i > SIDE_L.length + ARC_N ? SIDE_H : WALL_H);

/* ---------- 画面上の補助 ---------- */
function rect(x, y, w, h, cls, extra = '') { return `<rect class="${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}"${extra}/>`; }

function build() {
  const o = [];
  const defs = [];

  /* ===== defs ===== */
  defs.push(`<linearGradient id="@@st-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sk1"/><stop offset=".62" class="sk2"/><stop offset="1" class="sk3"/></linearGradient>`);
  defs.push(`<linearGradient id="@@st-grass" gradientUnits="userSpaceOnUse" x1="0" y1="190" x2="0" y2="720"><stop offset="0" class="gr1"/><stop offset=".35" class="gr2"/><stop offset="1" class="gr3"/></linearGradient>`);
  defs.push(`<linearGradient id="@@st-dirt" gradientUnits="userSpaceOnUse" x1="0" y1="240" x2="0" y2="720"><stop offset="0" class="dt1"/><stop offset="1" class="dt2"/></linearGradient>`);
  defs.push(`<radialGradient id="@@st-mound" cx=".5" cy=".42" r=".6"><stop offset="0" class="mo1"/><stop offset=".7" class="mo2"/><stop offset="1" class="mo3"/></radialGradient>`);
  defs.push(`<linearGradient id="@@st-fog" gradientUnits="userSpaceOnUse" x1="0" y1="80" x2="0" y2="360"><stop offset="0" class="fg1"/><stop offset=".45" class="fg2"/><stop offset="1" class="fg3"/></linearGradient>`);
  defs.push(`<linearGradient id="@@st-shade" gradientUnits="userSpaceOnUse" x1="0" y1="470" x2="0" y2="720"><stop offset="0" class="sh1"/><stop offset="1" class="sh2"/></linearGradient>`);
  defs.push(`<linearGradient id="@@st-tier" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ti1"/><stop offset="1" class="ti2"/></linearGradient>`);
  defs.push(`<radialGradient id="@@st-glow"><stop offset="0" class="gl1"/><stop offset=".35" class="gl2"/><stop offset="1" class="gl3"/></radialGradient>`);
  defs.push(`<linearGradient id="@@st-screen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc1"/><stop offset="1" class="sc2"/></linearGradient>`);
  // 観客（遠い / 近い）: 色の点をずらして並べたタイル
  const crowd = (id, w, hgt, r, dots) => `<pattern id="@@${id}" patternUnits="userSpaceOnUse" width="${w}" height="${hgt}">${dots.map(([x, y, c], i) => `<circle class="cw${c}" cx="${x}" cy="${y}" r="${(r * (i % 3 === 0 ? 1.1 : 0.92)).toFixed(2)}"/>`).join('')}</pattern>`;
  const D = [[1.5, 1.6, 1], [4.6, 1.2, 2], [7.7, 1.8, 3], [10.8, 1.3, 1], [13.9, 1.7, 4], [3.1, 4.3, 5], [6.2, 4.0, 1], [9.3, 4.4, 6], [12.4, 4.1, 2], [15.3, 4.5, 1]];
  defs.push(crowd('st-crowd-far', 16.5, 5.6, 1.15, D));
  defs.push(crowd('st-crowd-near', 24.8, 8.4, 1.75, D.map(([x, y, c]) => [x * 1.5, y * 1.5, c])));
  defs.push(`<pattern id="@@st-bank" patternUnits="userSpaceOnUse" width="7" height="6"><circle class="bulb" cx="3.5" cy="3" r="2.1"/></pattern>`);

  /* ===== 空 ===== */
  o.push(rect(0, 0, 1280, 260, 'st-skyrect', ' fill="url(#@@st-sky)"'));
  o.push(`<g class="st-clouds"><ellipse cx="236" cy="96" rx="70" ry="12"/><ellipse cx="262" cy="88" rx="34" ry="12"/><ellipse cx="1012" cy="92" rx="78" ry="13"/><ellipse cx="988" cy="84" rx="36" ry="12"/></g>`);

  /* ===== スタンド（奥 → 手前） ===== */
  const wallTop = WALL.map(([x, y], i) => P(x, y, wallH(i)));
  const lowTop = ring(WALL, 1.2, 40);
  const concTop = ring(WALL, 1.22, 47);
  const upBot = ring(WALL, 1.22, 52);
  const upTop = ring(WALL, 1.46, 112);
  const roofTop = ring(WALL, 1.47, 121);
  o.push(`<path class="st-roof" d="${band(upTop, roofTop)}"/>`);
  o.push(`<path class="st-seat" d="${band(upBot, upTop)}"/>`);
  o.push(`<path class="st-crowd" fill="url(#@@st-crowd-far)" d="${band(upBot, upTop)}"/>`);
  o.push(`<path class="st-tiershade" fill="url(#@@st-tier)" d="${band(upBot, upTop)}"/>`);
  o.push(`<path class="st-conc" d="${band(lowTop, upBot)}"/>`);
  o.push(`<path class="st-seat" d="${band(wallTop, lowTop)}"/>`);
  o.push(`<path class="st-crowd" fill="url(#@@st-crowd-near)" d="${band(wallTop, lowTop)}"/>`);
  o.push(`<path class="st-tiershade" fill="url(#@@st-tier)" d="${band(wallTop, lowTop)}"/>`);
  // 通路（各層の中ほど）
  o.push(`<polyline class="st-aisle" points="${poly(ring(WALL, 1.1, 27))}"/>`);
  o.push(`<polyline class="st-aisle" points="${poly(ring(WALL, 1.33, 80))}"/>`);
  o.push(`<polyline class="st-rail" points="${poly(lowTop)}"/>`);

  /* ===== バックスクリーン + 大型ビジョン ===== */
  const bsA = arc().filter((_, i) => i >= 11 && i <= 19);
  const bsBase = bsA.map(([x, y]) => P(x, y, WALL_H));
  const bsTop = bsA.map(([x, y]) => P(x * 1.03, y * 1.03, 58));
  o.push(`<polygon class="st-backscreen" points="${poly([...bsBase, ...bsTop.reverse()])}"/>`);
  // ビジョン（画面座標で直接）
  const VB = { x: 532, y: 84, w: 216, h: 58 };
  o.push(`<g class="st-board">`
    + `<rect class="st-pillar" x="566" y="${VB.y + VB.h}" width="10" height="20"/><rect class="st-pillar" x="704" y="${VB.y + VB.h}" width="10" height="20"/>`
    + rect(VB.x, VB.y, VB.w, VB.h, 'st-frame', ' rx="3"')
    + rect(VB.x + 5, VB.y + 5, 128, VB.h - 10, 'st-screen', ' fill="url(#@@st-screen)"')
    + `<text class="st-scr-t" x="${VB.x + 69}" y="${VB.y + 29}" text-anchor="middle">DOKIDOKI</text>`
    + `<text class="st-scr-s" x="${VB.x + 69}" y="${VB.y + 43}" text-anchor="middle">BALLPARK</text>`
    + rect(VB.x + 138, VB.y + 5, 73, VB.h - 10, 'st-lscore')
    + `<text class="st-ls" x="${VB.x + 142}" y="${VB.y + 18}">123456789</text>`
    + `<text class="st-ls dim" x="${VB.x + 142}" y="${VB.y + 31}">000000000</text>`
    + `<text class="st-ls dim" x="${VB.x + 142}" y="${VB.y + 44}">00000000-</text>`
    + `</g>`);
  // ビジョン脇のスポンサー板
  o.push(`<g class="st-ads">${rect(452, 124, 74, 14, 'st-ad a1', ' rx="2"')}<text x="489" y="134.5" text-anchor="middle" class="st-adt">ドキドキ食堂</text>`
    + `${rect(754, 124, 74, 14, 'st-ad a2', ' rx="2"')}<text x="791" y="134.5" text-anchor="middle" class="st-adt dark">ベースボールソーダ</text></g>`);

  /* ===== 照明塔（画面座標） ===== */
  const towers = [[352, 88, 0.86], [470, 82, 0.8], [810, 82, 0.8], [928, 88, 0.86]];
  o.push(`<g class="st-night-only st-glows">${towers.map(([x, y, s]) => `<circle cx="${x}" cy="${y + 10 * s}" r="${110 * s}" fill="url(#@@st-glow)"/>`).join('')}</g>`);
  o.push(`<g class="st-towers">${towers.map(([x, y, s]) => {
    const w = 54 * s, h = 22 * s;
    return `<rect class="st-pole" x="${r1(x - 2)}" y="${r1(y + h)}" width="4" height="${r1(30 * s)}"/>`
      + rect(x - w / 2, y, w, h, 'st-bankbg', ' rx="2"')
      + rect(x - w / 2 + 2, y + 2, w - 4, h - 4, 'st-bank', ' fill="url(#@@st-bank)"');
  }).join('')}</g>`);

  /* ===== 外野フェンス・ポール ===== */
  const wallBase = WALL.map(([x, y]) => P(x, y, 0));
  // 芝（壁の根元から下すべて）
  const grassRegion = [...wallBase, [1500, 900], [-220, 900]];
  o.push(`<polygon class="st-grass" fill="url(#@@st-grass)" points="${poly(grassRegion)}"/>`);
  o.push(`<path class="st-wall" d="${band(wallBase, wallTop)}"/>`);
  o.push(`<polyline class="st-wtop" points="${poly(wallTop)}"/>`);
  // 距離表示
  const marks = [[-40, '100'], [-22.5, '116'], [0, '122'], [22.5, '116'], [40, '100']];
  o.push(`<g class="st-dist">${marks.map(([deg, t]) => {
    const [x, y] = fencePt(deg * DEG);
    const [sx, sy] = P(x, y, WALL_H * 0.42);
    const fs = Math.max(7, (F * 7.5) / (y + CAM_D));
    return `<text x="${r1(sx)}" y="${r1(sy + fs * 0.35)}" font-size="${r1(fs)}" text-anchor="middle">${t}</text>`;
  }).join('')}</g>`);
  // ファウルポール（両翼）
  o.push(`<g class="st-poles">${[-1, 1].map((sg) => {
    const [x, y] = fencePt(sg * 45 * DEG);
    const [bx, by] = P(x, y, 0), [tx, ty] = P(x, y, 95);
    const [nx] = P(x + sg * 4, y, 95);
    return `<line class="st-fpole" x1="${r1(bx)}" y1="${r1(by)}" x2="${r1(tx)}" y2="${r1(ty)}"/><polygon class="st-fnet" points="${poly([[tx, ty], [nx, ty], [nx, ty + (by - ty) * 0.45], [tx, ty + (by - ty) * 0.45]])}"/>`;
  }).join('')}</g>`);
  // 警告帯（ウォーニングトラック）
  const tOut = arc().map(([x, y]) => P(x, y));
  const tIn = arc(15).map(([x, y]) => P(x, y));
  o.push(`<polygon class="st-track" points="${poly([...tOut, ...tIn.reverse()])}"/>`);

  /* ===== 芝の刈り込み（チェック）: 外野＋内野の芝だけにクリップ ===== */
  // 内野の土（半径 95ft の円弧 + ファウルライン沿い）
  const skin = [];
  const c0 = 60.5, R = 95;
  const aEnd = Math.atan2(84 - c0, 92); // (92, 84)
  for (let i = 0; i <= 28; i++) {
    const a = aEnd + ((Math.PI - 2 * aEnd) * i) / 28;
    skin.push([Math.cos(a) * R, c0 + Math.sin(a) * R]);
  }
  skin.push([0, -8]); // 順序: (92,84) → 中堅側の円弧 → (-92,84) → ホーム後方
  const skinPts = skin.map(([x, y]) => P(x, y));
  // 内野の芝（ダイヤモンドを内側に寄せた正方形）
  const b = 63.64, ins = 5.66;
  const sq = [[0, ins], [b - ins, b], [0, 2 * b - ins], [-(b - ins), b]];
  const sqPts = sq.map(([x, y]) => P(x, y));
  o.push(`<polygon class="st-dirt" fill="url(#@@st-dirt)" points="${poly(skinPts)}"/>`);
  o.push(`<polygon class="st-grass" fill="url(#@@st-grass)" points="${poly(sqPts)}"/>`);
  defs.push(`<clipPath id="@@st-mowclip"><path clip-rule="evenodd" d="${pathOf(grassRegion)}${pathOf(skinPts)}${pathOf(sqPts)}"/></clipPath>`);
  let stripes = '';
  for (let X = -330; X < 330; X += 26) stripes += pathOf([P(X, -10), P(X + 13, -10), P(X + 13, 430), P(X, 430)]);
  let bands = '';
  for (let Y = -10; Y < 420; Y += 30) bands += pathOf([P(-500, Y), P(500, Y), P(500, Y + 15), P(-500, Y + 15)]);
  o.push(`<g clip-path="url(#@@st-mowclip)"><path class="st-mow" d="${stripes}"/><path class="st-band" d="${bands}"/></g>`);
  // 内野芝のふち（刈り込みの段差）
  o.push(`<polygon class="st-edge" points="${poly(sqPts)}"/>`);

  /* ===== 塁・マウンド ===== */
  const cut = (x, y, r) => `<polygon class="st-dirt" fill="url(#@@st-dirt)" points="${poly(groundEllipse(x, y, r, r, 24))}"/>`;
  o.push(cut(b, b, 11) + cut(-b, b, 11) + cut(0, 2 * b, 10));
  // ファウルライン（ボックスの先から両翼ポールまで）
  const pole = fencePt(45 * DEG);
  o.push(`<g class="st-chalk">`
    + `<line x1="${r1(P(4.4, 4.4)[0])}" y1="${r1(P(4.4, 4.4)[1])}" x2="${r1(P(pole[0], pole[1])[0])}" y2="${r1(P(pole[0], pole[1])[1])}"/>`
    + `<line x1="${r1(P(-4.4, 4.4)[0])}" y1="${r1(P(-4.4, 4.4)[1])}" x2="${r1(P(-pole[0], pole[1])[0])}" y2="${r1(P(-pole[0], pole[1])[1])}"/>`
    + `</g>`);
  // 一塁・二塁・三塁ベース（少し大きめ）
  const base = (x, y, s = 1.6) => `<polygon class="st-base" points="${poly([P(x, y - s), P(x + s, y), P(x, y + s), P(x - s, y)])}"/>`;
  o.push(base(b, b) + base(-b, b) + base(0, 2 * b));
  // マウンド（キャラに合わせて大きめ）
  const MC = 59;
  o.push(`<polygon class="st-moundshadow" points="${poly(groundEllipse(0, MC - 1.5, 21, 14, 32))}"/>`);
  o.push(`<polygon class="st-mound" fill="url(#@@st-mound)" points="${poly(groundEllipse(0, MC, 19, 12.5, 32, 0.6))}"/>`);
  o.push(`<polygon class="st-rubber" points="${poly([P(-2.6, 60.5, 0.9), P(2.6, 60.5, 0.9), P(2.6, 61.3, 0.9), P(-2.6, 61.3, 0.9)])}"/>`);

  /* ===== ホームまわり（打者に合わせて横に誇張） ===== */
  const EX = 3.5;
  const N = (X, Y) => P(X * EX, Y);
  o.push(`<polygon class="st-dirt" fill="url(#@@st-dirt)" points="${poly(groundEllipse(0, 0.5, 6.4 * EX, 13.5, 40))}"/>`);
  // バッターボックス（左右）とキャッチャーボックス
  const box = (s) => {
    const xi = 1.25 * s, xo = 5.25 * s;
    return `<polygon class="st-box" points="${poly([N(xi, 4.4), N(xo, 4.4), N(xo, -3.2), N(xi, -3.2)])}"/>`;
  };
  o.push(`<g class="st-chalk">${box(1)}${box(-1)}`
    + `<polyline class="st-box" points="${poly([N(-1.25, -3.2), N(-1.6, -3.2), N(-1.6, -12), N(1.6, -12), N(1.6, -3.2), N(1.25, -3.2)])}"/></g>`);
  // ホームベース（五角形・先端が捕手側）
  const pw = 0.708;
  o.push(`<polygon class="st-plate" points="${poly([N(-pw, 1.2), N(pw, 1.2), N(pw, 0), N(0, -1.2), N(-pw, 0)])}"/>`);

  /* ===== 空気遠近・影 ===== */
  o.push(rect(0, 76, 1280, 300, 'st-fog', ' fill="url(#@@st-fog)"'));
  o.push(rect(0, 470, 1280, 250, 'st-shade', ' fill="url(#@@st-shade)"'));

  return `<svg class="stadium" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true" focusable="false"><defs>${defs.join('')}</defs>${o.join('')}</svg>`;
}

let cached = null;
let seq = 0;
/**
 * スタジアム背景の SVG 文字列。
 * @param {{ night?: boolean }} [opt] night: true で夜の配色（.is-night を付ける。親の .game.is-night でも切り替わる）
 */
export function stadiumSVG({ night = false } = {}) {
  if (!cached) cached = build();
  // id は画面ごとに一意にする（非表示のタイトル画面側の gradient を参照すると描画されないため）
  const svg = cached.replaceAll('@@', `s${++seq}-`);
  return night ? svg.replace('<svg class="stadium"', '<svg class="stadium is-night"') : svg;
}

/** テスト・調整用: 投影関数 */
export const stadiumProject = P;
