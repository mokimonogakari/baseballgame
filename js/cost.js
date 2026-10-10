/**
 * チームコスト制（パワプロ eBASEBALL 風）
 * 選手ごとに 1〜15 の「コスト」を目安として表示する（合計の上限はなし）。
 * data.js / engine.js に playerCost があればそれを優先し、無ければここで能力から算出する。
 */
import * as engine from './engine.js';
import * as data from './data.js';

/** チームコストの上限。祐友さんの指示で制限なし（参考表示のみ） */
export const TEAM_COST_CAP = Infinity;
export const ROSTER_SIZE = 25;
export const MIN_PITCHERS = 10;
export const MIN_CATCHERS = 2;
/** 守備位置（野手8人分） */
export const FIELD_POSITIONS = ['捕', '一', '二', '三', '遊', '左', '中', '右'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const velScale = (kmh) => clamp(Math.round(((kmh - 120) / 50) * 99), 1, 99);

/** 総合力 0-99（並べ替え・自動編成用） */
export function overallOf(p) {
  if (p.pitching) {
    const pi = p.pitching;
    const lv = (pi.pitches || []).reduce((a, b) => a + (b.level || 0), 0);
    const pitchScore = clamp(lv * 11, 10, 99);
    const starter = pi.role === 'starter';
    const s = starter
      ? 0.30 * velScale(pi.velocity) + 0.28 * pi.control + 0.24 * pi.stamina + 0.18 * pitchScore
      : 0.42 * velScale(pi.velocity) + 0.36 * pi.control + 0.06 * pi.stamina + 0.16 * pitchScore;
    return Math.round(s);
  }
  return Math.round(0.28 * p.contact + 0.27 * p.power + 0.17 * p.speed + 0.16 * p.fielding + 0.12 * p.arm);
}

function ownCost(p) {
  const s = overallOf(p);
  let c = 1 + ((s - 47) / (74 - 47)) * 14;
  if (p.pitching && p.pitching.role === 'closer') c += 0.8;
  return clamp(Math.round(c), 1, 15);
}

/** 選手のコスト 1〜15 */
export function playerCost(p) {
  for (const mod of [data, engine]) {
    if (typeof mod.playerCost !== 'function') continue;
    try {
      const v = Math.round(mod.playerCost(p));
      if (Number.isFinite(v)) return clamp(v, 1, 15);
    } catch (e) { /* fall through */ }
  }
  return ownCost(p);
}

/** コストの色（1=緑 → 8=黄 → 15=赤紫） */
export function costColor(c) {
  const t = (clamp(c, 1, 15) - 1) / 14;
  const hue = Math.round(150 - t * 190); // 150 → -40(=320)
  const h = (hue + 360) % 360;
  const light = t > 0.3 && t < 0.62 ? 52 : 42;
  const fg = t > 0.3 && t < 0.62 ? '#1C2B4B' : '#fff';
  return { bg: `hsl(${h} 70% ${light}%)`, fg };
}

export const isCatcher = (p) => !p.pitching && (p.positions || [p.pos]).includes('捕');
export const isCloser = (p) => !!p.pitching && p.pitching.role === 'closer';

/** 8守備位置を重複なく埋める割り当て（二部マッチング）。pos → player。埋まらない位置は含まれない */
export function matchPositions(fielders, prefer = (p) => overallOf(p)) {
  const owner = {}; // pos -> player
  const cands = {};
  for (const pos of FIELD_POSITIONS) {
    cands[pos] = fielders.filter((p) => (p.positions || [p.pos]).includes(pos))
      .sort((a, b) => ((b.pos === pos) - (a.pos === pos)) || (prefer(b) - prefer(a)));
  }
  const tryPlace = (pos, seen) => {
    for (const p of cands[pos]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const cur = Object.keys(owner).find((k) => owner[k].id === p.id);
      if (!cur || tryPlace(cur, seen)) {
        if (cur) delete owner[cur];
        owner[pos] = p;
        return true;
      }
    }
    return false;
  };
  const order = [...FIELD_POSITIONS].sort((a, b) => cands[a].length - cands[b].length);
  for (const pos of order) tryPlace(pos, new Set());
  return owner;
}

/** ロスターの検証。{ cost, ok, errors:[日本語], missingPositions } */
export function validateRoster(players) {
  const errors = [];
  const cost = players.reduce((a, p) => a + playerCost(p), 0);
  const n = players.length;
  if (n < ROSTER_SIZE) errors.push(`あと${ROSTER_SIZE - n}人えらんでください（${n}/${ROSTER_SIZE}人）`);
  if (n > ROSTER_SIZE) errors.push(`${n - ROSTER_SIZE}人おおすぎます`);
  if (cost > TEAM_COST_CAP) errors.push(`チームコストが${cost - TEAM_COST_CAP}オーバーです`);
  const pit = players.filter((p) => p.pitching);
  if (pit.length < MIN_PITCHERS) errors.push(`投手があと${MIN_PITCHERS - pit.length}人ひつようです`);
  if (!pit.some(isCloser)) errors.push('抑え投手が1人ひつようです');
  const fielders = players.filter((p) => !p.pitching);
  const cat = fielders.filter(isCatcher).length;
  if (cat < MIN_CATCHERS) errors.push(`捕手があと${MIN_CATCHERS - cat}人ひつようです`);
  const m = matchPositions(fielders);
  const missingPositions = FIELD_POSITIONS.filter((pos) => !m[pos]);
  if (missingPositions.length) errors.push(`守れる選手が足りないポジション: ${missingPositions.join('・')}`);
  return { cost, ok: errors.length === 0, errors, missingPositions };
}

/** おまかせ編成: 総合力の高い順に、残りの必須枠を最安で埋められる範囲で選ぶ */
export function autoBuild(pool) {
  const strategies = [
    (a, b) => overallOf(b) - overallOf(a) || playerCost(a) - playerCost(b),
    (a, b) => (overallOf(b) - 3 * playerCost(b)) - (overallOf(a) - 3 * playerCost(a)),
    (a, b) => playerCost(a) - playerCost(b) || overallOf(b) - overallOf(a),
  ];
  let best = null;
  for (const cmp of strategies) {
    const r = autoBuildWith(pool, [...pool].sort(cmp));
    if (validateRoster(r).ok) return r;
    best = best || r;
  }
  return best;
}

function autoBuildWith(pool, sorted) {
  const chosen = [];
  const completes = (sel) => {
    const set = new Set(sel.map((p) => p.id));
    const rest = pool.filter((p) => !set.has(p.id)).sort((a, b) => playerCost(a) - playerCost(b) || overallOf(b) - overallOf(a));
    const cur = [...sel];
    const add = (p) => { cur.push(p); set.add(p.id); };
    // 不足要件を先に最安で満たす
    const need = (pred, count) => {
      let have = cur.filter(pred).length;
      for (const p of rest) { if (have >= count || cur.length >= ROSTER_SIZE) break; if (!set.has(p.id) && pred(p)) { add(p); have++; } }
    };
    need(isCloser, 1);
    need(isCatcher, MIN_CATCHERS);
    need((p) => !!p.pitching, MIN_PITCHERS);
    const size = (list) => Object.keys(matchPositions(list.filter((p) => !p.pitching))).length;
    for (let guard = 0; guard < 8 && cur.length < ROSTER_SIZE; guard++) {
      const base = size(cur);
      if (base >= FIELD_POSITIONS.length) break;
      const c = rest.find((p) => !set.has(p.id) && !p.pitching && size([...cur, p]) > base);
      if (!c) break;
      add(c);
    }
    for (const p of rest) { if (cur.length >= ROSTER_SIZE) break; if (!set.has(p.id)) add(p); }
    return cur.length === ROSTER_SIZE && validateRoster(cur).ok;
  };
  for (const p of sorted) {
    if (chosen.length >= ROSTER_SIZE) break;
    if (completes([...chosen, p])) chosen.push(p);
  }
  if (chosen.length < ROSTER_SIZE) {
    // 取りこぼし: 最安から補充
    const set = new Set(chosen.map((p) => p.id));
    for (const p of [...pool].sort((a, b) => playerCost(a) - playerCost(b))) {
      if (chosen.length >= ROSTER_SIZE) break;
      if (!set.has(p.id)) chosen.push(p);
    }
  }
  return chosen;
}
