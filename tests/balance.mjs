/**
 * バランス検証スクリプト
 *   node tests/balance.mjs [1カードの試合数=50] [カード...]
 *   例: node tests/balance.mjs 200 red-blue red-green blue-yellow green-yellow
 * シード固定の CPU 同士の試合を回し、1試合平均（両軍合計、9回）を docs/BALANCE.md の NPB 2023〜25 目標と比較する。
 * カードは「先攻-後攻」（チーム id）。省略時は red-blue / red-green / blue-yellow / green-yellow の4カード。
 * 係数の一時上書き: TUNE='{"sigmaBase":0.6}' node tests/balance.mjs
 */
import { TEAMS } from '../js/data.js';
import { simulateGame, TUNING } from '../js/engine.js';

if (process.env.TUNE) Object.assign(TUNING, JSON.parse(process.env.TUNE));

/** シード付き乱数（mulberry32） */
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

/** NPB 2023〜25 に基づく目標（両軍合計 / 試合）。[下限, 上限, 表示名] */
export const TARGETS = {
  runs: [6.5, 7.8, '得点'],
  hits: [15.5, 17.5, '安打'],
  doubles: [2.4, 3.2, '二塁打'],
  triples: [0.15, 0.45, '三塁打'],
  hr: [1.0, 1.7, '本塁打'],
  k: [13.0, 15.5, '三振'],
  bb: [4.8, 6.3, '四球'],
  hbp: [0.5, 0.9, '死球'],
  sb: [0.7, 1.3, '盗塁'],
  cs: [0.3, 0.55, '盗塁死'],
  sh: [0.9, 1.7, '犠打'],
  dp: [1.0, 1.6, '併殺'],
  e: [0.6, 1.2, '失策'],
  wp: [0.3, 0.6, '暴投・捕逸'],
  pa: [72, 77, '打席'],
  pitches: [260, 300, '投球数'],
  starterPitches: [80, 110, '先発の球数'],
};

/** 1試合の集計 */
export function gameStats(s, away, home) {
  const r = { runs: 0, hits: 0, doubles: 0, triples: 0, hr: 0, k: 0, bb: 0, ibb: 0, hbp: 0, sb: 0, cs: 0, sh: 0, sf: 0, dp: 0, e: 0, wp: 0, ab: 0, pa: 0, mistakes: 0 };
  r.runs = s.score.away.reduce((a, b) => a + b, 0) + s.score.home.reduce((a, b) => a + b, 0);
  r.hits = s.hits.away + s.hits.home;
  r.pitches = s.pitchCount.away + s.pitchCount.home;
  r.e = s.errors.away + s.errors.home;
  for (const st of Object.values(s.stats)) {
    r.k += st.so; r.bb += st.bb; r.hr += st.hr; r.ab += st.ab;
    r.ibb += st.ibb || 0; r.hbp += st.hbp || 0;
    r.sb += st.sb || 0; r.cs += st.cs || 0; r.sh += st.sh || 0;
  }
  for (const ev of s.log) {
    if (ev.kind === 'hit' && ev.bases === 2) r.doubles += 1;
    if (ev.kind === 'hit' && ev.bases === 3) r.triples += 1;
    if (ev.kind === 'double_play') r.dp += 1;
    if (ev.kind === 'sac_fly') r.sf += 1;
    if (ev.wildPitch) r.wp += 1;
    if (ev.pitch?.mistake) r.mistakes += 1;
  }
  r.pa = r.ab + r.bb + r.hbp + r.sh + r.sf;
  r.starterPitches = ((s.pitchesBy?.[away.pitchers[0]] || 0) + (s.pitchesBy?.[home.pitchers[0]] || 0)) / 2;
  r.innings = s.inning;
  r.awayWin = r.runs && s.score.away.reduce((a, b) => a + b, 0) > s.score.home.reduce((a, b) => a + b, 0) ? 1 : 0;
  return r;
}

/** カードごとに N 試合を回して合計を返す */
export function runBalance(N, cards, seed = 20261004) {
  const byId = Object.fromEntries(TEAMS.map((t) => [t.id, t]));
  const per = [];
  for (const card of cards) {
    const [a, h] = card.split('-');
    const away = byId[a]; const home = byId[h];
    if (!away || !home) throw new Error(`カード ${card} のチームが見つかりません`);
    const rng = mulberry32(seed + per.length * 7919);
    const sum = {};
    for (let g = 0; g < N; g++) {
      const s = simulateGame(home, away, rng);
      const r = gameStats(s, away, home);
      for (const [k, v] of Object.entries(r)) sum[k] = (sum[k] || 0) + v;
    }
    per.push({ card, n: N, sum });
  }
  return per;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('balance.mjs');
if (isMain) {
  const N = Number(process.argv[2] || 50);
  const cards = process.argv.slice(3).length ? process.argv.slice(3) : ['red-blue', 'red-green', 'blue-yellow', 'green-yellow'];
  const per = runBalance(N, cards, Number(process.env.SEED || 20261004));
  const all = {};
  let games = 0;
  for (const p of per) { games += p.n; for (const [k, v] of Object.entries(p.sum)) all[k] = (all[k] || 0) + v; }
  const avg = (sum, n, k) => sum[k] / n;
  console.log(`CPU vs CPU ${games}試合（${cards.join(' / ')}、各 ${N} 試合）平均（両軍合計 / 試合）`);
  const head = ['項目'.padEnd(6, '　'), '全体'.padStart(7), ...per.map((p) => p.card.padStart(13)), '  目標'];
  console.log(head.join(' '));
  let ok = 0;
  for (const [key, [lo, hi, label]] of Object.entries(TARGETS)) {
    const v = avg(all, games, key);
    const mark = v >= lo && v <= hi ? 'OK ' : v >= lo * 0.9 && v <= hi * 1.1 ? '近い' : 'NG ';
    if (mark === 'OK ') ok += 1;
    const cols = per.map((p) => avg(p.sum, p.n, key).toFixed(2).padStart(13));
    console.log(`${mark} ${label.padEnd(5, '　')} ${v.toFixed(2).padStart(7)} ${cols.join(' ')}  ${lo}〜${hi}`);
  }
  const ab = all.ab; const h = all.hits;
  const tb = h + all.doubles + 2 * all.triples + 3 * all.hr;
  const obpDen = ab + all.bb + all.hbp + all.sf;
  console.log(`目標内 ${ok}/${Object.keys(TARGETS).length}`);
  console.log(`打率 ${(h / ab).toFixed(3)} / 出塁率 ${((h + all.bb + all.hbp) / obpDen).toFixed(3)} / 長打率 ${(tb / ab).toFixed(3)}（NPB .241〜.246 / .302〜.309 / .341〜.362）`);
  console.log(`盗塁成功率 ${(100 * all.sb / Math.max(1, all.sb + all.cs)).toFixed(1)}% / 申告敬遠 ${(all.ibb / games).toFixed(2)} / 失投 ${(100 * all.mistakes / all.pitches).toFixed(1)}%/球 / 延長込みイニング ${(all.innings / games).toFixed(2)}`);
  console.log(`先攻の勝利 ${all.awayWin} / ${games}`);
}
