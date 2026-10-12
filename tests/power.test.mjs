/** 球威（pitching.power / effectiveStats().pitchPower / event.pitch.power / event.jammed）のテスト */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS, SKILLS } from '../js/data.js';
import {
  createGame, pitchContact, effectiveStats, swingProbabilities, pitchPowerOf, powerRank, getPitcher, getBatter,
  TUNING, SKILL_FX, CONDITIONS,
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
const allNormal = Object.fromEntries([red, blue].flatMap((t) => t.players.map((p) => [p.id, '普通'])));

/** home（ブルー）の先発の球威と away（レッド）1 番打者のパワーを書き換えた試合（特殊能力なし・全員「普通」） */
function duel(pitchPower, batterPower) {
  const home = structuredClone(blue);
  const away = structuredClone(red);
  const p = home.players.find((x) => x.id === home.pitchers[0]);
  p.pitching = { ...p.pitching, power: pitchPower, velocity: 147, control: 70 };
  p.skills = [];
  const b = away.players.find((x) => x.id === away.lineup[0]);
  Object.assign(b, { contact: 65, power: batterPower, trajectory: 2, skills: [] });
  return createGame(home, away, { conditions: allNormal, seed: 1 });
}

/** ど真ん中のストレートを N 回スイングした集計（各回とも同じ初期 state から） */
function swingMany(pitchPower, batterPower, N = 5000, seed = 99) {
  const st = duel(pitchPower, batterPower);
  const rng = mulberry32(seed);
  const r = { swings: N, bip: 0, hr: 0, xbh: 0, exit: 0, jammed: 0, popup: 0 };
  for (let i = 0; i < N; i++) {
    const timing = (rng() - 0.5) * 0.9;
    const { event, ball } = pitchContact(st, { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0 } },
      { zone: { x: 1, y: 1 }, mode: 'meet', timing }, rng);
    assert.equal(event.pitch.power, pitchPower);
    if (!ball) continue;
    r.bip += 1;
    r.exit += ball.exitSpeed;
    const o = ball.intendedOutcome;
    if (o === 'hr') r.hr += 1;
    if (o === 'hr' || o === 'double' || o === 'triple') r.xbh += 1;
    if (ball.type === 'popup') r.popup += 1;
    if (event.jammed) r.jammed += 1;
  }
  r.exit /= r.bip;
  return r;
}

test('球威: 全投手が pitching.power（1〜99 の整数）を持ち、野手は持たない', () => {
  let n = 0;
  for (const t of TEAMS) {
    for (const p of t.players) {
      if (!p.pitching) continue;
      n += 1;
      assert.ok(Number.isInteger(p.pitching.power) && p.pitching.power >= 1 && p.pitching.power <= 99, `${p.name} power`);
      assert.equal(pitchPowerOf(p), p.pitching.power);
    }
  }
  assert.equal(n, 24);
  // 球速と相関するが別物（同じ球速帯でも差がある）
  const all = TEAMS.flatMap((t) => t.players.filter((p) => p.pitching));
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  assert.ok(byId.b13.pitching.power >= 85, '剛球無双のカットボール守護神は S 級');
  assert.ok(byId.y11.pitching.power < 45 && byId.g14.pitching.power < 45, '軟投派の左腕は低い');
  // 未設定の投手は球速から推定（30〜80）
  assert.equal(pitchPowerOf({ pitching: { velocity: 145 } }), 50);
  assert.equal(pitchPowerOf({ pitching: { velocity: 165 } }), 80);
  assert.equal(pitchPowerOf({ contact: 50 }), null);
  assert.deepEqual([powerRank(95), powerRank(72), powerRank(49.6), powerRank(10)], ['S', 'B', 'D', 'G']);
});

test('球威: 99 と 30 では本塁打・長打・打球速度がはっきり違う（同じ投手・同じ打者・同じスイング）', () => {
  const hi = swingMany(99, 60);
  const lo = swingMany(30, 60);
  const hrRate = (r) => r.hr / r.bip;
  const xbhRate = (r) => r.xbh / r.bip;
  assert.ok(hi.bip > 2000 && lo.bip > 2000);
  assert.ok(hrRate(hi) < hrRate(lo) * 0.7, `HR ${hrRate(hi)} vs ${hrRate(lo)}`);
  assert.ok(xbhRate(hi) < xbhRate(lo) * 0.75, `XBH ${xbhRate(hi)} vs ${xbhRate(lo)}`);
  assert.ok(hi.exit < lo.exit - 5, `exitSpeed ${hi.exit} vs ${lo.exit}`);
  assert.ok(hi.popup / hi.bip > lo.popup / lo.bip, '内野フライ（詰まった打球）が増える');
  // 詰まらせた（event.jammed）は球威の優位があるときだけ
  assert.ok(hi.jammed > hi.bip * 0.1, `jammed ${hi.jammed}`);
  assert.equal(lo.jammed, 0);
});

test('球威: パワー 99 の打者は球威の差を縮める（押し負けない）', () => {
  // 確率（解析）: 本塁打率の比 99/30 がパワー 99 の打者で 1 に近づく
  const st60 = duel(99, 60);
  const mk = (pw, bp) => {
    const s = duel(pw, bp);
    return swingProbabilities(getBatter(s), getPitcher(s), 'fastball', 'meet', 0, 0, true, 0, { state: s });
  };
  assert.ok(effectiveStats(st60, getPitcher(st60)).pitchPower === 99);
  const ratio = (bp, i) => mk(99, bp)[i] / mk(30, bp)[i];
  for (const i of [6, 8]) assert.ok(ratio(99, i) > ratio(60, i) + 0.08, `outcome ${i}: ${ratio(99, i)} vs ${ratio(60, i)}`);
  // シミュレーション: 長打率の相対差が小さくなる
  const gap = (bp) => {
    const hi = swingMany(99, bp, 5000, 7);
    const lo = swingMany(30, bp, 5000, 7);
    return { xbh: 1 - (hi.xbh / hi.bip) / (lo.xbh / lo.bip), exit: lo.exit - hi.exit };
  };
  const g60 = gap(60);
  const g99 = gap(99);
  assert.ok(g99.xbh < g60.xbh, `XBH gap ${g99.xbh} vs ${g60.xbh}`);
  assert.ok(g99.exit < g60.exit, `exit gap ${g99.exit} vs ${g60.exit}`);
});

test('球威: 空振りへの影響は小さい（球速・ノビが主役）', () => {
  const s = (pw) => swingProbabilities({ contact: 60, power: 60, skills: [] },
    { pitching: { velocity: 147, power: pw }, skills: [] }, 'fastball', 'meet', 0, 0, true)[1];
  const r = s(99) / s(30);
  assert.ok(r > 1 && r < 1.12, `whiff ratio ${r}`);
});

test('球威: 疲労（スタミナ 50% 未満）で実効球威が下がる', () => {
  const st = duel(80, 60);
  const p = getPitcher(st);
  const fresh = effectiveStats(st, p).pitchPower;
  assert.equal(fresh, 80);
  const at = (pct) => {
    const s = structuredClone(st);
    s.stamina[p.id] = p.pitching.stamina * pct;
    return effectiveStats(s, p);
  };
  assert.equal(at(0.6).pitchPower, 80, '50% 以上は変化なし');
  const e20 = at(0.2);
  assert.ok(Math.abs(e20.pitchPower - (80 - TUNING.powerFatigue * 0.6)) < 0.2, `${e20.pitchPower}`);
  assert.ok(e20.powerFatigue > 0 && e20.mods.some((m) => m.source === '疲労（球威）'));
  assert.ok(at(0.05).pitchPower < e20.pitchPower);
  // その球の event.pitch.power にも反映（失投は −mistakePower）
  const s = structuredClone(st);
  s.stamina[p.id] = p.pitching.stamina * 0.2;
  const { event } = pitchContact(s, { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0 } }, null, mulberry32(3));
  assert.ok(event.pitch.power < 80 && event.pitch.power > 60, `${event.pitch.power}`);
  const { event: em } = pitchContact(st, { type: 'fastball', zone: { x: 1, y: 1 }, loc: { x: 0, y: 0, mistake: true } }, null, mulberry32(3));
  assert.equal(em.pitch.power, 80 - TUNING.mistakePower);
});

test('球威: 重い球 +15・軽い球 −15（加算、旧倍率は廃止）、調子で ±', () => {
  const base = { id: 'x', name: 'x', pitching: { velocity: 147, power: 60, control: 60, stamina: 50 }, skills: [] };
  assert.equal(effectiveStats(null, base).pitchPower, 60);
  assert.equal(effectiveStats(null, { ...base, skills: ['重い球'] }).pitchPower, 75);
  assert.equal(effectiveStats(null, { ...base, skills: ['軽い球'] }).pitchPower, 45);
  assert.deepEqual(SKILL_FX['重い球'], { add: { pitchPower: 15 } });
  assert.equal(SKILLS['軽い球'].type, 'red');
  assert.equal(SKILLS['軽い球'].target, 'pitcher');
  // 投手の打撃のパワー（effectiveStats().power）は球威と別
  assert.equal(effectiveStats(null, { ...base, power: 20, skills: ['重い球'] }).power, 20);
  // 重い球の効果 = 球威 +15 と同じ（二重に数えない）
  const b = { contact: 60, power: 60, skills: [] };
  const pr = (p) => swingProbabilities(b, p, 'fastball', 'meet', 0, 0, true);
  const heavy = pr({ ...base, skills: ['重い球'] });
  const plus15 = pr({ ...base, pitching: { ...base.pitching, power: 75 } });
  heavy.forEach((v, i) => assert.ok(Math.abs(v - plus15[i]) < 1e-12));
  // 調子（試合中）: 絶好調 +8 … 絶不調 −8。絶不調では青特の重い球は無効、絶好調では赤特の軽い球が無効
  const home = structuredClone(blue);
  const pid = home.pitchers[0];
  const hp = home.players.find((x) => x.id === pid);
  hp.skills = ['重い球'];
  for (const c of Object.keys(CONDITIONS)) {
    const s = createGame(home, red, { conditions: { ...allNormal, [pid]: c } });
    const exp = hp.pitching.power + CONDITIONS[c].pit.pitchPower + (c === '絶不調' ? 0 : 15);
    assert.equal(effectiveStats(s, getPitcher(s)).pitchPower, exp, c);
  }
  hp.skills = ['軽い球'];
  const sg = createGame(home, red, { conditions: { ...allNormal, [pid]: '絶好調' } });
  assert.equal(effectiveStats(sg, getPitcher(sg)).pitchPower, hp.pitching.power + 8);
});
