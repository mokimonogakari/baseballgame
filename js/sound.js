/* WebAudio sound effects (synthesized) + recorded umpire voice clips
 * (assets/voice/*, generated with VOICEVOX:青山龍星 — see assets/voice/CREDITS.md).
 * Every call is safe/no-throw. */

// Voice clip variants per play name. A random variant is chosen on each call.
const VOICE_CLIPS = {
  strike: ['strike', 'strike2'],
  strikeout: ['strikeout'],
  out: ['out', 'out2'],
  ball: ['ball'],
  foul: ['foul'],
};
// Per-call gain (relative to the voice bus). Ball is called calmer.
const VOICE_LEVEL = { strike: 1, strikeout: 1, out: 1, ball: 0.75, foul: 0.85 };
// speechSynthesis fallback text when a clip cannot be loaded.
const VOICE_TEXT = {
  strike: 'ストラーイク！', strikeout: 'ストライク、バッターアウト！', out: 'アウトォ！',
  ball: 'ボール', foul: 'ファウルボール！',
};
const VOICE_DIR = 'assets/voice/';

function pickExt() {
  try {
    const a = document.createElement('audio');
    if (a.canPlayType && a.canPlayType('audio/ogg; codecs="vorbis"')) return ['ogg', 'mp3'];
  } catch (e) { /* ignore */ }
  return ['mp3', 'ogg'];
}

export function createSound({ enabled = true } = {}) {
  let on = !!enabled;
  let ac = null, master = null, voiceBus = null, noiseBuf = null, pinkBuf = null;
  // clip id -> AudioBuffer | null (failed); missing key = still loading
  const voiceBufs = {};
  const voiceBytes = {};
  let voiceLoad = null;
  let curVoice = null;

  // Start downloading clip bytes right away (no AudioContext needed for fetch).
  const exts = pickExt();
  async function fetchClip(id) {
    if (typeof fetch !== 'function') throw new Error('no fetch');
    let lastErr;
    for (const ext of exts) {
      try {
        const r = await fetch(VOICE_DIR + id + '.' + ext);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return { ext, buf: await r.arrayBuffer() };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('load failed');
  }
  const clipIds = [...new Set(Object.values(VOICE_CLIPS).flat())];
  try {
    for (const id of clipIds) {
      voiceBytes[id] = fetchClip(id);
      voiceBytes[id].catch(() => {}); // handled in decode
    }
  } catch (e) { /* ignore */ }

  function decode(c, data) {
    return new Promise((res, rej) => {
      try {
        const p = c.decodeAudioData(data, res, rej);
        if (p && typeof p.then === 'function') p.then(res, rej);
      } catch (e) { rej(e); }
    });
  }
  function loadVoices(c) {
    if (voiceLoad) return voiceLoad;
    voiceLoad = Promise.all(clipIds.map(async (id) => {
      try {
        const got = await voiceBytes[id];
        try {
          voiceBufs[id] = await decode(c, got.buf.slice(0));
        } catch (e) {
          // decoding failed for this format: try the other one
          const alt = exts.find((x) => x !== got.ext);
          const r = await fetch(VOICE_DIR + id + '.' + alt);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          voiceBufs[id] = await decode(c, await r.arrayBuffer());
        }
      } catch (e) {
        voiceBufs[id] = null;
      }
    })).then(() => {
      const ok = clipIds.filter((id) => voiceBufs[id]);
      return { loaded: ok, failed: clipIds.filter((id) => !voiceBufs[id]) };
    }).catch(() => ({ loaded: [], failed: clipIds.slice() }));
    return voiceLoad;
  }

  function ensure() {
    if (ac) return ac;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = (window.__dokiAudioCtx && typeof window.__dokiAudioCtx.createGain === 'function')
        ? window.__dokiAudioCtx : new AC();
      if (!window.__dokiAudioCtx) window.__dokiAudioCtx = ac;
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
      // Umpire voice sits a little above the SFX bus.
      voiceBus = ac.createGain();
      voiceBus.gain.value = 0.8;
      voiceBus.connect(ac.destination);
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
    if (ac) { try { loadVoices(ac); } catch (e) { /* ignore */ } }
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
        u.lang = 'ja-JP'; u.rate = 0.9; u.pitch = 0.6; u.volume = 1;
        ss.speak(u);
        return;
      }
    } catch (e) { /* fall through */ }
    tone(t, fallbackFreq, 0.18, { type: 'triangle', peak: 0.3 });
  }
  // Play a recorded umpire call; falls back to speechSynthesis if unavailable.
  function voice(name, fallbackFreq, t) {
    const ids = VOICE_CLIPS[name] || [];
    const ready = ids.filter((id) => voiceBufs[id]);
    if (!ready.length) { speak(VOICE_TEXT[name] || '', fallbackFreq, t); return; }
    const id = ready[Math.floor(Math.random() * ready.length)];
    try { if (curVoice) curVoice.stop(); } catch (e) { /* ignore */ }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    const src = ac.createBufferSource();
    src.buffer = voiceBufs[id];
    const g = ac.createGain();
    g.gain.value = VOICE_LEVEL[name] != null ? VOICE_LEVEL[name] : 1;
    src.connect(g); g.connect(voiceBus);
    src.onended = () => { if (curVoice === src) curVoice = null; try { g.disconnect(); } catch (e) { /* ignore */ } };
    src.start(t);
    curVoice = src;
  }

  const SOUNDS = {
    pitch(t) { noise(t, 0.35, { f0: 400, f1: 2500, q: 2, peak: 0.35, a: 0.12 }); },
    swing(t) { noise(t, 0.16, { f0: 3000, f1: 500, q: 1.5, peak: 0.5, a: 0.03 }); },
    hit(t) { crack(t); },
    homerun(t) {
      crack(t);
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(t + 0.25 + i * 0.13, f, i === 3 ? 0.6 : 0.16, { type: 'square', peak: 0.18, a: 0.01 }));
    },
    strike(t) { voice('strike', 520, t); },
    strikeout(t) { voice('strikeout', 520, t); },
    ball(t) { voice('ball', 330, t); },
    out(t) { voice('out', 260, t); },
    foul(t) { voice('foul', 400, t); },
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
    if (!on) {
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      try { if (curVoice) curVoice.stop(); } catch (e) { /* ignore */ }
      curVoice = null;
    }
  }
  // Optional: resolves to { loaded: [...ids], failed: [...ids] } once clips are decoded.
  function voiceReady() {
    try {
      const c = ensure();
      if (!c) return Promise.resolve({ loaded: [], failed: clipIds.slice() });
      return loadVoices(c);
    } catch (e) { return Promise.resolve({ loaded: [], failed: clipIds.slice() }); }
  }
  return { play, setEnabled, unlock, voiceReady };
}
