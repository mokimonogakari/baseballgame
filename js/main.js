import { TEAMS } from './data.js';
import { renderTitle, renderTeam, renderResult, renderSettings } from './screens.js';
import { createGameScreen } from './game.js';
import { boxScore } from './engine.js';
import { renderTeamEdit, loadMyTeam, MY_TEAM_ID } from './teamedit.js';
import { createSound } from './sound.js';
import { createMusic } from './music.js';

const stage = document.getElementById('stage');
const screens = {};
document.querySelectorAll('.screen').forEach((s) => (screens[s.dataset.screen] = s));

let userTeamId = 'red';
let current = null;
let gameScreen = null;
let editScreen = null;
let myTeam = loadMyTeam();
let opponentTeamId = null;
let oppModal = null;

function fitStage() {
  const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  stage.style.setProperty('--scale', scale);
}

const SETTINGS_KEY = 'dokidoki.settings';
const DEFAULTS = { innings: 9, difficulty: 'normal', sound: true, music: true, musicVolume: 0.7 };
function loadSettings() {
  const out = { ...DEFAULTS };
  try {
    const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if ([3, 6, 9].includes(o.innings)) out.innings = o.innings;
    if (['easy', 'normal', 'hard'].includes(o.difficulty)) out.difficulty = o.difficulty;
    if (typeof o.sound === 'boolean') out.sound = o.sound;
    if (typeof o.music === 'boolean') out.music = o.music;
    if (typeof o.musicVolume === 'number' && o.musicVolume >= 0 && o.musicVolume <= 1) out.musicVolume = o.musicVolume;
  } catch (e) { /* ignore */ }
  return out;
}
const settings = loadSettings();
const sound = createSound({ enabled: settings.sound });
const music = createMusic({ enabled: settings.music, volume: settings.musicVolume });
function saveSettings(patch) {
  Object.assign(settings, patch || {});
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  sound.setEnabled(settings.sound);
  music.setEnabled(settings.music);
  music.setVolume(settings.musicVolume);
}
const unlockOnce = () => { sound.unlock(); music.unlock(); window.removeEventListener('pointerdown', unlockOnce); window.removeEventListener('keydown', unlockOnce); };
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);
stage.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('button, a');
  if (t && !t.disabled) sound.play('decide');
});

const ctx = {
  sound, music, settings, saveSettings,
  get teams() { return myTeam ? [...TEAMS, myTeam] : TEAMS; },
  get userTeamId() { return userTeamId; },
  get opponentTeamId() { return opponentTeamId; },
  set opponentTeamId(id) { opponentTeamId = id; },
  setUserTeam(id) { if (ctx.teams.some((t) => t.id === id)) userTeamId = id; },
  setMyTeam(team) { myTeam = team && team.id === MY_TEAM_ID ? team : null; if (!myTeam && userTeamId === MY_TEAM_ID) userTeamId = TEAMS[0].id; },
  go,
  onGameOver(state) { go('result', state); },
};

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
  let opp = teams.find((t) => t.id === opponentTeamId && t.id !== user.id) || teams.find((t) => t.id !== user.id);
  return { ...ctx, teams: [user, opp], userTeamId: user.id };
}

function go(name, payload) {
  if (name === 'game' && !(payload && payload.confirmed)) { openOppModal(); return; }
  closeOppModal();
  if (editScreen) { try { editScreen.destroy(); } catch (e) { console.error(e); } editScreen = null; }
  if (gameScreen) { try { gameScreen.destroy(); } catch (e) { console.error(e); } gameScreen = null; }
  current = name;
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
  if (name === 'title') renderTitle(el, ctx);
  else if (name === 'team') renderTeam(el, ctx);
  else if (name === 'settings') renderSettings(el, ctx);
  else if (name === 'teamedit') editScreen = renderTeamEdit(el, ctx);
  else if (name === 'game') {
    gameScreen = createGameScreen(el, gameCtx());
    gameScreen.start();
  } else if (name === 'result') renderResult(el, ctx, boxScore(payload), payload);
}

const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  z: 'z', Z: 'z', x: 'x', X: 'x', Enter: 'enter', Escape: 'esc',
  s: 'steal', S: 'steal', c: 'bunt', C: 'bunt',
};

function typingTarget(e) {
  const t = e.target;
  return !!(t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

window.addEventListener('keydown', (e) => {
  if (typingTarget(e)) return;
  if (oppModal) {
    const k = KEYMAP[e.key];
    if (k || e.key === ' ') { e.preventDefault(); if (k) oppModal.key(k); }
    return;
  }
  const key = KEYMAP[e.key];
  if (current === 'game' && (key === 'up' || key === 'down' || key === 'left' || key === 'right' || e.key === ' ')) e.preventDefault();
  if (!key) return;
  if (current === 'title') { if (key === 'enter') go('game'); }
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

window.addEventListener('resize', fitStage);
window.addEventListener('load', fitStage);
fitStage();
go('title');
