// Systematized node database: every node type declares its ports, params and
// a build(ctx) factory that returns a live-audio instance with a uniform contract:
//
//   instance = {
//     inputs:   { portId: { node: AudioNode, index: number } }   // kind:'audio' ports
//     audioParams: { paramName: AudioParam }                     // kind:'param' ports
//     output:   AudioNode | null                                 // single output port
//     setParam(name, value)
//     applyNote(freq)   // optional, generators that track the keyboard
//     gateOn(time) / gateOff(time)  // optional, envelope-style generators
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
  generator: { label: 'Генераторы', color: '#d98a3d' },
  processor: { label: 'Обработка', color: '#4f8bff' },
};

export const NODE_TYPES = {
  // ---------------- GENERATORS ----------------

  oscillator: {
    id: 'oscillator',
    label: 'Oscillator',
    category: 'generator',
    desc: 'тон / VCO',
    inputs: [
      { id: 'freq_mod', label: 'Freq', kind: 'param', param: 'frequency' },
      { id: 'detune_mod', label: 'Detune', kind: 'param', param: 'detune' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'waveform', label: 'Wave', type: 'select', options: ['sine', 'square', 'sawtooth', 'triangle'], default: 'sine' },
      { name: 'freq', label: 'Freq', type: 'range', min: 20, max: 2000, step: 1, default: 440 },
      { name: 'keyTrack', label: 'Key trk', type: 'bool', default: true },
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
      let keyTrack = true;
      let baseFreq = 440;
      return {
        inputs: {},
        audioParams: { frequency: osc.frequency, detune: osc.detune },
        output: gain,
        setParam(name, value) {
          if (name === 'waveform') osc.type = value;
          else if (name === 'freq') {
            baseFreq = value;
            if (!keyTrack) osc.frequency.setTargetAtTime(value, ctx.currentTime, 0.01);
          } else if (name === 'keyTrack') {
            keyTrack = value;
            if (!keyTrack) osc.frequency.setTargetAtTime(baseFreq, ctx.currentTime, 0.01);
          } else if (name === 'level') gain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
        },
        applyNote(freq) {
          if (keyTrack) osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.004);
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
    desc: 'модуляция',
    inputs: [{ id: 'rate_mod', label: 'Rate', kind: 'param', param: 'frequency' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'waveform', label: 'Wave', type: 'select', options: ['sine', 'square', 'sawtooth', 'triangle'], default: 'sine' },
      { name: 'rate', label: 'Rate', type: 'range', min: 0.02, max: 20, step: 0.01, default: 2 },
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
    desc: 'шум',
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
    desc: 'ADSR / CV',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'attack', label: 'Atk', type: 'range', min: 0, max: 4, step: 0.01, default: 0.02 },
      { name: 'decay', label: 'Dec', type: 'range', min: 0, max: 4, step: 0.01, default: 0.2 },
      { name: 'sustain', label: 'Sus', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7 },
      { name: 'release', label: 'Rel', type: 'range', min: 0, max: 4, step: 0.01, default: 0.3 },
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

  // ---------------- PROCESSORS ----------------

  filter: {
    id: 'filter',
    label: 'Filter',
    category: 'processor',
    desc: 'фильтр',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'freq_mod', label: 'Cutoff', kind: 'param', param: 'frequency' },
      { id: 'q_mod', label: 'Q', kind: 'param', param: 'Q' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'type', label: 'Type', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'], default: 'lowpass' },
      { name: 'frequency', label: 'Cutoff', type: 'range', min: 20, max: 18000, step: 1, default: 1200 },
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
    desc: 'усилитель',
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
    desc: 'сумматор',
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
    desc: 'эхо',
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'time_mod', label: 'Time', kind: 'param', param: 'delayTime' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'time', label: 'Time', type: 'range', min: 0, max: 2, step: 0.01, default: 0.3 },
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

  distortion: {
    id: 'distortion',
    label: 'Distortion',
    category: 'processor',
    desc: 'дисторшн',
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

  reverb: {
    id: 'reverb',
    label: 'Reverb',
    category: 'processor',
    desc: 'реверберация',
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { name: 'size', label: 'Size', type: 'range', min: 0.1, max: 5, step: 0.1, default: 2 },
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

  math: {
    id: 'math',
    label: 'Math',
    category: 'processor',
    desc: 'LFO×CV комбинатор',
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

  output: {
    id: 'output',
    label: 'Output',
    category: 'processor',
    desc: 'выход / мастер',
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
  const map = { generator: [], processor: [] };
  for (const t of Object.values(NODE_TYPES)) map[t.category].push(t);
  return map;
}
