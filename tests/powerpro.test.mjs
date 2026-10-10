/** パワプロ系システム（特殊能力・調子・ミートカーソル・バント・盗塁・球種・コスト）のテスト（node --test tests/） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS, PITCH_TYPES, SKILLS as DATA_SKILLS } from '../js/data.js';
import {
  createGame, resolvePitch, pitchContact, swingProbabilities, meetCursor, pitchLocation, pitchBreak, pitchDirection,
  attemptSteal, cancelSteal, cpuSteal, stealChance, playerCost, SKILLS, CONDITIONS, CONDITION_LABELS, PITCH_DIRECTIONS,
  SKILL_FX, simulateGame, boxScore, isGameOver, getBatter, getPitcher, activeSkills, conditionOf, summary,
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
/** 全員「普通」の試合（away=レッド・ユーザー、home=ブルー） */
const allNormal = (teams) => Object.fromEntries(teams.flatMap((t) => t.players.map((p) => [p.id, '普通'])));
const normalGame = (home = blue, away = red, extra = {}) => createGame(home, away, { conditions: allNormal([home, away]), ...extra });
const IN = { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0 } };
const OUT = { type: 'fastball', zone: { x: 2, y: 1 }, loc: { x: 1.7, y: 0 } }; // 捕りやすいボール球
/** チームを複製して選手を書き換える */
function patched(team, id, patch) {
  const t = structuredClone(team);
  Object.assign(t.players.find((p) => p.id === id), patch);
  return t;
}

test('SKILLS: 契約の特殊能力がそろい、全選手が1〜4個の有効な特殊能力を持つ', () => {
  assert.equal(SKILLS, DATA_SKILLS);
  const required = {
    blue: ['チャンス◎', '対左投手◎', '盗塁◎', '走塁◎', '送球◎', 'パワーヒッター', 'アベレージヒッター', '広角打法', '流し打ち', '初球○', '粘り打ち', 'バント◎',
      'ノビ◎', 'キレ◎', '奪三振', '対ピンチ◎', '重い球', 'クイック◎', '牽制◎', '打たれ強さ◎', '低め◎'],
    red: ['チャンス×', '三振', '併殺', 'エラー', '一発', '四球', 'スロースターター'],
    gold: ['天才打者', '怪力', '怪物球威'],
  };
  for (const [type, names] of Object.entries(required)) {
    for (const n of names) {
      assert.ok(SKILLS[n], n);
      assert.equal(SKILLS[n].type, type, n);
      assert.ok(['batter', 'pitcher', 'any'].includes(SKILLS[n].target));
      assert.ok(SKILLS[n].desc.length > 0);
    }
  }
  for (const n of Object.keys(SKILL_FX)) assert.ok(SKILLS[n], `SKILL_FX ${n}`);
  for (const t of TEAMS) {
    for (const p of t.players) {
      assert.ok(p.skills.length >= 1 && p.skills.length <= 4, `${p.name} skills`);
      assert.equal(new Set(p.skills).size, p.skills.length);
      for (const n of p.skills) {
        assert.ok(SKILLS[n], `${p.name}: ${n}`);
        const kind = p.pitching ? 'pitcher' : 'batter';
        assert.ok(SKILLS[n].target === 'any' || SKILLS[n].target === kind, `${p.name}: ${n} target`);
      }
    }
  }
});

test('特殊能力: ノビ◎ はストレートの空振り率を上げ、変化球には効かない', () => {
  const b10 = blue.players.find((p) => p.id === 'b10');
  const batter = red.players.find((p) => p.id === 'r6');
  const nobi = { ...b10, skills: ['ノビ◎'] };
  const none = { ...b10, skills: [] };
  const pf = (p, type) => swingProbabilities(batter, p, type, 'meet', 0, 0, true)[1];
  assert.ok(pf(nobi, 'fastball') > pf(none, 'fastball') * 1.15);
  assert.equal(pf(nobi, 'slider'), pf(none, 'slider'));
  // 制御したシミュレーション: ど真ん中のストレートにミートで振る 1500 球
  const whiff = (skills) => {
    const home = patched(blue, 'b10', { skills });
    const s = normalGame(home);
    let k = 0;
    for (let seed = 0; seed < 1500; seed++) {
      const r = pitchContact(s, IN, { mode: 'meet', pos: { x: 0, y: 0 }, timing: 0.4 }, mulberry32(seed));
      if (r.event.kind === 'strike') k++;
    }
    return k / 1500;
  };
  const withNobi = whiff(['ノビ◎']);
  const without = whiff([]);
  assert.ok(withNobi > without + 0.01, `${withNobi} > ${without}`);
});

test('特殊能力: キレ◎・怪力・重い球・チャンス◎（状況依存）', () => {
  const p0 = { ...blue.players.find((p) => p.id === 'b10'), skills: [] };
  const b0 = { ...red.players.find((p) => p.id === 'r6'), skills: [] };
  const P = (b, p, type = 'fastball', ctx = {}) => swingProbabilities(b, p, type, 'meet', 0, 0, true, 0, ctx);
  assert.ok(P(b0, { ...p0, skills: ['キレ◎'] }, 'slider')[1] > P(b0, p0, 'slider')[1]);
  assert.ok(P({ ...b0, skills: ['怪力'] }, p0)[8] > P(b0, p0)[8] * 1.4);
  assert.ok(P(b0, { ...p0, skills: ['重い球'] })[8] < P(b0, p0)[8]);
  const s = normalGame();
  const risp = { ...structuredClone(s), bases: [null, 'r1', null] };
  const clutch = { ...b0, skills: ['チャンス◎'] };
  const hits = (pr) => pr[5] + pr[6] + pr[7] + pr[8];
  assert.ok(hits(P(clutch, p0, 'fastball', { state: risp })) > hits(P(clutch, p0, 'fastball', { state: s })));
  assert.equal(hits(P(clutch, p0, 'fastball', { state: s })), hits(P(b0, p0, 'fastball', { state: s })));
});

test('調子: 割り当て・上書き・倍率（打者のミート/パワー、投手の制球）', () => {
  assert.deepEqual(CONDITION_LABELS, ['絶好調', '好調', '普通', '不調', '絶不調']);
  assert.deepEqual(CONDITION_LABELS.map((k) => CONDITIONS[k].mult), [1.10, 1.05, 1, 0.95, 0.90]);
  assert.deepEqual(CONDITION_LABELS.map((k) => CONDITIONS[k].arrow), ['↑', '↗', '→', '↘', '↓']);
  for (const k of CONDITION_LABELS) assert.match(CONDITIONS[k].color, /^#[0-9A-F]{6}$/i);
  // 既定は決定的、rng 指定で変わる、全員に割り当て
  const a = createGame(blue, red);
  const b = createGame(blue, red);
  assert.deepEqual(a.condition, b.condition);
  for (const t of [red, blue]) for (const p of t.players) assert.ok(CONDITIONS[a.condition[p.id]]);
  // 重み 10/25/35/20/10 に近い分布
  const cnt = Object.fromEntries(CONDITION_LABELS.map((k) => [k, 0]));
  const rng = mulberry32(3);
  for (let i = 0; i < 150; i++) for (const v of Object.values(createGame(blue, red, { rng }).condition)) cnt[v]++;
  const n = 150 * 38;
  assert.ok(Math.abs(cnt.普通 / n - 0.35) < 0.03 && Math.abs(cnt.絶好調 / n - 0.10) < 0.02);
  // 上書き
  const c = createGame(blue, red, { conditions: { r4: '絶好調', b10: '絶不調' } });
  assert.equal(conditionOf(c, 'r4'), '絶好調');
  assert.equal(conditionOf(c, 'b10'), '絶不調');
  // 打者: 絶好調の方がヒット確率が高い、カーソルも大きい
  const r4 = red.players.find((p) => p.id === 'r4');
  const b10 = blue.players.find((p) => p.id === 'b10');
  const sGood = createGame(blue, red, { conditions: { ...allNormal([red, blue]), r4: '絶好調' } });
  const sBad = createGame(blue, red, { conditions: { ...allNormal([red, blue]), r4: '絶不調' } });
  const hits = (st) => swingProbabilities(r4, b10, 'fastball', 'meet', 0, 0, true, 0, { state: st }).slice(5).reduce((x, y) => x + y);
  assert.ok(hits(sGood) > hits(sBad));
  assert.ok(meetCursor(r4, 'meet', sGood).rx > meetCursor(r4, 'meet', sBad).rx);
  // 投手: 絶好調の方が制球のばらつきが小さい
  const spread = (cond) => {
    const st = createGame(blue, red, { conditions: { ...allNormal([red, blue]), b10: cond } });
    const r = mulberry32(9);
    let v = 0;
    for (let i = 0; i < 3000; i++) { const l = pitchLocation(st, { type: 'fastball', zone: { x: 1, y: 1 } }, r); v += l.x * l.x + l.y * l.y; }
    return v / 3000;
  };
  assert.ok(spread('絶好調') < spread('絶不調'));
});

test('調子と特殊能力: 絶好調で赤特（三振など）が消え、絶不調で青特（ノビ◎など）が無効', () => {
  const r5 = red.players.find((p) => p.id === 'r5'); // パワーヒッター, 三振
  const b10 = blue.players.find((p) => p.id === 'b10'); // キレ◎, ノビ◎
  const st = (conds) => createGame(blue, red, { conditions: { ...allNormal([red, blue]), ...conds } });
  assert.deepEqual(activeSkills(st({}), r5), ['パワーヒッター', '三振']);
  assert.deepEqual(activeSkills(st({ r5: '絶好調' }), r5), ['パワーヒッター']);
  assert.deepEqual(activeSkills(st({ b10: '絶不調' }), b10), []);
  const r16 = red.players.find((p) => p.id === 'r16');
  assert.deepEqual(activeSkills(st({ r16: '絶不調' }), r16), ['盗塁◎', '走塁◎'], '走塁系は絶不調でも有効');
  const r6 = { ...red.players.find((p) => p.id === 'r6'), skills: [] };
  const k = (s) => swingProbabilities(r6, b10, 'fastball', 'meet', 0, 0, true, 0, { state: s, pitcherCond: 1 })[1];
  assert.ok(k(st({ b10: '絶不調' })) < k(st({})), '絶不調ではノビ◎が効かない');
});

test('meetCursor: ミートで大きさが決まり、強振 0.7倍・バント 1.1倍、ry = rx×0.75', () => {
  const b = (contact) => ({ id: 'x', contact, power: 50, skills: [] });
  assert.equal(meetCursor(b(1)).rx, 0.35);
  assert.equal(meetCursor(b(99)).rx, 0.85);
  const m = meetCursor(b(60));
  assert.ok(m.rx > 0.35 && m.rx < 0.85);
  assert.ok(Math.abs(m.ry - m.rx * 0.75) < 0.002);
  assert.ok(m.coreR > 0 && m.coreR < m.ry);
  assert.ok(Math.abs(meetCursor(b(60), 'power').rx - m.rx * 0.7) < 0.002);
  assert.ok(Math.abs(meetCursor(b(60), 'bunt').rx - m.rx * 1.1) < 0.002);
  assert.ok(meetCursor({ ...b(60), skills: ['天才打者'] }).rx > m.rx);
});

test('ミートカーソル入力: 外れれば空振り、芯で contactTier、上下でフライ/ゴロ', () => {
  const s = normalGame();
  // カーソルから大きく外れたらすべて空振り
  for (let seed = 0; seed < 200; seed++) {
    const r = pitchContact(s, IN, { mode: 'meet', pos: { x: 1.8, y: -1.8 }, timing: 0 }, mulberry32(seed));
    assert.equal(r.event.kind, 'strike');
  }
  const c = pitchContact(s, IN, { mode: 'meet', pos: { x: 0, y: 0 }, timing: 0 }, mulberry32(1));
  assert.equal(c.event.contactTier, 'shin2');
  assert.ok(c.event.cursor && c.event.cursor.rx > 0);
  assert.equal(pitchContact(s, IN, { mode: 'meet', zone: { x: 1, y: 1 }, timing: 0 }, mulberry32(1)).event.contactTier, 'shin');
  // ボールがカーソル中心より上（y が小さい）→ フライが増え、下 → ゴロが増える
  const types = (dy) => {
    let gr = 0; let fl = 0;
    for (let seed = 0; seed < 1500; seed++) {
      const r = pitchContact(s, IN, { mode: 'meet', pos: { x: 0, y: dy }, timing: 0 }, mulberry32(seed));
      if (!r.ball || r.ball.isHomeRun) continue;
      if (r.ball.type === 'grounder') gr++; else fl++;
    }
    return gr / (gr + fl);
  };
  const ballAbove = types(0.35); // カーソルがボールより下 → ボールはカーソル中心の上
  const ballBelow = types(-0.35);
  assert.ok(ballAbove < ballBelow - 0.08, `ground rate above=${ballAbove} below=${ballBelow}`);
});

test('バント: 送りバント成功は sac_bunt（打数なし・犠打）、2ストライク後のファウルは三振', () => {
  let s0 = normalGame();
  s0 = { ...structuredClone(s0), bases: ['r1', null, null] };
  let found = null;
  for (let seed = 0; seed < 400 && !found; seed++) {
    const r = resolvePitch(s0, IN, { mode: 'bunt', pos: { x: 0, y: 0 }, timing: 0 }, mulberry32(seed));
    if (r.event.kind === 'sac_bunt') found = r;
  }
  assert.ok(found, 'sac_bunt が出る');
  const { state, event } = found;
  const bid = getBatter(s0).id;
  assert.equal(state.stats[bid].ab, 0);
  assert.equal(state.stats[bid].sh, 1);
  assert.equal(state.outs, 1);
  assert.equal(state.bases[1], 'r1');
  assert.ok(event.ball.bunt && event.ball.type === 'grounder');
  assert.ok(Math.abs(event.ball.dirDeg) <= 30 && event.ball.exitSpeed <= 60);
  assert.match(event.text, /送りバント成功/);
  // バントの打球は本塁付近
  let n = 0;
  for (let seed = 0; seed < 300; seed++) {
    const r = pitchContact(s0, IN, { mode: 'bunt', pos: { x: 0, y: 0 }, timing: 0 }, mulberry32(seed));
    if (r.ball && r.ball.type === 'grounder') { n++; assert.ok(r.ball.distance < 25, `${r.ball.distance}`); }
  }
  assert.ok(n > 100, 'バントは前に転がりやすい');
  // 2ストライク後のバントファウル = 三振
  const s2 = { ...structuredClone(s0), strikes: 2 };
  let k = null;
  for (let seed = 0; seed < 400 && !k; seed++) {
    const r = pitchContact(s2, IN, { mode: 'bunt', pos: { x: 0, y: 0 }, timing: 0.9 }, mulberry32(seed));
    if (r.event.buntFoulOut) k = r;
  }
  assert.ok(k);
  assert.equal(k.event.kind, 'strikeout');
  assert.equal(k.state.outs, 1);
});

test('盗塁: attemptSteal の検証・cancelSteal', () => {
  const s = normalGame();
  assert.throws(() => attemptSteal(s, 'away', 0), /ランナーがいません/);
  const s1 = { ...structuredClone(s), bases: ['r1', 'r2', null] };
  assert.throws(() => attemptSteal(s1, 'away', 0), /空いていません/);
  assert.throws(() => attemptSteal(s1, 'home', 1), /攻撃中/);
  const snap = structuredClone(s1);
  const s2 = attemptSteal(s1, 'away', 1);
  assert.deepEqual(s1, snap, '入力 state を変更しない');
  assert.deepEqual(s2.pendingSteal, { side: 'away', baseIndex: 1, runnerId: 'r2' });
  assert.deepEqual(summary(s2).steal, { side: 'away', baseIndex: 1, runnerId: 'r2' });
  assert.equal(cancelSteal(s2).pendingSteal, null);
  const p = pitchContact({ ...structuredClone(s), bases: ['r1', null, null] }, IN, { mode: 'meet', zone: { x: 1, y: 1 }, timing: 0 }, mulberry32(0));
  if (p.state.pending) assert.throws(() => attemptSteal(p.state, 'away', 0), /打球/);
});

test('盗塁: 俊足 vs 弱肩は成功しやすく、鈍足 vs 強肩は刺されやすい。event.steal とログ', () => {
  const rate = (runnerId, arm) => {
    const home = patched(blue, 'b8', { arm, catching: arm, skills: [] });
    const g = normalGame(home);
    const base = { ...structuredClone(g), bases: [runnerId, null, null] };
    let ok = 0;
    for (let seed = 0; seed < 300; seed++) {
      const st = attemptSteal(base, 'away', 0);
      const r = pitchContact(st, OUT, null, mulberry32(seed));
      assert.ok(r.event.steal && ['steal', 'caught_stealing'].includes(r.event.steal.kind));
      assert.equal(r.steal, r.event.steal);
      if (r.event.steal.kind === 'steal') {
        ok++;
        assert.equal(r.state.bases[1], runnerId);
        assert.equal(r.state.bases[0], null);
        assert.equal(r.state.stats[runnerId].sb, 1);
        assert.match(r.event.steal.text, /盗塁成功/);
      } else {
        assert.equal(r.state.outs, 1);
        assert.equal(r.state.bases[0], null);
        assert.match(r.event.steal.text, /刺した/);
      }
      assert.equal(r.state.log.at(-1).kind, r.event.steal.kind);
      assert.equal(r.state.pendingSteal, null);
    }
    return ok / 300;
  };
  const fastWeak = rate('r16', 30); // 走力95・盗塁◎
  const slowStrong = rate('r7', 95); // 走力34
  assert.ok(fastWeak > 0.85, `fast ${fastWeak}`);
  assert.ok(slowStrong < 0.2, `slow ${slowStrong}`);
  // ファウルなら走者は戻る、打球なら走っている
  const g = normalGame();
  const st = attemptSteal({ ...structuredClone(g), bases: ['r1', null, null] }, 'away', 0);
  let sawFoul = false; let sawRun = false;
  for (let seed = 0; seed < 200 && !(sawFoul && sawRun); seed++) {
    const r = pitchContact(st, IN, { mode: 'meet', pos: { x: 0, y: 0 }, timing: 0 }, mulberry32(seed));
    if (r.event.kind === 'foul') { sawFoul = true; assert.equal(r.state.bases[0], 'r1'); assert.equal(r.event.steal.kind, 'steal_cancelled'); }
    if (r.ball && !r.ball.isHomeRun) { sawRun = true; assert.deepEqual(r.ball.running, ['r1']); }
  }
  assert.ok(sawFoul && sawRun);
  // 盗塁死で3アウト目なら打者はそのまま次の回の先頭
  const s3 = attemptSteal({ ...structuredClone(normalGame(patched(blue, 'b8', { arm: 99, catching: 99 }))), outs: 2, bases: ['r7', null, null] }, 'away', 0);
  for (let seed = 0; seed < 100; seed++) {
    const r = pitchContact(s3, OUT, null, mulberry32(seed));
    if (r.event.steal.kind !== 'caught_stealing') continue;
    assert.equal(r.state.half, 'bottom');
    assert.equal(r.state.batterIndex.away, s3.batterIndex.away, '打者は打順を進めない');
    assert.ok(r.event.endHalf);
    break;
  }
});

test('盗塁: CPU は俊足走者で走る（ユーザー側では走らない）', () => {
  const s = createGame(blue, red, { userSide: 'home', conditions: allNormal([red, blue]) });
  const base = { ...structuredClone(s), bases: ['r16', null, null] };
  assert.ok(stealChance(base, 0) > 0.8);
  let n = 0;
  for (let seed = 0; seed < 200; seed++) if (cpuSteal(base, mulberry32(seed)).attempted) n++;
  assert.ok(n > 10 && n < 200, `${n}`);
  const user = { ...structuredClone(normalGame()), bases: ['r16', null, null] };
  for (let seed = 0; seed < 50; seed++) assert.equal(cpuSteal(user, mulberry32(seed)).attempted, false);
  const slow = { ...structuredClone(s), bases: ['r7', null, null] };
  for (let seed = 0; seed < 50; seed++) assert.equal(cpuSteal(slow, mulberry32(seed)).attempted, false);
});

test('球種: 方向（5方向＋ストレート系）、左投手は反転、変化量 level で変化が大きくなる', () => {
  for (const t of Object.keys(PITCH_TYPES)) assert.ok(PITCH_DIRECTIONS[t], t);
  for (const [t, d] of Object.entries(PITCH_DIRECTIONS)) {
    if (PITCH_TYPES[t].fastballFamily && t === 'fastball') continue;
    assert.ok(['←', '↙', '↓', '↘', '→'].includes(d), `${t} ${d}`);
  }
  assert.equal(pitchDirection('slider', '右'), '←');
  assert.equal(pitchDirection('slider', '左'), '→');
  assert.equal(pitchDirection('curve', '左'), '↘');
  assert.equal(pitchDirection('fork', '左'), '↓');
  const mk = (level, throws = '右') => ({ throws, skills: [], pitching: { pitches: [{ type: 'slider', level }] } });
  assert.ok(pitchBreak(mk(6), 'slider').dx > pitchBreak(mk(2), 'slider').dx);
  assert.ok(Math.abs(pitchBreak(mk(3), 'slider').dx - PITCH_TYPES.slider.dx) < 1e-9);
  assert.ok(pitchBreak(mk(4, '左'), 'slider').dx < 0);
  assert.ok(pitchBreak(mk(0), 'slider').dx > 0);
  assert.equal(pitchBreak({ throws: '右', skills: ['ノビ◎'] }, 'fastball').nobi, true);
  assert.ok(TEAMS.some((t) => t.players.some((p) => p.pitching?.pitches.some((q) => q.type === 'twoseam'))));
});

test('playerCost: 1〜15 の整数、エース・主砲は控えより高い', () => {
  for (const t of TEAMS) {
    for (const p of t.players) {
      const c = playerCost(p);
      assert.ok(Number.isInteger(c) && c >= 1 && c <= 15, `${p.name} ${c}`);
    }
    const sum = t.players.reduce((a, p) => a + playerCost(p), 0);
    assert.ok(sum * 25 / 19 >= 150 && sum * 25 / 19 <= 220, `${t.id} ${sum}`);
  }
  const by = (id) => TEAMS.flatMap((t) => t.players).find((p) => p.id === id);
  assert.ok(playerCost(by('r4')) > playerCost(by('r17')));
  assert.ok(playerCost(by('b10')) > playerCost(by('b15')));
});

test('4チーム: すべての組み合わせで試合が最後まで進む', () => {
  for (const home of TEAMS) {
    for (const away of TEAMS) {
      if (home === away) continue;
      const s = simulateGame(home, away, mulberry32(home.id.length * 31 + away.id.length));
      assert.ok(isGameOver(s));
      const box = boxScore(s);
      assert.equal(box.R[0], s.score.away.reduce((a, b) => a + b, 0));
      assert.ok(getPitcher(s) && getBatter(s));
    }
  }
});
