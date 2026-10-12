import { rank, RANK_COLORS } from './data.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function chibiHTML(color, number, scale = 1) {
  return `<div class="chibi" style="--team:${esc(color)};--chibi:${scale}">
    <div class="chibi-head">
      <div class="chibi-cap"><span class="chibi-cap-button"></span></div>
      <span class="chibi-brim"></span>
      <span class="chibi-eye l"><span class="chibi-shine"></span></span>
      <span class="chibi-eye r"><span class="chibi-shine"></span></span>
      <span class="chibi-cheek l"></span><span class="chibi-cheek r"></span>
      <span class="chibi-mouth"></span>
    </div>
    <div class="chibi-body">${esc(number ?? '')}</div>
    <span class="chibi-arm"></span>
    <div class="chibi-legs"><i></i><i></i></div>
  </div>`;
}

/** MVPの成績行。投手として投げていれば投球成績、それ以外は打撃成績 */
function mvpStatLine(p, s) {
  const outs = s.ip_outs ?? 0;
  if (p.pitching && outs > 0) {
    const ip = `${Math.floor(outs / 3)}${outs % 3 ? ` ${outs % 3}/3` : ''}回`;
    return `${ip} ${s.k ?? 0}奪三振 ${s.er ?? 0}自責点`;
  }
  return `${s.ab ?? 0}打数 ${s.h ?? 0}安打 ${s.hr ?? 0}本塁打 ${s.rbi ?? 0}打点`;
}

const badge = (label, v) => `<span class="badge rank-${rank(v)}">${esc(label)}</span>`;
const velScale = (kmh) => clamp(Math.round((kmh - 120) / 40 * 98 + 1), 1, 99);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function overallOf(p) {
  if (p.pitching) {
    const pi = p.pitching;
    return Math.round(avg([velScale(pi.velocity), pi.control, pi.stamina]));
  }
  return Math.round(avg([p.contact, p.power, p.speed, p.arm, p.fielding]));
}

/* タイトルは title.js */
export { renderTitle } from './title.js';

/* ---------------- Team ---------------- */
let teamTab = 'players';
let selectedId = null;

export function renderTeam(el, ctx) {
  const team = ctx.teams.find((t) => t.id === ctx.userTeamId) || ctx.teams[0];
  const byId = new Map(team.players.map((p) => [p.id, p]));
  const lineup = team.lineup.map((id) => byId.get(id)).filter(Boolean);
  const pitchers = team.pitchers.map((id) => byId.get(id)).filter(Boolean);
  const showPitchers = teamTab === 'pitchers';
  const list = showPitchers ? pitchers : lineup;
  if (!list.some((p) => p.id === selectedId)) selectedId = list[0] && list[0].id;
  const sel = list.find((p) => p.id === selectedId);

  const head = showPitchers
    ? ['順', '名前', '球速', 'コントロール', 'スタミナ', '球種数']
    : ['順', '名前', '弾道', 'ミート', 'パワー', '走力'];
  const rows = list.map((p, i) => {
    const cells = showPitchers
      ? [badge(rank(velScale(p.pitching.velocity)), velScale(p.pitching.velocity)), badge(rank(p.pitching.control), p.pitching.control), badge(rank(p.pitching.stamina), p.pitching.stamina), badge(p.pitching.pitches.length, p.pitching.pitches.length * 25)]
      : [badge(p.trajectory, p.trajectory * 25), badge(rank(p.contact), p.contact), badge(rank(p.power), p.power), badge(rank(p.speed), p.speed)];
    return `<button class="row${p.id === selectedId ? ' selected' : ''}" data-id="${esc(p.id)}">
      <span class="order">${i + 1}</span><span class="nm">${esc(p.name)}<small>${esc(p.pos)}</small></span>${cells.join('')}</button>`;
  }).join('');

  el.innerHTML = `<div class="team" style="position:absolute;inset:0">
    <div class="team-header">
      <button class="back-btn" data-act="back">もどる</button>
      <h2>${esc(team.name)}</h2>
      <button class="tab${teamTab === 'players' ? ' active' : ''}" data-tab="players">選手一覧</button>
      <button class="tab${teamTab === 'lineup' ? ' active' : ''}" data-tab="lineup">打順</button>
      <button class="tab${teamTab === 'pitchers' ? ' active' : ''}" data-tab="pitchers">投手陣</button>
      <span class="spacer"></span>
    </div>
    <div class="team-body">
      <div class="roster">
        <div class="roster-head">${head.map((h) => `<span>${h}</span>`).join('')}</div>
        ${rows}
      </div>
      ${sel ? cardHTML(sel, team) : '<div class="player-card"></div>'}
    </div>
  </div>`;

  el.querySelector('[data-act="back"]').onclick = () => ctx.go('title');
  el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { teamTab = b.dataset.tab; selectedId = null; renderTeam(el, ctx); }));
  el.querySelectorAll('.row').forEach((b) => (b.onclick = () => { selectedId = b.dataset.id; renderTeam(el, ctx); }));
  const sw = el.querySelector('[data-act="switch"]');
  if (sw) sw.onclick = () => {
    const i = ctx.teams.findIndex((t) => t.id === team.id);
    const other = ctx.teams[(i + 1) % ctx.teams.length] || team;
    ctx.setUserTeam(other.id);
    selectedId = null;
    renderTeam(el, ctx);
  };
  const pl = el.querySelector('[data-act="play"]');
  if (pl) pl.onclick = () => ctx.go('game');
}

function cardHTML(p, team) {
  const ov = overallOf(p);
  const pi = p.pitching;
  const tiles = pi
    ? [['球速', rank(velScale(pi.velocity)), `${pi.velocity}km`], ['制球', rank(pi.control), pi.control], ['スタミナ', rank(pi.stamina), pi.stamina], ['球種数', rank(pi.pitches.length * 25), pi.pitches.length], ['肩力', rank(p.arm), p.arm], ['守備', rank(p.fielding), p.fielding], ['捕球', rank(p.catching), p.catching]]
    : [['弾道', rank(p.trajectory * 25), p.trajectory], ['ミート', rank(p.contact), p.contact], ['パワー', rank(p.power), p.power], ['走力', rank(p.speed), p.speed], ['肩力', rank(p.arm), p.arm], ['守備', rank(p.fielding), p.fielding], ['捕球', rank(p.catching), p.catching]];
  const tileHTML = tiles.map(([l, r, n]) => `<div class="ability-tile"><span class="lbl">${l}</span><span class="badge rank-${r}">${r}</span><span class="num">${esc(n)}</span></div>`).join('');
  const st = p.stats || {};
  const sv = (k) => (st[k] === undefined || st[k] === null ? '-' : esc(st[k]));
  const stats = pi
    ? [['防御率', 'era'], ['勝', 'w'], ['敗', 'l'], ['S', 'sv'], ['奪三振', 'k']]
    : [['打率', 'avg'], ['本塁打', 'hr'], ['打点', 'rbi'], ['盗塁', 'sb'], ['出塁率', 'obp']];
  const legend = [['S', '90+'], ['A', '80'], ['B', '70'], ['C', '60'], ['D', '50'], ['E', '40'], ['F', '20'], ['G', '1']]
    .map(([r, t]) => `<span><span class="badge rank-${r}">${r}</span>${t}</span>`).join('');
  return `<div class="player-card">
    <div class="card-top">
      <div class="face-box">${chibiHTML(team.color, p.number, 0.8)}</div>
      <div class="card-info">
        <div><span class="pos-pill">${esc(p.pos)}</span><span class="card-meta">背番号 ${esc(p.number)} ・ ${esc(p.throws)}投${esc(p.bats)}打 ・ ${esc(p.age)}歳</span></div>
        <h2>${esc(p.name)}</h2>
        <div class="chips">${(p.skills || []).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
        ${p.model ? `<p class="model-text">${esc(p.model)}</p>` : ''}
      </div>
      <div class="overall rank-${rank(ov)}" style="${RANK_COLORS[rank(ov)] ? '' : ''}">${rank(ov)}<small>総合 ${ov}</small></div>
    </div>
    <div class="ability-grid">${tileHTML}</div>
    <div class="legend">${legend}</div>
    <div class="stat-tiles">${stats.map(([l, k]) => `<div class="stat-tile"><div class="lbl">${l}</div><div class="val">${sv(k)}</div></div>`).join('')}</div>
    <div class="card-actions">
      <button class="btn" data-act="switch">チームを切り替え</button>
      <button class="btn primary" data-act="play">このチームで試合</button>
    </div>
  </div>`;
}

/* ---------------- Result ---------------- */
export function renderResult(el, ctx, box, state) {
  const away = state.teams.away, home = state.teams.home;
  const ra = box.R[0], rh = box.R[1];
  const headline = ra === rh ? '引き分け' : `${(ra > rh ? away : home).name}の勝利！`;
  const n = Math.max(9, box.innings[0].length, box.innings[1].length);
  const cols = Array.from({ length: n }, (_, i) => i);
  const cell = (side, i) => {
    const v = box.innings[side][i];
    if (v === undefined || v === null) return side === 1 && box.innings[0][i] !== undefined ? 'X' : '';
    return esc(v);
  };
  const line = (t, side) => `<div class="ls-row"><span class="tn">${esc(t.name)}</span>${cols.map((i) => `<span>${cell(side, i)}</span>`).join('')}<span class="tot">${box.R[side]}</span><span class="tot">${box.H[side]}</span><span class="tot">${box.E[side]}</span></div>`;

  const mvp = box.mvp;
  let mvpHTML = '<div class="mvp"></div>';
  if (mvp) {
    const s = (state.stats && state.stats[mvp.id]) || {};
    const t = away.players.some((p) => p.id === mvp.id) ? away : home;
    mvpHTML = `<div class="mvp"><div class="face">${chibiHTML(t.color, mvp.number, 0.7)}</div>
      <div><div class="tag">MVP</div><div class="nm">${esc(mvp.name)}</div>
      <div class="st">${mvpStatLine(mvp, s)}</div></div></div>`;
  }
  const pn = (p) => (p ? esc(p.name) : '-');
  const pr = box.pitchers || {};

  el.innerHTML = `<div class="result" style="position:absolute;inset:0">
    <div class="result-kicker">GAME SET</div>
    <h1>${esc(headline)}</h1>
    <div class="score-row">
      <span class="tb" style="background:${esc(away.color)}">${esc(away.short)}</span>
      <span class="num">${ra}</span><span class="dash">-</span><span class="num">${rh}</span>
      <span class="tb" style="background:${esc(home.color)}">${esc(home.short)}</span>
    </div>
    <div class="linescore" style="--cols:${n}">
      <div class="ls-row head"><span></span>${cols.map((i) => `<span>${i + 1}</span>`).join('')}<span>R</span><span>H</span><span>E</span></div>
      ${line(away, 0)}${line(home, 1)}
    </div>
    ${mvpHTML}
    <div class="pitchers">
      <div class="prow"><span class="badge w">勝</span>${pn(pr.win)}</div>
      <div class="prow"><span class="badge l">敗</span>${pn(pr.lose)}</div>
      <div class="prow"><span class="badge s">S</span>${pn(pr.save)}</div>
    </div>
    <div class="result-btns">
      <button class="btn" data-act="again">もう一度あそぶ</button>
      <button class="btn white" data-act="team">チームを見る</button>
      <button class="btn dark" data-act="title">タイトルへ</button>
    </div>
  </div>`;
  el.querySelector('[data-act="again"]').onclick = () => ctx.go('game');
  el.querySelector('[data-act="team"]').onclick = () => ctx.go('team');
  el.querySelector('[data-act="title"]').onclick = () => ctx.go('title');
}

/* ---------------- Settings ---------------- */
// help: 選択中の項目の説明（1行）。tab: 'play'（試合・操作） | 'sound'（おと）
const SET_GROUPS = [
  { tab: 'play', key: 'innings', label: 'イニング（試合の長さ）', opts: [[3, '3回'], [6, '6回'], [9, '9回']],
    help: { 3: 'さくっと短い試合', 6: 'ちょうどいい長さ', 9: 'じっくり本格的に' } },
  { tab: 'play', key: 'difficulty', label: 'むずかしさ', opts: [['easy', 'かんたん'], ['normal', 'ふつう'], ['hard', 'むずかしい']],
    help: { easy: '球が遅く、通過位置が見える', normal: 'ふつうの速さ', hard: '球が速い' } },
  { tab: 'play', key: 'battingAssist', label: '打撃アシスト', cls: 'seg-5', opts: [['auto', '自動'], [0, 'なし'], [1, 'よわめ'], [2, 'つよめ'], [3, 'さいだい']],
    help: { auto: 'スマホはつよめ、キーボードはなし', 0: 'ぜんぶ自分のタイミング', 1: 'ちょっとだけ助けてくれる', 2: 'ミートしやすくなる', 3: 'ほとんど当たる！' } },
  { tab: 'play', key: 'pitchMode', label: '投球', opts: [['manual', '自分で投げる'], ['cpu', 'CPUにまかせる']],
    help: { manual: 'コースと球種を自分で選ぶ', cpu: '守備のときはCPUが投げる（打撃に集中）' } },
  { tab: 'play', key: 'fieldMode', label: '守備', cls: 'seg-3', opts: [['manual', '自分で'], ['assist', 'アシスト'], ['auto', 'オート']],
    help: { manual: '追う・捕る・投げるを全部自分で', assist: '追球はおまかせ、送球だけ選ぶ', auto: '守備は全部おまかせ' } },
  { tab: 'play', key: 'cursorSpeed', label: 'カーソル速度', cls: 'seg-vol', opts: [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']],
    help: { 1: 'ゆっくり（正確に動かせる）', 2: 'ややゆっくり', 3: 'ふつう', 4: 'ややはやい', 5: 'とてもはやい' } },
  { tab: 'sound', key: 'sound', label: '効果音', opts: [[true, 'オン'], [false, 'オフ']], help: { true: 'ヒット音や歓声が鳴る', false: '効果音を消す' } },
  { tab: 'sound', key: 'music', label: 'BGM', opts: [[true, 'オン'], [false, 'オフ']], help: { true: '音楽が流れる', false: '音楽を消す' } },
  { tab: 'sound', key: 'musicVolume', label: 'BGM 音量', cls: 'seg-vol', opts: [[0.2, '1'], [0.4, '2'], [0.6, '3'], [0.8, '4'], [1, '5']], help: {} },
];
let setTab = 'play';

function curVal(g, cur) {
  if (g.key === 'battingAssist') return [0, 1, 2, 3].includes(cur.battingAssist) ? cur.battingAssist : 'auto';
  if (g.key === 'musicVolume') {
    const v = g.opts.find(([x]) => Math.abs((cur.musicVolume ?? 0.7) - x) < 0.1);
    return v ? v[0] : 0.6;
  }
  if (g.key === 'cursorSpeed') return cur.cursorSpeed ?? 3;
  return cur[g.key];
}

export function renderSettings(el, ctx) {
  const cur = ctx.settings || {};
  const groups = SET_GROUPS.filter((g) => g.tab === setTab).map((g) => {
    const v = curVal(g, cur);
    return `<div class="set-group"><h3>${g.label}</h3><div class="seg${g.cls ? ' ' + g.cls : ''}">${g.opts.map(([x, l]) =>
      `<button class="seg-btn${x === v ? ' selected' : ''}" data-key="${g.key}" data-val="${esc(x)}">${l}</button>`).join('')}</div>
      <p class="set-help">${esc(g.help[v] || '')}</p></div>`;
  }).join('');
  el.innerHTML = `<div class="settings" style="position:absolute;inset:0">
    <div class="settings-header"><button class="back-btn" data-act="back">もどる</button><h2>せってい</h2>
      <div class="set-tabs"><button class="tab${setTab === 'play' ? ' active' : ''}" data-tab="play">試合・操作</button><button class="tab${setTab === 'sound' ? ' active' : ''}" data-tab="sound">おと</button></div></div>
    <div class="settings-body set-${setTab}">${groups}${setTab === 'sound' ? '<button class="set-test" data-act="test">テスト再生</button>' : ''}</div>
  </div>`;
  el.querySelector('[data-act="back"]').onclick = () => ctx.go('title');
  el.querySelector('[data-act="test"]')?.addEventListener('click', () => ctx.sound && ctx.sound.play('hit'));
  el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { setTab = b.dataset.tab; renderSettings(el, ctx); }));
  el.querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => {
    const key = b.dataset.key;
    const raw = b.dataset.val;
    let val;
    if (key === 'innings' || key === 'cursorSpeed' || key === 'musicVolume') val = Number(raw);
    else if (key === 'sound' || key === 'music') val = raw === 'true';
    else if (key === 'battingAssist') val = raw === 'auto' ? null : Number(raw);
    else val = raw;
    ctx.saveSettings({ [key]: val });
    renderSettings(el, ctx);
    if (key === 'sound' && val) ctx.sound.play('select');
  }));
}
