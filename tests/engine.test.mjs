/** エンジン・データのテスト（node --test tests/） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS, rank, PITCH_TYPES } from '../js/data.js';
import {
  createGame, getBatter, getPitcher, resolvePitch, choosePitch, chooseSwing, pitchLocation,
  isGameOver, boxScore, summary, simulateGame,
} from '../js/engine.js';

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
const [red, blue] = TEAMS;
const newGame = () => createGame(blue, red);
const sumArr = (a) => a.reduce((x, y) => x + y, 0);
/** ど真ん中（ゾーン内確定）とゾーン外確定の投球 */
const IN = { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0 } };
const OUT = { type: 'fastball', zone: { x: 2, y: 2 }, loc: { x: 2.5, y: 2.5 } };
const SWING = { zone: { x: 1, y: 1 }, mode: 'meet', timing: 0 };

test('データ: 4チーム76人、各チーム打順9人・投手6人・控え野手5人、能力値は1-99', () => {
  assert.equal(TEAMS.length, 4);
  assert.deepEqual(TEAMS.map((t) => t.id), ['red', 'blue', 'green', 'yellow']);
  assert.equal(TEAMS.reduce((n, t) => n + t.players.length, 0), 76);
  const ids = new Set();
  for (const t of TEAMS) {
    assert.equal(t.lineup.length, 9);
    assert.equal(t.pitchers.length, 6);
    assert.equal(t.bench.length, 5);
    assert.equal(t.players.length, 19);
    const roles = t.pitchers.map((id) => t.players.find((p) => p.id === id).pitching.role);
    assert.deepEqual(roles, ['starter', 'starter', 'reliever', 'reliever', 'reliever', 'closer']);
    for (const id of [...t.lineup, ...t.pitchers, ...t.bench]) assert.ok(t.players.some((p) => p.id === id), id);
    for (const id of t.pitchers) assert.ok(t.players.find((p) => p.id === id).pitching);
    for (const id of t.bench) {
      assert.ok(!t.lineup.includes(id) && !t.pitchers.includes(id));
      assert.equal(t.players.find((p) => p.id === id).pitching, null);
    }
    const bench = t.bench.map((id) => t.players.find((p) => p.id === id));
    assert.ok(bench.some((p) => p.speed >= 90), '代走要員');
    assert.ok(bench.some((p) => p.positions.includes('捕')), '控え捕手');
    for (const p of t.players) {
      assert.ok(!ids.has(p.id)); ids.add(p.id);
      for (const k of ['contact', 'power', 'speed', 'arm', 'fielding', 'catching']) {
        assert.ok(Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 99, `${p.name} ${k}`);
      }
      assert.ok(p.trajectory >= 1 && p.trajectory <= 4);
      assert.ok(typeof p.model === 'string' && p.model.length > 0);
      assert.ok(Array.isArray(p.positions) && p.positions.length > 0 && p.positions[0] === p.pos, `${p.name} positions`);
      if (p.pitching) {
        assert.ok(p.pitching.control >= 1 && p.pitching.control <= 99);
        assert.ok(p.pitching.stamina >= 1 && p.pitching.stamina <= 99);
        for (const q of p.pitching.pitches) {
          assert.ok(PITCH_TYPES[q.type], q.type);
          assert.ok(Number.isInteger(q.level) && q.level >= 0 && q.level <= 7, `${p.name} ${q.type} level`);
        }
      }
    }
  }
});

test('rank の境界値', () => {
  assert.deepEqual([95, 90, 89, 80, 70, 60, 50, 40, 20, 19].map(rank), ['S', 'S', 'A', 'A', 'B', 'C', 'D', 'E', 'F', 'G']);
});

test('CPU同士のシード付き試合が終了し、得点=ラインスコア合計', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    const s = simulateGame(blue, red, mulberry32(seed));
    assert.ok(isGameOver(s));
    const box = boxScore(s);
    assert.equal(box.R[0], sumArr(box.innings[0]));
    assert.equal(box.R[1], sumArr(box.innings[1]));
    assert.equal(box.R[0], sumArr(s.score.away));
    assert.ok(s.inning >= 9 && s.inning <= 12);
    if (box.R[0] !== box.R[1]) {
      assert.ok(box.pitchers.win && box.pitchers.lose);
      assert.ok(box.mvp);
    }
    for (const e of s.log) assert.ok(typeof e.text === 'string' && e.text.length > 0);
  }
});

test('同じシードなら同じ結果（rng 注入）', () => {
  const a = simulateGame(blue, red, mulberry32(99));
  const b = simulateGame(blue, red, mulberry32(99));
  assert.deepEqual(boxScore(a).innings, boxScore(b).innings);
});

test('入力 state を変更しない', () => {
  const rng = mulberry32(5);
  let s = newGame();
  for (let i = 0; i < 60; i++) {
    const snapshot = structuredClone(s);
    const pitch = choosePitch(s, rng);
    pitch.loc = pitchLocation(s, pitch, rng);
    const swing = chooseSwing(s, pitch, rng);
    const next = resolvePitch(s, pitch, swing, rng).state;
    assert.deepEqual(s, snapshot);
    assert.notEqual(next, s);
    s = next;
  }
});

test('4ボールで四球', () => {
  let s = newGame();
  let ev;
  for (let i = 0; i < 4; i++) ({ state: s, event: ev } = resolvePitch(s, OUT, null, mulberry32(i)));
  assert.equal(ev.kind, 'walk');
  assert.deepEqual(s.bases, [red.lineup[0], null, null]);
  assert.deepEqual(summary(s).bases, [true, false, false]);
  assert.equal(s.balls, 0);
  assert.equal(s.stats[red.lineup[0]].bb, 1);
  assert.equal(getBatter(s).id, red.lineup[1]);
});

test('3ストライクで三振、見送りゾーン内はストライク', () => {
  let s = newGame();
  let ev;
  for (let i = 0; i < 3; i++) ({ state: s, event: ev } = resolvePitch(s, IN, null, mulberry32(i)));
  assert.equal(ev.kind, 'strikeout');
  assert.equal(s.outs, 1);
  assert.equal(s.stats[getPitcher(s).id].k, 1);
});

test('2ストライク後のファウルはカウント維持', () => {
  let s = newGame();
  s = resolvePitch(s, IN, null).state;
  s = resolvePitch(s, IN, null).state;
  assert.equal(s.strikes, 2);
  // ファウルしか出ない rng を探す
  let fouls = 0;
  for (let seed = 0; seed < 300 && fouls < 3; seed++) {
    const r = resolvePitch(s, IN, SWING, mulberry32(seed));
    if (r.event.kind === 'foul') {
      fouls++;
      assert.equal(r.state.strikes, 2);
      assert.equal(r.state.outs, 0);
    }
  }
  assert.ok(fouls > 0);
});

test('ゾーン外を空振り以外で見送ればボール、ゾーン外スイングは ball にならない', () => {
  const s = newGame();
  for (let seed = 0; seed < 100; seed++) {
    assert.notEqual(resolvePitch(s, OUT, SWING, mulberry32(seed)).event.outcome, 'ball');
  }
});

test('3アウトでチェンジ、summary', () => {
  let s = newGame();
  for (let i = 0; i < 9; i++) s = resolvePitch(s, IN, null).state;
  const sm = summary(s);
  assert.equal(sm.inningLabel, '1回裏');
  assert.equal(sm.batting, 'home');
  assert.deepEqual(sm.count, { b: 0, s: 0, o: 0 });
  assert.deepEqual(sm.score, { away: 0, home: 0 });
});

test('9回裏はホームリードなら行わない', () => {
  let s = newGame();
  s = structuredClone(s);
  s.inning = 9; s.half = 'top';
  s.score = { away: [0, 0, 0, 0, 0, 0, 0, 0, 0], home: [1, 0, 0, 0, 0, 0, 0, 0] };
  s.outs = 2; s.strikes = 2;
  s = resolvePitch(s, IN, null).state;
  assert.ok(isGameOver(s));
  assert.equal(s.score.home.length, 8);
});

// 'node --test tests/' は tests/package.json の main（このファイル）だけを実行するため、追加のテストをここから読み込む
import './subs-fielding.test.mjs';
import './powerpro.test.mjs';
