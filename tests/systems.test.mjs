/** NPB 準拠の試合システム（死球・暴投・敬遠・CPU 送りバント・失投・実効能力・スタミナゲージ・継投・到達時間）のテスト */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../js/data.js';
import {
  createGame, pitchContact, resolvePitch, pitchLocation, chooseSwing, choosePitch, getBatter, getPitcher,
  intentionalWalk, cpuWantsIntentionalWalk, effectiveStats, staminaOf, cpuManage, pitchFlightMs, simulateGame,
  TUNING, PITCH_COST, CONDITIONS, SKILL_FX, SKILLS, SKILL_RENAMES, meetCursor, swingProbabilities,
} from '../js/engine.js';

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
const [red, blue] = TEAMS;
const allNormal = (teams) => Object.fromEntries(teams.flatMap((t) => t.players.map((p) => [p.id, '普通'])));
/** away = レッド（ユーザー）、home = ブルー（CPU）。全員「普通」 */
const game = (extra = {}, conds = {}) => createGame(blue, red, { conditions: { ...allNormal([red, blue]), ...conds }, ...extra });
const edit = (s, patch) => Object.assign(structuredClone(s), patch);
const withTuning = (patch, fn) => {
  const old = Object.fromEntries(Object.keys(patch).map((k) => [k, TUNING[k]]));
  Object.assign(TUNING, patch);
  try { return fn(); } finally { Object.assign(TUNING, old); }
};

test('死球: 打者は一塁へ、押し出しの走者だけ進み、満塁なら1点。kind = hbp', () => {
  const s0 = edit(game(), { bases: ['r1', null, 'r3'], balls: 1, strikes: 1 });
  const batter = getBatter(s0);
  const pitch = { type: 'fastball', zone: { x: 0, y: 1 }, loc: { x: -2.3, y: 0, hbp: true } };
  const r = pitchContact(s0, pitch, null, mulberry32(1));
  assert.equal(r.event.kind, 'hbp');
  assert.equal(r.event.hbp, true);
  assert.match(r.event.text, /デッドボール/);
  assert.deepEqual(r.state.bases, [batter.id, 'r1', 'r3'], '三塁走者はフォースでないので動かない');
  assert.equal(r.state.stats[batter.id].hbp, 1);
  assert.equal(r.state.stats[batter.id].ab, 0);
  assert.equal(r.state.balls, 0);
  assert.equal(getBatter(r.state).id, red.lineup[1]);
  assert.equal(r.state.log.at(-1).kind, 'hbp');
  // 満塁 → 押し出し
  const loaded = pitchContact(edit(game(), { bases: ['r1', 'r2', 'r3'] }), pitch, null, mulberry32(1));
  assert.equal(loaded.event.runs, 1);
  assert.equal(loaded.state.score.away[0], 1);
  // スイングした場合は死球にならない
  const swung = pitchContact(s0, pitch, { mode: 'meet', pos: { x: 0, y: 0 }, timing: 0 }, mulberry32(1));
  assert.notEqual(swung.event.kind, 'hbp');
});

test('死球: pitchLocation は打者の内角に大きく外れた球だけを死球にし、CPU はその球を振らない', () => {
  const s = game();
  const batter = getBatter(s); // 速水（左打者）→ 内角は +x
  assert.equal(batter.bats, '左');
  const rng = mulberry32(3);
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const loc = pitchLocation(s, { type: 'fastball', zone: { x: 2, y: 1 }, offset: { x: 0.6, y: 0 } }, rng);
    if (!loc.hbp) continue;
    n++;
    assert.ok(loc.x > TUNING.hbpX && Math.abs(loc.y) < TUNING.hbpY, `${loc.x},${loc.y}`);
    assert.equal(chooseSwing(s, { type: 'fastball', zone: { x: 2, y: 1 }, loc }, rng), null);
  }
  assert.ok(n > 5, `${n}`);
  // 外角（-x）へ外れても死球にならない
  for (let i = 0; i < 2000; i++) assert.ok(!pitchLocation(s, { type: 'fastball', zone: { x: 0, y: 1 }, offset: { x: -0.6, y: 0 } }, rng).hbp);
});

test('暴投・捕逸: 走者がそれぞれ1つ進み（三塁走者は生還）、打者の結果はなし。event.wildPitch', () => {
  const s0 = edit(game(), { bases: ['r1', null, 'r3'] });
  const batter = getBatter(s0);
  const r = pitchContact(s0, { type: 'fork', zone: { x: 1, y: 2 }, loc: { x: 0, y: 2.4, wildPitch: 'wild_pitch' } }, null, mulberry32(2));
  assert.equal(r.event.kind, 'ball');
  assert.equal(r.event.wildPitch.kind, 'wild_pitch');
  assert.equal(r.event.wildPitch.runs, 1);
  assert.deepEqual(r.event.wildPitch.runners.map((x) => [x.id, x.from, x.to]), [['r3', 3, 4], ['r1', 1, 2]]);
  assert.deepEqual(r.state.bases, [null, 'r1', null]);
  assert.equal(r.state.score.away[0], 1);
  assert.equal(r.state.balls, 1);
  assert.equal(getBatter(r.state).id, batter.id, '打席は続く');
  assert.equal(r.state.stats[batter.id].rbi, 0, '暴投の得点に打点はつかない');
  assert.match(r.event.text, /ワイルドピッチ/);
  // 捕逸は自責点にしない
  const pb = pitchContact(s0, { type: 'fork', zone: { x: 1, y: 2 }, loc: { x: 0, y: 2.4, wildPitch: 'passed_ball' } }, null, mulberry32(2));
  assert.equal(pb.event.wildPitch.kind, 'passed_ball');
  assert.equal(pb.state.stats[getPitcher(s0).id].er, 0);
  // 走者がいなければ pitchLocation は暴投を出さない。低めのフォークは制球が悪いほど暴投が多い
  const rng = mulberry32(4);
  const empty = game();
  for (let i = 0; i < 3000; i++) assert.ok(!pitchLocation(empty, { type: 'fork', zone: { x: 1, y: 2 }, offset: { x: 0, y: 0.6 } }, rng).wildPitch);
  const rate = (control, type) => {
    const home = structuredClone(blue);
    Object.assign(home.players.find((p) => p.id === 'b10').pitching, { control });
    const st = edit(createGame(home, red, { conditions: allNormal([red, blue]) }), { bases: ['r1', null, null] });
    const rr = mulberry32(5);
    let w = 0;
    for (let i = 0; i < 6000; i++) if (pitchLocation(st, { type, zone: { x: 1, y: 2 }, offset: { x: 0, y: 0.6 } }, rr).wildPitch) w++;
    return w / 6000;
  };
  assert.ok(rate(30, 'fork') > rate(90, 'fork'), '制球が悪いほど多い');
  assert.ok(rate(60, 'fork') > rate(60, 'fastball'), 'フォークは多い');
});

test('申告敬遠: 投球なしで一塁へ（kind = ibb、四球と敬遠に記録、投球数は増えない）', () => {
  const s0 = edit(game(), { inning: 8, bases: [null, 'r1', null], batterIndex: { away: 4, home: 0 } });
  const batter = getBatter(s0);
  const pc = s0.pitchCount.home;
  const { state, event } = intentionalWalk(s0, mulberry32(1));
  assert.equal(event.kind, 'ibb');
  assert.equal(event.intentional, true);
  assert.match(event.text, /敬遠/);
  assert.deepEqual(state.bases, [batter.id, 'r1', null]);
  assert.equal(state.stats[batter.id].bb, 1);
  assert.equal(state.stats[batter.id].ibb, 1);
  assert.equal(state.pitchCount.home, pc);
  assert.equal(getBatter(state).id, red.lineup[5]);
  // pitchContact / resolvePitch に intentional を渡しても同じ
  const r2 = resolvePitch(s0, { type: 'fastball', zone: { x: 1, y: 1 }, intentional: true }, null, mulberry32(1));
  assert.equal(r2.event.kind, 'ibb');
  assert.equal(r2.state.log.at(-1).kind, 'ibb');
});

test('申告敬遠: CPU は終盤・接戦・一塁が空き・強打者（次打者が弱い）のときだけ選ぶ', () => {
  const base = game(); // home（ブルー）が CPU 守備
  // 5番 黒木（ミート75・パワー88）→ 次は 緑川（72+60）
  const spot = edit(base, { inning: 8, bases: [null, 'r1', null], batterIndex: { away: 4, home: 0 } });
  assert.equal(cpuWantsIntentionalWalk(spot), true);
  assert.equal(choosePitch(spot, () => 0).intentional, true);
  assert.equal(cpuWantsIntentionalWalk(edit(spot, { inning: 3 })), false, '序盤はしない');
  assert.equal(cpuWantsIntentionalWalk(edit(spot, { bases: ['r2', 'r1', null] })), false, '一塁が埋まっている');
  assert.equal(cpuWantsIntentionalWalk(edit(spot, { bases: [null, null, null] })), false, '得点圏に走者なし');
  assert.equal(cpuWantsIntentionalWalk(edit(spot, { balls: 1 })), false, '打席の途中はしない');
  assert.equal(cpuWantsIntentionalWalk(edit(spot, { score: { away: [0, 0, 0, 0, 0, 0, 0, 0], home: [5, 0, 0, 0, 0, 0, 0] } })), false, '大差');
  assert.equal(cpuWantsIntentionalWalk(edit(spot, { batterIndex: { away: 2, home: 0 } })), false, '次打者も強い');
  // ユーザーの守備（away）は autoUserPitcher のときだけ
  const userDef = edit(base, { inning: 8, half: 'bottom', bases: [null, 'b1', null], batterIndex: { away: 0, home: 3 } });
  const strongHome = cpuWantsIntentionalWalk({ ...userDef, autoUserPitcher: true });
  assert.equal(cpuWantsIntentionalWalk(userDef), false);
  assert.equal(typeof strongHome, 'boolean');
});

test('CPU の送りバント: 無死一塁で投手（弱い打者）はストライクをバント、ボールは見送る。1死ならしない', () => {
  // home（ブルー）の攻撃、9番 = 投手 b10、userSide = away
  const s = edit(game(), { half: 'bottom', bases: ['b8', null, null], batterIndex: { away: 0, home: 8 } });
  assert.ok(getBatter(s).pitching);
  const strike = { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0.2, y: 0.1 } };
  const ball = { type: 'fastball', zone: { x: 2, y: 1 }, loc: { x: 2.2, y: 0 } };
  withTuning({ cpuBuntRate: 1, cpuBuntPitch: 1 }, () => {
    const sw = chooseSwing(s, strike, mulberry32(1));
    assert.equal(sw.mode, 'bunt');
    assert.equal(chooseSwing(s, ball, mulberry32(1)), null);
    const one = chooseSwing(edit(s, { outs: 1 }), strike, mulberry32(1));
    assert.ok(!one || one.mode !== 'bunt');
    const third = chooseSwing(edit(s, { bases: ['b8', null, 'b1'] }), strike, mulberry32(1));
    assert.ok(!third || third.mode !== 'bunt', '三塁に走者がいればしない');
  });
  // CPU 同士の試合で送りバントが記録される
  let sh = 0;
  const rng = mulberry32(8);
  for (let g = 0; g < 10; g++) for (const st of Object.values(simulateGame(blue, red, rng).stats)) sh += st.sh;
  assert.ok(sh >= 3, `${sh}`);
});

test('失投: 制球で確率が決まり（一発 ×2、失投回避 ×0.5）、真ん中寄りで変化は半分。event.pitch.mistake', () => {
  const rate = (control, skills) => {
    const home = structuredClone(blue);
    const p = home.players.find((x) => x.id === 'b10');
    Object.assign(p.pitching, { control });
    p.skills = skills;
    const st = createGame(home, red, { conditions: allNormal([red, blue]) });
    const rng = mulberry32(11);
    let m = 0; let mx = 0;
    for (let i = 0; i < 8000; i++) {
      const l = pitchLocation(st, { type: 'slider', zone: { x: 0, y: 0 } }, rng);
      if (l.mistake) { m++; mx += Math.abs(l.x) + Math.abs(l.y); }
    }
    return { p: m / 8000, spread: mx / Math.max(1, m) };
  };
  const base = rate(50, []);
  const expect = TUNING.mistakeBase + TUNING.mistakeK * (1 - 50 / 99);
  assert.ok(Math.abs(base.p - expect) < 0.012, `${base.p} vs ${expect}`);
  assert.ok(rate(95, []).p < base.p, '制球が良いほど少ない');
  assert.ok(Math.abs(rate(50, ['一発']).p / base.p - 2) < 0.35, '一発は約2倍');
  assert.ok(Math.abs(rate(50, ['失投回避']).p / base.p - 0.5) < 0.15, '失投回避は約半分');
  assert.ok(base.spread < 1.2, `失投は真ん中寄り ${base.spread}`);
  // pitchContact へ引き継がれ、失投は打ちやすい（本塁打 ×1.3）
  const s = game();
  const r = pitchContact(s, { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0.1, y: 0.1, mistake: true } }, null, mulberry32(1));
  assert.equal(r.event.pitch.mistake, true);
  const b = red.players.find((p) => p.id === 'r4');
  const p = blue.players.find((x) => x.id === 'b10');
  const hr = (mistake) => swingProbabilities(b, p, 'fastball', 'meet', 0, 0, true, 0, { loc: { x: 0, y: 0, mistake } })[8];
  assert.ok(hr(true) > hr(false) * 1.25);
});

test('effectiveStats: 調子は加算（打者 +15/+10/0/−10/−15、弾道 ±1）、投手は球速・制球・スタミナ', () => {
  const r4 = red.players.find((p) => p.id === 'r4');
  const b10 = blue.players.find((p) => p.id === 'b10');
  const want = { 絶好調: [15, 1], 好調: [10, 0], 普通: [0, 0], 不調: [-10, 0], 絶不調: [-15, -1] };
  for (const [c, [d, tr]] of Object.entries(want)) {
    const s = game({}, { r4: c, b10: c });
    const e = effectiveStats(s, r4, { skills: false });
    assert.equal(e.contact, r4.contact + d, `${c} contact`);
    assert.equal(e.power, r4.power + d, `${c} power`);
    assert.equal(e.trajectory, r4.trajectory + tr, `${c} trajectory`);
    assert.equal(e.speed, r4.speed, '走力は調子の影響なし');
    assert.equal(e.condition, c);
    const ep = effectiveStats(s, b10, { skills: false });
    assert.equal(ep.velocity, b10.pitching.velocity + CONDITIONS[c].pit.velocity);
    assert.equal(ep.control, b10.pitching.control + CONDITIONS[c].pit.control);
    assert.equal(ep.stamina, b10.pitching.stamina + CONDITIONS[c].pit.stamina);
  }
  assert.deepEqual([CONDITIONS.絶好調.pit.velocity, CONDITIONS.絶好調.pit.control, CONDITIONS.絶好調.pit.stamina], [3, 10, 25]);
  // 状況の特殊能力: チャンス◎（r4）は得点圏で ミート+15・パワー+10。mods に表示用の内訳
  const s = game();
  const risp = edit(s, { bases: [null, 'r1', null], batterIndex: { away: 3, home: 0 } });
  const e0 = effectiveStats(s, r4);
  const e1 = effectiveStats(risp, r4);
  assert.equal(e1.contact - e0.contact, 15);
  assert.equal(e1.power - e0.power, 10);
  assert.ok(e1.mods.some((m) => m.source === 'チャンス◎' && m.add.contact === 15));
  // 三振（赤）: 2ストライクで ミート −20
  const r5 = red.players.find((p) => p.id === 'r5');
  assert.equal(effectiveStats(edit(s, { strikes: 2 }), r5).contact, r5.contact - 20);
  assert.equal(effectiveStats(edit(s, { strikes: 1 }), r5).contact, r5.contact);
  // 二重に数えない: 加算に移した能力は打席結果の重みに倍率を持たない
  for (const n of ['チャンス◎', 'チャンス×', '対左投手◎', '初球○', '三振']) {
    assert.ok(SKILL_FX[n].add && SKILL_FX[n].hits == null && SKILL_FX[n].strike == null, n);
  }
  // meetCursor・swingProbabilities は実効値を使う
  const good = game({}, { r4: '絶好調' });
  const bad = game({}, { r4: '絶不調' });
  assert.ok(meetCursor(r4, 'meet', good).rx > meetCursor(r4, 'meet', bad).rx);
  const clamp99 = { ...r4, contact: 99 };
  assert.ok(effectiveStats(good, clamp99, { skills: false }).contact > 99, '99 を超えて加算できる（上限 110）');
});

test('剛球無双: 改名済み（旧名は SKILL_RENAMES で読み替え）、パワプロ固有名の能力は使わない', () => {
  assert.ok(SKILLS.剛球無双 && SKILL_FX.剛球無双);
  assert.equal(SKILLS.怪物球威, undefined);
  assert.equal(SKILL_RENAMES.怪物球威, '剛球無双');
  for (const t of TEAMS) for (const p of t.players) assert.ok(!p.skills.includes('怪物球威'));
  // 旧名のまま保存された選手でも効果が出る
  const b = red.players.find((p) => p.id === 'r6');
  const p0 = { ...blue.players.find((p) => p.id === 'b10'), skills: [] };
  const P = (p) => swingProbabilities(b, p, 'fastball', 'meet', 0, 0, true)[8];
  assert.ok(P({ ...p0, skills: ['怪物球威'] }) < P(p0));
  const banned = ['怪物球威', 'ドクターK', '精密機械', '鉄腕', '安打製造機', 'アーチスト', '逃げ球', '威圧感', 'ハイスピードジェット', '電光石火'];
  for (const n of banned) assert.equal(SKILLS[n], undefined, n);
});

test('スタミナゲージ: スタミナ×32＋先発1500、球種別の消費＋走者分、被安打で追加消費。staminaPct 0〜100', () => {
  const s0 = game();
  const b10 = blue.players.find((p) => p.id === 'b10');
  const b12 = blue.players.find((p) => p.id === 'b12');
  assert.equal(s0.staminaMax.b10, b10.pitching.stamina * 32 + 1500);
  assert.equal(s0.staminaMax.b12, b12.pitching.stamina * 32, '救援は先発ボーナスなし');
  assert.equal(s0.staminaPct.b10, 100);
  assert.equal(s0.stamina.b10, b10.pitching.stamina, '旧来の state.stamina は満タン = 能力値');
  const exc = createGame(blue, red, { conditions: { ...allNormal([red, blue]), b10: '絶好調' } });
  assert.equal(exc.staminaMax.b10, (b10.pitching.stamina + 25) * 32 + 1500, '調子でゲージが増減');
  const OUT = { type: 'fastball', zone: { x: 2, y: 1 }, loc: { x: 2.4, y: 0 } };
  const r1 = pitchContact(s0, OUT, null, mulberry32(1)).state;
  assert.equal(s0.staminaMax.b10 - r1.staminaGauge.b10, PITCH_COST.fastball);
  const withRunner = pitchContact(edit(s0, { bases: ['r1', null, null] }), { ...OUT, type: 'fork' }, null, mulberry32(1)).state;
  assert.equal(s0.staminaMax.b10 - withRunner.staminaGauge.b10, PITCH_COST.fork + TUNING.runnerCost1);
  assert.ok(Math.abs(r1.stamina.b10 - b10.pitching.stamina * r1.staminaGauge.b10 / r1.staminaMax.b10) < 0.01, '旧来の値も同期');
  assert.ok(r1.staminaPct.b10 < 100 && r1.staminaPct.b10 > 99);
  assert.equal(staminaOf(r1, 'b10').pct, r1.staminaPct.b10);
  // 安打は追加で消費
  let hitDrain = null;
  for (let seed = 0; seed < 300 && hitDrain == null; seed++) {
    const r = resolvePitch(s0, { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0 } }, { mode: 'meet', pos: { x: 0, y: 0 }, timing: 0 }, mulberry32(seed));
    if (r.event.kind === 'hit' && r.event.bases === 1 && !r.event.runs) hitDrain = s0.staminaMax.b10 - r.state.staminaGauge.b10;
  }
  assert.equal(hitDrain, PITCH_COST.fastball + TUNING.hitCost[1]);
  // 外部から旧来の stamina を書き換えるとゲージも合わせる（UI・テスト互換）
  const low = { ...structuredClone(s0), half: 'top' };
  low.stamina.b10 = 8.6;
  assert.ok(Math.abs(staminaOf(low, 'b10').pct - 10) < 0.01);
});

test('スタミナ: CPU 同士の試合で先発は 85〜110 球前後で降板し、両軍 260〜300 球', () => {
  const rng = mulberry32(21);
  const sp = []; let pitches = 0;
  const N = 20;
  for (let g = 0; g < N; g++) {
    const s = simulateGame(blue, red, rng);
    sp.push(s.pitchesBy[red.pitchers[0]], s.pitchesBy[blue.pitchers[0]]);
    pitches += s.pitchCount.away + s.pitchCount.home;
    for (const id of Object.keys(s.staminaPct)) assert.ok(s.staminaPct[id] >= 0 && s.staminaPct[id] <= 100);
  }
  const avg = sp.reduce((a, b) => a + b, 0) / sp.length;
  assert.ok(avg >= 80 && avg <= 110, `先発 ${avg}`);
  assert.ok(pitches / N >= 250 && pitches / N <= 310, `${pitches / N}`);
});

test('継投: 先発 → 8回の頭にセットアッパー（1〜3点リード）→ 9回に抑え。疲れたら中継ぎ', () => {
  // top = ブルー（home、CPU）が守備
  const lead2 = (inning) => ({ inning, half: 'top', outs: 0, bases: [null, null, null],
    score: { away: Array(inning).fill(0), home: [2, ...Array(inning - 2).fill(0)] } });
  const s8 = edit(game(), lead2(8));
  const r8 = cpuManage(s8);
  assert.equal(r8.events[0]?.reason, 'setup');
  assert.equal(getPitcher(r8.state).id, 'b12');
  assert.equal(getPitcher(r8.state).pitching.role, 'setup');
  const r9 = cpuManage(edit(r8.state, lead2(9)));
  assert.equal(r9.events[0]?.reason, 'closer');
  assert.equal(getPitcher(r9.state).pitching.role, 'closer');
  // 大差・同点ではセットアッパーを使わない
  const tie = edit(game(), { ...lead2(8), score: { away: Array(8).fill(0), home: Array(7).fill(0) } });
  assert.equal(cpuManage(tie).events.length, 0);
  // 3回に疲れた先発 → 中継ぎ（勝ちパターンは温存）
  const tired = edit(game(), { inning: 3, half: 'top', score: { away: [0, 0, 0], home: [0, 0] } });
  tired.stamina.b10 = 8;
  const rt = cpuManage(tired);
  assert.equal(rt.events[0]?.reason, 'tired');
  assert.equal(getPitcher(rt.state).pitching.role, 'reliever');
  // ユーザー側も autoUserPitcher なら同じ（bottom = レッドが守備）
  const u9 = edit(game(), { inning: 9, half: 'bottom', outs: 0, score: { away: [1, 0, 0, 0, 0, 0, 0, 0, 0], home: Array(8).fill(0) } });
  assert.equal(cpuManage(u9).events.length, 0, '既定ではユーザーの投手は替えない');
  const ru = cpuManage({ ...u9, autoUserPitcher: true });
  assert.equal(ru.events[0]?.side, 'away');
  assert.equal(getPitcher(ru.state).pitching.role, 'closer');
});

test('pitchFlightMs: 球速が上がるほど短い（単調）、145km/h ストレート normal ≈ 620ms、難易度・球種で変わる', () => {
  let prev = Infinity;
  for (let kmh = 110; kmh <= 170; kmh += 2) {
    const ms = pitchFlightMs(kmh, 'fastball', 'normal');
    assert.ok(ms < prev, `${kmh}`);
    prev = ms;
  }
  assert.equal(pitchFlightMs(145, 'fastball', 'normal'), 620);
  assert.ok(Math.abs(pitchFlightMs(145, 'fastball', 'easy') - 620 * 1.35) <= 1);
  assert.ok(Math.abs(pitchFlightMs(145, 'fastball', 'hard') - 620 * 0.82) <= 1);
  assert.ok(pitchFlightMs(145, 'curve') > pitchFlightMs(145, 'slider'));
  assert.ok(pitchFlightMs(145, 'slider') > pitchFlightMs(145, 'fastball'));
  const fast = { pitching: { velocity: 156 }, skills: [] };
  const slow = { pitching: { velocity: 134 }, skills: [] };
  assert.ok(pitchFlightMs(fast, 'fastball') < pitchFlightMs(slow, 'fastball'));
  assert.ok(pitchFlightMs(fast, 'fastball', 'normal', { kmh: 120 }) > pitchFlightMs(fast, 'fastball'));
  // 投球ごとの球速（loc.kmh / event.pitch.kmh）
  const loc = pitchLocation(game(), { type: 'fastball', zone: { x: 1, y: 1 } }, mulberry32(3));
  assert.ok(Math.abs(loc.kmh - blue.players.find((p) => p.id === 'b10').pitching.velocity) <= 6);
});

test('CPU 同士の試合: 死球・暴投・敬遠・犠打・失投のイベントが出て、ログのテキストがそろう', () => {
  const rng = mulberry32(99);
  const kinds = {};
  let wp = 0; let mistake = 0;
  for (let g = 0; g < 30; g++) {
    const s = simulateGame(TEAMS[g % 4], TEAMS[(g + 2) % 4], rng);
    for (const ev of s.log) {
      kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
      if (ev.wildPitch) wp++;
      if (ev.pitch?.mistake) mistake++;
      assert.ok(typeof ev.text === 'string' && ev.text.length > 0, ev.kind);
    }
  }
  assert.ok(kinds.hbp > 0, 'hbp');
  assert.ok(kinds.sac_bunt > 0, 'sac_bunt');
  assert.ok(wp > 0, 'wild pitch');
  assert.ok(mistake > 0, 'mistake');
});
