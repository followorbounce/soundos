// Combines two audio-rate signals sample-by-sample with a chosen operation.
// This exists because native Web Audio param connections can only *sum*
// incoming signals — multiply/min/max ("OR"-like) needs real per-sample math.
class MathProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 1, minValue: -10, maxValue: 10, automationRate: 'a-rate' },
      { name: 'offset', defaultValue: 0, minValue: -10, maxValue: 10, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this.op = 'add';
    this.port.onmessage = (e) => {
      if (e.data && e.data.op) this.op = e.data.op;
    };
  }

  process(inputs, outputs, parameters) {
    const a = inputs[0][0];
    const b = inputs[1][0];
    const out = outputs[0][0];
    if (!out) return true;
    const amount = parameters.amount;
    const offset = parameters.offset;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const av = a ? a[i] || 0 : 0;
      const bv = b ? b[i] || 0 : 0;
      const amt = amount.length > 1 ? amount[i] : amount[0];
      const off = offset.length > 1 ? offset[i] : offset[0];
      let v;
      switch (this.op) {
        case 'sub': v = av - bv; break;
        case 'mul': v = av * bv; break;
        case 'min': v = Math.min(av, bv); break;
        case 'max': v = Math.max(av, bv); break; // OR-like combine
        case 'avg': v = (av + bv) / 2; break;
        default: v = av + bv; // add / OR-like combine of control signals
      }
      out[i] = v * amt + off;
    }
    return true;
  }
}

registerProcessor('math-processor', MathProcessor);
