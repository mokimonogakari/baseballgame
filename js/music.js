/* Original procedural BGM (WebAudio step sequencer). All melodies are original compositions.
   Every public call is safe/no-throw. */

const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(name) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!m) return null;
  return (Number(m[3]) + 1) * 12 + NOTE_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const CH = {
  C: [60, 64, 67], G: [67, 71, 74], Am: [57, 60, 64], F: [53, 57, 60], Em: [64, 67, 71],
  Dm: [62, 65, 69], D: [62, 66, 69], E: [64, 68, 71],
};

/* "E5:2 G5:2 R:4" -> events of 16th-step positions within a bar */
function parseBar(str) {
  const out = []; let pos = 0;
  for (const tok of str.trim().split(/\s+/)) {
    const [n, l] = tok.split(':'); const len = Number(l);
    if (n !== 'R') { const m = midiOf(n); if (m != null) out.push({ pos, midi: m, len }); }
    pos += len;
  }
  return out;
}

const DR = {
  title: { k: 'x.....x.x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.xo', fill: true },
  game: { k: 'x.....x.x.....x.', s: '....x.......x.x.', h: '..x...x...x...x.', fill: false, soft: true },
  none: null,
};

const TRACKS = {
  title: {
    bpm: 132, level: 1, loopStart: 0, drums: 'title', arp: 0.06,
    lead: { wave: 'square', gain: 0.15, vib: 0 }, bassWave: 'triangle',
    bars: [
      ['C', 'E5:2 G5:2 C6:4 B5:2 G5:2 A5:4'],
      ['G', 'G5:2 B5:2 D6:4 C6:2 B5:2 G5:4'],
      ['Am', 'A5:2 C6:2 E6:4 D6:2 C6:2 A5:4'],
      ['F', 'A5:2 C6:2 F6:4 E6:2 D6:2 C6:4'],
      ['C', 'E6:3 D6:1 C6:2 G5:2 E5:2 G5:2 C6:4'],
      ['G', 'D6:3 C6:1 B5:2 G5:2 B5:2 D6:2 G5:4'],
      ['F', 'C6:2 A5:2 F5:2 A5:2 C6:4 A5:2 F5:2'],
      ['G', 'D6:2 D6:2 B5:2 G5:2 B5:2 C6:2 D6:4'],
      ['C', 'G5:4 C6:2 E6:2 G6:4 E6:4'],
      ['Em', 'E6:2 D6:2 B5:4 G5:2 B5:2 E6:4'],
      ['Am', 'C6:4 E6:2 A5:2 C6:4 B5:2 A5:2'],
      ['F', 'A5:2 C6:2 A5:2 F5:2 A5:4 C6:4'],
      ['Dm', 'D6:4 F6:2 D6:2 A5:4 D6:4'],
      ['G', 'B5:2 D6:2 G6:4 F6:2 D6:2 B5:4'],
      ['C', 'C6:2 E6:2 G6:2 E6:2 C6:2 E6:2 G6:4'],
      ['G', 'D6:2 F6:2 G6:2 B5:2 D6:4 R:4'],
    ],
  },
  game: {
    bpm: 140, level: 0.6, loopStart: 0, drums: 'game', arp: 0, stab: 0.07,
    lead: { wave: 'brass', gain: 0.13, vib: 9 }, bassWave: 'triangle',
    bars: [
      ['G', 'D5:2 G5:2 B5:2 G5:2 D6:4 B5:4'],
      ['C', 'C6:2 B5:2 A5:2 G5:2 E5:4 G5:4'],
      ['D', 'A5:2 A5:2 F#5:2 A5:2 D6:4 C6:2 A5:2'],
      ['G', 'B5:4 G5:4 B5:2 D6:2 G6:4'],
      ['Em', 'E6:2 D6:2 B5:2 G5:2 B5:4 E6:4'],
      ['C', 'G5:2 C6:2 E6:4 D6:2 C6:2 G5:4'],
      ['D', 'F#5:2 A5:2 D6:2 F#6:2 E6:4 D6:4'],
      ['G', 'D6:2 B5:2 G5:2 B5:2 D6:6 R:2'],
    ],
  },
  result_win: {
    bpm: 120, level: 0.8, loopStart: 4, drums: 'none', arp: 0.04,
    lead: { wave: 'square', gain: 0.14, vib: 0 }, bassWave: 'triangle',
    bars: [
      ['C', 'G5:1 G5:1 G5:2 C6:4 R:2 E6:4 R:2'],
      ['F', 'A5:1 A5:1 A5:2 C6:4 R:2 F6:4 R:2'],
      ['G', 'B5:2 D6:2 G6:4 F6:2 D6:2 B5:4'],
      ['C', 'C6:2 E6:2 G6:2 C7:10'],
      ['C', 'E5:4 G5:4 C6:4 G5:4'],
      ['Am', 'E5:4 A5:4 C6:4 A5:4'],
      ['F', 'F5:4 A5:4 C6:4 A5:4'],
      ['G', 'D5:4 G5:4 B5:4 D6:4'],
    ],
  },
  result_lose: {
    bpm: 90, level: 0.8, loopStart: 0, drums: 'none', arp: 0.05,
    lead: { wave: 'triangle', gain: 0.2, vib: 5 }, bassWave: 'sine',
    bars: [
      ['Am', 'A4:4 C5:4 E5:6 R:2'],
      ['F', 'A4:4 C5:4 F5:6 R:2'],
      ['Dm', 'D5:4 F5:4 A5:4 F5:4'],
      ['E', 'E5:4 G#4:4 B4:4 E5:4'],
    ],
  },
  settings: {
    bpm: 96, level: 0.75, loopStart: 0, drums: 'none', arp: 0.05,
    lead: { wave: 'triangle', gain: 0.2, vib: 4 }, bassWave: 'sine',
    bars: [
      ['C', 'E5:6 D5:2 C5:4 E5:4'],
      ['Am', 'C5:6 E5:2 A5:4 G5:4'],
      ['F', 'A5:6 G5:2 F5:4 A5:4'],
      ['G', 'G5:6 F5:2 D5:4 G5:4'],
      ['C', 'E5:6 G5:2 C6:4 B5:4'],
      ['Em', 'G5:6 E5:2 B4:4 E5:4'],
      ['F', 'A5:6 C6:2 A5:4 F5:4'],
      ['G', 'G5:6 D5:2 B4:4 G4:4'],
    ],
  },
};

/* compile a track into per-step event lists */
function compile(def) {
  const total = def.bars.length * 16;
  const steps = Array.from({ length: total }, () => []);
  const dr = DR[def.drums];
  def.bars.forEach(([chName, leadStr], b) => {
    const base = b * 16; const ch = CH[chName];
    for (const n of parseBar(leadStr)) steps[base + n.pos].push({ t: 'lead', midi: n.midi, len: n.len });
    let root = ch[0] - 24; if (root < 33) root += 12;
    for (let s = 0; s < 16; s += 2) {
      const m = (s % 4 === 0) ? root : root + 12;
      if (def.drums === 'game' && s % 8 !== 0 && s % 4 !== 0) continue;
      steps[base + s].push({ t: 'bass', midi: m, len: def.drums === 'game' ? 3 : 1.6 });
    }
    if (def.arp) for (let s = 0; s < 16; s++) {
      const tones = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 12];
      steps[base + s].push({ t: 'arp', midi: tones[s % 4], len: 1 });
    }
    if (def.stab) for (const s of [4, 12]) for (const m of ch) steps[base + s].push({ t: 'stab', midi: m, len: 2 });
    if (dr) for (let s = 0; s < 16; s++) {
      if (dr.k[s] === 'x') steps[base + s].push({ t: 'kick' });
      if (dr.s[s] === 'x') steps[base + s].push({ t: 'snare' });
      if (dr.h[s] === 'x' || dr.h[s] === 'o') steps[base + s].push({ t: 'hat', open: dr.h[s] === 'o' });
      if (dr.fill && b % 4 === 3 && (s === 14 || s === 15)) steps[base + s].push({ t: 'snare' });
    }
  });
  return { total, steps };
}

export function createMusic({ enabled = true, volume = 0.7 } = {}) {
  let on = !!enabled;
  let vol = clamp01(volume);
  let ac = null, busGain = null, duckGain = null, noiseBuf = null;
  const pulseWaves = {};
  let wanted = null;          // track name the app wants playing
  let current = null;         // active voice
  const voices = new Set();   // active + fading voices
  let timer = null;
  let ducked = false;

  function clamp01(v) { v = Number(v); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7; }

  function ensure() {
    if (ac) return ac;
    try {
      if (window.__dokiAudioCtx) ac = window.__dokiAudioCtx;
      else {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        window.__dokiAudioCtx = ac;
      }
      busGain = ac.createGain();
      duckGain = ac.createGain();
      duckGain.gain.value = ducked ? 0.4 : 1;
      busGain.gain.value = on ? 0.35 * vol : 0;
      busGain.connect(duckGain); duckGain.connect(ac.destination);
      const len = ac.sampleRate;
      noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { ac = null; }
    return ac;
  }

  function pulse(duty) {
    if (!pulseWaves[duty]) {
      const n = 32, re = new Float32Array(n), im = new Float32Array(n);
      for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      pulseWaves[duty] = ac.createPeriodicWave(re, im);
    }
    return pulseWaves[duty];
  }

  function applyBus() {
    if (!ac || !busGain) return;
    try { busGain.gain.setTargetAtTime(on ? 0.35 * vol : 0, ac.currentTime, 0.04); } catch (e) { /* ignore */ }
  }

  /* ---- instruments ---- */
  function tone(v, t, midi, durSteps, kind) {
    const dur = durSteps * v.stepSec;
    const g = ac.createGain();
    const osc = ac.createOscillator();
    let peak, wave = 'triangle', atk = 0.01, rel = 0.06, out = g;
    if (kind === 'lead') {
      const L = v.def.lead; peak = L.gain; wave = L.wave;
    } else if (kind === 'bass') { peak = 0.22; wave = v.def.bassWave; rel = 0.04; }
    else if (kind === 'arp') { peak = v.def.arp; wave = 'pulse'; rel = 0.03; }
    else { peak = v.def.stab; wave = 'brass'; atk = 0.015; rel = 0.08; }
    if (wave === 'pulse') osc.setPeriodicWave(pulse(0.25));
    else if (wave === 'brass') osc.type = 'sawtooth';
    else osc.type = wave;
    osc.frequency.value = hz(midi);
    if (wave === 'brass') {
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 2;
      f.frequency.setValueAtTime(700, t);
      f.frequency.exponentialRampToValueAtTime(2600, t + 0.07);
      f.frequency.exponentialRampToValueAtTime(1500, t + Math.max(0.12, dur));
      osc.connect(f); f.connect(g);
    } else osc.connect(g);
    if (kind === 'lead' && v.def.lead.vib && v.lfo) v.lfo.connect(osc.detune);
    const end = t + Math.max(0.05, dur * 0.94);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.setValueAtTime(peak * 0.8, Math.max(t + atk, end - 0.02));
    g.gain.linearRampToValueAtTime(0.0001, end + rel);
    out.connect(v.gain);
    osc.start(t); osc.stop(end + rel + 0.02);
    osc.onended = () => { try { g.disconnect(); } catch (e) { /* ignore */ } };
    window.__dokiMusicNotes = (window.__dokiMusicNotes || 0) + 1;
  }

  function noiseHit(v, t, { type, f, q = 1, peak, dur }) {
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl); fl.connect(g); g.connect(v.gain);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
    window.__dokiMusicNotes = (window.__dokiMusicNotes || 0) + 1;
  }

  function drum(v, t, kind, ev) {
    const soft = v.def.drums === 'game' ? 0.7 : 1;
    if (kind === 'kick') {
      const o = ac.createOscillator(); const g = ac.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(0.4 * soft, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(v.gain); o.start(t); o.stop(t + 0.2);
      window.__dokiMusicNotes = (window.__dokiMusicNotes || 0) + 1;
    } else if (kind === 'snare') {
      noiseHit(v, t, { type: 'bandpass', f: 1900, q: 0.8, peak: 0.22 * soft, dur: 0.13 });
    } else {
      noiseHit(v, t, { type: 'highpass', f: 7000, peak: (ev.open ? 0.07 : 0.05) * soft, dur: ev.open ? 0.11 : 0.04 });
    }
  }

  function scheduleStep(v, t) {
    const evs = v.comp.steps[v.pos];
    for (const e of evs) {
      if (e.t === 'kick' || e.t === 'snare' || e.t === 'hat') drum(v, t, e.t, e);
      else tone(v, t, e.midi, e.len, e.t);
    }
    v.pos++;
    if (v.pos >= v.comp.total) v.pos = v.loopStep;
    v.next += v.stepSec;
  }

  function tick() {
    try {
      if (!ac) return;
      const now = ac.currentTime;
      for (const v of voices) {
        if (v.dead) continue;
        if (v.next < now - 0.05) v.next = now + 0.02;
        let guard = 0;
        while (v.next < now + 0.1 && guard++ < 64) scheduleStep(v, v.next);
      }
      if (!voices.size && timer) { clearInterval(timer); timer = null; }
    } catch (e) { /* never throw */ }
  }

  function killVoice(v) {
    v.dead = true;
    voices.delete(v);
    try { if (v.lfo) v.lfo.stop(); } catch (e) { /* ignore */ }
    try { setTimeout(() => { try { v.gain.disconnect(); } catch (e) { /* ignore */ } }, 200); } catch (e) { /* ignore */ }
  }

  function fadeOut(v, sec) {
    const t = ac.currentTime;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0.0001, t + sec);
    } catch (e) { /* ignore */ }
    setTimeout(() => killVoice(v), sec * 1000 + 80);
  }

  function startTrack(name) {
    const def = TRACKS[name];
    if (!def || !ensure()) return;
    if (current) { fadeOut(current, 0.6); current = null; }
    const comp = compile(def);
    const gain = ac.createGain();
    const t0 = ac.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(def.level, t0 + 0.6);
    gain.connect(busGain);
    const v = { name, def, comp, gain, pos: 0, loopStep: def.loopStart * 16, stepSec: 60 / def.bpm / 4, next: t0 + 0.06, dead: false, lfo: null };
    if (def.lead.vib) {
      const lfo = ac.createOscillator(); lfo.frequency.value = 5.5;
      const lg = ac.createGain(); lg.gain.value = def.lead.vib;
      lfo.connect(lg); lfo.start();
      v.lfo = lg; v.lfoOsc = lfo;
      // lfo stop handled via killVoice using the osc
      v.lfo = Object.assign(lg, { stop() { lfo.stop(); } });
    }
    voices.add(v); current = v;
    if (!timer) timer = setInterval(tick, 25);
    tick();
  }

  function begin() {
    if (!on || !wanted || !ac) return;
    if (current && current.name === wanted && !current.dead) return;
    startTrack(wanted);
  }

  return {
    play(name) {
      try {
        if (!TRACKS[name]) return;
        wanted = name;
        if (ac) begin();
      } catch (e) { /* ignore */ }
    },
    stop(fadeMs = 600) {
      try {
        wanted = null;
        if (!ac) return;
        for (const v of [...voices]) fadeOut(v, Math.max(0.02, fadeMs / 1000));
        current = null;
      } catch (e) { /* ignore */ }
    },
    setEnabled(b) {
      try {
        on = !!b;
        if (ac) {
          applyBus();
          if (on) begin();
          else {
            for (const v of [...voices]) fadeOut(v, 0.15);
            current = null;
          }
        }
      } catch (e) { /* ignore */ }
    },
    setVolume(x) {
      try { vol = clamp01(x); applyBus(); } catch (e) { /* ignore */ }
    },
    unlock() {
      try {
        const c = ensure();
        if (!c) return;
        if (c.state === 'suspended') c.resume();
        begin();
      } catch (e) { /* ignore */ }
    },
    duck(flag) {
      try {
        ducked = !!flag;
        if (ac && duckGain) duckGain.gain.setTargetAtTime(ducked ? 0.4 : 1, ac.currentTime, 0.06);
      } catch (e) { /* ignore */ }
    },
  };
}
