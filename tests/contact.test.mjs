/** 当たりの質（contactTier）とタイミング（早い/遅い）が打球の形に効くことのテスト（node --test tests/） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../js/data.js';
import { createGame, getBatter, getPitcher, pitchContact, meetCursor, foulDirection } from '../js/engine.js';

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
const s0 = createGame(blue, red);
const IN = { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0 } };
const batter = getBatter(s0);
const cur = meetCursor(batter, 'meet', s0);
/** 打者から見た引っ張り方向の符号（engine の pullSign と同じ） */
const pull = batter.bats === '左' ? 1 : batter.bats === '右' ? -1 : (getPitcher(s0).throws === '左' ? -1 : 1);

/** カーソル位置（ボールとのずれ）とタイミングを固定して打球を集める */
function collect(offset, timing, n, seed) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = pitchContact(s0, IN, { mode: 'meet', pos: { x: offset.x, y: offset.y }, timing, zone: { x: 1, y: 1 } }, rng);
    if (r.ball && !r.ball.isHomeRun) out.push({ ball: r.ball, event: r.event });
  }
  return out;
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

test('contactTier: 真芯 > 芯 > 芯以外 の順に同じ結果の中で打球が強い', () => {
  // 横ずれだけ（上下のずれはゴロ/フライ比を変えるので 0）
  const tiers = {
    shin2: collect({ x: cur.coreR * 0.2, y: 0 }, 0, 3000, 1),
    shin: collect({ x: cur.coreR * 0.8, y: 0 }, 0, 3000, 2),
    other: collect({ x: Math.min(cur.rx * 0.9, cur.coreR * 1.6), y: 0 }, 0, 3000, 3),
  };
  const stat = {};
  for (const [k, xs] of Object.entries(tiers)) {
    assert.ok(xs.every((x) => x.event.contactTier === k && x.ball.contactTier === k), `${k} の event/ball.contactTier`);
    const go = xs.filter((x) => x.ball.intendedOutcome === 'groundout' && x.ball.type === 'grounder' && !x.event.jammed);
    const fo = xs.filter((x) => x.ball.intendedOutcome === 'flyout' && x.ball.type === 'fly' && !x.event.jammed);
    const fo2 = xs.filter((x) => x.ball.intendedOutcome === 'flyout' && !x.event.jammed);
    stat[k] = {
      goExit: mean(go.map((x) => x.ball.exitSpeed)),
      foDist: mean(fo.map((x) => x.ball.distance)),
      exit: mean(xs.map((x) => x.ball.exitSpeed)),
      dist: mean(xs.map((x) => x.ball.distance)),
      popShare: fo2.filter((x) => x.ball.type === 'popup').length / Math.max(1, fo2.length),
    };
  }
  for (const key of ['goExit', 'foDist', 'exit', 'dist']) {
    assert.ok(stat.shin2[key] > stat.shin[key] && stat.shin[key] > stat.other[key], `${key}: ${JSON.stringify(stat)}`);
  }
  assert.ok(stat.other.popShare > stat.shin2.popShare, `芯以外はフライアウトの中で内野フライが多い ${JSON.stringify(stat)}`);
});

test('timing: 早い → 引っ張り・ゴロ寄り、遅い → 流し・弱い', () => {
  const off = { x: cur.coreR * 0.8, y: 0 };
  const early = collect(off, -0.5, 3000, 11);
  const late = collect(off, 0.5, 3000, 12);
  const pullDeg = (xs) => mean(xs.map((x) => x.ball.dirDeg * pull));
  assert.ok(pullDeg(early) > 5, `早いと引っ張り方向 ${pullDeg(early)}`);
  assert.ok(pullDeg(late) < -3, `遅いと逆方向 ${pullDeg(late)}`);
  const gb = (xs) => xs.filter((x) => x.ball.type === 'grounder').length / xs.length;
  const goShare = (xs) => {
    const go = xs.filter((x) => x.ball.intendedOutcome === 'groundout');
    return go.filter((x) => x.ball.type === 'grounder').length / Math.max(1, go.length);
  };
  assert.ok(goShare(early) > goShare(late), `早いとゴロアウトの中のゴロが多い ${goShare(early)} / ${goShare(late)}`);
  assert.ok(gb(early) >= gb(late) - 0.02, `早いとゴロ率が下がらない ${gb(early)} / ${gb(late)}`);
  const sameOut = (xs, o) => xs.filter((x) => x.ball.intendedOutcome === o && !x.event.jammed);
  assert.ok(mean(sameOut(late, 'groundout').map((x) => x.ball.exitSpeed)) < mean(sameOut(early, 'groundout').map((x) => x.ball.exitSpeed)),
    '遅いとゴロが弱い');
  const pop = (xs) => { const f = sameOut(xs, 'flyout'); return f.filter((x) => x.ball.type === 'popup').length / Math.max(1, f.length); };
  assert.ok(pop(late) > pop(early), `遅いと内野フライが多い ${pop(late)} / ${pop(early)}`);
  assert.ok(early.every((x) => x.event.timing === -0.5) && late.every((x) => x.ball.timing === 0.5), 'event.timing / ball.timing');
});

test('ファウル: event.timing と event.foulDir（タイミングの向き）', () => {
  const dirs = {};
  for (const timing of [-0.5, 0, 0.5, 0.9]) {
    const rng = mulberry32(100 + Math.round(timing * 10));
    let fouls = 0;
    for (let i = 0; i < 2000 && fouls < 30; i++) {
      const r = pitchContact(s0, IN, { mode: 'meet', pos: { x: cur.coreR * 0.5, y: 0 }, timing, zone: { x: 1, y: 1 } }, rng);
      if (r.event.kind !== 'foul') continue;
      fouls += 1;
      assert.equal(r.event.timing, timing);
      assert.ok(['pull', 'oppo', 'back', 'tip'].includes(r.event.foulDir), r.event.foulDir);
      assert.ok(['left', 'right', 'back'].includes(r.event.foulSide), r.event.foulSide);
      dirs[timing] ||= new Set();
      dirs[timing].add(r.event.foulDir);
      // 最後のログにも残る（UI のリプレイ用）
      assert.equal(r.state.log.at(-1).foulDir, r.event.foulDir);
    }
    assert.ok(fouls > 0, `timing ${timing} でファウルが出る`);
  }
  assert.deepEqual([...dirs[-0.5]], ['pull']);
  assert.deepEqual([...dirs[0]], ['back']);
  assert.deepEqual([...dirs[0.5]], ['oppo']);
  assert.deepEqual([...dirs[0.9]], ['tip']);
  // 引っ張り側の左右は打者の打席で決まる
  const side = pull > 0 ? 'right' : 'left';
  const rng = mulberry32(7);
  for (let i = 0; i < 2000; i++) {
    const r = pitchContact(s0, IN, { mode: 'meet', pos: { x: 0, y: 0 }, timing: -0.5, zone: { x: 1, y: 1 } }, rng);
    if (r.event.kind === 'foul') { assert.equal(r.event.foulSide, side); break; }
  }
});

test('foulDirection: 境界値', () => {
  assert.equal(foulDirection(-1), 'pull');
  assert.equal(foulDirection(-0.15), 'pull');
  assert.equal(foulDirection(-0.1), 'back');
  assert.equal(foulDirection(0.1), 'back');
  assert.equal(foulDirection(0.15), 'oppo');
  assert.equal(foulDirection(0.8), 'oppo');
  assert.equal(foulDirection(0.81), 'tip');
  assert.equal(foulDirection(0.2, true), 'back');
  assert.equal(foulDirection(0.6, true), 'tip');
});
