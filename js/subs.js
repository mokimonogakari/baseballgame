/**
 * 選手交代メニュー（ドキドキベースボール）
 * 代打・代走（攻撃時）／投手交代・守備交代（守備時）のモーダル。ロジックは engine に委譲する。
 *
 * export function openSubsMenu(container, opts) → { handleKey(key), close() }
 *   opts = {
 *     state, side: ユーザー側 'away'|'home', engine: engine モジュール名前空間,
 *     mode: 'batting'|'fielding',
 *     onApply(newState, eventText)  交代成功時（その後メニューは閉じる）
 *     onClose({applied})            メニューが閉じたとき（適用後も呼ばれる。applied=true/false）
 *   }
 *   key: 'up'|'down'|'left'|'right'|'z'|'enter'|'x'|'esc'
 * 使用する engine 関数: lineupView, availableBench, availablePitchers, changePitcher, pinchHit, pinchRun,
 *   defensiveSwap, getBatter, getPitcher, summary（存在しない場合は画面内にメッセージを表示）
 */
import { rank, RANK_COLORS } from './data.js';

const POS_ORDER = ['投', '捕', '一', '二', '三', '遊', '左', '中', '右'];
const POS_NAMES = { 投: '投手', 捕: '捕手', 一: '一塁手', 二: '二塁手', 三: '三塁手', 遊: '遊撃手', 左: '左翼手', 中: '中堅手', 右: '右翼手', 指: '指名打者' };
const BASE_LABEL = ['1塁', '2塁', '3塁'];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function badge(label, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  const r = rank(v);
  const fg = r === 'C' ? '#1C2B4B' : '#fff';
  return `<span class="sb-ab"><small>${esc(label)}</small><b style="background:${esc(RANK_COLORS[r] || '#9E9E9E')};color:${fg}">${esc(r)}</b><i>${esc(Math.round(v))}</i></span>`;
}

export function openSubsMenu(container, opts = {}) {
  if (!container) throw new Error('subs.js: container がありません');
  const engine = opts.engine || {};
  const side = opts.side || opts.state?.userSide || 'away';
  const mode = opts.mode === 'fielding' ? 'fielding' : 'batting';
  let state = opts.state;
  const tabs = mode === 'batting'
    ? [{ id: 'ph', label: '代打' }, { id: 'pr', label: '代走' }]
    : [{ id: 'pc', label: '投手交代' }, { id: 'def', label: '守備交代' }];
  let tab = tabs[0].id;
  let step = 1;               // 代走: 1=走者選択 2=控え選択 / 守備交代: 1=野手選択 2=交代先
  let pickBase = null;        // 代走で選んだ塁 index
  let pickFielder = null;     // 守備交代で選んだ野手 id
  let confirm = null;         // { text, run:()=>({state,text}) }
  let error = '';
  let focusId = null;
  let closed = false;

  // ---------- データ取得 ----------
  const team = () => state?.teams?.[side] || { players: [] };
  const playerById = (id) => team().players?.find((p) => p.id === id) || null;
  const toPlayer = (x) => (x && typeof x === 'object' ? (x.id && !x.contact && !x.pitching && playerById(x.id)) || x : playerById(x));
  const call = (name, ...args) => {
    if (typeof engine[name] !== 'function') throw new Error(`この機能は準備中です（engine.${name} がありません）`);
    return engine[name](...args);
  };
  const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };

  const lineup = () => safe(() => call('lineupView', state, side), null) || (team().lineup || []).map((id, i) => {
    const p = playerById(id);
    return { slot: i + 1, id, name: p?.name ?? id, pos: p?.pos ?? '', isPitcher: p?.pos === '投' };
  });
  const bench = () => (safe(() => call('availableBench', state, side), []) || []).map(toPlayer).filter(Boolean);
  const pitchers = () => (safe(() => call('availablePitchers', state, side), []) || []).map(toPlayer).filter(Boolean);
  const currentBatter = () => safe(() => call('getBatter', state), null);
  const currentPitcher = () => {
    const lp = lineup().find((l) => l.isPitcher || l.pos === '投');
    if (lp) return playerById(lp.id) || lp;
    return safe(() => call('getPitcher', state), null);
  };
  const runners = () => {
    const s = safe(() => call('summary', state), null);
    if (Array.isArray(s?.runners)) return [0, 1, 2].map((i) => s.runners[i] || null);
    if (Array.isArray(state?.runners)) return [0, 1, 2].map((i) => (state.runners[i] ? toPlayer(state.runners[i]) : null));
    return [0, 1, 2].map((i) => (state?.bases?.[i] ? { id: null, name: '走者', speed: null } : null));
  };
  const staminaOf = (p) => {
    const max = Number(p?.pitching?.stamina) || 0;
    const cur = state?.stamina?.[p?.id];
    return { cur: typeof cur === 'number' ? cur : max, max };
  };

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.className = 'sb';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '選手交代');
  root.innerHTML = `<div class="sb-backdrop" data-act="backdrop"></div><div class="sb-panel"></div>`;
  container.appendChild(root);
  const panel = root.querySelector('.sb-panel');
  const onClick = (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.hasAttribute('disabled')) return;
    e.preventDefault();
    focusId = el.dataset.fid || focusId;
    activate(el);
  };
  root.addEventListener('click', onClick);

  function itemBtn(fid, act, inner, { disabled = false, cls = '', data = '' } = {}) {
    return `<button type="button" tabindex="-1" class="sb-item ${cls}" data-focus data-fid="${esc(fid)}" data-act="${esc(act)}" ${data} ${disabled ? 'disabled aria-disabled="true"' : ''}>${inner}</button>`;
  }

  function viewPinchHit() {
    const b = currentBatter();
    const lu = lineup();
    const slot = b ? lu.find((l) => l.id === b.id) : null;
    const list = bench();
    const head = b ? `<div class="sb-current"><span class="sb-tag">現在の打者</span><b>${slot ? `${esc(slot.slot)}番 ` : ''}${esc(b.name)}</b><small>${esc(POS_NAMES[b.pos] || b.pos || '')}</small>${badge('ミート', b.contact)}${badge('パワー', b.power)}${badge('走力', b.speed)}</div>` : '';
    const rows = list.length ? list.map((p) => itemBtn(`ph:${p.id}`, 'ph', `<span class="sb-pos">${esc(p.pos || '')}</span><span class="sb-nm">${esc(p.name)}<small>${esc(p.bats ? `${p.bats}打` : '')}</small></span>${badge('ミート', p.contact)}${badge('パワー', p.power)}${badge('走力', p.speed)}`, { data: `data-id="${esc(p.id)}"` })).join('')
      : '<div class="sb-empty">代打に出せる控え選手がいません</div>';
    return { hint: '代打で起用する選手を選んでください', html: `${head}<div class="sb-list">${rows}</div>` };
  }

  function viewPinchRun() {
    const rs = runners();
    if (step === 1) {
      const cards = rs.map((r, i) => itemBtn(`prb:${i}`, 'prb', r
        ? `<span class="sb-base">${BASE_LABEL[i]}</span><span class="sb-nm">${esc(r.name)}</span>${badge('走力', r.speed ?? playerById(r.id)?.speed)}`
        : `<span class="sb-base">${BASE_LABEL[i]}</span><span class="sb-nm sb-dim">走者なし</span>`, { disabled: !r, cls: 'sb-card', data: `data-base="${i}"` })).join('');
      const any = rs.some(Boolean);
      return { hint: any ? '代走を出す走者を選んでください' : '塁上に走者がいません', html: `<div class="sb-grid3">${cards}</div>` };
    }
    const r = rs[pickBase];
    const list = bench().slice().sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0));
    const head = `<div class="sb-current"><span class="sb-tag">${BASE_LABEL[pickBase]}走者</span><b>${esc(r?.name ?? '')}</b>${badge('走力', r?.speed ?? playerById(r?.id)?.speed)}</div>`;
    const rows = list.length ? list.map((p) => itemBtn(`pr:${p.id}`, 'pr', `<span class="sb-pos">${esc(p.pos || '')}</span><span class="sb-nm">${esc(p.name)}</span>${badge('走力', p.speed)}<span class="sb-big">${esc(p.speed ?? '-')}</span>`, { data: `data-id="${esc(p.id)}"` })).join('')
      : '<div class="sb-empty">代走に出せる控え選手がいません</div>';
    return { hint: '代走で起用する選手を選んでください（X:戻る）', html: `${head}<div class="sb-list">${rows}</div>` };
  }

  function staminaBar(p) {
    const { cur, max } = staminaOf(p);
    const pct = max ? clamp((cur / max) * 100, 0, 100) : 0;
    return `<span class="sb-stam"><i class="${pct < 30 ? 'low' : ''}" style="width:${pct.toFixed(0)}%"></i></span><span class="sb-stam-num">${Math.round(cur)}/${Math.round(max)}</span>`;
  }

  function viewPitcher() {
    const cur = currentPitcher();
    const curP = cur ? playerById(cur.id) || cur : null;
    const head = curP ? `<div class="sb-current"><span class="sb-tag">現在の投手</span><b>${esc(curP.name)}</b><small>${esc(curP.throws ? `${curP.throws}投` : '')}</small><span class="sb-lbl">残りスタミナ</span>${staminaBar(curP)}</div>` : '';
    const list = pitchers().filter((p) => !curP || p.id !== curP.id);
    const rows = list.length ? list.map((p) => {
      const pi = p.pitching || {};
      return itemBtn(`pc:${p.id}`, 'pc', `<span class="sb-nm">${esc(p.name)}<small>${esc(p.throws ? `${p.throws}投` : '')}</small></span><span class="sb-velo"><b>${esc(pi.velocity ?? '-')}</b><small>km/h</small></span>${badge('コントロール', pi.control)}${badge('スタミナ', pi.stamina)}`, { data: `data-id="${esc(p.id)}"` });
    }).join('') : '<div class="sb-empty">登板できる投手がいません</div>';
    return { hint: '登板させる投手を選んでください', html: `${head}<div class="sb-list">${rows}</div>` };
  }

  function fieldersNow() {
    const lu = lineup().filter((l) => l.pos && l.pos !== '指');
    return POS_ORDER.map((pos) => lu.find((l) => l.pos === pos)).filter(Boolean);
  }

  function viewDefense() {
    const fs = fieldersNow();
    if (step === 1) {
      const cards = fs.map((l) => {
        const p = playerById(l.id) || l;
        return itemBtn(`df:${l.id}`, 'df', `<span class="sb-pos">${esc(l.pos)}</span><span class="sb-nm">${esc(l.name)}</span>${badge('守備', p.fielding)}`, { cls: 'sb-card', data: `data-id="${esc(l.id)}"` });
      }).join('');
      return { hint: '交代・移動させる野手を選んでください', html: `<div class="sb-grid3">${cards}</div>` };
    }
    const me = fs.find((l) => l.id === pickFielder);
    const meP = playerById(pickFielder) || me;
    const head = `<div class="sb-current"><span class="sb-tag">${esc(me?.pos ?? '')}</span><b>${esc(me?.name ?? '')}</b><small>の交代先</small>${badge('守備', meP?.fielding)}${badge('肩力', meP?.arm)}${badge('捕球', meP?.catching)}</div>`;
    const posBtns = POS_ORDER.filter((pos) => pos !== me?.pos).map((pos) => {
      const occ = fs.find((l) => l.pos === pos);
      const canPlay = Array.isArray(meP?.positions) ? meP.positions.includes(pos) : null;
      return itemBtn(`dp:${pos}`, 'dp', `<span class="sb-pos">${esc(pos)}</span><span class="sb-nm">${esc(occ ? occ.name : '空き')}</span>${canPlay === false ? '<span class="sb-warn">不慣れ</span>' : ''}`, { cls: 'sb-mini', data: `data-pos="${esc(pos)}"` });
    }).join('');
    const bl = bench();
    const benchRows = bl.length ? bl.map((p) => itemBtn(`db:${p.id}`, 'db', `<span class="sb-pos">${esc(p.pos || '')}</span><span class="sb-nm">${esc(p.name)}</span>${badge('守備', p.fielding)}${badge('肩力', p.arm)}${badge('捕球', p.catching)}`, { data: `data-id="${esc(p.id)}"` })).join('')
      : '<div class="sb-empty">控え選手がいません</div>';
    return {
      hint: '守備位置を入れ替えるか、控え選手と交代します（X:戻る）',
      html: `${head}<div class="sb-split"><div><div class="sb-sec">守備位置を入れ替え</div><div class="sb-grid4">${posBtns}</div></div><div><div class="sb-sec">控え選手と交代</div><div class="sb-list">${benchRows}</div></div></div>`,
    };
  }

  function render() {
    if (closed) return;
    const v = tab === 'ph' ? viewPinchHit() : tab === 'pr' ? viewPinchRun() : tab === 'pc' ? viewPitcher() : viewDefense();
    panel.innerHTML = `
<header class="sb-head">
  <h2>選手交代</h2>
  <div class="sb-tabs">${tabs.map((t) => `<button type="button" tabindex="-1" class="sb-tab${t.id === tab ? ' active' : ''}" data-focus data-fid="tab:${t.id}" data-act="tab" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div>
  <button type="button" tabindex="-1" class="sb-close" data-focus data-fid="close" data-act="close">✕ 閉じる</button>
</header>
<div class="sb-hint">${esc(v.hint)}</div>
<div class="sb-body">${v.html}</div>
<div class="sb-err" role="alert">${confirm ? '' : esc(error)}</div>
<footer class="sb-foot"><span><b>↑↓←→</b>選択</span><span><b>Z/Enter</b>決定</span><span><b>X/Esc</b>戻る</span></footer>
${confirm ? `<div class="sb-confirm"><div class="sb-confirm-box"><p>${esc(confirm.text)}</p>${error ? `<div class="sb-err in">${esc(error)}</div>` : ''}<div class="sb-confirm-btns"><button type="button" tabindex="-1" class="sb-btn primary" data-focus data-confirm data-fid="ok" data-act="ok">決定</button><button type="button" tabindex="-1" class="sb-btn" data-focus data-confirm data-fid="cancel" data-act="cancel">やめる</button></div></div></div>` : ''}`;
    const els = focusables();
    let f = els.find((e) => e.dataset.fid === focusId);
    if (!f) f = (confirm ? els[0] : els.find((e) => e.classList.contains('sb-item'))) || els.find((e) => e.dataset.act === 'tab' && e.classList.contains('active')) || els[0];
    setFocus(f);
  }

  function focusables() {
    const all = [...panel.querySelectorAll('[data-focus]')].filter((e) => !e.disabled);
    return confirm ? all.filter((e) => e.hasAttribute('data-confirm')) : all;
  }
  function setFocus(el) {
    panel.querySelectorAll('.sb-focus').forEach((e) => e.classList.remove('sb-focus'));
    if (!el) return;
    el.classList.add('sb-focus');
    focusId = el.dataset.fid;
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
  }

  /** 方向キーによる空間ナビゲーション */
  function move(dir) {
    const els = focusables();
    const cur = panel.querySelector('.sb-focus');
    if (!cur) { setFocus(els[0]); return; }
    const r0 = cur.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null;
    let bestCone = null;
    for (const e of els) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const dx = x - cx, dy = y - cy;
      let main, cross;
      if (dir === 'up') { main = -dy; cross = Math.abs(dx); } else if (dir === 'down') { main = dy; cross = Math.abs(dx); } else if (dir === 'left') { main = -dx; cross = Math.abs(dy); } else { main = dx; cross = Math.abs(dy); }
      if (main <= 4) continue;
      const score = main + cross * 2.2;
      if (!best || score < best.score) best = { e, score };
      if (cross <= main && (!bestCone || score < bestCone.score)) bestCone = { e, score };
    }
    const pick = bestCone || best;
    if (pick) setFocus(pick.e);
  }

  // ---------- 操作 ----------
  function ask(text, run) { confirm = { text, run }; error = ''; focusId = 'ok'; render(); }

  function activate(el) {
    const act = el.dataset.act;
    const id = el.dataset.id;
    switch (act) {
      case 'backdrop': case 'close': doClose(false); return;
      case 'tab': if (el.dataset.tab !== tab) { tab = el.dataset.tab; step = 1; pickBase = null; pickFielder = null; error = ''; focusId = null; } render(); return;
      case 'cancel': confirm = null; error = ''; render(); return;
      case 'ok': apply(); return;
      case 'ph': {
        const p = playerById(id); const b = currentBatter();
        ask(`${b ? `${b.name} に代わり、` : ''}代打 ${p?.name ?? ''} を送ります。よろしいですか？`, () => {
          const s = call('pinchHit', state, side, id);
          return { state: s, text: `代打、${p?.name ?? ''}${b ? `（${b.name}に代わって）` : ''}` };
        });
        return;
      }
      case 'prb': pickBase = Number(el.dataset.base); step = 2; focusId = null; error = ''; render(); return;
      case 'pr': {
        const p = playerById(id); const r = runners()[pickBase];
        const base = pickBase;
        ask(`${BASE_LABEL[base]}走者 ${r?.name ?? ''} に代わり、代走 ${p?.name ?? ''} を送ります。`, () => {
          const s = call('pinchRun', state, side, base, id);
          return { state: s, text: `代走、${p?.name ?? ''}（${BASE_LABEL[base]}・${r?.name ?? ''}に代わって）` };
        });
        return;
      }
      case 'pc': {
        const p = playerById(id); const cur = currentPitcher();
        ask(`${cur ? `${cur.name} に代わり、` : ''}${p?.name ?? ''} を登板させます。`, () => {
          const s = call('changePitcher', state, side, id);
          return { state: s, text: `ピッチャー交代、${p?.name ?? ''}` };
        });
        return;
      }
      case 'df': pickFielder = id; step = 2; focusId = null; error = ''; render(); return;
      case 'dp': {
        const fs = fieldersNow();
        const me = fs.find((l) => l.id === pickFielder);
        const pos = el.dataset.pos;
        const occ = fs.find((l) => l.pos === pos);
        const changes = [{ playerId: pickFielder, pos }];
        if (occ) changes.push({ playerId: occ.id, pos: me.pos });
        ask(occ ? `${me.name}（${me.pos}）と ${occ.name}（${pos}）の守備位置を入れ替えます。` : `${me.name} を ${POS_NAMES[pos] || pos} に移します。`, () => {
          const s = call('defensiveSwap', state, side, changes);
          return { state: s, text: occ ? `守備交代：${me.name}が${POS_NAMES[pos] || pos}、${occ.name}が${POS_NAMES[me.pos] || me.pos}` : `守備交代：${me.name}が${POS_NAMES[pos] || pos}へ` };
        });
        return;
      }
      case 'db': {
        const fs = fieldersNow();
        const me = fs.find((l) => l.id === pickFielder);
        const p = playerById(id);
        ask(`${me.name}（${me.pos}）に代わり、${p?.name ?? ''} が${POS_NAMES[me.pos] || me.pos}に入ります。`, () => {
          const s = call('defensiveSwap', state, side, [{ playerId: id, pos: me.pos }]);
          return { state: s, text: `守備交代：${me.name}に代わり${p?.name ?? ''}（${POS_NAMES[me.pos] || me.pos}）` };
        });
        return;
      }
      default:
    }
  }

  function apply() {
    if (!confirm) return;
    try {
      const { state: s, text } = confirm.run();
      if (!s) throw new Error('交代できませんでした');
      state = s;
      confirm = null;
      try { opts.onApply?.(s, text); } catch (e) { console.error(e); }
      doClose(true);
    } catch (e) {
      error = e?.message || String(e);
      render();
    }
  }

  function back() {
    if (confirm) { confirm = null; error = ''; render(); return; }
    if (step === 2) { step = 1; focusId = tab === 'pr' ? `prb:${pickBase}` : `df:${pickFielder}`; error = ''; render(); return; }
    doClose(false);
  }

  function doClose(applied) {
    if (closed) return;
    closed = true;
    root.removeEventListener('click', onClick);
    root.remove();
    try { opts.onClose?.({ applied }); } catch (e) { console.error(e); }
  }

  function handleKey(key) {
    if (closed) return;
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') { move(key); return; }
    if (key === 'z' || key === 'enter') { const f = panel.querySelector('.sb-focus'); if (f && !f.disabled) activate(f); return; }
    if (key === 'x' || key === 'esc') back();
  }

  render();
  return { handleKey, close: () => doClose(false) };
}
