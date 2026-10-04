/**
 * 試合エンジン（ドキドキベースボール）
 * すべて純粋関数・DOM 非依存。乱数は引数 rng で注入（既定 Math.random）。
 * 入力 state は決して変更しない（structuredClone した新 state を返す）。
 * 打席判定は docs/BALANCE.md の係数表・能力補正・投球位置モデルに従う。
 */
import { PITCH_TYPES } from './data.js';

/* ------------------------------------------------------------------ */
/* 定数・係数                                                          */
/* ------------------------------------------------------------------ */

/** 打席結果の並び（係数表の列順） */
export const OUTCOMES = ['ball', 'strike', 'foul', 'groundout', 'flyout', 'single', 'double', 'triple', 'hr'];

/** スイング時の結果確率表 [mode][距離0-2][タイミング帯0-2]（BALANCE.md draft-1） */
export const SWING_TABLE = {
  meet: [
    [[0, 10, 18, 24, 20, 20, 6, 1, 1], [0, 24, 24, 22, 17, 10, 2, 0, 1], [0, 55, 25, 11, 6, 2, 1, 0, 0]],
    [[0, 28, 25, 22, 15, 8, 2, 0, 0], [0, 43, 27, 16, 10, 3, 1, 0, 0], [0, 72, 20, 5, 2, 1, 0, 0, 0]],
    [[0, 70, 20, 6, 3, 1, 0, 0, 0], [0, 84, 12, 3, 1, 0, 0, 0, 0], [0, 95, 4, 1, 0, 0, 0, 0, 0]],
  ],
  power: [
    [[0, 20, 18, 19, 19, 12, 6, 1, 5], [0, 36, 24, 16, 16, 4, 2, 0, 2], [0, 68, 20, 5, 5, 1, 0, 0, 1]],
    [[0, 42, 24, 14, 13, 3, 2, 0, 2], [0, 57, 25, 8, 8, 1, 0, 0, 1], [0, 82, 14, 2, 2, 0, 0, 0, 0]],
    [[0, 80, 14, 3, 2, 0, 0, 0, 1], [0, 91, 7, 1, 1, 0, 0, 0, 0], [0, 97, 3, 0, 0, 0, 0, 0, 0]],
  ],
};

/**
 * 調整用係数（50試合シミュレーション tests/balance.mjs で調整済み）
 * BALANCE.md の能力補正式の係数と、ゾーン外スイング補正・CPU打者/投手の傾向。
 * draft-1 からの変更: sigmaBase 0.45→0.72（四球が出なかったため）、foulBase 1.6（ファウル重み増で
 * 打席を長くし四球・三振を確保）、singleC 0.35→0.30（安打過多の抑制）。
 */
export const TUNING = {
  strikeC: -0.65, strikeV: 0.35, strikeD: 0.25,
  foulC: 0.15, foulBase: 1.6,
  singleC: 0.30, singleP: -0.15,
  doubleC: 0.35, doubleP: 0.35,
  tripleC: 0.35, tripleP: 0.15,
  hrC: 0.35, hrP: 0.85,
  outZoneStrike: 1.4, outZoneOther: 0.7,
  sigmaBase: 0.72, sigmaK: 0.20,
  // CPU 打者
  swingInZone: [0.66, 0.76, 0.88], swingOutZone: [0.18, 0.24, 0.36],
  guessNoiseBase: 0.0, guessNoiseContact: 0.55,
  timingBase: 0.08, timingVel: 0.15, timingContact: 0.25, timingRead: 0.25,
  powerModeRate: 0.40,
  // CPU 投手（コーナーを狙う確率）
  cornerBase: 0.35, cornerTwoStrike: 0.75, cornerThreeBall: 0.30, centerThreeBall: 0.25, breakAimFix: 0.3,
  wasteBase: 0.4, wasteTwoStrike: 0.5, wasteOffset: 0.6, wasteThreeBall: 0.1,
  // 走者
  singleScoreFrom2nd: 0.60, doubleScoreFrom1st: 0.40, doublePlay: 0.20,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const other = (side) => (side === 'away' ? 'home' : 'away');
const sum = (a) => a.reduce((x, y) => x + y, 0);

/** 正規乱数（Box-Muller、rng 注入） */
function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 重み配列からインデックスを抽選 */
function pickWeighted(weights, rng) {
  const total = sum(weights);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/**
 * 球速 km/h → 能力値 1-99
 * @param {number} kmh
 */
export function velocityAbility(kmh) {
  return clamp(Math.round(((kmh - 120) / 50) * 99), 1, 99);
}

/* ------------------------------------------------------------------ */
/* 状態の参照                                                          */
/* ------------------------------------------------------------------ */

/** 攻撃側 'away'|'home' */
const battingSide = (s) => (s.half === 'top' ? 'away' : 'home');
/** 守備側 */
const fieldingSide = (s) => (s.half === 'top' ? 'home' : 'away');

function findPlayer(team, id) {
  return team.players.find((p) => p.id === id);
}

/** 合計得点 */
const total = (s, side) => sum(s.score[side]);

/**
 * 新しい試合を作成
 * @param {object} homeTeam 後攻チーム
 * @param {object} awayTeam 先攻チーム
 * @param {{innings?:number, userSide?:'away'|'home'|null}} [opts]
 * @returns {object} GameState
 */
export function createGame(homeTeam, awayTeam, { innings = 9, userSide = 'away' } = {}) {
  const teams = { away: structuredClone(awayTeam), home: structuredClone(homeTeam) };
  const stats = {};
  const stamina = {};
  for (const side of ['away', 'home']) {
    for (const p of teams[side].players) {
      stats[p.id] = { ab: 0, h: 0, hr: 0, rbi: 0, so: 0, bb: 0, ip_outs: 0, er: 0, k: 0 };
      if (p.pitching) stamina[p.id] = p.pitching.stamina;
    }
  }
  return {
    inning: 1, half: 'top', outs: 0, balls: 0, strikes: 0, bases: [false, false, false],
    innings, maxInnings: innings + 3,
    score: { away: [0], home: [] }, hits: { away: 0, home: 0 }, errors: { away: 0, home: 0 },
    batterIndex: { away: 0, home: 0 }, pitcherIndex: { away: 0, home: 0 }, pitchCount: { away: 0, home: 0 },
    stamina, stats, log: [], over: false,
    // 勝敗投手判定用
    decision: null, // { side, win, lose } 現在リードしている側と責任投手
    entries: { [teams.away.pitchers[0]]: { side: 'away', lead: 0 }, [teams.home.pitchers[0]]: { side: 'home', lead: 0 } },
    teams, userSide,
  };
}

/**
 * 現在の打者
 * @param {object} state
 */
export function getBatter(state) {
  const side = battingSide(state);
  const team = state.teams[side];
  return findPlayer(team, team.lineup[state.batterIndex[side] % team.lineup.length]);
}

/**
 * 現在の投手
 * @param {object} state
 */
export function getPitcher(state) {
  const side = fieldingSide(state);
  const team = state.teams[side];
  return findPlayer(team, team.pitchers[state.pitcherIndex[side]]);
}

/** 指定チームの現在の投手 */
function currentPitcherOf(s, side) {
  const team = s.teams[side];
  return findPlayer(team, team.pitchers[s.pitcherIndex[side]]);
}

/**
 * 試合終了か
 * @param {object} state
 */
export function isGameOver(state) {
  return !!state.over;
}

/**
 * 表示用の要約
 * @param {object} state
 * @returns {{inningLabel:string,count:{b:number,s:number,o:number},bases:boolean[],score:{away:number,home:number},batting:'away'|'home'}}
 */
export function summary(state) {
  return {
    inningLabel: `${state.inning}回${state.half === 'top' ? '表' : '裏'}`,
    count: { b: state.balls, s: state.strikes, o: state.outs },
    bases: [...state.bases],
    score: { away: total(state, 'away'), home: total(state, 'home') },
    batting: battingSide(state),
  };
}

/* ------------------------------------------------------------------ */
/* 投球位置                                                            */
/* ------------------------------------------------------------------ */

/** 疲労による補正（スタミナ 20 未満で球速低下・制球悪化） */
function fatigue(s, pitcher) {
  const st = s.stamina?.[pitcher.id] ?? 50;
  return st < 20 ? (20 - st) / 20 : 0;
}

/**
 * 投球の実際の到達位置を計算（aim + 変化 + 制球誤差）。中心 (0,0)、ゾーン内は |x|,|y|<=1.5
 * @param {object} state
 * @param {{type:string, zone:{x:number,y:number}, offset?:{x:number,y:number}}} pitchInput offset=ボール球を狙う際の狙いのずらし（CPU用・任意）
 * @param {()=>number} [rng]
 * @returns {{x:number,y:number,inZone:boolean}}
 */
export function pitchLocation(state, pitchInput, rng = Math.random) {
  const pitcher = getPitcher(state);
  const pt = PITCH_TYPES[pitchInput.type] || PITCH_TYPES.fastball;
  const flip = pitcher.throws === '左' ? -1 : 1;
  const k = ((pitcher.pitching?.control ?? 50) - 50) / 49;
  const sigma = TUNING.sigmaBase - TUNING.sigmaK * k + 0.12 * fatigue(state, pitcher);
  const off = pitchInput.offset || { x: 0, y: 0 };
  const x = pitchInput.zone.x - 1 + (off.x || 0) + pt.dx * flip + gauss(rng) * sigma;
  const y = pitchInput.zone.y - 1 + (off.y || 0) + pt.dy + gauss(rng) * sigma;
  return { x, y, inZone: Math.abs(x) <= 1.5 && Math.abs(y) <= 1.5 };
}

/** 位置→セル番号（ゾーン外は -1 や 3 になりうる） */
const cellOf = (v) => Math.round(v) + 1;

/* ------------------------------------------------------------------ */
/* 打席判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * スイング結果の確率（正規化済み、OUTCOMES 順）
 * @param {object} batter
 * @param {object} pitcher
 * @param {string} type 球種
 * @param {'meet'|'power'} mode
 * @param {number} dist 0-2
 * @param {number} band 0-2
 * @param {boolean} inZone
 * @param {number} [fat] 疲労 0-1
 */
export function swingProbabilities(batter, pitcher, type, mode, dist, band, inZone, fat = 0) {
  const T = TUNING;
  const row = [...SWING_TABLE[mode === 'power' ? 'power' : 'meet'][dist][band]];
  const c = (batter.contact - 50) / 49;
  const p = (batter.power - 50) / 49;
  const kmh = (pitcher.pitching?.velocity ?? 135) - 4 * fat;
  const v = (velocityAbility(kmh) - 50) / 49;
  const lv = (pitcher.pitching?.pitches || []).find((q) => q.type === type)?.level ?? 2;
  const read = (PITCH_TYPES[type] || PITCH_TYPES.fastball).read + (type === 'fastball' ? 0 : 0.04 * (lv - 2));
  const d = read - 0.30;
  const mult = [1,
    Math.exp(T.strikeC * c + T.strikeV * v + T.strikeD * d),
    T.foulBase * Math.exp(T.foulC * c), 1, 1,
    Math.exp(T.singleC * c + T.singleP * p),
    Math.exp(T.doubleC * c + T.doubleP * p),
    Math.exp(T.tripleC * c + T.tripleP * p),
    Math.exp(T.hrC * c + T.hrP * p)];
  for (let i = 0; i < row.length; i++) {
    row[i] *= mult[i];
    if (!inZone) row[i] *= i === 1 ? T.outZoneStrike : T.outZoneOther;
  }
  const t = sum(row);
  return row.map((w) => w / t);
}

const DIR_GROUND = ['ショート', 'セカンド', 'サード', 'ファースト', 'ピッチャー'];
const DIR_FLY = ['レフト', 'センター', 'ライト', 'セカンド', 'ショート'];
const DIR_HIT = ['レフト前', 'センター前', 'ライト前', '三遊間を破る', '一二塁間を破る'];
const DIR_LONG = ['左中間', '右中間', 'レフト線', 'ライト線'];
const pickText = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];

/** 得点を加算し、打点・自責点・勝敗投手の情報を更新 */
function addRuns(s, n, batter, rbi = true) {
  if (n <= 0) return;
  const bat = battingSide(s);
  const before = total(s, 'away') - total(s, 'home');
  s.score[bat][s.inning - 1] = (s.score[bat][s.inning - 1] || 0) + n;
  if (rbi) s.stats[batter.id].rbi += n;
  const pitcher = getPitcher(s);
  s.stats[pitcher.id].er += n;
  const after = total(s, 'away') - total(s, 'home');
  const leaderBefore = Math.sign(before);
  const leaderAfter = Math.sign(after);
  if (leaderAfter === 0) s.decision = null;
  else if (leaderAfter !== leaderBefore) {
    s.decision = { side: bat, win: currentPitcherOf(s, bat).id, lose: pitcher.id };
  }
  // サヨナラ
  if (s.half === 'bottom' && s.inning >= s.innings && total(s, 'home') > total(s, 'away')) s.over = true;
}

/** アウトを記録 */
function addOut(s, n = 1) {
  const pitcher = getPitcher(s);
  const real = Math.min(n, 3 - s.outs);
  s.outs += real;
  s.stats[pitcher.id].ip_outs += real;
}

/** 押し出し型の進塁（四球・ゴロの封殺進塁）。戻り値=生還数 */
function forceAdvance(bases) {
  // bases は [1塁,2塁,3塁]、打者走者が1塁へ入る
  let runs = 0;
  if (bases[0]) {
    if (bases[1]) {
      if (bases[2]) runs = 1;
      bases[2] = true;
    }
    bases[1] = true;
  }
  bases[0] = true;
  return runs;
}

/**
 * CPU 投手交代（ユーザー側以外）。交代したら新投手名を返す
 * @param {object} s 変更可能な state（clone 済み）
 */
function maybeChangePitcher(s) {
  if (s.over) return null;
  const side = fieldingSide(s);
  if (side === s.userSide) return null;
  const team = s.teams[side];
  const idx = s.pitcherIndex[side];
  const last = team.pitchers.length - 1;
  if (idx >= last) return null;
  const cur = currentPitcherOf(s, side);
  const lead = total(s, side) - total(s, other(side));
  let next = idx;
  if (s.inning >= s.innings && lead > 0 && lead <= 3) next = last;
  else if ((s.stamina[cur.id] ?? 0) < 25 || (s.inning >= 8 && idx === 0)) next = idx + 1;
  if (next === idx) return null;
  return applyPitcherChange(s, side, next);
}

function applyPitcherChange(s, side, next) {
  const team = s.teams[side];
  const oldId = team.pitchers[s.pitcherIndex[side]];
  const newId = team.pitchers[next];
  s.pitcherIndex[side] = next;
  const li = team.lineup.indexOf(oldId);
  if (li >= 0) team.lineup[li] = newId;
  s.entries[newId] = { side, lead: total(s, side) - total(s, other(side)) };
  return findPlayer(team, newId);
}

/**
 * 投手交代（UI用・ユーザー側でも可）
 * @param {object} state
 * @param {'away'|'home'} side
 * @param {number} [index] 投手リストの番号（省略時は次の投手）
 * @returns {object} 新しい state
 */
export function changePitcher(state, side, index) {
  const s = structuredClone(state);
  const next = index ?? Math.min(s.pitcherIndex[side] + 1, s.teams[side].pitchers.length - 1);
  if (next !== s.pitcherIndex[side]) {
    const p = applyPitcherChange(s, side, next);
    s.log.push({ kind: 'change', text: `ピッチャー交代、${p.name}`, runs: 0 });
  }
  return s;
}

/** 打席終了処理（打順を進め、半イニング終了・試合終了・投手交代を判定） */
function endPlateAppearance(s, event) {
  const bat = battingSide(s);
  s.balls = 0;
  s.strikes = 0;
  s.batterIndex[bat] = (s.batterIndex[bat] + 1) % s.teams[bat].lineup.length;
  if (s.over) {
    event.text += ' サヨナラ！ 試合終了！';
    return;
  }
  if (s.outs >= 3) {
    const away = total(s, 'away');
    const home = total(s, 'home');
    event.text += ' スリーアウト、チェンジ。';
    event.endHalf = true;
    if (s.half === 'top') {
      if (s.inning >= s.innings && home > away) {
        s.over = true;
      } else {
        s.half = 'bottom';
        s.score.home[s.inning - 1] = 0;
      }
    } else if (s.inning >= s.innings && (home !== away || s.inning >= s.maxInnings)) {
      s.over = true;
    } else {
      s.inning += 1;
      s.half = 'top';
      s.score.away[s.inning - 1] = 0;
    }
    s.outs = 0;
    s.bases = [false, false, false];
    if (s.over) {
      event.text += home === away ? ' 引き分けで試合終了！' : ' 試合終了！';
      return;
    }
  }
  const np = maybeChangePitcher(s);
  if (np) {
    event.pitcherChange = np.id;
    event.text += ` ピッチャー交代、${np.name}。`;
  }
}

/**
 * 1球を判定する
 * @param {object} state
 * @param {{type:string, zone:{x:number,y:number}, loc?:{x:number,y:number}}} pitchInput loc 指定時はその位置を使う
 * @param {null|{zone:{x:number,y:number}, mode:'meet'|'power', timing:number}} batInput null=見送り
 * @param {()=>number} [rng]
 * @returns {{state:object, event:object}}
 */
export function resolvePitch(state, pitchInput, batInput, rng = Math.random) {
  const s = structuredClone(state);
  if (s.over) return { state: s, event: { kind: 'none', text: '試合は終了しています', runs: 0 } };
  const bat = battingSide(s);
  const def = fieldingSide(s);
  const batter = getBatter(s);
  const pitcher = getPitcher(s);
  const type = PITCH_TYPES[pitchInput.type] ? pitchInput.type : 'fastball';
  const loc0 = pitchInput.loc ?? pitchLocation(s, { ...pitchInput, type }, rng);
  const loc = { x: loc0.x, y: loc0.y, inZone: Math.abs(loc0.x) <= 1.5 && Math.abs(loc0.y) <= 1.5 };
  const fat = fatigue(s, pitcher);

  // スタミナ・投球数
  s.stamina[pitcher.id] = Math.max(0, (s.stamina[pitcher.id] ?? 0) - (type === 'fastball' ? 0.5 : 1));
  s.pitchCount[def] += 1;

  const bs = s.stats[batter.id];
  const ps = s.stats[pitcher.id];
  const pname = PITCH_TYPES[type].name;
  const event = {
    kind: 'ball', text: '', runs: 0, pitch: { type, zone: pitchInput.zone, loc },
    batter: batter.id, pitcher: pitcher.id, swing: !!batInput, outcome: null,
  };

  let outcome;
  if (!batInput) {
    outcome = loc.inZone ? 'strike' : 'ball';
  } else {
    const dist = Math.min(2, Math.max(Math.abs(batInput.zone.x - cellOf(loc.x)), Math.abs(batInput.zone.y - cellOf(loc.y))));
    const t = Math.abs(clamp(batInput.timing ?? 0, -1, 1));
    const band = t < 0.3 ? 0 : t < 0.6 ? 1 : 2;
    const probs = swingProbabilities(batter, pitcher, type, batInput.mode, dist, band, loc.inZone, fat);
    outcome = OUTCOMES[pickWeighted(probs, rng)];
    event.dist = dist;
    event.band = band;
  }
  event.outcome = outcome;
  const bases = s.bases;
  let runs = 0;

  switch (outcome) {
    case 'ball': {
      s.balls += 1;
      if (s.balls >= 4) {
        event.kind = 'walk';
        bs.bb += 1;
        runs = forceAdvance(bases);
        event.text = `フォアボール！ ${batter.name}は一塁へ。${runs ? '押し出しで1点！' : ''}`;
        addRuns(s, runs, batter);
        endPlateAppearance(s, event);
      } else {
        event.kind = 'ball';
        event.text = `${pname}、外れてボール。（${s.balls}-${s.strikes}）`;
      }
      break;
    }
    case 'strike': {
      s.strikes += 1;
      if (s.strikes >= 3) {
        event.kind = 'strikeout';
        bs.ab += 1; bs.so += 1; ps.k += 1;
        addOut(s);
        event.text = batInput ? `空振り三振！ ${pname}に${batter.name}のバットが空を切る！` : `見逃し三振！ ${pname}がズバッと決まった！`;
        endPlateAppearance(s, event);
      } else {
        event.kind = 'strike';
        event.text = batInput ? `空振り！ ${pname}。（${s.balls}-${s.strikes}）` : `${pname}、見逃しストライク。（${s.balls}-${s.strikes}）`;
      }
      break;
    }
    case 'foul': {
      if (s.strikes < 2) s.strikes += 1;
      event.kind = 'foul';
      event.text = `ファウル。（${s.balls}-${s.strikes}）`;
      break;
    }
    case 'groundout': {
      event.kind = 'out';
      bs.ab += 1;
      const dir = pickText(DIR_GROUND, rng);
      if (bases[0] && s.outs < 2 && rng() < TUNING.doublePlay) {
        // 併殺: 打者と一塁走者がアウト、他の走者は押し出し分のみ進塁
        addOut(s, 2);
        event.doublePlay = true;
        const nb = [false, false, false];
        if (bases[1]) nb[2] = true;
        if (bases[2]) {
          if (bases[1] && s.outs < 3) runs += 1; else nb[2] = true;
        }
        s.bases = nb;
        event.text = `${dir}ゴロ、ダブルプレー！`;
      } else {
        addOut(s);
        let scored = 0;
        if (s.outs < 3) {
          const nb = [...bases];
          if (nb[0]) {
            // 一塁走者は封殺進塁（打者アウト）
            scored = forceAdvance(nb);
            nb[0] = false;
          }
          s.bases = nb;
        }
        runs = scored;
        event.text = `${dir}ゴロ、アウト。${runs ? '三塁走者生還！' : ''}`;
      }
      addRuns(s, runs, batter, !event.doublePlay);
      endPlateAppearance(s, event);
      break;
    }
    case 'flyout': {
      event.kind = 'out';
      const dir = pickText(DIR_FLY, rng);
      const sac = bases[2] && s.outs < 2 && !DIR_FLY.slice(3).includes(dir);
      addOut(s);
      if (sac) {
        bases[2] = false;
        runs = 1;
        event.sacFly = true;
        event.text = `${dir}フライ、タッチアップ！ 犠牲フライで1点！`;
      } else {
        bs.ab += 1;
        event.text = `${dir}フライ、アウト。`;
      }
      addRuns(s, runs, batter);
      endPlateAppearance(s, event);
      break;
    }
    case 'single': case 'double': case 'triple': case 'hr': {
      event.kind = outcome === 'hr' ? 'hr' : 'hit';
      bs.ab += 1; bs.h += 1;
      s.hits[bat] += 1;
      const nb = [false, false, false];
      if (outcome === 'single') {
        if (bases[2]) runs += 1;
        if (bases[1]) { if (rng() < TUNING.singleScoreFrom2nd) runs += 1; else nb[2] = true; }
        if (bases[0]) nb[1] = true;
        nb[0] = true;
        event.text = `${batter.name}、${pickText(DIR_HIT, rng)}ヒット！`;
      } else if (outcome === 'double') {
        if (bases[2]) runs += 1;
        if (bases[1]) runs += 1;
        if (bases[0]) { if (rng() < TUNING.doubleScoreFrom1st) runs += 1; else nb[2] = true; }
        nb[1] = true;
        event.text = `${batter.name}、${pickText(DIR_LONG, rng)}を破るツーベース！`;
      } else if (outcome === 'triple') {
        runs += bases.filter(Boolean).length;
        nb[2] = true;
        event.text = `${batter.name}、${pickText(DIR_LONG, rng)}を深々と破るスリーベース！`;
      } else {
        runs += bases.filter(Boolean).length + 1;
        bs.hr += 1;
        const label = runs === 4 ? '満塁ホームラン' : runs === 1 ? 'ソロホームラン' : `${runs}ランホームラン`;
        event.text = `打ったー！ ${batter.name}、${label}！！`;
      }
      s.bases = nb;
      if (runs && outcome !== 'hr') event.text += ` ${runs}点追加！`;
      addRuns(s, runs, batter);
      endPlateAppearance(s, event);
      break;
    }
    default: break;
  }
  event.runs = runs;
  s.log.push(event);
  return { state: s, event };
}

/* ------------------------------------------------------------------ */
/* CPU 思考                                                            */
/* ------------------------------------------------------------------ */

/**
 * CPU 投手の配球
 * @param {object} state
 * @param {()=>number} [rng]
 * @returns {{type:string, zone:{x:number,y:number}, offset?:{x:number,y:number}}}
 */
export function choosePitch(state, rng = Math.random) {
  const pitcher = getPitcher(state);
  const pitches = pitcher.pitching?.pitches || [];
  const types = ['fastball', ...pitches.map((p) => p.type)];
  const weights = [45, ...pitches.map((p) => 10 + p.level * 6)];
  // 追い込んだら変化球を増やす
  if (state.strikes === 2) for (let i = 1; i < weights.length; i++) weights[i] *= 1.5;
  if (state.balls === 3) weights[0] *= 2;
  const type = types[pickWeighted(weights, rng)];
  const pt = PITCH_TYPES[type];
  const flip = pitcher.throws === '左' ? -1 : 1;
  let zone;
  const corners = state.strikes === 2 && state.balls <= 1 ? TUNING.cornerTwoStrike : state.balls === 3 ? TUNING.cornerThreeBall : TUNING.cornerBase;
  if (rng() < corners) {
    zone = { x: rng() < 0.5 ? 0 : 2, y: rng() < 0.5 ? 0 : 2 };
  } else if (state.balls === 3 && rng() < TUNING.centerThreeBall) {
    zone = { x: 1, y: 1 };
  } else {
    zone = { x: Math.floor(rng() * 3), y: Math.floor(rng() * 3) };
  }
  // ボール先行時は変化球の狙いを曲がりの逆側へ寄せてストライクを取りにいく（それ以外は曲げてボール球で誘う）
  if (state.balls === 3 || rng() < TUNING.breakAimFix) {
    if (Math.abs(pt.dx) >= 0.4) zone.x = clamp(zone.x - Math.sign(pt.dx * flip), 0, 2);
    if (pt.dy >= 0.6) zone.y = clamp(zone.y - 1, 0, 2);
  }
  const pitch = { type, zone };
  // 釣り球: 追い込んだら（またはときどき）コーナーからゾーン外へ狙いをずらす
  const waste = state.balls === 3 ? TUNING.wasteThreeBall : state.strikes === 2 ? TUNING.wasteTwoStrike : TUNING.wasteBase;
  if (rng() < waste) {
    const ox = zone.x === 1 ? 0 : (zone.x - 1) * TUNING.wasteOffset;
    const oy = zone.y === 1 ? TUNING.wasteOffset : (zone.y - 1) * TUNING.wasteOffset;
    pitch.offset = { x: ox, y: oy };
  }
  return pitch;
}

/**
 * CPU 打者のスイング判断
 * @param {object} state
 * @param {{type:string, zone:{x:number,y:number}, loc?:{x:number,y:number}}} pitch loc があれば実位置で判断、なければ予想位置
 * @param {()=>number} [rng]
 * @returns {null|{zone:{x:number,y:number}, mode:'meet'|'power', timing:number}}
 */
export function chooseSwing(state, pitch, rng = Math.random) {
  const T = TUNING;
  const batter = getBatter(state);
  const pitcher = getPitcher(state);
  const pt = PITCH_TYPES[pitch.type] || PITCH_TYPES.fastball;
  const flip = pitcher.throws === '左' ? -1 : 1;
  const off = pitch.offset || { x: 0, y: 0 };
  const loc = pitch.loc ?? { x: pitch.zone.x - 1 + (off.x || 0) + pt.dx * flip, y: pitch.zone.y - 1 + (off.y || 0) + pt.dy };
  const inZone = Math.abs(loc.x) <= 1.5 && Math.abs(loc.y) <= 1.5;
  const eye = (batter.contact - 50) / 200; // 選球眼
  // カウント別スイング率（平均でゾーン内 約75%・ゾーン外 約25%）
  const st = Math.min(2, state.strikes);
  let rate = inZone ? T.swingInZone[st] + eye : T.swingOutZone[st] - eye + (pt.read - 0.3) * 0.2;
  if (state.balls === 3) rate *= state.strikes === 0 ? 0.3 : state.strikes === 1 ? 0.8 : 1;
  if (rng() >= rate) return null;
  const noise = T.guessNoiseBase + ((100 - batter.contact) / 100) * T.guessNoiseContact;
  const zone = {
    x: clamp(Math.round(loc.x + gauss(rng) * noise) + 1, 0, 2),
    y: clamp(Math.round(loc.y + gauss(rng) * noise) + 1, 0, 2),
  };
  const v = velocityAbility(pitcher.pitching?.velocity ?? 135) / 99;
  const tSigma = T.timingBase + v * T.timingVel + ((100 - batter.contact) / 100) * T.timingContact + (pt.read - 0.15) * T.timingRead;
  const timing = clamp(gauss(rng) * tSigma, -1, 1);
  const mode = batter.power >= 75 && state.strikes < 2 && rng() < T.powerModeRate ? 'power' : 'meet';
  return { zone, mode, timing };
}

/* ------------------------------------------------------------------ */
/* 集計                                                                */
/* ------------------------------------------------------------------ */

/**
 * ボックススコア
 * @param {object} state
 * @returns {{innings:number[][], R:number[], H:number[], E:number[], mvp:object|null, pitchers:{win:object|null,lose:object|null,save:object|null}}}
 */
export function boxScore(state) {
  const s = state;
  const R = [total(s, 'away'), total(s, 'home')];
  const all = { ...Object.fromEntries(s.teams.away.players.map((p) => [p.id, ['away', p]])),
    ...Object.fromEntries(s.teams.home.players.map((p) => [p.id, ['home', p]])) };
  const getP = (id) => (id ? all[id]?.[1] ?? null : null);
  let win = null; let lose = null; let save = null;
  if (s.over && R[0] !== R[1] && s.decision) {
    win = s.decision.win;
    lose = s.decision.lose;
    const ws = R[0] > R[1] ? 'away' : 'home';
    const finisher = currentPitcherOf(s, ws).id;
    const entry = s.entries[finisher];
    if (finisher !== win && entry && entry.lead >= 1 && entry.lead <= 3) save = finisher;
  }
  const winSide = R[0] > R[1] ? 'away' : R[1] > R[0] ? 'home' : null;
  let mvp = null; let best = -Infinity;
  for (const id of Object.keys(all)) {
    const [side, p] = all[id];
    if (winSide && side !== winSide) continue;
    const st = s.stats[id];
    let sc = st.h + st.hr * 2 + st.rbi * 1.5 + st.bb * 0.3;
    if (p.pitching) sc += st.ip_outs / 3 * 0.8 + st.k * 0.4 - st.er * 1.2 + (id === win ? 2 : 0) + (id === save ? 1.5 : 0);
    if (st.ab === 0 && st.ip_outs === 0 && st.bb === 0) continue;
    if (sc > best) { best = sc; mvp = p; }
  }
  return {
    innings: [[...s.score.away], [...s.score.home]],
    R, H: [s.hits.away, s.hits.home], E: [s.errors.away, s.errors.home],
    mvp, pitchers: { win: getP(win), lose: getP(lose), save: getP(save) },
  };
}

/**
 * CPU 同士で1試合を最後まで進める（テスト・バランス検証用）
 * @param {object} homeTeam
 * @param {object} awayTeam
 * @param {()=>number} [rng]
 * @returns {object} 終了時の GameState
 */
export function simulateGame(homeTeam, awayTeam, rng = Math.random) {
  let s = createGame(homeTeam, awayTeam, { userSide: null });
  let guard = 0;
  while (!s.over && guard++ < 5000) {
    const pitch = choosePitch(s, rng);
    pitch.loc = pitchLocation(s, pitch, rng);
    const swing = chooseSwing(s, pitch, rng);
    s = resolvePitch(s, pitch, swing, rng).state;
  }
  return s;
}
