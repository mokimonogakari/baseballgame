import { TEAMS } from './data.js';
import { renderTitle, renderTeam, renderResult, renderSettings } from './screens.js';
import { createGameScreen } from './game.js';
import { boxScore } from './engine.js';
import { createSound } from './sound.js';

const stage = document.getElementById('stage');
const screens = {};
document.querySelectorAll('.screen').forEach((s) => (screens[s.dataset.screen] = s));

let userTeamId = 'red';
let current = null;
let gameScreen = null;

function fitStage() {
  const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  stage.style.setProperty('--scale', scale);
}

const SETTINGS_KEY = 'dokidoki.settings';
const DEFAULTS = { innings: 9, difficulty: 'normal', sound: true };
function loadSettings() {
  const out = { ...DEFAULTS };
  try {
    const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if ([3, 6, 9].includes(o.innings)) out.innings = o.innings;
    if (['easy', 'normal', 'hard'].includes(o.difficulty)) out.difficulty = o.difficulty;
    if (typeof o.sound === 'boolean') out.sound = o.sound;
  } catch (e) { /* ignore */ }
  return out;
}
const settings = loadSettings();
const sound = createSound({ enabled: settings.sound });
function saveSettings(patch) {
  Object.assign(settings, patch || {});
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  sound.setEnabled(settings.sound);
}
const unlockOnce = () => { sound.unlock(); window.removeEventListener('pointerdown', unlockOnce); window.removeEventListener('keydown', unlockOnce); };
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);
stage.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('button, a');
  if (t && !t.disabled) sound.play('decide');
});

const ctx = {
  sound, settings, saveSettings,
  teams: TEAMS,
  get userTeamId() { return userTeamId; },
  setUserTeam(id) { if (TEAMS.some((t) => t.id === id)) userTeamId = id; },
  go,
  onGameOver(state) { go('result', state); },
};

function go(name, payload) {
  if (gameScreen) { try { gameScreen.destroy(); } catch (e) { console.error(e); } gameScreen = null; }
  current = name;
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  const el = screens[name];
  el.innerHTML = '';
  if (name === 'title') renderTitle(el, ctx);
  else if (name === 'team') renderTeam(el, ctx);
  else if (name === 'settings') renderSettings(el, ctx);
  else if (name === 'game') {
    gameScreen = createGameScreen(el, ctx);
    gameScreen.start();
  } else if (name === 'result') renderResult(el, ctx, boxScore(payload), payload);
}

const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  z: 'z', Z: 'z', x: 'x', X: 'x', Enter: 'enter', Escape: 'esc',
};

window.addEventListener('keydown', (e) => {
  const key = KEYMAP[e.key];
  if (current === 'game' && (key === 'up' || key === 'down' || key === 'left' || key === 'right' || e.key === ' ')) e.preventDefault();
  if (!key) return;
  if (current === 'title') { if (key === 'enter') go('game'); }
  else if (current === 'team' || current === 'settings') { if (key === 'esc') go('title'); }
  else if (current === 'game') { if (gameScreen) gameScreen.handleKey(key); }
  else if (current === 'result') {
    if (key === 'enter') go('game');
    else if (key === 'esc') go('title');
  }
});

window.addEventListener('resize', fitStage);
window.addEventListener('load', fitStage);
fitStage();
go('title');
