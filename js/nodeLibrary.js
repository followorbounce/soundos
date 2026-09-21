// Systematized node database: every node type declares its ports, params and
// a build(ctx) factory that returns a live-audio instance with a uniform contract:
//
//   instance = {
//     inputs:   { portId: { node: AudioNode, index: number } }   // kind:'audio' ports
//     audioParams: { paramName: AudioParam }                     // kind:'param' ports
//     output:   AudioNode | null                                 // single output port
//     setParam(name, value)
//     gateOn(time) / gateOff(time)  // optional, envelope-style generators — opened
//                                   // once when Generate starts the (single,
//                                   // permanently-running) graph, never per-note
//     dispose()
//   }
//
// Any output can be wired into any input (audio or param) — this mirrors real
// modular synths where a raw audio-rate signal is a perfectly valid modulator.

function makeWhiteNoiseBuffer(ctx, seconds = 2) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function makeDistortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function makeClickCurve(decay) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1); // WaveShaper input -1..1 maps to phase 0..1 across one sawtooth cycle
    curve[i] = Math.exp(-p * decay);
  }
  return curve;
}

function makeCrushCurve(bits) {
  const n = 1024;
  const levels = Math.pow(2, Math.max(1, Math.min(16, bits)));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

function makeDutyCurve(duty) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1);
    curve[i] = p < duty ? 1 : 0;
  }
  return curve;
}

function makeStepCurve(steps) {
  const n = 1024;
  const s = Math.max(2, Math.round(steps));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1; // -1..1
    const p = (x + 1) / 2; // 0..1
    curve[i] = (Math.round(p * (s - 1)) / (s - 1)) * 2 - 1; // quantized, back to -1..1
  }
  return curve;
}

function makeReverbImpulse(ctx, seconds, decay) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// Band-limited pulse of a given duty cycle as a PeriodicWave (Fourier series of
// a 0/1 pulse with the DC term dropped), so Pulse Width is a real waveform
// change, not a filter trick. duty 0.5 is a plain square.
function makePulseWave(ctx, duty) {
  const N = 96;
  const re = new Float32Array(N + 1);
  const im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) {
    re[n] = Math.sin(2 * Math.PI * n * duty) / (n * Math.PI);
    im[n] = (1 - Math.cos(2 * Math.PI * n * duty)) / (n * Math.PI);
  }
  return ctx.createPeriodicWave(re, im);
}

// A loopable rise/fall (AD) envelope that free-runs — the graph has no
// keyboard, so "loop" is the only mode that makes sense here. One cycle of the
// shape lives in a looping buffer (unipolar 0..1: charge-curve rise, decay-curve
// fall), so the timing is sample-accurate and costs nothing on the main thread.
// Changing rise/fall builds a new buffer (debounced while a knob is dragged) and
// crossfades to it; the phase restarts on each swap.
function makeLoopEnvelope(ctx) {
  const out = ctx.createGain();
  let rise = 0.3, fall = 0.9, cur = null, timer = null;
  const K = 4;
  const den = 1 - Math.exp(-K);
  function cycle() {
    const total = Math.max(0.02, rise + fall);
    const len = Math.max(64, Math.round(total * ctx.sampleRate));
    const nr = Math.max(1, Math.round((len * rise) / total));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      if (i < nr) d[i] = (1 - Math.exp((-K * i) / nr)) / den;
      else d[i] = (Math.exp((-K * (i - nr)) / Math.max(1, len - nr)) - Math.exp(-K)) / den;
    }
    return buf;
  }
  function swap() {
    timer = null;
    const src = ctx.createBufferSource();
    src.buffer = cycle();
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(out);
    src.start();
    const now = ctx.currentTime;
    g.gain.setTargetAtTime(1, now, 0.01);
    const old = cur;
    cur = { src, g };
    if (old) {
      old.g.gain.setTargetAtTime(0, now, 0.01);
      setTimeout(() => { try { old.src.stop(); } catch (e) {} old.src.disconnect(); old.g.disconnect(); }, 150);
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(swap, 40);
  }
  schedule();
  return {
    out,
    setRise(v) { rise = Math.max(0.005, v); schedule(); },
    setFall(v) { fall = Math.max(0.005, v); schedule(); },
    dispose() {
      if (timer) clearTimeout(timer);
      if (cur) { try { cur.src.stop(); } catch (e) {} cur.src.disconnect(); cur.g.disconnect(); }
      out.disconnect();
    },
  };
}

export const CATEGORY = {
  generator: { label: 'Generators' },
  processor: { label: 'Processing' },
  video: { label: 'Video' },
};

export const NODE_TYPES = {
  // ---------------- GENERATORS ----------------

  oscillator: {
    id: 'oscillator',
    label: 'Oscillator',
    category: 'generator',
    color: '#FF8C42',
    desc: 'tone / VCO',
    inputs: [
      { id: 'freq_mod', label: 'Freq', kind: 'param', param: 'frequency' },
      { id: 'detune_mod', label: 'Detune', kind: 'param', param: 'detune' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'waveform', label: 'Wave', type: 'select', options: ['sine', 'square', 'sawtooth', 'triangle'], default: 'sine' },
      { name: 'freq', label: 'Freq', type: 'range', min: 20, max: 2000, step: 1, default: 440, scale: 'hz' },
      { name: 'level', label: 'Level', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7 },
    ],
    build(ctx) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440;
      const gain = ctx.createGain();
      gain.gain.value = 0.7;
      osc.connect(gain);
      osc.start();
      return {
        inputs: {},
        audioParams: { frequency: osc.frequency, detune: osc.detune },
        output: gain,
        setParam(name, value) {
          if (name === 'waveform') osc.type = value;
          else if (name === 'freq') osc.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'level') gain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          gain.disconnect();
        },
      };
    },
  },

  lfo: {
    id: 'lfo',
    label: 'LFO',
    category: 'generator',
    color: '#C9E85C',
    desc: 'modulation',
    inputs: [{ id: 'rate_mod', label: 'Rate', kind: 'param', param: 'frequency' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'waveform', label: 'Wave', type: 'select', options: ['sine', 'square', 'sawtooth', 'triangle'], default: 'sine' },
      { name: 'rate', label: 'Rate', type: 'range', min: 0.02, max: 20, step: 0.01, default: 2, scale: 'hz' },
      { name: 'depth', label: 'Depth', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
      { name: 'unipolar', label: 'Unipolar', type: 'bool', default: false },
    ],
    build(ctx) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 2;
      const depthGain = ctx.createGain();
      depthGain.gain.value = 1;
      const offset = ctx.createConstantSource();
      offset.offset.value = 0;
      offset.start();
      const sum = ctx.createGain();
      osc.connect(depthGain).connect(sum);
      offset.connect(sum);
      osc.start();
      return {
        inputs: {},
        audioParams: { frequency: osc.frequency },
        output: sum,
        setParam(name, value) {
          if (name === 'waveform') osc.type = value;
          else if (name === 'rate') osc.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'depth') depthGain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'unipolar') offset.offset.setTargetAtTime(value ? depthGain.gain.value : 0, ctx.currentTime, 0.01);
        },
        dispose() {
          try { osc.stop(); offset.stop(); } catch (e) {}
          osc.disconnect(); depthGain.disconnect(); offset.disconnect(); sum.disconnect();
        },
      };
    },
  },

  noise: {
    id: 'noise',
    label: 'Noise',
    category: 'generator',
    color: '#39CCCC',
    desc: 'noise',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'color', label: 'Color', type: 'select', options: ['white', 'pink'], default: 'white' },
      { name: 'level', label: 'Level', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    build(ctx) {
      const src = ctx.createBufferSource();
      src.buffer = makeWhiteNoiseBuffer(ctx);
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 20000;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      src.connect(filter).connect(gain);
      src.start();
      return {
        inputs: {},
        audioParams: {},
        output: gain,
        setParam(name, value) {
          if (name === 'color') filter.frequency.setTargetAtTime(value === 'pink' ? 800 : 20000, ctx.currentTime, 0.02);
          else if (name === 'level') gain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() {
          try { src.stop(); } catch (e) {}
          src.disconnect(); filter.disconnect(); gain.disconnect();
        },
      };
    },
  },

  // A digital take on the Dreadbox NYX (reissue of the 2015 analog paraphonic
  // synth): two VCOs sounding together through two 12 dB state-variable filters
  // that can be routed four ways, three loopable rise/fall envelopes, a
  // vibrato LFO, noise, and a reverb. "Paraphonic" = both oscillators share one
  // filter/VCA path, which is exactly what this node is — and since SoundOS has
  // no keyboard, the pitch is a Tune knob and each VCO's Glide is portamento
  // between Tune moves (knob drags, recorded loops, CV).
  //
  // Faithful: VCO 1 saw/pulse + PWM + 32'/16'/8', VCO 2 saw/triangle + detune +
  // 16'/8'/4', per-VCO glide, VCO2->VCO1 FM, noise, NOR/SPLIT/HALF/VCA routing,
  // separate filter ins, Cut A / Cut B / Res, three envelopes, triangle vibrato,
  // reverb with pre-delay + decay + mix.
  // Approximations: hard sync is not modelled (Web Audio oscillators can't be
  // reset per cycle); ODD is read as Filter 1 low-pass + Filter 2 high-pass in
  // parallel; envelope destinations are fixed (Env 1 -> VCA, Env 2 -> cutoff,
  // Env 3 -> pitch) rather than patched; no analog drift / warm-up.
  nyx: {
    id: 'nyx',
    label: 'NYX',
    category: 'generator',
    color: '#E0B040',
    desc: 'paraphonic dual filter',
    wide: true,
    inputs: [
      { id: 'in', label: 'Filt 1', kind: 'audio' },
      { id: 'in2', label: 'Filt 2', kind: 'audio' },
      { id: 'pitch_mod', label: 'Pitch', kind: 'param', param: 'pitch' },
      { id: 'cutoff_mod', label: 'Cutoff', kind: 'param', param: 'cutoff' },
      { id: 'vca_mod', label: 'VCA', kind: 'param', param: 'vca' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { group: 'Tuning', name: 'tune', label: 'Tune', type: 'range', min: 30, max: 1000, step: 1, default: 110, scale: 'hz' },
      { group: 'VCO 1', name: 'wave1', label: 'Wave 1', type: 'select', options: ['saw', 'square'], default: 'saw' },
      { group: 'VCO 1', name: 'oct1', label: "Range 1", type: 'select', options: ["32'", "16'", "8'"], default: "16'" },
      { group: 'VCO 1', name: 'pw', label: 'PW', type: 'range', min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
      { group: 'VCO 1', name: 'glide1', label: 'Glide', type: 'range', min: 0, max: 2, step: 0.01, default: 0, scale: 'time' },
      { group: 'VCO 1', name: 'level1', label: 'Level', type: 'range', min: 0, max: 1, step: 0.01, default: 0.6 },
      { group: 'VCO 2', name: 'wave2', label: 'Wave 2', type: 'select', options: ['saw', 'triangle'], default: 'saw' },
      { group: 'VCO 2', name: 'oct2', label: 'Range 2', type: 'select', options: ["16'", "8'", "4'"], default: "8'" },
      { group: 'VCO 2', name: 'detune2', label: 'Detune', type: 'range', min: -1200, max: 1200, step: 1, default: 7 },
      { group: 'VCO 2', name: 'glide2', label: 'Glide', type: 'range', min: 0, max: 2, step: 0.01, default: 0, scale: 'time' },
      { group: 'VCO 2', name: 'level2', label: 'Level', type: 'range', min: 0, max: 1, step: 0.01, default: 0.6 },
      { group: 'Mix / routing', name: 'fm', label: 'FM 2>1', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
      { group: 'Mix / routing', name: 'noise', label: 'Noise', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
      { group: 'Mix / routing', name: 'route', label: 'VCO routing', type: 'select', options: ['NOR', 'SPLIT', 'HALF', 'VCA'], default: 'NOR' },
      { group: 'Filters', name: 'fmode', label: 'Filter mode', type: 'select', options: ['LPF', 'HPF', 'EVEN', 'ODD'], default: 'LPF' },
      { group: 'Filters', name: 'cutA', label: 'Cut A', type: 'range', min: 30, max: 12000, step: 1, default: 900, scale: 'hz' },
      { group: 'Filters', name: 'cutB', label: 'Cut B', type: 'range', min: 30, max: 12000, step: 1, default: 1800, scale: 'hz' },
      { group: 'Filters', name: 'res', label: 'Res', type: 'range', min: 0, max: 1, step: 0.01, default: 0.3 },
      { group: 'Env 1 → VCA (loops)', name: 'e1rise', label: 'Rise', type: 'range', min: 0.005, max: 4, step: 0.005, default: 0.3, scale: 'time' },
      { group: 'Env 1 → VCA (loops)', name: 'e1fall', label: 'Fall', type: 'range', min: 0.005, max: 4, step: 0.005, default: 0.9, scale: 'time' },
      { group: 'Env 1 → VCA (loops)', name: 'e1amt', label: 'Amt', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
      { group: 'Env 2 → cutoff (loops)', name: 'e2rise', label: 'Rise', type: 'range', min: 0.005, max: 4, step: 0.005, default: 0.5, scale: 'time' },
      { group: 'Env 2 → cutoff (loops)', name: 'e2fall', label: 'Fall', type: 'range', min: 0.005, max: 4, step: 0.005, default: 1.5, scale: 'time' },
      { group: 'Env 2 → cutoff (loops)', name: 'e2amt', label: 'Amt', type: 'range', min: 0, max: 8000, step: 10, default: 0, scale: 'hz' },
      { group: 'Env 3 → pitch (loops)', name: 'e3rise', label: 'Rise', type: 'range', min: 0.005, max: 4, step: 0.005, default: 0.1, scale: 'time' },
      { group: 'Env 3 → pitch (loops)', name: 'e3fall', label: 'Fall', type: 'range', min: 0.005, max: 4, step: 0.005, default: 0.3, scale: 'time' },
      { group: 'Env 3 → pitch (loops)', name: 'e3amt', label: 'Amt ¢', type: 'range', min: -1200, max: 1200, step: 1, default: 0 },
      { group: 'Vibrato / reverb / out', name: 'vibRate', label: 'Vib rate', type: 'range', min: 0.1, max: 20, step: 0.1, default: 5, scale: 'hz' },
      { group: 'Vibrato / reverb / out', name: 'vibDepth', label: 'Vib ¢', type: 'range', min: 0, max: 100, step: 1, default: 0 },
      { group: 'Vibrato / reverb / out', name: 'revPre', label: 'Pre-dly', type: 'range', min: 0, max: 0.25, step: 0.005, default: 0.03, scale: 'time' },
      { group: 'Vibrato / reverb / out', name: 'revDecay', label: 'Decay', type: 'range', min: 0.2, max: 5, step: 0.1, default: 2, scale: 'time' },
      { group: 'Vibrato / reverb / out', name: 'revMix', label: 'Rev mix', type: 'range', min: 0, max: 1, step: 0.01, default: 0.2 },
      { group: 'Vibrato / reverb / out', name: 'vol', label: 'Vol', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7 },
    ],
    build(ctx) {
      const OCT1 = { "32'": 0.25, "16'": 0.5, "8'": 1 };
      const OCT2 = { "16'": 0.5, "8'": 1, "4'": 2 };
      const ROUTES = { // [bus1->F1, bus1->F2, bus1->VCA, bus2->F1, bus2->F2, bus2->VCA]
        NOR: [1, 0, 0, 1, 0, 0], SPLIT: [1, 0, 0, 0, 1, 0], HALF: [0, 1, 0, 0, 1, 0], VCA: [0, 0, 1, 0, 0, 1],
      };
      const st = { tune: 110, oct1: "16'", oct2: "8'", glide1: 0, glide2: 0, fm: 0, wave1: 'saw', pw: 0.5 };
      const all = []; // every node, for dispose
      const mk = (n) => { all.push(n); return n; };
      const sources = [];

      // --- VCOs ---
      const osc1 = mk(ctx.createOscillator());
      const osc2 = mk(ctx.createOscillator());
      osc1.type = 'sawtooth';
      osc2.type = 'sawtooth';
      osc2.detune.value = 7;
      const lvl1 = mk(ctx.createGain()); lvl1.gain.value = 0.6;
      const lvl2 = mk(ctx.createGain()); lvl2.gain.value = 0.6;
      osc1.connect(lvl1);
      osc2.connect(lvl2);
      const fmGain = mk(ctx.createGain()); fmGain.gain.value = 0; // VCO2 -> VCO1 frequency (Hz of deviation)
      osc2.connect(fmGain).connect(osc1.frequency);
      const noiseSrc = mk(ctx.createBufferSource());
      noiseSrc.buffer = makeWhiteNoiseBuffer(ctx);
      noiseSrc.loop = true;
      const noiseGain = mk(ctx.createGain()); noiseGain.gain.value = 0;
      noiseSrc.connect(noiseGain);
      sources.push(osc1, osc2, noiseSrc);

      // --- routing matrix: bus1 = VCO1 + noise, bus2 = VCO2 ---
      const bus1 = mk(ctx.createGain());
      const bus2 = mk(ctx.createGain());
      lvl1.connect(bus1); noiseGain.connect(bus1); lvl2.connect(bus2);
      const rg = ROUTES.NOR.map(() => mk(ctx.createGain()));
      [[bus1, 0, 'f1'], [bus1, 1, 'f2'], [bus1, 2, 'v'], [bus2, 3, 'f1'], [bus2, 4, 'f2'], [bus2, 5, 'v']].forEach(([bus, i]) => bus.connect(rg[i]));
      const f1in = mk(ctx.createGain());
      const f2in = mk(ctx.createGain());
      const vcaIn = mk(ctx.createGain());
      rg[0].connect(f1in); rg[3].connect(f1in);
      rg[1].connect(f2in); rg[4].connect(f2in);
      rg[2].connect(vcaIn); rg[5].connect(vcaIn);
      ROUTES.NOR.forEach((v, i) => { rg[i].gain.value = v; });

      // --- two 12 dB filters; series (LPF/HPF) feeds F1 into F2, parallel (EVEN/ODD) sums them ---
      const f1 = mk(ctx.createBiquadFilter());
      const f2 = mk(ctx.createBiquadFilter());
      f1.type = 'lowpass'; f2.type = 'lowpass';
      f1.frequency.value = 900; f2.frequency.value = 1800;
      f1in.connect(f1); f2in.connect(f2);
      const seriesSend = mk(ctx.createGain()); seriesSend.gain.value = 1; // F1 -> F2 input
      const parSend = mk(ctx.createGain()); parSend.gain.value = 0; // F1 -> output
      f1.connect(seriesSend).connect(f2in);
      f1.connect(parSend);
      const filtOut = mk(ctx.createGain());
      parSend.connect(filtOut); f2.connect(filtOut); filtOut.connect(vcaIn);

      // --- VCA: gain = (1 - amt) + amt * Env 1 ---
      const vca = mk(ctx.createGain()); vca.gain.value = 1;
      vcaIn.connect(vca);

      // --- CV inputs (a constant source's offset is the summing point for cables) ---
      const cutCv = mk(ctx.createConstantSource()); cutCv.offset.value = 0;
      const cutCvScale = mk(ctx.createGain()); cutCvScale.gain.value = 1200; // +-1 signal = +-1200 Hz
      cutCv.connect(cutCvScale); cutCvScale.connect(f1.frequency); cutCvScale.connect(f2.frequency);
      const pitchCv = mk(ctx.createConstantSource()); pitchCv.offset.value = 0;
      const pitchCvScale = mk(ctx.createGain()); pitchCvScale.gain.value = 1200; // +-1 signal = +-1 octave
      pitchCv.connect(pitchCvScale); pitchCvScale.connect(osc1.detune); pitchCvScale.connect(osc2.detune);
      sources.push(cutCv, pitchCv);

      // --- three looping envelopes ---
      const env = [makeLoopEnvelope(ctx), makeLoopEnvelope(ctx), makeLoopEnvelope(ctx)];
      const e1amt = mk(ctx.createGain()); e1amt.gain.value = 0;
      const e2amt = mk(ctx.createGain()); e2amt.gain.value = 0;
      const e3amt = mk(ctx.createGain()); e3amt.gain.value = 0;
      env[0].out.connect(e1amt).connect(vca.gain);
      env[1].out.connect(e2amt); e2amt.connect(f1.frequency); e2amt.connect(f2.frequency);
      env[2].out.connect(e3amt); e3amt.connect(osc1.detune); e3amt.connect(osc2.detune);

      // --- triangle vibrato ---
      const vib = mk(ctx.createOscillator()); vib.type = 'triangle'; vib.frequency.value = 5;
      const vibGain = mk(ctx.createGain()); vibGain.gain.value = 0;
      vib.connect(vibGain); vibGain.connect(osc1.detune); vibGain.connect(osc2.detune);
      sources.push(vib);

      // --- reverb + master volume ---
      const preDelay = mk(ctx.createDelay(0.5)); preDelay.delayTime.value = 0.03;
      const conv = mk(ctx.createConvolver());
      let decay = 2, impulseTimer = null;
      conv.buffer = makeReverbImpulse(ctx, decay, 2.5);
      const wet = mk(ctx.createGain()); wet.gain.value = 0.2;
      const dry = mk(ctx.createGain()); dry.gain.value = 0.8;
      const revOut = mk(ctx.createGain());
      const vol = mk(ctx.createGain()); vol.gain.value = 0.7;
      vca.connect(preDelay).connect(conv).connect(wet).connect(revOut);
      vca.connect(dry).connect(revOut);
      revOut.connect(vol);

      sources.forEach((s) => s.start());

      const now = () => ctx.currentTime;
      const tau = (g) => 0.01 + g / 3; // glide time -> setTargetAtTime time constant
      function applyPitch() {
        osc1.frequency.setTargetAtTime(Math.max(1, st.tune * OCT1[st.oct1]), now(), tau(st.glide1));
        osc2.frequency.setTargetAtTime(Math.max(1, st.tune * OCT2[st.oct2]), now(), tau(st.glide2));
        fmGain.gain.setTargetAtTime(st.fm * st.tune * OCT1[st.oct1] * 3, now(), 0.01);
      }
      function applyWave1() {
        if (st.wave1 === 'square') osc1.setPeriodicWave(makePulseWave(ctx, st.pw));
        else osc1.type = 'sawtooth';
      }
      const set = (param, v, t = 0.01) => param.setTargetAtTime(v, now(), t);
      const P = {
        tune(v) { st.tune = v; applyPitch(); },
        oct1(v) { st.oct1 = v; applyPitch(); },
        oct2(v) { st.oct2 = v; applyPitch(); },
        glide1(v) { st.glide1 = v; },
        glide2(v) { st.glide2 = v; },
        fm(v) { st.fm = v; applyPitch(); },
        wave1(v) { st.wave1 = v; applyWave1(); },
        pw(v) { st.pw = v; if (st.wave1 === 'square') applyWave1(); },
        wave2(v) { osc2.type = v === 'triangle' ? 'triangle' : 'sawtooth'; },
        detune2(v) { set(osc2.detune, v); },
        level1(v) { set(lvl1.gain, v); },
        level2(v) { set(lvl2.gain, v); },
        noise(v) { set(noiseGain.gain, v * 0.6); },
        route(v) { (ROUTES[v] || ROUTES.NOR).forEach((g, i) => set(rg[i].gain, g, 0.015)); },
        fmode(v) {
          f1.type = v === 'HPF' ? 'highpass' : 'lowpass';
          f2.type = v === 'HPF' || v === 'ODD' ? 'highpass' : 'lowpass';
          const series = v === 'LPF' || v === 'HPF';
          set(seriesSend.gain, series ? 1 : 0, 0.015);
          set(parSend.gain, series ? 0 : 1, 0.015);
        },
        cutA(v) { set(f1.frequency, v); },
        cutB(v) { set(f2.frequency, v); },
        res(v) { const q = 0.7 + v * v * 24; set(f1.Q, q); set(f2.Q, q); },
        e1rise(v) { env[0].setRise(v); },
        e1fall(v) { env[0].setFall(v); },
        e1amt(v) { set(e1amt.gain, v); set(vca.gain, 1 - v); },
        e2rise(v) { env[1].setRise(v); },
        e2fall(v) { env[1].setFall(v); },
        e2amt(v) { set(e2amt.gain, v); },
        e3rise(v) { env[2].setRise(v); },
        e3fall(v) { env[2].setFall(v); },
        e3amt(v) { set(e3amt.gain, v); },
        vibRate(v) { set(vib.frequency, v); },
        vibDepth(v) { set(vibGain.gain, v); },
        revPre(v) { set(preDelay.delayTime, Math.min(0.5, v)); },
        revDecay(v) {
          decay = v;
          if (impulseTimer) clearTimeout(impulseTimer);
          impulseTimer = setTimeout(() => { conv.buffer = makeReverbImpulse(ctx, decay, 2.5); }, 60);
        },
        revMix(v) { set(wet.gain, v); set(dry.gain, 1 - v); },
        vol(v) { set(vol.gain, v); },
      };
      return {
        inputs: { in: { node: f1in, index: 0 }, in2: { node: f2in, index: 0 } },
        audioParams: { pitch: pitchCv.offset, cutoff: cutCv.offset, vca: vca.gain },
        output: vol,
        setParam(name, value) { if (P[name]) P[name](value); },
        dispose() {
          if (impulseTimer) clearTimeout(impulseTimer);
          sources.forEach((s) => { try { s.stop(); } catch (e) {} });
          env.forEach((e) => e.dispose());
          all.forEach((n) => { try { n.disconnect(); } catch (e) {} });
        },
      };
    },
  },

  envelope: {
    id: 'envelope',
    label: 'Envelope',
    category: 'generator',
    color: '#A8D8C9',
    desc: 'ADSR / CV',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'attack', label: 'Atk', type: 'range', min: 0, max: 4, step: 0.01, default: 0.02, scale: 'time' },
      { name: 'decay', label: 'Dec', type: 'range', min: 0, max: 4, step: 0.01, default: 0.2, scale: 'time' },
      { name: 'sustain', label: 'Sus', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7 },
      { name: 'release', label: 'Rel', type: 'range', min: 0, max: 4, step: 0.01, default: 0.3, scale: 'time' },
      { name: 'amount', label: 'Amt', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    build(ctx) {
      const src = ctx.createConstantSource();
      src.offset.value = 1;
      src.start();
      const shape = ctx.createGain();
      shape.gain.value = 0;
      const amountGain = ctx.createGain();
      amountGain.gain.value = 1;
      src.connect(shape).connect(amountGain);
      let a = 0.02, d = 0.2, s = 0.7, r = 0.3;
      return {
        inputs: {},
        audioParams: {},
        output: amountGain,
        setParam(name, value) {
          if (name === 'attack') a = value;
          else if (name === 'decay') d = value;
          else if (name === 'sustain') s = value;
          else if (name === 'release') r = value;
          else if (name === 'amount') amountGain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        gateOn(time) {
          const g = shape.gain;
          g.cancelScheduledValues(time);
          g.setValueAtTime(g.value, time);
          g.linearRampToValueAtTime(1, time + Math.max(0.001, a));
          g.setTargetAtTime(s, time + Math.max(0.001, a), Math.max(0.01, d / 3));
        },
        gateOff(time) {
          const g = shape.gain;
          g.cancelScheduledValues(time);
          g.setValueAtTime(g.value, time);
          g.linearRampToValueAtTime(0, time + Math.max(0.001, r));
        },
        dispose() {
          try { src.stop(); } catch (e) {}
          src.disconnect(); shape.disconnect(); amountGain.disconnect();
        },
      };
    },
  },

  rhythm: {
    id: 'rhythm',
    label: 'Rhythm',
    category: 'generator',
    color: '#FFD166',
    desc: 'impulse / clock',
    inputs: [{ id: 'rate_mod', label: 'Rate', kind: 'param', param: 'rate' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'rate', label: 'Rate', type: 'range', min: 0.25, max: 20, step: 0.05, default: 4, scale: 'hz' },
      { name: 'decay', label: 'Decay', type: 'range', min: 2, max: 40, step: 0.5, default: 12 },
      { name: 'tone', label: 'Tone', type: 'range', min: 200, max: 8000, step: 10, default: 1500 },
      { name: 'level', label: 'Level', type: 'range', min: 0, max: 1, step: 0.01, default: 0.6 },
    ],
    // A self-clocked click generator, not a note: a sawtooth "clock" run through
    // a WaveShaper curve that decays from 1 to 0 across each cycle becomes a
    // repeating envelope (the clock's own hard wrap from +1 back to -1 gives
    // the near-instant attack), which then gates highpassed noise — the same
    // impulse-per-cycle trick used for Rhythm in Pulse Train, minus its
    // external edge-trigger input.
    build(ctx) {
      const clock = ctx.createOscillator();
      clock.type = 'sawtooth';
      clock.frequency.value = 4;
      clock.start();
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeClickCurve(12);
      shaper.oversample = 'none';
      const noise = ctx.createBufferSource();
      noise.buffer = makeWhiteNoiseBuffer(ctx);
      noise.loop = true;
      noise.start();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      const env = ctx.createGain();
      env.gain.value = 0;
      clock.connect(shaper).connect(env.gain);
      noise.connect(hp).connect(env);
      const level = ctx.createGain();
      level.gain.value = 0.6;
      env.connect(level);
      return {
        inputs: {},
        audioParams: { rate: clock.frequency },
        output: level,
        setParam(name, value) {
          if (name === 'rate') clock.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'decay') shaper.curve = makeClickCurve(value);
          else if (name === 'tone') hp.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'level') level.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() {
          try { clock.stop(); noise.stop(); } catch (e) {}
          [clock, shaper, noise, hp, env, level].forEach((n) => n.disconnect());
        },
      };
    },
  },

  // ---------------- PROCESSORS ----------------

  filter: {
    id: 'filter',
    label: 'Filter',
    category: 'processor',
    color: '#6FA98A',
    desc: 'filter',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'freq_mod', label: 'Cutoff', kind: 'param', param: 'frequency' },
      { id: 'q_mod', label: 'Q', kind: 'param', param: 'Q' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'type', label: 'Type', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'], default: 'lowpass' },
      { name: 'frequency', label: 'Cutoff', type: 'range', min: 20, max: 18000, step: 1, default: 1200, scale: 'hz' },
      { name: 'q', label: 'Q', type: 'range', min: 0.1, max: 20, step: 0.1, default: 1 },
    ],
    build(ctx) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1200;
      f.Q.value = 1;
      return {
        inputs: { in: { node: f, index: 0 } },
        audioParams: { frequency: f.frequency, Q: f.Q },
        output: f,
        setParam(name, value) {
          if (name === 'type') f.type = value;
          else if (name === 'frequency') f.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'q') f.Q.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() { f.disconnect(); },
      };
    },
  },

  amp: {
    id: 'amp',
    label: 'Amp / VCA',
    category: 'processor',
    color: '#FF4136',
    desc: 'amplifier',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'gain_mod', label: 'Gain', kind: 'param', param: 'gain' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [{ name: 'gain', label: 'Gain', type: 'range', min: 0, max: 2, step: 0.01, default: 0.6 }],
    build(ctx) {
      const g = ctx.createGain();
      g.gain.value = 0.6;
      return {
        inputs: { in: { node: g, index: 0 } },
        audioParams: { gain: g.gain },
        output: g,
        setParam(name, value) {
          if (name === 'gain') g.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() { g.disconnect(); },
      };
    },
  },

  mixer: {
    id: 'mixer',
    label: 'Mixer',
    category: 'processor',
    color: '#D8D0C0',
    desc: 'summer',
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [{ name: 'level', label: 'Level', type: 'range', min: 0, max: 1.5, step: 0.01, default: 1 }],
    build(ctx) {
      const g = ctx.createGain();
      g.gain.value = 1;
      return {
        inputs: { in: { node: g, index: 0 } },
        audioParams: { level: g.gain },
        output: g,
        setParam(name, value) {
          if (name === 'level') g.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() { g.disconnect(); },
      };
    },
  },

  delay: {
    id: 'delay',
    label: 'Delay',
    category: 'processor',
    color: '#7FB8D8',
    desc: 'echo',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'time_mod', label: 'Time', kind: 'param', param: 'delayTime' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'time', label: 'Time', type: 'range', min: 0, max: 2, step: 0.01, default: 0.3, scale: 'time' },
      { name: 'feedback', label: 'Fbck', type: 'range', min: 0, max: 0.95, step: 0.01, default: 0.35 },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 0.3 },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const delay = ctx.createDelay(5);
      delay.delayTime.value = 0.3;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.35;
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      const dry = ctx.createGain();
      dry.gain.value = 0.7;
      const out = ctx.createGain();
      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: { delayTime: delay.delayTime },
        output: out,
        setParam(name, value) {
          if (name === 'time') delay.delayTime.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'feedback') feedback.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() { [input, delay, feedback, wet, dry, out].forEach(n => n.disconnect()); },
      };
    },
  },

  freeze: {
    id: 'freeze',
    label: 'Freeze',
    category: 'processor',
    color: '#5B8FA8',
    desc: 'delay stretched toward infinity',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'time_mod', label: 'Time', kind: 'param', param: 'delayTime' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    // Same feedback-delay recurrence as Delay, just pushed to ~98% instead of
    // the usual 80-90% an echo tops out at — a struck signal barely decays,
    // cycling almost indefinitely instead of fading into discrete repeats.
    params: [
      { name: 'time', label: 'Time', type: 'range', min: 0, max: 3, step: 0.01, default: 0.6, scale: 'time' },
      { name: 'feedback', label: 'Fbck', type: 'range', min: 0, max: 0.99, step: 0.005, default: 0.9 },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 0.4 },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const delay = ctx.createDelay(5);
      delay.delayTime.value = 0.6;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.9;
      const wet = ctx.createGain(); wet.gain.value = 0.4;
      const dry = ctx.createGain(); dry.gain.value = 0.6;
      const out = ctx.createGain();
      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: { delayTime: delay.delayTime },
        output: out,
        setParam(name, value) {
          if (name === 'time') delay.delayTime.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'feedback') feedback.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() { [input, delay, feedback, wet, dry, out].forEach((n) => n.disconnect()); },
      };
    },
  },

  comb: {
    id: 'comb',
    label: 'Comb',
    category: 'processor',
    color: '#C97A4A',
    desc: 'metallic resonator',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'freq_mod', label: 'Freq', kind: 'param', param: 'delayTime' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    // The identical feedback-delay structure as Freeze/Delay, at a completely
    // different time scale: delay times short enough to be inaudible as
    // separate echoes. The `freq` knob sets delay time to 1/freq internally,
    // so it reads as a pitch, not a duration; a CV patched into `freq_mod`
    // instead nudges the raw delay time directly (same convention as
    // Delay/Freeze's own time_mod), not the frequency.
    params: [
      { name: 'freq', label: 'Freq', type: 'range', min: 40, max: 4000, step: 1, default: 220, scale: 'hz' },
      { name: 'resonance', label: 'Res', type: 'range', min: 0, max: 0.95, step: 0.01, default: 0.6 },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 1 / 220;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.6;
      const wet = ctx.createGain(); wet.gain.value = 0.5;
      const dry = ctx.createGain(); dry.gain.value = 0.5;
      const out = ctx.createGain();
      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: { delayTime: delay.delayTime },
        output: out,
        setParam(name, value) {
          if (name === 'freq') delay.delayTime.setTargetAtTime(1 / Math.max(20, value), ctx.currentTime, 0.005);
          else if (name === 'resonance') feedback.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() { [input, delay, feedback, wet, dry, out].forEach((n) => n.disconnect()); },
      };
    },
  },

  distortion: {
    id: 'distortion',
    label: 'Distortion',
    category: 'processor',
    color: '#E8547E',
    desc: 'distortion',
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'amount', label: 'Drive', type: 'range', min: 0, max: 100, step: 1, default: 20 },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(20);
      shaper.oversample = '4x';
      const wet = ctx.createGain(); wet.gain.value = 1;
      const dry = ctx.createGain(); dry.gain.value = 0;
      const out = ctx.createGain();
      input.connect(shaper).connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: {},
        output: out,
        setParam(name, value) {
          if (name === 'amount') shaper.curve = makeDistortionCurve(value);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() { [input, shaper, wet, dry, out].forEach(n => n.disconnect()); },
      };
    },
  },

  crush: {
    id: 'crush',
    label: 'Crush',
    category: 'processor',
    color: '#E0A458',
    desc: 'bit reduction · gate',
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'bits', label: 'Bits', type: 'range', min: 1, max: 16, step: 1, default: 6 },
      { name: 'gate', label: 'Gate', type: 'range', min: 0.5, max: 200, step: 0.1, default: 20, scale: 'hz' },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    // Amplitude quantization: Q(x,b) = round(x·2^(b-1)) / 2^(b-1), the same
    // staircase-WaveShaper technique as Pulse Train's Crush node. Gate is the
    // same rave-style square-wave amplitude chop as Pulse Train Stage II's
    // Crush: a square oscillator drives an audio-rate gain's own gain param,
    // applied after the bit-crush and before the wet/dry mix.
    build(ctx) {
      const input = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeCrushCurve(6);
      shaper.oversample = 'none';
      const gateOsc = ctx.createOscillator();
      gateOsc.type = 'square';
      gateOsc.frequency.value = 20;
      const gate = ctx.createGain();
      gate.gain.value = 0.5;
      gateOsc.connect(gate.gain);
      gateOsc.start();
      const wet = ctx.createGain(); wet.gain.value = 1;
      const dry = ctx.createGain(); dry.gain.value = 0;
      const out = ctx.createGain();
      input.connect(shaper).connect(gate).connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: {},
        output: out,
        setParam(name, value) {
          if (name === 'bits') shaper.curve = makeCrushCurve(value);
          else if (name === 'gate') gateOsc.frequency.setTargetAtTime(value, ctx.currentTime, 0.005);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() {
          try { gateOsc.stop(); } catch (e) {}
          [input, shaper, gateOsc, gate, wet, dry, out].forEach((n) => n.disconnect());
        },
      };
    },
  },

  ring: {
    id: 'ring',
    label: 'Ring',
    category: 'processor',
    color: '#8B7FB8',
    desc: 'ring modulation',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'freq_mod', label: 'Freq', kind: 'param', param: 'frequency' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'waveform', label: 'Wave', type: 'select', options: ['sine', 'square', 'sawtooth', 'triangle'], default: 'sine' },
      { name: 'freq', label: 'Freq', type: 'range', min: 20, max: 4000, step: 1, default: 220, scale: 'hz' },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    // True 4-quadrant ring mod: the carrier drives the input gain's own gain
    // AudioParam directly, so y(t) = x(t)·carrier(t) — sum/difference
    // sidebands, not a one-sided tremolo wobble.
    build(ctx) {
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = 220;
      carrier.start();
      const input = ctx.createGain();
      const ringGain = ctx.createGain();
      ringGain.gain.value = 0;
      carrier.connect(ringGain.gain);
      input.connect(ringGain);
      const wet = ctx.createGain(); wet.gain.value = 1;
      const dry = ctx.createGain(); dry.gain.value = 0;
      const out = ctx.createGain();
      ringGain.connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: { frequency: carrier.frequency },
        output: out,
        setParam(name, value) {
          if (name === 'waveform') carrier.type = value;
          else if (name === 'freq') carrier.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() {
          try { carrier.stop(); } catch (e) {}
          [carrier, input, ringGain, wet, dry, out].forEach((n) => n.disconnect());
        },
      };
    },
  },

  gate: {
    id: 'gate',
    label: 'Gate',
    category: 'processor',
    color: '#F2A65A',
    desc: 'rhythm chopper / rave gate',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'rate_mod', label: 'Rate', kind: 'param', param: 'rate' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'rate', label: 'Rate', type: 'range', min: 0.5, max: 32, step: 0.1, default: 8, scale: 'hz' },
      { name: 'duty', label: 'Duty', type: 'range', min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
      { name: 'depth', label: 'Depth', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    // The classic trance/rave gate: a sawtooth clock through a threshold
    // WaveShaper becomes a variable-duty 0/1 pulse, scaled by -depth and
    // summed onto the gain's own AudioParam (base 1) — swings the signal
    // between silent and full on every cycle. Turn any sustained tone into a
    // rhythmic chop without touching a keyboard.
    build(ctx) {
      const input = ctx.createGain();
      const clock = ctx.createOscillator();
      clock.type = 'sawtooth';
      clock.frequency.value = 8;
      clock.start();
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDutyCurve(0.5);
      shaper.oversample = 'none';
      const depthGain = ctx.createGain();
      depthGain.gain.value = -1;
      clock.connect(shaper).connect(depthGain);
      const gateNode = ctx.createGain();
      gateNode.gain.value = 1;
      depthGain.connect(gateNode.gain);
      input.connect(gateNode);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: { rate: clock.frequency },
        output: gateNode,
        setParam(name, value) {
          if (name === 'rate') clock.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'duty') shaper.curve = makeDutyCurve(value);
          else if (name === 'depth') depthGain.gain.setTargetAtTime(-value, ctx.currentTime, 0.01);
        },
        dispose() {
          try { clock.stop(); } catch (e) {}
          [input, clock, shaper, depthGain, gateNode].forEach((n) => n.disconnect());
        },
      };
    },
  },

  field: {
    id: 'field',
    label: 'Field',
    category: 'processor',
    color: '#6FA8D8',
    desc: 'stepped stereo pan',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'rate_mod', label: 'Rate', kind: 'param', param: 'rate' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    // A sine LFO through a staircase WaveShaper (same quantization curve as
    // Crush, applied to a control signal instead of audio) drives the pan
    // AudioParam, so position jumps between fixed steps instead of sweeping.
    params: [
      { name: 'rate', label: 'Rate', type: 'range', min: 0.02, max: 10, step: 0.01, default: 0.5, scale: 'hz' },
      { name: 'steps', label: 'Steps', type: 'range', min: 2, max: 8, step: 1, default: 4 },
      { name: 'depth', label: 'Depth', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.5;
      lfo.start();
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeStepCurve(4);
      shaper.oversample = 'none';
      const depthGain = ctx.createGain();
      depthGain.gain.value = 1;
      lfo.connect(shaper).connect(depthGain).connect(panner.pan);
      input.connect(panner);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: { rate: lfo.frequency },
        output: panner,
        setParam(name, value) {
          if (name === 'rate') lfo.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'steps') shaper.curve = makeStepCurve(value);
          else if (name === 'depth') depthGain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() {
          try { lfo.stop(); } catch (e) {}
          [input, panner, lfo, shaper, depthGain].forEach((n) => n.disconnect());
        },
      };
    },
  },

  reverb: {
    id: 'reverb',
    label: 'Reverb',
    category: 'processor',
    color: '#6B6B8C',
    desc: 'reverberation',
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'size', label: 'Size', type: 'range', min: 0.1, max: 5, step: 0.1, default: 2, scale: 'time' },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 0.3 },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.buffer = makeReverbImpulse(ctx, 2, 2.5);
      const wet = ctx.createGain(); wet.gain.value = 0.3;
      const dry = ctx.createGain(); dry.gain.value = 0.7;
      const out = ctx.createGain();
      input.connect(conv).connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: {},
        output: out,
        setParam(name, value) {
          if (name === 'size') conv.buffer = makeReverbImpulse(ctx, value, 2.5);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() { [input, conv, wet, dry, out].forEach(n => n.disconnect()); },
      };
    },
  },

  shimmer: {
    id: 'shimmer',
    label: 'Shimmer',
    category: 'processor',
    color: '#B8A8D8',
    desc: 'chorus',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'rate_mod', label: 'Rate', kind: 'param', param: 'rate' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    // About as plain as a chorus circuit gets: a short (~18ms) delay, with a
    // slow sine LFO wobbling delayTime itself rather than mixing in a second
    // pitch-shifted voice — a time-varying delay is a disguised pitch shift.
    params: [
      { name: 'rate', label: 'Rate', type: 'range', min: 0.05, max: 5, step: 0.01, default: 0.5, scale: 'hz' },
      { name: 'depth', label: 'Depth', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, default: 0.45 },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.018;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.5;
      lfo.start();
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.005; // seconds of delay-time wobble at depth=0.5
      lfo.connect(lfoDepth).connect(delay.delayTime);
      const wet = ctx.createGain(); wet.gain.value = 0.45;
      const dry = ctx.createGain(); dry.gain.value = 0.55;
      const out = ctx.createGain();
      input.connect(delay).connect(wet).connect(out);
      input.connect(dry).connect(out);
      return {
        inputs: { in: { node: input, index: 0 } },
        audioParams: { rate: lfo.frequency },
        output: out,
        setParam(name, value) {
          if (name === 'rate') lfo.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'depth') lfoDepth.gain.setTargetAtTime(value * 0.01, ctx.currentTime, 0.01);
          else if (name === 'mix') { wet.gain.setTargetAtTime(value, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - value, ctx.currentTime, 0.01); }
        },
        dispose() {
          try { lfo.stop(); } catch (e) {}
          [input, delay, lfo, lfoDepth, wet, dry, out].forEach((n) => n.disconnect());
        },
      };
    },
  },

  math: {
    id: 'math',
    label: 'Math',
    category: 'processor',
    color: '#C9A227',
    desc: 'LFO×CV combiner',
    inputs: [
      { id: 'a', label: 'A', kind: 'audio' },
      { id: 'b', label: 'B', kind: 'audio' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'operation', label: 'Op', type: 'select', options: ['add', 'sub', 'mul', 'min', 'max', 'avg'], default: 'add' },
      { name: 'amount', label: 'Amt', type: 'range', min: -4, max: 4, step: 0.01, default: 1 },
      { name: 'offset', label: 'Offset', type: 'range', min: -2, max: 2, step: 0.01, default: 0 },
    ],
    build(ctx) {
      const node = new AudioWorkletNode(ctx, 'math-processor', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.postMessage({ op: 'add' });
      return {
        inputs: { a: { node, index: 0 }, b: { node, index: 1 } },
        audioParams: { amount: node.parameters.get('amount'), offset: node.parameters.get('offset') },
        output: node,
        setParam(name, value) {
          if (name === 'operation') node.port.postMessage({ op: value });
          else if (name === 'amount') node.parameters.get('amount').setTargetAtTime(value, ctx.currentTime, 0.01);
          else if (name === 'offset') node.parameters.get('offset').setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() { node.disconnect(); },
      };
    },
  },

  // ---------------- VIDEO ----------------

  videoOutput: {
    id: 'videoOutput',
    label: 'Video Output',
    category: 'video',
    color: '#5CC9E8',
    desc: 'oscilloscope / video output',
    inputs: [
      { id: 'in1', label: 'In 1', kind: 'audio' },
      { id: 'in2', label: 'In 2', kind: 'audio' },
      { id: 'in3', label: 'In 3', kind: 'audio' },
      { id: 'in4', label: 'In 4', kind: 'audio' },
    ],
    outputs: [],
    params: [
      { name: 'resolution', label: 'Res', type: 'select', options: ['320x240', '640x480', '1280x720', '1920x1080'], default: '640x480' },
      { name: 'operation', label: 'Combine', type: 'select', options: ['add', 'sub', 'mul', 'min', 'max', 'avg'], default: 'add' },
      { name: 'gain', label: 'Gain', type: 'range', min: 0, max: 4, step: 0.01, default: 1 },
    ],
    // Not an audio sink: no output port. Each connected input is tapped by its
    // own analyser so the canvas renderer can read live time-domain data and,
    // when 2+ inputs are patched in, combine them sample-wise with the same
    // add/sub/mul/min/max/avg vocabulary as the Math node before drawing.
    build(ctx) {
      const analysers = [0, 1, 2, 3].map(() => {
        const a = ctx.createAnalyser();
        a.fftSize = 1024;
        a.smoothingTimeConstant = 0;
        return a;
      });
      return {
        inputs: {
          in1: { node: analysers[0], index: 0 },
          in2: { node: analysers[1], index: 0 },
          in3: { node: analysers[2], index: 0 },
          in4: { node: analysers[3], index: 0 },
        },
        audioParams: {},
        output: null,
        analysers,
        setParam() {}, // resolution/operation/gain are read live from patch state by the canvas renderer
        dispose() { analysers.forEach((a) => a.disconnect()); },
      };
    },
  },

  nullNode: {
    id: 'nullNode',
    label: 'Null',
    category: 'processor',
    color: '#8A9199',
    desc: 'passive summing junction',
    // A plain unity-gain pass-through with no knobs at all — a neutral
    // junction point to land several chains on before they reach Output,
    // same idea as a "null" or "mult" utility module on a real rack.
    // alwaysCompact means its card renders in the tightest layout
    // (see renderNode() in canvas.js) no matter what the global Compact
    // toggle is set to — there's nothing on it that compacting would hide.
    alwaysCompact: true,
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [],
    build(ctx) {
      const g = ctx.createGain();
      g.gain.value = 1;
      return {
        inputs: { in: { node: g, index: 0 } },
        audioParams: {},
        output: g,
        setParam() {},
        dispose() { g.disconnect(); },
      };
    },
  },

  output: {
    id: 'output',
    label: 'Output',
    category: 'processor',
    color: '#F5F5F0',
    desc: 'output / master',
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [],
    params: [{ name: 'volume', label: 'Vol', type: 'range', min: 0, max: 1, step: 0.01, default: 0.8 }],
    build(ctx) {
      const g = ctx.createGain();
      g.gain.value = 0.8;
      return {
        inputs: { in: { node: g, index: 0 } },
        audioParams: { volume: g.gain },
        output: g,
        setParam(name, value) {
          if (name === 'volume') g.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        dispose() { g.disconnect(); },
      };
    },
  },
};

export function nodeTypesByCategory() {
  const map = { generator: [], processor: [], video: [] };
  for (const t of Object.values(NODE_TYPES)) map[t.category].push(t);
  return map;
}
