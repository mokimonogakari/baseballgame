/**
 * 試合前のオーダー（打順・守備位置・先発投手）— DOM 非依存の純粋関数（tests/season.test.mjs）
 *
 * plan = { order: [9 ids], pos: { [id]: '投'|'捕'|… }, starter: id }
 *   order は打順（投手も打順に入る。DH なし）。pos は order の 9 人の守備位置（starter が '投'）。
 * applyLineup(team, plan, opts) → createGame にそのまま渡せるチーム（data.js と同じ形）。
 *   lineup = plan.order、pitchers = [starter, …残り]、bench = それ以外の野手、
 *   打順の野手の player.pos を plan の守備位置に置き換える（エンジンは player.pos で守備位置を決め、
 *   positions（守れる位置）で本職かどうかを判定するので、本職外の起用は守備力が下がる）。
 */
import { POSITIONS } from './engine.js';

export const FIELD_POS = ['捕', '一', '二', '三', '遊', '左', '中', '右'];
const LINEUP_KEY = 'dokidoki.lineup.v1';

const byId = (team) => new Map(team.players.map((p) => [p.id, p]));
const canPlay = (p, pos) => (pos === '投' ? !!p?.pitching : !!p && !p.pitching && (p.positions || [p.pos]).includes(pos));
const isFielder = (p) => !!p && !p.pitching;

/** 打撃の総合（打順・自動オーダー用） */
export function batValue(p) {
  if (!p) return 0;
  return p.contact * 0.42 + p.power * 0.42 + p.speed * 0.12 + (p.trajectory || 2) * 1.5;
}
/** 守備の重み（捕手・遊撃・二塁・中堅は守備を重く見る） */
const DEF_W = { 捕: 0.55, 遊: 0.5, 二: 0.42, 中: 0.42, 三: 0.3, 右: 0.28, 左: 0.22, 一: 0.15 };
function fitValue(p, pos) {
  const def = p.fielding * 0.7 + p.arm * 0.3;
  return batValue(p) + def * (DEF_W[pos] ?? 0.25) + (p.pos === pos ? 4 : 0);
}

/** データどおりのオーダー（starter を指定すると 9 番の投手を差し替える） */
export function defaultPlan(team, starter = null) {
  const map = byId(team);
  const st = starter && map.get(starter)?.pitching ? starter : team.pitchers[0];
  const order = team.lineup.map((id) => (id === team.pitchers[0] || map.get(id)?.pitching ? st : id));
  const pos = {};
  for (const id of order) pos[id] = id === st ? '投' : map.get(id).pos;
  return { order, pos, starter: st };
}

/**
 * オーダーの検査
 * @returns {{ ok:boolean, errors:string[], warnings:{id:string,text:string}[] }}
 */
export function validatePlan(team, plan) {
  const errors = [];
  const warnings = [];
  const map = byId(team);
  if (!plan || !Array.isArray(plan.order) || plan.order.length !== 9) return { ok: false, errors: ['打順は9人です'], warnings };
  if (new Set(plan.order).size !== 9) errors.push('同じ選手が打順に2回入っています');
  const seen = new Map();
  for (const id of plan.order) {
    const p = map.get(id);
    if (!p) { errors.push(`選手 ${id} はこのチームにいません`); continue; }
    const pos = plan.pos?.[id];
    if (!POSITIONS.includes(pos)) { errors.push(`${p.name}の守備位置がありません`); continue; }
    if (seen.has(pos)) errors.push(`${pos}が2人います（${seen.get(pos)}・${p.name}）`);
    seen.set(pos, p.name);
    if (pos === '投' && !p.pitching) errors.push(`${p.name}は投手ではありません`);
    if (pos !== '投' && p.pitching) errors.push(`投手の${p.name}は野手として出られません`);
    if (pos !== '投' && !p.pitching && !canPlay(p, pos)) warnings.push({ id, text: `${p.name}は${pos}が本職ではありません（守備力ダウン）` });
  }
  for (const pos of POSITIONS) if (!seen.has(pos) && errors.length === 0) errors.push(`${pos}がいません`);
  if (!plan.starter || plan.pos?.[plan.starter] !== '投' || !plan.order.includes(plan.starter)) errors.push('先発投手が打順に入っていません');
  return { ok: errors.length === 0, errors, warnings };
}

/** 9 人目（投手）以外の 8 守備位置を埋める（候補 = 野手）。守れない位置しか残らなければ本職外も可 */
function assignPositions(fielders) {
  // 候補の少ない位置から、その位置での価値が最も高い選手を選ぶ。全順列は不要（数が少ないので数通りの順で試して最良を採る）
  const orders = [
    [...FIELD_POS].sort((a, b) => fielders.filter((p) => canPlay(p, a)).length - fielders.filter((p) => canPlay(p, b)).length),
    ['捕', '遊', '二', '中', '三', '右', '左', '一'],
    ['捕', '中', '遊', '二', '右', '三', '左', '一'],
  ];
  let best = null;
  for (const ord of orders) {
    const used = new Set();
    const pick = {};
    let total = 0;
    for (const pos of ord) {
      let cand = fielders.filter((p) => !used.has(p.id) && canPlay(p, pos));
      let pen = 0;
      if (!cand.length) { cand = fielders.filter((p) => !used.has(p.id)); pen = 30; }
      cand.sort((a, b) => fitValue(b, pos) - fitValue(a, pos));
      const p = cand[0];
      if (!p) break;
      used.add(p.id);
      pick[pos] = p.id;
      total += fitValue(p, pos) - pen;
    }
    if (Object.keys(pick).length === 8 && (!best || total > best.total)) best = { pick, total };
  }
  return best ? best.pick : null;
}

/** 打順を組む（1 番 = 出塁と足、2 番 = ミート、3・4・5 番 = 主軸、6〜8 番 = 残り、9 番 = 投手） */
function battingOrder(players) {
  const rest = [...players];
  const take = (score) => {
    rest.sort((a, b) => score(b) - score(a));
    return rest.shift();
  };
  const order = new Array(8);
  order[3] = take((p) => p.power * 0.7 + p.contact * 0.3);            // 4 番
  order[2] = take((p) => batValue(p));                                 // 3 番
  order[0] = take((p) => p.speed * 0.5 + p.contact * 0.5 - p.power * 0.1); // 1 番
  order[4] = take((p) => p.power * 0.6 + p.contact * 0.4);            // 5 番
  order[1] = take((p) => p.contact * 0.7 + p.speed * 0.2);            // 2 番
  rest.sort((a, b) => batValue(b) - batValue(a));
  for (let i = 5; i < 8; i++) order[i] = rest.shift();
  return order;
}

/**
 * おまかせオーダー
 * @param {object} team
 * @param {{ starter?: string, exclude?: string[] }} [opts] exclude = 出場させない野手（ケガなど）
 */
export function autoPlan(team, { starter = null, exclude = [] } = {}) {
  const map = byId(team);
  const st = starter && map.get(starter)?.pitching ? starter : team.pitchers[0];
  const ex = new Set(exclude);
  const fielders = team.players.filter((p) => isFielder(p) && !ex.has(p.id));
  const pick = assignPositions(fielders);
  if (!pick) return defaultPlan(team, st);
  const players = FIELD_POS.map((pos) => map.get(pick[pos]));
  const order = [...battingOrder(players).map((p) => p.id), st];
  const pos = { [st]: '投' };
  for (const [ps, id] of Object.entries(pick)) pos[id] = ps;
  return { order, pos, starter: st };
}

/** plan の先発投手を差し替える（打順の投手の位置に入る） */
export function setStarter(team, plan, starterId) {
  const map = byId(team);
  if (!map.get(starterId)?.pitching) return plan;
  const order = plan.order.map((id) => (id === plan.starter ? starterId : id));
  const pos = { ...plan.pos };
  delete pos[plan.starter];
  pos[starterId] = '投';
  return { order, pos, starter: starterId };
}

/** 打順の 2 人を入れ替える（守備位置は選手について行く） */
export function swapOrder(plan, i, j) {
  const order = [...plan.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { ...plan, order };
}

/** 打順の 2 人の守備位置を入れ替える（投手は動かせない） */
export function swapPositions(plan, idA, idB) {
  const a = plan.pos[idA]; const b = plan.pos[idB];
  if (!a || !b || a === '投' || b === '投') return plan;
  return { ...plan, pos: { ...plan.pos, [idA]: b, [idB]: a } };
}

/** 控え野手 benchId を打順の outId と入れ替える（打順・守備位置を引き継ぐ） */
export function substitute(plan, outId, benchId) {
  const i = plan.order.indexOf(outId);
  if (i < 0 || plan.order.includes(benchId) || plan.pos[outId] === '投') return plan;
  const order = [...plan.order];
  order[i] = benchId;
  const pos = { ...plan.pos, [benchId]: plan.pos[outId] };
  delete pos[outId];
  return { ...plan, order, pos };
}

/** 控え野手（打順に入っていない野手） */
export function benchOfPlan(team, plan) {
  const inOrder = new Set(plan.order);
  return team.players.filter((p) => isFielder(p) && !inOrder.has(p.id)).map((p) => p.id);
}

/**
 * plan を適用したチームを作る（createGame に渡す）。
 * @param {object} team data.js 形式
 * @param {object} plan
 * @param {{ staminaMul?: Object<string,number>, rest?: string[] }} [opts]
 *   staminaMul: 投手 id → スタミナ倍率（疲労。0.4〜1）。rest: ベンチ外の投手（連投・登板過多で休養）
 */
export function applyLineup(team, plan, { staminaMul = {}, rest = [] } = {}) {
  const v = validatePlan(team, plan);
  if (!v.ok) throw new Error(v.errors[0]);
  const restSet = new Set(rest.filter((id) => id !== plan.starter));
  const players = team.players.map((p) => {
    let q = p;
    if (plan.order.includes(p.id) && !p.pitching && plan.pos[p.id] !== p.pos) q = { ...q, pos: plan.pos[p.id] };
    const mul = staminaMul[p.id];
    if (p.pitching && Number.isFinite(mul) && mul < 1) {
      q = { ...q, pitching: { ...p.pitching, stamina: Math.max(5, Math.round(p.pitching.stamina * Math.max(0.3, mul))) } };
    }
    return q;
  });
  const pitchers = [plan.starter, ...team.pitchers.filter((id) => id !== plan.starter && !restSet.has(id))];
  // 先発以外の投手が全員休養でも、最低 1 人はブルペンに残す
  if (pitchers.length < 2) {
    const extra = team.pitchers.find((id) => id !== plan.starter);
    if (extra) pitchers.push(extra);
  }
  return {
    ...team,
    lineup: [...plan.order],
    pitchers,
    bench: benchOfPlan(team, plan),
    players,
  };
}

/* ---------- 対戦モードのオーダー保存（チームごと） ---------- */
function readStore() {
  try {
    const o = JSON.parse(localStorage.getItem(LINEUP_KEY) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
/** 保存済みのオーダー（無い・壊れている・チームが変わって合わない場合は null） */
export function loadPlan(team) {
  if (!team) return null;
  const p = readStore()[team.id];
  if (!p || !Array.isArray(p.order) || typeof p.pos !== 'object' || !p.pos) return null;
  const plan = { order: p.order.map(String), pos: { ...p.pos }, starter: String(p.starter || '') };
  return validatePlan(team, plan).ok ? plan : null;
}
export function savePlan(team, plan) {
  if (!team || !validatePlan(team, plan).ok) return;
  try {
    const all = readStore();
    all[team.id] = plan;
    localStorage.setItem(LINEUP_KEY, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}
