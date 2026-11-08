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
 *     mode?: 'assist' | 'manual' | 'cpu'
 *            assist: 打球に一番早く追いつく野手が自動で追って捕る。ユーザーは送球先だけ選ぶ（塁ボタン / 矢印+Z）。
 *                    送球先を選ぶ間はスローモーション、1.2 秒（実時間）でおすすめの塁へ自動送球
 *            manual: ユーザーが野手を動かす（十字キー・Z ダイブ・X 切替）。省略時はタッチ端末なら従来どおり指を離すと自動で追う
 *            cpu   : CPU の守備を見せるだけ（userControlled=false）
 *     timeScale?: 再生速度（CPU 守備ビューの早送り 1.5 など）
 *     tapToSkip?: true なら画面のどこをタップ/クリックしてもスキップ（CPU 守備のみ）
 *   }
 *   key: 'up'|'down'|'left'|'right'|'z'|'x'|'enter'
 *   result = { caughtInAir, fielderId, fieldedAt:{x,y}, fieldTime, throwTo:1|2|3|4|null, throwTime, error,
 *              diving, throwStartAt, throwArriveAt }
 *   ホームランの場合は飛球を再生して onDone(null)。
 *   際どい判定（走者の到達と送球の到達の差 < CLOSE_S 秒）は、その瞬間をスロー（CLOSE_SLOW 倍）にして
 *   塁審のジェスチャー（アウト = 拳を上げる / セーフ = 両腕を広げる）を出す。見た目のみで判定・タイミングは変えない。
 *   prefers-reduced-motion ではスローにしない。
 *
 * 座標: メートル。本塁(0,0)、+y=センター方向、+x=一塁/ライト側、z=高さ。
 */

const DT = 1 / 120;            // シミュレーション刻み (s)
const REACH_Z = 2.8;           // 捕球できる高さ（engine TUNING.catchHeight と同じ）
const DIVE_RANGE = 2.5;        // ダイビング可能距離
const BASE_LEN = 27.43;        // 塁間（走者の走行距離計算用）
const AUTO_THROW_S = 1.2;      // 送球入力待ち
const CPU_HOLD_S = 0.35;       // CPU の送球までの間
const MAX_SIM_S = 25;
// 際どい判定の演出（見た目のみ）
const CLOSE_S = 0.15;          // 走者の到達と送球の到達の差がこれ未満なら「際どい」
const CLOSE_SLOW = 0.35;       // その瞬間の再生速度
const CLOSE_PRE = 0.4;         // 到達のこの秒数前からスロー
const CLOSE_POST = 0.3;        // 到達のこの秒数後までスロー
const CLOSE_CALL_DELAY = 0.1;  // ジェスチャーの後にコールの文字（シミュレーション秒）
/** 塁審の立ち位置（塁からのずれ、m）。1・3塁はファウルゾーン、2塁は外野寄り、本塁は三塁側の後ろ */
const UMP_OFFSET = { 1: { x: 3.2, y: 1.4 }, 2: { x: 3.4, y: 3.4 }, 3: { x: -3.2, y: 1.4 }, 4: { x: -2.4, y: -2.2 } };

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

/** 縦向き（body.portrait）は守備ビューを小さく縮めて全体を見せるので、選手・ボールを大きめに描く（見た目だけ） */
function viewZoom() {
  return typeof document !== 'undefined' && document.body?.classList.contains('portrait') ? 1.45 : 1;
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
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const assistMode = userControlled && opts.mode === 'assist';      // 自動で捕球、送球先だけ選ぶ
  const manualMode = userControlled && opts.mode === 'manual';
  // 従来のタッチ補助（指を離すと自動で追う・送球選択のスロー）: mode 未指定のタッチ端末。assist は常に
  const touchAssist = userControlled && (assistMode || (!manualMode && coarse));
  const SLOW_SECURED = 0.4;           // 送球先を選ぶ間のスローモーション
  const slowSecured = assistMode || (userControlled && coarse);
  const timeScale = clamp(num(opts.timeScale, 1), 0.25, 4);
  const AUTO_THROW_REAL_S = 1.2;      // assist: 実時間でこの秒数たったらおすすめの塁へ自動送球
  const isHR = !!ball.isHomeRun || ball.type === 'hr';
  const type = isHR ? 'hr' : (ball.type || 'grounder');
  const outs = num(opts.state?.outs, 0);
  // 判定をエンジンと一致させる（任意）: previewPlay(fielding) → 走者の目標塁・到達時刻とアウト／セーフ、
  // throwTime(fielderId, from, base) → 送球の所要時間、suggestThrow(fielding) → おすすめ送球先
  const judge = typeof opts.previewPlay === 'function' ? opts.previewPlay : null;
  const engThrowTime = typeof opts.throwTime === 'function' ? opts.throwTime : null;
  const engSuggest = typeof opts.suggestThrow === 'function' ? opts.suggestThrow : null;
  // CPU 守備ビュー: エンジンの CPU 守備（autoField）の結果どおりに見せる（打席結果と一致させる）
  const forced = !userControlled && opts.forced && opts.forced.fielderId ? opts.forced : null;
  let autoAll = false;       // スキップ: 残りを CPU 守備で一気に処理
  let verdict = null;        // 送球後の判定（previewPlay の結果）
  const closes = [];         // 際どい判定の瞬間 [{ base, at, out }]（見た目のみ）
  const timers = [];         // シミュレーション時間のタイマー
  const later = (fn, sec) => timers.push({ at: t + sec, fn });
  const safeCall = (fn, ...a) => { try { return fn(...a); } catch (e) { console.warn(e); return null; } };
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
  /** 飛球が捕球高さまで下りてくる時刻（見た目専用: 落下点で待つ外野手の「入り直し」演出） */
  const catchT = (() => {
    if (type === 'grounder' || isHR) return tdTime;
    let iMax = 0;
    for (let i = 1; i <= tdIndex; i++) if (path[i].z > path[iMax].z) iMax = i;
    for (let i = iMax; i <= tdIndex; i++) if (path[i].z < REACH_Z) return path[i].t;
    return tdTime;
  })();

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
    const eng = p.eng && Number.isFinite(p.eng.runSpeed) ? p.eng : null; // エンジンと同じ守備範囲（判定のずれを防ぐ）
    return {
      id: p.id, name: p.name || '', pos, color: p.color || '#1E88E5',
      speed: eng ? eng.runSpeed : 6 + (clamp(num(p.speed, 50), 1, 99) / 99) * 1.5,
      fielding: fieldingV, catching: catchingV, arm: clamp(num(p.arm, 50), 1, 99),
      R: eng ? eng.reachGround : 0.95 + (((fieldingV + catchingV) / 2) / 99) * 0.55,
      RA: eng ? eng.reachAir : null,
      react: eng ? eng.react : 0.26 - (fieldingV / 99) * 0.1,
      x: home.x, y: home.y, home, target: null, speedMul: 1,
      role: 'stay', downUntil: 0, dive: null, moving: false, el: null,
      // 見た目専用（判定には使わない）
      face: 1, vx: 0, vy: 0, vo: { x: 0, y: 0 }, waitSince: null, catchAt: null, catchPose: '', throwAt: null, recvAt: null,
    };
  });
  const byPos = (pos) => fielders.find((f) => f.pos === pos);
  /** 捕球半径（飛球は落下点に入りやすいよう広め） */
  const catchR = (f, tt) => (inAirAt(tt) ? (f.RA ?? f.R + 0.6) : f.R);

  // ---------- 走者 ----------
  const runnerSpeed = (s) => 6.0 + (clamp(num(s, 50), 1, 99) / 99) * 2.2;
  const occ = [0, 1, 2].map((i) => !!(opts.runners && opts.runners[i]));
  const runners = [];
  runners.push({ id: opts.batterId ?? ball.batterId ?? 'batter', name: opts.batterName || '', isBatter: true, origin: 0,
    p: 0, goal: 1, speed: runnerSpeed(opts.batterSpeed), startAt: 0.3, gone: false, scored: false, el: null,
    face: 1, vx: 0, vy: 0, vo: { x: 0, y: 0 } });
  (opts.runners || []).slice(0, 3).forEach((r, i) => {
    if (!r) return;
    const forced = occ.slice(0, i).every(Boolean);
    runners.push({ id: r.id, name: r.name || '', isBatter: false, origin: i + 1, forced, p: i + 1, goal: i + 1,
      speed: runnerSpeed(r.speed), startAt: 0.05, gone: false, scored: false, el: null, face: 1, vx: 0, vy: 0, vo: { x: 0, y: 0 } });
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
  root.className = `fv${userControlled && !isHR ? ' fv-user' : ' fv-cpu'}${assistMode && !isHR ? ' fv-assist' : ''}${isHR ? ' fv-hr' : ''}${reduceMotion ? ' fv-rm' : ''}`;
  root.innerHTML = template();
  container.appendChild(root);
  const q = (s) => root.querySelector(s);
  const dom = {
    layer: q('.fv-layer'), ball: q('.fv-ball'), shadow: q('.fv-shadow'), mark: q('.fv-landmark'),
    prompt: q('.fv-prompt'), callout: q('.fv-callout'), who: q('[data-ref="who"]'), skip: q('.fv-skip'),
    bases: [...root.querySelectorAll('.fv-basemark')], trail: [...root.querySelectorAll('.fv-trail')], zLabel: q('[data-ref="z-label"]'), xLabel: q('[data-ref="x-label"]'),
  };
  fielders.forEach((f) => { f.el = tokenEl(f.color, f.pos, false); dom.layer.appendChild(f.el); });
  // 塁審（際どい判定のときだけ現れる。本作の絵柄の 2 頭身）
  const ump = { el: null, base: 0, call: '' };
  function umpEl() {
    if (ump.el) return ump.el;
    const el = document.createElement('div');
    el.className = 'fv-tok fv-ump';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<i class="fv-tok-ring"></i><div class="fv-tok-fig"><i class="fv-ump-arm l"></i><i class="fv-ump-arm r"></i><div class="fv-tok-head"><i class="fv-tok-cap"></i><i class="fv-tok-eye l"></i><i class="fv-tok-eye r"></i></div><div class="fv-tok-body"></div><div class="fv-tok-legs"><i></i><i></i></div></div>';
    dom.layer.appendChild(el);
    ump.el = el;
    return el;
  }
  /** 塁審をその塁のそばに立たせる（判定前は構えて見ている） */
  function umpWatch(base) {
    const el = umpEl();
    ump.base = base; ump.call = '';
    el.classList.remove('fv-ump-out', 'fv-ump-safe');
    el.classList.add('show', 'fv-ump-watch');
  }
  /** 判定のジェスチャー: out = 拳を上げる、safe = 両腕を横に広げる */
  function umpCall(base, out) {
    const el = umpEl();
    if (ump.base !== base) umpWatch(base);
    ump.call = out ? 'out' : 'safe';
    el.classList.remove('fv-ump-watch', 'fv-ump-out', 'fv-ump-safe');
    void el.offsetWidth;
    el.classList.add('show', out ? 'fv-ump-out' : 'fv-ump-safe');
  }
  runners.forEach((r) => { r.el = tokenEl(opts.runnerColor || '#E5484D', r.isBatter ? '打' : '走', true); dom.layer.appendChild(r.el); });

  function tokenEl(color, label, runner) {
    const el = document.createElement('div');
    el.className = `fv-tok${runner ? ' fv-runner' : ''}`;
    el.style.setProperty('--team', color);
    el.innerHTML = `<i class="fv-tok-ring"></i><div class="fv-tok-fig"><div class="fv-tok-head"><i class="fv-tok-cap"></i><i class="fv-tok-eye l"></i><i class="fv-tok-eye r"></i></div><div class="fv-tok-body"></div><div class="fv-tok-legs"><i></i><i></i></div><i class="fv-tok-glove"></i><i class="fv-tok-hand"></i></div><b class="fv-tok-label">${esc(label)}</b><i class="fv-tok-arrow"></i>${runner ? '<b class="fv-tok-out">OUT</b>' : ''}`;
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
      return `<div class="fv-basemark" data-base="${n}" style="left:${p.X.toFixed(1)}px;top:${p.Y.toFixed(1)}px"><i class="fv-basering"></i><span><b>${key}</b>${BASE_NAME[n]}</span></div>`;
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
<div class="fv-slowfx" aria-hidden="true"><b>スロー</b></div>
<div class="fv-layer"><div class="fv-landmark"></div><div class="fv-shadow"></div><i class="fv-trail"></i><i class="fv-trail"></i><i class="fv-trail"></i><div class="fv-ball"></div></div>
<div class="fv-hud"><span class="fv-chip">${userControlled && !isHR ? (assistMode ? 'おまかせ守備' : '守備') : '打球'}</span><span class="fv-type">${esc(typeLabel)}</span><span class="fv-who" data-ref="who"></span></div>
<div class="fv-callout" role="status" aria-live="polite"></div>
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
</div>
<button type="button" class="fv-skip fv-skip-user" data-key="skip" aria-label="守備をスキップ（S）">スキップ ▶▶<small>S</small></button>` : `<button type="button" class="fv-skip" data-key="enter" aria-label="スキップ（S / Enter）">${opts.tapToSkip ? (coarse ? 'タップでスキップ ▶▶' : 'タップ / S:スキップ ▶▶') : 'S / Enter:スキップ ▶▶'}</button>`}`;
  }

  function bindTouch() {
    const on = (node, ev, fn) => { node.addEventListener(ev, fn); listeners.push([node, ev, fn]); };
    // 送球先マーカーをタップ/クリックでその塁へ送球
    dom.bases.forEach((m) => on(m, 'pointerdown', (e) => {
      if (!userControlled || phase !== 'secured') return;
      e.preventDefault();
      e.stopPropagation();
      handleKey(`base${m.dataset.base}`, true);
    }));
    // CPU 守備: どこをタップしてもスキップ
    if (!userControlled && opts.tapToSkip) on(root, 'pointerdown', (e) => { e.preventDefault(); skipToEnd(); });
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
    dom.callout.className = 'fv-callout';
    void dom.callout.offsetWidth; // スタンプ演出を毎回やり直す
    dom.callout.className = `fv-callout show ${cls}`;
    clearTimeout(calloutTimer);
    if (ms > 0) calloutTimer = setTimeout(() => { if (dom.callout) dom.callout.classList.remove('show'); }, ms);
  }

  /** 下部の操作ガイド（キーはキーキャップ風に） */
  const kbd = (k) => `<kbd>${k}</kbd>`;
  function setPrompt() {
    root.dataset.phase = phase;
    root.dataset.base = selBase || '';
    let html = '';
    let tag = '';
    const rec = selBase ? BASE_NAME[selBase] : '投げない';
    if (phase === 'hr' || !userControlled) html = '';
    else if (phase === 'live') { tag = '守備'; html = `${kbd('↑↓←→')}移動<span class="fv-sep"></span>${kbd('Z')}キャッチ／ダイブ<span class="fv-sep"></span>${kbd('X')}選手切替`; }
    else if (phase === 'bobble') { tag = '守備'; html = 'ボールを拾っています…'; }
    else if (phase === 'secured') { tag = '送球'; html = `${kbd('↑')}2塁 ${kbd('←')}3塁 ${kbd('→')}1塁 ${kbd('↓')}本塁<span class="fv-sep"></span>${kbd('Z')}送球${selBase ? `（<em>${BASE_NAME[selBase]}</em>）` : ''}`; }
    if (touchAssist && !assistMode && phase === 'live') { tag = 'おまかせ'; html = '自動で追球中 · 十字キーで動かせる · ダイブで好捕！'; }
    if (assistMode && phase === 'live') { tag = 'おまかせ'; html = '野手が自動で捕るよ'; }
    if (assistMode && phase === 'secured' && !coarse) { tag = '送球先'; html = `${kbd('→')}1塁 ${kbd('↑')}2塁 ${kbd('←')}3塁 ${kbd('↓')}本塁 → ${kbd('Z')}<span class="fv-sep"></span>そのままなら <em>${rec}</em>`; }
    if (coarse && userControlled && phase === 'secured') { tag = '送球'; html = `投げる塁をタップ！${selBase ? `<span class="fv-sep"></span>おすすめ <em>${BASE_NAME[selBase]}</em>` : ''}`; }
    if (dom.prompt) {
      dom.prompt.innerHTML = html ? `${tag ? `<span class="fv-prompt-tag">${tag}</span>` : ''}<span class="fv-prompt-txt">${html}</span>` : '';
      dom.prompt.style.display = html ? '' : 'none';
      dom.prompt.classList.toggle('fv-prompt-auto', phase === 'secured' && userControlled);
    }
    if (dom.zLabel) dom.zLabel.textContent = phase === 'secured' ? '送球' : 'キャッチ';
  }

  function placeTok(el, x, y, extraScale = 1) {
    const p = project(x, y);
    const k = (0.55 + 0.55 * p.s) * extraScale * viewZoom();
    el.style.transform = `translate(${p.X.toFixed(1)}px,${p.Y.toFixed(1)}px) scale(${k.toFixed(3)})`;
    el.style.zIndex = String(100 + Math.round(p.Y));
    return p;
  }

  function runnerXY(r) {
    const p = clamp(r.p, 0, 4);
    const i = Math.min(3, Math.floor(p));
    const k = p - i;
    const a = BASES[i], b = BASES[i + 1];
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  // ---------- 見た目専用の動き（位置・判定には影響しない） ----------
  const DIAMOND_C = { x: (F.first.x + F.third.x) / 2, y: F.second.y / 2 };
  const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };
  const ease = (v) => 1 - (1 - clamp(v, 0, 1)) ** 2;
  /** 位置オフセットを滑らかに追従させる（m） */
  function smoothOffset(o, tx, ty, k = 0.18) {
    if (reduceMotion) { o.vo.x = tx; o.vo.y = ty; return o.vo; }
    o.vo.x += (tx - o.vo.x) * k; o.vo.y += (ty - o.vo.y) * k;
    return o.vo;
  }
  /** 走者: ベースを膨らんで回る・一塁の駆け抜け */
  function runnerOffset(r) {
    let ox = 0, oy = 0;
    const p = clamp(r.p, 0, 4);
    const i = Math.min(3, Math.floor(p));
    const k = p - i;
    if (r.goal > i + 1 + 1e-3 && k > 0 && i < 3) {
      // 次の塁を回る: 塁の手前で外へ膨らみ、塁の上で戻る
      const a = BASES[i], b = BASES[i + 1];
      const n = unit((a.x + b.x) / 2 - DIAMOND_C.x, (a.y + b.y) / 2 - DIAMOND_C.y);
      const amp = 1.7 * Math.sin(Math.PI * k) * (0.35 + 0.65 * k);
      ox += n.x * amp; oy += n.y * amp;
    }
    if (r.isBatter && r.thruAt != null && !r.gone) {
      const e = t - r.thruAt;
      const g = e < 0.45 ? ease(e / 0.45) : e < 1.0 ? 1 : Math.max(0, 1 - (e - 1.0) / 0.9);
      const d = r.thruInf ? unit(F.first.x - F.home.x, F.first.y - F.home.y) : unit(F.second.x - F.first.x, F.second.y - F.first.y);
      const len = r.thruInf ? 3.2 : 2.4;
      if (r.goal <= 1 + 1e-3) { ox += d.x * len * g; oy += d.y * len * g; }
    }
    return smoothOffset(r, ox, oy);
  }
  /** 野手: 飛球の落下点で待つときは一歩下がって構え、落ちてくるのに合わせて前へ入る */
  function fielderOffset(f) {
    let ox = 0, oy = 0;
    const camping = phase === 'live' && inAirAt(t) && !f.moving && (f.role === 'chase' || f.role === 'backup' || (f === user && assistMode))
      && !(f === user && userControlled && !assistMode) && t < catchT;
    if (camping) {
      if (f.waitSince == null) f.waitSince = t;
      const m = Math.min(1, (t - f.waitSince) / 0.5) * clamp((catchT - t) / 1.0, 0, 1) * 1.3;
      const n = unit(f.x, f.y);
      ox = n.x * m; oy = n.y * m;
    } else f.waitSince = null;
    return smoothOffset(f, ox, oy, 0.25);
  }
  /** 向き（左右反転）と後ろ向き */
  function faceTok(o, p, lookX) {
    const lx = o._sx ?? p.X, ly = o._sy ?? p.Y;
    o._sx = p.X; o._sy = p.Y;
    o.vx = o.vx * 0.7 + (p.X - lx) * 0.3; o.vy = o.vy * 0.7 + (p.Y - ly) * 0.3;
    if (o.moving && Math.abs(o.vx) > 0.12) o.face = o.vx > 0 ? 1 : -1;
    else if (!o.moving && lookX != null && Math.abs(lookX - p.X) > 6) o.face = lookX > p.X ? 1 : -1;
    const back = !!o.moving && o.vy < -0.15 && Math.abs(o.vy) > Math.abs(o.vx) * 1.1;
    o.el.style.setProperty('--face', String(o.face || 1));
    o.el.classList.toggle('fv-back', back);
  }
  const POSES = ['fv-ready', 'fv-low', 'fv-high', 'fv-target', 'fv-stretch', 'fv-throw', 'fv-crow'];
  function setPose(el, pose) {
    for (const c of POSES) el.classList.toggle(c, c === pose);
  }
  function receiverOf(to) {
    return fielders.filter((f) => f !== holder).sort((a, c) => dist(a, to) - dist(c, to))[0] || null;
  }

  function ballRenderPos() {
    if ((phase === 'secured' || phase === 'after' || phase === 'done') && holder && !throwInfo) return { x: holder.x + 0.3, y: holder.y, z: 1.3 };
    if (throwInfo) return throwPos();
    if (phase === 'bobble' && holder) {
      const k = clamp((bobbleUntil - t) / 0.7, 0, 1);
      return { x: holder.x + 0.9 * k, y: holder.y + 0.5 * k, z: 1.6 * Math.sin(Math.PI * k) };
    }
    const b = ballAt(t);
    // ゴロは小さく跳ねながら転がる（見た目だけ）
    if (!reduceMotion && b.z < 0.05 && t < PEND) {
      const q2 = ballAt(Math.max(P0, t - 0.05));
      const v = Math.hypot(b.x - q2.x, b.y - q2.y) / 0.05;
      if (v > 2) b.z += Math.min(0.75, v * 0.028) * Math.abs(Math.sin((Math.PI * t) / 0.3));
    }
    return b;
  }

  function render() {
    const b = ballRenderPos();
    const pbView = project(b.x, b.y, b.z);
    const thrower = throwInfo ? project(throwInfo.from.x, throwInfo.from.y) : null;
    const holderP = holder ? project(holder.x, holder.y) : null;
    const recv = throwInfo ? receiverOf(throwInfo.to) : null;
    // 野手
    for (const f of fielders) {
      const o = fielderOffset(f);
      const p = placeTok(f.el, f.x + o.x, f.y + o.y);
      f.el.classList.toggle('fv-run', f.moving && !reduceMotion);
      f.el.classList.toggle('fv-sel', f === user && (phase === 'live' || phase === 'bobble'));
      f.el.classList.toggle('fv-hold', f === holder && phase !== 'throw');
      const diving = f.dive && t < f.dive.until + 0.5;
      f.el.classList.toggle('fv-dive', !!diving);
      f.el.classList.toggle('fv-dive-l', !!(diving && f.dive.dx < 0));
      f.el.classList.toggle('fv-down', t < f.downUntil);
      // 構え・ポーズ
      let pose = '';
      let look = pbView.X;
      if (phase === 'live' && t < f.react) pose = 'fv-ready';
      if ((phase === 'live' || phase === 'bobble') && !f.moving && !diving && f.role === 'cover') pose = 'fv-ready';
      if (phase === 'live' && (f.role === 'chase' || f === user || f.role === 'backup') && !diving) {
        const d = Math.hypot(b.x - f.x, b.y - f.y);
        if (inAirAt(t)) { if (d < 4 && b.z < 10) pose = 'fv-high'; } else if (d < 4.5 && b.z < 1.2) pose = 'fv-low';
      }
      if (f === holder && f.catchAt != null && t - f.catchAt < 0.4) pose = f.catchPose;
      if ((phase === 'secured' || phase === 'bobble') && f !== holder && f.role === 'cover' && !f.moving) {
        pose = 'fv-target';
        if (holderP) { f.face = holderP.X < p.X ? 1 : -1; look = null; } // グラブ側を捕球者へ
      }
      if (f.throwAt != null && t - f.throwAt < 0.45) {
        pose = OUTFIELD.includes(f.pos) ? 'fv-crow' : 'fv-throw';
        if (throwInfo) look = project(throwInfo.to.x, throwInfo.to.y).X;
      }
      if (throwInfo && f === recv) {
        const k = (t - throwInfo.start) / throwInfo.dur;
        pose = k > 0.45 ? 'fv-stretch' : 'fv-target';
        // グラブ側（左）を送球の来る方へ
        f.face = thrower.X < p.X ? 1 : -1; look = null;
      }
      if (f.recvAt != null && t - f.recvAt < 0.35 && f === holder) pose = 'fv-stretch';
      if (diving || t < f.downUntil) pose = '';
      setPose(f.el, pose);
      if (look === null) { f._sx = p.X; f._sy = p.Y; f.el.style.setProperty('--face', String(f.face)); f.el.classList.remove('fv-back'); }
      else faceTok(f, p, look);
    }
    for (const r of runners) {
      if (r.gone) {
        if (r.scored) { r.el.style.opacity = '0'; continue; }
        // アウトになった走者は「OUT」タグを付けて薄くなる
        if (!r.el.classList.contains('fv-out')) { r.el.classList.add('fv-out'); r.el.classList.remove('fv-run'); }
        continue;
      }
      const o = runnerOffset(r);
      const xy = runnerXY(r);
      const p = placeTok(r.el, xy.x + o.x, xy.y + o.y, 0.95);
      r.el.classList.toggle('fv-run', r.moving && !reduceMotion);
      const remain = (r.goal - r.p) * BASE_LEN;
      const sliding = !!r.slide && ((r.moving && remain > 0 && remain < 2.6) || (r.reachedAt != null && t - r.reachedAt < 0.9 && Math.abs(r.goal - r.p) < 1e-3));
      r.el.classList.toggle('fv-slide', sliding);
      if (sliding) r.el.classList.remove('fv-run');
      faceTok(r, p, null);
    }
    // ボール
    const ps = project(b.x, b.y, 0);
    const pb = pbView;
    const bk = (0.55 + 0.6 * ps.s) * viewZoom();
    dom.ball.style.transform = `translate(${pb.X.toFixed(1)}px,${pb.Y.toFixed(1)}px) scale(${bk.toFixed(3)})`;
    const bz = b.z > 0.6 ? 2000 : 100 + Math.round(ps.Y) + 1;
    dom.ball.style.zIndex = String(bz);
    const held2 = holder && !throwInfo;
    const shK = clamp(1 - b.z / 50, 0.6, 1) * bk;
    dom.shadow.style.transform = `translate(${ps.X.toFixed(1)}px,${ps.Y.toFixed(1)}px) scale(${shK.toFixed(3)})`;
    dom.shadow.style.zIndex = String(100 + Math.round(ps.Y) - 1);
    dom.shadow.style.opacity = held2 ? '0' : String(clamp(0.95 - b.z / 80, 0.5, 0.95));
    // 残像（速い打球・送球のみ）
    const trailOn = !reduceMotion && (phase === 'hr' || !held2);
    const posAt = (dt2) => (throwInfo ? throwPos(Math.max(throwInfo.start, t - dt2)) : ballAt(Math.max(P0, t - dt2)));
    let lastP = pb;
    dom.trail.forEach((el, i) => {
      if (!trailOn || (phase !== 'live' && phase !== 'throw' && phase !== 'hr')) { el.style.opacity = '0'; return; }
      const q2 = posAt(0.035 * (i + 1));
      const pq = project(q2.x, q2.y, q2.z);
      const gap = Math.hypot(pq.X - lastP.X, pq.Y - lastP.Y);
      lastP = pq;
      el.style.transform = `translate(${pq.X.toFixed(1)}px,${pq.Y.toFixed(1)}px) scale(${(bk * (0.9 - i * 0.18)).toFixed(3)})`;
      el.style.zIndex = String(bz - 1);
      el.style.opacity = gap > 2.5 ? String(0.45 - i * 0.13) : '0';
    });
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
      const n = Number(m.dataset.base);
      m.classList.toggle('show', showBases);
      m.classList.toggle('on', showBases && n === selBase);
      m.classList.toggle('tgt', !showBases && !!throwInfo && n === throwInfo.base);
    });
    // 自動送球までの残り時間（プロンプト下のバー）
    if (dom.prompt && userControlled && phase === 'secured') {
      const wait = assistMode ? AUTO_THROW_REAL_S * SLOW_SECURED : AUTO_THROW_S;
      dom.prompt.style.setProperty('--auto', String(clamp(1 - (t - securedAt) / wait, 0, 1).toFixed(3)));
    }
    if (dom.who) dom.who.textContent = user && userControlled ? `${user.pos} ${user.name}` : '';
    // 塁審（塁のそばに立ち、塁の方を向く）
    if (ump.el && ump.base) {
      const B = BASES[ump.base], o = UMP_OFFSET[ump.base];
      const p = placeTok(ump.el, B.x + o.x, B.y + o.y, 1.2);
      ump.el.style.setProperty('--face', String(project(B.x, B.y).X < p.X ? -1 : 1));
    }
    root.classList.toggle('fv-slow', closeSlowNow());
  }

  /** 際どい判定の瞬間か（スロー再生の区間。prefers-reduced-motion では常に false） */
  function closeSlowNow() {
    if (reduceMotion || phase === 'done') return false;
    return closes.some((c) => t >= c.at - CLOSE_PRE && t <= c.at + CLOSE_POST);
  }

  function throwPos(at = t) {
    const { from, to, start, dur } = throwInfo;
    const k = clamp((at - start) / dur, 0, 1);
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const arc = Math.min(5, 0.6 + d * 0.042); // 見た目の山なり（所要時間は throwInfo.dur のまま）
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
      if (r.backTo != null && r.goal !== r.backTo && Math.abs(r.p - r.backTo) < 1e-4) r.backTo = null;
      const d = r.goal - r.p;
      if (Math.abs(d) < 1e-4) {
        r.moving = false;
        if (r.backTo == null && r.next) { r.goal = r.next.goal; r.arrAt = r.next.arrAt; r.next = null; }
        continue;
      }
      const prevBase = Math.floor(r.p + 1e-6);
      // エンジンの到達時刻に合わせた速さ（判定と見た目を一致させる）
      let v = r.speed;
      if (r.arrAt != null && d > 0) v = clamp((Math.abs(d) * BASE_LEN) / Math.max(dt, r.arrAt - t), 1.5, 14);
      const step = Math.min(Math.abs(d), (v / BASE_LEN) * dt) * Math.sign(d);
      r.p += step;
      r.moving = true;
      // 塁に到達したら進塁を判断
      if (Math.floor(r.p + 1e-6) > prevBase || Math.abs(r.goal - r.p) < 1e-4) {
        const at = Math.round(r.p);
        if (Math.abs(r.goal - r.p) < 1e-4) r.reachedAt = t; // 見た目用（スライディングの余韻）
        if (Math.abs(r.p - at) < 1e-3 && at >= 4) { r.scored = true; r.gone = true; continue; }
        if (Math.abs(r.goal - r.p) < 1e-4 && Number.isInteger(r.goal) && phase === 'live' && !isHR && !holder) {
          const ballD = Math.hypot(ballAt(t).x, ballAt(t).y);
          const spare = primaryEta - t;
          const caughtPossible = inAirAt(t);
          if (!caughtPossible && ballD > 45 && spare > 1.6 && r.goal < 4) r.goal += 1;
        }
        // 見た目用: 打者走者が一塁で止まるなら駆け抜け（内野の打球）／オーバーラン（外野の打球）
        if (r.isBatter && r.thruAt == null && Math.abs(r.p - 1) < 1e-3 && r.goal <= 1 + 1e-3) {
          r.thruAt = t;
          r.thruInf = holder ? INFIELD.includes(holder.pos) : Math.hypot(landing.x, landing.y) < 40;
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
    const error = forced ? !!forced.error : Math.random() < errP;
    const caughtInAir = forced ? !!forced.caughtInAir && !error : air && !error;
    result = {
      caughtInAir, fielderId: f.id, fieldedAt: { x: round2(f.x), y: round2(f.y) },
      fieldTime: forced ? Number(forced.fieldTime) : round2(t + (error ? 0.7 : 0)), throwTo: null, throwTime: null, error, diving,
      throwStartAt: null, throwArriveAt: null,
    };
    f.moving = false;
    f.catchAt = t; f.catchPose = air ? 'fv-high' : 'fv-low'; // 見た目用
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

  /** エンジンの判定（previewPlay）どおりに走者の目標塁と到達時刻を合わせる */
  function syncRunners(pv) {
    if (!pv?.runners) return;
    for (const pr of pv.runners) {
      const r = runners.find((x) => (pr.isBatter ? x.isBatter : !x.isBatter && x.origin === pr.from));
      if (!r || r.gone) continue;
      if (pr.isBatter && pv.caught) { r.gone = true; continue; }
      const goal = clamp(pr.target, 0, 4);
      const arrAt = pr.arr?.[goal];
      r.startAt = Math.min(r.startAt, t);
      if (pv.caught && !pr.isBatter && r.p > r.origin + 1e-3) {
        // タッチアップ: いったん帰塁してから次の塁へ
        r.backTo = r.origin; r.goal = r.origin; r.arrAt = null;
        r.next = goal > r.origin ? { goal, arrAt } : null;
      } else {
        r.goal = goal; r.arrAt = goal > r.p + 1e-3 && arrAt != null ? arrAt : null; r.next = null;
      }
    }
  }

  function fieldingNow(extra = {}) {
    return { ...result, ...extra };
  }

  function enterSecured() {
    phase = 'secured';
    securedAt = t;
    if (judge && result) syncRunners(safeCall(judge, fieldingNow({ throwTo: null, throwTime: null, throwArriveAt: null })));
    const sug = engSuggest && result && !result.error ? safeCall(engSuggest, fieldingNow({ throwTo: undefined })) : undefined;
    selBase = sug !== undefined && sug !== null ? sug : sug === null ? null : smartBase();
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
    const eng = engThrowTime ? Number(safeCall(engThrowTime, holder.id, from, base)) : NaN;
    const dur = Math.max(0.15, Number.isFinite(eng) && eng > 0 ? eng : dist(from, to) / throwSpeed(holder));
    throwInfo = { from, to, base, start: t, dur };
    result.throwTime = round2(dur);
    result.throwStartAt = round2(t);
    result.throwArriveAt = round2((forced ? Number(forced.fieldTime) : t) + dur);
    verdict = judge ? safeCall(judge, fieldingNow()) : null;
    if (verdict) syncRunners(verdict);
    // 見た目用: 投げる動作、際どいタイミングの走者はスライディング
    holder.throwAt = t;
    for (const r of runners) {
      if (r.gone || (r.next?.goal ?? r.goal) !== base || (r.isBatter && base === 1)) continue;
      const arr = r.arrAt ?? r.next?.arrAt;
      if (arr != null && Math.abs(arr - result.throwArriveAt) < 0.45) r.slide = true;
    }
    findCloses(base);
    phase = 'throw';
    play('swing');
    setPrompt();
  }

  /**
   * 際どい判定を探す（見た目のみ）: 送球先の塁で、走者の到達と送球の到達（判定と同じ verdict.arrive）の差が CLOSE_S 未満。
   * 併殺の一塁転送（verdict.relay）も同じ。判定そのもの（out）は verdict のまま
   */
  function findCloses(base) {
    closes.length = 0;
    if (!verdict?.runners) return;
    const arrive = Number.isFinite(verdict.arrive) ? verdict.arrive : result?.throwArriveAt;
    const caughtBatter = (pr) => verdict.caught && pr.isBatter;
    const cands = verdict.runners.filter((pr) => pr.target === base && pr.target > pr.from && !caughtBatter(pr));
    const pr = cands.find((x) => x.out) || cands[0];
    const ra = pr ? Number(pr.arr?.[base]) : NaN;
    if (pr && Number.isFinite(ra) && Number.isFinite(arrive) && Math.abs(ra - arrive) < CLOSE_S) {
      closes.push({ base, at: arrive, out: !!pr.out });
      umpWatch(base);
    }
    if (verdict.relay && Number.isFinite(verdict.relay.arrive)) {
      const br = verdict.runners.find((x) => x.isBatter);
      const ba = br ? Number(br.arr?.[1]) : NaN;
      if (Number.isFinite(ba) && Math.abs(ba - verdict.relay.arrive) < CLOSE_S) {
        closes.push({ base: 1, at: verdict.relay.arrive, out: !!verdict.relay.out });
        if (closes.length === 1) umpWatch(1);
      }
    }
  }

  /** 判定のコール。際どい判定なら塁審のジェスチャーの後に文字を出す */
  function judgeCall(base, text, cls, out) {
    const c = closes.find((x) => x.base === base && !x.called);
    if (!c) { callout(text, cls); return; }
    c.called = true;
    umpCall(base, out);
    later(() => callout(text, cls), CLOSE_CALL_DELAY);
  }

  function finishSoon(delay) {
    phase = 'after';
    doneAt = t + delay;
    setPrompt();
  }

  function step(dt) {
    t += dt;
    for (let i = timers.length - 1; i >= 0; i--) {
      if (t >= timers[i].at) { const fn = timers[i].fn; timers.splice(i, 1); try { fn(); } catch (e) { console.warn(e); } }
    }
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
      if (phase === 'live' && f === user && userControlled && assistMode && !autoAll) {
        if (t >= f.react) moveToward(f, intercept(f, t), dt); else f.moving = false; // おまかせ: 最短で打球へ
        continue;
      }
      if (phase === 'live' && f === user && userControlled && !autoAll) {
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
      if (forced) {
        const f = fielders.find((g) => g.id === forced.fielderId);
        if (f && t >= forced.fieldTime) {
          f.x = forced.fieldedAt?.x ?? b.x; f.y = forced.fieldedAt?.y ?? b.y; // 捕球位置へ（追いついている前提の微調整）
          secure(f, { retrieved: !forced.caughtInAir && t > PEND });
          return;
        }
      } else if (t > 0.25) {
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
        const cands = fielders.filter((f) => f !== user || !userControlled || autoAll);
        cands.sort((a, c) => Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(b.x - c.x, b.y - c.y));
        cands.slice(0, 2).forEach((f) => { f.role = 'retrieve'; });
      }
      if (t > MAX_SIM_S && !forced) {
        const n = fielders.slice().sort((a, c) => Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
        if (n) { n.x = b.x; n.y = b.y; secure(n, { retrieved: true }); }
      }
    } else if (phase === 'bobble') {
      if (t >= bobbleUntil) enterSecured();
    } else if (phase === 'secured') {
      const wait = forced ? 0 : !userControlled || autoAll ? CPU_HOLD_S : assistMode ? AUTO_THROW_REAL_S * SLOW_SECURED : AUTO_THROW_S;
      if (t - securedAt >= wait) doThrow(forced ? forced.throwTo ?? null : userControlled ? (autoAll ? selBase ?? smartBase() : selBase) : smartBase());
    } else if (phase === 'throw') {
      if (t >= throwInfo.start + throwInfo.dur) {
        const recv = fielders.filter((f) => f !== holder).sort((a, c) => dist(a, throwInfo.to) - dist(c, throwInfo.to))[0];
        play('catch');
        if (recv) { holder = recv; recv.recvAt = t; }
        const base = throwInfo.base;
        throwInfo = null;
        let wait = 0.45;
        if (verdict) {
          // 送球先の塁のアウト／セーフ（エンジンの判定と同じ）
          const caughtBatter = (pr) => verdict.caught && pr.isBatter;
          const victim = verdict.runners.find((pr) => pr.out && pr.target === base && !caughtBatter(pr));
          const contested = verdict.runners.some((pr) => pr.target === base && pr.target > pr.from && !caughtBatter(pr));
          if (victim) {
            judgeCall(base, 'アウト！', 'good', true);
            const r = runners.find((x) => (victim.isBatter ? x.isBatter : !x.isBatter && x.origin === victim.from));
            if (r) later(() => { r.gone = true; }, 0.35);
          } else if (contested) judgeCall(base, 'セーフ！', 'bad', false);
          if (verdict.relay) {
            wait = Math.max(wait, verdict.relay.arrive - t + 0.6);
            if (verdict.relay.out) {
              const br = runners.find((x) => x.isBatter);
              later(() => { judgeCall(1, 'ゲッツー！', 'good', true); if (br) br.gone = true; }, Math.max(0, verdict.relay.arrive - t));
            } else later(() => judgeCall(1, '一塁セーフ！', 'bad', false), Math.max(0, verdict.relay.arrive - t));
          }
        }
        finishSoon(wait);
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
    // 際どい判定の瞬間はさらにスロー（見た目のみ。シミュレーションの刻みは同じなので判定は変わらない）
    let acc = dtReal * timeScale * (slowSecured && phase === 'secured' ? SLOW_SECURED : 1) * (closeSlowNow() ? CLOSE_SLOW : 1);
    while (acc > 1e-6 && phase !== 'done') {
      const d = Math.min(DT, acc);
      step(d);
      acc -= d;
    }
    render();
    if (phase === 'done') { finish(); rafId = 0; return; }
    rafId = requestAnimationFrame(frame);
  }

  /** スキップ（S キー / スキップボタン）: ユーザー守備でも残りを CPU 守備に任せて結果まで進める */
  function skipNow() {
    if (calledDone) return;
    if (userControlled && !isHR && !autoAll) {
      autoAll = true;
      if (user && user.role === 'user') user.role = 'chase';
    }
    skipToEnd();
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
    if (isDown && (key === 'skip' || key === 'steal')) { skipNow(); return; }
    if (destroyed) return;
    if (isDown && userControlled && phase === 'secured' && /^base[1-4]$/.test(key)) {
      selBase = Number(key.slice(-1)); doThrow(selBase); return;
    }
    if (key in held) {
      held[key] = !!isDown;
      if (isDown && userControlled && phase === 'secured' && KEY_BASE[key]) {
        selBase = KEY_BASE[key];
        // 選択後は少し待つ（assist は実時間 0.6 秒）
        securedAt = assistMode ? Math.max(securedAt, t - (AUTO_THROW_REAL_S - 0.6) * SLOW_SECURED) : Math.max(securedAt, t - AUTO_THROW_S + 0.6);
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
    if (assistMode && phase === 'live') return; // おまかせ: 捕るまでは操作なし
    if (key === 'x') switchFielder();
    else if (key === 'z' || key === 'enter') {
      if (phase === 'live' && key === 'z') tryDive();
      else if (phase === 'secured') doThrow(selBase ?? smartBase());
    }
  }

  // ---------- 初期化 ----------
  assignRoles();
  if (forced) {
    for (const f of fielders) {
      if (f.id === forced.fielderId) f.role = 'chase';
      else if (f.role === 'chase') f.role = 'backup';
    }
  }
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
        aim: user ? intercept(user, t, 0) : null, holder: holder && holder.pos, selBase, result,
        closes: closes.map((c) => ({ ...c })), slow: closeSlowNow(), ump: ump.call };
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
