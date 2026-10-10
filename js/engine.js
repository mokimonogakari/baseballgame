/**
 * 試合エンジン（ドキドキベースボール）
 * すべて純粋関数・DOM 非依存。乱数は引数 rng で注入（既定 Math.random）。
 * 入力 state は決して変更しない（structuredClone した新 state を返す）。
 * 打席判定は docs/BALANCE.md の係数表・能力補正・投球位置モデルに従う。
 * 打球・守備・走塁・選手交代の API は docs/ENGINE-API.md を参照。
 */
import { PITCH_TYPES, PITCH_DIRECTIONS, SKILLS, playerCost } from './data.js';

export { PITCH_DIRECTIONS, SKILLS, playerCost };

/* ------------------------------------------------------------------ */
/* 定数・係数                                                          */
/* ------------------------------------------------------------------ */

/** 打席結果の並び（係数表の列順） */
export const OUTCOMES = ['ball', 'strike', 'foul', 'groundout', 'flyout', 'single', 'double', 'triple', 'hr'];

/** スイング時の結果確率表 [mode][距離0-2][タイミング帯0-2]（BALANCE.md draft-1） */
export const SWING_TABLE = {
  meet: [
    [[0, 10, 18, 24, 20, 20, 6, 1, 1], [0, 24, 24, 22, 17, 10, 2, 0, 1], [0, 55, 25, 11, 6, 2, 1, 0, 0]],
    [[0, 28, 25, 22, 15, 8, 2, 0, 0], [0, 43, 27, 16, 10, 3, 1, 0, 0], [0, 72, 20, 5, 2, 1, 0, 0, 0]],
    [[0, 70, 20, 6, 3, 1, 0, 0, 0], [0, 84, 12, 3, 1, 0, 0, 0, 0], [0, 95, 4, 1, 0, 0, 0, 0, 0]],
  ],
  power: [
    [[0, 20, 18, 19, 19, 12, 6, 1, 5], [0, 36, 24, 16, 16, 4, 2, 0, 2], [0, 68, 20, 5, 5, 1, 0, 0, 1]],
    [[0, 42, 24, 14, 13, 3, 2, 0, 2], [0, 57, 25, 8, 8, 1, 0, 0, 1], [0, 82, 14, 2, 2, 0, 0, 0, 0]],
    [[0, 80, 14, 3, 2, 0, 0, 0, 1], [0, 91, 7, 1, 1, 0, 0, 0, 0], [0, 97, 3, 0, 0, 0, 0, 0, 0]],
  ],
};

/**
 * 調整用係数（50試合シミュレーション tests/balance.mjs で調整済み）
 * BALANCE.md の能力補正式の係数と、ゾーン外スイング補正・CPU打者/投手の傾向、打球・守備・走塁モデル。
 * draft-1 からの変更: sigmaBase 0.45→0.72（四球が出なかったため）、foulBase 1.6（ファウル重み増で
 * 打席を長くし四球・三振を確保）、singleC 0.35→0.30→0.20（安打過多の抑制。打球・守備モデル導入時に再調整）。
 * 打球・守備: pivot（併殺の中継時間）1.45 で併殺 約2個/試合。
 */
export const TUNING = {
  strikeC: -0.65, strikeV: 0.35, strikeD: 0.25,
  foulC: 0.15, foulBase: 1.6,
  singleC: 0.20, singleP: -0.15,
  doubleC: 0.35, doubleP: 0.35,
  tripleC: 0.35, tripleP: 0.15,
  hrC: 0.35, hrP: 0.85,
  outZoneStrike: 1.4, outZoneOther: 0.7,
  sigmaBase: 0.72, sigmaK: 0.20,
  // CPU 打者
  swingInZone: [0.72, 0.80, 0.92], swingOutZone: [0.18, 0.24, 0.36],
  guessNoiseBase: 0.0, guessNoiseContact: 0.55,
  timingBase: 0.08, timingVel: 0.15, timingContact: 0.25, timingRead: 0.25,
  powerModeRate: 0.40,
  // CPU 投手（コーナーを狙う確率）
  cornerBase: 0.35, cornerTwoStrike: 0.75, cornerThreeBall: 0.30, centerThreeBall: 0.25, breakAimFix: 0.3,
  wasteBase: 0.4, wasteTwoStrike: 0.5, wasteOffset: 0.6, wasteThreeBall: 0.1,
  // 打球の物理
  gravity: 9.8, rollFly: 0.4, rollLiner: 0.55, rollPopup: 0.2, rollDecel: 6, groundDecel: 5.5, groundSpeedFactor: 0.8,
  ballTries: 14, // 打席判定結果（intendedOutcome）と一致する打球を探す試行回数
  // 走塁（打者の一塁到達 4.6〜4.9 秒、走者は m/s）
  bat1BFast: 4.6, bat1BSlow: 4.9, batLegBase: 6.3, batLegSpeed: 1.6,
  runBase: 7.0, runSpeed: 1.6, runLead: 4.0, rounding: 0.2,
  runMargin: 0.2, runMargin2: 0.0, runAggro: 0.3, tagMargin: 0.25, tagTime: 0.15,
  linerDelay: 0.5, flyDelay: 0.25, flyDelayMax: 1.2,
  // 守備
  fielderReact: 0.45, fielderReactF: 0.2, fielderRun: 5.8, fielderRunS: 1.4, fielderRunF: 0.8,
  reachGround: 1.0, reachAir: 1.3, reachF: 0.6, catchHeight: 2.8,
  secureIF: 0.25, secureOF: 0.7, secureWall: 0.5,
  throwV0: 24, throwVArm: 12, transferIF: 0.7, transferOF: 1.0, longThrow: 0.02, longFrom: 40,
  pivot: 1.45, throwNoise: 0.2, throwAdvance: 1.4,
  pitcherReact: 0.35, pitcherReach: 0.6,
  errBase: 0.012, errDelay: 1.5, offPosPenalty: 25,
  // ミートカーソル（連続座標の打撃入力 batInput.pos）
  cursorMin: 0.35, cursorMax: 0.85, cursorRy: 0.75, cursorCore: 0.3, cursorPower: 0.7, cursorBunt: 1.1,
  cursorDist: 1.9, cursorCoreN: 0.15, cursorRim: 0.15, rimFoul: 0.5, vyK: 0.45, trajLift: 0.15,
  timingDir: 20, hxDir: 10, oppoDir: 8,
  posNoiseBase: 0.02, posNoiseContact: 0.32,
  // バント
  buntFoul: 0.22, buntFoulNd: 0.22, buntFoulC: 0.10, buntPop: 0.05, buntPopNd: 0.07, buntRimFoul: 0.7,
  // 盗塁（秒・m）
  stealLead1: 3.6, stealLead2: 5.5, stealJump: 0.30, stealSlide: 0.10, stealNoise: 0.08,
  stealDelivery: 1.35, stealBreaking: 0.10, stealPop: 0.85, stealPopC: 0.25, stealTag: 0.15, stealWild: 0.25,
  runningLead: 6.0,
  cpuStealSpeed: 75, cpuStealRate: 0.35, cpuStealDeficit: 3, cpuStealMin: 0.55,
  // CPU 采配
  phInning: 7, phMargin: 10, phWeak: 108, phRate: 0.75, prInning: 8, prSlow: 55, prFast: 80, prRate: 0.8,
};

/**
 * 調子（createGame で全選手に割り当て、state.condition[playerId]）。
 * mult: 野手はミート・パワー（ミートカーソルの大きさも）、投手はコントロール・球威（球速能力）に掛かる倍率。
 * weight: 抽選の重み（10/25/35/20/10）。キーの並びが良い順。
 */
export const CONDITIONS = {
  絶好調: { label: '絶好調', mult: 1.10, arrow: '↑', color: '#FF4FA3', weight: 10 },
  好調: { label: '好調', mult: 1.05, arrow: '↗', color: '#F57C00', weight: 25 },
  普通: { label: '普通', mult: 1.00, arrow: '→', color: '#FDD835', weight: 35 },
  不調: { label: '不調', mult: 0.95, arrow: '↘', color: '#1E88E5', weight: 20 },
  絶不調: { label: '絶不調', mult: 0.90, arrow: '↓', color: '#7E57C2', weight: 10 },
};
/** 調子のラベル（良い順） */
export const CONDITION_LABELS = Object.keys(CONDITIONS);

/**
 * 特殊能力の効果（打席結果の重み倍率など）。キー:
 *   strike=空振り, foul, go=ゴロアウト, fo=フライアウト, single, double, triple, hr, hits=安打4種すべて（OUTCOMES の重みに乗算後に正規化）
 *   cursor=ミートカーソルの大きさ倍率, sigma=制球誤差の倍率, swingOut=CPU のボール球スイング率倍率
 *   when: 発動条件（docs/ENGINE-API.md 参照）
 * 盗塁・走塁・守備・バントの効果は STEAL/送球などの各処理に記述（SKILL_FX の数値を参照）。
 */
export const SKILL_FX = {
  // 打者
  'チャンス◎': { when: 'risp', hits: 1.15, strike: 0.90 },
  'チャンス×': { when: 'risp', hits: 0.87, strike: 1.10 },
  '対左投手◎': { when: 'vsLHP', hits: 1.12, strike: 0.92 },
  'パワーヒッター': { hr: 1.30, fo: 1.10, go: 0.90, lift: 0.15 },
  'アベレージヒッター': { single: 1.12, double: 1.08 },
  '広角打法': { hr: 1.10, double: 1.05, noPull: true },
  '流し打ち': { single: 1.06, oppo: 8 },
  '初球○': { when: 'firstPitch', hits: 1.20, strike: 0.90 },
  '粘り打ち': { when: 'twoStrikes', foul: 1.40, strike: 0.85 },
  'バント◎': { buntFoul: -0.10, buntPop: -0.03 },
  '選球眼': { swingOut: 0.75 },
  '三振': { strike: 1.15 },
  '併殺': { when: 'dpChance', go: 1.15, to1B: 0.12 },
  'エラー': { error: 2.0 },
  '送球◎': { throwV: 3, transfer: 0.08 },
  '盗塁◎': { stealJump: 0.12, cpuSteal: 10 },
  '走塁◎': { runSpeed: 10, margin: 0.10 },
  'キャッチャー◎': { pop: 0.06 },
  '天才打者': { strike: 0.80, hits: 1.15, foul: 1.10, cursor: 1.10 },
  '怪力': { hr: 1.60, double: 1.15 },
  // 投手
  'ノビ◎': { when: 'fastball', strike: 1.25, fo: 1.10, hits: 0.92 },
  'キレ◎': { when: 'breaking', strike: 1.20 },
  '奪三振': { when: 'twoStrikes', strike: 1.15 },
  '対ピンチ◎': { when: 'risp', hits: 0.88, strike: 1.10 },
  '重い球': { hr: 0.70, double: 0.85, go: 1.10 },
  'クイック◎': { delivery: 0.15 },
  '牽制◎': { lead: 0.8 },
  '打たれ強さ◎': { when: 'runners', hits: 0.94 },
  '低め◎': { when: 'low', go: 1.10, sigmaLow: 0.85 },
  '対左打者◎': { when: 'vsLHB', hits: 0.90, strike: 1.08 },
  '一発': { hr: 1.40 },
  '四球': { sigma: 1.15 },
  'スロースターター': { when: 'early', hits: 1.08, sigma: 1.10 },
  '怪物球威': { strike: 1.20, hits: 0.88, hr: 0.60 },
};
const FX_IDX = { strike: [1], foul: [2], go: [3], fo: [4], single: [5], double: [6], triple: [7], hr: [8], hits: [5, 6, 7, 8] };

/** 絶好調で打ち消される赤特 */
export const CONDITION_CANCEL_RED = ['三振', 'チャンス×', '四球', 'スロースターター', '一発'];
/** 絶不調でも有効な青特（走塁・守備系）。それ以外の青特は絶不調で無効 */
export const CONDITION_KEEP_BLUE = ['盗塁◎', '走塁◎', '送球◎', 'キャッチャー◎', 'クイック◎', '牽制◎', 'バント◎'];

/**
 * 選手の特殊能力が有効か（調子による打ち消しを反映。state 省略時は持っていれば有効）。
 * 絶好調: CONDITION_CANCEL_RED の赤特が無効。絶不調: CONDITION_KEEP_BLUE 以外の青特・金特が無効。
 */
function skillOn(p, name, s = null) {
  if (!p?.skills?.includes(name)) return false;
  const c = s?.condition?.[p.id];
  if (c === '絶好調' && CONDITION_CANCEL_RED.includes(name)) return false;
  if (c === '絶不調' && SKILLS[name]?.type !== 'red' && !CONDITION_KEEP_BLUE.includes(name)) return false;
  return true;
}
/**
 * 選手の有効な特殊能力の一覧（調子による打ち消し後）
 * @param {object} state
 * @param {object} player
 * @returns {string[]}
 */
export function activeSkills(state, player) {
  return (player?.skills || []).filter((n) => skillOn(player, n, state));
}
const hasSkill = (p, name, s = null) => skillOn(p, name, s);
/** 特殊能力の数値（持っていなければ def） */
const fxNum = (p, name, key, def = 0, s = null) => (skillOn(p, name, s) ? SKILL_FX[name][key] : def);

/** シード付き乱数（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 文字列 → 32bit ハッシュ（既定の調子シード） */
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 選手の調子（state.condition。未設定なら '普通'）
 * @param {object} state
 * @param {string} playerId
 * @returns {'絶好調'|'好調'|'普通'|'不調'|'絶不調'}
 */
export function conditionOf(state, playerId) {
  const c = state?.condition?.[playerId];
  return CONDITIONS[c] ? c : '普通';
}
/** 調子の倍率 */
const condMult = (s, id) => CONDITIONS[s?.condition?.[id]]?.mult ?? 1;

/** 守備位置（打順表示・守備交代で使う記号） */
export const POSITIONS = ['投', '捕', '一', '二', '三', '遊', '左', '中', '右'];
/** 守備位置の読み */
export const POS_NAMES = {
  投: 'ピッチャー', 捕: 'キャッチャー', 一: 'ファースト', 二: 'セカンド', 三: 'サード',
  遊: 'ショート', 左: 'レフト', 中: 'センター', 右: 'ライト',
};
const INFIELD = ['投', '捕', '一', '二', '三', '遊'];
const BASE_NAMES = { 1: '一塁', 2: '二塁', 3: '三塁', 4: 'ホーム' };

/**
 * フィールド座標（メートル）。本塁 (0,0)、+y がセンター方向、+x が一塁（ライト）側。
 * fence(dirDeg) は fenceDistance() を参照（両翼 98m、中堅 122m を角度で線形補間）。
 */
export const FIELD = {
  home: { x: 0, y: 0 },
  bases: { 1: { x: 19.4, y: 19.4 }, 2: { x: 0, y: 38.8 }, 3: { x: -19.4, y: 19.4 }, 4: { x: 0, y: 0 } },
  mound: { x: 0, y: 18.4 },
  baseDistance: 27.4,
  fenceLine: 98,
  fenceCenter: 122,
  foulAngle: 45,
};

/** 守備位置ごとの標準ポジショニング（通常守備） */
export const DEFAULT_POSITIONS = {
  投: { x: 0, y: 18.4 },
  捕: { x: 0, y: -1.5 },
  一: { x: 17, y: 25 },
  二: { x: 11, y: 38 },
  三: { x: -17, y: 25 },
  遊: { x: -11, y: 38 },
  左: { x: -28, y: 80 },
  中: { x: 0, y: 92 },
  右: { x: 28, y: 80 },
};

/**
 * 打球方向のフェンスまでの距離（m）
 * @param {number} dirDeg -45=三塁線 … 0=センター … +45=一塁線
 */
export function fenceDistance(dirDeg) {
  const a = Math.min(FIELD.foulAngle, Math.abs(dirDeg));
  return FIELD.fenceLine + (FIELD.fenceCenter - FIELD.fenceLine) * (1 - a / FIELD.foulAngle);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const other = (side) => (side === 'away' ? 'home' : 'away');
const sum = (a) => a.reduce((x, y) => x + y, 0);
const hyp = (p) => Math.hypot(p.x, p.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r2 = (v) => Math.round(v * 100) / 100;
const uni = (rng, a, b) => a + (b - a) * rng();
/** 名字（表示用）: '赤城 大地' → '赤城' */
const fam = (p) => String(p?.name ?? '').split(/[ 　]/)[0];

/** 正規乱数（Box-Muller、rng 注入） */
function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 重み配列からインデックスを抽選 */
function pickWeighted(weights, rng) {
  const total = sum(weights);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/**
 * 球速 km/h → 能力値 1-99
 * @param {number} kmh
 */
export function velocityAbility(kmh) {
  return clamp(Math.round(((kmh - 120) / 50) * 99), 1, 99);
}

/* ------------------------------------------------------------------ */
/* 状態の参照                                                          */
/* ------------------------------------------------------------------ */

/** 攻撃側 'away'|'home' */
const battingSide = (s) => (s.half === 'top' ? 'away' : 'home');
/** 守備側 */
const fieldingSide = (s) => (s.half === 'top' ? 'home' : 'away');

/** 攻撃中のチーム側 'away'|'home' */
export function battingSideOf(state) { return battingSide(state); }
/** 守備中のチーム側 'away'|'home' */
export function fieldingSideOf(state) { return fieldingSide(state); }

function findPlayer(team, id) {
  return team.players.find((p) => p.id === id);
}

/**
 * state の複製（純粋関数の入口で使う）。ログの各イベント・選手オブジェクト・打球はエンジンが
 * 変更しない不変データとして新旧 state で共有し、それ以外を深く複製する（structuredClone より高速）。
 */
function cloneState(st) {
  const { log, teams, pending, ...rest } = st;
  const s = structuredClone(rest);
  s.log = log.slice();
  const ct = (t) => ({ ...t, lineup: [...t.lineup], pitchers: [...t.pitchers], bench: [...(t.bench || [])] });
  s.teams = { away: ct(teams.away), home: ct(teams.home) };
  s.pending = pending ? { ...pending, event: structuredClone(pending.event) } : null;
  return s;
}

/** 両チームから選手を検索 */
function anyPlayer(s, id) {
  return findPlayer(s.teams.away, id) || findPlayer(s.teams.home, id) || null;
}

/** 合計得点 */
const total = (s, side) => sum(s.score[side]);

/** チームの控え野手 id（data に bench が無ければ 打順・投手以外） */
function benchOf(team) {
  if (Array.isArray(team.bench)) return team.bench;
  return team.players.filter((p) => !team.lineup.includes(p.id) && !team.pitchers.includes(p.id) && !p.pitching).map((p) => p.id);
}

/**
 * 新しい試合を作成
 * @param {object} homeTeam 後攻チーム
 * @param {object} awayTeam 先攻チーム
 * @param {{innings?:number, userSide?:'away'|'home'|null, rng?:()=>number, seed?:number, conditions?:Object<string,string>}} [opts]
 *   rng: 調子の抽選に使う乱数（省略時は seed、seed も省略時はチーム id から決まる固定シード）。
 *   conditions: { playerId: '絶好調'|… } で調子を上書き（指定した選手のみ）。
 * @returns {object} GameState
 */
export function createGame(homeTeam, awayTeam, { innings = 9, userSide = 'away', rng, seed, conditions } = {}) {
  const teams = { away: structuredClone(awayTeam), home: structuredClone(homeTeam) };
  const stats = {};
  const stamina = {};
  const condition = {};
  const positions = { away: {}, home: {} };
  const crng = typeof rng === 'function' ? rng
    : mulberry32(seed != null ? Number(seed) : hashStr(`${teams.away.id}|${teams.home.id}`));
  const cw = CONDITION_LABELS.map((k) => CONDITIONS[k].weight);
  for (const side of ['away', 'home']) {
    const team = teams[side];
    team.bench = [...benchOf(team)];
    for (const p of team.players) {
      stats[p.id] = { ab: 0, h: 0, hr: 0, rbi: 0, so: 0, bb: 0, ip_outs: 0, er: 0, k: 0, sb: 0, cs: 0, sh: 0 };
      if (p.pitching) stamina[p.id] = p.pitching.stamina;
      condition[p.id] = CONDITION_LABELS[pickWeighted(cw, crng)];
      if (conditions && CONDITIONS[conditions[p.id]]) condition[p.id] = conditions[p.id];
    }
    for (const id of team.lineup) {
      const p = findPlayer(team, id);
      positions[side][id] = id === team.pitchers[0] ? '投' : p.pos;
    }
  }
  return {
    inning: 1, half: 'top', outs: 0, balls: 0, strikes: 0, bases: [null, null, null],
    innings, maxInnings: innings + 3,
    score: { away: [0], home: [] }, hits: { away: 0, home: 0 }, errors: { away: 0, home: 0 },
    batterIndex: { away: 0, home: 0 }, pitcherIndex: { away: 0, home: 0 }, pitchCount: { away: 0, home: 0 },
    stamina, stats, log: [], over: false,
    // 勝敗投手判定用
    decision: null, // { side, win, lose } 現在リードしている側と責任投手
    entries: { [teams.away.pitchers[0]]: { side: 'away', lead: 0 }, [teams.home.pitchers[0]]: { side: 'home', lead: 0 } },
    // 守備位置 { side: { playerId: '投'|'捕'|… } }（打順の9人のみ）
    positions,
    // 交代で退いた選手（再出場不可）
    removed: { away: [], home: [] },
    // 自動で登板させた投手（1球も投げる前なら changePitcher で退いても removed にしない）
    provisional: { away: null, home: null },
    pending: null, ballSeq: 0,
    // 調子 { playerId: '絶好調'|'好調'|'普通'|'不調'|'絶不調' }
    condition,
    // 盗塁の予約（attemptSteal）。次の pitchContact で解決
    pendingSteal: null,
    teams, userSide,
  };
}

/**
 * 現在の打者
 * @param {object} state
 */
export function getBatter(state) {
  const side = battingSide(state);
  const team = state.teams[side];
  return findPlayer(team, team.lineup[state.batterIndex[side] % team.lineup.length]);
}

/**
 * 現在の投手
 * @param {object} state
 */
export function getPitcher(state) {
  const side = fieldingSide(state);
  const team = state.teams[side];
  return findPlayer(team, team.pitchers[state.pitcherIndex[side]]);
}

/** 指定チームの現在の投手 */
function currentPitcherOf(s, side) {
  const team = s.teams[side];
  return findPlayer(team, team.pitchers[s.pitcherIndex[side]]);
}

/**
 * 試合終了か
 * @param {object} state
 */
export function isGameOver(state) {
  return !!state.over;
}

/**
 * 表示用の要約
 * @param {object} state
 * @returns {{inningLabel:string,count:{b:number,s:number,o:number},bases:boolean[],runners:(null|{id:string,name:string,speed:number})[],score:{away:number,home:number},batting:'away'|'home',pending:boolean}}
 */
export function summary(state) {
  const side = battingSide(state);
  return {
    inningLabel: `${state.inning}回${state.half === 'top' ? '表' : '裏'}`,
    count: { b: state.balls, s: state.strikes, o: state.outs },
    bases: state.bases.map((b) => !!b),
    runners: state.bases.map((id) => {
      if (!id) return null;
      const p = findPlayer(state.teams[side], id) || anyPlayer(state, id);
      return p ? { id: p.id, name: p.name, speed: p.speed } : { id, name: '', speed: 50 };
    }),
    score: { away: total(state, 'away'), home: total(state, 'home') },
    batting: side,
    pending: !!state.pending,
    steal: state.pendingSteal ? { ...state.pendingSteal } : null,
  };
}

/* ------------------------------------------------------------------ */
/* 投球位置                                                            */
/* ------------------------------------------------------------------ */

/** 疲労による補正（スタミナ 20 未満で球速低下・制球悪化） */
function fatigue(s, pitcher) {
  const st = s.stamina?.[pitcher.id] ?? 50;
  return st < 20 ? (20 - st) / 20 : 0;
}

/** 投手の球種の変化量 level（持ち球に無ければ 3、ストレートは 0） */
function pitchLevel(pitcher, type) {
  if (type === 'fastball') return 0;
  return (pitcher?.pitching?.pitches || []).find((q) => q.type === type)?.level ?? 3;
}

/**
 * 球種の変化（ゾーンセル単位、打者カメラの画面で +x=右, +y=下）。変化量 level で拡大縮小し、左投手は dx を反転。
 * scale = 0.7 + 0.1 × level（level 3 = PITCH_TYPES の値、level 7 = ×1.4、level 1 = ×0.8、level 0 = ×0.4）
 * @param {object} pitcher 投手（throws, pitching.pitches, skills）
 * @param {string} type 球種
 * @returns {{dx:number, dy:number, level:number, dir:string, nobi:boolean}}
 */
export function pitchBreak(pitcher, type) {
  const pt = PITCH_TYPES[type] || PITCH_TYPES.fastball;
  const lv = pitchLevel(pitcher, PITCH_TYPES[type] ? type : 'fastball');
  const scale = type === 'fastball' ? 1 : lv <= 0 ? 0.4 : 0.7 + 0.1 * lv;
  const flip = pitcher?.throws === '左' ? -1 : 1;
  return {
    dx: pt.dx * scale * flip, dy: pt.dy * scale, level: lv,
    dir: pitchDirection(type, pitcher?.throws),
    nobi: type === 'fastball' && hasSkill(pitcher, 'ノビ◎'),
  };
}

const MIRROR = { '←': '→', '→': '←', '↙': '↘', '↘': '↙', '↑': '↑', '↓': '↓' };
/**
 * 球種の変化方向の矢印（パワプロ表記・投手目線）。左投手は左右反転。
 * @param {string} type
 * @param {'右'|'左'} [throws]
 */
export function pitchDirection(type, throws = '右') {
  const d = PITCH_DIRECTIONS[type] ?? '↑';
  return throws === '左' ? MIRROR[d] ?? d : d;
}

/**
 * 投球の実際の到達位置を計算（aim + 変化 + 制球誤差）。中心 (0,0)、ゾーン内は |x|,|y|<=1.5
 * 制球誤差 sigma = sigmaBase - sigmaK×k（k は コントロール×調子）＋疲労、特殊能力（四球・スロースターター・低め◎）で倍率。
 * @param {object} state
 * @param {{type:string, zone:{x:number,y:number}, offset?:{x:number,y:number}}} pitchInput offset=ボール球を狙う際の狙いのずらし（CPU用・任意）
 * @param {()=>number} [rng]
 * @returns {{x:number,y:number,inZone:boolean}}
 */
export function pitchLocation(state, pitchInput, rng = Math.random) {
  const pitcher = getPitcher(state);
  const type = PITCH_TYPES[pitchInput.type] ? pitchInput.type : 'fastball';
  const br = pitchBreak(pitcher, type);
  const ctl = (pitcher.pitching?.control ?? 50) * condMult(state, pitcher.id);
  const k = (ctl - 50) / 49;
  let sigma = TUNING.sigmaBase - TUNING.sigmaK * k + 0.12 * fatigue(state, pitcher);
  sigma *= fxNum(pitcher, '四球', 'sigma', 1, state);
  if (state.inning <= 2) sigma *= fxNum(pitcher, 'スロースターター', 'sigma', 1, state);
  if (pitchInput.zone.y >= 2) sigma *= fxNum(pitcher, '低め◎', 'sigmaLow', 1, state);
  const off = pitchInput.offset || { x: 0, y: 0 };
  const x = pitchInput.zone.x - 1 + (off.x || 0) + br.dx + gauss(rng) * sigma;
  const y = pitchInput.zone.y - 1 + (off.y || 0) + br.dy + gauss(rng) * sigma;
  return { x, y, inZone: Math.abs(x) <= 1.5 && Math.abs(y) <= 1.5 };
}

/** 位置→セル番号（ゾーン外は -1 や 3 になりうる） */
const cellOf = (v) => Math.round(v) + 1;

/* ------------------------------------------------------------------ */
/* 打席判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * ミートカーソルの大きさ（セル単位の楕円。中心 = batInput.pos）。
 * rx = 0.35 + 0.50 × (ミート×調子 - 1)/98（ミート1 → 0.35、99 → 0.85）、天才打者 ×1.10
 * mode: 'power' ×0.7、'bunt' ×1.1。ry = rx × 0.75、coreR（芯の円の半径）= rx × 0.3
 * @param {object} batter
 * @param {'meet'|'power'|'bunt'} [mode]
 * @param {object} [state] 調子を反映する場合
 * @returns {{rx:number, ry:number, coreR:number}}
 */
export function meetCursor(batter, mode = 'meet', state = null) {
  const T = TUNING;
  const c = (batter?.contact ?? 50) * (state ? condMult(state, batter?.id) : 1);
  let rx = T.cursorMin + (T.cursorMax - T.cursorMin) * clamp((c - 1) / 98, 0, 1);
  rx *= fxNum(batter, '天才打者', 'cursor', 1, state);
  if (mode === 'power') rx *= T.cursorPower;
  else if (mode === 'bunt') rx *= T.cursorBunt;
  return { rx: r3(rx), ry: r3(rx * T.cursorRy), coreR: r3(rx * T.cursorCore) };
}
const r3 = (v) => Math.round(v * 1000) / 1000;

/** 特殊能力の発動条件 */
function fxActive(when, ctx, batter, pitcher, type) {
  if (!when) return true;
  const s = ctx.state;
  switch (when) {
    case 'vsLHP': return pitcher?.throws === '左';
    case 'vsLHB': return batter?.bats === '左';
    case 'fastball': return type === 'fastball';
    case 'breaking': return !(PITCH_TYPES[type]?.fastballFamily);
    case 'low': return !!ctx.loc && ctx.loc.y > 0.5;
    default: break;
  }
  if (!s) return false;
  switch (when) {
    case 'risp': return !!(s.bases[1] || s.bases[2]);
    case 'runners': return s.bases.some(Boolean);
    case 'firstPitch': return s.balls === 0 && s.strikes === 0;
    case 'twoStrikes': return s.strikes === 2;
    case 'dpChance': return !!s.bases[0] && s.outs < 2;
    case 'early': return s.inning <= 2;
    default: return false;
  }
}

/** 特殊能力による打席結果の重み倍率（OUTCOMES 順） */
function skillMultipliers(batter, pitcher, type, ctx = {}) {
  const m = OUTCOMES.map(() => 1);
  for (const pl of [batter, pitcher]) {
    for (const name of pl?.skills || []) {
      const fx = SKILL_FX[name];
      if (!fx || !skillOn(pl, name, ctx.state)) continue;
      const def = SKILLS[name];
      if (def && def.target !== 'any' && def.target !== (pl === pitcher ? 'pitcher' : 'batter')) continue;
      if (!fxActive(fx.when, ctx, batter, pitcher, type)) continue;
      for (const [k, idx] of Object.entries(FX_IDX)) {
        if (fx[k] != null) for (const i of idx) m[i] *= fx[k];
      }
    }
  }
  return m;
}

/**
 * スイング結果の確率（正規化済み、OUTCOMES 順）
 * @param {object} batter
 * @param {object} pitcher
 * @param {string} type 球種
 * @param {'meet'|'power'} mode
 * @param {number} dist 0-2（小数可: 隣り合う距離帯の係数表を線形補間）
 * @param {number} band 0-2
 * @param {boolean} inZone
 * @param {number} [fat] 疲労 0-1
 * @param {{state?:object, loc?:{x:number,y:number}, batterCond?:number, pitcherCond?:number, skills?:boolean}} [ctx]
 *   state があれば調子と状況依存の特殊能力（得点圏・カウント等）を反映。skills:false で特殊能力を無視。
 */
export function swingProbabilities(batter, pitcher, type, mode, dist, band, inZone, fat = 0, ctx = {}) {
  const T = TUNING;
  const tbl = SWING_TABLE[mode === 'power' ? 'power' : 'meet'];
  const dd = clamp(Number(dist) || 0, 0, 2);
  const i0 = Math.floor(dd);
  const i1 = Math.min(2, i0 + 1);
  const fr = dd - i0;
  const row = tbl[i0][band].map((w, i) => w * (1 - fr) + tbl[i1][band][i] * fr);
  const st = ctx.state;
  const bc = ctx.batterCond ?? (st ? condMult(st, batter.id) : 1);
  const pc = ctx.pitcherCond ?? (st ? condMult(st, pitcher.id) : 1);
  const c = (batter.contact * bc - 50) / 49;
  const p = (batter.power * bc - 50) / 49;
  const kmh = (pitcher.pitching?.velocity ?? 135) - 4 * fat;
  const v = (velocityAbility(kmh) * pc - 50) / 49;
  const lv = pitchLevel(pitcher, type);
  const read = (PITCH_TYPES[type] || PITCH_TYPES.fastball).read + (type === 'fastball' ? 0 : 0.025 * (lv - 3));
  const d = read - 0.30;
  const mult = [1,
    Math.exp(T.strikeC * c + T.strikeV * v + T.strikeD * d),
    T.foulBase * Math.exp(T.foulC * c), 1, 1,
    Math.exp(T.singleC * c + T.singleP * p),
    Math.exp(T.doubleC * c + T.doubleP * p),
    Math.exp(T.tripleC * c + T.tripleP * p),
    Math.exp(T.hrC * c + T.hrP * p)];
  const sk = ctx.skills === false ? null : skillMultipliers(batter, pitcher, type, ctx);
  for (let i = 0; i < row.length; i++) {
    row[i] *= mult[i] * (sk ? sk[i] : 1);
    if (!inZone) row[i] *= i === 1 ? T.outZoneStrike : T.outZoneOther;
  }
  const t = sum(row);
  return row.map((w) => w / t);
}

/** 得点を加算し、打点・自責点・勝敗投手の情報を更新 */
function addRuns(s, n, batter, rbi = true, earned = true) {
  if (n <= 0) return;
  const bat = battingSide(s);
  const before = total(s, 'away') - total(s, 'home');
  s.score[bat][s.inning - 1] = (s.score[bat][s.inning - 1] || 0) + n;
  if (rbi) s.stats[batter.id].rbi += n;
  const pitcher = getPitcher(s);
  if (earned) s.stats[pitcher.id].er += n;
  const after = total(s, 'away') - total(s, 'home');
  const leaderBefore = Math.sign(before);
  const leaderAfter = Math.sign(after);
  if (leaderAfter === 0) s.decision = null;
  else if (leaderAfter !== leaderBefore) {
    s.decision = { side: bat, win: currentPitcherOf(s, bat).id, lose: pitcher.id };
  }
  // サヨナラ
  if (s.half === 'bottom' && s.inning >= s.innings && total(s, 'home') > total(s, 'away')) s.over = true;
}

/** アウトを記録 */
function addOut(s, n = 1) {
  const pitcher = getPitcher(s);
  const real = Math.min(n, 3 - s.outs);
  s.outs += real;
  s.stats[pitcher.id].ip_outs += real;
}

/** 押し出し型の進塁（四球）。bases は [id|null ×3]、打者 id が一塁へ。戻り値=生還数 */
function forceAdvance(bases, batterId) {
  let runs = 0;
  if (bases[0]) {
    if (bases[1]) {
      if (bases[2]) runs = 1;
      bases[2] = bases[1];
    }
    bases[1] = bases[0];
  }
  bases[0] = batterId;
  return runs;
}

/* ------------------------------------------------------------------ */
/* 選手交代                                                            */
/* ------------------------------------------------------------------ */

/** 投手の役割（data の pitching.role、無ければ並び順から推定） */
function roleOf(team, p) {
  if (p?.pitching?.role) return p.pitching.role;
  const i = team.pitchers.indexOf(p?.id);
  if (i === team.pitchers.length - 1) return 'closer';
  return i <= 1 ? 'starter' : 'reliever';
}

function subGuard(s, side) {
  if (side !== 'away' && side !== 'home') throw new Error('チームの指定が正しくありません');
  if (s.over) throw new Error('試合は終了しています');
  if (s.pending) throw new Error('打球の処理中は選手交代できません');
}

function benchAvailIds(s, side) {
  const team = s.teams[side];
  return team.bench.filter((id) => !s.removed[side].includes(id) && !team.lineup.includes(id));
}

function pitcherAvailIds(s, side) {
  const team = s.teams[side];
  const cur = team.pitchers[s.pitcherIndex[side]];
  return team.pitchers.filter((id) => id !== cur && !s.removed[side].includes(id) && !team.lineup.includes(id)
    && findPlayer(team, id)?.pitching);
}

/**
 * まだ出場していない（交代で退いていない）控え野手
 * @param {object} state
 * @param {'away'|'home'} side
 * @returns {object[]} Player
 */
export function availableBench(state, side) {
  const team = state.teams[side];
  return benchAvailIds(state, side).map((id) => findPlayer(team, id));
}

/**
 * まだ登板していない投手（現在の投手・退いた投手を除く）
 * @param {object} state
 * @param {'away'|'home'} side
 * @returns {object[]} Player
 */
export function availablePitchers(state, side) {
  const team = state.teams[side];
  return pitcherAvailIds(state, side).map((id) => findPlayer(team, id));
}

/**
 * 現在の打順と守備位置
 * @param {object} state
 * @param {'away'|'home'} side
 * @returns {{slot:number,id:string,name:string,pos:string,isPitcher:boolean,eligible:boolean,player:object}[]}
 */
export function lineupView(state, side) {
  const team = state.teams[side];
  const cur = team.pitchers[state.pitcherIndex[side]];
  return team.lineup.map((id, slot) => {
    const p = findPlayer(team, id);
    const pos = state.positions?.[side]?.[id] ?? p.pos;
    return {
      slot, id, name: p.name, pos, isPitcher: id === cur,
      eligible: pos === '投' ? !!p.pitching : (p.positions || [p.pos]).includes(pos),
      player: p,
    };
  });
}

function pushSub(s, side, subType, text, extra = {}) {
  const ev = { kind: 'sub', subType, side, text, runs: 0, ...extra };
  s.log.push(ev);
  return ev;
}

/**
 * 投手交代を state（clone 済み）に適用。新投手は旧投手の打順に入る。
 * 旧投手が打順にいない場合（代打・代走を出された後）は '投' の守備位置の選手の打順に入る。
 */
function applyPitcherChange(s, side, newId) {
  const team = s.teams[side];
  const oldId = team.pitchers[s.pitcherIndex[side]];
  let pi = team.pitchers.indexOf(newId);
  if (pi < 0) { team.pitchers.push(newId); pi = team.pitchers.length - 1; }
  s.pitcherIndex[side] = pi;
  const pos = s.positions[side];
  let slot = team.lineup.indexOf(oldId);
  if (slot < 0) slot = team.lineup.findIndex((id) => pos[id] === '投');
  if (slot >= 0) {
    const out = team.lineup[slot];
    if (out !== newId) {
      team.lineup[slot] = newId;
      delete pos[out];
      if (s.provisional[side] !== out && !s.removed[side].includes(out)) s.removed[side].push(out);
    }
  }
  if (oldId !== newId && !team.lineup.includes(oldId) && s.provisional[side] !== oldId && !s.removed[side].includes(oldId)) {
    s.removed[side].push(oldId);
  }
  if (s.provisional[side] === oldId) delete s.entries[oldId];
  s.provisional[side] = null;
  pos[newId] = '投';
  if (s.stamina[newId] == null) s.stamina[newId] = findPlayer(team, newId)?.pitching?.stamina ?? 30;
  s.entries[newId] = { side, lead: total(s, side) - total(s, other(side)) };
  return findPlayer(team, newId);
}

/** CPU が選ぶ次の投手 id（中継ぎ→先発→抑えの順で未登板の投手） */
function pickRelief(s, side, { closer = false } = {}) {
  const team = s.teams[side];
  const avail = pitcherAvailIds(s, side).map((id) => findPlayer(team, id));
  if (closer) return avail.find((p) => roleOf(team, p) === 'closer')?.id ?? null;
  return (avail.find((p) => roleOf(team, p) === 'reliever')
    || avail.find((p) => roleOf(team, p) === 'starter')
    || avail.find((p) => roleOf(team, p) === 'closer'))?.id ?? null;
}

/**
 * 投手交代（UI用・ユーザー側でも可）。新投手は旧投手の打順に入り、スタミナは満タン。
 * @param {object} state
 * @param {'away'|'home'} side
 * @param {string|number} [playerIdOrIndex] 投手の playerId、または投手リストの番号（旧API）。省略時は CPU と同じ選択
 * @returns {object} 新しい state
 */
export function changePitcher(state, side, playerIdOrIndex) {
  const s = cloneState(state);
  subGuard(s, side);
  if (fieldingSide(s) !== side) throw new Error('ピッチャー交代は守備中のチームのみできます');
  const team = s.teams[side];
  let id;
  if (playerIdOrIndex == null) {
    id = pickRelief(s, side);
    if (!id) return s;
  } else if (typeof playerIdOrIndex === 'number') {
    if (playerIdOrIndex === s.pitcherIndex[side]) return s;
    id = team.pitchers[playerIdOrIndex];
  } else {
    id = playerIdOrIndex;
  }
  const p = findPlayer(team, id);
  if (!p) throw new Error('その選手はチームにいません');
  if (s.removed[side].includes(id)) throw new Error(`${p.name}はすでに交代しているため再出場できません`);
  if (!pitcherAvailIds(s, side).includes(id)) throw new Error(`${p.name}は登板できません`);
  const old = currentPitcherOf(s, side);
  applyPitcherChange(s, side, id);
  pushSub(s, side, 'pitcher', `ピッチャー、${fam(old)}に代わりまして${fam(p)}。`, { inId: id, outId: old.id });
  return s;
}

/** 打順の slot を新しい選手に入れ替え（守備位置は引き継ぐ） */
function replaceSlot(s, side, slot, newId) {
  const team = s.teams[side];
  const oldId = team.lineup[slot];
  const pos = s.positions[side];
  team.lineup[slot] = newId;
  pos[newId] = pos[oldId];
  delete pos[oldId];
  if (!s.removed[side].includes(oldId)) s.removed[side].push(oldId);
  return oldId;
}

function checkBench(s, side, playerId) {
  const team = s.teams[side];
  const p = findPlayer(team, playerId);
  if (!p) throw new Error('その選手はチームにいません');
  if (s.removed[side].includes(playerId)) throw new Error(`${p.name}はすでに交代しているため再出場できません`);
  if (team.lineup.includes(playerId)) throw new Error(`${p.name}はすでに出場しています`);
  if (!benchAvailIds(s, side).includes(playerId)) throw new Error(`${p.name}は控え野手ではありません`);
  return p;
}

/**
 * 代打（現在の打者と交代。カウントはそのまま引き継ぐ）
 * @param {object} state
 * @param {'away'|'home'} side 攻撃中のチーム
 * @param {string} playerId 控え野手
 * @returns {object} 新しい state
 */
export function pinchHit(state, side, playerId) {
  const s = cloneState(state);
  subGuard(s, side);
  if (battingSide(s) !== side) throw new Error('代打は攻撃中のチームしか出せません');
  const p = checkBench(s, side, playerId);
  const team = s.teams[side];
  const slot = s.batterIndex[side] % team.lineup.length;
  const oldId = replaceSlot(s, side, slot, playerId);
  const old = findPlayer(team, oldId);
  pushSub(s, side, 'pinch_hit', `代打、${fam(old)}に代わりまして${fam(p)}。`, { inId: playerId, outId: oldId, slot });
  return s;
}

/**
 * 代走
 * @param {object} state
 * @param {'away'|'home'} side 攻撃中のチーム
 * @param {0|1|2} baseIndex 0=一塁 1=二塁 2=三塁
 * @param {string} playerId 控え野手
 * @returns {object} 新しい state
 */
export function pinchRun(state, side, baseIndex, playerId) {
  const s = cloneState(state);
  subGuard(s, side);
  if (battingSide(s) !== side) throw new Error('代走は攻撃中のチームしか出せません');
  if (![0, 1, 2].includes(baseIndex)) throw new Error('塁の指定が正しくありません');
  const oldId = s.bases[baseIndex];
  if (!oldId) throw new Error(`${BASE_NAMES[baseIndex + 1]}にランナーがいません`);
  const p = checkBench(s, side, playerId);
  const team = s.teams[side];
  const slot = team.lineup.indexOf(oldId);
  if (slot < 0) throw new Error('ランナーが打順にいません');
  replaceSlot(s, side, slot, playerId);
  s.bases[baseIndex] = playerId;
  const old = findPlayer(team, oldId);
  pushSub(s, side, 'pinch_run', `代走、${BASE_NAMES[baseIndex + 1]}ランナー${fam(old)}に代わりまして${fam(p)}。`,
    { inId: playerId, outId: oldId, slot, base: baseIndex });
  return s;
}

/**
 * 守備交代・守備位置の変更。
 * changes の playerId が出場中の選手なら守備位置の変更、控え（野手・未登板投手）なら途中出場。
 * 途中出場の選手は、変更後に守備位置が重複した（＝はじき出された）選手の打順に入る（replaces で明示も可）。
 * 9つの守備位置がちょうど1人ずつ埋まらない場合はエラー。途中出場は守備中のチームのみ。
 * @param {object} state
 * @param {'away'|'home'} side
 * @param {{playerId:string, pos:string, replaces?:string}[]} changes
 * @returns {object} 新しい state
 */
export function defensiveSwap(state, side, changes) {
  const s = cloneState(state);
  subGuard(s, side);
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('交代内容が指定されていません');
  const team = s.teams[side];
  const lineup = [...team.lineup];
  const pos = { ...s.positions[side] };
  const curPitcher = team.pitchers[s.pitcherIndex[side]];
  const moved = new Set();
  const incoming = [];
  const taken = new Map();
  for (const c of changes) {
    if (!POSITIONS.includes(c.pos)) throw new Error(`守備位置「${c.pos}」は指定できません`);
    if (taken.has(c.pos)) throw new Error(`${POS_NAMES[c.pos]}が重複しています`);
    taken.set(c.pos, c.playerId);
    const p = findPlayer(team, c.playerId);
    if (!p) throw new Error('その選手はチームにいません');
    if (lineup.includes(c.playerId)) {
      if (moved.has(c.playerId)) throw new Error(`${p.name}が重複しています`);
      moved.add(c.playerId);
    } else {
      if (s.removed[side].includes(c.playerId)) throw new Error(`${p.name}はすでに交代しているため再出場できません`);
      if (!benchAvailIds(s, side).includes(c.playerId) && !pitcherAvailIds(s, side).includes(c.playerId)) {
        throw new Error(`${p.name}は出場できません`);
      }
      incoming.push(c);
    }
  }
  if (incoming.length && fieldingSide(s) !== side) throw new Error('途中出場の守備交代は守備中のチームのみできます');
  for (const c of changes) if (moved.has(c.playerId)) pos[c.playerId] = c.pos;
  // はじき出された選手（変更対象外で、守備位置を他の選手に取られた）
  const displaced = lineup.filter((id) => !moved.has(id) && taken.has(pos[id]) && taken.get(pos[id]) !== id);
  if (displaced.length !== incoming.length) throw new Error('9つの守備位置をすべて1人ずつ埋めてください');
  const outs = [...displaced];
  const pairs = [];
  for (const c of incoming) {
    let out = c.replaces && outs.includes(c.replaces) ? c.replaces : null;
    if (c.replaces && !out) throw new Error('交代する選手の指定が正しくありません');
    if (!out) out = outs.find((id) => pos[id] === c.pos) ?? outs[0];
    outs.splice(outs.indexOf(out), 1);
    pairs.push([c, out]);
  }
  for (const [c, out] of pairs) {
    lineup[lineup.indexOf(out)] = c.playerId;
    delete pos[out];
    pos[c.playerId] = c.pos;
  }
  const used = lineup.map((id) => pos[id]);
  if (used.some((x) => !x) || new Set(used).size !== 9 || !POSITIONS.every((x) => used.includes(x))) {
    throw new Error('9つの守備位置をすべて1人ずつ埋めてください');
  }
  // 確定
  const texts = [];
  for (const [c, out] of pairs) {
    if (!s.removed[side].includes(out) && s.provisional[side] !== out) s.removed[side].push(out);
    texts.push(`${fam(findPlayer(team, out))}に代わりまして${fam(findPlayer(team, c.playerId))}が入り${POS_NAMES[c.pos]}`);
  }
  for (const c of changes) {
    if (moved.has(c.playerId) && s.positions[side][c.playerId] !== c.pos) {
      texts.push(`${fam(findPlayer(team, c.playerId))}が${POS_NAMES[c.pos]}へ`);
    }
  }
  team.lineup = lineup;
  s.positions[side] = pos;
  const newPitcher = lineup.find((id) => pos[id] === '投');
  if (newPitcher !== curPitcher) {
    // 投手の交代（旧投手が他の守備位置に残る場合は removed にしない）
    let pi = team.pitchers.indexOf(newPitcher);
    if (pi < 0) { team.pitchers.push(newPitcher); pi = team.pitchers.length - 1; }
    s.pitcherIndex[side] = pi;
    if (s.provisional[side] === curPitcher) delete s.entries[curPitcher];
    s.provisional[side] = null;
    if (s.stamina[newPitcher] == null) s.stamina[newPitcher] = findPlayer(team, newPitcher)?.pitching?.stamina ?? 30;
    s.entries[newPitcher] = { side, lead: total(s, side) - total(s, other(side)) };
  }
  pushSub(s, side, 'defense', texts.length ? `守備の交代、${texts.join('、')}。` : '守備位置の変更はありません。',
    { changes: changes.map((c) => ({ ...c })), inIds: pairs.map(([c]) => c.playerId), outIds: pairs.map(([, o]) => o) });
  return s;
}

/**
 * 守備につくチームに投手がいない（投手に代打・代走を出した）場合、自動で投手を登板させる。
 * 新投手は '投' の守備位置を引き継いだ選手の打順に入る。
 */
function ensureDefense(s, side, event) {
  const team = s.teams[side];
  const curId = team.pitchers[s.pitcherIndex[side]];
  const pos = s.positions[side];
  if (team.lineup.includes(curId) && pos[curId] === '投' && !s.removed[side].includes(curId)) return;
  const holder = team.lineup.find((id) => pos[id] === '投');
  const lead = total(s, side) - total(s, other(side));
  const save = side !== s.userSide && s.inning >= s.innings && lead > 0 && lead <= 3;
  const cand = (save && pickRelief(s, side, { closer: true })) || pickRelief(s, side);
  let p;
  if (cand) {
    p = applyPitcherChange(s, side, cand);
    s.provisional[side] = cand;
  } else if (holder) {
    // 投手を使い切った: '投' の位置の選手がそのまま登板
    let pi = team.pitchers.indexOf(holder);
    if (pi < 0) { team.pitchers.push(holder); pi = team.pitchers.length - 1; }
    s.pitcherIndex[side] = pi;
    if (s.stamina[holder] == null) s.stamina[holder] = 30;
    s.entries[holder] = { side, lead: total(s, side) - total(s, other(side)) };
    p = findPlayer(team, holder);
  }
  if (!p) return;
  const ev = pushSub(s, side, 'pitcher', `ピッチャー、${fam(p)}。`, { inId: p.id, outId: holder ?? curId, auto: true });
  if (event) {
    (event.subs ||= []).push(ev);
    event.text += ` ${ev.text}`;
  }
}

/** CPU 投手交代（守備側がユーザーでない時）。sub イベントを返す */
function cpuPitcherChange(s) {
  const side = fieldingSide(s);
  const team = s.teams[side];
  const cur = currentPitcherOf(s, side);
  const lead = total(s, side) - total(s, other(side));
  const role = roleOf(team, cur);
  let next = null;
  if (s.inning >= s.innings && lead > 0 && lead <= 3 && role !== 'closer') next = pickRelief(s, side, { closer: true });
  if (!next && ((s.stamina[cur.id] ?? 0) < 25 || (s.inning >= 8 && role === 'starter'))) next = pickRelief(s, side);
  if (!next) return null;
  const p = applyPitcherChange(s, side, next);
  return pushSub(s, side, 'pitcher', `ピッチャー、${fam(cur)}に代わりまして${fam(p)}。`, { inId: p.id, outId: cur.id, cpu: true });
}

/** CPU の代打・代走（攻撃側がユーザーでない時） */
function cpuPinch(s, rng, events) {
  const side = battingSide(s);
  if (s.inning < TUNING.phInning) return;
  const team = s.teams[side];
  const deficit = total(s, other(side)) - total(s, side);
  // 代走: 8回以降、同点・勝ち越しの走者が鈍足なら俊足の控えを送る
  if (s.inning >= TUNING.prInning && deficit >= 0 && deficit <= 2) {
    let order = 0;
    for (const bi of [2, 1, 0]) {
      const id = s.bases[bi];
      if (!id) continue;
      order += 1;
      if (order !== deficit && order !== deficit + 1) continue;
      const runner = findPlayer(team, id);
      if (!runner || runner.speed >= TUNING.prSlow) continue;
      const fast = benchAvailIds(s, side).map((x) => findPlayer(team, x))
        .filter((p) => p.speed >= TUNING.prFast).sort((a, b) => b.speed - a.speed)[0];
      if (!fast || rng() >= TUNING.prRate) continue;
      const slot = team.lineup.indexOf(id);
      if (slot < 0) continue;
      replaceSlot(s, side, slot, fast.id);
      s.bases[bi] = fast.id;
      events.push(pushSub(s, side, 'pinch_run', `代走、${BASE_NAMES[bi + 1]}ランナー${fam(runner)}に代わりまして${fam(fast)}。`,
        { inId: fast.id, outId: id, slot, base: bi, cpu: true }));
    }
  }
  // 代打: 7回以降の接戦で、弱い打者（投手含む）に控えの強打者を送る
  if (Math.abs(deficit) <= 2) {
    const slot = s.batterIndex[side] % team.lineup.length;
    const batter = findPlayer(team, team.lineup[slot]);
    const val = (p) => p.contact + p.power;
    // 控え捕手と代走要員は温存
    const best = benchAvailIds(s, side).map((x) => findPlayer(team, x))
      .filter((p) => p.pos !== '捕' && p.speed < TUNING.prFast).sort((a, b) => val(b) - val(a))[0];
    const bpos = s.positions[side][batter.id];
    const weak = batter.pitching || (val(batter) < TUNING.phWeak && bpos !== '捕');
    if (best && weak && val(best) >= val(batter) + TUNING.phMargin && rng() < TUNING.phRate) {
      replaceSlot(s, side, slot, best.id);
      events.push(pushSub(s, side, 'pinch_hit', `代打、${fam(batter)}に代わりまして${fam(best)}。`,
        { inId: best.id, outId: batter.id, slot, cpu: true }));
    }
  }
}

/** CPU: 本職でない守備位置に就いた選手（代打・代走の後など）を控えの本職と交代させる */
function cpuFixDefense(s, side, event) {
  const team = s.teams[side];
  for (const v of lineupView(s, side)) {
    if (v.eligible || v.pos === '投') continue;
    const sub = benchAvailIds(s, side).map((x) => findPlayer(team, x))
      .filter((p) => (p.positions || [p.pos]).includes(v.pos)).sort((a, b) => b.fielding - a.fielding)[0];
    if (!sub) continue;
    replaceSlot(s, side, v.slot, sub.id);
    const ev = pushSub(s, side, 'defense', `守備の交代、${fam(v.player)}に代わりまして${fam(sub)}が入り${POS_NAMES[v.pos]}。`,
      { inIds: [sub.id], outIds: [v.id], changes: [{ playerId: sub.id, pos: v.pos }], cpu: true });
    (event.subs ||= []).push(ev);
    event.text += ` ${ev.text}`;
  }
}

function cpuManageMut(s, rng) {
  const events = [];
  if (s.over || s.pending) return events;
  if (fieldingSide(s) !== s.userSide) {
    const ev = cpuPitcherChange(s);
    if (ev) events.push(ev);
  }
  if (battingSide(s) !== s.userSide) cpuPinch(s, rng, events);
  return events;
}

/**
 * CPU 側（userSide でないチーム）の采配: 投手交代・代打・代走。
 * resolvePitch / pitchContact / resolveBattedBall が打席終了ごとに自動で呼ぶ。
 * @param {object} state
 * @param {()=>number} [rng]
 * @returns {{state:object, events:object[]}}
 */
export function cpuManage(state, rng = Math.random) {
  const s = cloneState(state);
  const events = cpuManageMut(s, rng);
  return { state: s, events };
}

/* ------------------------------------------------------------------ */
/* 打席の進行                                                          */
/* ------------------------------------------------------------------ */

/** 打席終了処理（打順を進め、半イニング終了・試合終了・CPU 采配を判定） */
function endPlateAppearance(s, event, rng = Math.random, advance = true) {
  const bat = battingSide(s);
  s.balls = 0;
  s.strikes = 0;
  if (advance) s.batterIndex[bat] = (s.batterIndex[bat] + 1) % s.teams[bat].lineup.length;
  if (s.over) {
    event.text += ' サヨナラ！ 試合終了！';
    return;
  }
  if (s.outs >= 3) {
    const away = total(s, 'away');
    const home = total(s, 'home');
    event.text += ' スリーアウト、チェンジ。';
    event.endHalf = true;
    if (s.half === 'top') {
      if (s.inning >= s.innings && home > away) {
        s.over = true;
      } else {
        s.half = 'bottom';
        s.score.home[s.inning - 1] = 0;
      }
    } else if (s.inning >= s.innings && (home !== away || s.inning >= s.maxInnings)) {
      s.over = true;
    } else {
      s.inning += 1;
      s.half = 'top';
      s.score.away[s.inning - 1] = 0;
    }
    s.outs = 0;
    s.bases = [null, null, null];
    if (s.over) {
      event.text += home === away ? ' 引き分けで試合終了！' : ' 試合終了！';
      return;
    }
    ensureDefense(s, fieldingSide(s), event);
    if (fieldingSide(s) !== s.userSide) cpuFixDefense(s, fieldingSide(s), event);
  }
  const subs = cpuManageMut(s, rng);
  for (const ev of subs) {
    (event.subs ||= []).push(ev);
    if (ev.subType === 'pitcher') {
      event.pitcherChange = ev.inId;
      event.text += ` ピッチャー交代、${findPlayer(s.teams[ev.side], ev.inId).name}。`;
    } else {
      event.text += ` ${ev.text}`;
    }
  }
}

/** ログ用（打球の軌跡など重いデータを除く） */
function logCopy(event) {
  const { ball, fielding, logAt, ...rest } = event;
  if (ball) rest.ballType = ball.type;
  return rest;
}

/** イベントをログへ（打席終了処理中に記録された交代イベントより前に入れる） */
function pushLog(s, event) {
  const at = event.logAt ?? s.log.length;
  delete event.logAt;
  s.log.splice(at, 0, logCopy(event));
  const st = event.steal;
  if (st && (st.kind === 'steal' || st.kind === 'caught_stealing')) s.log.splice(at + 1, 0, { ...st });
}

/** 打者から見た引っ張り方向の符号（+1 = ライト方向、-1 = レフト方向） */
function pullSign(batter, pitcher) {
  if (batter.bats === '左') return 1;
  if (batter.bats === '右') return -1;
  return pitcher?.throws === '左' ? -1 : 1; // 両打ちは投手の逆の打席
}

/**
 * スイングの結果（打席結果・打球のヒント・接触情報）を決める。
 * batInput.pos があればミートカーソル（連続座標）、なければ従来のゾーン距離で判定。
 */
function swingOutcome(s, batter, pitcher, type, loc, bat, fat, rng) {
  const T = TUNING;
  const mode = bat.mode === 'power' ? 'power' : bat.mode === 'bunt' ? 'bunt' : 'meet';
  const timing = clamp(Number(bat.timing) || 0, -1, 1);
  const t = Math.abs(timing);
  const band = t < 0.3 ? 0 : t < 0.6 ? 1 : 2;
  const ctx = { state: s, loc };
  const info = { mode, band };
  const usePos = bat.pos && Number.isFinite(bat.pos.x) && Number.isFinite(bat.pos.y);
  let nd; let lift = 0; let hx = 0; let tier = 'other'; let d = 0;
  if (usePos) {
    const cur = meetCursor(batter, mode, s);
    const dx = loc.x - bat.pos.x;
    const dy = loc.y - bat.pos.y;
    nd = Math.hypot(dx / cur.rx, dy / cur.ry);
    const e = Math.hypot(dx, dy);
    tier = e <= cur.coreR * 0.5 ? 'shin2' : e <= cur.coreR ? 'shin' : 'other';
    // ボールがカーソル中心より上（画面 y が小さい）→ バットがボールの下側に当たりフライ、下 → ゴロ
    lift = clamp(-dy / cur.ry, -1, 1);
    hx = clamp(dx / cur.rx, -1, 1);
    info.cursor = { rx: cur.rx, ry: cur.ry, coreR: cur.coreR };
    info.nd = r2(nd);
  } else {
    const zone = bat.zone || { x: 1, y: 1 };
    d = Math.min(2, Math.max(Math.abs(zone.x - cellOf(loc.x)), Math.abs(zone.y - cellOf(loc.y))));
    nd = [0.25, 0.75, 1.08][d];
    tier = d === 0 ? 'shin' : 'other';
  }
  info.contactTier = tier;
  // 弾道・パワーヒッターで打球角度が上がる
  lift += ((batter.trajectory ?? 2) - 2) * T.trajLift + fxNum(batter, 'パワーヒッター', 'lift', 0, s);
  // 方向: タイミングが早い → 引っ張り、遅い → 流し。カーソル横ずれも反映。流し打ちは逆方向へ
  const ps = pullSign(batter, pitcher);
  let dirShift = ps * -timing * T.timingDir + hx * T.hxDir;
  if (skillOn(batter, '流し打ち', s) && timing > 0) dirShift -= ps * SKILL_FX['流し打ち'].oppo;
  const hint = { lift, dirShift, noPull: skillOn(batter, '広角打法', s) };

  if (mode === 'bunt') {
    info.dist = r2(nd);
    if (nd > 1) {
      const out = nd <= 1 + T.cursorRim && rng() < T.buntRimFoul ? 'foul' : 'strike';
      return { outcome: out, hint, info: { ...info, contactTier: 'other' } };
    }
    const c = (batter.contact * condMult(s, batter.id) - 50) / 49;
    const pFoul = clamp(T.buntFoul + T.buntFoulNd * nd - T.buntFoulC * c + fxNum(batter, 'バント◎', 'buntFoul', 0, s)
      + (band === 2 ? 0.12 : band === 1 ? 0.04 : 0) + (loc.inZone ? 0 : 0.10), 0.03, 0.9);
    const pPop = clamp(T.buntPop + T.buntPopNd * nd + fxNum(batter, 'バント◎', 'buntPop', 0, s), 0.01, 0.5);
    const r = rng();
    const out = r < pFoul ? 'foul' : r < pFoul + pPop ? 'bunt_pop' : 'bunt';
    hint.quality = 1 - nd;
    return { outcome: out, hint, info };
  }
  if (usePos) {
    if (nd > 1) {
      const out = nd <= 1 + T.cursorRim && rng() < T.rimFoul ? 'foul' : 'strike';
      info.dist = 2;
      return { outcome: out, hint, info };
    }
    d = tier === 'shin2' ? 0 : T.cursorDist * clamp((nd - T.cursorCoreN) / (1 - T.cursorCoreN), 0, 1);
  }
  info.dist = usePos ? r2(d) : d;
  const probs = swingProbabilities(batter, pitcher, type, mode, d, band, loc.inZone, fat, ctx);
  if (usePos) {
    // 上下のずれでゴロ/フライの比率
    probs[3] *= Math.exp(-T.vyK * lift);
    probs[4] *= Math.exp(T.vyK * lift);
    if (tier === 'shin2') { for (const i of [5, 6, 7, 8]) probs[i] *= 1.12; probs[1] *= 0.85; }
  }
  // 早めのタイミングで内角を引っ張る → 強い打球
  const inside = ps === 1 ? loc.x > 0.3 : loc.x < -0.3;
  if (timing < -0.1 && timing > -0.6 && inside) { probs[6] *= 1.1; probs[8] *= 1.1; }
  const tot = sum(probs);
  const outcome = OUTCOMES[pickWeighted(probs.map((x) => x / tot), rng)];
  return { outcome, hint, info };
}

/** 現在の守備側の捕手 */
function catcherOf(s) {
  const def = fieldingSide(s);
  const team = s.teams[def];
  const id = team.lineup.find((x) => s.positions[def][x] === '捕');
  return id ? findPlayer(team, id) : null;
}

/**
 * 盗塁の走者と送球の到達時刻（秒、投手の始動 = 0）。
 * 走者: スタート 0.30 秒（盗塁◎ -0.12）＋ (27.4m − リード) / (7.0 + 1.6×走力/99 m/s)（走塁◎ 走力+10）＋スライディング 0.10
 *       リード 一塁 3.6m / 二塁 5.5m（投手が牽制◎なら -0.8m）
 * 守備: 投球 1.35 秒（クイック◎ -0.15、変化球 +0.10）＋ 捕手の握り替え 0.80 − 0.25×捕球/99（送球◎ -0.08、キャッチャー◎ -0.06）
 *       ＋ 距離 / (24 + 12×肩/99 m/s、送球◎ +3) ＋ タッチ 0.15（ワンバウンド・大きく外れた球 +0.25）
 * どちらにも σ0.08 秒の誤差。走者が早ければセーフ。
 */
function stealTimes(s, runner, catcher, pitcher, baseIndex, type, loc, rng) {
  const T = TUNING;
  const spd = Math.min(99, (runner?.speed ?? 50) + fxNum(runner, '走塁◎', 'runSpeed', 0, s)) / 99;
  const lead = (baseIndex === 0 ? T.stealLead1 : T.stealLead2) - fxNum(pitcher, '牽制◎', 'lead', 0, s);
  const v = T.runBase + T.runSpeed * spd;
  const runnerTime = T.stealJump - fxNum(runner, '盗塁◎', 'stealJump', 0, s) + (27.4 - lead) / v + T.stealSlide
    + (rng ? gauss(rng) * T.stealNoise : 0);
  const delivery = T.stealDelivery - fxNum(pitcher, 'クイック◎', 'delivery', 0, s)
    + (PITCH_TYPES[type]?.fastballFamily ? 0 : T.stealBreaking);
  const cArm = catcher?.arm ?? 50;
  const pop = T.stealPop - T.stealPopC * ((catcher?.catching ?? 50) / 99)
    - fxNum(catcher, '送球◎', 'transfer', 0, s) - fxNum(catcher, 'キャッチャー◎', 'pop', 0, s);
  const tv = T.throwV0 + (T.throwVArm * cArm) / 99 + fxNum(catcher, '送球◎', 'throwV', 0, s);
  const target = FIELD.bases[baseIndex + 2];
  const dthrow = dist({ x: 0, y: -1 }, target);
  const wild = loc && (Math.abs(loc.x) > 1.9 || loc.y > 1.9) ? T.stealWild : 0;
  const throwTime = delivery + pop + dthrow / tv + T.stealTag + wild + (rng ? gauss(rng) * T.stealNoise : 0);
  return { runnerTime, throwTime };
}

/**
 * 盗塁の成功確率の目安（UI 表示・CPU 判断用。乱数なしの時間差から近似）
 * @param {object} state
 * @param {0|1} baseIndex
 * @returns {number} 0-1
 */
export function stealChance(state, baseIndex) {
  const runner = anyPlayer(state, state.bases[baseIndex]);
  if (!runner) return 0;
  const { runnerTime, throwTime } = stealTimes(state, runner, catcherOf(state), getPitcher(state), baseIndex, 'fastball', null, null);
  const z = (throwTime - runnerTime) / (TUNING.stealNoise * Math.SQRT2);
  return 1 / (1 + Math.exp(-1.7 * z));
}

/** 盗塁の判定を state（clone 済み）に反映し、steal イベントを返す */
function runSteal(s, steal, pitcher, type, loc, rng) {
  const bi = steal.baseIndex;
  const runnerId = s.bases[bi];
  if (!runnerId || s.bases[bi + 1]) return { kind: 'steal_cancelled', reason: 'blocked', runnerId: runnerId ?? null, text: '' };
  const bat = battingSide(s);
  const runner = findPlayer(s.teams[bat], runnerId) || anyPlayer(s, runnerId);
  const catcher = catcherOf(s);
  const { runnerTime, throwTime } = stealTimes(s, runner, catcher, pitcher, bi, type, loc, rng);
  const safe = runnerTime < throwTime;
  const to = BASE_NAMES[bi + 2];
  const ev = {
    kind: safe ? 'steal' : 'caught_stealing', side: bat, runnerId, catcherId: catcher?.id ?? null,
    from: bi + 1, to: bi + 2, safe, runnerTime: r2(runnerTime), throwTime: r2(throwTime), runs: 0, text: '',
  };
  s.bases[bi] = null;
  if (safe) {
    s.bases[bi + 1] = runnerId;
    s.stats[runnerId] && (s.stats[runnerId].sb += 1);
    ev.text = `${fam(runner)}、${to}へ盗塁成功！`;
  } else {
    s.stats[runnerId] && (s.stats[runnerId].cs += 1);
    addOut(s);
    ev.text = `${fam(runner)}が${to}へスタート…${catcher ? `${fam(catcher)}の送球、` : ''}刺した！ 盗塁失敗。`;
  }
  return ev;
}

/**
 * 1球の投球〜スイング判定。ボール・ストライク・ファウル・四球・三振（と盗塁）はここで state に反映して完結。
 * 打球（groundout〜hr、バント）の場合は outcome を返し、呼び出し側で打球を生成する。
 */
function pitchCore(s, pitchInput, batInput, rng) {
  const def = fieldingSide(s);
  const batter = getBatter(s);
  const pitcher = getPitcher(s);
  const type = PITCH_TYPES[pitchInput.type] ? pitchInput.type : 'fastball';
  const loc0 = pitchInput.loc ?? pitchLocation(s, { ...pitchInput, type }, rng);
  const loc = { x: loc0.x, y: loc0.y, inZone: Math.abs(loc0.x) <= 1.5 && Math.abs(loc0.y) <= 1.5 };
  const fat = fatigue(s, pitcher);
  const steal = s.pendingSteal && s.pendingSteal.side === battingSide(s) ? s.pendingSteal : null;
  s.pendingSteal = null;
  s.stealChecked = false;

  // スタミナ・投球数
  s.stamina[pitcher.id] = Math.max(0, (s.stamina[pitcher.id] ?? 0) - (PITCH_TYPES[type].fastballFamily ? 0.5 : 1));
  s.pitchCount[def] += 1;
  if (s.provisional?.[def] === pitcher.id) s.provisional[def] = null;

  const bs = s.stats[batter.id];
  const ps = s.stats[pitcher.id];
  const pname = PITCH_TYPES[type].name;
  const event = {
    kind: 'ball', text: '', runs: 0, pitch: { type, zone: pitchInput.zone, loc },
    batter: batter.id, pitcher: pitcher.id, swing: !!batInput, outcome: null,
  };
  if (type === 'fastball' && skillOn(pitcher, 'ノビ◎', s)) event.pitch.nobi = true;

  let outcome;
  let hint = null;
  if (!batInput) {
    outcome = loc.inZone ? 'strike' : 'ball';
  } else {
    const r = swingOutcome(s, batter, pitcher, type, loc, batInput, fat, rng);
    outcome = r.outcome;
    hint = r.hint;
    event.dist = r.info.dist;
    event.band = r.info.band;
    event.mode = r.info.mode;
    event.contactTier = r.info.contactTier;
    if (r.info.cursor) { event.cursor = r.info.cursor; event.nd = r.info.nd; }
    if (r.info.mode === 'bunt') event.bunt = true;
  }
  event.outcome = outcome;
  const cancel = (reason) => {
    if (steal) event.steal = { kind: 'steal_cancelled', reason, runnerId: s.bases[steal.baseIndex] ?? steal.runnerId, text: '' };
  };
  const doSteal = () => {
    const ev = runSteal(s, steal, pitcher, type, loc, rng);
    event.steal = ev;
    if (ev.text) event.text += ` ${ev.text}`;
    return ev;
  };
  let done = true;
  switch (outcome) {
    case 'ball': {
      s.balls += 1;
      if (s.balls >= 4) {
        cancel('walk');
        event.kind = 'walk';
        bs.bb += 1;
        const runs = forceAdvance(s.bases, batter.id);
        event.text = `フォアボール！ ${batter.name}は一塁へ。${runs ? '押し出しで1点！' : ''}`;
        event.runs = runs;
        addRuns(s, runs, batter);
        event.logAt = s.log.length;
        endPlateAppearance(s, event, rng);
      } else {
        event.kind = 'ball';
        event.text = `${pname}、外れてボール。（${s.balls}-${s.strikes}）`;
        if (steal) {
          const ev = doSteal();
          if (ev.kind === 'caught_stealing' && s.outs >= 3) { event.logAt = s.log.length; endPlateAppearance(s, event, rng, false); }
        }
      }
      break;
    }
    case 'strike': {
      s.strikes += 1;
      if (s.strikes >= 3) {
        event.kind = 'strikeout';
        bs.ab += 1; bs.so += 1; ps.k += 1;
        addOut(s);
        event.logAt = s.log.length;
        event.text = batInput ? (batInput.mode === 'bunt' ? `バント空振り、三振！` : `空振り三振！ ${pname}に${batter.name}のバットが空を切る！`)
          : `見逃し三振！ ${pname}がズバッと決まり${batter.name}は手が出ない！`;
        if (steal) { if (s.outs < 3) doSteal(); else cancel('inning_over'); }
        endPlateAppearance(s, event, rng);
      } else {
        event.kind = 'strike';
        event.text = batInput ? `空振り！ ${pname}。（${s.balls}-${s.strikes}）` : `${pname}、見逃しストライク。（${s.balls}-${s.strikes}）`;
        if (steal) {
          const ev = doSteal();
          if (ev.kind === 'caught_stealing' && s.outs >= 3) { event.logAt = s.log.length; endPlateAppearance(s, event, rng, false); }
        }
      }
      break;
    }
    case 'foul': {
      cancel('foul');
      if (event.bunt && s.strikes >= 2) {
        // スリーバント失敗（2ストライク後のバントファウルは三振）
        event.kind = 'strikeout';
        event.buntFoulOut = true;
        bs.ab += 1; bs.so += 1; ps.k += 1;
        addOut(s);
        event.logAt = s.log.length;
        event.text = `バントはファウル…スリーバント失敗！ ${batter.name}、三振。`;
        endPlateAppearance(s, event, rng);
        break;
      }
      if (s.strikes < 2) s.strikes += 1;
      event.kind = 'foul';
      event.text = `${event.bunt ? 'バントは' : ''}ファウル。（${s.balls}-${s.strikes}）`;
      if (steal) event.text += ' ランナーは戻ります。';
      break;
    }
    default:
      done = false;
      if (steal && s.bases[steal.baseIndex]) {
        event.steal = { kind: 'running', runnerId: s.bases[steal.baseIndex], from: steal.baseIndex + 1, text: '' };
      }
  }
  if (outcome === 'bunt') event.outcome = 'groundout';
  if (outcome === 'bunt_pop') event.outcome = 'flyout';
  return { event, outcome, batter, pitcher, done, hint, running: event.steal?.kind === 'running' ? [event.steal.runnerId] : [] };
}

/** ホームランを state に反映 */
function applyHomeRun(s, ball, event, batter) {
  const bat = battingSide(s);
  const bs = s.stats[batter.id];
  const runs = s.bases.filter(Boolean).length + 1;
  bs.ab += 1; bs.h += 1; bs.hr += 1;
  s.hits[bat] += 1;
  s.bases = [null, null, null];
  const label = runs === 4 ? '満塁ホームラン' : runs === 1 ? 'ソロホームラン' : `${runs}ランホームラン`;
  const where = ball.dirDeg < -15 ? 'レフトスタンドへ' : ball.dirDeg > 15 ? 'ライトスタンドへ' : 'バックスクリーンへ';
  event.kind = 'hr';
  event.outcome = 'hr';
  event.bases = 4;
  event.runs = runs;
  event.text = `打ったー！ ${batter.name}、${where}${label}！！`;
  addRuns(s, runs, batter);
}

/**
 * 1球を投げ、スイング結果を出す（打球の処理は分離）。
 * - ボール/ストライク/ファウル/四球/三振: resolvePitch と同じく state を進めて ball=null を返す。
 * - 本塁打: 即座に反映し（state 進行済み）、アニメ用の ball（isHomeRun:true, path あり）を返す。
 * - それ以外の打球: アウト・走者は未処理。state.pending に打球を保持し、event.kind='inplay'。
 *   続けて autoField（CPU 守備）またはユーザー守備の結果で resolveBattedBall を呼ぶこと。
 * @param {object} state
 * @param {{type:string, zone:{x:number,y:number}, loc?:{x:number,y:number}}} pitchInput
 * @param {null|{zone?:{x:number,y:number}, pos?:{x:number,y:number}, mode:'meet'|'power'|'bunt', timing:number}} batInput
 *   pos（セル単位の連続座標）があればミートカーソルで判定、なければ zone で判定（docs/ENGINE-API.md 7.4）
 * @param {()=>number} [rng]
 * @returns {{state:object, event:object, ball:null|object, steal:null|object}}
 */
export function pitchContact(state, pitchInput, batInput, rng = Math.random) {
  const s = cloneState(state);
  if (s.over) return { state: s, event: { kind: 'none', text: '試合は終了しています', runs: 0 }, ball: null, steal: null };
  if (s.pending) throw new Error('前の打球の処理（resolveBattedBall）が終わっていません');
  // CPU（攻撃側がユーザーでない）の盗塁判断
  if (!s.pendingSteal && !s.stealChecked && battingSide(s) !== s.userSide && !pitchInput?.noSteal) cpuStealMut(s, rng);
  const { event, outcome, batter, done, hint, running } = pitchCore(s, pitchInput, batInput, rng);
  const steal = event.steal && (event.steal.kind === 'steal' || event.steal.kind === 'caught_stealing') ? event.steal : null;
  if (done) {
    pushLog(s, event);
    return { state: s, event, ball: null, steal };
  }
  const ball = generateBall(s, outcome, batter, rng, hint, running);
  if (ball.isHomeRun) {
    event.ball = ball;
    applyHomeRun(s, ball, event, batter);
    event.logAt = s.log.length;
    endPlateAppearance(s, event, rng);
    pushLog(s, event);
    return { state: s, event, ball, steal: null };
  }
  const base = { ...event };
  s.pending = { ballId: ball.id, ball, batterId: batter.id, pitcherId: event.pitcher, event: base };
  return { state: s, event: { ...event, kind: 'inplay', text: event.bunt ? 'バント！' : '打った！', ball }, ball, steal: null };
}

/**
 * 盗塁を予約する（次の投球で走る）。次の pitchContact / resolvePitch で解決される。
 * @param {object} state
 * @param {'away'|'home'} side 攻撃中のチーム
 * @param {0|1} baseIndex 0 = 一塁走者が二塁へ、1 = 二塁走者が三塁へ
 * @returns {object} 新しい state（state.pendingSteal = { side, baseIndex, runnerId }）
 */
export function attemptSteal(state, side, baseIndex) {
  const s = cloneState(state);
  if (s.over) throw new Error('試合は終了しています');
  if (s.pending) throw new Error('打球の処理中は盗塁できません');
  if (battingSide(s) !== side) throw new Error('盗塁は攻撃中のチームしかできません');
  if (baseIndex !== 0 && baseIndex !== 1) throw new Error('盗塁できるのは一塁・二塁ランナーです');
  const runnerId = s.bases[baseIndex];
  if (!runnerId) throw new Error(`${BASE_NAMES[baseIndex + 1]}にランナーがいません`);
  if (s.bases[baseIndex + 1]) throw new Error(`${BASE_NAMES[baseIndex + 2]}が空いていません`);
  s.pendingSteal = { side, baseIndex, runnerId };
  return s;
}

/**
 * 盗塁の予約を取り消す
 * @param {object} state
 * @returns {object} 新しい state
 */
export function cancelSteal(state) {
  const s = cloneState(state);
  s.pendingSteal = null;
  return s;
}

/** CPU の盗塁判断（state を変更）。走る場合は pendingSteal を設定して true */
function cpuStealMut(s, rng) {
  const T = TUNING;
  s.stealChecked = true;
  if (s.over || s.pending || s.pendingSteal || s.outs >= 3) return false;
  if (s.strikes >= 2 || s.balls >= 3) return false;
  const side = battingSide(s);
  if (total(s, other(side)) - total(s, side) > T.cpuStealDeficit) return false;
  for (const bi of [1, 0]) {
    const id = s.bases[bi];
    if (!id || s.bases[bi + 1]) continue;
    if (bi === 0 && s.bases[1]) continue;
    if (bi === 1 && s.outs >= 2) continue;
    const r = findPlayer(s.teams[side], id) || anyPlayer(s, id);
    const eff = (r?.speed ?? 0) + fxNum(r, '盗塁◎', 'cpuSteal', 0, s);
    const need = T.cpuStealSpeed + (bi === 1 ? 10 : 0);
    if (eff < need) continue;
    if (stealChance(s, bi) < T.cpuStealMin) continue;
    if (rng() < T.cpuStealRate * (eff - 70) / 30) {
      s.pendingSteal = { side, baseIndex: bi, runnerId: id, cpu: true };
      return true;
    }
  }
  return false;
}

/**
 * CPU の盗塁判断だけを先に行う（UI で投球前に走者のスタートを見せたい場合）。
 * 返した state で pitchContact を呼べば、同じ投球で再判断はしない。
 * @param {object} state
 * @param {()=>number} [rng]
 * @returns {{state:object, attempted:boolean}}
 */
export function cpuSteal(state, rng = Math.random) {
  const s = cloneState(state);
  if (battingSide(s) === s.userSide) return { state: s, attempted: false };
  const attempted = cpuStealMut(s, rng);
  return { state: s, attempted };
}

/**
 * 1球を判定する（従来 API）。打球は autoField（CPU 守備）で自動処理する。
 * @param {object} state
 * @param {{type:string, zone:{x:number,y:number}, loc?:{x:number,y:number}}} pitchInput loc 指定時はその位置を使う
 * @param {null|{zone:{x:number,y:number}, mode:'meet'|'power', timing:number}} batInput null=見送り
 * @param {()=>number} [rng]
 * @returns {{state:object, event:object}}
 */
export function resolvePitch(state, pitchInput, batInput, rng = Math.random) {
  const r = pitchContact(state, pitchInput, batInput, rng);
  if (!r.ball || r.ball.isHomeRun) return { state: r.state, event: r.event };
  const fielding = autoField(r.state, r.ball, rng);
  const res = resolveBattedBall(r.state, r.ball, fielding, rng);
  return res;
}

/* ------------------------------------------------------------------ */
/* 打球の生成                                                          */
/* ------------------------------------------------------------------ */

const DT = 0.05;

/** 方向（度）と距離 → 座標 */
function polar(dirDeg, d) {
  const a = (dirDeg * Math.PI) / 180;
  return { x: d * Math.sin(a), y: d * Math.cos(a) };
}

/** 打球の軌跡を計算して ball に path/landing/hangTime などを設定 */
function buildPath(ball, D, T) {
  const T_ = TUNING;
  const fence = fenceDistance(ball.dirDeg);
  const path = [];
  const push = (t, r, z) => {
    const p = polar(ball.dirDeg, r);
    path.push({ t: r2(t), x: r2(p.x), y: r2(p.y), z: r2(Math.max(0, z)) });
  };
  if (ball.type === 'grounder') {
    const v0 = (ball.exitSpeed / 3.6) * T_.groundSpeedFactor;
    const a = T_.groundDecel;
    let tEnd = v0 / a;
    const rMax = (v0 * v0) / (2 * a);
    let rEnd = rMax;
    if (rMax > fence - 0.5) {
      rEnd = fence - 0.5;
      tEnd = (v0 - Math.sqrt(Math.max(0, v0 * v0 - 2 * a * rEnd))) / a;
    }
    for (let t = 0; t < tEnd; t += DT) {
      const r = v0 * t - 0.5 * a * t * t;
      push(t, r, 0.8 * Math.abs(Math.sin((Math.PI * t) / 0.45)) * Math.exp(-1.5 * t));
    }
    push(tEnd, rEnd, 0);
    ball.hangTime = 0;
    ball.distance = r2(rEnd);
    ball.landing = polar(ball.dirDeg, rEnd);
    ball.endTime = r2(tEnd);
  } else {
    const g = T_.gravity;
    const h0 = 1.0;
    const vz = (0.5 * g * T * T - h0) / T;
    const vh = D / T;
    for (let t = 0; t < T; t += DT) push(t, vh * t, h0 + vz * t - 0.5 * g * t * t);
    push(T, D, 0);
    ball.hangTime = r2(T);
    ball.distance = r2(D);
    ball.landing = polar(ball.dirDeg, D);
    ball.exitSpeed = Math.round(Math.hypot(vh, vz) * 3.6);
    ball.launchDeg = Math.round((Math.atan2(vz, vh) * 180) / Math.PI);
    let tEnd = T;
    if (!ball.isHomeRun) {
      // バウンド後の転がり（フェンスで止まる）
      const vr = vh * (ball.type === 'liner' ? T_.rollLiner : ball.type === 'popup' ? T_.rollPopup : T_.rollFly);
      const vb = 0.3 * Math.abs(vz - g * T);
      const a = T_.rollDecel;
      const tStop = vr / a;
      for (let t = DT; t < tStop + 1e-9; t += DT) {
        let r = D + vr * t - 0.5 * a * t * t;
        const atWall = r >= fence - 0.5;
        if (atWall) r = fence - 0.5;
        push(T + t, r, vb * t - 0.5 * g * t * t);
        tEnd = T + t;
        if (atWall) break;
      }
    }
    ball.endTime = r2(tEnd);
  }
  ball.landing = { x: r2(ball.landing.x), y: r2(ball.landing.y) };
  const last = path[path.length - 1];
  ball.rest = { x: last.x, y: last.y };
  ball.path = path;
  return ball;
}

/** 打席結果（intendedOutcome）に合いそうな打球の候補を1つ作る */
function candidateBall(s, intended, batter, rng, id, hint = null) {
  const pull = hint?.noPull ? 0 : batter.bats === '左' ? 1 : batter.bats === '右' ? -1 : 0;
  let dir = clamp(uni(rng, -44, 44) * 0.75 + gauss(rng) * 9 + pull * 7 + (hint?.dirShift ?? 0), -44, 44);
  let r = rng();
  // 打球角度（カーソルの上下・弾道）: ゴロ/ライナー/フライの選び方をずらす
  if (hint && (intended === 'single' || intended === 'groundout')) r = clamp(r + hint.lift * 0.25, 0, 0.999);
  if (hint && intended === 'flyout' && hint.lift > 0.4 && r < 0.62 && rng() < (hint.lift - 0.4)) r = 0.7;
  let type; let D = 0; let T = 0; let exit = 0;
  switch (intended) {
    case 'groundout':
      if (r < 0.9) { type = 'grounder'; exit = uni(rng, 80, 150); } else { type = 'liner'; D = uni(rng, 30, 55); T = uni(rng, 0.8, 1.3); }
      break;
    case 'flyout':
      if (r < 0.62) { type = 'fly'; D = uni(rng, 55, 100); T = 2.6 + D / 40 + uni(rng, -0.3, 0.4); }
      else if (r < 0.85) { type = 'popup'; D = uni(rng, 8, 42); T = uni(rng, 4.3, 6.0); }
      else { type = 'liner'; D = uni(rng, 30, 62); T = uni(rng, 0.9, 1.4); }
      break;
    case 'single':
      if (r < 0.45) { type = 'grounder'; exit = uni(rng, 115, 170); }
      else if (r < 0.8) { type = 'liner'; D = uni(rng, 40, 72); T = uni(rng, 1.0, 1.8); }
      else { type = 'fly'; D = uni(rng, 45, 72); T = uni(rng, 2.6, 3.6); }
      break;
    case 'double':
      if (r < 0.45) { type = 'liner'; D = uni(rng, 62, 98); T = uni(rng, 1.3, 2.2); }
      else if (r < 0.85) { type = 'fly'; D = uni(rng, 78, 110); T = uni(rng, 2.6, 3.8); }
      else { type = 'grounder'; exit = uni(rng, 150, 175); dir = (rng() < 0.5 ? -1 : 1) * uni(rng, 36, 44); }
      break;
    case 'triple':
      if (r < 0.5) { type = 'fly'; D = uni(rng, 92, 120); T = uni(rng, 2.8, 3.8); } else { type = 'liner'; D = uni(rng, 85, 110); T = uni(rng, 1.8, 2.6); }
      break;
    default: // hr
      type = 'fly'; T = uni(rng, 4.6, 6.0);
  }
  const fence = fenceDistance(dir);
  const ball = {
    id, type, dirDeg: r2(dir), exitSpeed: Math.round(exit), landing: null, path: [], hangTime: 0,
    isFoul: false, isHomeRun: intended === 'hr', batterId: batter.id, intendedOutcome: intended,
    runAggro: r2(uni(rng, -1, 1) * TUNING.runAggro),
  };
  if (intended === 'hr') { ball.type = 'hr'; D = fence + uni(rng, 2, 28); }
  else if (type !== 'grounder') D = Math.min(D, fence - 1.5);
  return buildPath(ball, D, T);
}

/**
 * バントの打球（本塁付近のゴロ、またはバントの小フライ）。
 * ゴロ: 方向 ±30°、打球速度 32〜60 km/h（バント◎ 28〜45 km/h で両ラインへ転がしやすい。質が低いと強く・正面へ）
 */
function buntBall(s, batter, pop, rng, id, hint) {
  const good = skillOn(batter, 'バント◎', s);
  const q = clamp(hint?.quality ?? 0.5, 0, 1);
  let type; let dir; let exit = 0; let D = 0; let T = 0;
  if (pop) {
    type = 'popup';
    dir = clamp(gauss(rng) * 15, -30, 30);
    D = uni(rng, 4, 14);
    T = uni(rng, 1.6, 2.4);
  } else {
    type = 'grounder';
    const side = rng() < 0.5 ? -1 : 1;
    const spread = (good ? 12 : 4) + 14 * q;
    dir = clamp(side * uni(rng, spread * 0.4, spread + 4) + gauss(rng) * 4, -30, 30);
    exit = good ? uni(rng, 28, 45) : uni(rng, 32, 46) + (1 - q) * 14;
  }
  const ball = {
    id, type, dirDeg: r2(dir), exitSpeed: Math.round(exit), landing: null, path: [], hangTime: 0,
    isFoul: false, isHomeRun: false, batterId: batter.id, intendedOutcome: pop ? 'flyout' : 'groundout',
    runAggro: 0, bunt: true,
  };
  return buildPath(ball, D, T);
}

/** プレー結果が打席判定（intendedOutcome）と合っているか */
function matchesIntended(intended, play) {
  switch (intended) {
    case 'groundout': return ['out', 'double_play', 'fielders_choice'].includes(play.kind);
    case 'flyout': return play.caught && ['out', 'sac_fly', 'double_play'].includes(play.kind);
    case 'single': return play.kind === 'hit' && play.bases === 1 && !play.batterOut;
    case 'double': return play.kind === 'hit' && play.bases === 2 && !play.batterOut;
    case 'triple': return play.kind === 'hit' && play.bases === 3 && !play.batterOut;
    default: return true;
  }
}

/**
 * 打球を生成。CPU 守備（エラー・送球誤差なし）で処理したときに打席判定の結果になる軌跡を探す
 * （棄却サンプリング）。ユーザーが守備で上回れば結果は変わりうる。
 */
function generateBall(s, intended, batter, rng, hint = null, running = []) {
  s.ballSeq = (s.ballSeq || 0) + 1;
  const id = `ball-${s.ballSeq}`;
  if (intended === 'bunt' || intended === 'bunt_pop') {
    const ball = buntBall(s, batter, intended === 'bunt_pop', rng, id, hint);
    if (running.length) ball.running = [...running];
    return ball;
  }
  const want = { single: 1, double: 2, triple: 3 }[intended] ?? 0;
  let best = null; let bestScore = -Infinity;
  for (let i = 0; i < TUNING.ballTries; i++) {
    const ball = candidateBall(s, intended, batter, rng, id, hint);
    if (running.length) ball.running = [...running];
    if (ball.isHomeRun) return ball;
    const f = autoFieldCore(s, ball, null);
    const play = computePlay(s, ball, f, null);
    if (matchesIntended(intended, play)) return ball;
    // 一致しない場合の次善: 安打なら塁打数が近い安打、凡打ならアウト
    const isHit = play.kind === 'hit' && !play.batterOut;
    const score = want ? (isHit ? 10 - Math.abs(play.bases - want) : 0) : (isHit ? 0 : 10);
    if (score > bestScore) { best = ball; bestScore = score; }
  }
  best.mismatch = true;
  return best;
}

/**
 * 打球の時刻 t（秒、打った瞬間=0）の位置 {x,y,z}（path を線形補間）
 * @param {object} ball
 * @param {number} t
 */
export function ballPositionAt(ball, t) {
  const p = ball.path;
  if (!p.length) return { x: 0, y: 0, z: 0 };
  if (t <= p[0].t) return { x: p[0].x, y: p[0].y, z: p[0].z };
  for (let i = 1; i < p.length; i++) {
    if (p[i].t >= t) {
      const a = p[i - 1]; const b = p[i];
      const k = (t - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
    }
  }
  const l = p[p.length - 1];
  return { x: l.x, y: l.y, z: l.z };
}

/* ------------------------------------------------------------------ */
/* 守備                                                                */
/* ------------------------------------------------------------------ */

/**
 * 野手の守備パラメータ（UI で野手を操作する際の移動速度などにも使える）
 * @param {object} player
 * @param {string} pos 守備位置
 * @returns {{react:number, runSpeed:number, reachGround:number, reachAir:number, catchHeight:number, arm:number, fld:number, eligible:boolean}}
 */
export function fielderParams(player, pos) {
  const T = TUNING;
  const eligible = pos === '投' ? !!player.pitching : (player.positions || [player.pos]).includes(pos);
  const fld = clamp((player.fielding - (eligible ? 0 : T.offPosPenalty)) / 99, 0.05, 1);
  const spd = player.speed / 99;
  const pit = pos === '投'; // 投手は投球動作の後なので反応が遅く、守備範囲も狭い
  return {
    react: T.fielderReact - T.fielderReactF * fld + (pit ? T.pitcherReact : 0),
    runSpeed: T.fielderRun + T.fielderRunS * spd + T.fielderRunF * fld,
    reachGround: (T.reachGround + T.reachF * fld) * (pit ? T.pitcherReach : 1),
    reachAir: T.reachAir + T.reachF * fld,
    catchHeight: T.catchHeight,
    arm: player.arm, fld, eligible,
    throwBonus: fxNum(player, '送球◎', 'throwV', 0), transferBonus: fxNum(player, '送球◎', 'transfer', 0),
  };
}

/** 守備側の野手一覧（位置・能力） */
function fieldersOf(s, side) {
  const team = s.teams[side];
  return team.lineup.map((id) => {
    const p = findPlayer(team, id);
    const pos = s.positions[side][id] ?? p.pos;
    const home = DEFAULT_POSITIONS[pos] ?? DEFAULT_POSITIONS.中;
    return { id, pos, player: p, x: home.x, y: home.y, ...fielderParams(p, pos) };
  });
}

/**
 * 送球にかかる時間（秒）。捕球位置 from から塁 base（1-3、4=本塁）まで。
 * @param {object} F fielderParams の結果（arm, fld, runSpeed）
 */
function throwSeconds(F, from, base) {
  const T = TUNING;
  const to = FIELD.bases[base];
  const d = dist(from, to);
  if (d < 4) return d / F.runSpeed + 0.1; // 自分でベースを踏む
  const v = T.throwV0 + (T.throwVArm * F.arm) / 99 + (F.throwBonus || 0);
  const tr = (hyp(from) < 45 ? T.transferIF : T.transferOF) - 0.15 * F.fld - (F.transferBonus || 0);
  return tr + d / v + (d > T.longFrom ? (d - T.longFrom) * T.longThrow : 0);
}

/**
 * UI 用: 野手 fielderId が from から base へ送球した場合の所要時間（秒）
 * @param {object} state
 * @param {string} fielderId
 * @param {{x:number,y:number}} from
 * @param {1|2|3|4} base
 */
export function throwTimeFor(state, fielderId, from, base) {
  const F = fielderInfo(state, fielderId);
  return throwSeconds(F, from, base);
}

function fielderInfo(s, id) {
  const side = fieldingSide(s);
  const team = s.teams[side];
  const p = findPlayer(team, id) || anyPlayer(s, id);
  const pos = s.positions[side][id] ?? p?.pos ?? '中';
  return { id, pos, player: p, ...fielderParams(p, pos) };
}

/** 打球に最も早く追いつく野手と捕球時刻 */
function intercept(ball, fielders) {
  const T = TUNING;
  const path = ball.path;
  let best = null;
  for (const F of fielders) {
    const catcherOnly = F.pos === '捕';
    let cand = null;
    // 1) ノーバウンド捕球
    if (ball.type !== 'grounder') {
      for (const p of path) {
        if (p.t > ball.hangTime) break;
        if (p.t <= F.react || p.z > T.catchHeight) continue;
        if (catcherOnly && hyp(p) > 12) continue;
        if (Math.hypot(p.x - F.x, p.y - F.y) - F.reachAir <= F.runSpeed * (p.t - F.react)) {
          cand = { caught: true, t: p.t, at: p };
          break;
        }
      }
    }
    // 2) ゴロ・バウンド後の打球を捕る
    if (!cand) {
      for (const p of path) {
        if (p.t <= F.react || (ball.type !== 'grounder' && p.t <= ball.hangTime)) continue;
        if (catcherOnly && hyp(p) > 12) continue;
        if (Math.hypot(p.x - F.x, p.y - F.y) - F.reachGround <= F.runSpeed * (p.t - F.react)) {
          cand = { caught: false, t: p.t + (hyp(p) < 45 ? T.secureIF : T.secureOF), at: p };
          break;
        }
      }
    }
    // 3) 止まった打球を拾いに行く
    if (!cand && !catcherOnly) {
      const l = path[path.length - 1];
      const run = Math.max(0, Math.hypot(l.x - F.x, l.y - F.y) - F.reachGround) / F.runSpeed;
      const wall = hyp(l) >= fenceDistance(ball.dirDeg) - 1.5 ? T.secureWall : 0;
      cand = { caught: false, t: Math.max(l.t, F.react + run) + (hyp(l) < 45 ? T.secureIF : T.secureOF) + wall, at: l };
    }
    if (!cand) continue;
    if (!best || (cand.caught && !best.caught) || (cand.caught === best.caught && cand.t < best.t)) best = { ...cand, F };
  }
  return best;
}

function autoFieldCore(s, ball, rng) {
  const def = fieldingSide(s);
  const fielders = fieldersOf(s, def);
  if (ball.isHomeRun) {
    return { caughtInAir: false, fielderId: null, fielderPos: null, fieldedAt: { ...ball.landing }, fieldTime: ball.hangTime, throwTo: null, error: false, auto: true };
  }
  const ic = intercept(ball, fielders);
  let error = false;
  if (rng) {
    const p = TUNING.errBase * (1.4 - ic.F.player.catching / 99) * (ic.caught ? 0.6 : 1) * (ic.F.eligible ? 1 : 2)
      * fxNum(ic.F.player, 'エラー', 'error', 1);
    error = rng() < p;
  }
  const f = {
    caughtInAir: ic.caught, fielderId: ic.F.id, fielderPos: ic.F.pos,
    fieldedAt: { x: ic.at.x, y: ic.at.y }, fieldTime: r2(ic.t), throwTo: null, error, auto: true,
  };
  const plan = planRunners(s, ball, f);
  f.throwTo = chooseThrow(s, plan);
  if (f.throwTo) f.estThrowTime = r2(throwSeconds(plan.F, f.fieldedAt, f.throwTo));
  return f;
}

/**
 * CPU 守備の結果（最も早く打球に追いつく野手・捕球時刻・送球先・エラー）。
 * ユーザーが打撃中のプレーや、resolvePitch の自動処理で使う。
 * @param {object} state pitchContact が返した state（pending あり）
 * @param {object} ball
 * @param {()=>number} [rng] エラー判定用
 * @returns {{caughtInAir:boolean, fielderId:string, fielderPos:string, fieldedAt:{x:number,y:number}, fieldTime:number, throwTo:1|2|3|4|null, error:boolean, auto:true, estThrowTime?:number}}
 */
export function autoField(state, ball, rng = Math.random) {
  return autoFieldCore(state, ball, rng);
}

/**
 * UI 用ヘルパー: ユーザーが野手を操作して打球に触れた結果から fielding オブジェクトを作る。
 * fieldTime が滞空中（<= hangTime）で、その時刻の打球の高さが捕球可能（<= catchHeight）なら caughtInAir=true。
 * @param {object} state pending のある state
 * @param {object} ball
 * @param {{fielderId:string, fieldTime:number, throwTo?:1|2|3|4|null, throwTime?:number, error?:boolean, caughtInAir?:boolean}} input
 * @returns {object} resolveBattedBall に渡せる fielding
 */
export function makeFielding(state, ball, input) {
  const t = Math.max(0, Number(input.fieldTime) || 0);
  const p = ballPositionAt(ball, t);
  const air = ball.type !== 'grounder' && t <= ball.hangTime && p.z <= TUNING.catchHeight;
  const f = {
    caughtInAir: input.caughtInAir ?? air, fielderId: input.fielderId,
    fieldedAt: { x: r2(p.x), y: r2(p.y) }, fieldTime: r2(t), throwTo: input.throwTo ?? null, error: !!input.error,
  };
  if (input.throwTime != null) f.throwTime = input.throwTime;
  if (input.throwTo === undefined) f.throwTo = suggestThrow(state, ball, f);
  return f;
}

/**
 * UI 用ヘルパー: その守備結果で CPU なら投げる送球先（1-3, 4=本塁, null=投げない）
 * @param {object} state
 * @param {object} ball
 * @param {object} fielding
 */
export function suggestThrow(state, ball, fielding) {
  return chooseThrow(state, planRunners(state, ball, fielding));
}

/* ------------------------------------------------------------------ */
/* 走塁とプレーの解決                                                  */
/* ------------------------------------------------------------------ */

/**
 * 走者・打者走者の進塁計画（送球前に決まる。乱数を使わない決定的な関数）
 * runners: 先頭の走者から順、最後が打者走者。arr[k] = 塁 k への到達時刻（打った瞬間=0）
 */
function planRunners(s, ball, f) {
  const T = TUNING;
  const outs0 = s.outs;
  const F = fielderInfo(s, f.fielderId);
  const caught = !!f.caughtInAir && !f.error;
  const fieldTime = f.fieldTime + (f.error ? T.errDelay : 0);
  const fromHome = hyp(f.fieldedAt);
  const infieldPlay = !caught && !f.error && ball.type === 'grounder' && fromHome < 45 && INFIELD.includes(F.pos);
  const ballEst = (base) => fieldTime + throwSeconds(F, f.fieldedAt, base);
  const bat = battingSide(s);
  const team = s.teams[bat];
  const batter = findPlayer(team, s.pending?.batterId) || getBatter(s);
  const b = s.bases;
  // 封殺（押し出される）かどうか: 一塁走者は常に、二塁走者は一塁が埋まっていれば、三塁走者は一・二塁が埋まっていれば
  const forcedAt = [true, !!b[0], !!b[0] && !!b[1]];
  const runners = [];
  for (let i = 2; i >= 0; i--) {
    if (!b[i]) continue;
    const p = findPlayer(team, b[i]) || anyPlayer(s, b[i]);
    runners.push({ id: b[i], player: p, from: i + 1, forced: i === 0 ? true : forcedAt[i], isBatter: false });
  }
  runners.push({ id: batter.id, player: batter, from: 0, forced: true, isBatter: true });
  const margin0 = (outs0 === 2 ? T.runMargin2 : T.runMargin) - (ball.runAggro || 0);
  const running = ball.running || [];
  // 走者のスタートと各塁到達時刻
  for (const r of runners) {
    const spd = Math.min(99, (r.player?.speed ?? 50) + fxNum(r.player, '走塁◎', 'runSpeed', 0, s)) / 99;
    r.margin = margin0 - fxNum(r.player, '走塁◎', 'margin', 0, s);
    let start;
    let lead = T.runLead;
    if (r.isBatter) start = 0;
    else if (running.includes(r.id) && !caught) { start = 0; lead = T.runLead + T.runningLead; }
    else if (caught) { start = fieldTime; lead = 0; }
    else if (infieldPlay) start = 0;
    else if (ball.type === 'grounder') start = r.forced || outs0 === 2 ? 0 : 0.3;
    else if (outs0 === 2) start = 0;
    else if (ball.type === 'liner') start = T.linerDelay;
    else start = Math.min(T.flyDelay * ball.hangTime, T.flyDelayMax);
    r.start = start;
    r.arr = {};
    let t = start;
    for (let k = r.from + 1; k <= 4; k++) {
      if (r.isBatter) {
        t += k === 1 ? T.bat1BSlow - (T.bat1BSlow - T.bat1BFast) * ((Math.min(99, spd * 99) - 1) / 98)
            + fxNum(r.player, '併殺', 'to1B', 0, s)
          : 27.4 / (T.batLegBase + T.batLegSpeed * spd) + T.rounding;
      } else {
        const v = T.runBase + T.runSpeed * spd;
        t += k === r.from + 1 ? (27.4 - lead) / v : 27.4 / v + T.rounding;
      }
      r.arr[k] = t;
    }
    r.minBase = r.forced ? r.from + 1 : r.from;
  }
  // 進塁先の決定（先頭の走者から。前の走者を追い越さない）
  let limit = 4;
  for (const r of runners) {
    const cap = limit;
    let target = r.minBase;
    if (caught) {
      target = r.isBatter ? 0 : r.from;
      if (!r.isBatter && r.from + 1 <= cap && outs0 + 1 < 3
        && r.arr[r.from + 1] + T.tagMargin - (ball.runAggro || 0) < ballEst(r.from + 1) + T.tagTime) target = r.from + 1;
    } else if (infieldPlay) {
      if (!r.forced && ball.bunt) {
        // 送りバント: 二塁走者は三塁へ（三塁走者は自重）
        target = r.from === 2 && r.from + 1 <= cap ? 3 : r.from;
      } else if (!r.forced && running.includes(r.id) && r.from + 1 <= cap && r.from + 1 < 4) {
        target = r.from + 1; // スタートを切っていた走者
      } else if (!r.forced) {
        target = r.from;
        const rightSide = r.from === 2 && f.fieldedAt.x > 3;
        if ((outs0 === 2 || rightSide) && r.from + 1 <= cap && r.from + 1 < 4) target = r.from + 1;
        if (outs0 === 2 && r.from === 3) target = 3; // 内野ゴロで三塁走者は無理をしない（2死は一塁で勝負）
      }
    } else {
      while (target < 4 && target + 1 <= cap
        && r.arr[target + 1] + r.margin < ballEst(target + 1) + T.tagTime) target += 1;
    }
    target = Math.min(target, cap);
    if (!caught) target = Math.max(target, Math.min(r.minBase, cap));
    r.target = target;
    r.forceAtTarget = !caught && r.forced && target === r.from + 1;
    if (!(caught && r.isBatter)) limit = target >= 4 ? 4 : target - 1;
  }
  return { runners, caught, infieldPlay, fieldTime, ballEst, F, outs0, batter, fieldedAt: f.fieldedAt };
}

/** CPU 野手の送球先 */
function chooseThrow(s, plan) {
  const T = TUNING;
  const { runners, ballEst, outs0 } = plan;
  const slack = (r) => r.arr[r.target] - (ballEst(r.target) + (r.forceAtTarget ? 0 : T.tagTime));
  if (plan.caught) {
    if (outs0 + 1 >= 3) return null;
    const tag = runners.find((r) => !r.isBatter && r.target > r.from);
    return tag ? tag.target : null;
  }
  const moving = runners.filter((r) => r.target > r.from);
  const batter = runners[runners.length - 1];
  if (plan.infieldPlay) {
    const forced = moving.filter((r) => r.forceAtTarget);
    if (outs0 === 2) {
      const best = forced.sort((a, c) => slack(c) - slack(a))[0];
      return best && slack(best) > -0.6 ? best.target : null;
    }
    for (const base of [4, 3, 2]) {
      const r = forced.find((x) => x.target === base);
      if (r && slack(r) > 0.1) return base;
    }
    return slack(batter) > -0.8 ? 1 : null;
  }
  const sorted = [...moving].sort((a, c) => c.target - a.target);
  for (const r of sorted) {
    if (r.isBatter && r.target === 1 && hyp(plan.fieldedAt) > 45) continue;
    if (slack(r) > -0.25) return r.target;
  }
  return batter.target < 3 ? batter.target + 1 : null;
}

/** 併殺の中継に入る野手 */
function coverFielder(s, base, F, fieldedAt) {
  const def = fieldingSide(s);
  let want;
  if (base === 2) want = ['遊', '三'].includes(F.pos) || (F.pos === '投' && fieldedAt.x < 0) ? '二' : '遊';
  else if (base === 3) want = F.pos === '三' ? '遊' : '三';
  else if (base === 4) want = '捕';
  else want = F.pos === '一' ? '投' : '一';
  if (dist(fieldedAt, FIELD.bases[base]) < 4) return F;
  const id = s.teams[def].lineup.find((x) => s.positions[def][x] === want);
  return id ? fielderInfo(s, id) : F;
}

/**
 * 打球・守備結果から走者・アウト・得点を決める（state は変更しない）
 * rng=null なら送球誤差なし（打球生成時の判定用）
 */
function computePlay(s, ball, f, rng) {
  const T = TUNING;
  const plan = planRunners(s, ball, f);
  const { runners, caught, infieldPlay, fieldTime, F, outs0 } = plan;
  const batter = runners[runners.length - 1];
  const outs = []; // {r, base, time, force}
  if (caught) outs.push({ r: batter, base: 0, time: fieldTime, force: false, caught: true });
  const tgt = f.error ? null : f.throwTo ?? null;
  let arrive = null;
  let victim = null;
  let relay = null;
  if (tgt && outs0 + outs.length < 3) {
    if (f.throwArriveAt != null && !f.error) arrive = Math.max(fieldTime + 0.1, Number(f.throwArriveAt));
    else {
      const tt = f.throwTime != null ? Number(f.throwTime) : throwSeconds(F, f.fieldedAt, tgt) + (rng ? gauss(rng) * T.throwNoise : 0);
      arrive = Math.max(fieldTime + 0.1, fieldTime + tt);
    }
    const cands = runners.filter((r) => !(caught && r.isBatter) && r.target === tgt && r.target > r.from);
    victim = cands.sort((a, c) => c.arr[tgt] - a.arr[tgt])[0] || null;
    if (victim) {
      const force = victim.forceAtTarget;
      const outTime = arrive + (force ? 0 : T.tagTime);
      if (victim.arr[tgt] > outTime) {
        victim.out = true;
        outs.push({ r: victim, base: tgt, time: outTime, force });
        // 併殺（フォースアウト後に一塁へ転送）
        if (force && tgt !== 1 && infieldPlay && !victim.isBatter && batter.target === 1 && outs0 + outs.length < 3) {
          const C = coverFielder(s, tgt, F, f.fieldedAt);
          const v = T.throwV0 + (T.throwVArm * C.arm) / 99 + (C.throwBonus || 0);
          const relayArr = arrive + (T.pivot - 0.25 * C.fld) + dist(FIELD.bases[tgt], FIELD.bases[1]) / v
            + (rng ? gauss(rng) * T.throwNoise * 0.5 : 0);
          relay = { fielderId: C.id, arrive: relayArr, out: false };
          if (batter.arr[1] > relayArr) {
            batter.out = true;
            relay.out = true;
            outs.push({ r: batter, base: 1, time: relayArr, force: true });
          }
        }
      }
    }
    // 送球の間の進塁（打者走者）
    if (!infieldPlay && !caught && !batter.out && tgt > batter.target + 1 && batter.target < 3) {
      const nb = batter.target + 1;
      const blocked = runners.some((r) => !r.isBatter && !r.out && r.target === nb);
      if (!blocked && batter.arr[nb] < arrive + T.throwAdvance) batter.onThrow = nb;
    }
  }
  outs.sort((a, c) => a.time - c.time);
  const scorers = runners.filter((r) => !r.out && !(caught && r.isBatter) && r.target === 4);
  let runs = scorers.length;
  let scoringIds = scorers.map((r) => r.id);
  if (outs0 + outs.length >= 3) {
    const third = outs[2 - outs0];
    const noRuns = third.caught || third.force || (third.r.isBatter && third.base <= 1);
    const ok = noRuns ? [] : scorers.filter((r) => r.arr[4] < third.time);
    runs = ok.length;
    scoringIds = ok.map((r) => r.id);
  }
  const runnerOuts = outs.filter((o) => !o.r.isBatter);
  let kind; let bases = 0;
  const batterOut = !!batter.out || caught;
  if (f.error) kind = 'error';
  else if (caught) kind = runnerOuts.length ? 'double_play' : runs > 0 ? 'sac_fly' : 'out';
  else if (batter.out) {
    if (batter.target <= 1) {
      kind = runnerOuts.length ? 'double_play' : 'out';
      if (ball.bunt && !runnerOuts.length && outs0 < 2 && runners.some((r) => !r.isBatter && r.target > r.from)) kind = 'sac_bunt';
    }
    else { kind = 'hit'; bases = batter.target - 1; }
  } else if (infieldPlay && runnerOuts.length) kind = 'out'; // 先行走者アウト・打者は一塁へ（日本の記録では凡打）
  else if (infieldPlay && tgt && tgt !== 1) kind = 'fielders_choice'; // 先行走者を狙ってオールセーフ＝野選
  else if (batter.target === 4) { kind = 'hr'; bases = 4; }
  else { kind = 'hit'; bases = batter.target; }
  return {
    kind, bases, runs, scoringIds, outs, runners, caught, infieldPlay, batterOut, tgt, arrive, victim, relay,
    fieldTime, F, outs0, error: !!f.error,
  };
}

/** 打球の場所の言い回し */
function hitPlace(ball, F, bases, infieldPlay) {
  const d = ball.dirDeg;
  const side = d < -15 ? 'レフト' : d > 15 ? 'ライト' : 'センター';
  if (infieldPlay) return '内野安打';
  if (bases === 1) {
    if (ball.type === 'grounder') {
      if (d < -8 && d > -32) return '三遊間を破る';
      if (d > 8 && d < 32) return '一二塁間を破る';
      if (Math.abs(d) <= 8) return 'センター前';
    }
    return `${side}前`;
  }
  if (Math.abs(d) > 36) return `${side}線を破る`;
  if (Math.abs(d) > 12) return `${d < 0 ? '左中間' : '右中間'}を破る`;
  return 'センターオーバーの';
}

const HIT_WORD = { 1: 'ヒット', 2: 'ツーベース', 3: 'スリーベース' };

/** 実況テキスト */
function playText(s, ball, f, play, batter) {
  const pos = POS_NAMES[play.F.pos] ?? '野手';
  const B = batter.name;
  const parts = [];
  const runnerLabel = (r) => `${BASE_NAMES[r.from]}ランナー`;
  const runnerNotes = (skipVictim) => {
    for (const r of play.runners) {
      if (r.isBatter || (skipVictim && r === play.victim)) continue;
      if (r.target === 4) parts.push(`${runnerLabel(r)}${4 - r.from >= 2 ? '一気に' : ''}ホームイン！`);
      else if (r.target - r.from >= 2) parts.push(`${runnerLabel(r)}は${BASE_NAMES[r.target]}へ。`);
    }
  };
  const throwNote = () => {
    if (!play.victim || !play.tgt) return;
    const v = play.victim;
    if (!v.out && v.arr[v.target] < play.arrive - 0.8) return; // 余裕のセーフは実況しない
    const who = v.isBatter ? 'バッターランナー' : runnerLabel(v);
    const tag = v.forceAtTarget ? 'アウト！' : 'タッチアウト！';
    if (v.target === 4) parts.push(`${who}ホームへ突入…${v.out ? `${tag}` : 'セーフ！'}`);
    else parts.push(`${BASE_NAMES[play.tgt]}へ送球…${who}${v.out ? tag : 'セーフ！'}`);
  };
  if (play.kind === 'error') {
    const what = ball.type === 'grounder' ? 'ゴロ' : ball.type === 'liner' ? 'ライナー' : 'フライ';
    parts.push(`${B}、${pos}${what}…あっと${pos}がエラー！`);
    runnerNotes(false);
    if (batter && play.runners[play.runners.length - 1].target > 1) parts.push(`${fam(batter)}は${BASE_NAMES[play.runners[play.runners.length - 1].target]}へ。`);
  } else if (play.caught) {
    if (ball.type === 'liner') parts.push(`${B}、${pos}ライナー…ダイレクトキャッチ！ アウト！`);
    else if (ball.type === 'popup' || INFIELD.includes(play.F.pos)) parts.push(`${B}、打ち上げた…${pos}が捕ってアウト！`);
    else parts.push(`${B}、${pos}フライ…捕りました、アウト！`);
    const tag = play.runners.find((r) => !r.isBatter && r.target > r.from);
    if (tag) {
      const dest = BASE_NAMES[tag.target];
      parts.push(`${runnerLabel(tag)}タッチアップ！ ${dest}へ…${tag.out ? 'タッチアウト！ ダブルプレー！' : 'セーフ！'}`);
      if (play.kind === 'sac_fly') parts.push('犠牲フライ！');
    }
  } else if (play.infieldPlay && ball.bunt) {
    const head = `${B}、バント！ ${pos}が処理して`;
    if (play.kind === 'sac_bunt') parts.push(`${head}一塁へ…アウト！ 送りバント成功！`);
    else if (!play.tgt) parts.push(`${B}、絶妙なバント！ 投げられない！ バントヒット！`);
    else if (play.tgt === 1) parts.push(`${head}一塁へ…${play.batterOut ? 'アウト！' : 'セーフ！ バントヒット！'}`);
    else if (play.victim?.out) parts.push(`${head}${BASE_NAMES[play.tgt]}へ…アウト！ 送りバント失敗！`);
    else parts.push(`${head}${BASE_NAMES[play.tgt]}へ…セーフ！ フィルダースチョイス！`);
    runnerNotes(true);
  } else if (play.infieldPlay) {
    const head = `${B}、${pos}ゴロ！`;
    if (!play.tgt) {
      parts.push(`${head} ${pos}捕るも投げられない！ 内野安打！`);
    } else if (play.kind === 'double_play') {
      parts.push(`${head} ${pos}捕って${BASE_NAMES[play.tgt]}へ、一塁へ転送…ダブルプレー！`);
    } else if (play.tgt === 1) {
      parts.push(`${head} ${pos}捕って一塁へ…${play.batterOut ? 'アウト！' : 'セーフ！ 内野安打！'}`);
    } else if (play.victim) {
      if (play.victim.out) {
        const o = play.outs.find((x) => x.r === play.victim);
        parts.push(`${head} ${pos}捕って${BASE_NAMES[play.tgt]}へ…${o && !o.force ? 'タッチアウト！' : 'フォースアウト！'}`);
        if (play.relay && !play.relay.out) parts.push('一塁は間に合わずセーフ。');
        else if (!play.relay) parts.push('バッターランナーは一塁へ。');
      } else {
        parts.push(`${head} ${pos}捕って${BASE_NAMES[play.tgt]}へ…セーフ！ フィルダースチョイス！`);
      }
    } else {
      parts.push(`${head} ${pos}捕って${BASE_NAMES[play.tgt]}へ…オールセーフ！ フィルダースチョイス！`);
    }
    runnerNotes(true);
  } else {
    const br = play.runners[play.runners.length - 1];
    if (play.kind === 'hr') {
      parts.push(`${B}、${hitPlace(ball, play.F, 3, false)}打球…ランニングホームラン！！`);
    } else if (br.out && br.target > 1) {
      parts.push(`${B}、${hitPlace(ball, play.F, play.bases, false)}${HIT_WORD[play.bases]}！`);
      runnerNotes(true);
      parts.push(`バッターは${BASE_NAMES[br.target]}を狙うも…タッチアウト！`);
      return parts.join(' ');
    } else if (br.out) {
      parts.push(`${B}、${pos}が素早く処理して一塁へ…アウト！`);
    } else {
      parts.push(`${B}、${hitPlace(ball, play.F, play.bases, false)}${HIT_WORD[play.bases] ?? 'ヒット'}！`);
    }
    runnerNotes(true);
    throwNote();
    if (br.onThrow) parts.push(`その間にバッターは${BASE_NAMES[br.onThrow]}へ。`);
  }
  return parts.join(' ');
}

/**
 * 打球を守備結果で解決し、アウト・進塁・得点・成績・イニング進行を反映する。
 * @param {object} state pitchContact が返した state（pending あり）
 * @param {object} ball pitchContact が返した ball
 * @param {{caughtInAir:boolean, fielderId:string, fieldedAt:{x:number,y:number}, fieldTime:number, throwTo:1|2|3|4|null, throwTime?:number, error?:boolean}} fielding
 * @param {()=>number} [rng]
 * @returns {{state:object, event:object}}
 */
export function resolveBattedBall(state, ball, fielding, rng = Math.random) {
  const s = cloneState(state);
  if (!s.pending || s.pending.ballId !== ball.id) throw new Error('処理待ちの打球がありません');
  if (!fielding || !fielding.fielderId) throw new Error('守備結果（fielderId）が指定されていません');
  const def = fieldingSide(s);
  const bat = battingSide(s);
  if (!s.teams[def].lineup.includes(fielding.fielderId)) throw new Error('守備についていない選手です');
  const f = { ...fielding, fieldedAt: fielding.fieldedAt ?? { ...ball.landing }, fieldTime: Number(fielding.fieldTime ?? ball.hangTime) };
  const pend = s.pending;
  const batter = findPlayer(s.teams[bat], pend.batterId) || getBatter(s);
  const play = computePlay(s, ball, f, rng);
  const event = {
    ...pend.event, kind: play.kind, text: '', runs: play.runs, bases: play.bases,
    outcome: play.kind === 'hit' ? ['single', 'double', 'triple'][play.bases - 1]
      : play.kind === 'hr' ? 'hr' : ball.type === 'grounder' && !play.caught ? 'groundout' : 'flyout',
    intendedOutcome: ball.intendedOutcome, ballId: ball.id, ball, fielding: f,
    fielderId: play.F.id, fielderPos: play.F.pos, outsMade: Math.min(play.outs.length, 3 - s.outs),
    doublePlay: play.kind === 'double_play', sacFly: play.kind === 'sac_fly', sacBunt: play.kind === 'sac_bunt', error: play.error,
    bunt: !!ball.bunt,
    throwTo: play.tgt, throwArrive: play.arrive != null ? r2(play.arrive) : null,
    runnerResults: play.runners.map((r) => ({
      id: r.id, from: r.from, to: (r.out || (play.caught && r.isBatter)) ? null : (r.onThrow ?? r.target),
      out: !!r.out || (play.caught && r.isBatter), arrive: r.arr[r.target] != null ? r2(r.arr[r.target]) : null,
    })),
  };
  const bs = s.stats[batter.id];
  if (play.kind !== 'sac_fly' && play.kind !== 'sac_bunt') bs.ab += 1;
  if (play.kind === 'sac_bunt') bs.sh = (bs.sh || 0) + 1;
  if (play.kind === 'hit' || play.kind === 'hr') {
    bs.h += 1;
    s.hits[bat] += 1;
    if (play.kind === 'hr') bs.hr += 1;
  }
  if (play.kind === 'error') s.errors[def] += 1;
  event.text = playText(s, ball, f, play, batter);
  // アウト
  if (play.outs.length) addOut(s, play.outs.length);
  // 塁
  if (s.outs < 3) {
    const nb = [null, null, null];
    for (const r of play.runners) {
      if (r.out || (play.caught && r.isBatter)) continue;
      const to = r.isBatter && r.onThrow ? r.onThrow : r.target;
      if (to >= 1 && to <= 3) nb[to - 1] = r.id;
    }
    s.bases = nb;
  }
  if (play.runs > 0 && play.kind !== 'hr') event.text += ` ${play.runs}点${play.kind === 'hit' ? '追加' : ''}！`;
  const rbi = !['double_play', 'error'].includes(play.kind);
  addRuns(s, play.runs, batter, rbi, play.kind !== 'error');
  s.pending = null;
  event.logAt = s.log.length;
  endPlateAppearance(s, event, rng);
  pushLog(s, event);
  return { state: s, event };
}

/* ------------------------------------------------------------------ */
/* CPU 思考                                                            */
/* ------------------------------------------------------------------ */

/**
 * CPU 投手の配球
 * @param {object} state
 * @param {()=>number} [rng]
 * @returns {{type:string, zone:{x:number,y:number}, offset?:{x:number,y:number}}}
 */
export function choosePitch(state, rng = Math.random) {
  const pitcher = getPitcher(state);
  const pitches = pitcher.pitching?.pitches || [];
  const types = ['fastball', ...pitches.map((p) => p.type)];
  const fam2 = (t) => !!PITCH_TYPES[t]?.fastballFamily;
  const weights = [45, ...pitches.map((p) => (fam2(p.type) ? 18 : 10) + (p.level ?? 3) * 3.6)];
  // 追い込んだら変化球を増やす
  if (state.strikes === 2) for (let i = 1; i < weights.length; i++) if (!fam2(types[i])) weights[i] *= 1.5;
  if (state.balls === 3) for (let i = 0; i < weights.length; i++) if (fam2(types[i])) weights[i] *= 2;
  const type = types[pickWeighted(weights, rng)];
  const br = pitchBreak(pitcher, type);
  const pt = { dx: br.dx, dy: br.dy };
  const flip = 1;
  let zone;
  const corners = state.strikes === 2 && state.balls <= 1 ? TUNING.cornerTwoStrike : state.balls === 3 ? TUNING.cornerThreeBall : TUNING.cornerBase;
  if (rng() < corners) {
    zone = { x: rng() < 0.5 ? 0 : 2, y: rng() < 0.5 ? 0 : 2 };
  } else if (state.balls === 3 && rng() < TUNING.centerThreeBall) {
    zone = { x: 1, y: 1 };
  } else {
    zone = { x: Math.floor(rng() * 3), y: Math.floor(rng() * 3) };
  }
  // ボール先行時は変化球の狙いを曲がりの逆側へ寄せてストライクを取りにいく（それ以外は曲げてボール球で誘う）
  if (state.balls === 3 || rng() < TUNING.breakAimFix) {
    if (Math.abs(pt.dx) >= 0.4) zone.x = clamp(zone.x - Math.sign(pt.dx * flip), 0, 2);
    if (pt.dy >= 0.6) zone.y = clamp(zone.y - 1, 0, 2);
  }
  const pitch = { type, zone };
  // 釣り球: 追い込んだら（またはときどき）コーナーからゾーン外へ狙いをずらす
  const waste = state.balls === 3 ? TUNING.wasteThreeBall : state.strikes === 2 ? TUNING.wasteTwoStrike : TUNING.wasteBase;
  if (rng() < waste) {
    const ox = zone.x === 1 ? 0 : (zone.x - 1) * TUNING.wasteOffset;
    const oy = zone.y === 1 ? TUNING.wasteOffset : (zone.y - 1) * TUNING.wasteOffset;
    pitch.offset = { x: ox, y: oy };
  }
  return pitch;
}

/**
 * CPU 打者のスイング判断
 * @param {object} state
 * @param {{type:string, zone:{x:number,y:number}, loc?:{x:number,y:number}}} pitch loc があれば実位置で判断、なければ予想位置
 * @param {()=>number} [rng]
 * @returns {null|{zone:{x:number,y:number}, pos:{x:number,y:number}, mode:'meet'|'power', timing:number}}
 */
export function chooseSwing(state, pitch, rng = Math.random) {
  const T = TUNING;
  const batter = getBatter(state);
  const pitcher = getPitcher(state);
  const pt = PITCH_TYPES[pitch.type] || PITCH_TYPES.fastball;
  const br = pitchBreak(pitcher, PITCH_TYPES[pitch.type] ? pitch.type : 'fastball');
  const off = pitch.offset || { x: 0, y: 0 };
  const loc = pitch.loc ?? { x: pitch.zone.x - 1 + (off.x || 0) + br.dx, y: pitch.zone.y - 1 + (off.y || 0) + br.dy };
  const inZone = Math.abs(loc.x) <= 1.5 && Math.abs(loc.y) <= 1.5;
  const eye = (batter.contact - 50) / 200; // 選球眼
  // カウント別スイング率（平均でゾーン内 約75%・ゾーン外 約25%）
  const st = Math.min(2, state.strikes);
  let rate = inZone ? T.swingInZone[st] + eye
    : (T.swingOutZone[st] - eye + (pt.read - 0.3) * 0.2) * fxNum(batter, '選球眼', 'swingOut', 1, state);
  if (state.balls === 3) rate *= state.strikes === 0 ? 0.3 : state.strikes === 1 ? 0.8 : 1;
  if (rng() >= rate) return null;
  const cont = batter.contact * condMult(state, batter.id);
  const noise = T.posNoiseBase + ((100 - cont) / 100) * T.posNoiseContact;
  const pos = { x: r2(loc.x + gauss(rng) * noise), y: r2(loc.y + gauss(rng) * noise) };
  const zone = { x: clamp(Math.round(pos.x) + 1, 0, 2), y: clamp(Math.round(pos.y) + 1, 0, 2) };
  const v = velocityAbility(pitcher.pitching?.velocity ?? 135) / 99;
  const tSigma = T.timingBase + v * T.timingVel + ((100 - batter.contact) / 100) * T.timingContact + (pt.read - 0.15) * T.timingRead;
  const timing = clamp(gauss(rng) * tSigma, -1, 1);
  const mode = batter.power >= 75 && state.strikes < 2 && rng() < T.powerModeRate ? 'power' : 'meet';
  return { zone, pos, mode, timing };
}

/* ------------------------------------------------------------------ */
/* 集計                                                                */
/* ------------------------------------------------------------------ */

/**
 * ボックススコア
 * @param {object} state
 * @returns {{innings:number[][], R:number[], H:number[], E:number[], mvp:object|null, pitchers:{win:object|null,lose:object|null,save:object|null}}}
 */
export function boxScore(state) {
  const s = state;
  const R = [total(s, 'away'), total(s, 'home')];
  const all = { ...Object.fromEntries(s.teams.away.players.map((p) => [p.id, ['away', p]])),
    ...Object.fromEntries(s.teams.home.players.map((p) => [p.id, ['home', p]])) };
  const getP = (id) => (id ? all[id]?.[1] ?? null : null);
  let win = null; let lose = null; let save = null;
  if (s.over && R[0] !== R[1] && s.decision) {
    win = s.decision.win;
    lose = s.decision.lose;
    const ws = R[0] > R[1] ? 'away' : 'home';
    const finisher = currentPitcherOf(s, ws).id;
    const entry = s.entries[finisher];
    if (finisher !== win && entry && entry.lead >= 1 && entry.lead <= 3) save = finisher;
  }
  const winSide = R[0] > R[1] ? 'away' : R[1] > R[0] ? 'home' : null;
  let mvp = null; let best = -Infinity;
  for (const id of Object.keys(all)) {
    const [side, p] = all[id];
    if (winSide && side !== winSide) continue;
    const st = s.stats[id];
    let sc = st.h + st.hr * 2 + st.rbi * 1.5 + st.bb * 0.3;
    if (p.pitching) sc += st.ip_outs / 3 * 0.8 + st.k * 0.4 - st.er * 1.2 + (id === win ? 2 : 0) + (id === save ? 1.5 : 0);
    if (st.ab === 0 && st.ip_outs === 0 && st.bb === 0) continue;
    if (sc > best) { best = sc; mvp = p; }
  }
  return {
    innings: [[...s.score.away], [...s.score.home]],
    R, H: [s.hits.away, s.hits.home], E: [s.errors.away, s.errors.home],
    mvp, pitchers: { win: getP(win), lose: getP(lose), save: getP(save) },
  };
}

/**
 * CPU 同士で1試合を最後まで進める（テスト・バランス検証用）
 * @param {object} homeTeam
 * @param {object} awayTeam
 * @param {()=>number} [rng]
 * @returns {object} 終了時の GameState
 */
export function simulateGame(homeTeam, awayTeam, rng = Math.random) {
  let s = createGame(homeTeam, awayTeam, { userSide: null, rng });
  let guard = 0;
  while (!s.over && guard++ < 5000) {
    const pitch = choosePitch(s, rng);
    pitch.loc = pitchLocation(s, pitch, rng);
    const swing = chooseSwing(s, pitch, rng);
    s = resolvePitch(s, pitch, swing, rng).state;
  }
  return s;
}
