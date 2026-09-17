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
