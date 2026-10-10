/**
 * スマホ・タブレット向けの入力まわり（ドキドキベースボール）
 *
 * - (pointer: coarse) の端末では body に .touch を付け、試合画面のタッチ操作（十字キー・Z/X・
 *   バント/盗塁・さいはい/メニュー）を拡大縮小されるステージの外（#touch-ui、画面の四隅に固定）に出す。
 *   ボタンは実際の CSS px で指サイズのまま。入力は試合画面の handleKey/handleKeyUp に流すので、
 *   守備ビュー（fielding.js）や采配メニューへの振り分けは game.js 側の既存ロジックのまま。
 * - フィールドのドラッグでミートカーソル／投球の狙いを相対移動（トラックパッド風）。
 * - 縦向きでは「横向きにしてあそんでね」（#rotate-hint）を出して入力を止める。
 * - ダブルタップ拡大・ピンチ・長押しメニューなどスマホ特有の誤動作を抑える。
 *
 * export function initTouch(opts) → { isCoarse(), isRotateBlocking(), releaseAll() }
 *   opts = { stage, wrap, getGame(): gameScreen|null, getCurrent(): 画面名, getScale(): number }
 * export canFullscreen(), isFullscreenOrStandalone(), enterFullscreen()
 */

const mm = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : { matches: false, addEventListener() {} });

/* ---------------- 全画面 ---------------- */
export function canFullscreen() {
  const d = document;
  const el = d.documentElement;
  return !!((d.fullscreenEnabled || d.webkitFullscreenEnabled) && (el.requestFullscreen || el.webkitRequestFullscreen));
}
export function isFullscreenOrStandalone() {
  const d = document;
  return !!(d.fullscreenElement || d.webkitFullscreenElement
    || mm('(display-mode: fullscreen)').matches || mm('(display-mode: standalone)').matches
    || navigator.standalone);
}
export async function enterFullscreen() {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (e) { return false; }
  try { await screen.orientation?.lock?.('landscape'); } catch (e) { /* 未対応の端末では無視 */ }
  return true;
}

/* ---------------- タッチ操作 ---------------- */
const SCROLLABLE = '.te-scroll, .roster, .sb-body, .opp-list, .settings-body, .te-panel, [data-scroll]';

export function initTouch({ stage, wrap, getGame, getCurrent, getScale }) {
  const coarseMQ = mm('(pointer: coarse)');
  const portraitMQ = mm('(orientation: portrait)');
  const body = document.body;
  const isCoarse = () => !!coarseMQ.matches;
  const isRotateBlocking = () => isCoarse() && !!portraitMQ.matches;

  const ui = document.createElement('div');
  ui.id = 'touch-ui';
  ui.hidden = true;
  ui.innerHTML = `
  <div class="tu-dpad">
    <button type="button" class="tu-dir up" data-key="up" aria-label="上">▲</button>
    <button type="button" class="tu-dir left" data-key="left" aria-label="左">◀</button>
    <button type="button" class="tu-dir right" data-key="right" aria-label="右">▶</button>
    <button type="button" class="tu-dir down" data-key="down" aria-label="下">▼</button>
  </div>
  <div class="tu-mini">
    <button type="button" class="tu-pill tu-bunt" data-key="bunt">バント</button>
    <button type="button" class="tu-pill tu-steal" data-key="steal">盗塁</button>
  </div>
  <div class="tu-act">
    <button type="button" class="tu-round tu-x" data-key="x" aria-label="X"><b>X</b><small data-tu="x">強振</small></button>
    <button type="button" class="tu-round tu-z" data-key="z" aria-label="Z"><b>Z</b><small data-tu="z">ミート</small></button>
  </div>
  <div class="tu-top">
    <button type="button" class="tu-pill tu-subs" data-act="subs">さいはい</button>
    <button type="button" class="tu-pill tu-menu" data-act="menu">メニュー</button>
  </div>`;
  body.appendChild(ui);
  const q = (s) => ui.querySelector(s);
  const tu = { z: q('[data-tu="z"]'), x: q('[data-tu="x"]'), steal: q('.tu-steal'), subs: q('.tu-subs'), mini: q('.tu-mini') };

  /* ---- ボタン（マルチタッチ: ボタンごとに pointer を捕まえる） ---- */
  const active = new Map(); // button → pointerId
  const game = () => { try { return getCurrent() === 'game' ? getGame() : null; } catch (e) { return null; } };
  function press(btn, e) {
    if (active.has(btn)) return;
    active.set(btn, e ? e.pointerId : -1);
    btn.classList.add('is-down');
    const key = btn.dataset.key;
    if (key === 'z' || key === 'x') { try { navigator.vibrate?.(10); } catch (er) { /* ignore */ } }
    try { game()?.handleKey(key); } catch (er) { console.error(er); }
  }
  function release(btn) {
    if (!active.has(btn)) return;
    active.delete(btn);
    btn.classList.remove('is-down');
    try { game()?.handleKeyUp?.(btn.dataset.key); } catch (er) { console.error(er); }
  }
  function releaseAll() { [...active.keys()].forEach(release); endDrag(); }

  ui.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      press(btn, e);
    });
    const up = (e) => { if (active.get(btn) === e.pointerId) release(btn); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('pointerleave', (e) => { if (!btn.hasPointerCapture?.(e.pointerId)) up(e); });
  });
  ui.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = stage.querySelector(`#screen-game [data-ref="${btn.dataset.act}"]`);
      target?.click();
    });
  });
  ui.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---- フィールドのドラッグ → カーソル移動 ---- */
  let drag = null; // { id, x, y }
  function endDrag() { drag = null; }
  wrap.addEventListener('pointerdown', (e) => {
    if (drag || e.pointerType === 'mouse' || !body.classList.contains('touch')) return;
    const g = game();
    if (!g || typeof g.dragCursor !== 'function' || isRotateBlocking()) return;
    if (e.clientX > window.innerWidth * 0.72) return; // 右側は Z/X 用に空けておく
    if (e.target.closest?.('button, input, select, textarea, a, .sb, .fv, .opp-modal')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const s = Number(getScale()) || 1;
    const dx = (e.clientX - drag.x) / s, dy = (e.clientY - drag.y) / s;
    drag.x = e.clientX; drag.y = e.clientY;
    try { game()?.dragCursor(dx, dy); } catch (er) { console.error(er); }
  });
  const dragEnd = (e) => { if (drag && e.pointerId === drag.id) endDrag(); };
  wrap.addEventListener('pointerup', dragEnd);
  wrap.addEventListener('pointercancel', dragEnd);

  /* ---- 画面の状態に合わせてボタンの表示・ラベルを同期 ---- */
  const last = {};
  const set = (k, v, fn) => { if (last[k] !== v) { last[k] = v; fn(v); } };
  function sync() {
    const g = game();
    const on = isCoarse() && !!g && !isRotateBlocking();
    set('hidden', !on, (v) => { ui.hidden = v; if (v) releaseAll(); });
    if (!on) return;
    const root = stage.querySelector('#screen-game .game');
    if (!root) return;
    const fv = root.querySelector('.fv');
    const subsOpen = !!stage.querySelector('#screen-game .sb');
    const mode = subsOpen ? 'subs' : fv ? (fv.classList.contains('fv-user') ? 'field' : 'field-cpu') : 'play';
    set('mode', mode, (v) => { ui.dataset.mode = v; if (v === 'subs') releaseAll(); });
    const src = mode === 'field' ? fv : root;
    const zl = mode === 'field-cpu' ? 'スキップ' : (src.querySelector('[data-ref="z-label"]')?.textContent || '');
    const xl = src.querySelector('[data-ref="x-label"]')?.textContent || '';
    set('z', zl, (v) => { tu.z.textContent = v; });
    set('x', xl, (v) => { tu.x.textContent = v; });
    const mini = root.querySelector('[data-ref="mini-btns"]');
    set('mini', !!mini && mini.style.display !== 'none', (v) => tu.mini.classList.toggle('is-off', !v));
    const steal = root.querySelector('[data-ref="steal-btn"]');
    set('steal', !!steal?.classList.contains('is-disabled'), (v) => tu.steal.classList.toggle('is-disabled', v));
    const subs = root.querySelector('[data-ref="subs"]');
    set('subs', !!subs?.classList.contains('is-disabled'), (v) => tu.subs.classList.toggle('is-disabled', v));
  }
  setInterval(sync, 100);

  /* ---- 端末の種類・向き ---- */
  function applyPointer() {
    body.classList.toggle('touch', isCoarse());
    sync();
  }
  const onOrient = () => { if (isRotateBlocking()) releaseAll(); sync(); };
  coarseMQ.addEventListener?.('change', applyPointer);
  portraitMQ.addEventListener?.('change', onOrient);
  window.addEventListener('orientationchange', onOrient);
  applyPointer();

  /* ---- スマホ特有の誤動作の抑止 ---- */
  // iOS Safari のピンチ（user-scalable=no を無視するため）
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  // 2 本指以上のピンチ・リスト以外のスクロール（引っぱって更新・バウンス）
  document.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 1) { e.preventDefault(); return; }
    if (!e.target.closest?.(SCROLLABLE)) e.preventDefault();
  }, { passive: false });
  // ダブルタップ拡大は CSS の touch-action（none / manipulation）で止める（click を潰さないため JS では扱わない）
  // 長押しのコンテキストメニュー
  document.addEventListener('contextmenu', (e) => {
    if (body.classList.contains('touch') && !e.target.closest?.('input, textarea')) e.preventDefault();
  });

  return { isCoarse, isRotateBlocking, releaseAll, sync };
}
