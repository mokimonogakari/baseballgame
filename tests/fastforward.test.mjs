/** 守備オートの早送り（js/fastforward.js の DOM なし中核）のテスト */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../js/data.js';
import * as engine from '../js/engine.js';
import { stepPitch, simulateHalf, runHalf, isUserDefending, battingSide, logLines, resultLabel, pitchLine } from '../js/fastforward.js';

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

/** resolveBattedBall の呼び出しを打球 id ごとに数える engine */
function countingEngine() {
  const calls = new Map();
  const eng = {
    ...engine,
    resolveBattedBall(s, ball, f, rng) {
      const r = engine.resolveBattedBall(s, ball, f, rng);
      calls.set(ball.id, (calls.get(ball.id) || 0) + 1);
      return r;
    },
  };
  return { eng, calls };
}

/** game.js と同じ形の試合（ユーザー = away、継投はエンジンの CPU 采配） */
function newGame(i, innings = 9) {
  const user = TEAMS[i % TEAMS.length];
  const cpu = TEAMS[(i + 1 + (i >> 2)) % TEAMS.length] === user ? TEAMS[(i + 2) % TEAMS.length] : TEAMS[(i + 1 + (i >> 2)) % TEAMS.length];
  const s = engine.createGame(cpu, user, { innings, userSide: 'away', seed: 1000 + i });
  return { ...s, autoUserPitcher: true };
}

/** ユーザーの攻撃の半イニングを CPU 同士で進める（simulateGame と同じ手順） */
function cpuHalf(s, rng) {
  const side = battingSide(engine, s);
  let g = 0;
  while (!s.over && battingSide(engine, s) === side && g++ < 500) {
    const pitch = engine.choosePitch(s, rng);
    if (!pitch.intentional) pitch.loc = engine.pitchLocation(s, pitch, rng);
    const swing = pitch.intentional ? null : engine.chooseSwing(s, pitch, rng);
    s = engine.resolvePitch(s, pitch, swing, rng).state;
  }
  return s;
}

const total = (s, side) => (s.score[side] || []).reduce((a, b) => a + (Number(b) || 0), 0);
const HIT_KINDS = ['hit', 'hr'];

/** 1 試合: ユーザーの守備の半イニングは runHalf（早送り）で。各半イニングの整合性を確かめる */
function playGame(i, { innings = 9, check = true } = {}) {
  const rng = mulberry32(7000 + i);
  const { eng, calls } = countingEngine();
  let s = newGame(i, innings);
  let halves = 0;
  let ffSteps = 0;
  const trace = [];
  for (let g = 0; g < 60 && !s.over; g++) {
    if (!isUserDefending(eng, s, 'away')) { s = cpuHalf(s, rng); continue; }
    const before = s;
    const side = battingSide(eng, s);
    const res = runHalf(eng, s, rng);
    halves++;
    ffSteps += res.steps.length;
    if (check) {
      assert.ok(['halfEnd', 'gameOver'].includes(res.reason), `reason ${res.reason}`);
      assert.ok(res.steps.length > 0);
      let runs = 0; let hits = 0;
      for (const st of res.steps) {
        assert.equal(st.state.pending, null, '早送りの state に打球処理待ちが残らない');
        assert.equal(engine.summary(st.state).pending, false);
        if (st.ball && !st.ball.isHomeRun) assert.equal(st.resolves, 1, '打球はちょうど 1 回 resolve');
        else assert.equal(st.resolves, 0);
        runs += Number(st.event.runs) || 0;
        if (HIT_KINDS.includes(st.event.kind)) hits++;
        trace.push(`${st.event.kind}:${st.event.runs || 0}`);
      }
      const last = res.steps[res.steps.length - 1];
      assert.ok(last.endHalf, '最後の 1 球で半イニングが終わる');
      res.steps.slice(0, -1).forEach((st) => assert.ok(!st.endHalf, '途中で半イニングが終わらない'));
      // スコア・安打は summary と一致
      assert.equal(total(res.state, side) - total(before, side), runs, '得点 = event.runs の合計');
      assert.equal(engine.summary(res.state).score[side] - engine.summary(before).score[side], runs);
      assert.equal(res.state.hits[side] - before.hits[side], hits, '安打 = hit/hr の数');
      if (res.reason === 'halfEnd') {
        assert.notEqual(battingSide(eng, res.state), side, '攻守交代');
        assert.equal(res.state.outs, 0);
        assert.ok(/スリーアウト/.test(last.event.text) || last.event.endHalf, '3 アウトでチェンジ');
      } else {
        assert.ok(engine.isGameOver(res.state));
      }
    }
    s = res.state;
  }
  if (check) {
    for (const [id, n] of calls) assert.equal(n, 1, `打球 ${id} の resolveBattedBall は 1 回（${n} 回）`);
    // 打者成績の合計 = チーム安打
    for (const side of ['away', 'home']) {
      const ids = s.teams[side].players.map((p) => p.id);
      const h = ids.reduce((a, id) => a + (s.stats[id]?.h || 0), 0);
      assert.equal(h, s.hits[side], `${side} 安打の合計`);
    }
  }
  return { s, halves, ffSteps, trace };
}

test('早送り: 多数の試合でユーザーの守備の半イニングを最後まで（3 アウト / 試合終了で止まる、resolve は 1 回、得点・安打が summary と一致）', () => {
  let halves = 0; let steps = 0; let over = 0;
  for (let i = 0; i < 48; i++) {
    const r = playGame(i, { innings: [3, 6, 9][i % 3] });
    assert.ok(r.s.over, `試合 ${i} が終わる`);
    halves += r.halves;
    steps += r.ffSteps;
    over++;
  }
  assert.equal(over, 48);
  assert.ok(halves >= 48 * 2, `半イニング ${halves}`);
  assert.ok(steps / halves > 8 && steps / halves < 40, `1 半イニングあたりの球数 ${(steps / halves).toFixed(1)}`);
});

test('早送り: シード付き rng で決定的', () => {
  const a = playGame(3, { check: false });
  const b = playGame(3, { check: false });
  assert.deepEqual(a.trace, b.trace);
  assert.deepEqual(a.s.score, b.s.score);
  assert.equal(a.s.log.length, b.s.log.length);
  assert.deepEqual(a.s.log.map((e) => e.text), b.s.log.map((e) => e.text));
});

test('早送り: サヨナラ（後攻 = CPU の攻撃で試合終了）でも止まる', () => {
  let walkOffs = 0;
  for (let i = 0; i < 400 && walkOffs < 3; i++) {
    const rng = mulberry32(90000 + i);
    let s = newGame(i, 3);
    for (let g = 0; g < 40 && !s.over; g++) {
      if (!isUserDefending(engine, s, 'away')) { s = cpuHalf(s, rng); continue; }
      const res = runHalf(engine, s, rng);
      if (res.reason === 'gameOver') {
        // 試合終了: サヨナラ（後攻が勝ち越した瞬間）か、最終回裏 3 アウト（先攻の勝ち・引き分け）
        assert.ok(res.steps[res.steps.length - 1].over);
        assert.equal(isUserDefending(engine, res.state, 'away'), false);
        if (total(res.state, 'home') > total(res.state, 'away')) {
          walkOffs++;
          assert.ok(res.state.outs < 3 && /サヨナラ/.test(res.steps[res.steps.length - 1].event.text), 'サヨナラで止まる');
        }
      }
      s = res.state;
    }
  }
  assert.ok(walkOffs >= 1, 'サヨナラの例が見つかる');
});

test('早送り: shouldStop（ふつうに見る）で投球の区切りに止まり、続きは通常の進行で進められる', () => {
  const rng = mulberry32(42);
  let s = newGame(5, 9);
  s = cpuHalf(s, rng); // 1回表（ユーザーの攻撃）
  assert.ok(isUserDefending(engine, s, 'away'));
  let n = 0;
  const res = runHalf(engine, s, rng, { shouldStop: () => ++n >= 3 });
  assert.equal(res.reason, 'stopped');
  assert.equal(res.steps.length, 3);
  assert.equal(res.state.pending, null);
  assert.ok(isUserDefending(engine, res.state, 'away'), 'まだ同じ半イニング');
  // 途中から再開（ゲーム画面の通常進行の代わりに、もう一度早送り）
  const rest = runHalf(engine, res.state, rng);
  assert.ok(['halfEnd', 'gameOver'].includes(rest.reason));
});

test('早送り: manage（投球前の采配フック）は毎球呼ばれ、返した state で投げる', () => {
  const rng = mulberry32(9);
  let s = cpuHalf(newGame(2, 9), rng);
  let calls = 0;
  const manage = (st) => { calls++; return calls === 1 ? { ...st, ffTouched: true } : null; };
  const gen = simulateHalf(engine, s, rng, { manage });
  const first = gen.next().value;
  assert.equal(calls, 1);
  assert.equal(first.state.ffTouched, true, 'manage が返した state から進む');
  for (const st of gen) { assert.ok(st); }
  assert.ok(calls > 3);
});

test('早送り: stepPitch は打球処理待ちの state を受け付けない・攻撃中のユーザーには isUserDefending=false', () => {
  const rng = mulberry32(1);
  const s0 = newGame(0, 9);
  assert.equal(isUserDefending(engine, s0, 'away'), false); // 1回表 = ユーザーの攻撃
  assert.throws(() => stepPitch(engine, { ...s0, pending: { ballId: 'x' } }, rng));
});

test('早送り: 表示用ヘルパー（結果ラベル・ログ行・球の説明）', () => {
  assert.equal(resultLabel({ kind: 'hit', bases: 2 }).text, 'ツーベース');
  assert.equal(resultLabel({ kind: 'strike' }), null);
  assert.match(pitchLine({ kind: 'ball', pitch: { type: 'curve', kmh: 118 } }), /カーブ 118km\/h　ボール/);
  const lines = logLines({ event: { kind: 'out', text: 'サードゴロ', runs: 0 }, subs: [{ kind: 'sub', text: 'ピッチャー交代' }], steals: [{ kind: 'steal', text: '盗塁成功！' }] });
  assert.deepEqual(lines.map((l) => l.cls), ['hit', 'out', 'sub']);
  assert.equal(logLines({ event: { kind: 'ball', text: 'ボール', runs: 0 }, subs: [], steals: [] }).length, 0);
});
