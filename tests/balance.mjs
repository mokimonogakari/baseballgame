/**
 * バランス検証スクリプト（node tests/balance.mjs）
 * シード固定の CPU 同士 50 試合を回し、1試合平均（両軍合計）を BALANCE.md の目標と比較する。
 */
import { TEAMS } from '../js/data.js';
import { simulateGame, TUNING } from '../js/engine.js';

// 試験用: TUNE='{"sigmaBase":0.6}' node tests/balance.mjs で係数を一時上書き
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

const N = Number(process.argv[2] || 50);
const rng = mulberry32(Number(process.env.SEED || 20261004));
const [red, blue] = TEAMS;
const totals = { runs: 0, hits: 0, k: 0, bb: 0, hr: 0, pitches: 0, sb: 0, cs: 0, sh: 0 };
const wins = { away: 0, home: 0, tie: 0 };
for (let g = 0; g < N; g++) {
  const s = simulateGame(blue, red, rng);
  const ra = s.score.away.reduce((a, b) => a + b, 0);
  const rh = s.score.home.reduce((a, b) => a + b, 0);
  totals.runs += ra + rh;
  totals.hits += s.hits.away + s.hits.home;
  totals.pitches += s.pitchCount.away + s.pitchCount.home;
  for (const st of Object.values(s.stats)) {
    totals.k += st.so; totals.bb += st.bb; totals.hr += st.hr;
    totals.sb += st.sb || 0; totals.cs += st.cs || 0; totals.sh += st.sh || 0;
  }
  wins[ra > rh ? 'away' : rh > ra ? 'home' : 'tie'] += 1;
}
const targets = { runs: [6, 9, '得点'], hits: [16, 20, '安打'], k: [10, 14, '三振'], bb: [4, 7, '四球'], hr: [1, 3, '本塁打'] };
console.log(`CPU vs CPU ${N}試合 平均（両軍合計）`);
for (const [key, [lo, hi, label]] of Object.entries(targets)) {
  const avg = totals[key] / N;
  const mark = avg >= lo && avg <= hi ? 'OK ' : avg >= lo * 0.85 && avg <= hi * 1.15 ? '近い' : 'NG ';
  console.log(`${mark} ${label.padEnd(4, '　')} ${avg.toFixed(2).padStart(6)}  （目標 ${lo}〜${hi}）`);
}
console.log(`盗塁 ${(totals.sb / N).toFixed(2)} / 盗塁死 ${(totals.cs / N).toFixed(2)} / 犠打 ${(totals.sh / N).toFixed(2)}`);
console.log(`投球数 ${(totals.pitches / N).toFixed(1)} / 勝敗 レッド(先攻) ${wins.away} - ブルー(後攻) ${wins.home} - 分 ${wins.tie}`);
