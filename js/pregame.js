/**
 * 試合前画面（対戦モード・ペナント共通）: 打順・守備位置・先発投手・控えを決める
 *
 * renderPregame(el, ctx, opts) → { handleKey(key, e), destroy() }
 * opts = {
 *   mode: 'exhibition' | 'season',
 *   team, opp,              // data.js 形式のチーム（自分・相手）
 *   userHome: boolean,      // 自分が後攻か
 *   plan,                   // 初期オーダー（js/lineup.js の plan）
 *   caption: string,        // 見出しの補足（例: 'ペナント 第3戦'）
 *   oppStarter?: Player,    // 相手の予告先発
 *   pitcherInfo?(id) → { f, label, restDays, rest, reason, mul } | null   // ペナント: 疲労・登板間隔
 *   suggestedStarter?: id,  // ローテーションの予定
 *   statsOf?(id) → string,  // ペナント: シーズン成績の短い表記
 *   onStart(plan), onBack(),
 * }
 * 操作: 打順の行・控えの行をタップ（クリック / Enter）で選び、もう一度別の行をタップで入れ替え。
 *       守備位置のボタン同士で守備位置を入れ替え。行はドラッグでも入れ替えられる。投手は「先発投手」タブ。
 *       キーボード: 矢印で移動、Z / Enter で選ぶ、X / Esc で取り消し・もどる。
 */
import { rank } from './data.js';
import { POS_NAMES } from './engine.js';
import {
  autoPlan, validatePlan, swapOrder, swapPositions, substitute, setStarter, benchOfPlan, loadPlan, savePlan, defaultPlan, applyLineup,
} from './lineup.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE = { starter: '先発', setup: '中継ぎ(8回)', reliever: '中継ぎ', closer: '抑え' };
export const roleName = (p) => ROLE[p?.pitching?.role] || '投手';
const velScale = (kmh) => Math.max(1, Math.min(99, Math.round(((kmh - 120) / 50) * 99)));
const rk = (label, v) => `<span class="pg-rk"><small>${label}</small><b class="badge rank-${rank(v)}">${rank(v)}</b></span>`;
export const chip = (t, cls = '') => `<span class="sn-chip ${cls}" style="--c:${esc(t.color)}">${esc(t.short)}</span>`;

/**
 * 矢印キーで画面内のボタンを移動する（見えている要素から、その方向で最も近いもの）
 * @returns {boolean} 移動したか
 */
export function spatialNav(root, dir) {
  const items = [...root.querySelectorAll('button:not([disabled]), [data-nav]')].filter((b) => b.offsetParent !== null && !b.closest('[hidden]'));
  if (!items.length) return false;
  const cur = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
  if (!cur) { items[0].focus(); return true; }
  const r0 = cur.getBoundingClientRect();
  const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
  let best = null; let bestScore = Infinity;
  for (const b of items) {
    if (b === cur) continue;
    const r = b.getBoundingClientRect();
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const dx = c.x - c0.x; const dy = c.y - c0.y;
    let main; let side;
    if (dir === 'up') { main = -dy; side = Math.abs(dx); }
    else if (dir === 'down') { main = dy; side = Math.abs(dx); }
    else if (dir === 'left') { main = -dx; side = Math.abs(dy); }
    else { main = dx; side = Math.abs(dy); }
    if (main <= 2) continue;
    const score = main + side * 2.2;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  if (best) { best.focus(); best.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); return true; }
  return false;
}

/** 対戦モードの試合前画面の設定（タイトルの「試合をはじめる」から） */
export function exhibitionOptions(ctx) {
  const { user, opp } = ctx.matchup();
  return {
    mode: 'exhibition', team: user, opp, userHome: false,
    plan: loadPlan(user) || defaultPlan(user),
    caption: 'たいせん',
    oppStarter: opp ? opp.players.find((p) => p.id === opp.pitchers[0]) : null,
    onStart(plan) { savePlan(user, plan); ctx.go('game'); },
    onBack() { ctx.go('title'); },
  };
}
/** 対戦モード: 保存したオーダーを反映した自分のチーム（無ければそのまま） */
export function exhibitionTeam(team) {
  const plan = loadPlan(team);
  if (!plan) return team;
  try { return applyLineup(team, plan); } catch (e) { return team; }
}

export function renderPregame(el, ctx, opts) {
  const team = opts.team;
  const map = new Map(team.players.map((p) => [p.id, p]));
  let plan = opts.plan && validatePlan(team, opts.plan).ok ? opts.plan : autoPlan(team, { starter: opts.suggestedStarter });
  let tab = 'bench';
  let sel = null;          // { kind: 'order'|'pos'|'bench', id }
  let msg = '';
  let msgKind = '';
  let drag = null;
  let destroyed = false;
  const listeners = [];
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); listeners.push(() => t.removeEventListener(ev, fn, o)); };

  const say = (text, kind = '') => { msg = text; msgKind = kind; };

  function act(src, dst) {
    if (!src || !dst) return;
    const pitcherIds = new Set(team.players.filter((p) => p.pitching).map((p) => p.id));
    if (src.kind === 'pitcher' || dst.kind === 'pitcher') {
      const pid = src.kind === 'pitcher' ? src.id : dst.id;
      plan = setStarter(team, plan, pid); say(`先発投手は ${map.get(pid).name}`, 'good'); return;
    }
    if (src.kind === 'order' && dst.kind === 'order') {
      const i = plan.order.indexOf(src.id); const j = plan.order.indexOf(dst.id);
      if (i === j) return;
      plan = swapOrder(plan, i, j);
      say(`${map.get(src.id).name} と ${map.get(dst.id).name} の打順を入れ替えました`, 'good');
      return;
    }
    if (src.kind === 'pos' && dst.kind === 'pos') {
      if (src.id === dst.id) return;
      if (plan.pos[src.id] === '投' || plan.pos[dst.id] === '投') { say('投手の守備位置は変えられません（「先発投手」タブで交代）', 'bad'); return; }
      plan = swapPositions(plan, src.id, dst.id);
      say(`${map.get(src.id).name}（${plan.pos[src.id]}）と ${map.get(dst.id).name}（${plan.pos[dst.id]}）の守備位置を入れ替えました`, 'good');
      return;
    }
    const o = src.kind === 'bench' ? dst : src;
    const b = src.kind === 'bench' ? src : dst;
    if (b.kind === 'bench' && (o.kind === 'order' || o.kind === 'pos')) {
      if (pitcherIds.has(o.id)) { say('投手は「先発投手」タブで替えてください', 'bad'); return; }
      const pos = plan.pos[o.id];
      plan = substitute(plan, o.id, b.id);
      say(`${map.get(b.id).name} が ${plan.order.indexOf(b.id) + 1}番・${pos} に入ります`, 'good');
    }
  }

  function tap(target) {
    if (target.kind === 'pitcher') { act(target, target); sel = null; render(); return; }
    if (!sel) { sel = target; say(target.kind === 'pos' ? '入れ替える相手の守備位置をえらんでください' : '入れ替える相手をえらんでください'); render(); return; }
    if (sel.kind === target.kind && sel.id === target.id) { sel = null; say(''); render(); return; }
    if (sel.kind === 'bench' && target.kind === 'bench') { sel = target; render(); return; }
    // 守備位置ボタンと行の組み合わせ: 行同士として扱う（控え → 守備位置ボタンは交代）
    let a = sel; let b = target;
    if (a.kind === 'pos' && b.kind === 'order') b = { kind: 'pos', id: b.id };
    else if (a.kind === 'order' && b.kind === 'pos') a = { kind: 'pos', id: a.id };
    act(a, b);
    sel = null;
    render();
  }

  const isSel = (kind, id) => sel && sel.kind === kind && sel.id === id;

  function orderRow(id, i, warnIds) {
    const p = map.get(id);
    const pos = plan.pos[id];
    const isP = pos === '投';
    const abil = isP
      ? `${rk('球速', velScale(p.pitching.velocity))}${rk('制球', p.pitching.control)}${rk('スタ', p.pitching.stamina)}`
      : `${rk('ミート', p.contact)}${rk('パワー', p.power)}${rk('走力', p.speed)}${rk('守備', p.fielding)}`;
    const st = opts.statsOf ? `<span class="pg-st">${esc(opts.statsOf(id) || '')}</span>` : '';
    const warn = warnIds.has(id) ? '<i class="pg-warn" title="本職ではない守備位置">⚠</i>' : '';
    return `<div class="pg-row${isSel('order', id) ? ' sel' : ''}${isP ? ' is-p' : ''}" data-drop="order" data-id="${esc(id)}">
      <span class="pg-num">${i + 1}</span>
      <button type="button" class="pg-pos${isSel('pos', id) ? ' sel' : ''}${warnIds.has(id) ? ' off' : ''}" data-kind="pos" data-id="${esc(id)}" aria-label="${esc(p.name)}の守備位置 ${esc(POS_NAMES[pos] || pos)}">${esc(pos)}</button>
      <button type="button" class="pg-name" data-kind="order" data-id="${esc(id)}" data-drag="order">
        <b>${esc(p.name)}</b><small>${esc(p.throws)}投${esc(p.bats)}打${isP ? '' : ` ・ ${esc((p.positions || [p.pos]).join(''))}`}</small>${warn}
      </button>
      <span class="pg-abil">${st}${abil}</span>
    </div>`;
  }

  function benchRow(id) {
    const p = map.get(id);
    const st = opts.statsOf ? `<span class="pg-st">${esc(opts.statsOf(id) || '')}</span>` : '';
    return `<button type="button" class="pg-item${isSel('bench', id) ? ' sel' : ''}" data-kind="bench" data-id="${esc(id)}" data-drag="bench" data-drop="bench">
      <span class="pg-iname"><b>${esc(p.name)}</b><small>守れる位置 ${esc((p.positions || [p.pos]).join('・'))} ・ ${esc(p.bats)}打</small></span>
      <span class="pg-abil">${st}${rk('ミート', p.contact)}${rk('パワー', p.power)}${rk('走力', p.speed)}</span>
    </button>`;
  }

  function pitcherRow(id) {
    const p = map.get(id);
    const info = opts.pitcherInfo ? opts.pitcherInfo(id) : null;
    const cur = plan.starter === id;
    const sug = opts.suggestedStarter === id;
    const st = opts.statsOf ? `<span class="pg-st">${esc(opts.statsOf(id) || '')}</span>` : '';
    let fat = '';
    if (info) {
      const pct = Math.round(info.mul * 100);
      const lvl = info.f < 30 ? 'ok' : info.f < 60 ? 'mid' : 'low';
      const rest = info.restDays == null ? '未登板' : info.restDays === 0 ? '前日登板' : `中${info.restDays}日`;
      fat = `<span class="pg-fat"><span class="pg-bar"><i class="${lvl}" style="width:${Math.max(4, 100 - info.f)}%"></i></span><small>${esc(info.label)}・${rest}${pct < 100 ? `・スタミナ${pct}%` : ''}${info.rest && !cur ? `・${esc(info.reason)}` : ''}</small></span>`;
    }
    return `<button type="button" class="pg-item pit${cur ? ' cur' : ''}" data-kind="pitcher" data-id="${esc(id)}" aria-pressed="${cur}">
      <span class="pg-iname"><b>${cur ? '<i class="pg-tag">先発</i>' : ''}${sug && !cur ? '<i class="pg-tag sug">予定</i>' : ''}${esc(p.name)}</b><small>${esc(roleName(p))} ・ ${esc(p.throws)}投 ・ ${p.pitching.velocity}km</small>${fat}</span>
      <span class="pg-abil">${st}${rk('制球', p.pitching.control)}${rk('スタ', p.pitching.stamina)}</span>
    </button>`;
  }

  function render() {
    if (destroyed) return;
    const focusKey = document.activeElement && el.contains(document.activeElement)
      ? `${document.activeElement.dataset.kind || document.activeElement.dataset.act || ''}|${document.activeElement.dataset.id || document.activeElement.dataset.tab || ''}` : '';
    const v = validatePlan(team, plan);
    const warnIds = new Set(v.warnings.map((w) => w.id));
    const bench = benchOfPlan(team, plan);
    const sideL = opts.userHome ? 'あなたは後攻（ホーム）' : 'あなたは先攻（ビジター）';
    const status = !v.ok ? `<p class="pg-msg bad">${esc(v.errors[0])}</p>`
      : msg ? `<p class="pg-msg ${msgKind}">${esc(msg)}</p>`
        : v.warnings.length ? `<p class="pg-msg warn">⚠ ${esc(v.warnings[0].text)}${v.warnings.length > 1 ? ` ほか${v.warnings.length - 1}人` : ''}</p>`
          : '<p class="pg-msg">タップで選んで、もう一度タップで入れ替え（ドラッグでもOK）。守備位置のボタン同士で守備を交換</p>';
    const oppSt = opts.oppStarter ? `<span class="pg-opp-st">予告先発 <b>${esc(opts.oppStarter.name)}</b></span>` : '';
    el.innerHTML = `<div class="pregame" data-scroll>
      <div class="pg-header">
        <button type="button" class="back-btn pg-back" data-act="back">もどる</button>
        <h2>試合前<small>${esc(opts.caption || '')}</small></h2>
        <div class="pg-match">${chip(team)}<span class="pg-vs">VS</span>${opts.opp ? chip(opts.opp) : ''}<span class="pg-side">${esc(sideL)}</span>${oppSt}</div>
        <button type="button" class="pg-auto" data-act="auto">おまかせ</button>
        <button type="button" class="pg-start" data-act="start"${v.ok ? '' : ' disabled'}>プレイボール ▶</button>
      </div>
      <div class="pg-body">
        <section class="pg-panel pg-order" aria-label="スタメン">
          <h3>スタメン <small>${esc(team.name)}</small></h3>
          <div class="pg-rows" data-scroll>${plan.order.map((id, i) => orderRow(id, i, warnIds)).join('')}</div>
        </section>
        <section class="pg-panel pg-side-panel">
          <div class="pg-tabs" role="tablist">
            <button type="button" class="pg-tab${tab === 'bench' ? ' on' : ''}" data-tab="bench" role="tab" aria-selected="${tab === 'bench'}">控え野手 <small>${bench.length}</small></button>
            <button type="button" class="pg-tab${tab === 'pitchers' ? ' on' : ''}" data-tab="pitchers" role="tab" aria-selected="${tab === 'pitchers'}">先発投手 <small>${esc(map.get(plan.starter)?.name || '')}</small></button>
          </div>
          <div class="pg-list" data-scroll>${tab === 'bench' ? bench.map(benchRow).join('') || '<p class="pg-empty">控えはいません</p>' : team.pitchers.map(pitcherRow).join('')}</div>
        </section>
      </div>
      <div class="pg-foot">${status}<span class="pg-inn">イニング
        ${[3, 6, 9].map((n) => `<button type="button" class="pg-innbtn${Number(ctx.settings?.innings) === n ? ' on' : ''}" data-inn="${n}">${n}回</button>`).join('')}</span></div>
    </div>`;
    el.querySelector('[data-act="back"]').onclick = () => opts.onBack?.();
    el.querySelector('[data-act="auto"]').onclick = () => {
      plan = autoPlan(team, { starter: plan.starter });
      sel = null; say('おまかせでオーダーを組みました', 'good'); render();
    };
    el.querySelector('[data-act="start"]').onclick = start;
    el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
    el.querySelectorAll('[data-inn]').forEach((b) => (b.onclick = () => { ctx.saveSettings?.({ innings: Number(b.dataset.inn) }); render(); }));
    el.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = (e) => {
      if (b.__dragged) { b.__dragged = false; e.preventDefault(); return; }
      tap({ kind: b.dataset.kind, id: b.dataset.id });
    }));
    if (focusKey) {
      const [k, id] = focusKey.split('|');
      const t = el.querySelector(`[data-kind="${k}"][data-id="${id}"]`) || el.querySelector(`[data-act="${k}"]`) || el.querySelector(`[data-tab="${id}"]`);
      t?.focus({ preventScroll: true });
    }
  }

  function start() {
    const v = validatePlan(team, plan);
    if (!v.ok) { say(v.errors[0], 'bad'); render(); return; }
    opts.onStart?.(plan);
  }

  /* ---------- ドラッグ（pointer events。タップと区別するため 10px 動いたら開始） ---------- */
  on(el, 'pointerdown', (e) => {
    const src = e.target.closest?.('[data-drag]');
    if (!src || e.button > 0) return;
    // マウスはすぐ、タッチは 0.25 秒押したままでドラッグ（すぐ動かしたらリストのスクロール）
    const touchy = e.pointerType !== 'mouse';
    drag = { src, x: e.clientX, y: e.clientY, id: e.pointerId, ghost: null, over: null, armed: !touchy, timer: 0 };
    if (touchy) {
      const d = drag;
      d.timer = setTimeout(() => { if (drag === d) { d.armed = true; d.src.classList.add('armed'); } }, 250);
    }
  });
  on(document, 'touchmove', (e) => { if (drag?.armed) e.preventDefault(); }, { passive: false });
  on(window, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
    if (!drag.ghost) {
      if (Math.hypot(dx, dy) < 10) return;
      if (!drag.armed) { clearTimeout(drag.timer); drag = null; return; }
      const g = document.createElement('div');
      g.className = 'pg-ghost';
      g.textContent = drag.src.querySelector('b')?.textContent || '';
      document.body.appendChild(g);
      drag.ghost = g;
      drag.src.classList.add('dragging');
    }
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-drop]');
    if (drag.over && drag.over !== over) drag.over.classList.remove('drop');
    drag.over = over && el.contains(over) ? over : null;
    drag.over?.classList.add('drop');
    e.preventDefault();
  }, { passive: false });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    d.src.classList.remove('armed');
    if (!d.ghost) return;
    d.ghost.remove();
    d.src.classList.remove('dragging');
    d.over?.classList.remove('drop');
    d.src.__dragged = true;
    setTimeout(() => { d.src.__dragged = false; }, 0);
    if (e && e.type === 'pointerup' && d.over) {
      const src = { kind: d.src.dataset.kind, id: d.src.dataset.id };
      const dst = { kind: d.over.dataset.drop, id: d.over.dataset.id };
      if (!(src.kind === dst.kind && src.id === dst.id) && !(src.kind === 'bench' && dst.kind === 'bench')) { act(src, dst); sel = null; render(); }
    }
  };
  on(window, 'pointerup', endDrag);
  on(window, 'pointercancel', endDrag);

  render();
  el.querySelector('[data-act="start"]')?.focus({ preventScroll: true });

  return {
    handleKey(key, e) {
      if (['up', 'down', 'left', 'right'].includes(key)) { e?.preventDefault(); spatialNav(el, key); return; }
      if (key === 'z') {
        const a = document.activeElement;
        if (a && el.contains(a) && a.tagName === 'BUTTON') { e?.preventDefault(); a.click(); }
        return;
      }
      if (key === 'enter') {
        const a = document.activeElement;
        if (!(a && el.contains(a) && a.tagName === 'BUTTON')) { e?.preventDefault(); start(); }
        return;
      }
      if (key === 'x' || key === 'esc') {
        e?.preventDefault();
        if (sel) { sel = null; say(''); render(); } else opts.onBack?.();
      }
    },
    destroy() {
      destroyed = true;
      if (drag?.ghost) drag.ghost.remove();
      drag = null;
      listeners.forEach((f) => f());
    },
  };
}
