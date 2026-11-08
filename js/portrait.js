/**
 * 縦向き（スマホを縦に持ったとき）の試合画面の情報バー（#p-hud）
 *
 * 縦向きでは 1280×720 のステージの中央（ゾーン・投手・打者）だけを切り出して大きく見せるため、
 * 横向きのスコアボード（ヘッダー）と左右の投手・打者パネルは画面の外になる。
 * その代わりに画面の上へ実寸（CSS px）の情報バーを出す。中身は試合画面の DOM（game.js の render() が
 * 毎回更新するスコア・カウント・パネル）を写すだけなので、ゲームの処理には手を入れない。
 *
 * export createPortraitHud({ getRoot }) → { el, sync(), height() }
 *   getRoot(): 試合画面の section（試合中でなければ null）
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createPortraitHud({ getRoot }) {
  const el = document.createElement('div');
  el.id = 'p-hud';
  el.setAttribute('aria-hidden', 'true'); // 同じ内容はステージ内のスコアボード・パネルにもある（読み上げの重複を避ける）
  el.innerHTML = `
  <div class="ph-score">
    <span class="ph-team"><i class="ph-badge" data-h="away-badge"></i><b class="ph-num" data-h="away"></b></span>
    <span class="ph-inning" data-h="inning"></span>
    <span class="ph-team"><b class="ph-num" data-h="home"></b><i class="ph-badge" data-h="home-badge"></i></span>
    <span class="ph-count"><span class="ph-c ph-b"><em>B</em><i></i><i></i><i></i></span><span class="ph-c ph-s"><em>S</em><i></i><i></i></span><span class="ph-c ph-o"><em>O</em><i></i><i></i></span></span>
    <span class="ph-runners"><i class="ph-base b2"></i><i class="ph-base b3"></i><i class="ph-base b1"></i></span>
  </div>
  <div class="ph-row ph-p"><em class="ph-role">投</em><b class="ph-name" data-h="p-name"></b><span class="ph-sub" data-h="p-meta"></span><span class="ph-velo" data-h="p-velo"></span><span class="ph-rk" data-h="p-power"></span><span class="ph-stam"><small>スタミナ</small><span class="ph-bar"><i data-h="p-stam-bar"></i></span><b data-h="p-stam"></b></span></div>
  <div class="ph-row ph-bt"><em class="ph-role">打</em><b class="ph-order" data-h="b-order"></b><b class="ph-name" data-h="b-name"></b><span class="ph-sub" data-h="b-hand"></span><span class="ph-abil" data-h="b-abil"></span></div>`;
  document.body.appendChild(el);
  const h = {};
  el.querySelectorAll('[data-h]').forEach((n) => (h[n.dataset.h] = n));
  const lamps = { b: el.querySelectorAll('.ph-b i'), s: el.querySelectorAll('.ph-s i'), o: el.querySelectorAll('.ph-o i') };
  const bases = [el.querySelector('.ph-base.b1'), el.querySelector('.ph-base.b2'), el.querySelector('.ph-base.b3')];
  const last = {};
  const put = (k, v, fn) => { if (last[k] !== v) { last[k] = v; fn(v); } };
  const text = (k, v) => put(k, v, (t) => { h[k].textContent = t; });
  const html = (k, v) => put(k, v, (t) => { h[k].innerHTML = t; });

  function sync() {
    if (!document.body.classList.contains('portrait')) return;
    const root = getRoot()?.querySelector('.game');
    if (!root) return;
    const q = (s) => root.querySelector(s);
    const t = (s) => q(s)?.textContent ?? '';
    for (const side of ['away', 'home']) {
      const b = q(`.hteam.${side} .team-badge`);
      put(`${side}-badge`, `${b?.textContent}|${b?.style.background}`, () => { h[`${side}-badge`].textContent = b?.textContent || ''; h[`${side}-badge`].style.background = b?.style.background || ''; });
      text(side, t(`[data-score="${side}"]`));
    }
    text('inning', t('[data-ref="inning"]'));
    for (const k of ['b', 's', 'o']) {
      const n = root.querySelectorAll(`[data-lamps="${k}"] .cl.on-${k}`).length;
      put(`lamp-${k}`, n, (v) => lamps[k].forEach((l, i) => l.classList.toggle('on', i < v)));
    }
    [0, 1, 2].forEach((i) => put(`base${i}`, !!q(`.runners [data-base="${i}"]`)?.classList.contains('on'), (v) => bases[i].classList.toggle('on', v)));
    // 投手: 名前・投げ方・球速・球威・スタミナ
    text('p-name', t('[data-ref="p-name"]'));
    text('p-meta', t('[data-ref="p-meta"]'));
    const velo = t('[data-ref="p-velo"]');
    html('p-velo', velo && velo !== '-' ? `<b>${esc(velo)}</b><small>km/h</small>` : '');
    const pw = q('[data-ref="p-power"]');
    const pwb = pw && pw.style.display !== 'none' ? pw.querySelector('b') : null;
    html('p-power', pwb ? `<small>球威</small><b style="background:${esc(pwb.style.background)};color:${esc(pwb.style.color)}">${esc(pwb.textContent)}</b>` : '');
    const stam = t('[data-ref="p-stamina-num"]');
    text('p-stam', stam);
    const bar = q('[data-ref="p-stamina"]');
    put('p-stam-bar', `${bar?.style.width}|${bar?.className}`, () => { h['p-stam-bar'].style.width = bar?.style.width || '0%'; h['p-stam-bar'].className = bar?.className || ''; });
    // 打者: 打順・名前・打席・ミート/パワー/走力
    const meta = t('[data-ref="b-meta"]'); // 例「1番・中堅手」
    text('b-order', meta.split('・')[0] || '');
    text('b-name', t('[data-ref="b-name"]'));
    text('b-hand', t('[data-ref="b-hand"]'));
    const abil = [...root.querySelectorAll('[data-ref="b-abilities"] .ability')].slice(1).map((a) => {
      const lb = a.querySelector('.ability-label')?.textContent || '';
      const bd = a.querySelector('.ability-badge');
      return `<span class="ph-ab"><small>${esc(lb)}</small><b style="background:${esc(bd?.style.background)};color:${esc(bd?.style.color)}">${esc(bd?.textContent)}</b></span>`;
    }).join('');
    html('b-abil', abil);
  }
  return { el, sync, height: () => el.offsetHeight || 0 };
}
