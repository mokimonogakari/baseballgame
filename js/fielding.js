/**
 * 守備ビュー（ドキドキベースボール）
 * 打球を 2.5D の全景フィールドでリアルタイム再生し、ユーザーが野手を操作して打球を追う。
 * DOM 描画（絶対配置 + インライン SVG の背景）。engine.js には依存しない（opts で受け取る）。
 *
 * export function createFieldingView(container, opts) → { start(), handleKey(key, isDown), destroy() }
 *   opts = {
 *     state, ball, side, userControlled, fielders:[{id,name,pos,speed,fielding,arm,catching,color}],
 *     runners:[{id,name,speed}|null ×3], batterSpeed, sound?:{play(name)}, onDone(result|null),
 *     // 任意:
 *     positions?: {投:{x,y},...}   (engine.DEFAULT_POSITIONS を渡すと初期守備位置がエンジンと一致)
 *     field?: engine.FIELD          (塁・フェンス座標の上書き。形は柔軟に解釈)
 *     runnerColor?: '#E5484D'       (走者のヘルメット色)
 *     batterId?, batterName?
 *   }
 *   key: 'up'|'down'|'left'|'right'|'z'|'x'|'enter'
 *   result = { caughtInAir, fielderId, fieldedAt:{x,y}, fieldTime, throwTo:1|2|3|4|null, throwTime, error,
 *              diving, throwStartAt, throwArriveAt }
 *   ホームランの場合は飛球を再生して onDone(null)。
 *
 * 座標: メートル。本塁(0,0)、+y=センター方向、+x=一塁/ライト側、z=高さ。
 */

const DT = 1 / 120;            // シミュレーション刻み (s)
const REACH_Z = 2.4;           // 捕球できる高さ
const DIVE_RANGE = 2.5;        // ダイビング可能距離
const BASE_LEN = 27.43;        // 塁間（走者の走行距離計算用）
const AUTO_THROW_S = 1.2;      // 送球入力待ち
const CPU_HOLD_S = 0.35;       // CPU の送球までの間
const MAX_SIM_S = 25;

const DEFAULT_FIELD = {
  home: { x: 0, y: 0 },
  first: { x: 19.4, y: 19.4 },
  second: { x: 0, y: 27.4 },
  third: { x: -19.4, y: 19.4 },
  mound: { x: 0, y: 18.4 },
  fenceLine: 98,
  fenceCenter: 122,
};

const FALLBACK_POSITIONS = {
  投: { x: 0, y: 18.4 }, 捕: { x: 0, y: -1.2 }, 一: { x: 16.5, y: 24 }, 二: { x: 8.5, y: 33 },
  三: { x: -16.5, y: 23 }, 遊: { x: -8.5, y: 33 }, 左: { x: -30, y: 78 }, 中: { x: 0, y: 92 }, 右: { x: 30, y: 78 },
};

const TYPE_LABEL = { grounder: 'ゴロ', liner: 'ライナー', fly: 'フライ', popup: 'ポップフライ', hr: 'ホームラン' };
const INFIELD = ['投', '捕', '一', '二', '三', '遊'];
const OUTFIELD = ['左', '中', '右'];
const BASE_NAME = { 1: '1塁', 2: '2塁', 3: '3塁', 4: '本塁' };
const KEY_BASE = { right: 1, up: 2, left: 3, down: 4 };

// ---- 投影（2.5D、本塁は画面下中央） ----
const CX = 640;
const HOME_SY = 640;     // 本塁のスクリーン y
const HORIZON = -131;    // 消失点 y（画面外）
const PERSP = 70;        // 奥行き定数 (m)
const KX = 11.5;           // 本塁付近の横 px/m
const KZ = 8;            // 本塁付近の高さ px/m

function scaleAt(y) { return PERSP / (PERSP + Math.max(-60, y)); }
/** フィールド座標 → ステージ座標 */
export function project(x, y, z = 0) {
  const s = scaleAt(y);
  return { X: CX + x * KX * s, Y: HORIZON + (HOME_SY - HORIZON) * s - z * KZ * s, s };
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pt = (p, d) => (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) ? { x: Number(p.x), y: Number(p.y) } : d);

/** engine.FIELD の形を柔軟に解釈 */
function normalizeField(f) {
  const F = { ...DEFAULT_FIELD };
  if (!f || typeof f !== 'object') return F;
  const b = f.bases;
  if (Array.isArray(b)) {
    const arr = b.length >= 4 ? b.slice(1, 4) : b.slice(0, 3);
    F.first = pt(arr[0], F.first); F.second = pt(arr[1], F.second); F.third = pt(arr[2], F.third);
  } else if (b && typeof b === 'object') {
    F.first = pt(b[1] ?? b.first, F.first); F.second = pt(b[2] ?? b.second, F.second); F.third = pt(b[3] ?? b.third, F.third);
  }
  F.first = pt(f.first ?? f.b1 ?? f.firstBase, F.first);
  F.second = pt(f.second ?? f.b2 ?? f.secondBase, F.second);
  F.third = pt(f.third ?? f.b3 ?? f.thirdBase, F.third);
  F.mound = pt(f.mound, F.mound);
  F.fenceLine = num(f.fenceLine ?? f.fence?.line ?? f.fenceLines, F.fenceLine);
  F.fenceCenter = num(f.fenceCenter ?? f.fence?.center, F.fenceCenter);
  return F;
}

export function createFieldingView(container, opts = {}) {
  if (!container) throw new Error('fielding.js: container がありません');
  const ball = opts.ball || {};
  const F = normalizeField(opts.field);
  const BASES = [F.home, F.first, F.second, F.third, F.home]; // index 4 = 本塁
  const fenceR = (x, y) => {
    const th = Math.atan2(x, Math.max(0.01, y));
    const c = Math.cos(2 * clamp(th, -Math.PI / 4, Math.PI / 4));
    return F.fenceLine + (F.fenceCenter - F.fenceLine) * c;
  };
  const userControlled = !!opts.userControlled;
  const touchAssist = userControlled && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const isHR = !!ball.isHomeRun || ball.type === 'hr';
  const type = isHR ? 'hr' : (ball.type || 'grounder');
  const outs = num(opts.state?.outs, 0);
  const play = (n) => { try { opts.sound?.play?.(n); } catch (e) { /* ignore */ } };
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 打球軌道（転がりを延長） ----------
  const path = buildPath();
  const P0 = path[0].t;
  const PDT = path.length > 1 ? (path[path.length - 1].t - P0) / (path.length - 1) || 0.05 : 0.05;
  const PEND = path[path.length - 1].t;
  const tdIndex = (() => {
    if (type === 'grounder') return 0;
    for (let i = 1; i < path.length; i++) if (path[i].z <= 0.05) return i;
    return path.length - 1;
  })();
  const tdTime = path[tdIndex].t;

  function buildPath() {
    let src = Array.isArray(ball.path) ? ball.path.filter((p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.y))
      .map((p) => ({ t: num(p.t, 0), x: +p.x, y: +p.y, z: Math.max(0, num(p.z, 0)) })) : [];
    if (src.length < 2) {
      // 軌道が無い場合は landing と hangTime から放物線を合成
      const L = pt(ball.landing, { x: 0, y: 40 });
      const T = Math.max(0.4, num(ball.hangTime, type === 'grounder' ? 1.5 : 3));
      const apex = type === 'grounder' ? 0 : (9.8 * T * T) / 8;
      src = [];
      for (let t = 0; t <= T + 1e-6; t += 0.05) {
        const k = t / T;
        src.push({ t, x: L.x * k, y: L.y * k, z: type === 'grounder' ? 0 : Math.max(0, 1 + apex * 4 * k * (1 - k) - k) });
      }
    }
    src.sort((a, b) => a.t - b.t);
    if (isHR) return src;
    const out = src.slice();
    const last = out[out.length - 1];
    const prev = out[out.length - 2] || last;
    const dtp = Math.max(0.01, last.t - prev.t);
    let vx = (last.x - prev.x) / dtp, vy = (last.y - prev.y) / dtp;
    let v = Math.hypot(vx, vy);
    if (last.z > 0.4 || v < 0.3) return out;
    const landedFly = type !== 'grounder';
    if (landedFly) v *= 0.5; // バウンドで減速
    const ux = vx / (Math.hypot(vx, vy) || 1), uy = vy / (Math.hypot(vx, vy) || 1);
    let x = last.x, y = last.y, t = last.t;
    let hop = landedFly ? Math.min(2.5, v * 0.12) : 0;
    let hopT = 0;
    const decel = 5.5;
    while (v > 0.25 && out.length < 2000) {
      t += 0.05;
      v = Math.max(0, v - decel * 0.05);
      x += ux * v * 0.05; y += uy * v * 0.05;
      let z = 0;
      if (hop > 0.05) {
        hopT += 0.05;
        const dur = Math.sqrt((8 * hop) / 9.8);
        if (hopT >= dur) { hopT = 0; hop *= 0.35; } else z = hop * 4 * (hopT / dur) * (1 - hopT / dur);
      }
      const R = fenceR(x, y) - 0.6;
      if (Math.hypot(x, y) > R) { const k = R / Math.hypot(x, y); x *= k; y *= k; v = 0; }
      out.push({ t, x, y, z });
    }
    return out;
  }

  function ballAt(t) {
    if (t <= P0) return { ...path[0] };
    if (t >= PEND) return { ...path[path.length - 1] };
    const f = (t - P0) / PDT;
    const i = Math.min(path.length - 2, Math.floor(f));
    const a = path[i], b = path[i + 1];
    const k = clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
  }
  const inAirAt = (t) => type !== 'grounder' && t < tdTime;
  const landing = isHR ? pt(ball.landing, path[path.length - 1]) : { x: path[tdIndex].x, y: path[tdIndex].y };

  // ---------- 野手 ----------
  const positions = opts.positions || FALLBACK_POSITIONS;
  const fielders = (opts.fielders || []).slice(0, 9).map((p, i) => {
    const pos = p.pos || INFIELD.concat(OUTFIELD)[i];
    const home = pt(positions[pos], FALLBACK_POSITIONS[pos] || { x: 0, y: 30 });
    const fieldingV = clamp(num(p.fielding, 50), 1, 99);
    const catchingV = clamp(num(p.catching, 50), 1, 99);
    return {
      id: p.id, name: p.name || '', pos, color: p.color || '#1E88E5',
      speed: 6 + (clamp(num(p.speed, 50), 1, 99) / 99) * 1.5,
      fielding: fieldingV, catching: catchingV, arm: clamp(num(p.arm, 50), 1, 99),
      R: 0.95 + (((fieldingV + catchingV) / 2) / 99) * 0.55,
      react: 0.26 - (fieldingV / 99) * 0.1,
      x: home.x, y: home.y, home, target: null, speedMul: 1,
      role: 'stay', downUntil: 0, dive: null, moving: false, el: null,
    };
  });
  const byPos = (pos) => fielders.find((f) => f.pos === pos);
  /** 捕球半径（飛球は落下点に入りやすいよう広め） */
  const catchR = (f, tt) => f.R + (inAirAt(tt) ? 0.6 : 0);

  // ---------- 走者 ----------
  const runnerSpeed = (s) => 6.0 + (clamp(num(s, 50), 1, 99) / 99) * 2.2;
  const occ = [0, 1, 2].map((i) => !!(opts.runners && opts.runners[i]));
  const runners = [];
  runners.push({ id: opts.batterId ?? ball.batterId ?? 'batter', name: opts.batterName || '', isBatter: true, origin: 0,
    p: 0, goal: 1, speed: runnerSpeed(opts.batterSpeed), startAt: 0.3, gone: false, scored: false, el: null });
  (opts.runners || []).slice(0, 3).forEach((r, i) => {
    if (!r) return;
    const forced = occ.slice(0, i).every(Boolean);
    runners.push({ id: r.id, name: r.name || '', isBatter: false, origin: i + 1, forced, p: i + 1, goal: i + 1,
      speed: runnerSpeed(r.speed), startAt: 0.05, gone: false, scored: false, el: null });
  });
  // 初期目標
  for (const r of runners) {
    if (isHR) { r.goal = 4; r.speed *= 0.62; continue; }
    if (r.isBatter) continue;
    if (type === 'grounder') r.goal = r.forced ? r.origin + 1 : r.origin;
    else r.goal = r.origin + (type === 'popup' ? 0.15 : 0.35);
  }

  // ---------- 状態 ----------
  let t = 0;
  let phase = isHR ? 'hr' : 'live'; // live | bobble | secured | throw | after | done | hr
  let holder = null;
  let user = null;           // 操作中の野手
  let switchOrder = [];
  let result = null;
  let selBase = null;        // 選択中の送球先
  let securedAt = 0;
  let throwInfo = null;      // { from, to, base, start, dur }
  let bobbleUntil = 0;
  let doneAt = 0;
  let touchedDown = false;
  let retrieveAssigned = false;
  let primaryEta = Infinity;
  let calledDone = false;
  let hrCalled = false;
  let destroyed = false;
  let started = false;
  let rafId = 0;
  let lastNow = 0;
  const held = { up: false, down: false, left: false, right: false };
  const listeners = [];
  let calloutTimer = 0;

  // ---------- 迎撃計算 ----------
  /** 野手 f が今から打球に追いつける最も早い地点 */
  function intercept(f, tNow, reactLeft = 0) {
    const sp = f.speed;
    const start = Math.max(0, Math.floor((tNow - P0) / PDT));
    for (let i = start; i < path.length; i++) {
      const q = path[i];
      if (q.t < tNow) continue;
      if (q.z >= REACH_Z) continue;
      const need = Math.max(0, Math.hypot(q.x - f.x, q.y - f.y) - f.R * 0.8) / sp + reactLeft;
      if (need <= q.t - tNow + 0.02) return { t: q.t, x: q.x, y: q.y };
    }
    const q = path[path.length - 1];
    return { t: Math.max(q.t, tNow + Math.hypot(q.x - f.x, q.y - f.y) / sp + reactLeft), x: q.x, y: q.y };
  }

  function rankByIntercept(list = fielders) {
    return list.map((f) => ({ f, ic: intercept(f, t, Math.max(0, f.react - t)) }))
      .sort((a, b) => a.ic.t - b.ic.t);
  }

  // ---------- 役割（AI） ----------
  function assignRoles() {
    const ranked = rankByIntercept();
    switchOrder = ranked.map((r) => r.f);
    const primary = ranked[0]?.f;
    primaryEta = ranked[0]?.ic.t ?? Infinity;
    const endD = Math.hypot(path[path.length - 1].x, path[path.length - 1].y);
    let backup = null;
    if (primary && INFIELD.includes(primary.pos) && endD > 38) backup = ranked.find((r) => OUTFIELD.includes(r.f.pos))?.f;
    if (!backup) backup = ranked.find((r) => r.f !== primary && r.f.pos !== '捕' && r.f.pos !== '投')?.f;
    fielders.forEach((f) => { f.role = 'stay'; f.target = null; f.speedMul = 1; });
    if (primary) primary.role = 'chase';
    if (backup) backup.role = 'backup';
    const free = (pos) => { const f = byPos(pos); return f && f.role === 'stay' ? f : null; };
    const cover = (f, base) => { if (f) { f.role = 'cover'; f.coverBase = base; } };
    // 1塁: 一 → 投 → 二
    cover(free('一') || free('投') || free('二'), 1);
    // 2塁: 打球が右なら遊、左なら二
    const right = landing.x >= 0;
    cover(right ? (free('遊') || free('二')) : (free('二') || free('遊')), 2);
    cover(free('三') || free('遊') || free('投'), 3);
    cover(free('捕') || free('投'), 4);
    // 残りの外野は打球方向へ寄る
    fielders.forEach((f) => { if (f.role === 'stay' && OUTFIELD.includes(f.pos)) f.role = 'drift'; });
  }

  function aiTarget(f) {
    switch (f.role) {
      case 'chase': {
        const ic = intercept(f, t, Math.max(0, f.react - t));
        return { x: ic.x, y: ic.y };
      }
      case 'backup': {
        if (OUTFIELD.includes(f.pos)) { const own = intercept(f, t, Math.max(0, f.react - t)); return { x: own.x, y: own.y }; }
        const ic = primaryIntercept();
        const d = Math.hypot(ic.x, ic.y) || 1;
        const back = OUTFIELD.includes(f.pos) ? 7 : 4;
        return { x: ic.x + (ic.x / d) * back, y: ic.y + (ic.y / d) * back };
      }
      case 'cover': { const b = BASES[f.coverBase]; return { x: b.x + (f.coverBase === 4 ? 0 : 0.6) * Math.sign(-b.x || 0), y: b.y + (f.coverBase === 4 ? -0.4 : 0.4) }; }
      case 'drift': {
        const b = ballAt(t);
        return { x: f.home.x + (b.x - f.home.x) * 0.3, y: f.home.y + (b.y - f.home.y) * 0.3 };
      }
      case 'retrieve': { const b = ballAt(t); return { x: b.x, y: b.y }; }
      default: return null;
    }
  }
  function primaryIntercept() {
    const p = fielders.find((f) => f.role === 'chase') || user;
    return p ? intercept(p, t, 0) : landing;
  }

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.className = `fv${userControlled && !isHR ? ' fv-user' : ' fv-cpu'}${isHR ? ' fv-hr' : ''}${reduceMotion ? ' fv-rm' : ''}`;
  root.innerHTML = template();
  container.appendChild(root);
  const q = (s) => root.querySelector(s);
  const dom = {
    layer: q('.fv-layer'), ball: q('.fv-ball'), shadow: q('.fv-shadow'), mark: q('.fv-landmark'),
    prompt: q('.fv-prompt'), callout: q('.fv-callout'), who: q('[data-ref="who"]'), skip: q('.fv-skip'),
    bases: [...root.querySelectorAll('.fv-basemark')], zLabel: q('[data-ref="z-label"]'), xLabel: q('[data-ref="x-label"]'),
  };
  fielders.forEach((f) => { f.el = tokenEl(f.color, f.pos, false); dom.layer.appendChild(f.el); });
  runners.forEach((r) => { r.el = tokenEl(opts.runnerColor || '#E5484D', r.isBatter ? '打' : '走', true); dom.layer.appendChild(r.el); });

  function tokenEl(color, label, runner) {
    const el = document.createElement('div');
    el.className = `fv-tok${runner ? ' fv-runner' : ''}`;
    el.style.setProperty('--team', color);
    el.innerHTML = `<i class="fv-tok-ring"></i><div class="fv-tok-fig"><div class="fv-tok-head"><i class="fv-tok-cap"></i><i class="fv-tok-eye l"></i><i class="fv-tok-eye r"></i></div><div class="fv-tok-body"></div><div class="fv-tok-legs"><i></i><i></i></div></div><b class="fv-tok-label">${esc(label)}</b><i class="fv-tok-arrow"></i>`;
    return el;
  }

  function template() {
    const P = (x, y, z = 0) => { const p = project(x, y, z); return `${p.X.toFixed(1)},${p.Y.toFixed(1)}`; };
    const poly = (arr) => arr.map(([x, y, z]) => P(x, y, z)).join(' ');
    // フェンス弧
    const arc = [];
    for (let a = -45; a <= 45; a += 2.5) {
      const th = (a * Math.PI) / 180;
      const r = F.fenceLine + (F.fenceCenter - F.fenceLine) * Math.cos(2 * th);
      arc.push([r * Math.sin(th), r * Math.cos(th)]);
    }
    const pole = F.fenceLine / Math.SQRT2;
    const sideR = [[pole + 8, pole - 14], [pole + 20, pole - 40], [pole + 26, 0], [pole + 20, -30]];
    const sideL = sideR.map(([x, y]) => [-x, y]).reverse();
    const ground = [...sideL, ...arc, ...sideR];
    const wallLine = [...sideL.slice().reverse().slice(0, 0), ...sideL, ...arc, ...sideR];
    const wallTop = wallLine.map(([x, y]) => [x, y, 3.2]);
    const wallPoly = [...wallLine.map(([x, y]) => [x, y, 0]), ...wallTop.slice().reverse()];
    // 芝の縞（等 y の帯 = 画面の水平帯）
    let stripes = '';
    let k = 0;
    for (let y = -12; y < 140; y += 7, k++) {
      const a = project(0, y).Y, b = project(0, y + 7).Y;
      stripes += `<rect x="0" y="${b.toFixed(1)}" width="1280" height="${(a - b + 0.6).toFixed(1)}" fill="${k % 2 ? '#47A54D' : '#56B95B'}"/>`;
    }
    // 内野
    const M = F.mound;
    const rDirt = Math.max(dist(M, F.second), dist(M, F.first), dist(M, F.third)) + 5;
    const circ = [];
    for (let a = 0; a < 360; a += 5) {
      const th = (a * Math.PI) / 180;
      circ.push([M.x + rDirt * Math.sin(th), M.y + rDirt * Math.cos(th)]);
    }
    const wedge = [[0, -4], [pole + 2.5, pole], [pole + 2.5, pole + 30], [-pole - 2.5, pole + 30], [-pole - 2.5, pole]];
    const cen = { x: (F.first.x + F.third.x + F.second.x) / 3, y: (F.first.y + F.third.y + F.second.y + 0) / 4 };
    const shrink = (b, k2) => [cen.x + (b.x - cen.x) * k2, cen.y + (b.y - cen.y) * k2];
    const innerGrass = [shrink(F.home, 0.78), shrink(F.first, 0.78), shrink(F.second, 0.78), shrink(F.third, 0.78)];
    const circleAt = (c, r, z = 0) => { const a = []; for (let d = 0; d < 360; d += 10) { const th = (d * Math.PI) / 180; a.push([c.x + r * Math.sin(th), c.y + r * Math.cos(th), z]); } return poly(a); };
    const baseSq = (b, sz = 0.75) => poly([[b.x, b.y - sz], [b.x + sz, b.y], [b.x, b.y + sz], [b.x - sz, b.y]]);
    const ppole = (sx) => { const a = project(sx * pole, pole, 0), b = project(sx * pole, pole, 14); return `<line x1="${a.X.toFixed(1)}" y1="${a.Y.toFixed(1)}" x2="${b.X.toFixed(1)}" y2="${b.Y.toFixed(1)}" stroke="#FFD54A" stroke-width="4" stroke-linecap="round"/>`; };
    const hp = project(0, 0);
    const fl = (sx) => { const b = project(sx * pole, pole); return `<line x1="${hp.X.toFixed(1)}" y1="${hp.Y.toFixed(1)}" x2="${b.X.toFixed(1)}" y2="${b.Y.toFixed(1)}"/>`; };
    const baseMarks = [1, 2, 3, 4].map((n) => {
      const p = project(BASES[n].x, BASES[n].y);
      const key = { 1: '→', 2: '↑', 3: '←', 4: '↓' }[n];
      return `<div class="fv-basemark" data-base="${n}" style="left:${p.X.toFixed(1)}px;top:${p.Y.toFixed(1)}px"><span><b>${key}</b>${BASE_NAME[n]}</span></div>`;
    }).join('');
    const typeLabel = TYPE_LABEL[type] || '';
    return `
<div class="fv-crowd"></div>
<svg class="fv-field" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
  <defs><clipPath id="fv-clip-ground"><polygon points="${poly(ground)}"/></clipPath><clipPath id="fv-clip-wedge"><polygon points="${poly(wedge)}"/></clipPath></defs>
  <polygon points="${poly(wallPoly)}" fill="#2E9E58" stroke="#1C2B4B" stroke-width="2"/>
  <polyline points="${poly(wallTop)}" fill="none" stroke="#FFD54A" stroke-width="5" stroke-linejoin="round"/>
  <g clip-path="url(#fv-clip-ground)">${stripes}
    <polygon points="${poly(ground)}" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="8"/>
    <polygon points="${poly(arc.map(([x, y]) => [x * 0.955, y * 0.955]).concat(arc.slice().reverse()))}" fill="#C9955F" opacity=".85"/>
    <g clip-path="url(#fv-clip-wedge)"><polygon points="${poly(circ)}" fill="#C9955F"/></g>
    <polygon points="${poly(innerGrass)}" fill="#4CAF50"/>
    <polygon points="${circleAt(F.home, 4.2)}" fill="#C9955F"/>
    <polygon points="${circleAt(M, 2.8)}" fill="#D6A770" stroke="#B98450" stroke-width="2"/>
    <g stroke="#fff" stroke-width="3" opacity=".95" stroke-linecap="round">${fl(1)}${fl(-1)}</g>
    <polyline points="${poly([[F.home.x, F.home.y], [F.first.x, F.first.y], [F.second.x, F.second.y], [F.third.x, F.third.y], [F.home.x, F.home.y]])}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>
    <rect x="${(project(M.x, M.y).X - 9).toFixed(1)}" y="${(project(M.x, M.y).Y - 2).toFixed(1)}" width="18" height="4" rx="1" fill="#fff"/>
    <polygon points="${baseSq(F.first)}" fill="#fff" stroke="#1C2B4B" stroke-width="1.5"/>
    <polygon points="${baseSq(F.second)}" fill="#fff" stroke="#1C2B4B" stroke-width="1.5"/>
    <polygon points="${baseSq(F.third)}" fill="#fff" stroke="#1C2B4B" stroke-width="1.5"/>
    <polygon points="${poly([[-0.45, 0.3], [0.45, 0.3], [0.45, -0.1], [0, -0.45], [-0.45, -0.1]])}" fill="#fff" stroke="#1C2B4B" stroke-width="1.5"/>
  </g>
  ${ppole(1)}${ppole(-1)}
</svg>
${baseMarks}
<div class="fv-layer"><div class="fv-landmark"></div><div class="fv-shadow"></div><div class="fv-ball"></div></div>
<div class="fv-hud"><span class="fv-chip">${userControlled && !isHR ? '守備' : '打球'}</span><span class="fv-type">${esc(typeLabel)}</span><span class="fv-who" data-ref="who"></span></div>
<div class="fv-callout"></div>
<div class="fv-prompt"></div>
${userControlled && !isHR ? `
<div class="fv-dpad">
  <button type="button" class="fv-dpad-btn up" data-key="up" aria-label="上">▲</button>
  <button type="button" class="fv-dpad-btn left" data-key="left" aria-label="左">◀</button>
  <button type="button" class="fv-dpad-btn right" data-key="right" aria-label="右">▶</button>
  <button type="button" class="fv-dpad-btn down" data-key="down" aria-label="下">▼</button>
</div>
<div class="fv-actions">
  <button type="button" class="fv-btn-x" data-key="x" aria-label="X"><b>X</b><small data-ref="x-label">切替</small></button>
  <button type="button" class="fv-btn-z" data-key="z" aria-label="Z"><b>Z</b><small data-ref="z-label">キャッチ</small></button>
</div>` : '<button type="button" class="fv-skip" data-key="enter">Enter:スキップ ▶▶</button>'}`;
  }

  function bindTouch() {
    const on = (node, ev, fn) => { node.addEventListener(ev, fn); listeners.push([node, ev, fn]); };
    root.querySelectorAll('[data-key]').forEach((btn) => {
      const k = btn.dataset.key;
      on(btn, 'pointerdown', (e) => { e.preventDefault(); try { btn.setPointerCapture?.(e.pointerId); } catch (er) { /* */ } handleKey(k, true); });
      const up = (e) => { e.preventDefault(); if (k in held) handleKey(k, false); };
      on(btn, 'pointerup', up);
      on(btn, 'pointercancel', up);
      on(btn, 'lostpointercapture', up);
      on(btn, 'contextmenu', (e) => e.preventDefault());
    });
  }

  // ---------- 表示 ----------
  function callout(text, cls = '', ms = 1100) {
    if (!dom.callout) return;
    dom.callout.textContent = text;
    dom.callout.className = `fv-callout show ${cls}`;
    clearTimeout(calloutTimer);
    if (ms > 0) calloutTimer = setTimeout(() => { if (dom.callout) dom.callout.classList.remove('show'); }, ms);
  }

  function setPrompt() {
    root.dataset.phase = phase;
    root.dataset.base = selBase || '';
    let txt = '';
    if (phase === 'hr') txt = '';
    else if (!userControlled) txt = '';
    else if (phase === 'live') txt = '↑↓←→:移動　Z:キャッチ／ダイブ　X:選手切替';
    else if (phase === 'bobble') txt = 'ボールを拾っています…';
    else if (phase === 'secured') txt = `↑2塁　←3塁　→1塁　↓本塁　Z:送球${selBase ? `（${BASE_NAME[selBase]}）` : ''}`;
    if (touchAssist && phase === 'live') txt = 'おまかせ追球中 · 十字キーで動かせる · ダイブで好捕！';
    if (touchAssist && phase === 'secured') txt = `投げる塁をタップ！${selBase ? ` おすすめ：${BASE_NAME[selBase]}` : ''}`;
    if (dom.prompt) { dom.prompt.textContent = txt; dom.prompt.style.display = txt ? '' : 'none'; }
    if (dom.zLabel) dom.zLabel.textContent = phase === 'secured' ? '送球' : 'キャッチ';
  }

  function placeTok(el, x, y, extraScale = 1) {
    const p = project(x, y);
    const k = (0.55 + 0.55 * p.s) * extraScale;
    el.style.transform = `translate(${p.X.toFixed(1)}px,${p.Y.toFixed(1)}px) scale(${k.toFixed(3)})`;
    el.style.zIndex = String(100 + Math.round(p.Y));
  }

  function runnerXY(r) {
    const p = clamp(r.p, 0, 4);
    const i = Math.min(3, Math.floor(p));
    const k = p - i;
    const a = BASES[i], b = BASES[i + 1];
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  function render() {
    // 野手
    for (const f of fielders) {
      placeTok(f.el, f.x, f.y);
      f.el.classList.toggle('fv-run', f.moving && !reduceMotion);
      f.el.classList.toggle('fv-sel', f === user && (phase === 'live' || phase === 'bobble'));
      f.el.classList.toggle('fv-hold', f === holder);
      const diving = f.dive && t < f.dive.until + 0.5;
      f.el.classList.toggle('fv-dive', !!diving);
      f.el.classList.toggle('fv-dive-l', !!(diving && f.dive.dx < 0));
      f.el.classList.toggle('fv-down', t < f.downUntil);
    }
    for (const r of runners) {
      if (r.gone) { r.el.style.opacity = '0'; continue; }
      const p = runnerXY(r);
      placeTok(r.el, p.x, p.y, 0.95);
      r.el.classList.toggle('fv-run', r.moving && !reduceMotion);
    }
    // ボール
    let b;
    if ((phase === 'secured' || phase === 'after' || phase === 'done') && holder && !throwInfo) b = { x: holder.x + 0.3, y: holder.y, z: 1.3 };
    else if (throwInfo) b = throwPos();
    else if (phase === 'bobble' && holder) {
      const k = clamp((bobbleUntil - t) / 0.7, 0, 1);
      b = { x: holder.x + 0.9 * k, y: holder.y + 0.5 * k, z: 1.6 * Math.sin(Math.PI * k) };
    } else b = ballAt(t);
    const ps = project(b.x, b.y, 0);
    const pb = project(b.x, b.y, b.z);
    const bk = 0.55 + 0.6 * ps.s;
    dom.ball.style.transform = `translate(${pb.X.toFixed(1)}px,${pb.Y.toFixed(1)}px) scale(${bk.toFixed(3)})`;
    dom.ball.style.zIndex = String(b.z > 0.6 ? 2000 : 100 + Math.round(ps.Y) + 1);
    const shK = clamp(1 - b.z / 50, 0.6, 1) * bk;
    dom.shadow.style.transform = `translate(${ps.X.toFixed(1)}px,${ps.Y.toFixed(1)}px) scale(${shK.toFixed(3)})`;
    dom.shadow.style.zIndex = String(100 + Math.round(ps.Y) - 1);
    dom.shadow.style.opacity = holder && !throwInfo ? '0' : String(clamp(0.95 - b.z / 80, 0.6, 0.95));
    // 落下点
    const showMark = userControlled && phase === 'live' && type !== 'grounder' && inAirAt(t);
    dom.mark.style.display = showMark ? '' : 'none';
    if (showMark) {
      const pm = project(landing.x, landing.y);
      dom.mark.style.transform = `translate(${pm.X.toFixed(1)}px,${pm.Y.toFixed(1)}px) scale(${(0.5 + 0.6 * pm.s).toFixed(3)})`;
    }
    // 送球先
    const showBases = userControlled && phase === 'secured';
    dom.bases.forEach((m) => {
      m.classList.toggle('show', showBases);
      m.classList.toggle('on', showBases && Number(m.dataset.base) === selBase);
    });
    if (dom.who) dom.who.textContent = user && userControlled ? `${user.pos} ${user.name}` : '';
  }

  function throwPos() {
    const { from, to, start, dur } = throwInfo;
    const k = clamp((t - start) / dur, 0, 1);
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const arc = Math.min(4, 0.6 + d * 0.035);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: 1.6 + (1.2 - 1.6) * k + arc * 4 * k * (1 - k) };
  }

  // ---------- シミュレーション ----------
  function moveToward(f, tgt, dt, mul = 1) {
    if (!tgt) { f.moving = false; return; }
    const dx = tgt.x - f.x, dy = tgt.y - f.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.08) { f.moving = false; return; }
    const step = Math.min(d, f.speed * mul * dt);
    f.x += (dx / d) * step; f.y += (dy / d) * step;
    f.moving = true;
  }

  function stepRunners(dt) {
    for (const r of runners) {
      if (r.gone) { r.moving = false; continue; }
      if (t < r.startAt) { r.moving = false; continue; }
      const d = r.goal - r.p;
      if (Math.abs(d) < 1e-4) { r.moving = false; continue; }
      const prevBase = Math.floor(r.p + 1e-6);
      const step = Math.min(Math.abs(d), (r.speed / BASE_LEN) * dt) * Math.sign(d);
      r.p += step;
      r.moving = true;
      // 塁に到達したら進塁を判断
      if (Math.floor(r.p + 1e-6) > prevBase || Math.abs(r.goal - r.p) < 1e-4) {
        const at = Math.round(r.p);
        if (Math.abs(r.p - at) < 1e-3 && at >= 4) { r.scored = true; r.gone = true; continue; }
        if (Math.abs(r.goal - r.p) < 1e-4 && Number.isInteger(r.goal) && phase === 'live' && !isHR && !holder) {
          const ballD = Math.hypot(ballAt(t).x, ballAt(t).y);
          const spare = primaryEta - t;
          const caughtPossible = inAirAt(t);
          if (!caughtPossible && ballD > 45 && spare > 1.6 && r.goal < 4) r.goal += 1;
        }
      }
    }
  }

  function onTouchdown() {
    touchedDown = true;
    const deep = Math.hypot(landing.x, landing.y) > 80;
    for (const r of runners) {
      if (r.isBatter || r.gone) continue;
      r.goal = Math.min(4, r.origin + (deep && r.origin >= 1 ? 2 : 1));
    }
  }

  function secure(f, { diving = false, retrieved = false } = {}) {
    if (holder) return;
    holder = f;
    const air = inAirAt(t);
    const routine = !diving && !retrieved;
    const errP = routine ? 0.04 - (f.catching / 99) * 0.03 : 0;
    const error = Math.random() < errP;
    const caughtInAir = air && !error;
    result = {
      caughtInAir, fielderId: f.id, fieldedAt: { x: round2(f.x), y: round2(f.y) },
      fieldTime: round2(t + (error ? 0.7 : 0)), throwTo: null, throwTime: null, error, diving,
      throwStartAt: null, throwArriveAt: null,
    };
    f.moving = false;
    play('catch');
    if (caughtInAir) {
      callout(diving ? 'ダイビングキャッチ！' : 'ナイスキャッチ！', 'good');
      // フライアウト: 走者は帰塁、打者走者は退く
      for (const r of runners) {
        if (r.isBatter) { r.gone = true; continue; }
        r.goal = r.origin;
      }
    } else {
      if (air && !touchedDown) onTouchdown();
      if (error) callout(air ? '落球！' : 'エラー！', 'bad');
      else if (diving) callout('ダイビング！', 'good');
      // 捕球後は次の塁で止まる
      for (const r of runners) {
        if (r.gone) continue;
        const next = Math.min(4, Math.max(r.isBatter ? 1 : 0, Math.ceil(r.p - 1e-6)));
        if (r.goal > next) r.goal = next;
        if (r.isBatter && r.goal < 1) r.goal = 1;
      }
    }
    if (error) { phase = 'bobble'; bobbleUntil = t + 0.7; }
    else enterSecured();
    setPrompt();
  }
  const round2 = (v) => Math.round(v * 100) / 100;

  function enterSecured() {
    phase = 'secured';
    securedAt = t;
    selBase = smartBase();
    if (touchAssist) { try { opts.sound?.say?.('とった！ 塁をタップして送球！'); } catch {} }
    fielders.forEach((f) => { if (f !== holder && f.role !== 'cover') f.role = 'stay-still'; });
    setPrompt();
  }

  function throwSpeed(f) { return 25 + f.arm * 0.15; }

  /** 最も賢明な送球先 */
  function smartBase() {
    const h = holder;
    if (!h) return null;
    const live = runners.filter((r) => !r.gone);
    if (result?.caughtInAir) {
      const others = live.filter((r) => !r.isBatter);
      if (!others.length) return OUTFIELD.includes(h.pos) ? 2 : null;
      const r3 = others.find((r) => r.origin === 3);
      if (r3 && outs < 2 && OUTFIELD.includes(h.pos) && Math.hypot(h.x, h.y) < 85) return 4;
      const off = others.filter((r) => r.p - r.origin > 0.2).sort((a, b) => b.origin - a.origin)[0];
      if (off) return off.origin;
      return OUTFIELD.includes(h.pos) ? 2 : null;
    }
    let best = null;
    for (const r of live) {
      if (r.goal <= r.p + 1e-3) continue;
      const nb = Math.min(4, Math.floor(r.p + 1e-6) + 1);
      const remain = ((nb - r.p) * BASE_LEN) / r.speed + Math.max(0, r.startAt - t);
      const thr = dist(h, BASES[nb]) / throwSpeed(h) + 0.2;
      const margin = remain - thr;
      if (margin > 0.05 && (!best || nb > best.nb)) best = { nb, margin };
    }
    if (best) return best.nb;
    const moving = live.filter((r) => r.goal > r.p + 1e-3);
    if (moving.length) {
      const lead = Math.max(...moving.map((r) => Math.min(4, Math.ceil(r.goal))));
      if (INFIELD.includes(h.pos) && moving.some((r) => r.isBatter && r.p < 1)) return 1;
      return OUTFIELD.includes(h.pos) ? Math.max(2, lead) : lead;
    }
    return OUTFIELD.includes(h.pos) ? 2 : null;
  }

  function doThrow(base) {
    if (phase !== 'secured' || !holder) return;
    result.throwTo = base ?? null;
    if (!base) { finishSoon(0.5); return; }
    const to = BASES[base];
    const from = { x: holder.x, y: holder.y };
    const dur = Math.max(0.15, dist(from, to) / throwSpeed(holder));
    throwInfo = { from, to, base, start: t, dur };
    result.throwTime = round2(dur);
    result.throwStartAt = round2(t);
    result.throwArriveAt = round2(t + dur);
    phase = 'throw';
    play('swing');
    setPrompt();
  }

  function finishSoon(delay) {
    phase = 'after';
    doneAt = t + delay;
    setPrompt();
  }

  function step(dt) {
    t += dt;
    if (phase === 'hr') {
      stepRunners(dt);
      const hb = ballAt(t);
      if (!hrCalled && Math.hypot(hb.x, hb.y) >= fenceR(hb.x, hb.y) - 1) { hrCalled = true; callout('ホームラン！', 'hr', 0); play('cheer'); }
      // 外野手はフェンス際まで追う
      for (const f of fielders) {
        if (t < f.react || (f.role !== 'chase' && f.role !== 'backup')) { f.moving = false; continue; }
        const k = (fenceR(landing.x, landing.y) - 2) / (Math.hypot(landing.x, landing.y) || 1);
        moveToward(f, { x: landing.x * Math.min(1, k), y: landing.y * Math.min(1, k) }, dt);
      }
      if (t >= PEND + 1.4) { phase = 'done'; }
      return;
    }
    // 打球の接地（フライ系）
    if (phase === 'live' && !touchedDown && type !== 'grounder' && t >= tdTime) onTouchdown();

    // 野手の移動
    for (const f of fielders) {
      if (t < f.downUntil) { f.moving = false; continue; }
      if (f.dive && t < f.dive.until) {
        f.x += f.dive.dx * dt; f.y += f.dive.dy * dt; f.moving = false;
        if (t + dt >= f.dive.until && !f.dive.ok) f.downUntil = f.dive.until + 0.9;
        continue;
      }
      if (f === holder) { f.moving = false; continue; }
      if (phase === 'live' && f === user && userControlled) {
        const vx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
        const vy = (held.up ? 1 : 0) - (held.down ? 1 : 0);
        const m = Math.hypot(vx, vy);
        if (m > 0) { f.x += (vx / m) * f.speed * dt; f.y += (vy / m) * f.speed * dt; f.moving = true; }
        else if (touchAssist && t >= f.react) moveToward(f, intercept(f, t), dt);
        else f.moving = false;
        f.x = clamp(f.x, -110, 110); f.y = clamp(f.y, -8, 130);
        continue;
      }
      if (t < f.react) { f.moving = false; continue; }
      if (phase === 'live' || phase === 'bobble') {
        if (phase === 'bobble' && f.role !== 'cover') { f.moving = false; continue; }
        moveToward(f, aiTarget(f), dt, f.role === 'drift' ? 0.6 : 1);
      } else if (f.role === 'cover') {
        moveToward(f, aiTarget(f), dt);
      } else f.moving = false;
    }

    stepRunners(dt);

    if (phase === 'live') {
      const b = ballAt(t);
      // 自動捕球
      if (t > 0.25) {
        let best = null;
        for (const f of fielders) {
          if (t < f.downUntil) continue;
          const diving = f.dive && t < f.dive.until;
          const d = Math.hypot(b.x - f.x, b.y - f.y);
          const r = catchR(f, t) + (diving && f.dive.ok ? 1.2 : 0);
          const zMax = REACH_Z + (diving && f.dive.ok ? 0.4 : 0);
          if (d <= r && b.z < zMax && (!best || d < best.d)) best = { f, d, diving: !!(diving && d > catchR(f, t)) };
        }
        if (best) { secure(best.f, { retrieved: t > PEND, diving: best.diving }); return; }
      }
      // 停止したボールの回収
      if (t > PEND + 0.4 && !retrieveAssigned) {
        retrieveAssigned = true;
        const cands = fielders.filter((f) => f !== user || !userControlled);
        cands.sort((a, c) => Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(b.x - c.x, b.y - c.y));
        cands.slice(0, 2).forEach((f) => { f.role = 'retrieve'; });
      }
      if (t > MAX_SIM_S) {
        const n = fielders.slice().sort((a, c) => Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
        if (n) { n.x = b.x; n.y = b.y; secure(n, { retrieved: true }); }
      }
    } else if (phase === 'bobble') {
      if (t >= bobbleUntil) enterSecured();
    } else if (phase === 'secured') {
      const wait = userControlled ? AUTO_THROW_S : CPU_HOLD_S;
      if (t - securedAt >= wait) doThrow(userControlled ? selBase : smartBase());
    } else if (phase === 'throw') {
      if (t >= throwInfo.start + throwInfo.dur) {
        const recv = fielders.filter((f) => f !== holder).sort((a, c) => dist(a, throwInfo.to) - dist(c, throwInfo.to))[0];
        play('catch');
        if (recv) { holder = recv; }
        throwInfo = null;
        finishSoon(0.45);
      }
    } else if (phase === 'after') {
      if (t >= doneAt) phase = 'done';
    }
  }

  function finish() {
    if (calledDone) return;
    calledDone = true;
    setPrompt();
    render();
    const res = isHR ? null : result;
    try { opts.onDone?.(res); } catch (e) { console.error(e); }
  }

  function frame(nowMs) {
    if (destroyed) return;
    if (document.hidden) { lastNow = 0; Object.keys(held).forEach(k => held[k] = false); rafId = requestAnimationFrame(frame); return; }
    const dtReal = lastNow ? Math.min(0.05, (nowMs - lastNow) / 1000) : 0;
    lastNow = nowMs;
    // Slow the entire play equally so runners and throw physics remain fair.
    let acc = dtReal * (touchAssist && phase === 'secured' ? 0.4 : 1);
    while (acc > 1e-6 && phase !== 'done') {
      const d = Math.min(DT, acc);
      step(d);
      acc -= d;
    }
    render();
    if (phase === 'done') { finish(); rafId = 0; return; }
    rafId = requestAnimationFrame(frame);
  }

  function skipToEnd() {
    let guard = 0;
    while (phase !== 'done' && guard++ < MAX_SIM_S * 2 / DT) step(DT);
    if (phase !== 'done') phase = 'done';
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    finish();
  }

  // ---------- 入力 ----------
  function switchFielder() {
    if (!userControlled || phase !== 'live') return;
    // 現在位置から打球に近い順
    const ranked = rankByIntercept().map((r) => r.f);
    const idx = ranked.indexOf(user);
    const next = ranked[(idx + 1) % Math.min(ranked.length, 4)] || ranked[0];
    setUser(next);
    play('select');
  }

  function setUser(f) {
    if (user && user !== f) { user.role = user._prevRole && user._prevRole !== 'user' ? user._prevRole : 'chase'; }
    user = f;
    if (f) { f._prevRole = f.role; f.role = 'user'; }
    // ユーザーが主役なら AI の主役を後方支援へ
    fielders.forEach((g) => { if (g !== f && g.role === 'chase') g.role = 'backup'; });
  }

  function tryDive() {
    if (!user || phase !== 'live' || t < user.downUntil || (user.dive && t < user.dive.until + 0.3)) return;
    // 今後 0.45 秒で最も近づく地点へ飛び込む
    let best = null;
    for (let k = 0; k <= 0.45 + 1e-6; k += 0.05) {
      const q2 = ballAt(t + k);
      if (q2.z >= REACH_Z + 0.4) continue;
      const d = Math.hypot(q2.x - user.x, q2.y - user.y);
      if (!best || d < best.d) best = { d, q: q2 };
    }
    if (!best || best.d > DIVE_RANGE + 0.6) return; // 届かない: 何もしない
    const dd = best.d;
    const ux = (best.q.x - user.x) / (dd || 1), uy = (best.q.y - user.y) / (dd || 1);
    const len = clamp(dd - 0.3, 0, 2.2);
    const p = clamp(0.3 + 0.45 * (user.fielding / 99) - 0.25 * clamp((dd - user.R) / (DIVE_RANGE - user.R), 0, 1), 0.12, 0.85);
    user.dive = { until: t + 0.3, dx: (ux * len) / 0.3, dy: (uy * len) / 0.3, ok: dd <= user.R || Math.random() < p };
    play('swing');
  }

  function handleKey(key, isDown = true) {
    if (destroyed) return;
    if (isDown && userControlled && phase === 'secured' && /^base[1-4]$/.test(key)) {
      selBase = Number(key.slice(-1)); doThrow(selBase); return;
    }
    if (key in held) {
      held[key] = !!isDown;
      if (isDown && userControlled && phase === 'secured' && KEY_BASE[key]) {
        selBase = KEY_BASE[key];
        securedAt = Math.max(securedAt, t - AUTO_THROW_S + 0.6); // 選択後は少し待つ
        play('select');
        setPrompt();
      }
      return;
    }
    if (!isDown) return;
    if (!userControlled || phase === 'hr') {
      if (key === 'enter' || key === 'z') skipToEnd();
      return;
    }
    if (key === 'x') switchFielder();
    else if (key === 'z' || key === 'enter') {
      if (phase === 'live' && key === 'z') tryDive();
      else if (phase === 'secured') doThrow(selBase ?? smartBase());
    }
  }

  // ---------- 初期化 ----------
  assignRoles();
  if (userControlled && !isHR) {
    const first = switchOrder[0];
    setUser(first);
  }
  bindTouch();
  setPrompt();
  render();
  if (isHR) { /* nothing to field */ }

  return {
    start() {
      if (started || destroyed) return;
      started = true;
      lastNow = 0;
      rafId = requestAnimationFrame(frame);
    },
    handleKey,
    /** テスト・デバッグ用のスナップショット */
    debug() {
      const b = ballAt(t);
      return { t, phase, type, ball: b, landing, user: user && { x: user.x, y: user.y, pos: user.pos, R: user.R },
        aim: user ? intercept(user, t, 0) : null, holder: holder && holder.pos, selBase, result };
    },
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearTimeout(calloutTimer);
      listeners.forEach(([n, ev, fn]) => n.removeEventListener(ev, fn));
      listeners.length = 0;
      root.remove();
    },
  };
}
