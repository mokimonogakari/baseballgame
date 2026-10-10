/**
 * スマホ・タブレット向けの入力まわり（ドキドキベースボール）
 *
 * - (pointer: coarse) の端末では body に .touch を付け、試合画面のタッチ操作（十字キー・Z/X・
 *   バント/盗塁・さいはい/メニュー）を拡大縮小されるステージの外（#touch-ui、画面の四隅に固定）に出す。
 *   ボタンは実際の CSS px で指サイズのまま。入力は試合画面の handleKey/handleKeyUp に流すので、
 *   守備ビュー（fielding.js）や采配メニューへの振り分けは game.js 側の既存ロジックのまま。
 * - フィールドのドラッグでミートカーソル／投球の狙いを相対移動（トラックパッド風）。
 * - ゾーンのタップ: 打席ではカーソルをその位置へ動かし、投球後なら選んだ打ち方（ミート/強振/バント）でスイング。
 *   投球のコース選びでは狙いをその位置へ。10px 以上動かしたらドラッグ扱い（スイングしない）。
 * - 打席では「ミート / 強振 / バント」の切り替えと大きな「スイング」ボタン、投球では球種パネルのタップ・
 *   「決定」「投げる」「球種」ボタン（ラベルは場面ごとに game.touchInfo() から同期）。
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
    <button type="button" class="tu-pill tu-steal" data-key="steal">盗塁</button>
    <div class="tu-seg" role="group" aria-label="打ち方">
      <button type="button" class="tu-seg-btn is-on" data-swing="meet" aria-pressed="true">ミート</button>
      <button type="button" class="tu-seg-btn" data-swing="power" aria-pressed="false">強振</button>
      <button type="button" class="tu-seg-btn" data-swing="bunt" aria-pressed="false">バント</button>
    </div>
  </div>
  <div class="tu-act">
    <button type="button" class="tu-round tu-x" data-key="x" aria-label="X"><b data-tu="xb">X</b><small data-tu="x">強振</small></button>
    <button type="button" class="tu-round tu-z" data-key="z" aria-label="Z"><b data-tu="zb">Z</b><small data-tu="z">ミート</small></button>
  </div>
  <div class="tu-top">
    <button type="button" class="tu-pill tu-subs" data-act="subs">さいはい</button>
    <button type="button" class="tu-pill tu-menu" data-act="menu">メニュー</button>
  </div>`;
  body.appendChild(ui);
  const q = (s) => ui.querySelector(s);
  const tu = {
    z: q('[data-tu="z"]'), x: q('[data-tu="x"]'), zb: q('[data-tu="zb"]'), xb: q('[data-tu="xb"]'),
    steal: q('.tu-steal'), subs: q('.tu-subs'), mini: q('.tu-mini'), seg: [...ui.querySelectorAll('[data-swing]')],
  };
  const vibrate = (ms) => { try { navigator.vibrate?.(ms); } catch (er) { /* ignore */ } };

  /* ---- ボタン（マルチタッチ: ボタンごとに pointer を捕まえる） ---- */
  const active = new Map(); // button → { id: pointerId, key: 押したときのキー }
  const game = () => { try { return getCurrent() === 'game' ? getGame() : null; } catch (e) { return null; } };
  function press(btn, e) {
    if (active.has(btn)) return;
    let key = btn.dataset.key;
    // 打席の大ボタンは「スイング」（選んだ打ち方で振る）
    if (key === 'z' && ui.dataset.mode === 'play' && ui.dataset.step === 'bat') key = 'swing';
    active.set(btn, { id: e ? e.pointerId : -1, key });
    btn.classList.add('is-down');
    if (key === 'z' || key === 'x' || key === 'swing') vibrate(10);
    try { game()?.handleKey(key); } catch (er) { console.error(er); }
    sync();
  }
  function release(btn) {
    const a = active.get(btn);
    if (!a) return;
    active.delete(btn);
    btn.classList.remove('is-down');
    try { game()?.handleKeyUp?.(a.key); } catch (er) { console.error(er); }
  }
  function releaseAll() { [...active.keys()].forEach(release); endDrag(); }
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  let sync = () => {}; // 下で定義（ボタンを押した直後にも呼ぶ）

  ui.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      press(btn, e);
    });
    const up = (e) => { if (active.get(btn)?.id === e.pointerId) release(btn); };
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
  // 打ち方の切り替え（ミート / 強振 / バント）
  tu.seg.forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (btn.classList.contains('is-disabled')) return;
      let ok = false;
      try { ok = !!game()?.setSwingMode?.(btn.dataset.swing); } catch (er) { console.error(er); }
      if (ok) vibrate(6);
      btn.classList.add('is-down');
      sync();
    });
    const up = () => btn.classList.remove('is-down');
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  });
  ui.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---- 球種パネルのタップ・ゾーンのタップ・フィールドのドラッグ ---- */
  const TAP_SLOP = 10; // これ以上動いたらドラッグ（スイングしない）
  /** 画面座標 → ステージ座標（1280×720。ステージは拡大縮小されて中央寄せ） */
  function toStage(cx, cy) {
    const r = stage.getBoundingClientRect();
    const s = r.width > 0 ? r.width / 1280 : (Number(getScale()) || 1);
    return { x: (cx - r.left) / s, y: (cy - r.top) / s };
  }
  /** 指が触れた時刻（performance.now 基準。event.timeStamp が別基準の古い端末では今） */
  function evTime(e) {
    const n = performance.now();
    const t = Number(e.timeStamp);
    return Number.isFinite(t) && t > 0 && t <= n + 5 && n - t < 1000 ? t : n;
  }
  let drag = null; // { id, x, y, x0, y0, t, moved, zone, p }
  function endDrag(cancelZone = true) {
    const d = drag;
    drag = null;
    if (cancelZone && d?.zone && !d.moved) { try { game()?.touchZoneCancel?.(); } catch (er) { console.error(er); } }
  }
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !body.classList.contains('touch')) return;
    const g = game();
    if (!g || isRotateBlocking()) return;
    // 球種パネル: 球種名 = その球種、マスの余白 = そのマスの球種。選択中をもう一度 = 決定
    const dial = e.target.closest?.('.pitch-dial.show');
    if (dial) {
      e.preventDefault();
      const pe = e.target.closest('[data-pitch]');
      const slot = e.target.closest('[data-dir]');
      if ((pe || slot) && typeof g.tapPitch === 'function') {
        let r = null;
        try { r = g.tapPitch(pe ? Number(pe.dataset.pitch) : null, slot?.dataset.dir || ''); } catch (er) { console.error(er); }
        if (r) vibrate(r === 'confirm' ? 12 : 6);
        sync();
      }
      return;
    }
    if (drag || typeof g.dragCursor !== 'function') return;
    if (e.clientX > window.innerWidth * 0.72) return; // 右側は Z/X 用に空けておく
    if (e.target.closest?.('button, input, select, textarea, a, .sb, .fv, .opp-modal')) return;
    const p = toStage(e.clientX, e.clientY);
    let zone = false;
    try { zone = !!g.touchZoneDown?.(p.x, p.y); } catch (er) { console.error(er); }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: evTime(e), moved: false, zone, p };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < TAP_SLOP) return;
      drag.moved = true; // ここからドラッグ: 触れた位置からの移動をまとめて反映
      if (drag.zone) { try { game()?.touchZoneCancel?.(); } catch (er) { console.error(er); } }
    }
    const s = Number(getScale()) || 1;
    const dx = (e.clientX - drag.x) / s, dy = (e.clientY - drag.y) / s;
    drag.x = e.clientX; drag.y = e.clientY;
    try { game()?.dragCursor(dx, dy); } catch (er) { console.error(er); }
  });
  wrap.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    endDrag(false);
    if (d.moved || !d.zone) return;
    let r = null;
    try { r = game()?.touchZoneTap?.(d.p.x, d.p.y, d.t); } catch (er) { console.error(er); }
    if (r === 'swing') vibrate(12);
    sync();
  });
  wrap.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) endDrag(); });

  /* ---- 画面の状態に合わせてボタンの表示・ラベルを同期 ---- */
  const last = {};
  const set = (k, v, fn) => { if (last[k] !== v) { last[k] = v; fn(v); } };
  sync = function syncNow() {
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
    let info = { step: '', swingMode: 'meet', canBunt: false };
    if (mode === 'play') { try { info = g.touchInfo?.() || info; } catch (er) { /* ignore */ } }
    set('step', info.step || '', (v) => { ui.dataset.step = v; });
    const src = mode === 'field' ? fv : root;
    let zl = mode === 'field-cpu' ? 'スキップ' : (src.querySelector('[data-ref="z-label"]')?.textContent || '');
    let xl = src.querySelector('[data-ref="x-label"]')?.textContent || '';
    let zb = 'Z', xb = 'X';
    // 打席・投球では大ボタンを言葉に（スイング / 決定 / 投げる）。小さい字は打ち方・球種名
    const pitchName = () => root.querySelector('.dial-pitch.selected .dp-name')?.textContent
      || (root.querySelector('.pitch-item.selected')?.getAttribute('title') || '').split(' ')[0];
    const SW = { meet: 'ミート', power: '強振', bunt: 'バント' };
    if (info.step === 'bat') { zb = 'スイング'; zl = SW[info.swingMode] || 'ミート'; xb = '強振'; xl = ''; }
    else if (info.step === 'select') { zb = '決定'; zl = pitchName(); }
    else if (info.step === 'aim') { zb = '投げる'; zl = pitchName(); xb = '球種'; xl = ''; }
    else if (info.step === 'windup') { zb = '投げる'; zl = 'もう一度'; }
    set('z', zl, (v) => { tu.z.textContent = v; });
    set('x', xl, (v) => { tu.x.textContent = v; });
    set('zb', zb, (v) => { tu.zb.textContent = v; tu.zb.classList.toggle('tu-word', v.length > 1); });
    set('xb', xb, (v) => { tu.xb.textContent = v; tu.xb.classList.toggle('tu-word', v.length > 1); });
    set('swing', info.swingMode || 'meet', (v) => tu.seg.forEach((b) => {
      const on = b.dataset.swing === v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }));
    set('canBunt', !!info.canBunt, (v) => tu.seg.find((b) => b.dataset.swing === 'bunt')?.classList.toggle('is-disabled', !v));
    const mini = root.querySelector('[data-ref="mini-btns"]');
    set('mini', !!mini && mini.style.display !== 'none', (v) => tu.mini.classList.toggle('is-off', !v));
    const steal = root.querySelector('[data-ref="steal-btn"]');
    set('steal', !!steal?.classList.contains('is-disabled'), (v) => tu.steal.classList.toggle('is-disabled', v));
    const subs = root.querySelector('[data-ref="subs"]');
    set('subs', !!subs?.classList.contains('is-disabled'), (v) => tu.subs.classList.toggle('is-disabled', v));
  };
  setInterval(() => sync(), 100);

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
