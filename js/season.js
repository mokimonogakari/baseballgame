/**
 * ペナント画面（js/season-model.js の UI）
 *
 * renderSeason(el, ctx, payload) → { handleKey(key, e), destroy() }
 *   payload: { result: { day, gameId } }  自分の試合が終わった直後（結果を表示）
 * 画面: はじめる（チーム・試合数）→ ホーム（次の試合・試合前へ・おまかせ・まとめて進める）／順位／個人成績／チーム／日程／表彰
 * 自分の試合: 試合前画面（js/pregame.js）→ 試合画面（js/game.js）→ ctx.onGameOver で記録 → この画面へ戻る。
 */
import { TEAMS } from './data.js';
import { chibiHTML } from './screens.js';
import { renderPregame, spatialNav, esc, chip, roleName } from './pregame.js';
import {
  createSeason, loadSeason, saveSeason, clearSeason, SEASON_KEY, SEASON_LENGTHS, teamById, findPlayer, nextUserGame, gamesOnDay,
  standings, fmtPct, fmtGb, leaders, LEADER_KEYS, teamStats, playerRows, pitcherStatus, chooseStarter, userPlanFor, prepareMatch,
  recordGame, finishDay, simGame, advanceDay, playedCount, avgOf, obpOf, eraOf, fmtAvg, fmtEra, fmtIp, pa, isUserGame, qualifiers, lastDay,
} from './season-model.js';

let season;          // 読み込んだシーズン（undefined = まだ読んでいない）
let tab = 'home';
let teamView = null;
let teamSub = 'bat';
let setup = { teamId: null, length: 12 };

const rankOf = (s, tid) => standings(s).findIndex((r) => r.teamId === tid) + 1;
const tname = (id) => teamById(id)?.name ?? id;
const pname = (id) => findPlayer(id)?.name ?? '-';
const userGameNo = (s, g) => s.games.filter((x) => isUserGame(s, x) && (x.day < g.day || x === g)).length;
function shortStat(s, id) {
  const p = findPlayer(id);
  const st = s.stats[id];
  if (!p || !st) return '';
  if (p.pitching) return st.pg ? `${st.w}勝${st.l}敗${st.sv ? `${st.sv}S` : ''} 防${fmtEra(eraOf(st))}` : '登板なし';
  return st.ab ? `${fmtAvg(avgOf(st))} ${st.hr}本 ${st.rbi}点` : '';
}
function userOutcome(s, g) {
  const r = g.result;
  if (!r) return null;
  const mine = g.home === s.userTeamId ? r.hs : r.as;
  const theirs = g.home === s.userTeamId ? r.as : r.hs;
  return mine > theirs ? 'W' : mine < theirs ? 'L' : 'T';
}
const OUT_MARK = { W: '○', L: '●', T: '△' };
const OUT_TEXT = { W: '勝利！', L: '敗戦…', T: '引き分け' };

export function renderSeason(el, ctx, payload = {}) {
  let destroyed = false;
  let modal = null;     // { kind: 'result'|'summary'|'champion'|'confirm', ... }
  let busy = null;      // { label, done, total, cancel }
  let corrupt = false;
  if (season === undefined) {
    season = loadSeason();
    try { corrupt = !season && !!localStorage.getItem(SEASON_KEY); } catch (e) { corrupt = false; }
  }
  if (season && payload.result) {
    const g = season.games.find((x) => x.id === payload.result.gameId);
    if (g?.result) modal = { kind: 'result', games: [g], day: g.day, played: true };
  }
  if (season && !teamView) teamView = season.userTeamId;
  if (season && season.done && modal) modal.thenChampion = true;

  const save = () => { if (season) saveSeason(season); };

  /* ---------- 操作 ---------- */
  function startSeason() {
    if (!setup.teamId) return;
    season = createSeason({ userTeamId: setup.teamId, length: setup.length });
    teamView = season.userTeamId;
    tab = 'home';
    corrupt = false;
    save();
    render();
  }
  function abandon() {
    clearSeason();
    season = null;
    modal = null;
    tab = 'home';
    render();
  }
  function openPregame() {
    const g = nextUserGame(season);
    if (!g || g.day !== season.day) return;
    const team = teamById(season.userTeamId);
    const userHome = g.home === team.id;
    const opp = teamById(userHome ? g.away : g.home);
    const sug = chooseStarter(season, team.id);
    const s = season;
    ctx.go('pregame', {
      mode: 'season', team, opp, userHome,
      plan: userPlanFor(s, sug),
      caption: `ペナント 第${userGameNo(s, g)}戦／全${s.length}戦`,
      oppStarter: findPlayer(chooseStarter(s, opp.id)),
      suggestedStarter: sug,
      pitcherInfo: (id) => pitcherStatus(s, id),
      statsOf: (id) => shortStat(s, id),
      onStart(plan) {
        s.userPlan = plan;
        saveSeason(s);
        const m = prepareMatch(s, g, { userPlan: plan });
        const us = userHome ? 'home' : 'away';
        ctx.go('game', {
          match: {
            user: m[us], opp: m[userHome ? 'away' : 'home'], userHome, quitTo: 'season',
            onGameOver(state) {
              try {
                if (!g.result) recordGame(s, g, state, { starters: m.starters, by: 'user' });
                finishDay(s);
                saveSeason(s);
              } catch (e) { console.error(e); }
              ctx.go('season', { result: { day: g.day, gameId: g.id } });
            },
          },
        });
      },
      onBack() { ctx.go('season'); },
    });
  }

  /** シミュレーション（1 試合ずつ setTimeout で区切って UI を止めない） */
  function runSim(kind) {
    if (busy || !season || season.done) return;
    const s = season;
    const startDay = s.day;
    const before = s.games.filter((g) => g.result).length;
    const targetDays = kind === 'today' ? 1 : kind === 'days5' ? 5 : Infinity;
    const userGames = [];
    let days = 0;
    const totalGames = kind === 'end' ? s.games.filter((g) => !g.result).length : Math.min(s.games.filter((g) => !g.result).length, targetDays * 2);
    busy = { label: kind === 'today' ? 'おまかせで試合中…' : 'シミュレーション中…', done: 0, total: totalGames, cancel: false };
    render();
    const step = () => {
      if (destroyed) return;
      try {
        const open = gamesOnDay(s).filter((g) => !g.result);
        if (open.length) {
          const g = open[0];
          simGame(s, g);
          if (isUserGame(s, g)) userGames.push(g);
          busy.done = s.games.filter((x) => x.result).length - before;
        } else {
          advanceDay(s);
          days++;
          if (days >= targetDays || s.done || busy.cancel) {
            save();
            busy = null;
            if (kind === 'today' && userGames.length) modal = { kind: 'result', games: userGames, day: startDay, played: false };
            else modal = { kind: 'summary', games: userGames, days };
            if (s.done) modal.thenChampion = true;
            render();
            try { if (kind === 'today' && userGames.length) ctx.music?.play?.(userOutcome(s, userGames[0]) === 'W' ? 'result_win' : 'result_lose'); } catch (e) { /* ignore */ }
            return;
          }
        }
      } catch (e) {
        console.error(e);
        busy = null; save(); render();
        return;
      }
      updateBusy();
      setTimeout(step, 0);
    };
    setTimeout(step, 30);
  }

  /* ---------- 描画 ---------- */
  function updateBusy() {
    const b = el.querySelector('.sn-busy');
    if (!b || !busy) return;
    b.querySelector('.sn-busy-bar i').style.width = `${Math.round((busy.done / Math.max(1, busy.total)) * 100)}%`;
    b.querySelector('.sn-busy-n').textContent = `${busy.done} / ${busy.total} 試合`;
  }

  function setupHTML() {
    const saved = season;
    const teams = TEAMS.map((t) => `<button type="button" class="sn-team${setup.teamId === t.id ? ' sel' : ''}" data-team="${esc(t.id)}" style="--c:${esc(t.color)}" aria-pressed="${setup.teamId === t.id}">
      ${chip(t, 'big')}<span><b>${esc(t.name)}</b><small>${esc(teamBlurb(t))}</small></span></button>`).join('');
    const lens = SEASON_LENGTHS.map((n) => `<button type="button" class="sn-len${setup.length === n ? ' sel' : ''}" data-len="${n}" aria-pressed="${setup.length === n}"><b>${n}試合</b><small>${n === 12 ? 'さくっと' : n === 30 ? 'ほどよく' : 'じっくり'}（各カード${n / 3}試合）</small></button>`).join('');
    return `<div class="sn-setup" data-scroll>
      <h3>ペナントレースを始める</h3>
      ${corrupt ? '<p class="sn-note bad">保存データが壊れていたため読み込めませんでした。新しく始めてください。</p>' : ''}
      ${saved ? '' : ''}
      <div class="sn-setup-grid">
        <section><h4>① チームをえらぶ</h4><div class="sn-teams">${teams}</div></section>
        <section><h4>② 試合数</h4><div class="sn-lens">${lens}</div>
          <p class="sn-note">4球団の総当たり。自分の試合は遊ぶか「おまかせ」、ほかのカードは自動で進みます。先発投手は登板間隔が必要、疲れた投手はスタミナが減ります。</p>
          <button type="button" class="sn-go" data-act="begin"${setup.teamId ? '' : ' disabled'}>シーズン開始 ▶</button></section>
      </div></div>`;
  }

  function headerHTML() {
    const s = season;
    const tabs = s ? [['home', 'ホーム'], ['standings', '順位'], ['leaders', '個人成績'], ['team', 'チーム'], ['schedule', '日程'], ...(s.done ? [['awards', '表彰']] : [])] : [];
    let rec = '';
    if (s) {
      const st = standings(s).find((r) => r.teamId === s.userTeamId);
      rec = `<span class="sn-rec">${chip(teamById(s.userTeamId))}<b>${st.w}勝${st.l}敗${st.t ? `${st.t}分` : ''}</b><small>${rankOf(s, s.userTeamId)}位 ・ ${playedCount(s, s.userTeamId)}/${s.length}試合</small></span>`;
    }
    return `<div class="sn-header">
      <button type="button" class="back-btn sn-back" data-act="title">タイトル</button>
      <h2>ペナント</h2>${rec}
      <div class="sn-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" class="sn-tab${tab === k ? ' on' : ''}" data-tab="${k}" role="tab" aria-selected="${tab === k}">${l}</button>`).join('')}</div>
      ${s ? '<button type="button" class="sn-quit" data-act="quit">やめる</button>' : ''}
    </div>`;
  }

  function miniStandings() {
    const rows = standings(season).map((r, i) => `<tr class="${r.teamId === season.userTeamId ? 'me' : ''}"><td>${i + 1}</td><td class="tn">${chip(teamById(r.teamId))}<span class="tnm">${esc(teamById(r.teamId).name)}</span></td><td>${r.w}</td><td>${r.l}</td><td>${r.t}</td><td>${fmtPct(r.pct)}</td><td>${fmtGb(r.gb)}</td></tr>`).join('');
    return `<table class="sn-table sn-mini"><thead><tr><th>位</th><th class="tn">チーム</th><th>勝</th><th>敗</th><th>分</th><th>勝率</th><th>差</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function homeHTML() {
    const s = season;
    const recent = s.games.filter((g) => g.result && isUserGame(s, g)).slice(-5).reverse().map((g) => {
      const o = userOutcome(s, g);
      const opp = g.home === s.userTeamId ? g.away : g.home;
      const my = g.home === s.userTeamId ? g.result.hs : g.result.as;
      const th = g.home === s.userTeamId ? g.result.as : g.result.hs;
      return `<li class="o-${o}"><span class="mk">${OUT_MARK[o]}</span>第${userGameNo(s, g)}戦 vs ${chip(teamById(opp))}<b>${my} - ${th}</b><small>${g.result.by === 'user' ? 'プレイ' : 'おまかせ'}</small></li>`;
    }).join('') || '<li class="none">まだ試合をしていません</li>';
    let main;
    if (s.done) {
      const champ = teamById(s.awards.champion);
      const mine = s.awards.champion === s.userTeamId;
      main = `<div class="sn-card sn-final" style="--c:${esc(champ.color)}">
        <p class="sn-kicker">シーズン終了</p>
        <h3>${mine ? 'ペナント制覇！' : `優勝は ${esc(champ.name)}`}</h3>
        <p>${esc(teamById(s.userTeamId).name)}は ${rankOf(s, s.userTeamId)}位でした</p>
        <div class="sn-btns"><button type="button" class="sn-go" data-act="awards">表彰式を見る ▶</button>
        <button type="button" class="sn-btn" data-act="new">新しいシーズン</button></div></div>`;
    } else {
      const g = nextUserGame(s);
      const away = teamById(g.away); const home = teamById(g.home);
      const stA = findPlayer(chooseStarter(s, g.away)); const stH = findPlayer(chooseStarter(s, g.home));
      const fl = (p) => { const st = pitcherStatus(s, p.id, { starting: true }); return `<small>${esc(st.label)}${st.mul < 1 ? `・スタミナ${Math.round(st.mul * 100)}%` : ''}</small>`; };
      const others = gamesOnDay(s).filter((x) => x !== g).map((x) => `${chip(teamById(x.away))}<span>vs</span>${chip(teamById(x.home))}`).join(' ');
      main = `<div class="sn-card sn-next">
        <p class="sn-kicker">次の試合 ・ 第${userGameNo(s, g)}戦／全${s.length}戦 ・ ${g.day + 1}日目</p>
        <div class="sn-vs">
          <div class="sn-vt${g.away === s.userTeamId ? ' me' : ''}">${chip(away, 'big')}<b>${esc(away.name)}</b><small>先攻・ビジター</small></div>
          <span class="sn-vsx">VS</span>
          <div class="sn-vt${g.home === s.userTeamId ? ' me' : ''}">${chip(home, 'big')}<b>${esc(home.name)}</b><small>後攻・ホーム</small></div>
        </div>
        <p class="sn-probable">予告先発 <b>${esc(stA.name)}</b>${fl(stA)} <span>－</span> <b>${esc(stH.name)}</b>${fl(stH)}</p>
        <div class="sn-btns">
          <button type="button" class="sn-go" data-act="play">試合前へ（自分でプレイ）▶</button>
        </div>
        <div class="sn-btns sub">
          <button type="button" class="sn-btn" data-act="simToday">おまかせで試合</button>
          <button type="button" class="sn-btn" data-act="sim5">5日すすめる</button>
          <button type="button" class="sn-btn" data-act="simEnd">最後までおまかせ</button>
        </div>
        ${others ? `<p class="sn-others">同じ日のほかの試合 ${others}</p>` : ''}
      </div>`;
    }
    return `<div class="sn-home">${main}
      <div class="sn-card sn-side"><h4>順位</h4>${miniStandings()}<h4>最近の試合</h4><ul class="sn-recent">${recent}</ul></div></div>`;
  }

  function standingsHTML() {
    const s = season;
    const rows = standings(s).map((r, i) => `<tr class="${r.teamId === s.userTeamId ? 'me' : ''}"><td>${i + 1}</td><td class="tn">${chip(teamById(r.teamId))}${esc(teamById(r.teamId).name)}</td>
      <td>${r.g}</td><td>${r.w}</td><td>${r.l}</td><td>${r.t}</td><td><b>${fmtPct(r.pct)}</b></td><td>${fmtGb(r.gb)}</td><td>${r.rs}</td><td>${r.ra}</td><td>${esc(r.streak)}</td><td class="l5">${[...r.last5].map((c) => `<i class="o-${c}">${OUT_MARK[c]}</i>`).join('')}</td></tr>`).join('');
    const ts = teamStats(s).sort((a, b) => rankOf(s, a.teamId) - rankOf(s, b.teamId)).map((t) => `<tr class="${t.teamId === s.userTeamId ? 'me' : ''}"><td class="tn">${chip(teamById(t.teamId))}${esc(teamById(t.teamId).name)}</td>
      <td>${fmtAvg(t.avg)}</td><td>${t.hr}</td><td>${t.sb}</td><td>${t.rs}</td><td>${fmtEra(t.era)}</td><td>${t.k}</td><td>${t.ra}</td><td>${t.errors}</td></tr>`).join('');
    return `<div class="sn-scroll" data-scroll>
      <h4>順位表</h4>
      <div class="sn-tw"><table class="sn-table"><thead><tr><th>位</th><th class="tn">チーム</th><th>試合</th><th>勝</th><th>敗</th><th>分</th><th>勝率</th><th>ゲーム差</th><th>得点</th><th>失点</th><th>連続</th><th>直近5</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h4>チーム成績</h4>
      <div class="sn-tw"><table class="sn-table"><thead><tr><th class="tn">チーム</th><th>打率</th><th>本塁打</th><th>盗塁</th><th>得点</th><th>防御率</th><th>奪三振</th><th>失点</th><th>失策</th></tr></thead><tbody>${ts}</tbody></table></div>
      <p class="sn-note">勝率 = 勝 ÷（勝＋敗）。引き分けは勝率に数えません。ゲーム差 = 首位との（勝−敗）の差 ÷ 2。</p>
    </div>`;
  }

  function leadersHTML() {
    const s = season;
    const L = leaders(s, 5);
    const q = qualifiers(s, s.userTeamId);
    const cards = LEADER_KEYS.map(([k, label]) => {
      const rows = L[k].rows.map((r, i) => `<li class="${r.teamId === s.userTeamId ? 'me' : ''}"><span class="rk">${i + 1}</span>${chip(teamById(r.teamId))}<span class="nm">${esc(r.name)}</span><b>${esc(r.text)}</b></li>`).join('') || '<li class="none">該当者なし</li>';
      return `<div class="sn-lcard"><h5>${esc(label)}</h5><ol>${rows}</ol></div>`;
    }).join('');
    return `<div class="sn-scroll" data-scroll><div class="sn-leaders">${cards}</div>
      <p class="sn-note">打率は規定打席（チーム試合数×3.1 = 約${q.pa}打席）、防御率は規定投球回（チーム試合数×1 = 約${Math.round(q.outs / 3)}回）以上が対象。</p></div>`;
  }

  function teamHTML() {
    const s = season;
    const tid = teamView || s.userTeamId;
    const sel = s.teamIds.map((id) => `<button type="button" class="sn-tsel${id === tid ? ' on' : ''}" data-tview="${esc(id)}">${chip(teamById(id))}<span>${esc(teamById(id).name)}</span></button>`).join('');
    const rows = playerRows(s, tid);
    let table;
    if (teamSub === 'bat') {
      const body = rows.filter((r) => !r.player.pitching).map(({ player: p, s: st }) => `<tr><td class="tn">${esc(p.name)}</td><td>${esc(p.pos)}</td><td>${st.g}</td><td><b>${fmtAvg(avgOf(st))}</b></td><td>${pa(st)}</td><td>${st.ab}</td><td>${st.h}</td><td>${st.d2}</td><td>${st.d3}</td><td>${st.hr}</td><td>${st.rbi}</td><td>${st.sb}</td><td>${st.bb + st.hbp}</td><td>${st.so}</td><td>${fmtAvg(obpOf(st))}</td></tr>`).join('');
      table = `<table class="sn-table sn-pl"><thead><tr><th class="tn">選手</th><th>守</th><th>試合</th><th>打率</th><th>打席</th><th>打数</th><th>安打</th><th>二塁打</th><th>三塁打</th><th>本塁打</th><th>打点</th><th>盗塁</th><th>四死球</th><th>三振</th><th>出塁率</th></tr></thead><tbody>${body}</tbody></table>`;
    } else {
      const body = rows.filter((r) => r.player.pitching).map(({ player: p, s: st }) => {
        const ps = pitcherStatus(s, p.id);
        return `<tr><td class="tn">${esc(p.name)}</td><td>${esc(roleName(p))}</td><td>${st.pg}</td><td>${st.gs}</td><td>${st.w}</td><td>${st.l}</td><td>${st.sv}</td><td>${fmtIp(st.outs)}</td><td><b>${st.outs ? fmtEra(eraOf(st)) : '-'}</b></td><td>${st.k}</td><td>${st.ha}</td><td>${st.bba}</td><td>${st.hra}</td><td class="fat f-${ps.f < 30 ? 'ok' : ps.f < 60 ? 'mid' : 'low'}">${esc(ps.label)}${ps.restDays != null ? `<small>中${ps.restDays}日</small>` : ''}</td></tr>`;
      }).join('');
      table = `<table class="sn-table sn-pl"><thead><tr><th class="tn">投手</th><th>役割</th><th>登板</th><th>先発</th><th>勝</th><th>敗</th><th>S</th><th>投球回</th><th>防御率</th><th>奪三振</th><th>被安打</th><th>与四死球</th><th>被本塁打</th><th>疲労</th></tr></thead><tbody>${body}</tbody></table>`;
    }
    return `<div class="sn-scroll" data-scroll>
      <div class="sn-tsels">${sel}</div>
      <div class="sn-subtabs"><button type="button" class="sn-sub${teamSub === 'bat' ? ' on' : ''}" data-sub="bat">野手</button><button type="button" class="sn-sub${teamSub === 'pit' ? ' on' : ''}" data-sub="pit">投手</button></div>
      <div class="sn-tw">${table}</div></div>`;
  }

  function scheduleHTML() {
    const s = season;
    const days = [...new Set(s.games.map((g) => g.day))].sort((a, b) => a - b);
    const items = days.map((d) => {
      const gs = gamesOnDay(s, d).map((g) => {
        const r = g.result;
        const me = isUserGame(s, g);
        const sc = r ? `<b>${r.as} - ${r.hs}</b>` : '<span class="tbd">vs</span>';
        const o = me && r ? `<i class="o-${userOutcome(s, g)}">${OUT_MARK[userOutcome(s, g)]}</i>` : '';
        return `<span class="sn-sg${me ? ' me' : ''}">${o}${chip(teamById(g.away))}${sc}${chip(teamById(g.home))}</span>`;
      }).join('');
      const off = d > 0 && !days.includes(d - 1) ? '<span class="sn-off">移動日のあと</span>' : '';
      return `<li class="${d === s.day && !s.done ? 'today' : ''}${d < s.day ? ' past' : ''}" ${d === s.day ? 'data-today' : ''}><span class="sn-day">${d + 1}日目${off}</span>${gs}</li>`;
    }).join('');
    return `<div class="sn-scroll" data-scroll><h4>日程と結果 <small>（左が先攻、右が後攻。全${lastDay(s) + 1}日・移動日あり）</small></h4><ul class="sn-sched">${items}</ul></div>`;
  }

  function awardsHTML() {
    const s = season;
    const a = s.awards;
    if (!a) return '';
    const champ = teamById(a.champion);
    const mvp = a.mvp;
    const mvpT = mvp ? teamById(mvp.teamId) : null;
    const titles = a.titles.map((t) => `<div class="sn-award"><h5>${esc(t.label)}</h5>${t.winners.length ? t.winners.map((w) => `<p class="${w.teamId === s.userTeamId ? 'me' : ''}">${chip(teamById(w.teamId))}<span>${esc(w.name)}</span><b>${esc(w.text)}</b></p>`).join('') : '<p class="none">該当者なし</p>'}</div>`).join('');
    return `<div class="sn-scroll" data-scroll><div class="sn-awards">
      <div class="sn-champ" style="--c:${esc(champ.color)}"><p class="sn-kicker">優勝</p>${chip(champ, 'big')}<h3>${esc(champ.name)}</h3><p>${standings(s)[0].w}勝${standings(s)[0].l}敗${standings(s)[0].t ? `${standings(s)[0].t}分` : ''}</p></div>
      ${mvp ? `<div class="sn-mvp"><div class="face">${chibiHTML(mvpT.color, findPlayer(mvp.id)?.number ?? '', 0.62)}</div><div><p class="sn-kicker">最優秀選手（MVP）</p><h3>${esc(mvp.name)}</h3><p>${esc(mvpT.name)}</p><p class="ln">${esc(mvp.text)}</p></div></div>` : ''}
      <div class="sn-titles">${titles}</div>
    </div></div>`;
  }

  function modalHTML() {
    if (!modal) return '';
    const s = season;
    if (modal.kind === 'confirm') {
      return `<div class="sn-modal" role="dialog" aria-modal="true" aria-label="確認"><div class="sn-mcard">
        <h3>${esc(modal.title)}</h3><p>${esc(modal.text)}</p>
        <div class="sn-btns"><button type="button" class="sn-btn" data-act="mcancel">やめない</button><button type="button" class="sn-go danger" data-act="mok">${esc(modal.ok)}</button></div></div></div>`;
    }
    if (modal.kind === 'champion') {
      const champ = teamById(s.awards.champion);
      const mine = s.awards.champion === s.userTeamId;
      return `<div class="sn-modal champ" role="dialog" aria-modal="true" aria-label="優勝"><div class="sn-mcard sn-champcard" style="--c:${esc(champ.color)}">
        <div class="confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
        <p class="sn-kicker">ペナントレース 最終結果</p>
        <h3>${mine ? `${esc(champ.name)} 優勝！` : `優勝は ${esc(champ.name)}`}</h3>
        <div class="sn-champ-hero">${chibiHTML(champ.color, champ.players[0]?.number ?? 1, 0.9)}</div>
        <p>${mine ? 'おめでとう！ ペナント制覇！' : `${esc(teamById(s.userTeamId).name)}は${rankOf(s, s.userTeamId)}位。次こそ優勝だ！`}</p>
        <div class="sn-btns"><button type="button" class="sn-go" data-act="awards">表彰式へ ▶</button></div></div></div>`;
    }
    const games = modal.games || [];
    let body = '';
    if (modal.kind === 'result' && games.length) {
      const g = games[0];
      const r = g.result;
      const o = userOutcome(s, g);
      const away = teamById(g.away); const home = teamById(g.home);
      const n = Math.max(r.line[0].length, r.line[1].length, r.inn);
      const cells = (i) => Array.from({ length: n }, (_, k) => `<td>${r.line[i][k] ?? (i === 1 && r.line[0][k] !== undefined ? 'X' : '')}</td>`).join('');
      const others = gamesOnDay(s, g.day).filter((x) => x !== g && x.result).map((x) => `<span>${chip(teamById(x.away))}<b>${x.result.as} - ${x.result.hs}</b>${chip(teamById(x.home))}</span>`).join('');
      const st = standings(s).find((x) => x.teamId === s.userTeamId);
      body = `<p class="sn-kicker">第${userGameNo(s, g)}戦 ${modal.played ? '' : '（おまかせ）'}</p>
        <h3 class="o-${o}">${OUT_MARK[o]} ${OUT_TEXT[o]}</h3>
        <div class="sn-tw"><table class="sn-line"><thead><tr><th></th>${Array.from({ length: n }, (_, k) => `<th>${k + 1}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr></thead>
        <tbody><tr><th>${chip(away)}</th>${cells(0)}<td class="t">${r.as}</td><td class="t">${r.H[0]}</td><td class="t">${r.E[0]}</td></tr>
        <tr><th>${chip(home)}</th>${cells(1)}<td class="t">${r.hs}</td><td class="t">${r.H[1]}</td><td class="t">${r.E[1]}</td></tr></tbody></table></div>
        <p class="sn-pit"><span><i class="w">勝</i>${esc(r.w ? pname(r.w) : '-')}</span><span><i class="l">敗</i>${esc(r.l ? pname(r.l) : '-')}</span><span><i class="s">S</i>${esc(r.s ? pname(r.s) : '-')}</span>${r.mvp ? `<span><i class="m">MVP</i>${esc(pname(r.mvp))}</span>` : ''}</p>
        ${others ? `<p class="sn-others">この日のほかの試合 ${others}</p>` : ''}
        <p class="sn-now">${esc(teamById(s.userTeamId).name)} ${st.w}勝${st.l}敗${st.t ? `${st.t}分` : ''} ・ ${rankOf(s, s.userTeamId)}位${st.gb > 0 ? `（首位と${fmtGb(st.gb)}差）` : ''}</p>`;
    } else {
      const w = games.filter((g) => userOutcome(s, g) === 'W').length;
      const l = games.filter((g) => userOutcome(s, g) === 'L').length;
      const t = games.length - w - l;
      const list = games.slice(-8).map((g) => {
        const opp = g.home === s.userTeamId ? g.away : g.home;
        const my = g.home === s.userTeamId ? g.result.hs : g.result.as;
        const th = g.home === s.userTeamId ? g.result.as : g.result.hs;
        return `<li class="o-${userOutcome(s, g)}">${OUT_MARK[userOutcome(s, g)]} vs ${chip(teamById(opp))}<b>${my} - ${th}</b></li>`;
      }).join('');
      body = `<p class="sn-kicker">${modal.days}日すすめました</p><h3>${w}勝${l}敗${t ? `${t}分` : ''}</h3><ul class="sn-recent">${list}</ul>
        <p class="sn-now">${rankOf(s, s.userTeamId)}位 ・ ${playedCount(s, s.userTeamId)}/${s.length}試合</p>`;
    }
    return `<div class="sn-modal" role="dialog" aria-modal="true" aria-label="試合結果"><div class="sn-mcard" data-scroll>${body}
      <div class="sn-btns"><button type="button" class="sn-go" data-act="mclose">${modal.thenChampion ? '最終結果へ ▶' : 'つづける ▶'}</button></div></div></div>`;
  }

  function render() {
    if (destroyed) return;
    let body;
    if (!season) body = setupHTML();
    else if (tab === 'standings') body = standingsHTML();
    else if (tab === 'leaders') body = leadersHTML();
    else if (tab === 'team') body = teamHTML();
    else if (tab === 'schedule') body = scheduleHTML();
    else if (tab === 'awards' && season.done) body = awardsHTML();
    else { tab = 'home'; body = homeHTML(); }
    const busyHTML = busy ? `<div class="sn-modal busy"><div class="sn-mcard sn-busy"><h3>${esc(busy.label)}</h3><div class="sn-busy-bar"><i style="width:0%"></i></div><p class="sn-busy-n">0 / ${busy.total} 試合</p>
      ${busy.total > 2 ? '<button type="button" class="sn-btn" data-act="stop">とめる</button>' : ''}</div></div>` : '';
    el.innerHTML = `<div class="season">${headerHTML()}<div class="sn-body" data-scroll>${body}</div>${modalHTML()}${busyHTML}</div>`;
    bind();
    const first = el.querySelector('.sn-modal [data-act="mclose"], .sn-modal [data-act="mok"], .sn-modal [data-act="awards"], .sn-modal [data-act="stop"]')
      || el.querySelector('[data-act="play"], [data-act="begin"]:not([disabled]), [data-act="awards"]');
    first?.focus({ preventScroll: true });
    if (tab === 'schedule') el.querySelector('[data-today]')?.scrollIntoView?.({ block: 'center' });
  }

  function bind() {
    const on = (sel, fn) => el.querySelectorAll(sel).forEach((b) => (b.onclick = fn));
    on('[data-act="title"]', () => ctx.go('title'));
    on('[data-tab]', (e) => { tab = e.currentTarget.dataset.tab; render(); });
    on('[data-team]', (e) => { setup.teamId = e.currentTarget.dataset.team; render(); });
    on('[data-len]', (e) => { setup.length = Number(e.currentTarget.dataset.len); render(); });
    on('[data-act="begin"]', startSeason);
    on('[data-act="quit"]', () => { modal = { kind: 'confirm', title: 'このシーズンをやめますか？', text: 'これまでの成績は消えます（元に戻せません）。', ok: 'やめる', onOk: abandon }; render(); });
    on('[data-act="new"]', () => { modal = { kind: 'confirm', title: '新しいシーズンを始めますか？', text: '今のシーズンの記録は消えます。', ok: '新しく始める', onOk: abandon }; render(); });
    on('[data-act="mcancel"]', () => { modal = null; render(); });
    on('[data-act="mok"]', () => { const f = modal?.onOk; modal = null; f?.(); });
    on('[data-act="mclose"]', () => { modal = modal?.thenChampion ? { kind: 'champion' } : null; render(); });
    on('[data-act="awards"]', () => { modal = null; tab = 'awards'; render(); });
    on('[data-act="play"]', openPregame);
    on('[data-act="simToday"]', () => runSim('today'));
    on('[data-act="sim5"]', () => runSim('days5'));
    on('[data-act="simEnd"]', () => runSim('end'));
    on('[data-act="stop"]', () => { if (busy) { busy.cancel = true; const b = el.querySelector('[data-act="stop"]'); if (b) { b.disabled = true; b.textContent = 'この日の試合のあと止めます'; } } });
    on('[data-tview]', (e) => { teamView = e.currentTarget.dataset.tview; render(); });
    on('[data-sub]', (e) => { teamSub = e.currentTarget.dataset.sub; render(); });
  }

  render();
  if (modal?.kind === 'result' && modal.played) {
    try { ctx.music?.play?.(userOutcome(season, modal.games[0]) === 'W' ? 'result_win' : 'result_lose'); } catch (e) { /* ignore */ }
  }

  return {
    handleKey(key, e) {
      if (busy) return;
      if (['up', 'down', 'left', 'right'].includes(key)) {
        e?.preventDefault();
        spatialNav(el.querySelector('.sn-modal') || el, key);
        return;
      }
      if (key === 'z') {
        const a = document.activeElement;
        if (a && el.contains(a) && a.tagName === 'BUTTON') { e?.preventDefault(); a.click(); }
        return;
      }
      if (key === 'esc' || key === 'x') {
        e?.preventDefault();
        if (modal) {
          if (modal.kind === 'confirm') modal = null;
          else if (modal.kind === 'champion') { modal = null; tab = 'awards'; }
          else modal = modal.thenChampion ? { kind: 'champion' } : null;
          render();
        } else if (tab !== 'home' && season) { tab = 'home'; render(); }
        else ctx.go('title');
      }
    },
    destroy() { destroyed = true; if (busy) busy.cancel = true; },
  };
}

/** 試合前画面（pregame.js）をこのモジュール経由で使う画面名 'pregame' 用 */
export { renderPregame };

function teamBlurb(t) {
  return { red: '現役スター軍・バランス型', blue: 'メジャー級の剛腕と強打', green: '昭和の名選手・投手王国', yellow: '平成の名手・堅守と機動力' }[t.id] || '';
}
