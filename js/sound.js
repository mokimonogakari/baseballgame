/* WebAudio-synthesized sound effects. No audio files. Every call is safe/no-throw. */
export function createSound({ enabled = true } = {}) {
  let on = !!enabled;
  let ac = null, master = null, noiseBuf = null, pinkBuf = null;

  function ensure() {
    if (ac) return ac;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
      const len = ac.sampleRate * 2;
      noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      pinkBuf = ac.createBuffer(1, len, ac.sampleRate);
      const p = pinkBuf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        p[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
      }
    } catch (e) { ac = null; }
    return ac;
  }

  function unlock() {
    try { const c = ensure(); if (c && c.state === 'suspended') c.resume(); } catch (e) { /* ignore */ }
  }

  function env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function noise(t, dur, { type = 'bandpass', f0 = 1000, f1 = f0, q = 1, peak = 0.5, a = 0.01, buf } = {}) {
    const s = ac.createBufferSource(); s.buffer = buf || noiseBuf;
    s.loop = true;
    const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain(); env(g, t, a, peak, dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  function tone(t, freq, dur, { type = 'sine', peak = 0.3, a = 0.01, f1 } = {}) {
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain(); env(g, t, a, peak, dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function crack(t) {
    noise(t, 0.09, { type: 'highpass', f0: 1800, f1: 900, peak: 0.9, a: 0.002 });
    tone(t, 1200, 0.06, { type: 'square', peak: 0.35, a: 0.001, f1: 700 });
    tone(t, 180, 0.12, { type: 'sine', peak: 0.5, a: 0.002, f1: 70 });
  }
  function speak(text, fallbackFreq, t) {
    try {
      const ss = window.speechSynthesis;
      if (ss && typeof SpeechSynthesisUtterance !== 'undefined') {
        ss.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP'; u.rate = 1.1; u.volume = 0.9;
        ss.speak(u);
        return;
      }
    } catch (e) { /* fall through */ }
    tone(t, fallbackFreq, 0.18, { type: 'triangle', peak: 0.3 });
  }

  const SOUNDS = {
    pitch(t) { noise(t, 0.35, { f0: 400, f1: 2500, q: 2, peak: 0.35, a: 0.12 }); },
    swing(t) { noise(t, 0.16, { f0: 3000, f1: 500, q: 1.5, peak: 0.5, a: 0.03 }); },
    hit(t) { crack(t); },
    homerun(t) {
      crack(t);
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(t + 0.25 + i * 0.13, f, i === 3 ? 0.6 : 0.16, { type: 'square', peak: 0.18, a: 0.01 }));
    },
    strike(t) { speak('ストライク！', 520, t); tone(t, 800, 0.05, { type: 'square', peak: 0.12 }); },
    ball(t) { speak('ボール', 330, t); },
    out(t) { speak('アウト！', 260, t); },
    cheer(t) { noise(t, 1.2, { type: 'bandpass', f0: 700, f1: 1400, q: 0.6, peak: 0.6, a: 0.5, buf: pinkBuf }); },
    catch(t) {
      tone(t, 160, 0.12, { peak: 0.7, a: 0.002, f1: 60 });
      noise(t, 0.06, { type: 'lowpass', f0: 1200, f1: 400, peak: 0.4, a: 0.002 });
    },
    gameset(t) {
      for (let i = 0; i < 3; i++) tone(t + i * 0.3, 2400 + (i % 2) * 120, 0.25, { type: 'sine', peak: 0.2, a: 0.02 });
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(t + 1 + i * 0.14, f, 0.2, { type: 'triangle', peak: 0.22 }));
    },
    select(t) { tone(t, 660, 0.06, { type: 'square', peak: 0.1, a: 0.002 }); },
    decide(t) {
      tone(t, 660, 0.07, { type: 'square', peak: 0.12, a: 0.002 });
      tone(t + 0.07, 990, 0.1, { type: 'square', peak: 0.12, a: 0.002 });
    },
  };

  function play(name) {
    if (!on) return;
    try {
      const fn = SOUNDS[name];
      if (!fn) return;
      const c = ensure();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      fn(c.currentTime + 0.005);
    } catch (e) { /* never throw */ }
  }
  function setEnabled(v) {
    on = !!v;
    if (!on) { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
  }
  return { play, setEnabled, unlock };
}
