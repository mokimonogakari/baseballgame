import { judgeSwing, pitchDuration } from './challenge-model.mjs';

export function openChallenge({ sound, onClose }) {
  const root = document.createElement('section');
  root.id = 'challenge';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '10球ホームランチャレンジ');
  root.innerHTML = `<header><button data-exit>もどる</button><b>10球チャレンジ</b><button data-pause>休けい</button></header>
    <div class="ch-score"><span data-balls>1 / 10 球</span><strong data-score>0 点</strong><span data-combo>まずは1本！</span></div>
    <canvas aria-label="ボールが手前の黄色い輪に来たらスイング"></canvas>
    <div class="ch-message" aria-live="polite">黄色い輪に ボールがきたら タップ！</div>
    <div class="ch-progress" aria-label="10球の結果"></div>
    <button class="ch-swing">はじめる ▶</button><small>片手でOK · スイングだけで遊べる · Spaceキーも対応</small>`;
  document.body.append(root);
  document.body.classList.add('challenge-open');
  const prevFocus = document.activeElement;
  const wrap = document.getElementById('stage-wrap');
  wrap.inert = true;
  const q = s => root.querySelector(s);
  const cv = q('canvas'), c = cv.getContext('2d'), btn = q('.ch-swing');
  let state = 'intro', paused = false, elapsed = 0, ball = 0, score = 0, combo = 0, hrs = 0;
  let last = 0, raf, result = null, alive = true, best = 0, w = 0, h = 0, pausedMessage = '';
  try { best = Math.max(0, Number(localStorage.getItem('dokidoki.challenge.best')) || 0); } catch {}
  function resize() {
    const r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    w = r.width; h = r.height; cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    c.setTransform(d, 0, 0, d, 0, 0);
  }
  const observer = new ResizeObserver(resize); observer.observe(cv);
  function message(text) { q('.ch-message').textContent = text; }
  function next() {
    btn.setAttribute('aria-disabled', 'false');
    state = 'pitch'; elapsed = 0; result = null;
    q('[data-balls]').textContent = `${ball + 1} / 10 球`;
    btn.textContent = 'スイング！';
    message(ball < 2 ? '黄色い輪まで ひきつけよう！' : 'ボールを よくみて！');
  }
  function finishPitch(offset) {
    if (state !== 'pitch') return;
    result = judgeSwing(offset, combo); combo = result.combo; score += result.points;
    if (result.kind === 'hr') hrs++;
    if (result.kind === 'hr') sound.say?.('ホームラン！');
    q('[data-score]').textContent = `${score} 点`;
    q('[data-combo]').textContent = combo > 1 ? `${combo} 連続ヒット！` : 'つぎも ねらおう！';
    message(result.kind === 'hr' ? `ホームラン！ +${result.points}` : result.kind === 'hit' ? `ヒット！ +${result.points}` : result.hint);
    const mark = document.createElement('span'); mark.textContent = result.kind === 'hr' ? '★' : result.kind === 'hit' ? '●' : '−';
    mark.className = result.kind; q('.ch-progress').append(mark);
    sound.play(result.kind === 'hr' ? 'homerun' : result.kind === 'miss' ? 'swing' : 'hit');
    state = 'result'; elapsed = 0; ball++; btn.textContent = 'ナイスチャレンジ！'; btn.setAttribute('aria-disabled', 'true');
  }
  function complete() {
    sound.say?.('ナイスチャレンジ！ もう一回あそぼう！');
    btn.setAttribute('aria-disabled', 'false');
    state = 'done'; btn.disabled = false; btn.textContent = 'もういっかい ▶';
    const record = score > best; best = Math.max(score, best);
    try { localStorage.setItem('dokidoki.challenge.best', String(best)); } catch {}
    message(`${record ? '自己ベスト！ ' : ''}${hrs}本塁打 · ベスト ${best}点`);
    q('[data-combo]').textContent = hrs >= 7 ? '🏆 ホームラン王' : hrs >= 3 ? '⭐ 強打者' : '⚾ また挑戦しよう';
  }
  function swing() {
    if (paused) return;
    if (state === 'intro' || state === 'done') {
      ball = score = combo = hrs = 0; q('.ch-progress').replaceChildren(); q('[data-score]').textContent = '0 点'; q('[data-combo]').textContent = 'まずは1本！'; next();
    } else if (state === 'pitch') finishPitch(elapsed - pitchDuration(ball));
  }
  btn.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); swing(); });
  btn.addEventListener('click', e => { if (e.detail === 0) swing(); });
  function pause(value) {
    if (paused === value) return;
    if (value) pausedMessage = q('.ch-message').textContent;
    paused = value; last = 0; btn.disabled = paused;
    q('[data-pause]').textContent = paused ? 'つづける' : '休けい';
    if (paused) message('休けい中 · つづける を押して再開');
    else message(pausedMessage);
  }
  q('[data-pause]').onclick = () => pause(!paused);
  function hidden() { if (document.hidden) pause(true); }
  document.addEventListener('visibilitychange', hidden);
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); pause(!paused); }
    if (e.code === 'Space' && e.target === btn) { e.preventDefault(); if (!e.repeat) swing(); }
    if (e.key === 'Tab') {
      const focusable = [...root.querySelectorAll('button:not(:disabled)')];
      const i = focusable.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); focusable.at(-1).focus(); }
      else if (!e.shiftKey && i === focusable.length - 1) { e.preventDefault(); focusable[0].focus(); }
    }
  }
  root.addEventListener('keydown', key);
  q('[data-exit]').onclick = () => {
    alive = false; cancelAnimationFrame(raf); observer.disconnect(); document.removeEventListener('visibilitychange', hidden);
    root.remove(); wrap.inert = false; document.body.classList.remove('challenge-open'); onClose(); prevFocus?.focus();
  };
  function draw() {
    if (!w || !h) return;
    const sky = c.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#122848'); sky.addColorStop(1, '#539b9a');
    c.fillStyle = sky; c.fillRect(0, 0, w, h);
    c.fillStyle = '#e7b970'; c.beginPath(); c.moveTo(w * .5, h * .3); c.lineTo(w, h); c.lineTo(0, h); c.fill();
    for (let i = 0; i < 24; i++) { c.fillStyle = i % 2 ? '#ffd95d' : '#ffffff'; c.fillRect(i * w / 24, h * .19, 5, 5); }
    const cy = h * .79;
    c.strokeStyle = '#ffe166'; c.lineWidth = 5; c.beginPath(); c.ellipse(w / 2, cy, 35, 19, 0, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#fff'; c.font = 'bold 14px system-ui'; c.textAlign = 'center'; c.fillText('ここで 打つ！', w / 2, cy + 40);
    c.fillStyle = '#ef5958'; c.beginPath(); c.arc(w / 2, h * .28, 11, 0, 7); c.fill();
    c.fillStyle = '#fff'; c.fillRect(w / 2 - 9, h * .28 + 12, 18, 22);
    // A visible bat follows the swing; the field remains clear of controls.
    c.save(); c.translate(w * .22, h * .85);
    c.rotate(state === 'result' ? -1.4 + Math.min(1, elapsed * 5) * 1.8 : -.45);
    c.strokeStyle = '#bb652f'; c.lineWidth = 10; c.lineCap = 'round'; c.beginPath(); c.moveTo(0, 15); c.lineTo(0, -48); c.stroke();
    c.strokeStyle = '#ffe2a3'; c.lineWidth = 16; c.beginPath(); c.moveTo(0, -15); c.lineTo(0, -48); c.stroke(); c.restore();
    if (state === 'result' && result?.kind === 'hr') {
      for (let i = 0; i < 22; i++) { c.fillStyle = ['#ffe166','#ff738b','#91efca'][i % 3]; c.fillRect((i * 47 % w), (i * 37 + elapsed * 150) % h, 6, 10); }
    }
    if (state === 'pitch' || (state === 'result' && result?.kind !== 'miss')) {
      let x = w / 2, y, radius;
      if (state === 'pitch') { const p = elapsed / pitchDuration(ball); y = h * .34 + (cy - h * .34) * p * p; radius = 5 + Math.min(1.3, p) * 10; }
      else { const p = Math.min(1, elapsed / 1.1); x += Math.sin(p * 2) * w * .3; y = cy - p * h; radius = Math.max(3, 15 - p * 12); }
      c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, radius, 0, 7); c.fill(); c.strokeStyle = '#e45967'; c.lineWidth = 2; c.stroke();
    }
    if (paused) { c.fillStyle = '#10203999'; c.fillRect(0, 0, w, h); c.fillStyle = '#fff'; c.font = 'bold 28px system-ui'; c.fillText('ひとやすみ', w / 2, h / 2); }
  }
  function frame(t) {
    if (!alive) return;
    const dt = last ? Math.min(.05, (t - last) / 1000) : 0; last = t;
    if (!paused) {
      elapsed += dt;
      if (state === 'pitch' && elapsed > pitchDuration(ball) + .32) finishPitch(.33);
      else if (state === 'result' && elapsed > 1.25) { btn.disabled = false; if (ball === 10) complete(); else next(); }
    }
    draw(); raf = requestAnimationFrame(frame);
  }
  resize(); raf = requestAnimationFrame(frame); btn.focus();
}
