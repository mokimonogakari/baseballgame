import { chibiHTML } from './screens.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEEN_KEY = 'dokidoki.guideSeen';

const isTouch = () => document.body.classList.contains('touch');
function guideSeen() { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return true; } }
function markSeen() { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ } }

/** 設定から「いまのルール」チップ用の文言を作る */
export function modeChips(s = {}) {
  const ba = s.battingAssist;
  const baName = ba === 0 ? 'なし' : ba === 1 ? 'よわめ' : ba === 2 ? 'つよめ' : ba === 3 ? 'さいだい' : (isTouch() ? 'つよめ' : 'なし');
  const pit = s.pitchMode === 'cpu' ? 'CPU' : '自分';
  const fld = s.fieldMode === 'manual' ? '自分' : s.fieldMode === 'auto' ? 'オート' : 'アシスト';
  return [
    ['打撃アシスト', baName], ['投球', pit], ['守備', fld], [`${s.innings || 3}回制`, ''],
  ];
}

/* ---------- あそびかたガイド ---------- */
const ILLU = {
  move: `<svg viewBox="0 0 120 90" aria-hidden="true"><rect x="30" y="8" width="60" height="74" rx="6" fill="#fff" stroke="#1C2B4B" stroke-width="4"/><path d="M50 8v74M70 8v74M30 33v24M90 33v24M30 33h60M30 57h60" stroke="#B8C4DB" stroke-width="2" fill="none"/><circle cx="76" cy="46" r="13" fill="none" stroke="#E5484D" stroke-width="5"/><path d="M76 46l16 14" stroke="#1C2B4B" stroke-width="5" stroke-linecap="round"/></svg>`,
  swing: `<svg viewBox="0 0 120 90" aria-hidden="true"><circle cx="30" cy="30" r="10" fill="#fff" stroke="#1C2B4B" stroke-width="4"/><path d="M42 36l16 8" stroke="#FFD54A" stroke-width="5" stroke-dasharray="3 8" stroke-linecap="round"/><path d="M70 74L100 20" stroke="#C9955F" stroke-width="10" stroke-linecap="round"/><path d="M70 74L100 20" stroke="#1C2B4B" stroke-width="3" stroke-linecap="round" opacity=".4"/><path d="M80 14q16 4 22 22" fill="none" stroke="#E5484D" stroke-width="5" stroke-linecap="round"/></svg>`,
  throw: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M60 14l34 30-34 30-34-30z" fill="#C9955F" stroke="#1C2B4B" stroke-width="4"/><g fill="#fff" stroke="#1C2B4B" stroke-width="3"><rect x="52" y="6" width="16" height="16" transform="rotate(45 60 14)"/><rect x="86" y="36" width="16" height="16" transform="rotate(45 94 44)"/><rect x="18" y="36" width="16" height="16" transform="rotate(45 26 44)"/><rect x="52" y="66" width="16" height="16" transform="rotate(45 60 74)"/></g><path d="M60 70Q92 50 92 50" fill="none" stroke="#E5484D" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 9"/></svg>`,
};
function stepsFor(kind) {
  if (kind === 'touch') {
    return [
      { n: '①', t: 'カーソルを動かして', d: '画面をなぞるとミートカーソルが動くよ。十字キーでもOK', i: ILLU.move },
      { n: '②', t: 'タイミングよく打つ', d: 'ボールが来たらゾーンをタップ！「ミート・強振・バント」を選べる', i: ILLU.swing },
      { n: '③', t: '投げる・守る', d: '投球は狙ってタップ。守備はとったあと、投げる塁をタップ', i: ILLU.throw },
    ];
  }
  return [
    { n: '①', t: 'カーソルを動かして', d: '矢印キーでミートカーソルを動かす（Vで中央へ）', i: ILLU.move },
    { n: '②', t: 'タイミングよく打つ', d: 'Z：ミート　X：強振　C：バント　Enter：見送り', i: ILLU.swing },
    { n: '③', t: '投げる・守る', d: '投球：矢印でコース→Z。守備：矢印で動いてZでキャッチ、矢印＋Zで送球', i: ILLU.throw },
  ];
}

let openOverlay = null;
export function isGuideOpen() { return !!openOverlay; }
export function closeGuide() {
  if (!openOverlay) return;
  const o = openOverlay;
  openOverlay = null;
  o.remove();
  try { document.activeElement?.blur?.(); } catch (e) { /* ignore */ }
}

export function openGuide(host, { first = false } = {}) {
  closeGuide();
  markSeen();
  let kind = isTouch() ? 'touch' : 'key';
  const ov = document.createElement('div');
  ov.className = 'guide-ov';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'あそびかた');
  ov.__prevFocus = document.activeElement;
  const draw = () => {
    ov.innerHTML = `<div class="gd-card">
      <div class="gd-head"><h2>あそびかた</h2>
        <div class="gd-tabs" role="tablist">
          <button type="button" class="gd-tab${kind === 'key' ? ' on' : ''}" data-kind="key">キーボード</button>
          <button type="button" class="gd-tab${kind === 'touch' ? ' on' : ''}" data-kind="touch">タッチ</button>
        </div></div>
      <div class="gd-steps">${stepsFor(kind).map((s) => `<div class="gd-step"><div class="gd-num">${s.n}</div><div class="gd-ill">${s.i}</div><h3>${esc(s.t)}</h3><p>${esc(s.d)}</p></div>`).join('')}</div>
      <button type="button" class="gd-close" data-act="close">${first ? 'わかった！ はじめよう ▶' : 'とじる'}</button>
      <p class="gd-note">タイトルの「あそびかた」でいつでも見られるよ（Enter / Esc でとじる）</p>
    </div>`;
    ov.querySelectorAll('.gd-tab').forEach((b) => (b.onclick = () => { kind = b.dataset.kind; draw(); ov.querySelector(`.gd-tab.on`)?.focus(); }));
    ov.querySelector('[data-act="close"]').onclick = closeGuide;
  };
  draw();
  ov.addEventListener('click', (e) => { if (e.target === ov) closeGuide(); });
  host.appendChild(ov);
  openOverlay = ov;
  ov.querySelector('[data-act="close"]').focus({ preventScroll: true });
}

/* ---------- タイトル ---------- */
export function renderTitle(el, ctx) {
  openOverlay = null;
  const { user, opp } = ctx.matchup();
  const chip = (t) => `<span class="mchip" style="--c:${esc(t.color)}">${esc(t.short)}</span>`;
  const chips = modeChips(ctx.settings).map(([a, b]) => `<span class="rule-chip">${b ? `${esc(a)}<b>${esc(b)}</b>` : `<b>${esc(a)}</b>`}</span>`).join('');
  el.innerHTML = `<div class="title" style="position:absolute;inset:0">
    <div class="cloud c1"></div><div class="cloud c2"></div><div class="cloud c3"></div>
    <div class="stand"></div><div class="stand-line"></div>
    <div class="grass"></div><div class="grass-stripe s1"></div><div class="grass-stripe s2"></div>
    <div class="dirt"></div>
    <div class="logo">
      <div class="logo-kicker">ぼくらの熱闘 野球ゲーム</div>
      <h1>ドキドキ<span class="logo-accent">ベースボール</span></h1>
    </div>
    <div class="tt-col">
      <button type="button" class="tt-match" data-act="team" aria-label="タップでチーム変更（${esc(user.name)} 対 ${esc(opp ? opp.name : '')}）">
        <span class="tt-side">${chip(user)}<span class="tt-who"><small>あなた</small><span class="tt-name">${esc(user.name)}</span></span></span>
        <span class="tt-vsbox"><span class="tt-vs">VS</span><small>チーム変更</small></span>
        <span class="tt-side">${opp ? chip(opp) : ''}<span class="tt-who"><small>あいて</small><span class="tt-name">${esc(opp ? opp.name : '')}</span></span></span>
      </button>
      <div class="tt-rules" aria-label="いまのルール">${chips}</div>
      <button type="button" class="tt-play" data-act="game"><span>試合をはじめる</span><i>▶</i></button>
      <div class="tt-grid">
        <button type="button" class="tt-sub" data-act="challenge"><b>⚾ 10球チャレンジ</b><small>すぐ遊べる打撃ゲーム</small></button>
        <button type="button" class="tt-sub" data-act="team"><b>チーム・選手</b><small>能力を見る</small></button>
        <button type="button" class="tt-sub" data-act="teamedit"><b>オリジナルチーム</b><small>自分のチームを作る</small></button>
        <button type="button" class="tt-sub" data-act="settings"><b>せってい</b><small>操作・難しさ・音</small></button>
      </div>
    </div>
    <div class="hero">${chibiHTML(user.color, user.number ?? 1, 1.4)}</div>
    <button type="button" class="tt-help" data-act="guide"><b>？ あそびかた</b><small>3ステップでわかる</small></button>
    <div class="footer"><span>GitHub Pages で配信 ・ 球審ボイス VOICEVOX:青山龍星</span><span>v0.4</span></div>
  </div>`;
  const on = (act, fn) => el.querySelectorAll(`[data-act="${act}"]`).forEach((b) => (b.onclick = fn));
  on('game', () => ctx.go('game'));
  on('challenge', () => ctx.openChallenge());
  on('team', () => ctx.go('team'));
  on('teamedit', () => ctx.go('teamedit'));
  on('settings', () => ctx.go('settings'));
  on('guide', () => openGuide(el));
  if (!guideSeen()) openGuide(el, { first: true });
}
