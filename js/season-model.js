/**
 * ペナント（シーズン）モードのデータとロジック — DOM 非依存（tests/season.test.mjs）
 *
 * - 4 球団の総当たり。1 チームの試合数は 12 / 30 / 60（各カード 4 / 10 / 20 試合、ホーム・ビジター半々）。
 *   毎日 2 試合（全チームが試合）、6 試合日ごとに移動日（試合なし・疲労回復）。2 連戦ごとにカードが替わる。
 * - 試合はすべて同じエンジン（js/engine.js、NPB 準拠のバランス）。自分の試合は試合画面で遊ぶか simulateGame。
 * - 投手の疲労: 投球数 × 0.75（救援は +10）だけたまり、1 日 25 回復。疲労 f のスタミナ倍率 = 1 − 0.5 × f/100。
 *   先発は疲労の少ない順（ローテーション）。救援は 3 連投しない・疲労 60 以上は休養（ベンチ外）。
 * - 保存: localStorage 'dokidoki.season.v1'（{ v: 1, … }）。壊れたデータは読み込まない（null）。
 */
import { TEAMS } from './data.js';
import { createGame, choosePitch, pitchLocation, chooseSwing, resolvePitch, boxScore } from './engine.js';
import { defaultPlan, validatePlan, applyLineup, autoPlan } from './lineup.js';

export const SEASON_KEY = 'dokidoki.season.v1';
export const SEASON_VERSION = 1;
export const SEASON_LENGTHS = [12, 30, 60];
/** 疲労のパラメータ */
export const FATIGUE = {
  perPitch: 0.75, reliefExtra: 10, recoverPerDay: 25, max: 100,
  staminaLoss: 0.5,        // 疲労 100 でスタミナ −50%
  starterReady: 30,        // 先発はこれ以下なら「登板可」
  starterSpot: 60,         // 先発が全員これより疲れていたら救援投手が代わりに先発
  reliefRest: 60,          // 救援投手はこれ以上なら休養
  idleStarterRest: 20,     // 先発要員は登板日以外、これより疲れていたらブルペンにも入らない
};
/** 移動日: 何試合日ごとに 1 日休むか */
const OFF_EVERY = 6;

/* ---------- 乱数 ---------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export const gameRng = (season, gameId) => mulberry32(hashStr(`${season.seed}|${gameId}`));

/* ---------- チーム ---------- */
const TEAM_MAP = new Map(TEAMS.map((t) => [t.id, t]));
export const teamById = (id) => TEAM_MAP.get(id) || null;
const playerTeam = new Map(TEAMS.flatMap((t) => t.players.map((p) => [p.id, t.id])));
const playerById = new Map(TEAMS.flatMap((t) => t.players.map((p) => [p.id, p])));
export const findPlayer = (id) => playerById.get(id) || null;
export const teamOfPlayer = (id) => playerTeam.get(id) || null;

/* ---------- 日程 ---------- */
/**
 * 日程を作る。4 チームなら 3 通りの組み合わせ（ラウンド）を 2 連戦ずつ回す。
 * @returns {{ id:string, day:number, home:string, away:string }[]}
 */
export function makeSchedule(teamIds, gamesPerTeam, seed = 1) {
  const n = teamIds.length;
  if (n !== 4) throw new Error('ペナントは 4 チームです');
  if (!SEASON_LENGTHS.includes(gamesPerTeam)) throw new Error(`試合数は ${SEASON_LENGTHS.join(' / ')} です`);
  const rng = mulberry32(seed);
  const ids = [...teamIds];
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const rounds = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  const perPair = gamesPerTeam / 3;               // 各カードの試合数（偶数）
  const meet = {};                                 // pair → これまでの対戦数
  const games = [];
  for (let gd = 0; gd < gamesPerTeam; gd++) {
    const day = gd + Math.floor(gd / OFF_EVERY);   // 移動日を挟んだ暦の日
    const round = rounds[Math.floor(gd / 2) % 3];
    for (const [a, b] of round) {
      const A = ids[a]; const B = ids[b];
      const key = `${A}|${B}`;
      const k = meet[key] = (meet[key] ?? -1) + 1;
      // 2 連戦は同じ球場。カードの最後の 2 連戦が奇数番目になる場合は 1 試合ずつ分ける（ホーム数を半々に）
      const series = Math.floor(k / 2);
      const nSeries = perPair / 2;
      let homeA = series % 2 === 0;
      if (nSeries % 2 === 1 && series === nSeries - 1) homeA = k % 2 === 0;
      games.push({ id: `g${games.length + 1}`, day, home: homeA ? A : B, away: homeA ? B : A });
    }
  }
  return games;
}

/* ---------- 成績 ---------- */
const BAT_KEYS = ['g', 'ab', 'h', 'd2', 'd3', 'hr', 'rbi', 'bb', 'so', 'sb', 'cs', 'sh', 'hbp'];
const PIT_KEYS = ['pg', 'gs', 'w', 'l', 'sv', 'outs', 'er', 'k', 'ha', 'bba', 'hra', 'np'];
export const STAT_KEYS = [...BAT_KEYS, ...PIT_KEYS];
const emptyStats = () => Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));

/**
 * 新しいシーズン
 * @param {{ userTeamId:string, length?:number, seed?:number, teamIds?:string[] }} opts
 */
export function createSeason({ userTeamId, length = 12, seed, teamIds } = {}) {
  const ids = teamIds || TEAMS.map((t) => t.id);
  if (!ids.includes(userTeamId)) throw new Error('チームが見つかりません');
  const sd = Number.isFinite(seed) ? seed >>> 0 : (Math.floor(Math.random() * 2 ** 31) >>> 0);
  const games = makeSchedule(ids, length, sd);
  const stats = {};
  const fatigue = {};
  for (const id of ids) for (const p of teamById(id).players) {
    stats[p.id] = emptyStats();
    if (p.pitching) fatigue[p.id] = 0;
  }
  return {
    v: SEASON_VERSION, seed: sd, createdAt: Date.now(), userTeamId, length, teamIds: [...ids],
    day: 0, done: false,
    games: games.map((g) => ({ ...g, result: null })),
    stats, fatigue,
    lastPitched: {},          // 投手 id → 最後に投げた日（暦）
    streak: {},               // 投手 id → 連投日数（前日にも投げていれば +1）
    rot: Object.fromEntries(ids.map((id) => [id, 0])), // 次に回す先発（チームの先発要員の番号）
    userPlan: null,           // 自分のチームのオーダー（試合前画面で保存）
    awards: null,
  };
}

/* ---------- 日・試合 ---------- */
export const lastDay = (season) => season.games.reduce((m, g) => Math.max(m, g.day), 0);
export const gamesOnDay = (season, day = season.day) => season.games.filter((g) => g.day === day);
export const isUserGame = (season, g) => g.home === season.userTeamId || g.away === season.userTeamId;
/** 自分の次の試合（未消化で最も早いもの） */
export function nextUserGame(season) {
  return season.games.find((g) => !g.result && isUserGame(season, g)) || null;
}
/** チームの消化試合数 */
export const playedCount = (season, teamId) => season.games.filter((g) => g.result && (g.home === teamId || g.away === teamId)).length;

/* ---------- 疲労・ローテーション ---------- */
/**
 * 投手の状態
 * @returns {{ f:number, mul:number, restDays:number|null, rest:boolean, reason:string, label:string }}
 *   restDays = 最後の登板から何日空いたか（null = 未登板）。rest = きょうはベンチ外（休養）
 */
export function pitcherStatus(season, pid, { starting = false } = {}) {
  const p = findPlayer(pid);
  const f = Math.min(FATIGUE.max, Math.max(0, season.fatigue[pid] ?? 0));
  const mul = 1 - FATIGUE.staminaLoss * f / 100;
  const last = season.lastPitched[pid];
  const restDays = Number.isFinite(last) ? Math.max(0, season.day - last - 1) : null;
  const pitchedYesterday = Number.isFinite(last) && season.day - last === 1;
  const streak = pitchedYesterday ? (season.streak[pid] ?? 1) : 0;
  let rest = false; let reason = '';
  if (!starting && p?.pitching) {
    if (p.pitching.role === 'starter') {
      if (f > FATIGUE.idleStarterRest) { rest = true; reason = '登板間隔（調整中）'; }
    } else if (streak >= 2) { rest = true; reason = `${streak}連投中（休養）`; }
    else if (f >= FATIGUE.reliefRest) { rest = true; reason = '疲労（休養）'; }
  }
  const label = f < 10 ? '万全' : f < 30 ? '良好' : f < 60 ? 'お疲れ' : 'ヘトヘト';
  return { f: Math.round(f), mul, restDays, rest, reason, label, streak };
}

/** チームの先発投手を選ぶ（疲労の少ない先発要員。全員疲れていたら救援投手が先発） */
export function chooseStarter(season, teamId) {
  const team = teamById(teamId);
  const starters = team.pitchers.filter((id) => findPlayer(id)?.pitching?.role === 'starter');
  const f = (id) => season.fatigue[id] ?? 0;
  if (starters.length) {
    const r = (season.rot[teamId] ?? 0) % starters.length;
    const ordered = [...starters.slice(r), ...starters.slice(0, r)];
    // 前日に投げた投手は先発させない（連投の先発は無し）
    const yesterday = (id) => Number.isFinite(season.lastPitched[id]) && season.day - season.lastPitched[id] <= 1;
    const ready = ordered.find((id) => !yesterday(id) && f(id) <= FATIGUE.starterReady);
    if (ready) return ready;
    const best = ordered.filter((id) => !yesterday(id)).sort((a, b) => f(a) - f(b))[0];
    if (best && f(best) <= FATIGUE.starterSpot) return best;
  }
  const rested = (id) => !(Number.isFinite(season.lastPitched[id]) && season.day - season.lastPitched[id] <= 1);
  const spot = team.pitchers.filter((id) => rested(id) && !['closer', 'setup'].includes(findPlayer(id)?.pitching?.role))
    .sort((a, b) => (findPlayer(b).pitching.stamina * (1 - f(b) / 100)) - (findPlayer(a).pitching.stamina * (1 - f(a) / 100)))[0];
  return spot || team.pitchers[0];
}

/** そのチームのきょうのベンチ外の投手と、スタミナ倍率 */
export function pitcherAvailability(season, teamId, starter) {
  const team = teamById(teamId);
  const rest = []; const staminaMul = {};
  for (const id of team.pitchers) {
    const st = pitcherStatus(season, id, { starting: id === starter });
    staminaMul[id] = st.mul;
    if (id !== starter && st.rest) rest.push(id);
  }
  return { rest, staminaMul };
}

/** 自分のチームのオーダー（保存済みが有効ならそれ、無ければおまかせ）。starter を差し替える */
export function userPlanFor(season, starter) {
  const team = teamById(season.userTeamId);
  let plan = season.userPlan && validatePlan(team, season.userPlan).ok ? season.userPlan : autoPlan(team);
  if (starter && plan.starter !== starter) {
    const order = plan.order.map((id) => (id === plan.starter ? starter : id));
    const pos = { ...plan.pos }; delete pos[plan.starter]; pos[starter] = '投';
    plan = { order, pos, starter };
  }
  return plan;
}

/**
 * 1 試合の準備: 両チームの先発・オーダー・疲労を反映したチーム（createGame に渡す）
 * @param {{ userPlan?: object }} [opts] 自分のチームのオーダー（試合前画面で決めたもの）
 * @returns {{ home:object, away:object, starters:{home:string, away:string} }}
 */
export function prepareMatch(season, game, { userPlan } = {}) {
  const out = { starters: {} };
  for (const side of ['home', 'away']) {
    const tid = game[side];
    const team = teamById(tid);
    let plan;
    if (tid === season.userTeamId) plan = userPlan && validatePlan(team, userPlan).ok ? userPlan : userPlanFor(season, chooseStarter(season, tid));
    else plan = defaultPlan(team, chooseStarter(season, tid));
    const av = pitcherAvailability(season, tid, plan.starter);
    out[side] = applyLineup(team, plan, av);
    out.starters[side] = plan.starter;
  }
  return out;
}

/** CPU 同士で 1 試合（engine.simulateGame と同じ進め方。既定 9 回制） */
export function simulateMatch(home, away, rng, { innings = 9 } = {}) {
  let s = createGame(home, away, { userSide: null, rng, innings });
  let guard = 0;
  while (!s.over && guard++ < 6000) {
    const pitch = choosePitch(s, rng);
    pitch.loc = pitchLocation(s, pitch, rng);
    const swing = chooseSwing(s, pitch, rng);
    s = resolvePitch(s, pitch, swing, rng).state;
  }
  return s;
}

/** 試合を 1 つシミュレートして記録（自分の試合の「おまかせ」も同じ） */
export function simGame(season, game) {
  const m = prepareMatch(season, game, { userPlan: isUserGame(season, game) ? userPlanFor(season, chooseStarter(season, season.userTeamId)) : null });
  const rng = gameRng(season, game.id);
  const state = simulateMatch(m.home, m.away, rng);
  recordGame(season, game, state, { starters: m.starters, by: 'sim' });
  return state;
}

/* ---------- 記録 ---------- */
/**
 * 終わった試合（GameState）をシーズンに記録する（season を書き換える）
 * @param {object} season
 * @param {object} game 日程の 1 試合
 * @param {object} state 終了した GameState（home = game.home）
 * @param {{ starters?:{home:string,away:string}, by?:'user'|'sim' }} [opts]
 */
export function recordGame(season, game, state, { starters = {}, by = 'sim' } = {}) {
  if (game.result) throw new Error('この試合はもう記録されています');
  if (state.teams.home.id !== game.home || state.teams.away.id !== game.away) throw new Error('試合のチームが日程と合いません');
  const box = boxScore(state);
  const st = season.stats;
  const add = (id, k, v = 1) => { if (st[id]) st[id][k] += v; };
  // 出場（打順に入った・途中出場して退いた選手）
  for (const side of ['home', 'away']) {
    const appeared = new Set([...state.teams[side].lineup, ...(state.removed?.[side] || [])]);
    for (const id of appeared) if (!findPlayer(id)?.pitching) add(id, 'g');
  }
  // 試合の打撃・投球成績
  for (const [id, s] of Object.entries(state.stats)) {
    if (!st[id]) continue;
    for (const k of ['ab', 'h', 'hr', 'rbi', 'bb', 'so', 'sb', 'cs', 'sh', 'hbp']) add(id, k, s[k] || 0);
    const np = state.pitchesBy?.[id] || 0;
    if (np > 0 || s.ip_outs > 0) {
      add(id, 'pg'); add(id, 'outs', s.ip_outs || 0); add(id, 'er', s.er || 0); add(id, 'k', s.k || 0); add(id, 'np', np);
    }
  }
  for (const ev of state.log) {
    if (ev.kind === 'hit') {
      if (ev.outcome === 'double') add(ev.batter, 'd2');
      else if (ev.outcome === 'triple') add(ev.batter, 'd3');
      add(ev.pitcher, 'ha');
    } else if (ev.kind === 'hr') { add(ev.pitcher, 'ha'); add(ev.pitcher, 'hra'); }
    else if (ev.kind === 'walk' || ev.kind === 'ibb' || ev.kind === 'hbp') add(ev.pitcher, 'bba');
  }
  for (const side of ['home', 'away']) if (starters[side]) add(starters[side], 'gs');
  const win = box.pitchers.win?.id ?? null; const lose = box.pitchers.lose?.id ?? null; const save = box.pitchers.save?.id ?? null;
  if (win) add(win, 'w');
  if (lose) add(lose, 'l');
  if (save) add(save, 'sv');
  // 疲労と連投
  for (const side of ['home', 'away']) {
    for (const id of teamById(game[side]).pitchers) {
      const np = state.pitchesBy?.[id] || 0;
      if (!np) continue;
      const relief = id !== starters[side];
      season.fatigue[id] = Math.min(FATIGUE.max, (season.fatigue[id] ?? 0) + np * FATIGUE.perPitch + (relief ? FATIGUE.reliefExtra : 0));
      const last = season.lastPitched[id];
      season.streak[id] = Number.isFinite(last) && game.day - last === 1 ? (season.streak[id] ?? 1) + 1 : 1;
      season.lastPitched[id] = game.day;
    }
    // ローテーションを進める（先発要員が先発したとき）
    const sid = starters[side];
    const tm = teamById(game[side]);
    const rot = tm.pitchers.filter((id) => findPlayer(id)?.pitching?.role === 'starter');
    const i = rot.indexOf(sid);
    if (i >= 0) season.rot[game[side]] = (i + 1) % rot.length;
  }
  const mvp = box.mvp?.id ?? null;
  game.result = {
    as: box.R[0], hs: box.R[1], H: [...box.H], E: [...box.E],
    line: box.innings.map((a) => a.map((v) => (Number.isFinite(v) ? v : 0))),
    inn: state.innings, w: win, l: lose, s: save, mvp, by,
    st: { home: starters.home ?? null, away: starters.away ?? null },
  };
  return game.result;
}

/** きょうの残りの試合をシミュレートして次の日へ（自分の試合も未消化ならおまかせ） */
export function finishDay(season) {
  if (season.done) return [];
  const played = [];
  for (const g of gamesOnDay(season)) if (!g.result) { simGame(season, g); played.push(g); }
  advanceDay(season);
  return played;
}

/** 次の試合日へ進める（移動日は疲労の回復だけ）。全試合が終わったら done と表彰 */
export function advanceDay(season) {
  if (gamesOnDay(season).some((g) => !g.result)) throw new Error('きょうの試合が終わっていません');
  const end = lastDay(season);
  do {
    season.day += 1;
    for (const id of Object.keys(season.fatigue)) season.fatigue[id] = Math.max(0, season.fatigue[id] - FATIGUE.recoverPerDay);
  } while (season.day <= end && gamesOnDay(season).length === 0);
  if (season.games.every((g) => g.result)) {
    season.done = true;
    season.day = Math.min(season.day, end + 1);
    season.awards = computeAwards(season);
  }
}

/** シーズンの最後まで（自分の試合もおまかせ） */
export function simulateToEnd(season) {
  let guard = 0;
  while (!season.done && guard++ < 1000) finishDay(season);
  return season;
}

/* ---------- 順位表 ---------- */
/**
 * @returns {{ teamId, g, w, l, t, pct, gb, rs, ra, home:[w,l,t], away:[w,l,t], streak:string, last5:string }[]} 順位順
 */
export function standings(season) {
  const rows = new Map(season.teamIds.map((id) => [id, { teamId: id, g: 0, w: 0, l: 0, t: 0, rs: 0, ra: 0, results: [] }]));
  for (const g of season.games) {
    if (!g.result) continue;
    const { hs, as } = g.result;
    const h = rows.get(g.home); const a = rows.get(g.away);
    h.g++; a.g++; h.rs += hs; h.ra += as; a.rs += as; a.ra += hs;
    if (hs > as) { h.w++; a.l++; h.results.push('W'); a.results.push('L'); }
    else if (as > hs) { a.w++; h.l++; h.results.push('L'); a.results.push('W'); }
    else { h.t++; a.t++; h.results.push('T'); a.results.push('T'); }
  }
  const list = [...rows.values()].map((r) => ({ ...r, pct: r.w + r.l > 0 ? r.w / (r.w + r.l) : 0 }));
  list.sort((x, y) => y.pct - x.pct || (y.w - y.l) - (x.w - x.l) || (y.rs - y.ra) - (x.rs - x.ra) || x.teamId.localeCompare(y.teamId));
  const top = list[0];
  for (const r of list) {
    r.gb = ((top.w - top.l) - (r.w - r.l)) / 2;
    const last = r.results[r.results.length - 1];
    let n = 0;
    for (let i = r.results.length - 1; i >= 0 && r.results[i] === last; i--) n++;
    r.streak = last ? `${n}${last === 'W' ? '連勝' : last === 'L' ? '連敗' : '分'}` : '-';
    r.last5 = r.results.slice(-5).join('');
    delete r.results;
  }
  return list;
}
/** 勝率の表示（.667 / 1.000） */
export const fmtPct = (v) => (v >= 1 ? '1.000' : v.toFixed(3).replace(/^0/, ''));
/** ゲーム差の表示（首位は '-'、0.5 刻み） */
export const fmtGb = (gb) => (gb <= 0 ? '-' : Number.isInteger(gb) ? String(gb) : gb.toFixed(1));

/* ---------- 個人成績 ---------- */
export const pa = (s) => s.ab + s.bb + s.hbp + s.sh;
export const avgOf = (s) => (s.ab > 0 ? s.h / s.ab : 0);
export const obpOf = (s) => (s.ab + s.bb + s.hbp > 0 ? (s.h + s.bb + s.hbp) / (s.ab + s.bb + s.hbp) : 0);
export const slgOf = (s) => (s.ab > 0 ? (s.h + s.d2 + 2 * s.d3 + 3 * s.hr) / s.ab : 0);
export const eraOf = (s) => (s.outs > 0 ? (s.er * 27) / s.outs : (s.er > 0 ? Infinity : 0));
export const fmtAvg = (v) => (v >= 1 ? '1.000' : v.toFixed(3).replace(/^0/, ''));
export const fmtEra = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
export const fmtIp = (outs) => `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ''}`;

/** 規定打席・規定投球回（チームの消化試合数 × 3.1 / × 1.0） */
export function qualifiers(season, teamId) {
  const g = playedCount(season, teamId);
  return { pa: Math.max(1, Math.floor(g * 3.1)), outs: Math.max(1, g * 3) };
}

/** 選手の一覧（チーム画面用） */
export function playerRows(season, teamId) {
  const team = teamById(teamId);
  const order = [...team.lineup.filter((id) => !findPlayer(id).pitching), ...team.bench, ...team.pitchers];
  const seen = new Set();
  const ids = [...order, ...team.players.map((p) => p.id)].filter((id) => !seen.has(id) && seen.add(id));
  return ids.map((id) => ({ player: findPlayer(id), s: season.stats[id] || emptyStats() }));
}

const LEADER_DEFS = [
  { key: 'avg', label: '打率', kind: 'bat', val: (s) => avgOf(s), fmt: fmtAvg, qual: 'pa' },
  { key: 'hr', label: '本塁打', kind: 'bat', val: (s) => s.hr, fmt: String },
  { key: 'rbi', label: '打点', kind: 'bat', val: (s) => s.rbi, fmt: String },
  { key: 'sb', label: '盗塁', kind: 'bat', val: (s) => s.sb, fmt: String },
  { key: 'era', label: '防御率', kind: 'pit', val: (s) => eraOf(s), fmt: fmtEra, qual: 'outs', asc: true },
  { key: 'w', label: '勝利', kind: 'pit', val: (s) => s.w, fmt: String },
  { key: 'k', label: '奪三振', kind: 'pit', val: (s) => s.k, fmt: String },
  { key: 'sv', label: 'セーブ', kind: 'pit', val: (s) => s.sv, fmt: String },
];
export const LEADER_KEYS = LEADER_DEFS.map((d) => [d.key, d.label]);

/**
 * 個人タイトル争い（上位 n 人）
 * @returns {{ [key]: { label, rows: { id, name, teamId, value, text }[] } }}
 */
export function leaders(season, n = 5) {
  const out = {};
  for (const d of LEADER_DEFS) {
    const rows = [];
    for (const tid of season.teamIds) {
      const q = qualifiers(season, tid);
      for (const p of teamById(tid).players) {
        const s = season.stats[p.id];
        if (!s) continue;
        if (d.kind === 'bat' && p.pitching) continue;
        if (d.kind === 'pit' && !p.pitching) continue;
        if (d.qual === 'pa' && pa(s) < q.pa) continue;
        if (d.qual === 'outs' && s.outs < q.outs) continue;
        const value = d.val(s);
        if (!d.qual && value <= 0) continue;
        if (!Number.isFinite(value)) continue;
        rows.push({ id: p.id, name: p.name, teamId: tid, value, text: d.fmt(value) });
      }
    }
    rows.sort((a, b) => (d.asc ? a.value - b.value : b.value - a.value) || a.id.localeCompare(b.id));
    out[d.key] = { label: d.label, rows: rows.slice(0, n) };
  }
  return out;
}

/* ---------- チーム成績 ---------- */
export function teamStats(season) {
  const st = standings(season);
  return season.teamIds.map((tid) => {
    const row = st.find((r) => r.teamId === tid);
    const t = emptyStats();
    for (const p of teamById(tid).players) {
      const s = season.stats[p.id];
      if (s) for (const k of STAT_KEYS) t[k] += s[k];
    }
    return {
      teamId: tid, g: row.g, w: row.w, l: row.l, t: row.t, rs: row.rs, ra: row.ra,
      avg: avgOf(t), hr: t.hr, sb: t.sb, era: eraOf(t), k: t.k, errors: season.games.reduce((a, g) => a + (g.result ? (g.home === tid ? g.result.E[1] : g.away === tid ? g.result.E[0] : 0) : 0), 0),
      totals: t,
    };
  });
}

/** リーグ全体の平均（バランス確認・テスト用） */
export function leagueTotals(season) {
  const t = emptyStats();
  for (const s of Object.values(season.stats)) for (const k of STAT_KEYS) t[k] += s[k];
  const games = season.games.filter((g) => g.result);
  const runs = games.reduce((a, g) => a + g.result.hs + g.result.as, 0);
  return { games: games.length, runsPerTeamGame: games.length ? runs / (games.length * 2) : 0, avg: avgOf(t), era: eraOf(t), hrPerTeamGame: games.length ? t.hr / (games.length * 2) : 0, totals: t };
}

/* ---------- 表彰 ---------- */
function mvpScore(p, s) {
  if (p.pitching) return s.w * 2.2 + s.sv * 1.1 + (s.outs / 3) * 0.35 - s.er * 0.55 + s.k * 0.12;
  const tb = s.h + s.d2 + 2 * s.d3 + 3 * s.hr;
  const rc = (s.ab + s.bb + s.hbp) > 0 ? ((s.h + s.bb + s.hbp) * tb) / (s.ab + s.bb + s.hbp) : 0;
  return rc + s.sb * 0.25 + s.rbi * 0.1;
}
/** 表彰（MVP・タイトル）と優勝チーム */
export function computeAwards(season) {
  const st = standings(season);
  const champion = st[0].teamId;
  const L = leaders(season, 10);
  const top = (key) => {
    const rows = L[key].rows;
    if (!rows.length) return [];
    return rows.filter((r) => r.value === rows[0].value).map((r) => ({ id: r.id, name: r.name, teamId: r.teamId, text: r.text }));
  };
  let mvp = null; let best = -Infinity;
  for (const tid of season.teamIds) {
    for (const p of teamById(tid).players) {
      const s = season.stats[p.id];
      if (!s) continue;
      const sc = mvpScore(p, s) * (tid === champion ? 1.15 : 1);
      if (sc > best) { best = sc; mvp = p; }
    }
  }
  const s = mvp ? season.stats[mvp.id] : null;
  const mvpLine = !mvp ? '' : mvp.pitching
    ? `${s.w}勝${s.l}敗${s.sv ? `${s.sv}S` : ''} 防御率${fmtEra(eraOf(s))} ${s.k}奪三振`
    : `打率${fmtAvg(avgOf(s))} ${s.hr}本塁打 ${s.rbi}打点${s.sb ? ` ${s.sb}盗塁` : ''}`;
  return {
    champion,
    mvp: mvp ? { id: mvp.id, name: mvp.name, teamId: teamOfPlayer(mvp.id), text: mvpLine } : null,
    titles: [
      ['首位打者', top('avg')], ['本塁打王', top('hr')], ['打点王', top('rbi')], ['盗塁王', top('sb')],
      ['最多勝', top('w')], ['最優秀防御率', top('era')], ['最多奪三振', top('k')], ['最多セーブ', top('sv')],
    ].map(([label, winners]) => ({ label, winners })),
  };
}

/* ---------- 保存・読み込み ---------- */
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 保存データの検査と正規化。不正なら null（例外は出さない）
 */
export function validateSeason(raw) {
  try {
    if (!isObj(raw) || raw.v !== SEASON_VERSION) return null;
    if (!Array.isArray(raw.teamIds) || raw.teamIds.length !== 4 || raw.teamIds.some((id) => !teamById(id))) return null;
    if (new Set(raw.teamIds).size !== 4 || !raw.teamIds.includes(raw.userTeamId)) return null;
    if (!SEASON_LENGTHS.includes(raw.length)) return null;
    if (!Array.isArray(raw.games) || raw.games.length !== raw.length * 2) return null;
    const games = [];
    const seenIds = new Set();
    for (const g of raw.games) {
      if (!isObj(g) || typeof g.id !== 'string' || seenIds.has(g.id) || !isNum(g.day) || g.day < 0) return null;
      if (!raw.teamIds.includes(g.home) || !raw.teamIds.includes(g.away) || g.home === g.away) return null;
      seenIds.add(g.id);
      let result = null;
      if (g.result != null) {
        const r = g.result;
        if (!isObj(r) || !isNum(r.hs) || !isNum(r.as) || r.hs < 0 || r.as < 0) return null;
        const pid = (v) => (typeof v === 'string' && findPlayer(v) ? v : null);
        result = {
          hs: r.hs, as: r.as,
          H: Array.isArray(r.H) && r.H.length === 2 && r.H.every(isNum) ? [...r.H] : [0, 0],
          E: Array.isArray(r.E) && r.E.length === 2 && r.E.every(isNum) ? [...r.E] : [0, 0],
          line: Array.isArray(r.line) && r.line.length === 2 && r.line.every((a) => Array.isArray(a) && a.every(isNum)) ? r.line.map((a) => [...a]) : [[], []],
          inn: isNum(r.inn) ? r.inn : 9, w: pid(r.w), l: pid(r.l), s: pid(r.s), mvp: pid(r.mvp), by: r.by === 'user' ? 'user' : 'sim',
          st: { home: pid(r.st?.home), away: pid(r.st?.away) },
        };
      }
      games.push({ id: g.id, day: g.day, home: g.home, away: g.away, result });
    }
    const stats = {};
    const fatigue = {};
    for (const tid of raw.teamIds) for (const p of teamById(tid).players) {
      const s = isObj(raw.stats) && isObj(raw.stats[p.id]) ? raw.stats[p.id] : {};
      stats[p.id] = Object.fromEntries(STAT_KEYS.map((k) => [k, isNum(s[k]) && s[k] >= 0 ? s[k] : 0]));
      if (p.pitching) {
        const f = isObj(raw.fatigue) ? raw.fatigue[p.id] : 0;
        fatigue[p.id] = isNum(f) ? Math.min(FATIGUE.max, Math.max(0, f)) : 0;
      }
    }
    const numMap = (o) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([k, v]) => findPlayer(k) && isNum(v)));
    const out = {
      v: SEASON_VERSION, seed: isNum(raw.seed) ? raw.seed >>> 0 : 1, createdAt: isNum(raw.createdAt) ? raw.createdAt : 0,
      userTeamId: raw.userTeamId, length: raw.length, teamIds: [...raw.teamIds],
      day: isNum(raw.day) && raw.day >= 0 ? Math.floor(raw.day) : 0, done: false,
      games, stats, fatigue, lastPitched: numMap(raw.lastPitched), streak: numMap(raw.streak),
      rot: Object.fromEntries(raw.teamIds.map((id) => [id, isNum(raw.rot?.[id]) ? Math.max(0, Math.floor(raw.rot[id])) : 0])),
      userPlan: null, awards: null,
    };
    if (raw.userPlan && validatePlan(teamById(out.userTeamId), raw.userPlan).ok) out.userPlan = raw.userPlan;
    // 日付と消化状況の整合: 未消化の試合がある日より先には進めない
    const firstOpen = games.filter((g) => !g.result).reduce((m, g) => Math.min(m, g.day), Infinity);
    if (Number.isFinite(firstOpen)) out.day = Math.min(out.day, firstOpen);
    if (games.every((g) => g.result)) { out.done = true; out.day = Math.max(out.day, lastDay(out) + 1); out.awards = computeAwards(out); }
    return out;
  } catch (e) {
    return null;
  }
}

/** 保存（storage 省略時は localStorage）。失敗しても例外を出さず false */
export function saveSeason(season, storage = globalThis.localStorage) {
  try {
    const { awards, ...rest } = season; // 表彰は読み込み時に再計算
    storage.setItem(SEASON_KEY, JSON.stringify(rest));
    return true;
  } catch (e) { return false; }
}
/** 読み込み（無い・壊れている → null） */
export function loadSeason(storage = globalThis.localStorage) {
  try {
    const txt = storage?.getItem(SEASON_KEY);
    if (!txt) return null;
    return validateSeason(JSON.parse(txt));
  } catch (e) { return null; }
}
export function clearSeason(storage = globalThis.localStorage) {
  try { storage.removeItem(SEASON_KEY); } catch (e) { /* ignore */ }
}
/** 保存データがあるか（壊れたデータは false） */
export const hasSeason = (storage) => !!loadSeason(storage);

/** タイトル用: 保存中のシーズンの要約（無ければ null） */
export function seasonSummary(storage = globalThis.localStorage) {
  const s = loadSeason(storage);
  if (!s) return null;
  const st = standings(s).find((r) => r.teamId === s.userTeamId);
  return { team: teamById(s.userTeamId), played: playedCount(s, s.userTeamId), length: s.length, w: st.w, l: st.l, t: st.t, done: s.done };
}
