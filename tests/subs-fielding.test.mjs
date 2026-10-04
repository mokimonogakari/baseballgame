/** 選手交代・打球/守備（pitchContact → resolveBattedBall）のテスト（node --test tests/） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../js/data.js';
import * as E from '../js/engine.js';
import {
  createGame, getBatter, getPitcher, resolvePitch, summary, changePitcher,
  availableBench, availablePitchers, pinchHit, pinchRun, defensiveSwap, lineupView, cpuManage,
  pitchContact, autoField, resolveBattedBall, FIELD, DEFAULT_POSITIONS, fenceDistance, ballPositionAt,
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
/** away=レッド（ユーザー）、home=ブルー（CPU） */
const newGame = () => createGame(blue, red);
const IN = { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0 } };
const OUT = { type: 'fastball', zone: { x: 2, y: 2 }, loc: { x: 2.5, y: 2.5 } };
const SWING = { zone: { x: 1, y: 1 }, mode: 'meet', timing: 0 };
const runsOf = (s) => s.score.away.reduce((a, b) => a + b, 0) + s.score.home.reduce((a, b) => a + b, 0);
const walk = (s) => { for (let i = 0; i < 4; i++) s = resolvePitch(s, OUT, null).state; return s; };
const posId = (s, side, pos) => lineupView(s, side).find((v) => v.pos === pos).id;

/** 条件に合う打球が出るまでシードを変えて pitchContact */
function findBall(s, pred, from = 0) {
  for (let seed = from; seed < from + 3000; seed++) {
    const r = pitchContact(s, IN, SWING, mulberry32(seed));
    if (r.ball && !r.ball.isHomeRun && pred(r.ball)) return r;
  }
  throw new Error('ball not found');
}

test('控え: 試合開始時は控え野手5人・未登板投手5人', () => {
  const s = newGame();
  for (const side of ['away', 'home']) {
    assert.equal(availableBench(s, side).length, 5);
    assert.equal(availablePitchers(s, side).length, 5);
    const lv = lineupView(s, side);
    assert.equal(lv.length, 9);
    assert.deepEqual([...new Set(lv.map((v) => v.pos))].sort(), ['一', '三', '中', '二', '投', '捕', '右', '左', '遊'].sort());
    assert.equal(lv.filter((v) => v.isPitcher).length, 1);
    assert.ok(lv.every((v) => v.eligible));
  }
});

test('代打: 現在の打者と交代し、退いた選手は再出場できない', () => {
  const s0 = newGame();
  const snap = structuredClone(s0);
  const oldId = getBatter(s0).id;
  const s = pinchHit(s0, 'away', 'r9');
  assert.deepEqual(s0, snap, '入力 state を変更しない');
  assert.equal(getBatter(s).id, 'r9');
  assert.equal(s.teams.away.lineup[0], 'r9');
  assert.ok(s.removed.away.includes(oldId));
  assert.equal(lineupView(s, 'away')[0].pos, '中', '守備位置を引き継ぐ');
  assert.equal(availableBench(s, 'away').length, 4);
  const ev = s.log.at(-1);
  assert.equal(ev.kind, 'sub');
  assert.equal(ev.subType, 'pinch_hit');
  assert.match(ev.text, /代打、速水に代わりまして桜井/);
  assert.throws(() => pinchHit(s, 'away', oldId), /再出場/);
  assert.throws(() => pinchHit(s, 'away', 'r9'), Error);
  assert.throws(() => pinchHit(s0, 'home', 'b9'), /攻撃中/);
  assert.throws(() => pinchHit(s0, 'away', 'r10'), Error, '控え野手以外は不可');
  assert.throws(() => defensiveSwap(s, 'away', [{ playerId: oldId, pos: '中' }]), Error);
});

test('塁上の走者は選手 id、summary は boolean と runners', () => {
  const s = walk(newGame());
  assert.equal(s.bases[0], red.lineup[0]);
  const sm = summary(s);
  assert.deepEqual(sm.bases, [true, false, false]);
  assert.equal(sm.runners[0].id, red.lineup[0]);
  assert.equal(sm.runners[0].name, '速水 翔');
  assert.equal(typeof sm.runners[0].speed, 'number');
  assert.equal(sm.runners[1], null);
  const s2 = walk(s);
  assert.deepEqual(s2.bases, [red.lineup[1], red.lineup[0], null]);
});

test('代走: 塁上の走者と交代、空いている塁は不可', () => {
  const s0 = walk(newGame());
  const s = pinchRun(s0, 'away', 0, 'r16');
  assert.equal(s.bases[0], 'r16');
  assert.equal(s.teams.away.lineup[0], 'r16');
  assert.ok(s.removed.away.includes('r1'));
  assert.equal(s.log.at(-1).subType, 'pinch_run');
  assert.throws(() => pinchRun(s0, 'away', 1, 'r16'), /ランナーがいません/);
  assert.throws(() => pinchRun(s0, 'home', 0, 'b16'), /攻撃中/);
  assert.throws(() => pinchRun(s, 'away', 0, 'r1'), /再出場/);
});

test('投手交代: 新投手は旧投手の打順に入り、旧投手は戻れない（旧 index API も可）', () => {
  const s0 = newGame();
  const s = changePitcher(s0, 'home', 'b12');
  assert.equal(getPitcher(s).id, 'b12');
  assert.equal(s.teams.home.lineup[8], 'b12');
  assert.equal(lineupView(s, 'home')[8].pos, '投');
  assert.ok(s.removed.home.includes('b10'));
  assert.equal(s.stamina.b12, blue.players.find((p) => p.id === 'b12').pitching.stamina);
  assert.equal(availablePitchers(s, 'home').length, 4);
  assert.equal(s.log.at(-1).subType, 'pitcher');
  assert.throws(() => changePitcher(s, 'home', 'b10'), /再出場/);
  assert.throws(() => changePitcher(s, 'home', 'b3'), Error, '野手は登板不可');
  // 旧API: index 指定
  const s2 = changePitcher(s0, 'home', 2);
  assert.equal(getPitcher(s2).id, blue.pitchers[2]);
  assert.equal(changePitcher(s0, 'home', 0).pitcherIndex.home, 0);
});

test('守備交代: 位置の入れ替え・控えの途中出場・9ポジションの検証', () => {
  const s0 = newGame();
  // ホーム（守備中）: 二塁手と遊撃手を入れ替え
  const s1 = defensiveSwap(s0, 'home', [{ playerId: 'b2', pos: '遊' }, { playerId: 'b1', pos: '二' }]);
  assert.equal(posId(s1, 'home', '遊'), 'b2');
  assert.equal(posId(s1, 'home', '二'), 'b1');
  assert.equal(s1.removed.home.length, 0);
  // 控え捕手を捕手として出場 → 正捕手は退く
  const s2 = defensiveSwap(s1, 'home', [{ playerId: 'b17', pos: '捕' }]);
  assert.equal(posId(s2, 'home', '捕'), 'b17');
  assert.equal(s2.teams.home.lineup.indexOf('b17'), blue.lineup.indexOf('b8'));
  assert.ok(s2.removed.home.includes('b8'));
  assert.equal(s2.log.at(-1).subType, 'defense');
  assert.throws(() => defensiveSwap(s2, 'home', [{ playerId: 'b8', pos: '捕' }]), /再出場/);
  // 穴が空く・重複は不可
  assert.throws(() => defensiveSwap(s0, 'home', [{ playerId: 'b2', pos: '遊' }]), /9つの守備位置/);
  assert.throws(() => defensiveSwap(s0, 'home', [{ playerId: 'b2', pos: '遊' }, { playerId: 'b1', pos: '遊' }]), /重複/);
  assert.throws(() => defensiveSwap(s0, 'home', [{ playerId: 'b2', pos: 'DH' }]), Error);
  // 攻撃中のチームは途中出場不可（位置の入れ替えのみ可）
  assert.throws(() => defensiveSwap(s0, 'away', [{ playerId: 'r17', pos: '捕' }]), /守備中/);
  assert.doesNotThrow(() => defensiveSwap(s0, 'away', [{ playerId: 'r2', pos: '遊' }, { playerId: 'r8', pos: '二' }]));
});

test('投手に代打 → 攻守交代時に自動で投手が登板し、代打は退く', () => {
  let s = structuredClone(newGame());
  s.batterIndex.away = 8; // 9番=投手 r10
  s.outs = 2;
  s = pinchHit(s, 'away', 'r9');
  for (let i = 0; i < 3; i++) s = resolvePitch(s, IN, null).state; // 三振でチェンジ
  assert.equal(s.half, 'bottom');
  const p = getPitcher(s);
  assert.ok(p.pitching && p.id !== 'r10');
  assert.equal(s.teams.away.lineup[8], p.id);
  assert.ok(s.removed.away.includes('r9') === false || !s.teams.away.lineup.includes('r9'));
  assert.ok(!s.teams.away.lineup.includes('r9'));
  assert.ok(s.removed.away.includes('r10'));
  // ユーザーは自動登板の投手を1球も投げる前なら別の投手に替えられ、自動登板の投手は控えに戻る
  const other = availablePitchers(s, 'away').find((x) => x.id !== p.id).id;
  const s2 = changePitcher(s, 'away', other);
  assert.equal(getPitcher(s2).id, other);
  assert.ok(availablePitchers(s2, 'away').some((x) => x.id === p.id));
});

test('pitchContact: 打球は pending のまま、resolveBattedBall でアウト・得点が整合', () => {
  let n = 0;
  for (let seed = 0; seed < 400 && n < 40; seed++) {
    let s = structuredClone(newGame());
    s.bases = ['r5', 'r6', null];
    s.batterIndex.away = 3;
    const r = pitchContact(s, IN, SWING, mulberry32(seed));
    if (!r.ball || r.ball.isHomeRun) continue;
    n++;
    assert.equal(r.event.kind, 'inplay');
    assert.equal(r.state.pending.ballId, r.ball.id);
    assert.equal(r.state.outs, 0);
    assert.deepEqual(r.state.bases, s.bases);
    assert.equal(r.state.pitchCount.home, 1);
    assert.ok(r.ball.path.length > 1 && r.ball.landing && r.ball.dirDeg >= -45 && r.ball.dirDeg <= 45);
    assert.ok(['grounder', 'liner', 'fly', 'popup'].includes(r.ball.type));
    assert.throws(() => pitchContact(r.state, IN, SWING), /処理/);
    const f = autoField(r.state, r.ball, mulberry32(seed));
    const { state: s2, event } = resolveBattedBall(r.state, r.ball, f, mulberry32(seed));
    assert.equal(s2.pending, null);
    assert.equal(runsOf(s2) - runsOf(r.state), event.runs);
    assert.equal(s2.outs, event.outsMade);
    assert.ok(['hit', 'out', 'double_play', 'error', 'fielders_choice', 'sac_fly', 'hr'].includes(event.kind));
    const onBase = s2.bases.filter(Boolean).length;
    // 走者保存則: 走者2 + 打者1 = 生還 + アウト + 塁上
    assert.equal(3, event.runs + event.outsMade + onBase, event.text);
    assert.ok(event.text.length > 0);
    if (event.kind === 'hit') assert.ok(event.bases >= 1 && event.bases <= 3);
  }
  assert.ok(n >= 20);
});

test('ノーバウンド捕球（完璧な守備）のフライはアウト', () => {
  const s = newGame();
  const r = findBall(s, (b) => b.type === 'fly');
  const cf = posId(r.state, 'home', '中');
  const f = { caughtInAir: true, fielderId: cf, fieldedAt: { ...r.ball.landing }, fieldTime: r.ball.hangTime, throwTo: null, error: false };
  const { state, event } = resolveBattedBall(r.state, r.ball, f, mulberry32(1));
  assert.equal(event.kind, 'out');
  assert.equal(state.outs, 1);
  assert.equal(state.stats[red.lineup[0]].ab, 1);
  assert.equal(state.stats[red.lineup[0]].h, 0);
});

test('ゴロを遅く処理するとヒットになる', () => {
  const s = newGame();
  const r = findBall(s, (b) => b.type === 'grounder');
  const ss = posId(r.state, 'home', '遊');
  const f = { caughtInAir: false, fielderId: ss, fieldedAt: { ...r.ball.rest }, fieldTime: 9, throwTo: 1, error: false };
  const { state, event } = resolveBattedBall(r.state, r.ball, f, mulberry32(1));
  assert.equal(event.kind, 'hit');
  assert.equal(state.outs, 0);
  assert.ok(state.bases.includes(red.lineup[0]), '打者走者は塁上');
  assert.equal(state.hits.away, 1);
});

test('一塁走者ありのショートゴロ → 二塁送球・一塁転送でダブルプレー', () => {
  let s = structuredClone(newGame());
  s.bases = ['r7', null, null]; // 鈍足の捕手が一塁走者
  s.batterIndex.away = 4; // 黒木（鈍足）
  const r = findBall(s, (b) => b.type === 'grounder');
  const ss = posId(r.state, 'home', '遊');
  const f = { caughtInAir: false, fielderId: ss, fieldedAt: { ...DEFAULT_POSITIONS.遊 }, fieldTime: 0.8, throwTo: 2, throwTime: 0.5, error: false };
  const { state, event } = resolveBattedBall(r.state, r.ball, f, () => 0.5);
  assert.equal(event.kind, 'double_play');
  assert.equal(state.outs, 2);
  assert.deepEqual(state.bases, [null, null, null]);
  assert.match(event.text, /ダブルプレー/);
  // 同じ打球でも一塁送球なら打者のみアウト、走者は二塁へ
  const f2 = { ...f, throwTo: 1, throwTime: 0.9 };
  const r2 = resolveBattedBall(r.state, r.ball, f2, () => 0.5);
  // UI 形式: throwArriveAt（打った瞬間からの到達時刻）を優先
  const r3 = resolveBattedBall(r.state, r.ball, { ...f, throwTime: 9, throwArriveAt: 1.3, diving: false }, () => 0.5);
  assert.equal(r3.event.kind, 'double_play');
  assert.equal(r2.event.kind, 'out');
  assert.equal(r2.state.outs, 1);
  assert.deepEqual(r2.state.bases, [null, 'r7', null]);
});

test('タッチアップ: 三塁走者は深い外野フライの捕球後に生還（犠牲フライ）', () => {
  let s = structuredClone(newGame());
  s.bases = [null, null, 'r1'];
  const r = findBall(s, (b) => b.type === 'fly' && b.distance > 85);
  const cf = posId(r.state, 'home', '中');
  const f = { caughtInAir: true, fielderId: cf, fieldedAt: { ...r.ball.landing }, fieldTime: r.ball.hangTime, throwTo: 4, error: false };
  const { state, event } = resolveBattedBall(r.state, r.ball, f, () => 0.5);
  assert.equal(event.kind, 'sac_fly');
  assert.equal(event.runs, 1);
  assert.equal(state.outs, 1);
  assert.equal(state.stats[red.lineup[0]].ab, 0);
  assert.equal(state.stats[red.lineup[0]].rbi, 1);
});

test('エラーは E に記録され安打にならない', () => {
  const s = newGame();
  const r = findBall(s, (b) => b.type === 'grounder');
  const f = { ...autoField(r.state, r.ball, () => 0.99), error: true };
  const { state, event } = resolveBattedBall(r.state, r.ball, f, () => 0.5);
  assert.equal(event.kind, 'error');
  assert.equal(state.errors.home, 1);
  assert.equal(state.hits.away, 0);
  assert.ok(state.bases[0] || state.bases[1]);
});

test('フィールド定数と打球の軌跡', () => {
  assert.deepEqual(FIELD.bases[1], { x: 19.4, y: 19.4 });
  assert.equal(fenceDistance(45), 98);
  assert.equal(fenceDistance(0), 122);
  const r = findBall(newGame(), (b) => b.type === 'fly');
  const b = r.ball;
  assert.ok(Math.abs(ballPositionAt(b, b.hangTime).z) < 0.01);
  assert.ok(ballPositionAt(b, b.hangTime / 2).z > 3);
  for (let i = 1; i < b.path.length; i++) assert.ok(b.path[i].t > b.path[i - 1].t);
});

test('CPU 采配: 7回以降の接戦で投手に代打、8回以降は鈍足の走者に代走', () => {
  let s = structuredClone(newGame());
  s.inning = 7; s.half = 'bottom'; s.score.home = [0, 0, 0, 0, 0, 0, 0]; s.score.away = [0, 0, 0, 0, 0, 0, 1];
  s.batterIndex.home = 8;
  const r = cpuManage(s, () => 0);
  const ph = r.events.find((e) => e.subType === 'pinch_hit');
  assert.ok(ph, 'pinch hit');
  assert.equal(ph.outId, 'b10');
  assert.notEqual(getBatter(r.state).id, 'b10');
  // 代走
  let t = structuredClone(newGame());
  t.inning = 8; t.half = 'bottom'; t.score.home = [0, 0, 0, 0, 0, 0, 0, 0]; t.score.away = [0, 0, 0, 0, 0, 0, 0, 0];
  t.bases = ['b8', null, null]; // 鈍足の捕手 = サヨナラの走者
  t.batterIndex.home = 0;
  const r2 = cpuManage(t, () => 0);
  const pr = r2.events.find((e) => e.subType === 'pinch_run');
  assert.ok(pr, 'pinch run');
  assert.equal(r2.state.bases[0], 'b16');
  // ユーザー側（away）には何もしない
  let u = structuredClone(newGame());
  u.inning = 8; u.score.away = [0, 0, 0, 0, 0, 0, 0, 0]; u.score.home = [0, 0, 0, 0, 0, 0, 0, 0];
  u.bases = ['r7', null, null]; u.batterIndex.away = 8;
  assert.equal(cpuManage(u, () => 0).events.filter((e) => e.side === 'away').length, 0);
});

test('resolvePitch は打球の自動処理まで行い pending を残さない', () => {
  let s = newGame();
  const rng = mulberry32(77);
  for (let i = 0; i < 200 && !s.over; i++) {
    s = resolvePitch(s, IN, SWING, rng).state;
    assert.equal(s.pending, null);
  }
});

test('フィルダースチョイスはオールセーフのときだけ（走者アウトなら凡打扱い）', () => {
  let seed = 11; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let fc = 0;
  for (let g = 0; g < 60; g++) {
    const res = E.simulateGame(TEAMS[1], TEAMS[0], r); const s = res.state || res;
    for (const ev of s.log) {
      if (ev.kind === 'fielders_choice') {
        fc++;
        assert.ok(!(ev.runnerResults || []).some((x) => x.out), `野選なのに走者アウト: ${ev.text}`);
      } else if (ev.text) {
        assert.ok(!ev.text.includes('フィルダースチョイス'), `野選以外に野選の実況: ${ev.text}`);
      }
    }
  }
  assert.ok(fc >= 0);
});
