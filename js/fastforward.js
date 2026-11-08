/**
 * 守備オートの早送り画面（オリジナル）。
 * ユーザーの守備の半イニングを CPU 投手・CPU 打者・CPU 守備（autoField）で 1 球ずつ進め、
 * 簡略化した画面（真上から見たミニダイヤモンド・スコアボード・カウント・実況ログ）で素早く見せる。
 *
 * ---- DOM なしの中核（node で動く。tests/fastforward.test.mjs） ----
 * stepPitch(engine, state, rng, opts?) → Step
 *   1 球ぶん進める: [opts.manage] → choosePitch → pitchLocation → chooseSwing → pitchContact
 *   → 打球なら autoField → resolveBattedBall（打球 1 つにつき成功 1 回だけ）。返す state に pending は残らない。
 *   Step = { prev, state, pitch, swing, event, contact, ball, fielding, subs[], steals[], newLog[], resolves,
 *            paEnded, endHalf, over }
 * simulateHalf(engine, state, rng, opts?) → Generator<Step>
 *   state の攻撃側が変わる（3 アウト）か試合終了まで 1 球ずつ yield。opts.shouldStop(step) が true なら次の球の前で止まる。
 * runHalf(engine, state, rng, opts?) → { state, steps, reason: 'halfEnd'|'gameOver'|'stopped'|'limit' }
 * isUserDefending(engine, state, userSide?) → boolean
 *
 * ---- 画面 ----
 * createFastForward(container, { engine, state, rng, speed = 2, userSide, onPlay, onDone, sound, manage, autoStart = true })
 *   → { start(), handleKey(key) → boolean, setSpeed(2|4|'end'), requestNormal(), destroy(), getState(), el }
 *   onPlay(event, state, step) : 1 球ごと（state は pending なし・その球の処理後）
 *   onDone(state, { reason: 'halfEnd'|'gameOver'|'normal'|'notDefending'|'error'|'limit', steps, error? })
 *     'normal' = 「ふつうに見る」（投球と投球の間で止まる。同じ半イニングの続きを通常画面で）
 *   key: 'z'|'enter'（はやく: ×2 → ×4 → 結果まで）| 'esc'|'x'（ふつうに見る）
 *   manage(state) → state|null : 投球前の采配（ユーザー側の自動継投など。game.js から注入。省略可）
 *   sound: { play(name) }（省略可）
 * engine は js/engine.js の名前空間（または同じ関数を持つオブジェクト）を注入する。このモジュールは engine.js を import しない。
 */

export const FF_SPEEDS = [2, 4, 'end'];
const MAX_PITCHES_PER_HALF = 400;
const NON_PA = ['ball', 'strike', 'foul', 'none', 'inplay'];
const STEAL_KINDS = ['steal', 'caught_stealing'];

/* ======================================================================== */
/* 中核（DOM 非依存）                                                         */
/* ======================================================================== */

/** 攻撃側 'away'|'home' */
export function battingSide(engine, state) {
  if (typeof engine.battingSideOf === 'function') {
    try { const s = engine.battingSideOf(state); if (s === 'away' || s === 'home') return s; } catch (e) { /* fall back */ }
  }
  return state.half === 'top' ? 'away' : 'home';
}
const other = (side) => (side === 'away' ? 'home' : 'away');

/** ユーザーが守備中か（試合終了・打球処理中は false） */
export function isUserDefending(engine, state, userSide = state?.userSide || 'away') {
  if (!state || state.pending || engine.isGameOver(state)) return false;
  return battingSide(engine, state) !== userSide;
}

/** 打席が終わった（カウント以外の結果が出た）event か */
export function isPaEnd(event) {
  return !!event && !NON_PA.includes(event.kind);
}

/**
 * 1 球進める（CPU 投手 × CPU 打者 × CPU 守備）。
 * @returns {object} Step（上のコメント参照）
 */
export function stepPitch(engine, state, rng = Math.random, opts = {}) {
  if (!state) throw new Error('fastforward: state がありません');
  if (state.pending) throw new Error('fastforward: 打球の処理中の state では進められません');
  const prev = state;
  const logStart = (state.log || []).length;
  let s = state;
  if (typeof opts.manage === 'function') {
    const m = opts.manage(s);
    if (m && typeof m === 'object' && m !== s) s = m;
  }
  let pitch = engine.choosePitch(s, rng);
  if (!pitch) throw new Error('fastforward: choosePitch が投球を返しませんでした');
  if (!pitch.intentional && typeof engine.pitchLocation === 'function') {
    const loc = engine.pitchLocation(s, pitch, rng);
    if (loc && Number.isFinite(Number(loc.x))) pitch = { ...pitch, loc };
  }
  const swing = pitch.intentional ? null : (engine.chooseSwing(s, pitch, rng) || null);
  const r = engine.pitchContact(s, pitch, swing, rng);
  let next = r.state;
  let event = r.event;
  let fielding = null;
  let resolves = 0;
  if (r.ball && !r.ball.isHomeRun && next.pending) {
    // 打球 1 つにつき resolveBattedBall の成功は 1 回だけ。例外（state は変わらない）のときだけ守備をやり直す
    let out = null;
    let lastErr = null;
    for (let i = 0; i < 3 && !out; i++) {
      try {
        fielding = engine.autoField(next, r.ball, rng);
        out = engine.resolveBattedBall(next, r.ball, fielding, rng);
      } catch (e) { lastErr = e; }
    }
    if (!out) throw lastErr || new Error('fastforward: resolveBattedBall に失敗しました');
    resolves = 1;
    next = out.state;
    event = out.event;
  }
  const newLog = (next.log || []).slice(logStart);
  const subs = newLog.filter((e) => e && e.kind === 'sub');
  const seen = new Set();
  const steals = [];
  for (const e of [...newLog, event?.steal].filter(Boolean)) {
    if (!STEAL_KINDS.includes(e.kind) || !e.text || seen.has(e.text) || e === event) continue;
    seen.add(e.text);
    steals.push(e);
  }
  const over = !!engine.isGameOver(next);
  return {
    prev, state: next, pitch, swing, event, contact: r.event, ball: r.ball || null,
    fielding: event?.fielding || fielding, subs, steals, newLog, resolves,
    paEnded: isPaEnd(event), endHalf: over || battingSide(engine, next) !== battingSide(engine, s), over,
  };
}

/** 半イニングの終わり（攻撃側が変わる・試合終了）まで 1 球ずつ yield */
export function* simulateHalf(engine, state, rng = Math.random, opts = {}) {
  let s = state;
  const side = battingSide(engine, s);
  const max = opts.maxPitches ?? MAX_PITCHES_PER_HALF;
  for (let n = 0; n < max; n++) {
    if (engine.isGameOver(s) || battingSide(engine, s) !== side) return;
    const step = stepPitch(engine, s, rng, opts);
    s = step.state;
    yield step;
    if (step.endHalf) return;
    if (typeof opts.shouldStop === 'function' && opts.shouldStop(step)) return;
  }
}

/** 半イニングを最後まで（または shouldStop まで）進める */
export function runHalf(engine, state, rng = Math.random, opts = {}) {
  const steps = [];
  let s = state;
  let stopped = false;
  const shouldStop = (st) => { const v = !!opts.shouldStop?.(st); if (v) stopped = true; return v; };
  for (const step of simulateHalf(engine, state, rng, { ...opts, shouldStop })) { steps.push(step); s = step.state; }
  const last = steps[steps.length - 1];
  const reason = engine.isGameOver(s) ? 'gameOver' : last?.endHalf ? 'halfEnd' : stopped ? 'stopped' : 'limit';
  return { state: s, steps, reason };
}

/* ======================================================================== */
/* 表示用ヘルパー                                                             */
/* ======================================================================== */

const POS_FALLBACK = {
  投: { x: 0, y: 18.4 }, 捕: { x: 0, y: -1.5 }, 一: { x: 17, y: 25 }, 二: { x: 11, y: 38 }, 三: { x: -17, y: 25 },
  遊: { x: -11, y: 38 }, 左: { x: -28, y: 80 }, 中: { x: 0, y: 92 }, 右: { x: 28, y: 80 },
};
const BASE_XY = { 0: { x: 0, y: 0 }, 1: { x: 19.4, y: 19.4 }, 2: { x: 0, y: 38.8 }, 3: { x: -19.4, y: 19.4 }, 4: { x: 0, y: 0 } };
const PITCH_NAMES = {
  fastball: 'ストレート', twoseam: 'ツーシーム', cutter: 'カット', slider: 'スライダー', curve: 'カーブ', fork: 'フォーク',
  splitter: 'スプリット', palm: 'パーム', shoot: 'シュート', sinker: 'シンカー', changeup: 'チェンジアップ',
};

/** 結果のラベルと色クラス */
export function resultLabel(event) {
  if (!event) return null;
  const k = event.kind;
  const b = Number(event.bases) || 0;
  switch (k) {
    case 'hit': return { text: b >= 3 ? 'スリーベース' : b === 2 ? 'ツーベース' : 'ヒット', cls: 'hit' };
    case 'hr': return { text: 'ホームラン', cls: 'hr' };
    case 'out': return { text: 'アウト', cls: 'out' };
    case 'double_play': return { text: 'ゲッツー', cls: 'out' };
    case 'sac_fly': return { text: '犠牲フライ', cls: 'out' };
    case 'sac_bunt': return { text: '送りバント', cls: 'out' };
    case 'fielders_choice': return { text: 'フィルダースチョイス', cls: 'hit' };
    case 'error': return { text: 'エラー', cls: 'hit' };
    case 'strikeout': return { text: '三振', cls: 'k' };
    case 'walk': return { text: 'フォアボール', cls: 'walk' };
    case 'hbp': return { text: 'デッドボール', cls: 'walk' };
    case 'ibb': return { text: '敬遠', cls: 'walk' };
    case 'steal': return { text: '盗塁成功', cls: 'hit' };
    case 'caught_stealing': return { text: '盗塁死', cls: 'out' };
    default: return null;
  }
}

/** 1 球の短い説明（「カーブ 118km/h ボール」） */
export function pitchLine(event) {
  const p = event?.pitch;
  if (!p?.type) return event?.kind === 'ibb' ? '申告敬遠' : '';
  const kmh = Number(p.kmh);
  const res = { ball: 'ボール', strike: 'ストライク', foul: 'ファウル', walk: 'ボール', strikeout: 'ストライク', hbp: 'デッドボール' }[event.kind]
    || (event.ball || event.fielding ? 'インプレー' : '');
  return `${PITCH_NAMES[p.type] || p.type}${kmh > 60 ? ` ${Math.round(kmh)}km/h` : ''}${res ? `　${res}` : ''}`;
}

/** 実況ログに出す行（steals → 打席結果 → 交代）。{ text, cls, runs } */
export function logLines(step) {
  const out = [];
  for (const st of step.steals || []) out.push({ text: st.text, cls: st.kind === 'steal' ? 'hit' : 'out', runs: 0 });
  const ev = step.event;
  const notable = isPaEnd(ev) || (ev?.runs > 0) || ev?.wildPitch;
  if (ev && notable && ev.text && !STEAL_KINDS.includes(ev.kind)) {
    out.push({ text: ev.text, cls: resultLabel(ev)?.cls || (ev.runs > 0 ? 'hit' : 'pitch'), runs: Number(ev.runs) || 0 });
  } else if (ev && STEAL_KINDS.includes(ev.kind) && ev.text && !out.some((l) => l.text === ev.text)) {
    out.push({ text: ev.text, cls: ev.kind === 'steal' ? 'hit' : 'out', runs: Number(ev.runs) || 0 });
  }
  for (const s of step.subs || []) out.push({ text: s.text || '選手交代', cls: 'sub', runs: 0 });
  return out;
}

/* ======================================================================== */
/* 画面                                                                       */
/* ======================================================================== */

// ミニダイヤモンドの座標（box 内 px）: 本塁 (BOX_W/2, HOME_Y)、1m = K px
const BOX_W = 600;
const BOX_H = 500;
const HOME_Y = 456;
const K = 3.5;
const toBox = (p) => ({ x: BOX_W / 2 + Number(p.x || 0) * K, y: HOME_Y - Number(p.y || 0) * K });
// 1 倍速の基準時間（ms）。表示時間 = 基準 / 倍率
const BASE_MS = { pitch: 720, pa: 1300, hold: 900, sub: 1100, change: 1500, steal: 500 };
const FLIGHT_CAP_MS = 2600; // 打球の飛行アニメの上限（1 倍速）

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fieldSvg() {
  const h = toBox({ x: 0, y: 0 });
  const b1 = toBox(BASE_XY[1]); const b2 = toBox(BASE_XY[2]); const b3 = toBox(BASE_XY[3]);
  const lf = toBox({ x: -69.3, y: 69.3 }); const rf = toBox({ x: 69.3, y: 69.3 });
  const cf = toBox({ x: 0, y: 122 });
  // フェンス: 両翼 98m・中堅 122m を通る 2 次ベジェ（中間の制御点）
  const ctrl = { x: BOX_W / 2, y: 2 * cf.y - (lf.y + rf.y) / 2 };
  const dirt = (r) => { const a = toBox({ x: -r * 0.7071, y: r * 0.7071 }); const c = toBox({ x: r * 0.7071, y: r * 0.7071 }); return `M${h.x},${h.y} L${a.x},${a.y} Q${BOX_W / 2},${toBox({ x: 0, y: r * 1.25 }).y} ${c.x},${c.y} Z`; };
  const mound = toBox({ x: 0, y: 18.4 });
  return `<svg class="ff-field-svg" viewBox="0 0 ${BOX_W} ${BOX_H}" width="${BOX_W}" height="${BOX_H}" aria-hidden="true">
    <path d="M${h.x},${h.y} L${lf.x},${lf.y} Q${ctrl.x},${ctrl.y} ${rf.x},${rf.y} Z" class="ff-grass"/>
    <path d="${dirt(44)}" class="ff-dirt"/>
    <path d="M${h.x},${h.y} L${b1.x},${b1.y} L${b2.x},${b2.y} L${b3.x},${b3.y} Z" class="ff-infield"/>
    <path d="M${lf.x},${lf.y} Q${ctrl.x},${ctrl.y} ${rf.x},${rf.y}" class="ff-fence"/>
    <line x1="${h.x}" y1="${h.y}" x2="${lf.x}" y2="${lf.y}" class="ff-foul"/>
    <line x1="${h.x}" y1="${h.y}" x2="${rf.x}" y2="${rf.y}" class="ff-foul"/>
    <circle cx="${mound.x}" cy="${mound.y}" r="9" class="ff-mound"/>
    ${[b1, b2, b3].map((b) => `<rect x="${b.x - 7}" y="${b.y - 7}" width="14" height="14" transform="rotate(45 ${b.x} ${b.y})" class="ff-base"/>`).join('')}
    <path d="M${h.x - 7},${h.y - 4} h14 v6 l-7,6 l-7,-6 Z" class="ff-base"/>
    <polyline class="ff-traj" points=""/>
    <line class="ff-throw" x1="0" y1="0" x2="0" y2="0"/>
  </svg>`;
}

function template() {
  return `<div class="ff" role="region" aria-label="早送り">
    <div class="ff-top">
      <div class="ff-badge"><span class="ff-arrows" aria-hidden="true">▶▶</span><b>早送り</b><span class="ff-speed-now" data-ff="speedNow">×2</span></div>
      <div class="ff-inning" data-ff="inning"></div>
      <div class="ff-matchup">
        <div class="ff-mu"><span class="ff-tag p">投</span><b data-ff="pitcher"></b><span class="ff-sub" data-ff="pcount"></span><i class="ff-stam"><i data-ff="stam"></i></i></div>
        <div class="ff-mu"><span class="ff-tag b">打</span><b data-ff="batter"></b><span class="ff-sub" data-ff="bline"></span></div>
      </div>
    </div>
    <div class="ff-main">
      <div class="ff-diamond" style="width:${BOX_W}px;height:${BOX_H}px">
        ${fieldSvg()}
        <div class="ff-fielders" data-ff="fielders"></div>
        <div class="ff-runners" data-ff="runners"></div>
        <div class="ff-ball" data-ff="ball"></div>
        <div class="ff-callout" data-ff="callout"></div>
        <div class="ff-runs" data-ff="runs"></div>
        <div class="ff-banner" data-ff="banner"></div>
      </div>
      <div class="ff-side">
        <table class="ff-line" data-ff="line"></table>
        <div class="ff-countrow">
          <div class="ff-count" data-ff="count"></div>
          <div class="ff-lastpitch" data-ff="lastpitch"></div>
        </div>
        <ol class="ff-log" data-ff="log" data-scroll aria-live="polite"></ol>
      </div>
    </div>
    <div class="ff-bar">
      <div class="ff-speeds" role="group" aria-label="はやさ">
        <button type="button" class="ff-btn" data-speed="2" aria-pressed="false">×2</button>
        <button type="button" class="ff-btn" data-speed="4" aria-pressed="false">×4</button>
        <button type="button" class="ff-btn ff-end" data-speed="end" aria-pressed="false">この回の終わりまで</button>
      </div>
      <div class="ff-hint"><kbd>Z</kbd>はやく　<kbd>Esc</kbd>ふつうに見る</div>
      <button type="button" class="ff-btn ff-normal" data-act="normal">ふつうに見る</button>
    </div>
  </div>`;
}

export function createFastForward(container, opts = {}) {
  const { engine } = opts;
  if (!engine) throw new Error('fastforward: engine がありません');
  if (!container) throw new Error('fastforward: container がありません');
  const rng = opts.rng || Math.random;
  const userSide = opts.userSide || opts.state?.userSide || 'away';
  let state = opts.state;
  let speed = FF_SPEEDS.includes(opts.speed) ? opts.speed : 2;
  let destroyed = false;
  let started = false;
  let finished = false;
  let wantNormal = false;
  let timer = 0;
  let raf = 0;
  let steps = 0;
  const dom = {};

  const play = (name) => { if (destroyed) return; try { opts.sound?.play?.(name); } catch (e) { /* ignore */ } };
  let unlogged = null; // 計算済みで、まだログに出していない 1 球（打球アニメ中）
  const rate = () => (speed === 'end' ? 8 : speed);
  const ms = (base) => Math.round(base / rate());
  const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const wrap = document.createElement('div');
  wrap.innerHTML = template();
  const root = wrap.firstElementChild;
  container.appendChild(root);
  root.querySelectorAll('[data-ff]').forEach((n) => { dom[n.dataset.ff] = n; });
  dom.traj = root.querySelector('.ff-traj');
  dom.throwLine = root.querySelector('.ff-throw');
  const listeners = [];
  const on = (n, t, f) => { n.addEventListener(t, f); listeners.push([n, t, f]); };
  root.querySelectorAll('[data-speed]').forEach((b) => on(b, 'click', (e) => {
    e.preventDefault();
    const v = b.dataset.speed === 'end' ? 'end' : Number(b.dataset.speed);
    play('select');
    setSpeed(v);
  }));
  on(root.querySelector('[data-act="normal"]'), 'click', (e) => { e.preventDefault(); play('decide'); requestNormal(); });

  /* ---------- 描画 ---------- */
  const teamOf = (side) => state.teams?.[side] || {};
  const playerById = (id) => {
    for (const side of ['away', 'home']) {
      const p = teamOf(side).players?.find((x) => x.id === id);
      if (p) return p;
    }
    return null;
  };
  const posTable = () => engine.DEFAULT_POSITIONS || POS_FALLBACK;
  /** スコアボード用のチーム名（1 文字の略称より正式名を優先。長い名前は CSS で省略） */
  const short = (side) => { const t = teamOf(side); return (t.short && String(t.short).length >= 2 ? t.short : t.name) || t.short || side; };

  function renderLine(s = state) {
    const n = Math.max(Number(s.innings) || 9, s.score?.away?.length || 0, s.score?.home?.length || 0);
    const cur = s.inning - 1;
    const tot = (side) => (s.score?.[side] || []).reduce((a, b) => a + (Number(b) || 0), 0);
    const row = (side) => {
      const arr = s.score?.[side] || [];
      const cells = [];
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        const live = !s.over && i === cur && ((side === 'away') === (s.half === 'top'));
        cells.push(`<td class="${live ? 'live' : ''}">${v === undefined || v === null ? '' : v}</td>`);
      }
      const color = teamOf(side).color || '#888';
      return `<tr><th><i style="background:${escHtml(color)}"></i>${escHtml(short(side))}</th>${cells.join('')}<td class="r">${tot(side)}</td><td>${s.hits?.[side] ?? 0}</td><td>${s.errors?.[side] ?? 0}</td></tr>`;
    };
    const head = Array.from({ length: n }, (_, i) => `<td>${i + 1}</td>`).join('');
    dom.line.innerHTML = `<thead><tr><th></th>${head}<td class="r">R</td><td>H</td><td>E</td></tr></thead><tbody>${row('away')}${row('home')}</tbody>`;
    dom.line.classList.toggle('many', n > 9);
  }

  function renderCount(s = state, override = null) {
    const c = override || { b: s.balls ?? 0, s: s.strikes ?? 0, o: s.outs ?? 0 };
    const dots = (n, max, cls) => Array.from({ length: max }, (_, i) => `<i class="${i < n ? `on ${cls}` : ''}"></i>`).join('');
    dom.count.innerHTML = `<div><b>B</b>${dots(c.b, 3, 'g')}</div><div><b>S</b>${dots(c.s, 2, 'y')}</div><div><b>O</b>${dots(c.o, 2 + (c.o >= 3 ? 1 : 0), 'r')}</div>`;
  }

  function renderMatchup(s = state) {
    const p = engine.getPitcher(s);
    const b = engine.getBatter(s);
    dom.pitcher.textContent = p?.name || '';
    const pc = s.pitchesBy?.[p?.id] ?? 0;
    dom.pcount.textContent = `${pc}球`;
    const pct = Number(s.staminaPct?.[p?.id]);
    dom.stam.style.width = `${Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 100}%`;
    dom.stam.className = Number.isFinite(pct) && pct < 25 ? 'low' : '';
    const side = battingSide(engine, s);
    let slot = null;
    try { slot = engine.lineupView?.(s, side)?.find((l) => l.id === b?.id) || null; } catch (e) { /* ignore */ }
    dom.batter.textContent = `${slot ? `${slot.slot + 1}番 ` : ''}${b?.name || ''}`;
    const st = s.stats?.[b?.id];
    dom.bline.textContent = st ? `${st.ab}打数${st.h}安打` : '';
    const label = engine.summary?.(s)?.inningLabel || `${s.inning}回${s.half === 'top' ? '表' : '裏'}`;
    dom.inning.innerHTML = `<b>${escHtml(label)}</b><span>${escHtml(teamOf(side).name || '')}の攻撃</span>`;
  }

  function renderFielders(s = state, actor = null) {
    const fside = other(battingSide(engine, s));
    const posMap = s.positions?.[fside] || {};
    const byPos = {};
    for (const [id, pos] of Object.entries(posMap)) byPos[pos] = id;
    const tbl = posTable();
    dom.fielders.innerHTML = Object.keys(tbl).map((pos) => {
      const p = toBox(tbl[pos]);
      const id = byPos[pos] || '';
      return `<div class="ff-f" data-pos="${pos}" data-id="${escHtml(id)}" style="transform:translate(${p.x}px,${p.y}px)"><i></i><span>${pos}</span></div>`;
    }).join('');
    dom.fielders.style.setProperty('--team', teamOf(fside).color || '#1E88E5');
    if (actor) highlightFielder(actor);
  }

  function highlightFielder(pos) {
    dom.fielders.querySelectorAll('.ff-f').forEach((n) => n.classList.toggle('act', n.dataset.pos === pos));
  }

  function moveFielder(pos, to, durMs, name) {
    const n = dom.fielders.querySelector(`.ff-f[data-pos="${pos}"]`);
    if (!n) return;
    const p = toBox(to);
    n.getBoundingClientRect(); // 直前の innerHTML の位置から動かす
    n.classList.add('act');
    n.style.transition = `transform ${Math.max(0, durMs)}ms linear`;
    n.style.transform = `translate(${p.x}px,${p.y}px)`;
    const tag = n.querySelector('span');
    if (tag && name) tag.textContent = `${pos} ${name}`;
  }

  /** 走者（bases: [id|null]×3）。scored: 生還した走者 id */
  function renderRunners(s = state, { animate = false, scored = [], outs = [] } = {}) {
    const side = battingSide(engine, s);
    const color = teamOf(side).color || '#E5484D';
    dom.runners.style.setProperty('--team', color);
    const existing = new Map([...dom.runners.querySelectorAll('.ff-r')].map((n) => [n.dataset.id, n]));
    const want = new Map();
    (s.bases || []).forEach((id, i) => { if (id) want.set(id, i + 1); });
    const dur = animate && !reduceMotion() ? ms(BASE_MS.hold * 0.55) : 0;
    for (const [id, n] of existing) {
      if (want.has(id)) continue;
      n.style.transition = `transform ${dur}ms ease-out, opacity ${dur}ms ease-in`;
      if (scored.includes(id)) { const h = toBox(BASE_XY[4]); n.style.transform = `translate(${h.x}px,${h.y}px)`; n.classList.add('home'); }
      else if (outs.includes(id)) n.classList.add('out');
      n.style.opacity = '0';
      setTimeout(() => n.remove(), dur + 30);
    }
    for (const [id, base] of want) {
      let n = existing.get(id);
      const p = toBox(BASE_XY[base]);
      if (!n) {
        n = document.createElement('div');
        n.className = 'ff-r';
        n.dataset.id = id;
        n.innerHTML = `<i></i><span>${escHtml(playerById(id)?.name || '')}</span>`;
        const from = toBox(BASE_XY[Math.max(0, base - 1)]);
        n.style.transform = `translate(${(animate ? from : p).x}px,${(animate ? from : p).y}px)`;
        dom.runners.appendChild(n);
        n.getBoundingClientRect();
      }
      n.style.transition = `transform ${dur}ms ease-out`;
      n.style.transform = `translate(${p.x}px,${p.y}px)`;
    }
  }

  function callout(event) {
    const l = resultLabel(event);
    if (!l) { dom.callout.className = 'ff-callout'; return; }
    dom.callout.textContent = l.text;
    dom.callout.className = `ff-callout ${l.cls}`;
    void dom.callout.offsetWidth;
    dom.callout.classList.add('show');
  }

  function runsPop(n) {
    if (!(n > 0)) return;
    dom.runs.textContent = `+${n}点`;
    dom.runs.className = 'ff-runs';
    void dom.runs.offsetWidth;
    dom.runs.classList.add('show');
  }

  function banner(text, sub = '') {
    dom.banner.innerHTML = text ? `<b>${escHtml(text)}</b>${sub ? `<span>${escHtml(sub)}</span>` : ''}` : '';
    dom.banner.classList.toggle('show', !!text);
  }

  function addLog(lines, s) {
    if (!lines.length) return;
    const tag = `${s.inning}回 ${s.outs ?? 0}死`;
    for (const l of lines) {
      const li = document.createElement('li');
      li.className = `ff-l ${l.cls}`;
      li.innerHTML = `<em>${escHtml(l.cls === 'sub' ? '交代' : tag)}</em><span>${escHtml(l.text)}</span>${l.runs ? `<b class="ff-l-runs">+${l.runs}</b>` : ''}`;
      dom.log.appendChild(li);
    }
    while (dom.log.children.length > 60) dom.log.firstElementChild.remove();
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  function renderSpeed() {
    root.querySelectorAll('[data-speed]').forEach((b) => {
      const v = b.dataset.speed === 'end' ? 'end' : Number(b.dataset.speed);
      b.classList.toggle('on', v === speed);
      b.setAttribute('aria-pressed', String(v === speed));
    });
    dom.speedNow.textContent = speed === 'end' ? '回の終わりまで' : `×${speed}`;
    root.style.setProperty('--ff-rate', String(rate()));
    root.dataset.speed = String(speed);
  }

  function renderAll(s = state, countOverride = null) {
    renderLine(s);
    renderCount(s, countOverride);
    renderMatchup(s);
  }

  /* ---------- 打球アニメ ---------- */
  function clearBall() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    dom.ball.className = 'ff-ball';
    dom.traj.setAttribute('points', '');
    dom.traj.setAttribute('class', 'ff-traj');
    dom.throwLine.setAttribute('class', 'ff-throw');
  }

  /** 打球の飛行（ball.path を fieldTime まで）＋ 野手の移動 ＋ 送球線。戻り値 = 所要 ms */
  function animateBall(step) {
    const ball = step.ball;
    const f = step.fielding;
    if (!ball?.path?.length) return 0;
    const endT = f && Number.isFinite(Number(f.fieldTime)) && !ball.isHomeRun
      ? Math.min(Number(f.fieldTime), ball.endTime ?? Infinity) : (ball.endTime ?? ball.path[ball.path.length - 1].t);
    const realMs = Math.max(200, endT * 1000);
    const dur = reduceMotion() ? 0 : Math.min(realMs / rate(), FLIGHT_CAP_MS / rate());
    const pts = ball.path.filter((p) => p.t <= endT + 1e-6);
    const target = f?.fieldedAt || ball.landing || ball.rest;
    if (target && !ball.isHomeRun) pts.push({ t: endT, x: target.x, y: target.y, z: 0 });
    dom.traj.setAttribute('class', `ff-traj ${ball.type || ''}${ball.isHomeRun ? ' hr' : ''}`);
    const fpos = f?.fielderPos;
    if (fpos && target) moveFielder(fpos, target, dur, playerById(f.fielderId)?.name);
    const draw = (k) => {
      const tNow = endT * k;
      const seg = pts.filter((p) => p.t <= tNow);
      let last = seg[seg.length - 1] || pts[0];
      const nxt = pts.find((p) => p.t > tNow);
      if (nxt && last && nxt.t > last.t) {
        const u = (tNow - last.t) / (nxt.t - last.t);
        last = { x: last.x + (nxt.x - last.x) * u, y: last.y + (nxt.y - last.y) * u, z: (last.z || 0) + ((nxt.z || 0) - (last.z || 0)) * u };
        seg.push(last);
      }
      dom.traj.setAttribute('points', seg.map((p) => { const b = toBox(p); return `${b.x.toFixed(1)},${b.y.toFixed(1)}`; }).join(' '));
      const b = toBox(last);
      const lift = Math.min(40, Math.max(0, Number(last.z) || 0)) ;
      dom.ball.style.transform = `translate(${b.x}px,${b.y - lift * 0.6}px) scale(${1 + lift / 30})`;
      dom.ball.style.setProperty('--shadow-y', `${lift * 0.6}px`);
    };
    dom.ball.className = 'ff-ball show';
    if (!dur) { draw(1); return 0; }
    const t0 = performance.now();
    const tick = (now) => {
      if (destroyed) return;
      const k = Math.min(1, (now - t0) / dur);
      draw(k);
      if (k < 1) raf = requestAnimationFrame(tick);
      else {
        raf = 0;
        if (f?.throwTo && target) showThrow(target, f.throwTo);
      }
    };
    raf = requestAnimationFrame(tick);
    return dur;
  }

  function showThrow(from, base) {
    const a = toBox(from); const b = toBox(BASE_XY[base] || BASE_XY[1]);
    const l = dom.throwLine;
    l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
    l.setAttribute('class', 'ff-throw show');
    l.style.setProperty('--len', String(Math.hypot(b.x - a.x, b.y - a.y)));
  }

  /* ---------- 進行 ---------- */
  function later(fn, t) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; if (!destroyed && !finished) fn(); }, Math.max(0, t));
  }

  function flushLog() {
    if (!unlogged) return;
    const st = unlogged;
    unlogged = null;
    addLog(logLines(st), st.prev);
  }

  function finish(reason, extra = {}) {
    if (finished || destroyed) return;
    flushLog();
    finished = true;
    clearTimeout(timer);
    timer = 0;
    root.classList.add('done');
    try { opts.onDone?.(state, { reason, steps, ...extra }); } catch (e) { console.error(e); }
  }

  function soundFor(step) {
    if (speed === 'end') return;
    const ev = step.event;
    const k = ev?.kind;
    if (step.ball) play(step.ball.isHomeRun ? 'homerun' : 'hit');
    if (k === 'strikeout') play('strikeout');
    else if (['out', 'double_play', 'sac_fly', 'sac_bunt', 'caught_stealing'].includes(k)) setTimeout(() => play('out'), ms(500));
    else if (['hit', 'hr', 'error'].includes(k) || ev?.runs > 0) setTimeout(() => play('cheer'), ms(400));
    else if (k === 'walk' || k === 'hbp' || k === 'ibb') play('ball');
    else if (speed === 2 && k === 'strike') play('catch');
  }

  /** 1 球を計算して表示し、次の予定を立てる */
  function next() {
    if (destroyed || finished) return;
    if (wantNormal) { finish('normal'); return; }
    if (!isUserDefending(engine, state, userSide)) { finish(engine.isGameOver(state) ? 'gameOver' : 'halfEnd'); return; }
    if (steps >= MAX_PITCHES_PER_HALF) { finish('limit'); return; }
    if (speed === 'end') { runToEnd(); return; }
    let step;
    try { step = stepPitch(engine, state, rng, { manage: opts.manage }); }
    catch (e) { console.error(e); finish('error', { error: e }); return; }
    steps++;
    const prev = state;
    state = step.state;
    try { opts.onPlay?.(step.event, state, step); } catch (e) { console.error(e); }
    showStep(step, prev);
  }

  function showStep(step, prev) {
    clearBall();
    banner('');
    dom.callout.className = 'ff-callout';
    // 投球前の場面（走者・野手）→ 打球 → 結果
    renderFielders(prev, null);
    dom.lastpitch.textContent = pitchLine(step.event.kind === 'inplay' ? step.contact : step.event) || pitchLine(step.contact);
    soundFor(step);
    if (step.ball) {
      renderAll(prev);
      renderRunners(prev);
      unlogged = step;
      const flight = animateBall(step);
      later(() => resultPhase(step), flight);
    } else {
      resultPhase(step);
    }
  }

  function resultPhase(step) {
    const ev = step.event;
    const scored = (ev.runnerResults || []).filter((r) => r.to === 4 && r.from > 0).map((r) => step.prev.bases?.[r.from - 1]).filter(Boolean);
    const outs = (ev.runnerResults || []).filter((r) => r.out && r.from > 0).map((r) => step.prev.bases?.[r.from - 1]).filter(Boolean);
    const endCount = step.endHalf && !step.over ? { b: 0, s: 0, o: 3 } : null;
    renderAll(step.endHalf && !step.over ? { ...step.state, inning: step.prev.inning, half: step.prev.half } : step.state, endCount);
    if (step.endHalf && !step.over) renderMatchup(step.prev);
    renderRunners(step.endHalf ? { ...step.state, bases: [null, null, null], teams: step.state.teams, half: step.prev.half, inning: step.prev.inning } : step.state, { animate: true, scored, outs });
    if (step.paEnded || STEAL_KINDS.includes(ev.kind)) callout(ev);
    runsPop(Number(ev.runs) || 0);
    unlogged = null;
    addLog(logLines(step), step.prev);
    let wait = step.ball ? BASE_MS.hold : step.paEnded ? BASE_MS.pa : BASE_MS.pitch;
    if (step.steals.length) wait += BASE_MS.steal;
    if (step.subs.length) {
      wait += BASE_MS.sub * Math.min(2, step.subs.length);
      banner('選手交代', step.subs.map((x) => x.text).join(' '));
    }
    if (step.endHalf) {
      const over = step.over;
      later(() => {
        clearBall();
        banner(over ? '試合終了' : 'チェンジ', over ? scoreText(state) : '');
        later(() => finish(over ? 'gameOver' : 'halfEnd'), ms(BASE_MS.change));
      }, ms(wait));
      return;
    }
    later(next, ms(wait));
  }

  const scoreText = (s) => {
    const t = (side) => (s.score?.[side] || []).reduce((a, b) => a + (Number(b) || 0), 0);
    return `${short('away')} ${t('away')} - ${t('home')} ${short('home')}`;
  };

  /** 結果まで: 残りを一気に計算（onPlay は 1 球ずつ呼ぶ）して最終状態を見せる */
  function runToEnd() {
    clearBall();
    flushLog();
    const before = state;
    let last = null;
    let runs = 0;
    try {
      for (const step of simulateHalf(engine, state, rng, { manage: opts.manage, maxPitches: MAX_PITCHES_PER_HALF - steps, shouldStop: () => wantNormal })) {
        steps++;
        state = step.state;
        last = step;
        runs += Number(step.event?.runs) || 0;
        try { opts.onPlay?.(step.event, state, step); } catch (e) { console.error(e); }
        addLog(logLines(step), step.prev);
      }
    } catch (e) { console.error(e); finish('error', { error: e }); return; }
    const over = engine.isGameOver(state);
    const ended = over || battingSide(engine, state) !== battingSide(engine, before);
    renderFielders(last && ended ? last.prev : state);
    renderAll(ended && !over && last ? { ...state, inning: last.prev.inning, half: last.prev.half } : state, ended && !over ? { b: 0, s: 0, o: 3 } : null);
    if (ended && !over && last) renderMatchup(last.prev);
    renderRunners(ended ? { ...state, bases: [null, null, null], half: last?.prev.half ?? state.half } : state);
    if (last?.ball) { animateBall(last); }
    if (last) dom.lastpitch.textContent = pitchLine(last.event.kind === 'inplay' ? last.contact : last.event);
    play('select');
    if (!ended) { finish(wantNormal ? 'normal' : 'limit'); return; }
    banner(over ? '試合終了' : 'チェンジ', over ? scoreText(state) : (runs ? `この回 ${runs}点` : 'この回 無失点'));
    timer = setTimeout(() => { timer = 0; finish(over ? 'gameOver' : 'halfEnd'); }, 1100);
  }

  /* ---------- 操作 ---------- */
  function setSpeed(v) {
    if (!FF_SPEEDS.includes(v) || finished) return;
    const was = speed;
    speed = v;
    renderSpeed();
    // 結果まで: いま待っている次の球をすぐに
    if (v === 'end' && was !== 'end' && started && timer && !raf) { clearTimeout(timer); timer = 0; next(); }
    else if (v === 'end' && was !== 'end' && started && raf) {
      // 打球アニメ中 → 次の区切り（resultPhase）を待たずに一気に。現在の 1 球は計算済み（resolve 済み）なのでそのまま進めてよい
      clearBall(); clearTimeout(timer); timer = 0; next();
    }
  }

  function requestNormal() {
    if (finished) return;
    wantNormal = true;
    root.classList.add('leaving');
    // 1 球の処理（resolve まで）は計算済みなので、ここは必ず投球と投球の間。少しだけ結果を見せて戻る
    if (started && !timer && !raf) { finish('normal'); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; finish('normal'); }, 180);
  }

  function handleKey(key) {
    if (destroyed || finished) return false;
    const k = String(key || '').toLowerCase();
    if (k === 'z' || k === 'enter' || k === ' ' || k === 'swing') {
      const i = FF_SPEEDS.indexOf(speed);
      if (i < FF_SPEEDS.length - 1) setSpeed(FF_SPEEDS[i + 1]);
      return true;
    }
    if (k === 'esc' || k === 'escape' || k === 'x') { requestNormal(); return true; }
    return k === 'up' || k === 'down' || k === 'left' || k === 'right';
  }

  function start() {
    if (started || destroyed) return;
    started = true;
    renderSpeed();
    renderAll(state);
    renderFielders(state);
    renderRunners(state);
    if (!isUserDefending(engine, state, userSide)) {
      timer = setTimeout(() => { timer = 0; finish(engine.isGameOver(state) ? 'gameOver' : 'notDefending'); }, 0);
      return;
    }
    root.classList.add('on');
    later(next, speed === 'end' ? 0 : ms(BASE_MS.pitch * 0.6));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
    listeners.forEach(([n, t, f]) => n.removeEventListener(t, f));
    listeners.length = 0;
    root.remove();
  }

  renderSpeed();
  if (opts.autoStart !== false) start();
  return { start, handleKey, setSpeed, requestNormal, destroy, getState: () => state, get speed() { return speed; }, el: root };
}
