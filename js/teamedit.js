/**
 * オリジナルチーム編成画面（チームコスト制）
 * renderTeamEdit(el, ctx) → { handleKey(key), destroy() }
 * 保存先: localStorage 'dokidoki.myteam'。data.js のチームと同じ形のオブジェクト（id 'my'）を作る。
 */
import { TEAMS, rank } from './data.js';
import {
  TEAM_COST_CAP, ROSTER_SIZE, MIN_PITCHERS, MIN_CATCHERS, FIELD_POSITIONS,
  playerCost, costColor, overallOf, velScale, validateRoster, matchPositions, autoBuild,
} from './cost.js';

const STORE_KEY = 'dokidoki.myteam';
export const MY_TEAM_ID = 'my';
const COLORS = [
  ['#E5484D', 'あか'], ['#1E88E5', 'あお'], ['#43A047', 'みどり'],
  ['#F5A623', 'オレンジ'], ['#8E44AD', 'むらさき'], ['#EC407A', 'ピンク'],
];
const ROT_LABELS = ['先発①', '先発②', '中継ぎ①', '中継ぎ②', '中継ぎ③', '抑え'];
const ROT_ROLES = ['starter', 'starter', 'reliever', 'reliever', 'reliever', 'closer'];
const MAX_NAME = 12;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- プール ---------------- */
function poolList() {
  const out = [];
  const seen = new Set();
  for (const t of TEAMS) {
    for (const p of t.players) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ ...p, _team: { id: t.id, short: t.short, color: t.color, name: t.name } });
    }
  }
  return out;
}
const eligible = (p, pos) => !p.pitching && (p.positions || [p.pos]).includes(pos);

/* ---------------- 保存・読み込み ---------------- */
function readRaw() {
  try {
    const o = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return o && typeof o === 'object' ? o : null;
  } catch (e) { return null; }
}

/** 保存データ → チームオブジェクト（検証に失敗したら null） */
export function buildTeam(save) {
  try {
    if (!save || typeof save !== 'object') return null;
    const pool = new Map(poolList().map((p) => [p.id, p]));
    if (!Array.isArray(save.roster) || save.roster.length !== ROSTER_SIZE) return null;
    if (new Set(save.roster).size !== ROSTER_SIZE) return null;
    const roster = save.roster.map((id) => pool.get(id));
    if (roster.some((p) => !p)) return null;
    if (!validateRoster(roster).ok) return null;
    const inRoster = new Set(save.roster);
    const lu = save.lineup;
    if (!Array.isArray(lu) || lu.length !== 8) return null;
    const usedPos = new Set(); const usedId = new Set();
    for (const s of lu) {
      if (!s || !inRoster.has(s.id) || usedId.has(s.id) || usedPos.has(s.pos)) return null;
      if (!FIELD_POSITIONS.includes(s.pos) || !eligible(pool.get(s.id), s.pos)) return null;
      usedId.add(s.id); usedPos.add(s.pos);
    }
    const rot = save.rot;
    if (!Array.isArray(rot) || rot.length !== 6 || new Set(rot).size !== 6) return null;
    if (rot.some((id) => !inRoster.has(id) || !pool.get(id).pitching)) return null;

    const MY = (id) => `${MY_TEAM_ID}_${id}`;
    const clone = (p, patch) => {
      const { _team, ...rest } = p;
      return structuredClone({ ...rest, ...patch, id: MY(p.id) });
    };
    const players = [];
    const slotPos = Object.fromEntries(lu.map((s) => [s.id, s.pos]));
    const roleOf = Object.fromEntries(rot.map((id, i) => [id, ROT_ROLES[i]]));
    for (const p of roster) {
      if (p.pitching) players.push(clone(p, { pitching: { ...structuredClone(p.pitching), role: roleOf[p.id] || p.pitching.role } }));
      else players.push(clone(p, slotPos[p.id] ? { pos: slotPos[p.id] } : {}));
    }
    const rest = roster.filter((p) => !p.pitching && !usedId.has(p.id))
      .sort((a, b) => (eligible(b, '捕') - eligible(a, '捕')) || overallOf(b) - overallOf(a));
    const bench = rest.slice(0, 5).map((p) => MY(p.id));
    const name = String(save.name || '').trim().slice(0, MAX_NAME) || 'マイチーム';
    const color = COLORS.some(([c]) => c === save.color) ? save.color : COLORS[0][0];
    return {
      id: MY_TEAM_ID, name, short: [...name][0] || 'M', color,
      lineup: [...lu.map((s) => MY(s.id)), MY(rot[0])],
      pitchers: rot.map(MY),
      bench, players,
    };
  } catch (e) {
    return null;
  }
}

/** 保存されたオリジナルチーム（無効なら null） */
export function loadMyTeam() {
  return buildTeam(readRaw());
}

/* ---------------- 画面状態 ---------------- */
let S = null;
function initState() {
  const raw = readRaw() || {};
  const ids = new Set(poolList().map((p) => p.id));
  const roster = Array.isArray(raw.roster) ? [...new Set(raw.roster.filter((id) => ids.has(id)))].slice(0, ROSTER_SIZE) : [];
  S = {
    tab: 'pool', kind: 'all', pos: '', sort: 'cost', q: '',
    roster,
    lineup: Array.isArray(raw.lineup) ? raw.lineup.filter((s) => s && ids.has(s.id)) : [],
    rot: Array.isArray(raw.rot) ? raw.rot.filter((id) => ids.has(id)) : [],
    name: typeof raw.name === 'string' ? raw.name.slice(0, MAX_NAME) : 'マイチーム',
    color: COLORS.some(([c]) => c === raw.color) ? raw.color : COLORS[0][0],
    sel: { kind: 'bat', idx: 0 },
    msg: '', msgKind: '',
  };
}

export function renderTeamEdit(el, ctx) {
  if (!S) initState();
  const pool = poolList();
  const byId = new Map(pool.map((p) => [p.id, p]));
  const rosterPlayers = () => S.roster.map((id) => byId.get(id)).filter(Boolean);
  const totalCost = () => rosterPlayers().reduce((a, p) => a + playerCost(p), 0);
  let msgTimer = 0;
  let alive = true;

  const say = (text, kind = '') => {
    S.msg = text; S.msgKind = kind;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { S.msg = ''; const m = el.querySelector('.te-msg'); if (m) { m.textContent = ''; m.className = 'te-msg'; } }, 3200);
  };

  /* ----- 打順・投手の自動割り当て ----- */
  function lineupValid() {
    const ids = new Set(S.roster);
    if (S.lineup.length !== 8 || S.rot.length !== 6) return false;
    const up = new Set(); const ui = new Set();
    for (const s of S.lineup) {
      const p = byId.get(s.id);
      if (!p || !ids.has(s.id) || ui.has(s.id) || up.has(s.pos) || !eligible(p, s.pos)) return false;
      ui.add(s.id); up.add(s.pos);
    }
    if (up.size !== 8) return false;
    return new Set(S.rot).size === 6 && S.rot.every((id) => ids.has(id) && byId.get(id)?.pitching);
  }
  function autoLineup() {
    const rp = rosterPlayers();
    const fielders = rp.filter((p) => !p.pitching);
    const m = matchPositions(fielders);
    const slots = FIELD_POSITIONS.map((pos) => m[pos] && { pos, p: m[pos] }).filter(Boolean);
    const bat = (p) => p.contact * 1.0 + p.power * 0.8 + p.speed * 0.3;
    const sorted = [...slots].sort((a, b) => bat(b.p) - bat(a.p));
    const orderIdx = [1, 3, 0, 2, 4, 5, 6, 7];
    S.lineup = orderIdx.map((i) => sorted[i]).filter(Boolean).map((s) => ({ pos: s.pos, id: s.p.id }));
    const pit = rp.filter((p) => p.pitching);
    const used = new Set();
    const take = (pred, cmp) => {
      const c = pit.filter((p) => !used.has(p.id) && pred(p)).sort(cmp)[0] || pit.filter((p) => !used.has(p.id)).sort(cmp)[0];
      used.add(c.id); return c.id;
    };
    const stam = (a, b) => (b.pitching.stamina + overallOf(b)) - (a.pitching.stamina + overallOf(a));
    const ovr = (a, b) => overallOf(b) - overallOf(a);
    const sp1 = take((p) => p.pitching.role === 'starter', stam);
    const sp2 = take((p) => p.pitching.role === 'starter', stam);
    const cl = take((p) => p.pitching.role === 'closer', ovr);
    const r1 = take((p) => p.pitching.role !== 'starter', ovr);
    const r2 = take((p) => p.pitching.role !== 'starter', ovr);
    const r3 = take(() => true, ovr);
    S.rot = [sp1, sp2, r1, r2, r3, cl];
  }
  const ensureLineup = () => { if (!lineupValid()) autoLineup(); };

  /* ----- 描画 ----- */
  const costBadge = (c, cls = '') => {
    const col = costColor(c);
    return `<span class="cost-badge ${cls}" style="background:${col.bg};color:${col.fg}" title="コスト${c}">${c}</span>`;
  };
  const rb = (label, v) => `<span class="te-st"><i>${label}</i><span class="badge rank-${rank(v)}">${rank(v)}</span></span>`;
  const statBadges = (p) => (p.pitching
    ? rb('球速', velScale(p.pitching.velocity)) + rb('制球', p.pitching.control) + rb('体力', p.pitching.stamina)
    : rb('ミ', p.contact) + rb('パ', p.power) + rb('走', p.speed) + rb('守', p.fielding));
  const chips = (p, n = 2) => (p.skills || []).slice(0, n).map((s) => `<span class="chip te-chip">${esc(s)}</span>`).join('');
  const roleTag = (p) => (p.pitching ? ({ starter: '先発', reliever: '中継ぎ', closer: '抑え' }[p.pitching.role] || '投手') : '');
  const teamDot = (p) => `<span class="te-dot" style="background:${esc(p._team?.color || '#999')}" title="${esc(p._team?.name || '')}">${esc(p._team?.short || '')}</span>`;

  function filtered() {
    const q = S.q.trim();
    let list = pool.filter((p) => {
      if (S.kind === 'bat' && p.pitching) return false;
      if (S.kind === 'pit' && !p.pitching) return false;
      if (S.pos && !(p.positions || [p.pos]).includes(S.pos)) return false;
      if (q && !p.name.includes(q) && !(p.skills || []).some((s) => s.includes(q))) return false;
      return true;
    });
    list = list.sort(S.sort === 'cost'
      ? (a, b) => playerCost(b) - playerCost(a) || overallOf(b) - overallOf(a)
      : (a, b) => overallOf(b) - overallOf(a) || playerCost(b) - playerCost(a));
    return list;
  }

  function poolRowsHTML() {
    const sel = new Set(S.roster);
    const list = filtered();
    if (!list.length) return '<div class="te-empty">条件に合う選手がいません</div>';
    return list.map((p) => {
      const on = sel.has(p.id);
      return `<button class="te-row${on ? ' on' : ''}" data-nav data-col="0" data-fk="pool-${esc(p.id)}" data-add="${esc(p.id)}" aria-pressed="${on}">
        ${costBadge(playerCost(p))}${teamDot(p)}
        <span class="te-nm"><b>${esc(p.name)}</b><small>${p.pitching ? esc(roleTag(p)) : esc((p.positions || [p.pos]).join('・'))}${chips(p)}</small></span>
        <span class="te-sts">${statBadges(p)}</span>
        <span class="te-act">${on ? '✓' : '＋'}</span></button>`;
    }).join('');
  }

  function rosterHTML() {
    const rp = rosterPlayers();
    const fielders = rp.filter((p) => !p.pitching).sort((a, b) => FIELD_POSITIONS.indexOf(a.pos) - FIELD_POSITIONS.indexOf(b.pos) || overallOf(b) - overallOf(a));
    const pit = rp.filter((p) => p.pitching).sort((a, b) => ['starter', 'reliever', 'closer'].indexOf(a.pitching.role) - ['starter', 'reliever', 'closer'].indexOf(b.pitching.role) || overallOf(b) - overallOf(a));
    const row = (p) => {
      const c = playerCost(p); const col = costColor(c);
      return `<button class="te-row te-rrow" data-nav data-col="1" data-fk="ros-${esc(p.id)}" data-del="${esc(p.id)}" title="はずす">
        ${costBadge(c)}<span class="te-nm"><b>${esc(p.name)}</b><small>${p.pitching ? esc(roleTag(p)) : esc(p.pos)}</small></span>
        <span class="te-sts te-sts-s">${statBadges(p)}</span><span class="te-act">×</span>
        <span class="te-bar" style="width:${(c / 15) * 100}%;background:${col.bg}"></span></button>`;
    };
    return `${fielders.length ? `<div class="te-sec">野手 ${fielders.length}人</div>` : ''}${fielders.map(row).join('')}
      ${pit.length ? `<div class="te-sec">投手 ${pit.length}人</div>` : ''}${pit.map(row).join('')}
      ${rp.length ? '' : '<div class="te-empty">左の一覧から選手をえらぶか<br>「おまかせ編成」を押してください</div>'}`;
  }

  function summaryHTML() {
    const rp = rosterPlayers();
    const v = validateRoster(rp);
    const nP = rp.filter((p) => p.pitching).length;
    const nC = rp.filter((p) => !p.pitching && eligible(p, '捕')).length;
    const m = matchPositions(rp.filter((p) => !p.pitching));
    const posChips = FIELD_POSITIONS.map((pos) => `<span class="te-pos${m[pos] ? ' ok' : ''}">${pos}</span>`).join('');
    return `<div class="te-need">
        <span class="${rp.length === ROSTER_SIZE ? 'ok' : ''}">人数 ${rp.length}/${ROSTER_SIZE}</span>
        <span class="${nP >= MIN_PITCHERS ? 'ok' : ''}">投手 ${nP}/${MIN_PITCHERS}</span>
        <span class="${rp.some((p) => p.pitching?.role === 'closer') ? 'ok' : ''}">抑え</span>
        <span class="${nC >= MIN_CATCHERS ? 'ok' : ''}">捕手 ${nC}/${MIN_CATCHERS}</span>
      </div><div class="te-poschips">${posChips}</div>
      <ul class="te-errs">${v.ok ? '<li class="good">✓ このロスターで登録できます</li>' : v.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
  }

  function meterHTML() {
    const cost = totalCost();
    return `<div class="te-meter" role="status" aria-live="polite">
      <div class="te-meter-top"><span class="te-meter-lbl">チームコスト合計</span><span class="te-meter-num"><b>${cost}</b></span><span class="te-meter-note">（制限なし・目安）</span></div></div>`;
  }

  function poolTabHTML() {
    const kinds = [['all', '全員'], ['bat', '野手'], ['pit', '投手']];
    const sorts = [['cost', 'コスト順'], ['ovr', '総合順']];
    const poss = [['', 'すべて'], ...FIELD_POSITIONS.map((x) => [x, x]), ['投', '投']];
    const list = filtered();
    return `<div class="te-body">
      <section class="te-panel te-pool" aria-label="選手プール">
        <div class="te-filters">
          <div class="te-seg">${kinds.map(([k, l]) => `<button class="te-seg-btn${S.kind === k ? ' sel' : ''}" data-kind="${k}">${l}</button>`).join('')}</div>
          <div class="te-seg">${sorts.map(([k, l]) => `<button class="te-seg-btn${S.sort === k ? ' sel' : ''}" data-sort="${k}">${l}</button>`).join('')}</div>
          <label class="te-search"><span class="sr">名前でさがす</span><input type="search" data-fk="q" placeholder="名前でさがす" value="${esc(S.q)}" maxlength="12" autocomplete="off"></label>
        </div>
        <div class="te-poschips te-posfilter">${poss.map(([k, l]) => `<button class="te-posbtn${S.pos === k ? ' sel' : ''}" data-pos="${k}" aria-label="${k ? l + 'を守れる選手' : 'すべてのポジション'}">${l}</button>`).join('')}<span class="te-count">${list.length}人</span></div>
        <div class="te-scroll te-pool-list" data-scroll="0">${poolRowsHTML()}</div>
      </section>
      <section class="te-panel te-ros" aria-label="あなたの25人">
        <div class="te-ros-head"><h3>わたしの25人</h3>
          <button class="te-btn" data-act="auto" data-nav data-col="1" data-fk="auto">おまかせ編成</button>
          <button class="te-btn ghost" data-act="clear" data-nav data-col="1" data-fk="clear">ぜんぶ外す</button></div>
        <div class="te-summary">${summaryHTML()}</div>
        <div class="te-scroll te-ros-list" data-scroll="1">${rosterHTML()}</div>
      </section></div>`;
  }

  function lineupTabHTML() {
    const rp = rosterPlayers();
    const get = (id) => rp.find((p) => p.id === id);
    const slotRows = S.lineup.map((s, i) => {
      const p = get(s.id);
      const on = S.sel.kind === 'bat' && S.sel.idx === i;
      return `<div class="te-slot${on ? ' on' : ''}">
        <button class="te-slot-main" data-nav data-col="0" data-fk="slot-${i}" data-slot="bat:${i}"><span class="te-ord">${i + 1}</span><span class="te-pos ok big">${s.pos}</span>
          <span class="te-nm"><b>${esc(p?.name)}</b><small>${p ? esc((p.positions || []).join('・')) : ''}</small></span>${p ? costBadge(playerCost(p)) : ''}</button>
        <button class="te-mv" data-mv="${i}:-1" aria-label="${i + 1}番を上へ" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="te-mv" data-mv="${i}:1" aria-label="${i + 1}番を下へ" ${i === 7 ? 'disabled' : ''}>▼</button></div>`;
    }).join('');
    const sp = get(S.rot[0]);
    const pitchRow = `<div class="te-slot fixed"><div class="te-slot-main"><span class="te-ord">9</span><span class="te-pos ok big">投</span><span class="te-nm"><b>${esc(sp?.name)}</b><small>先発①が打席に立ちます</small></span></div></div>`;
    const rotRows = S.rot.map((id, i) => {
      const p = get(id); const on = S.sel.kind === 'pit' && S.sel.idx === i;
      return `<div class="te-slot${on ? ' on' : ''}"><button class="te-slot-main" data-nav data-col="1" data-fk="rot-${i}" data-slot="pit:${i}"><span class="te-role">${ROT_LABELS[i]}</span>
        <span class="te-nm"><b>${esc(p?.name)}</b><small>${p ? esc(`${p.pitching.velocity}km ・ ${p.throws}投`) : ''}</small></span>${p ? costBadge(playerCost(p)) : ''}</button></div>`;
    }).join('');

    let chooserTitle; let cands;
    if (S.sel.kind === 'bat') {
      const s = S.lineup[S.sel.idx];
      chooserTitle = `${S.sel.idx + 1}番・${s.pos}に入れる選手`;
      cands = rp.filter((p) => eligible(p, s.pos)).sort((a, b) => ((b.pos === s.pos) - (a.pos === s.pos)) || overallOf(b) - overallOf(a));
    } else {
      chooserTitle = `${ROT_LABELS[S.sel.idx]}にする投手`;
      cands = rp.filter((p) => p.pitching).sort((a, b) => overallOf(b) - overallOf(a));
    }
    const cur = S.sel.kind === 'bat' ? S.lineup[S.sel.idx].id : S.rot[S.sel.idx];
    const candRows = cands.map((p) => `<button class="te-row te-crow${p.id === cur ? ' on' : ''}" data-nav data-col="2" data-fk="cand-${esc(p.id)}" data-pick="${esc(p.id)}">
      ${costBadge(playerCost(p))}<span class="te-nm"><b>${esc(p.name)}</b><small>${p.pitching ? esc(roleTag(p)) : esc((p.positions || []).join('・'))}</small></span>
      <span class="te-sts te-sts-s">${statBadges(p)}</span><span class="te-act">${p.id === cur ? '✓' : ''}</span></button>`).join('');

    const swatches = COLORS.map(([c, n]) => `<button class="te-sw${S.color === c ? ' sel' : ''}" data-color="${c}" style="--c:${c}" aria-label="${n}" aria-pressed="${S.color === c}"></button>`).join('');
    return `<div class="te-body te-body3">
      <section class="te-panel"><h3>打順</h3><div class="te-slots">${slotRows}${pitchRow}</div></section>
      <section class="te-panel"><h3>投手陣</h3><div class="te-slots">${rotRows}</div>
        <p class="te-hint">左の枠を選んでから、右の一覧で選手を決めます。<br>▲▼で打順を入れ替えられます。</p></section>
      <section class="te-panel"><h3>${esc(chooserTitle)}</h3><div class="te-scroll te-cand" data-scroll="2">${candRows || '<div class="te-empty">該当する選手がいません</div>'}</div></section>
      <div class="te-strip">
        <label class="te-lbl" for="te-name">チーム名</label>
        <input id="te-name" class="te-name" data-fk="name" type="text" maxlength="${MAX_NAME}" value="${esc(S.name)}" autocomplete="off">
        <span class="te-lbl" id="te-colorlbl">チームカラー</span>
        <div class="te-sws" role="group" aria-labelledby="te-colorlbl">${swatches}</div>
        <button class="te-btn primary te-decide" data-act="decide" data-fk="decide">この内容で決定</button>
      </div></div>`;
  }

  function render() {
    if (!alive) return;
    const active = document.activeElement;
    const fk = active && el.contains(active) ? active.dataset.fk : null;
    const scrolls = [...el.querySelectorAll('[data-scroll]')].map((n) => [n.dataset.scroll, n.scrollTop]);
    const selStart = active && active.tagName === 'INPUT' ? active.selectionStart : null;
    const body = S.tab === 'pool' ? poolTabHTML() : lineupTabHTML();
    el.innerHTML = `<div class="teamedit" style="position:absolute;inset:0">
      <div class="team-header te-header">
        <button class="back-btn te-hbtn" data-act="back">もどる</button>
        <h2>オリジナルチーム</h2>
        ${meterHTML()}
        <button class="tab te-hbtn${S.tab === 'pool' ? ' active' : ''}" data-tab="pool">① 選手えらび</button>
        <button class="tab te-hbtn${S.tab === 'lineup' ? ' active' : ''}" data-tab="lineup">② 打順・投手</button>
        <button class="te-save te-hbtn" data-act="save">保存</button>
      </div>
      <div class="te-msg${S.msg ? ' show ' + S.msgKind : ''}" role="alert">${esc(S.msg)}</div>
      ${body}</div>`;
    bind();
    for (const [i, top] of scrolls) { const n = el.querySelector(`[data-scroll="${i}"]`); if (n) n.scrollTop = top; }
    if (fk) {
      const n = [...el.querySelectorAll('[data-fk]')].find((x) => x.dataset.fk === fk);
      if (n) {
        n.focus({ preventScroll: true });
        if (selStart != null && n.setSelectionRange) { try { n.setSelectionRange(selStart, selStart); } catch (e) { /* ignore */ } }
      }
    }
  }

  function updatePoolOnly() {
    const sc = el.querySelector('[data-scroll="0"]');
    if (!sc) return;
    sc.innerHTML = poolRowsHTML();
    sc.scrollTop = 0;
    const c = el.querySelector('.te-count'); if (c) c.textContent = `${filtered().length}人`;
    bindRows(sc);
  }

  /* ----- 操作 ----- */
  function toggle(id) {
    const i = S.roster.indexOf(id);
    if (i >= 0) S.roster.splice(i, 1);
    else if (S.roster.length >= ROSTER_SIZE) { say(`${ROSTER_SIZE}人までです。だれかを外してください`, 'bad'); }
    else S.roster.push(id);
  }
  function save() {
    const rp = rosterPlayers();
    const v = validateRoster(rp);
    if (!v.ok) { say(v.errors[0], 'bad'); return false; }
    ensureLineup();
    const name = S.name.trim() || 'マイチーム';
    S.name = name;
    const data = { v: 1, name, color: S.color, roster: [...S.roster], lineup: S.lineup.map((s) => ({ ...s })), rot: [...S.rot] };
    const team = buildTeam(data);
    if (!team) { say('チームを作れませんでした。編成を見直してください', 'bad'); return false; }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { say('保存できませんでした（このゲーム中のみ有効）', 'bad'); }
    ctx.setMyTeam?.(team);
    ctx.setUserTeam?.(MY_TEAM_ID);
    say(`「${name}」を保存しました。あなたのチームに設定しました`, 'good');
    return true;
  }
  function assign(id) {
    if (S.sel.kind === 'bat') {
      const idx = S.sel.idx; const slot = S.lineup[idx];
      const other = S.lineup.findIndex((s, i) => i !== idx && s.id === id);
      if (other >= 0) {
        const displaced = byId.get(slot.id);
        if (!eligible(displaced, S.lineup[other].pos)) {
          say(`${displaced.name}は${S.lineup[other].pos}を守れないので入れ替えできません`, 'bad'); return;
        }
        S.lineup[other].id = slot.id;
      }
      slot.id = id;
    } else {
      const idx = S.sel.idx; const other = S.rot.indexOf(id);
      if (other >= 0) S.rot[other] = S.rot[idx];
      S.rot[idx] = id;
    }
  }

  function bindRows(root) {
    root.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => { toggle(b.dataset.add); S.lastFk = b.dataset.fk; render(); }));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { toggle(b.dataset.del); render(); }));
  }

  function bind() {
    const q = (s) => el.querySelector(s);
    q('[data-act="back"]').onclick = () => (S.tab === 'lineup' ? ((S.tab = 'pool'), render()) : ctx.go('title'));
    q('[data-act="save"]').onclick = () => { save(); render(); };
    el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
      if (b.dataset.tab === 'lineup') {
        const v = validateRoster(rosterPlayers());
        if (!v.ok) { say(`先に25人を正しく編成してください：${v.errors[0]}`, 'bad'); render(); return; }
        ensureLineup();
        S.sel = { kind: 'bat', idx: 0 };
      }
      S.tab = b.dataset.tab; render();
    }));
    if (S.tab === 'pool') {
      el.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { S.kind = b.dataset.kind; render(); }));
      el.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => { S.sort = b.dataset.sort; render(); }));
      el.querySelectorAll('[data-pos]').forEach((b) => (b.onclick = () => { S.pos = b.dataset.pos; render(); }));
      const inp = q('input[data-fk="q"]');
      inp.oninput = () => { S.q = inp.value; updatePoolOnly(); };
      inp.onkeydown = (e) => { if (e.key === 'Escape') { inp.blur(); } };
      bindRows(el);
      q('[data-act="auto"]').onclick = () => {
        S.roster = autoBuild(pool).map((p) => p.id);
        const v = validateRoster(rosterPlayers());
        S.lineup = []; // 再生成
        say(v.ok ? `おまかせ編成：コスト${v.cost}で完成しました` : v.errors[0], v.ok ? 'good' : 'bad');
        render();
      };
      q('[data-act="clear"]').onclick = () => { S.roster = []; S.lineup = []; S.rot = []; say('ぜんぶ外しました'); render(); };
    } else {
      el.querySelectorAll('[data-slot]').forEach((b) => (b.onclick = () => {
        const [k, i] = b.dataset.slot.split(':'); S.sel = { kind: k, idx: Number(i) }; render();
      }));
      el.querySelectorAll('[data-mv]').forEach((b) => (b.onclick = () => {
        const [i, d] = b.dataset.mv.split(':').map(Number); const j = i + d;
        if (j < 0 || j > 7) return;
        [S.lineup[i], S.lineup[j]] = [S.lineup[j], S.lineup[i]];
        if (S.sel.kind === 'bat' && S.sel.idx === i) S.sel.idx = j;
        S.lastFk = `slot-${j}`;
        render();
        el.querySelector(`[data-fk="slot-${j}"]`)?.focus({ preventScroll: true });
      }));
      el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
        assign(b.dataset.pick); render();
        const fk = S.sel.kind === 'bat' ? `slot-${S.sel.idx}` : `rot-${S.sel.idx}`;
        el.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
      }));
      el.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => { S.color = b.dataset.color; render(); }));
      const nm = q('#te-name');
      nm.oninput = () => { S.name = nm.value.slice(0, MAX_NAME); };
      nm.onkeydown = (e) => { if (e.key === 'Escape' || e.key === 'Enter') nm.blur(); };
      q('[data-act="decide"]').onclick = () => { save(); render(); };
    }
  }

  /* ----- キー操作 ----- */
  function navEls() { return [...el.querySelectorAll('[data-nav]:not([disabled])')]; }
  function handleKey(key) {
    const act = document.activeElement;
    if (act && act.tagName === 'INPUT') return;
    if (key === 'esc' || key === 'x') {
      if (S.tab === 'lineup') { S.tab = 'pool'; render(); } else ctx.go('title');
      return;
    }
    const all = navEls();
    if (!all.length) return;
    let cur = all.indexOf(act);
    if (key === 'enter' && act && act.tagName === 'BUTTON') return; // ブラウザ標準のクリックに任せる
    if (key === 'z' || key === 'enter') {
      if (cur >= 0) act.click(); else all[0].focus();
      return;
    }
    if (cur < 0) { all[0].focus(); return; }
    const col = act.dataset.col;
    const same = all.filter((n) => n.dataset.col === col);
    const idx = same.indexOf(act);
    if (key === 'up') same[Math.max(0, idx - 1)].focus();
    else if (key === 'down') same[Math.min(same.length - 1, idx + 1)].focus();
    else if (key === 'left' || key === 'right') {
      const cols = [...new Set(all.map((n) => n.dataset.col))].sort();
      const ci = cols.indexOf(col) + (key === 'right' ? 1 : -1);
      if (ci < 0 || ci >= cols.length) return;
      const tgt = all.filter((n) => n.dataset.col === cols[ci]);
      // 打順/投手陣の選択中の枠に対応する一覧へ移るときは先頭へ
      (tgt[Math.min(idx, tgt.length - 1)] || tgt[0]).focus();
    }
  }

  render();
  return { handleKey, destroy() { alive = false; clearTimeout(msgTimer); } };
}
