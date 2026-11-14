/** ペナント（js/season-model.js）と試合前オーダー（js/lineup.js）のテスト */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../js/data.js';
import { createGame, lineupView, simulateGame } from '../js/engine.js';
import {
  defaultPlan, autoPlan, validatePlan, applyLineup, swapOrder, swapPositions, substitute, setStarter, benchOfPlan,
} from '../js/lineup.js';
import {
  makeSchedule, createSeason, standings, fmtGb, fmtPct, recordGame, simGame, finishDay, simulateToEnd, leaders,
  leagueTotals, teamStats, validateSeason, saveSeason, loadSeason, SEASON_KEY, gamesOnDay, prepareMatch,
  pitcherStatus, chooseStarter, nextUserGame, avgOf, eraOf, FATIGUE, playedCount, simulateMatch, gameRng, mulberry32,
} from '../js/season-model.js';

const ids = TEAMS.map((t) => t.id);
const [red, blue] = TEAMS;
const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

/* ---------- オーダー ---------- */
test('オーダー: データどおりの plan は有効で、createGame に渡すと同じ打順・守備位置', () => {
  for (const t of TEAMS) {
    const plan = defaultPlan(t);
    assert.ok(validatePlan(t, plan).ok, t.id);
    const team = applyLineup(t, plan);
    assert.deepEqual(team.lineup, t.lineup);
    assert.equal(team.pitchers[0], t.pitchers[0]);
    const s = createGame(blue, team, { userSide: 'away' });
    const view = lineupView(s, 'away');
    assert.deepEqual(view.map((v) => v.id), t.lineup);
  }
});

test('オーダー: おまかせは 9 人・9 守備位置ちょうど・全員本職、先発投手が打順に入る', () => {
  for (const t of TEAMS) {
    const st = t.pitchers[1];
    const plan = autoPlan(t, { starter: st });
    const v = validatePlan(t, plan);
    assert.ok(v.ok, `${t.id}: ${v.errors.join(',')}`);
    assert.equal(v.warnings.length, 0, `${t.id}: ${v.warnings.map((w) => w.text).join(',')}`);
    assert.equal(plan.order[8], st);
    assert.equal(plan.pos[st], '投');
    assert.equal(benchOfPlan(t, plan).length, 5);
  }
});

test('オーダー: 入れ替え・守備位置の交換・控えとの交代・先発の変更、検査と警告', () => {
  let plan = defaultPlan(red);
  plan = swapOrder(plan, 0, 3);
  assert.equal(plan.order[0], red.lineup[3]);
  assert.ok(validatePlan(red, plan).ok);
  // 守備位置の交換（捕手と中堅）→ 本職外の警告
  const c = plan.order.find((id) => plan.pos[id] === '捕');
  const cf = plan.order.find((id) => plan.pos[id] === '中');
  const p2 = swapPositions(plan, c, cf);
  const v2 = validatePlan(red, p2);
  assert.ok(v2.ok);
  assert.ok(v2.warnings.length >= 1);
  // 投手の守備位置は動かせない
  assert.equal(swapPositions(plan, plan.starter, c), plan);
  // 控えと交代
  const bench = benchOfPlan(red, plan);
  const p3 = substitute(plan, c, bench[0]);
  assert.ok(p3.order.includes(bench[0]) && !p3.order.includes(c));
  assert.equal(p3.pos[bench[0]], '捕');
  // 先発の変更
  const p4 = setStarter(red, plan, red.pitchers[1]);
  assert.equal(p4.starter, red.pitchers[1]);
  assert.ok(p4.order.includes(red.pitchers[1]) && !p4.order.includes(red.pitchers[0]));
  assert.ok(validatePlan(red, p4).ok);
  // 不正: 守備位置の重複・投手が野手・人数不足
  const dup = { ...plan, pos: { ...plan.pos, [cf]: '捕' } };
  assert.equal(validatePlan(red, dup).ok, false);
  assert.equal(validatePlan(red, { ...plan, order: plan.order.slice(0, 8) }).ok, false);
  const pit = { ...plan, order: plan.order.map((id) => (id === c ? red.pitchers[2] : id)), pos: { ...plan.pos, [red.pitchers[2]]: '捕' } };
  assert.equal(validatePlan(red, pit).ok, false);
  assert.throws(() => applyLineup(red, dup));
});

test('オーダー: applyLineup の守備位置・疲労・休養がエンジンに反映される', () => {
  let plan = defaultPlan(red, red.pitchers[1]);
  const c = plan.order.find((id) => plan.pos[id] === '捕');
  const ss = plan.order.find((id) => plan.pos[id] === '遊');
  plan = swapPositions(plan, c, ss);
  const team = applyLineup(red, plan, { staminaMul: { [red.pitchers[1]]: 0.5 }, rest: [red.pitchers[5]] });
  assert.equal(team.pitchers[0], red.pitchers[1]);
  assert.ok(!team.pitchers.includes(red.pitchers[5]));
  const s = createGame(blue, team, { userSide: 'away' });
  assert.equal(s.positions.away[c], '遊');
  assert.equal(s.positions.away[ss], '捕');
  assert.equal(s.positions.away[red.pitchers[1]], '投');
  const orig = red.players.find((p) => p.id === red.pitchers[1]).pitching.stamina;
  assert.equal(s.stamina[red.pitchers[1]], Math.round(orig * 0.5));
  assert.equal(lineupView(s, 'away').find((v) => v.id === c).eligible, false);
  // 元のデータは変わらない
  assert.equal(red.players.find((p) => p.id === c).pos, '捕');
  // 抑えが休養でも最後まで試合ができる
  const end = simulateGame(blue, team, mulberry32(4));
  assert.ok(end.over);
});

/* ---------- 日程 ---------- */
test('日程: 各チーム同じ試合数、各カード同数、ホーム・ビジター半々、1 日 1 試合まで', () => {
  for (const len of [12, 30, 60]) {
    const games = makeSchedule(ids, len, 42);
    assert.equal(games.length, len * 2);
    const count = {}; const home = {}; const pair = {}; const perDay = {};
    for (const g of games) {
      count[g.home] = (count[g.home] || 0) + 1; count[g.away] = (count[g.away] || 0) + 1;
      home[g.home] = (home[g.home] || 0) + 1;
      const k = [g.home, g.away].sort().join('-');
      pair[k] = pair[k] || {}; pair[k][g.home] = (pair[k][g.home] || 0) + 1;
      for (const t of [g.home, g.away]) {
        const d = `${g.day}|${t}`;
        perDay[d] = (perDay[d] || 0) + 1;
      }
    }
    for (const t of ids) { assert.equal(count[t], len); assert.equal(home[t], len / 2); }
    assert.equal(Object.keys(pair).length, 6);
    for (const k of Object.keys(pair)) {
      const v = Object.values(pair[k]);
      assert.equal(v.length, 2, `${len} ${k}`);
      assert.equal(v[0], len / 6); assert.equal(v[1], len / 6);
    }
    assert.ok(Object.values(perDay).every((n) => n === 1));
    // 移動日がある（試合のない日）
    const days = new Set(games.map((g) => g.day));
    assert.ok(Math.max(...days) + 1 > days.size);
  }
  assert.throws(() => makeSchedule(ids, 13));
});

/* ---------- 順位表 ---------- */
test('順位表: 勝率（引き分けは除く）とゲーム差', () => {
  const s = createSeason({ userTeamId: 'red', length: 12, seed: 3 });
  // 手で結果を入れる: red 3勝0敗、blue 1勝1敗1分、green 1勝2敗、yellow 0勝2敗1分 になるように
  const set = (home, away, hs, as) => {
    const g = s.games.find((x) => !x.result && x.home === home && x.away === away)
      || s.games.find((x) => !x.result && x.home === away && x.away === home);
    if (g.home === home) g.result = { hs, as, H: [0, 0], E: [0, 0], line: [[], []], inn: 9 };
    else g.result = { hs: as, as: hs, H: [0, 0], E: [0, 0], line: [[], []], inn: 9 };
  };
  set('red', 'blue', 5, 1); set('red', 'green', 3, 2); set('red', 'yellow', 1, 0);
  set('blue', 'green', 4, 0); set('blue', 'yellow', 2, 2);
  set('green', 'yellow', 6, 5);
  const st = standings(s);
  assert.deepEqual(st.map((r) => r.teamId), ['red', 'blue', 'green', 'yellow']);
  const r = Object.fromEntries(st.map((x) => [x.teamId, x]));
  assert.deepEqual([r.red.w, r.red.l, r.red.t], [3, 0, 0]);
  assert.deepEqual([r.blue.w, r.blue.l, r.blue.t], [1, 1, 1]);
  assert.equal(r.blue.pct, 0.5);
  assert.equal(r.yellow.pct, 0);
  assert.equal(r.red.gb, 0);
  assert.equal(r.blue.gb, 1.5);    // ((3 - 0) - (1 - 1)) / 2
  assert.equal(fmtGb(r.blue.gb), '1.5');
  assert.equal(r.green.gb, 2);
  assert.equal(r.yellow.gb, 2.5);
  assert.equal(fmtGb(0), '-');
  assert.equal(fmtPct(1), '1.000');
  assert.equal(fmtPct(2 / 3), '.667');
  assert.equal(r.red.rs, 9); assert.equal(r.red.ra, 3);
});

/* ---------- 成績の集計 ---------- */
test('成績: 1 試合の記録で打撃・投球成績・勝敗投手・出場が集計される', () => {
  const s = createSeason({ userTeamId: 'red', length: 12, seed: 11 });
  const g = gamesOnDay(s)[0];
  const m = prepareMatch(s, g);
  const state = simulateMatch(m.home, m.away, gameRng(s, g.id));
  recordGame(s, g, state, { starters: m.starters });
  assert.throws(() => recordGame(s, g, state, { starters: m.starters }));
  const all = [...m.home.players, ...m.away.players];
  const sum = (k) => all.reduce((a, p) => a + s.stats[p.id][k], 0);
  const sumGame = (k) => all.reduce((a, p) => a + (state.stats[p.id][k] || 0), 0);
  assert.equal(sum('h'), state.hits.home + state.hits.away);
  assert.equal(sum('ab'), sumGame('ab'));
  assert.equal(sum('hr'), sumGame('hr'));
  assert.equal(sum('outs'), sumGame('ip_outs'));
  assert.equal(sum('ha'), sum('h'));                 // 被安打の合計 = 安打の合計
  assert.equal(sum('hra'), sum('hr'));
  assert.equal(sum('k'), sum('so'));                 // 奪三振の合計 = 三振の合計
  const tie = g.result.hs === g.result.as;
  assert.equal(sum('w'), tie ? 0 : 1);
  assert.equal(sum('l'), tie ? 0 : 1);
  assert.equal(sum('gs'), 2);
  assert.equal(s.stats[m.starters.home].gs, 1);
  assert.ok(sum('d2') + sum('d3') + sum('hr') <= sum('h'));
  for (const side of ['home', 'away']) {
    for (const id of m[side].lineup) if (!m[side].players.find((p) => p.id === id).pitching) assert.ok(s.stats[id].g >= 1);
  }
  assert.ok(s.fatigue[m.starters.home] > 40);
  assert.equal(s.lastPitched[m.starters.home], g.day);
});

test('成績: チーム成績・個人タイトルの数値が個人成績と一致', () => {
  const s = createSeason({ userTeamId: 'blue', length: 12, seed: 5 });
  for (let i = 0; i < 4; i++) finishDay(s);
  assert.equal(playedCount(s, 'blue'), 4);
  for (const t of teamStats(s)) {
    const st = standings(s).find((r) => r.teamId === t.teamId);
    assert.equal(t.w, st.w); assert.equal(t.rs, st.rs);
    const team = TEAMS.find((x) => x.id === t.teamId);
    assert.equal(t.hr, team.players.reduce((a, p) => a + s.stats[p.id].hr, 0));
  }
  const L = leaders(s);
  for (let i = 1; i < L.hr.rows.length; i++) assert.ok(L.hr.rows[i - 1].value >= L.hr.rows[i].value);
  for (const r of L.era.rows) assert.ok(s.stats[r.id].outs >= 4 * 3);
  for (const r of L.avg.rows) assert.equal(r.value, avgOf(s.stats[r.id]));
  const decided = s.games.filter((g) => g.result && g.result.hs !== g.result.as).length;
  assert.equal(Object.values(s.stats).reduce((a, x) => a + x.w, 0), decided);
});

test('ローテーション: 先発は連続で投げない・疲れた投手はスタミナが下がる・救援は 3 連投しない', () => {
  const s = createSeason({ userTeamId: 'red', length: 12, seed: 9 });
  const starters = {};
  for (let d = 0; d < 8; d++) {
    for (const g of gamesOnDay(s)) {
      const m = prepareMatch(s, g);
      for (const side of ['home', 'away']) {
        (starters[g[side]] = starters[g[side]] || []).push(m.starters[side]);
        for (const id of m[side].pitchers) {
          if (id === m.starters[side]) continue;
          assert.ok(pitcherStatus(s, id).streak < 2, `${id} は 3 連投`);
        }
      }
      recordGame(s, g, simulateMatch(m.home, m.away, gameRng(s, g.id)), { starters: m.starters });
    }
    finishDay(s);
  }
  for (const [tid, list] of Object.entries(starters)) {
    for (let i = 1; i < list.length; i++) assert.notEqual(list[i], list[i - 1], `${tid}: ${list.join(',')}`);
  }
  s.fatigue.r10 = 60;
  const st = pitcherStatus(s, 'r10');
  assert.equal(st.mul, 1 - FATIGUE.staminaLoss * 0.6);
  assert.equal(st.rest, true); // 先発要員は登板日以外ベンチ外
  s.fatigue.r10 = 0; s.fatigue.r11 = 0;
  assert.ok(['r10', 'r11'].includes(chooseStarter(s, 'red')));
  // 疲れた先発はスタミナが下がった状態で試合に出る
  s.fatigue.r10 = 40; s.fatigue.r11 = 80; s.rot.red = 0;
  const g = s.games.find((x) => !x.result && (x.home === 'red' || x.away === 'red'));
  const m = prepareMatch(s, g);
  const side = g.home === 'red' ? 'home' : 'away';
  assert.equal(m.starters[side], 'r10');
  const base = TEAMS[0].players.find((p) => p.id === 'r10').pitching.stamina;
  assert.equal(m[side].players.find((p) => p.id === 'r10').pitching.stamina, Math.round(base * 0.8));
  assert.ok(!m[side].pitchers.includes('r11'));
});

/* ---------- 保存・読み込み ---------- */
test('保存: 往復で同じ状態、壊れたデータ・別バージョンは null', () => {
  const s = createSeason({ userTeamId: 'green', length: 12, seed: 21 });
  for (let i = 0; i < 3; i++) finishDay(s);
  s.userPlan = autoPlan(TEAMS.find((t) => t.id === 'green'));
  const store = memStore();
  assert.ok(saveSeason(s, store));
  assert.ok(store.getItem(SEASON_KEY));
  const back = loadSeason(store);
  assert.deepEqual(back, s);
  finishDay(back);
  assert.ok(back.games.filter((g) => g.result).length > s.games.filter((g) => g.result).length);
  const bads = ['{', 'null', '[]', '"x"', '{"v":2}', JSON.stringify({ ...s, v: 99 }),
    JSON.stringify({ ...s, teamIds: ['red', 'red', 'blue', 'x'] }),
    JSON.stringify({ ...s, games: s.games.slice(1) }),
    JSON.stringify({ ...s, games: s.games.map((g, i) => (i === 0 ? { ...g, result: { hs: 'x' } } : g)) }),
    JSON.stringify({ ...s, games: s.games.map((g, i) => (i === 0 ? { ...g, home: g.away } : g)) }),
    JSON.stringify({ ...s, userTeamId: 'nope' }), JSON.stringify({ ...s, length: 13 })];
  for (const bad of bads) {
    store.setItem(SEASON_KEY, bad);
    assert.equal(loadSeason(store), null, bad.slice(0, 60));
  }
  const broken = JSON.parse(JSON.stringify(s));
  broken.stats.g1 = { ab: -5, h: 'a' };
  broken.day = 999;
  broken.fatigue.g10 = 1e9;
  broken.userPlan = { order: ['x'] };
  const v = validateSeason(broken);
  assert.equal(v.stats.g1.ab, 0);
  assert.equal(v.stats.g1.h, 0);
  assert.equal(v.fatigue.g10, 100);
  assert.equal(v.userPlan, null);
  assert.ok(v.games.filter((g) => g.day < v.day).every((g) => g.result));
  assert.ok(gamesOnDay(v).some((g) => !g.result));
  assert.equal(loadSeason({ getItem() { throw new Error('denied'); } }), null);
  assert.equal(loadSeason(memStore()), null);
  assert.equal(saveSeason(s, { setItem() { throw new Error('quota'); } }), false);
});

/* ---------- シーズン全体 ---------- */
test('シーズン: 30 試合を最後までシミュレート（10 秒未満）、リーグ平均が NPB の範囲、表彰と優勝', () => {
  const t0 = Date.now();
  const s = createSeason({ userTeamId: 'yellow', length: 30, seed: 2026 });
  simulateToEnd(s);
  const ms = Date.now() - t0;
  assert.ok(ms < 10000, `${ms} ms`);
  assert.ok(s.done);
  assert.ok(s.games.every((g) => g.result));
  for (const t of ids) assert.equal(playedCount(s, t), 30);
  const L = leagueTotals(s);
  assert.ok(L.runsPerTeamGame > 2.6 && L.runsPerTeamGame < 5.2, `得点 ${L.runsPerTeamGame}`);
  assert.ok(L.avg > 0.225 && L.avg < 0.29, `打率 ${L.avg}`);
  const era = eraOf(L.totals);
  assert.ok(era > 2.4 && era < 4.9, `防御率 ${era}`);
  assert.ok(L.hrPerTeamGame > 0.4 && L.hrPerTeamGame < 1.4, `本塁打 ${L.hrPerTeamGame}`);
  const st = standings(s);
  assert.equal(st.reduce((a, r) => a + r.w, 0), st.reduce((a, r) => a + r.l, 0));
  assert.equal(s.awards.champion, st[0].teamId);
  assert.ok(s.awards.mvp && s.awards.mvp.name);
  assert.equal(s.awards.titles.length, 8);
  assert.ok(s.awards.titles.every((t) => t.winners.length >= 1), JSON.stringify(s.awards.titles));
  for (const t of TEAMS) {
    const gs = t.pitchers.filter((id) => t.players.find((p) => p.id === id).pitching.role === 'starter').map((id) => s.stats[id].gs);
    assert.ok(Math.min(...gs) >= 12, `${t.id} ${gs}`);
  }
  // 読み込み後の表彰も同じ
  const store = memStore();
  saveSeason(s, store);
  assert.deepEqual(loadSeason(store).awards, s.awards);
  // 同じシードなら同じ結果
  const s2 = createSeason({ userTeamId: 'yellow', length: 30, seed: 2026 });
  simulateToEnd(s2);
  assert.deepEqual(standings(s2), st);
});

test('シーズン: 自分の試合（短いイニング・試合画面のオーダー）を記録して次の日へ', () => {
  const s = createSeason({ userTeamId: 'red', length: 12, seed: 77 });
  const g = nextUserGame(s);
  const plan = autoPlan(TEAMS[0], { starter: chooseStarter(s, 'red') });
  const m = prepareMatch(s, g, { userPlan: plan });
  const userSide = g.home === 'red' ? 'home' : 'away';
  assert.deepEqual(m[userSide].lineup, plan.order);
  const st = simulateMatch(m.home, m.away, gameRng(s, 'short'), { innings: 3 });
  assert.equal(st.innings, 3);
  recordGame(s, g, st, { starters: m.starters, by: 'user' });
  assert.equal(g.result.by, 'user');
  assert.equal(g.result.inn, 3);
  finishDay(s);
  assert.ok(gamesOnDay(s, g.day).every((x) => x.result));
  assert.ok(s.day > g.day);
  // チームが日程と違う試合は記録できない
  const other = s.games.find((x) => !x.result && (x.home !== st.teams.home.id || x.away !== st.teams.away.id));
  assert.throws(() => recordGame(s, other, st, {}));
  assert.equal(other.result, null);
});
