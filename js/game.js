/**
 * 試合画面（ドキドキベースボール）
 * 描画・入力・投球アニメーションを担当。試合ロジックは engine.js に委譲する。
 *
 * export function createGameScreen(el, ctx) → { start(), handleKey(key), destroy() }
 *   key: 'up'|'down'|'left'|'right'|'z'|'x'|'enter'|'esc'
 *   ctx: { teams, userTeamId, go(name, payload), onGameOver(state) }
 */
import * as engine from './engine.js';
import { rank, RANK_COLORS, PITCH_TYPES } from './data.js';

// ---- レイアウト定数（1280x720 ステージ座標） ----
const ZONE_LEFT = 520;
const ZONE_TOP = 404;
const CELL = 80;
const ZONE_CX = ZONE_LEFT + CELL * 1.5; // 640
const ZONE_CY = ZONE_TOP + CELL * 1.5;  // 524
const PITCHER_X = 640;
const PITCHER_Y = 300;
const BALL_HALF = 12;
const FLIGHT_MS = 700;
const TIMING_WINDOW_MS = 300;
const TAKE_GRACE_MS = 150;
const RESULT_MS = 900;
const CHANGE_MS = 1200;
const GAMESET_MS = 1500;
const CPU_PITCH_DELAY_MS = 1100;
const BATTER_LEFT_R = 400; // 右打者（三塁側）
const BATTER_LEFT_L = 800; // 左打者（一塁側）= 鏡像
const BATTER_TOP = 420;

const REQUIRED = ['createGame', 'getBatter', 'getPitcher', 'resolvePitch', 'choosePitch', 'chooseSwing', 'isGameOver'];

/** HTML エスケープ */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function chibiHTML(extraClass, color, number) {
  return `<div class="chibi ${extraClass}" style="--team:${esc(color)}"><div class="chibi-head"><div class="chibi-cap"></div><div class="chibi-cap-button"></div><div class="chibi-brim"></div><div class="chibi-eye l"><i class="chibi-shine"></i></div><div class="chibi-eye r"><i class="chibi-shine"></i></div><div class="chibi-cheek l"></div><div class="chibi-cheek r"></div><div class="chibi-mouth"></div></div><div class="chibi-body">${esc(number)}</div><div class="chibi-legs"><i></i><i></i></div>${extraClass === 'chibi-batter' ? '<div class="bat"></div>' : ''}</div>`;
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
    case 'hr': return 'ホームラン！';
    case 'out': return 'アウト';
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
    case 'strikeout': return '三振';
    case 'walk': return '四球';
    default: return null;
  }
}

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
  let phase = 'idle'; // idle | ready | pitching | resolve | change | over
  let cursor = { x: 1, y: 1 };   // 打撃カーソル
  let aim = { x: 1, y: 1 };      // 投球の狙い
  let pitchIdx = 0;              // ユーザー投手の球種インデックス
  let tickerText = '';
  let rafId = 0;
  const timers = new Set();
  const listeners = [];
  const atBatChips = {};         // playerId → ['安打', ...]
  const pitcherBase = {};        // side → { id, count } 登板時の投球数
  let flight = null;             // 投球アニメ情報
  let lastBatting = null;
  let destroyed = false;
  let dom = {};

  // ---------- helpers ----------
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
    timers.add(id);
    return id;
  };
  const clearTimers = () => { timers.forEach(clearTimeout); timers.clear(); };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const battingSide = (s = state) => {
    if (typeof engine.summary === 'function') {
      const b = engine.summary(s)?.batting;
      if (b === 'away' || b === 'home') return b;
    }
    return s.half === 'top' ? 'away' : 'home';
  };
  const fieldingSide = (s = state) => (battingSide(s) === 'away' ? 'home' : 'away');
  const userSide = () => state.userSide || 'away';
  const userBatting = () => battingSide() === userSide();

  const inningLabel = (s = state) => {
    if (typeof engine.summary === 'function') {
      const l = engine.summary(s)?.inningLabel;
      if (l) return l;
    }
    return `${s.inning}回${s.half === 'top' ? '表' : '裏'}`;
  };
  const totalRuns = (arr) => (Array.isArray(arr) ? arr.reduce((a, b) => a + (Number(b) || 0), 0) : Number(arr) || 0);
  const scores = () => {
    if (typeof engine.summary === 'function') {
      const sc = engine.summary(state)?.score;
      if (sc && typeof sc.away === 'number') return sc;
    }
    return { away: totalRuns(state.score?.away), home: totalRuns(state.score?.home) };
  };

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
  <div class="game-field"></div>
  <header class="game-header">
    <div class="team away"><span class="team-badge" style="background:${esc(away.color)}">${esc(away.short)}</span><span class="team-name">${esc(away.name)}</span><span class="score-num" data-score="away">0</span></div>
    <div class="inning" data-ref="inning"></div>
    <div class="team home"><span class="score-num" data-score="home">0</span><span class="team-name">${esc(home.name)}</span><span class="team-badge" style="background:${esc(home.color)}">${esc(home.short)}</span></div>
    <div class="lamps">
      <div class="lamp-row"><b>B</b><span data-lamps="b">${lamps('lamp-b', 3)}</span></div>
      <div class="lamp-row"><b>S</b><span data-lamps="s">${lamps('lamp-s', 2)}</span></div>
      <div class="lamp-row"><b>O</b><span data-lamps="o">${lamps('lamp-o', 2)}</span></div>
    </div>
    <div class="runners"><i class="base b2" data-base="1"></i><i class="base b3" data-base="2"></i><i class="base b1" data-base="0"></i></div>
    <button type="button" class="menu-btn" data-ref="menu">メニュー</button>
  </header>

  <aside class="panel panel-left" data-ref="pitcher-panel">
    <div class="panel-title">ピッチャー</div>
    <div class="player-name" data-ref="p-name"></div>
    <div class="player-meta" data-ref="p-meta"></div>
    <div class="player-velo" data-ref="p-velo"></div>
    <div class="stamina"><span>スタミナ</span><div class="stamina-bar"><i data-ref="p-stamina"></i></div></div>
    <ul class="pitch-list" data-ref="p-pitches"></ul>
    <div class="pitch-count" data-ref="p-count"></div>
  </aside>

  <aside class="panel panel-right" data-ref="batter-panel">
    <div class="panel-title">バッター</div>
    <div class="player-name" data-ref="b-name"></div>
    <div class="player-meta" data-ref="b-meta"></div>
    <div class="abilities" data-ref="b-abilities"></div>
    <div class="today"><div class="today-title">本日の成績</div><div class="today-chips" data-ref="b-today"></div></div>
  </aside>

  ${chibiHTML('chibi-pitcher', cpuOrUserColor('field'), pitcher?.number ?? '')}
  <div data-ref="batter-wrap">${chibiHTML('chibi-batter', cpuOrUserColor('bat'), '')}</div>

  <div class="zone">${cells.join('')}</div>
  <div class="cursor" data-ref="cursor"></div>
  <div class="ball" data-ref="ball" style="opacity:0"></div>

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

  function cpuOrUserColor(which) {
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
      pName: q('[data-ref="p-name"]'),
      pMeta: q('[data-ref="p-meta"]'),
      pVelo: q('[data-ref="p-velo"]'),
      pStamina: q('[data-ref="p-stamina"]'),
      pPitches: q('[data-ref="p-pitches"]'),
      pCount: q('[data-ref="p-count"]'),
      bName: q('[data-ref="b-name"]'),
      bMeta: q('[data-ref="b-meta"]'),
      bAbilities: q('[data-ref="b-abilities"]'),
      bToday: q('[data-ref="b-today"]'),
      pitcherChibi: q('.chibi-pitcher'),
      batterChibi: q('.chibi-batter'),
      bat: q('.chibi-batter .bat'),
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
    el.querySelectorAll('[data-key]').forEach((btn) => {
      on(btn, 'pointerdown', (e) => { e.preventDefault(); handleKey(btn.dataset.key); });
      on(btn, 'contextmenu', (e) => e.preventDefault());
    });
    on(dom.menu, 'click', (e) => { e.preventDefault(); ctx.go?.('title'); });
  }

  // ---------- render (patch) ----------
  function abilityBadge(label, value, r) {
    const color = RANK_COLORS[r] || '#9E9E9E';
    const fg = r === 'C' ? '#1C2B4B' : '#fff';
    return `<div class="ability"><span class="ability-label">${esc(label)}</span><span class="ability-badge" style="background:${esc(color)};color:${fg}">${esc(r)}</span><span class="ability-value">${esc(value)}</span></div>`;
  }

  function staminaRatio(pitcher, side) {
    const own = state.stamina?.[side] ?? state.pitcherStamina?.[side];
    if (typeof own === 'number') return clamp(own > 1 ? own / 100 : own, 0, 1);
    if (typeof own === 'object' && own && typeof own[pitcher?.id] === 'number') {
      const v = own[pitcher.id]; return clamp(v > 1 ? v / 100 : v, 0, 1);
    }
    const count = state.pitchCount?.[side] ?? 0;
    const base = pitcherBase[side];
    const thrown = base && base.id === pitcher?.id ? count - base.count : count;
    const cap = Math.max(20, (pitcher?.pitching?.stamina ?? 50) * 1.5);
    return clamp(1 - thrown / cap, 0, 1);
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
    const bases = state.bases || [false, false, false];
    dom.bases.forEach((n, i) => n && n.classList.toggle('on', !!bases[i]));

    // pitcher panel
    const fSide = fieldingSide();
    const pitcher = engine.getPitcher(state);
    const userPitching = !userBatting();
    if (pitcher) {
      dom.pName.textContent = pitcher.name;
      dom.pMeta.textContent = `#${pitcher.number}  ${pitcher.throws}投${pitcher.bats}打`;
      dom.pVelo.textContent = `球速 ${pitcher.pitching?.velocity ?? '-'} km/h`;
      dom.pStamina.style.width = `${Math.round(staminaRatio(pitcher, fSide) * 100)}%`;
      const list = userPitches();
      dom.pPitches.innerHTML = list.map((p, i) => `<li class="pitch-item${userPitching && i === pitchIdx ? ' selected' : ''}" data-type="${esc(p.type)}"><span>${esc(p.name)}</span>${p.level ? `<b>${esc('★'.repeat(Math.min(7, p.level)))}</b>` : ''}</li>`).join('');
      dom.pCount.textContent = `投球数 ${state.pitchCount?.[fSide] ?? 0}`;
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
      const order = ((state.batterIndex?.[bSide] ?? 0) % 9) + 1;
      dom.bName.textContent = batter.name;
      dom.bMeta.textContent = `${order}番 ${batter.pos}  ${batter.throws}投${batter.bats}打`;
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
        dom.batterChibi.style.transform = lefty ? 'scaleX(-1)' : '';
        const body = dom.batterChibi.querySelector('.chibi-body');
        if (body) body.textContent = batter.number;
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
    dom.ticker.textContent = tickerText;
  }

  // ---------- overlay ----------
  function showOverlay(big, sub, ms, then) {
    dom.overlayBig.textContent = big;
    dom.overlaySub.textContent = sub || '';
    dom.overlay.classList.add('show');
    later(() => {
      dom.overlay.classList.remove('show');
      if (then) then();
    }, ms);
  }

  // ---------- flow ----------
  function readyHint() {
    return userBatting()
      ? '←→↑↓:カーソル  Z:ミート  X:強振  Enter:見送り'
      : '←→↑↓:コース  X:球種変更  Z:投げる';
  }

  function enterReady() {
    if (destroyed) return;
    phase = 'ready';
    flight = null;
    if (dom.ball) dom.ball.style.opacity = '0';
    if (dom.bat) dom.bat.style.transform = '';
    const list = userPitches();
    if (pitchIdx >= list.length) pitchIdx = 0;
    render();
    if (userBatting()) {
      later(() => { if (phase === 'ready') startCpuPitch(false); }, CPU_PITCH_DELAY_MS);
    }
  }

  function startFlight(pitch, finalLoc, onArrive) {
    const start = now();
    const aimLoc = { x: pitch.zone.x - 1, y: pitch.zone.y - 1 };
    flight = { pitch, start, arrival: start + FLIGHT_MS, aimLoc, finalLoc, swung: false, batInput: null, take: false, onArrive, done: false };
    if (dom.ball) dom.ball.style.opacity = '1';
    const step = () => {
      if (destroyed || !flight) return;
      const t = clamp((now() - flight.start) / FLIGHT_MS, 0, 1);
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
    if (phase !== 'ready') return;
    phase = 'pitching';
    const pitch = engine.choosePitch(state, rng);
    tickerText = `${engine.getPitcher(state)?.name ?? '投手'}、投げた！`;
    render();
    startFlight(pitch, predictLoc(pitch), () => {
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
    const timing = clamp((t - flight.arrival) / TIMING_WINDOW_MS, -1, 1);
    const batInput = { zone: { x: cursor.x, y: cursor.y }, mode, timing };
    if (dom.bat) dom.bat.style.transform = 'rotate(-110deg)';
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
    const res = engine.resolvePitch(state, pitchInput, batInput, rng);
    const loc = validLoc(res?.event?.location) ? { x: Number(res.event.location.x), y: Number(res.event.location.y) } : predictLoc(pitchInput);
    tickerText = `${engine.getPitcher(prev)?.name ?? '投手'}、${list[pitchIdx]?.name ?? ''}を投げた！`;
    render();
    startFlight(pitchInput, loc, () => {
      if (batInput && dom.bat) dom.bat.style.transform = 'rotate(-110deg)';
      applyResult(prev, res);
    });
  }

  function finishPitch(pitch, batInput) {
    if (phase !== 'pitching') return;
    const prev = state;
    const res = engine.resolvePitch(state, pitch, batInput, rng);
    if (validLoc(res?.event?.location) && dom.ball) {
      const px = locToPx({ x: Number(res.event.location.x), y: Number(res.event.location.y) });
      dom.ball.style.left = `${px.left}px`;
      dom.ball.style.top = `${px.top}px`;
    }
    applyResult(prev, res);
  }

  function applyResult(prev, res) {
    if (destroyed) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    phase = 'resolve';
    const event = res?.event || { kind: 'ball', text: '' };
    const batterBefore = engine.getBatter(prev);
    state = res?.state || state;
    const chip = chipFor(event);
    if (chip && batterBefore) (atBatChips[batterBefore.id] ||= []).push(chip);
    tickerText = event.text || overlayFor(event);

    // 投手交代検出
    const pitcherChange = detectPitcherChange();
    if (pitcherChange) tickerText += `  ${pitcherChange}`;

    render();
    const sub = event.runs ? `${event.runs}点！` : '';
    showOverlay(overlayFor(event), sub, RESULT_MS, afterResult);
  }

  function detectPitcherChange() {
    const side = fieldingSide();
    const p = engine.getPitcher(state);
    if (!p) return '';
    const base = pitcherBase[side];
    if (!base) { pitcherBase[side] = { id: p.id, count: state.pitchCount?.[side] ?? 0 }; return ''; }
    if (base.id !== p.id) {
      pitcherBase[side] = { id: p.id, count: state.pitchCount?.[side] ?? 0 };
      return `ピッチャー交代：${p.name}`;
    }
    return '';
  }

  function afterResult() {
    if (destroyed) return;
    if (dom.ball) dom.ball.style.opacity = '0';
    if (dom.bat) dom.bat.style.transform = '';
    if (engine.isGameOver(state)) {
      phase = 'over';
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
      detectPitcherChange();
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

  // ---------- input ----------
  function handleKey(key) {
    if (destroyed || !state) return;
    if (phase === 'over' || phase === 'idle') return;
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
      if (key === 'enter' && phase === 'ready') {
        clearTimers();
        startCpuPitch(true);
      }
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

  // ---------- lifecycle ----------
  function start() {
    const teams = ctx.teams || [];
    userTeam = teams.find((t) => t.id === ctx.userTeamId) || teams[0];
    cpuTeam = teams.find((t) => t !== userTeam);
    if (!userTeam || !cpuTeam) throw new Error('game.js: チームデータが2チーム分ありません');
    state = engine.createGame(cpuTeam, userTeam);
    if (!state) throw new Error('game.js: engine.createGame が GameState を返しませんでした');
    if (!state.userSide) state = { ...state, userSide: 'away' };
    phase = 'idle';
    cursor = { x: 1, y: 1 };
    aim = { x: 1, y: 1 };
    pitchIdx = 0;
    el.innerHTML = template();
    cacheDom();
    bindInputs();
    detectPitcherChange();
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
    clearTimers();
    listeners.forEach(([n, t, f, o]) => n.removeEventListener(t, f, o));
    listeners.length = 0;
    flight = null;
  }

  return { start, handleKey, destroy };
}
