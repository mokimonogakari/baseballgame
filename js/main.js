import { TEAMS } from './data.js';
import { openChallenge } from './challenge.js';
import { renderTitle, renderTeam, renderResult, renderSettings } from './screens.js';
import { isGuideOpen, closeGuide } from './title.js';
import { createGameScreen } from './game.js';
import { boxScore } from './engine.js';
import { renderTeamEdit, loadMyTeam, MY_TEAM_ID } from './teamedit.js';
import { createSound } from './sound.js';
import { createMusic } from './music.js';
import { createPortraitHud } from './portrait.js';
import { initTouch, canFullscreen, isFullscreenOrStandalone, enterFullscreen } from './touch.js';

const stage = document.getElementById('stage');
const wrap = document.getElementById('stage-wrap');
const screens = {};
document.querySelectorAll('.screen').forEach((s) => (screens[s.dataset.screen] = s));

let userTeamId = 'red';
let current = null;
let gameScreen = null;
let editScreen = null;
let myTeam = loadMyTeam();
let opponentTeamId = null;
let oppModal = null;
/** 試合前の「あいてを選ぶ」モーダル（false: たいせん・試合へ・もう一度あそぶ で即試合開始） */
const OPPONENT_PICKER = false;

const hud = createPortraitHud({ getRoot: () => (current === 'game' ? screens.game : null) });
let stageScale = 1;
/** 縦向き（スマホ・タブレットを縦に持ったとき）のメニュー画面の論理幅。高さは画面の縦横比に合わせる */
const PORTRAIT_W = 480;
const PORTRAIT_MIN_H = 880;
/** 縦向きの試合画面: 1280×720 のステージから切り出す範囲（打席 = ゾーン・投手・打者・捕手 / 守備 = ダイヤモンドと外野） */
const CROP_BAT = { x: 260, y: 130, w: 760, h: 590 };
const CROP_FIELD = { x: 200, y: 120, w: 880, h: 580 };
/** 守備オートの早送り（js/fastforward.js）: ステージ中央の縦 1 列（css/portrait.css が .ff をこの範囲に並べ直す） */
const CROP_FF = { x: 400, y: 0, w: 480, h: 720 };
/** 縦向きの試合画面で、ステージの下にタッチ操作のために残す最低の高さ（CSS px） */
const PORTRAIT_MIN_CTL = 228;
const coarseMQ = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : { matches: false };
let portraitView = '';
/** 縦向きか（タッチ端末で縦長の画面）。マウスの PC は縦長ウィンドウでも従来どおり 1280×720 を縮小 */
function portraitNow(w, h) { return !!coarseMQ.matches && h > w; }
function portraitGameView() {
  if (current !== 'game') return '';
  if (screens.game.querySelector('.ff')) return 'ff';
  return screens.game.querySelector('.fv') ? 'field' : 'bat';
}
/** 1280×720 のステージを画面に収める。#stage-wrap の padding = safe-area（ノッチ）を除いた領域で計算 */
function fitStage() {
  const cs = getComputedStyle(wrap);
  const px = (v) => parseFloat(v) || 0;
  const w = (wrap.clientWidth || window.innerWidth) - px(cs.paddingLeft) - px(cs.paddingRight);
  const h = (wrap.clientHeight || window.innerHeight) - px(cs.paddingTop) - px(cs.paddingBottom);
  const portrait = portraitNow(w, h);
  const body = document.body;
  const root = document.documentElement.style;
  body.classList.toggle('portrait', portrait);
  portraitView = portrait ? portraitGameView() : '';
  body.dataset.pview = portraitView;
  if (!portrait) {
    stage.style.width = stage.style.height = stage.style.transform = stage.style.clipPath = '';
    const scale = Math.max(0.05, Math.min(w / 1280, h / 720));
    stageScale = scale;
    stage.style.setProperty('--scale', scale);
    // 小さい画面（スマホ横向きなど）では重要な文字・ボタンを大きくする
    body.classList.toggle('compact', scale < 0.6);
    return;
  }
  if (portraitView) {
    // 試合: 1280×720 の中央（守備ビューはダイヤモンド全体）を切り出して横幅いっぱいに。上は情報バー、下はタッチ操作
    const crop = portraitView === 'ff' ? CROP_FF : portraitView === 'field' ? CROP_FIELD : CROP_BAT;
    const padT = px(cs.paddingTop);
    let top = Math.max(0, hud.height() - padT); // 情報バーは safe-area の上端から（ステージは padding の内側）
    // 早送りは画面いっぱい（タッチ操作は出さない）。それ以外は下にタッチ操作の高さを残す
    const minCtl = portraitView === 'ff' ? 0 : PORTRAIT_MIN_CTL;
    let scale = w / crop.w;
    if (h - top - crop.h * scale < minCtl) scale = Math.max(0.05, (h - top - minCtl) / crop.h);
    const offX = (w - crop.w * scale) / 2;
    if (portraitView === 'ff') top = Math.max(top, Math.floor((h - crop.h * scale) / 2)); // 早送りは上下中央に
    stageScale = scale;
    stage.style.width = '1280px';
    stage.style.height = '720px';
    stage.style.setProperty('--scale', scale);
    stage.style.transform = `translate(${(offX - crop.x * scale).toFixed(2)}px, ${(top - crop.y * scale).toFixed(2)}px) scale(${scale.toFixed(5)})`;
    stage.style.clipPath = `inset(${crop.y}px ${1280 - crop.x - crop.w}px ${720 - crop.y - crop.h}px ${crop.x}px)`;
    // css/portrait.css 用: フィールドの上端・下端（画面の上からの CSS px）。タッチ操作はフィールドの下へ
    root.setProperty('--pt-top', `${Math.round(padT + top)}px`);
    root.setProperty('--pt-ctl', `${Math.round(padT + top + crop.h * scale)}px`);
    body.classList.toggle('compact', scale < 0.6);
  } else {
    // メニュー画面: 幅 560 の縦長ステージ（css/portrait.css の縦レイアウト）
    // 縦長でない画面（タブレットなど）は幅を広げて、高さ PORTRAIT_MIN_H を確保
    const pw = Math.max(PORTRAIT_W, Math.round(PORTRAIT_MIN_H * w / h));
    const scale = w / pw;
    stageScale = scale;
    stage.style.width = `${pw}px`;
    stage.style.height = `${Math.round(h / scale)}px`;
    stage.style.setProperty('--scale', scale);
    stage.style.transform = `scale(${scale.toFixed(5)})`;
    stage.style.clipPath = '';
    body.classList.remove('compact');
  }
}
/** 縦向きの試合中: 守備ビューの開閉で切り出す範囲を変える */
setInterval(() => {
  if (!document.body.classList.contains('portrait')) return;
  hud.sync();
  if (portraitGameView() !== portraitView) fitStage();
}, 100);

const SETTINGS_KEY = 'dokidoki.settings';
const DEFAULTS = { innings: 3, difficulty: 'normal', sound: true, music: true, musicVolume: 0.7, cursorSpeed: 3, pitchMode: 'manual', fieldMode: 'assist', watchPlays: 'all', fastForward: 'on', battingAssist: null };
function loadSettings() {
  const out = { ...DEFAULTS };
  try {
    const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if ([3, 6, 9].includes(o.innings)) out.innings = o.innings;
    if (['easy', 'normal', 'hard'].includes(o.difficulty)) out.difficulty = o.difficulty;
    if (typeof o.sound === 'boolean') out.sound = o.sound;
    if (typeof o.music === 'boolean') out.music = o.music;
    if (typeof o.musicVolume === 'number' && o.musicVolume >= 0 && o.musicVolume <= 1) out.musicVolume = o.musicVolume;
    if (Number.isInteger(o.cursorSpeed) && o.cursorSpeed >= 1 && o.cursorSpeed <= 5) out.cursorSpeed = o.cursorSpeed;
    if (['manual', 'cpu'].includes(o.pitchMode)) out.pitchMode = o.pitchMode;
    if (['manual', 'assist', 'auto'].includes(o.fieldMode)) out.fieldMode = o.fieldMode;
    if (['all', 'big', 'off'].includes(o.watchPlays)) out.watchPlays = o.watchPlays;
    if (['on', 'off'].includes(o.fastForward)) out.fastForward = o.fastForward;
    if (o.battingAssist === null || [0, 1, 2, 3].includes(o.battingAssist)) out.battingAssist = o.battingAssist ?? null;
  } catch (e) { /* ignore */ }
  return out;
}
const settings = loadSettings();
const sound = createSound({ enabled: settings.sound, onVoiceActivity: active => music.duck(active) });
const music = createMusic({ enabled: settings.music, volume: settings.musicVolume });
function saveSettings(patch) {
  const p = { ...(patch || {}) };
  if ('cursorSpeed' in p && !(Number.isInteger(p.cursorSpeed) && p.cursorSpeed >= 1 && p.cursorSpeed <= 5)) delete p.cursorSpeed;
  if ('pitchMode' in p && !['manual', 'cpu'].includes(p.pitchMode)) delete p.pitchMode;
  if ('fieldMode' in p && !['manual', 'assist', 'auto'].includes(p.fieldMode)) delete p.fieldMode;
  if ('watchPlays' in p && !['all', 'big', 'off'].includes(p.watchPlays)) delete p.watchPlays;
  if ('fastForward' in p && !['on', 'off'].includes(p.fastForward)) delete p.fastForward;
  if ('battingAssist' in p && !(p.battingAssist === null || [0, 1, 2, 3].includes(p.battingAssist))) delete p.battingAssist;
  Object.assign(settings, p);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  sound.setEnabled(settings.sound);
  music.setEnabled(settings.music);
  music.setVolume(settings.musicVolume);
}
/* ---------- 音（iOS Safari は touchend でないと AudioContext が動かないことがある） ---------- */
let audioUnlocked = false;
const audioCtx = () => window.__dokiAudioCtx || null;
function unlockAudio() {
  if (document.hidden) return;
  const c = audioCtx();
  if (audioUnlocked && c && c.state === 'running') return;
  audioUnlocked = true;
  sound.unlock();
  music.unlock();
  try { const c2 = audioCtx(); if (c2 && c2.state !== 'running') c2.resume(); } catch (e) { /* ignore */ }
}
['pointerdown', 'pointerup', 'touchend', 'keydown'].forEach((t) => window.addEventListener(t, unlockAudio, { passive: true }));
// 裏に回ったら止める（BGM も効果音も AudioContext ごと一時停止）。戻ったら再開
document.addEventListener('visibilitychange', () => {
  const c = audioCtx();
  if (!c) return;
  try {
    if (document.hidden) { if (c.state === 'running') c.suspend(); }
    else if (audioUnlocked && c.state !== 'running') c.resume();
  } catch (e) { /* ignore */ }
});
window.addEventListener('pagehide', () => { try { audioCtx()?.suspend(); } catch (e) { /* ignore */ } });
stage.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('button, a');
  if (t && !t.disabled) sound.play('decide');
});

const ctx = {
  openChallenge: launchChallenge,
  sound, music, settings, saveSettings,
  get teams() { return myTeam ? [...TEAMS, myTeam] : TEAMS; },
  get userTeamId() { return userTeamId; },
  get opponentTeamId() { return opponentTeamId; },
  matchup() { const g = gameCtx(); return { user: g.teams[0], opp: g.teams[1] }; },
  set opponentTeamId(id) { opponentTeamId = id; },
  setUserTeam(id) { if (ctx.teams.some((t) => t.id === id)) userTeamId = id; },
  setMyTeam(team) { myTeam = team && team.id === MY_TEAM_ID ? team : null; if (!myTeam && userTeamId === MY_TEAM_ID) userTeamId = TEAMS[0].id; },
  go,
  onGameOver(state) { go('result', state); },
};

function launchChallenge() {
  if (document.body.classList.contains('challenge-open')) return;
  unlockAudio();
  openChallenge({ sound, onClose() {} });
}
/* ---------- あいてを選ぶ ---------- */
function closeOppModal() {
  if (oppModal) { oppModal.el.remove(); oppModal = null; }
}
function openOppModal() {
  closeOppModal();
  const user = ctx.teams.find((t) => t.id === userTeamId) || ctx.teams[0];
  const opts = ctx.teams.filter((t) => t.id !== user.id);
  if (!opts.length) { go('game', { confirmed: true }); return; }
  let idx = Math.max(0, opts.findIndex((t) => t.id === opponentTeamId));
  const wrap = document.createElement('div');
  wrap.className = 'opp-modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', 'あいてを選ぶ');
  const draw = () => {
    wrap.innerHTML = `<div class="opp-card">
      <h2>あいてを選ぶ</h2>
      <p class="opp-me">あなた：<b style="background:${user.color}">${user.short}</b> ${user.name}</p>
      <div class="opp-list">${opts.map((t, i) => `<button class="opp-row${i === idx ? ' sel' : ''}" data-i="${i}">
        <span class="opp-chip" style="background:${t.color}">${t.short}</span><span class="opp-name">${t.name}</span><span class="opp-vs">${i === idx ? '▶' : ''}</span></button>`).join('')}</div>
      <div class="opp-btns"><button class="opp-cancel" data-act="cancel">やめる</button><button class="opp-go" data-act="ok">この相手で試合開始</button></div>
      <p class="opp-help">↑↓ えらぶ ・ Enter / Z 決定 ・ Esc / X もどる</p></div>`;
    wrap.querySelectorAll('.opp-row').forEach((b) => (b.onclick = () => { idx = Number(b.dataset.i); draw(); wrap.querySelector('.opp-row.sel')?.focus(); }));
    wrap.querySelector('[data-act="cancel"]').onclick = closeOppModal;
    wrap.querySelector('[data-act="ok"]').onclick = confirm;
  };
  const confirm = () => { opponentTeamId = opts[idx].id; closeOppModal(); go('game', { confirmed: true }); };
  stage.appendChild(wrap);
  oppModal = {
    el: wrap,
    key(key) {
      if (key === 'up') { idx = (idx + opts.length - 1) % opts.length; draw(); }
      else if (key === 'down') { idx = (idx + 1) % opts.length; draw(); }
      else if (key === 'enter' || key === 'z') confirm();
      else if (key === 'esc' || key === 'x') closeOppModal();
    },
  };
  draw();
  wrap.querySelector('.opp-row.sel')?.focus();
}

function gameCtx() {
  const teams = ctx.teams;
  const user = teams.find((t) => t.id === userTeamId) || teams[0];
  const ui = teams.indexOf(user);
  // 相手: 前に選んだチーム、無ければ一覧で自分の次のチーム（赤 → 青）
  const next = teams.length > 1 ? teams[(ui + 1) % teams.length] : null;
  const opp = teams.find((t) => t.id === opponentTeamId && t.id !== user.id) || (next && next.id !== user.id ? next : teams.find((t) => t.id !== user.id));
  return { ...ctx, teams: [user, opp], userTeamId: user.id, opponentTeamId: opp?.id ?? null };
}

function go(name, payload) {
  if (OPPONENT_PICKER && name === 'game' && !(payload && payload.confirmed)) { openOppModal(); return; }
  closeOppModal();
  if (editScreen) { try { editScreen.destroy(); } catch (e) { console.error(e); } editScreen = null; }
  if (gameScreen) { try { gameScreen.destroy(); } catch (e) { console.error(e); } gameScreen = null; }
  current = name;
  document.body.dataset.screen = name;
  try {
    if (name === 'title') music.play('title');
    else if (name === 'team' || name === 'teamedit') music.play('title');
    else if (name === 'settings') music.play('settings');
    else if (name === 'game') music.play('game');
    else if (name === 'result') {
      let won = false;
      try {
        const R = boxScore(payload).R; // [away, home]
        const side = payload.userSide || 'away';
        won = side === 'away' ? R[0] > R[1] : R[1] > R[0];
      } catch (e) { /* ignore */ }
      music.play(won ? 'result_win' : 'result_lose');
    }
  } catch (e) { console.error(e); }
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  const el = screens[name];
  el.innerHTML = '';
  fitStage(); // 縦向きは画面ごとにステージの大きさが違う。描画の前に合わせる（試合画面の文字幅の計算などのため）
  if (name === 'title') { renderTitle(el, ctx); addFullscreenButton(el); }
  else if (name === 'team') renderTeam(el, ctx);
  else if (name === 'settings') renderSettings(el, ctx);
  else if (name === 'teamedit') editScreen = renderTeamEdit(el, ctx);
  else if (name === 'game') {
    gameScreen = createGameScreen(el, gameCtx());
    gameScreen.start();
  } else if (name === 'result') renderResult(el, ctx, boxScore(payload), payload);
  hud.sync();
  fitStage(); // 縦向きでは画面ごとにステージの形が変わる
}

/** タイトルの「全画面」ボタン（Fullscreen API があり、まだ全画面・ホーム画面アプリでないときだけ） */
function addFullscreenButton(el) {
  if (!canFullscreen() || isFullscreenOrStandalone()) return;
  const host = el.querySelector('.title') || el;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fs-btn';
  b.setAttribute('aria-label', '全画面で遊ぶ');
  b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>全画面</span>';
  b.onclick = async () => { await enterFullscreen(); b.remove(); };
  host.appendChild(b);
}
const onFullscreenChange = () => {
  fitStage();
  if (current === 'title' && isFullscreenOrStandalone()) screens.title.querySelector('.fs-btn')?.remove();
};
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  z: 'z', Z: 'z', x: 'x', X: 'x', Enter: 'enter', Escape: 'esc',
  s: 'steal', S: 'steal', c: 'bunt', C: 'bunt',
  v: 'center', V: 'center', Shift: 'center', // ミートカーソルを中心へ戻す
};

function typingTarget(e) {
  const t = e.target;
  return !!(t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

window.addEventListener('keydown', (e) => {
  if (document.body.classList.contains('challenge-open')) return;
  if (typingTarget(e)) return;
  if (oppModal) {
    const k = KEYMAP[e.key];
    if (k || e.key === ' ') { e.preventDefault(); if (k) oppModal.key(k); }
    return;
  }
  const key = KEYMAP[e.key];
  if (current === 'game' && (key === 'up' || key === 'down' || key === 'left' || key === 'right' || e.key === ' ')) e.preventDefault();
  if (!key) return;
  if (current === 'title') {
    if (isGuideOpen()) { if (key === 'enter' || key === 'esc' || key === 'z' || key === 'x') { e.preventDefault(); closeGuide(); } }
    else if (key === 'enter' && !(e.target.closest && e.target.closest('button'))) go('game');
  }
  else if (current === 'team' || current === 'settings') { if (key === 'esc') go('title'); }
  else if (current === 'teamedit') { if (editScreen) { if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault(); editScreen.handleKey(key); } }
  else if (current === 'game') {
    // Esc is plain navigation input unless the game screen is capturing it itself.
    if (gameScreen) gameScreen.handleKey(key);
  }
  else if (current === 'result') {
    if (key === 'enter') go('game');
    else if (key === 'esc') go('title');
  }
});

window.addEventListener('keyup', (e) => {
  if (typingTarget(e) || oppModal) return;
  const key = KEYMAP[e.key];
  if (!key || current !== 'game' || !gameScreen) return;
  try { gameScreen.handleKeyUp?.(key); } catch (err) { console.error(err); }
});

const touch = initTouch({ stage, wrap, getGame: () => gameScreen, getCurrent: () => current, getScale: () => stageScale });

window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', () => { fitStage(); setTimeout(fitStage, 250); });
window.visualViewport?.addEventListener('resize', fitStage);
window.addEventListener('load', fitStage);
fitStage();
go('title');

/* ---------- オフライン用 service worker（https か localhost のときだけ） ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker:', e));
  });
}
