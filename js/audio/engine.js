import { NODE_TYPES } from '../nodeLibrary.js';
import { state } from '../state.js';

// Compiles the visual patch graph into one continuously-running audio graph —
// there is no per-note voice, no polyphony and no keyboard: generators build
// their oscillators/LFOs and .start() them immediately (same as every SoundOS
// node already did), Generate just wires the current patch together and
// unmutes the master bus. Turning the patch off again is a mute, not a
// teardown-and-retrigger — the whole point is that it oscillates permanently
// once running, exactly like a hardware modular rig left patched and powered.

function wireEdge(instances) {
  for (const edge of state.edges.values()) {
    const fromInst = instances.get(edge.from.nodeId);
    const toNode = state.nodes.get(edge.to.nodeId);
    const toInst = instances.get(edge.to.nodeId);
    if (!fromInst || !toInst || !toNode || !fromInst.output) continue;
    const toDef = NODE_TYPES[toNode.typeId];
    const portDef = toDef.inputs.find((p) => p.id === edge.to.port);
    if (!portDef) continue;
    try {
      if (portDef.kind === 'param') {
        const param = toInst.audioParams[portDef.param];
        if (param) fromInst.output.connect(param);
      } else {
        const target = toInst.inputs[portDef.id] || toInst.inputs.in;
        if (target) fromInst.output.connect(target.node, 0, target.index || 0);
      }
    } catch (err) {
      console.warn('SoundOS: connection failed', edge, err);
    }
  }
}

export class SynthEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.kill = null;
    this.compressor = null;
    this.instances = new Map(); // nodeId -> live instance, one single always-on graph
    this.workletReady = false;
    this.scopeAnalysers = new Map(); // nodeId -> AnalyserNode, for the per-node waveform toggle
    this.bypass = new Map(); // nodeId -> {wet, dry} bypass-crossfade gains
    this.powered = false;
  }

  async ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.kill = this.ctx.createGain();
    this.kill.gain.value = 1;
    this.compressor = this.ctx.createDynamicsCompressor();
    this.master.connect(this.kill).connect(this.compressor).connect(this.ctx.destination);
    await this.ctx.audioWorklet.addModule('js/audio/worklets/mathProcessor.js');
    this.workletReady = true;
  }

  async start() {
    await this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.rebuild();
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0.9, now, 0.05);
    this.powered = true;
  }

  rebuild() {
    this.disposeGraph();
    for (const [id, node] of state.nodes) {
      const def = NODE_TYPES[node.typeId];
      if (!def) continue;
      const inst = def.build(this.ctx);
      for (const p of def.params) inst.setParam(p.name, node.params[p.name] ?? p.default);
      this.instances.set(id, inst);
    }
    // Wrap every instance's own output in a bypass crossfade *before* wiring
    // the patch, so wireEdge (and the Output->master hookup below) route
    // through the wrapper — that's what makes a bypassed node's toggle
    // actually reach whatever it feeds downstream, live, without a rebuild.
    // Where the node exposes a distinct pre-processing input tap (its own
    // `in` isn't the same object as its `output`), bypass is a true dry
    // passthrough; otherwise — generators, and single-node processors like
    // Filter/Amp/Mixer where in and out are literally the same AudioNode —
    // bypass just mutes that node's contribution, the same as a footswitch
    // on a source unit with nothing patched into its own `in`.
    for (const [id, node] of state.nodes) {
      const inst = this.instances.get(id);
      if (!inst || !inst.output) continue;
      const rawOut = inst.output;
      const nodeOut = this.ctx.createGain();
      const bypassed = !!node.bypassed;
      const wet = this.ctx.createGain();
      wet.gain.value = bypassed ? 0 : 1;
      rawOut.connect(wet).connect(nodeOut);
      let dry = null;
      const dryTap = inst.inputs && inst.inputs.in && inst.inputs.in.node !== rawOut ? inst.inputs.in.node : null;
      if (dryTap) {
        dry = this.ctx.createGain();
        dry.gain.value = bypassed ? 1 : 0;
        dryTap.connect(dry).connect(nodeOut);
      }
      inst.output = nodeOut;
      this.bypass.set(id, { wet, dry });
    }
    wireEdge(this.instances);
    for (const [id, node] of state.nodes) {
      if (node.typeId === 'output') {
        const inst = this.instances.get(id);
        if (inst && inst.output) inst.output.connect(this.master);
      }
    }
    for (const [id, inst] of this.instances) {
      if (!inst.output) continue;
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      try { inst.output.connect(analyser); } catch (e) {}
      this.scopeAnalysers.set(id, analyser);
    }
    // Envelope nodes gate a shape open on demand; with no keyboard to trigger
    // them, open every one once per rebuild so an Envelope->Amp patch still
    // sounds instead of sitting silently closed — including after a live
    // re-patch (rebuild runs again on every structural edit while playing,
    // not just on the initial Generate).
    const now = this.ctx.currentTime;
    for (const inst of this.instances.values()) inst.gateOn?.(now);
  }

  getScopeAnalyser(nodeId) {
    return this.scopeAnalysers.get(nodeId) || null;
  }

  // Live bypass toggle — no rebuild needed, just crossfades the wrapper
  // gains created in rebuild(). Same 8ms time constant as the reference.
  setBypass(nodeId, bypassed) {
    const b = this.bypass.get(nodeId);
    if (!b || !this.ctx) return;
    const now = this.ctx.currentTime;
    b.wet.gain.cancelScheduledValues(now);
    b.wet.gain.setTargetAtTime(bypassed ? 0 : 1, now, 0.008);
    if (b.dry) {
      b.dry.gain.cancelScheduledValues(now);
      b.dry.gain.setTargetAtTime(bypassed ? 1 : 0, now, 0.008);
    }
  }

  // Momentary mute-all — held, not toggled, the same gesture as a hand on a
  // mixer's mute button. Lives on its own gain stage so it never fights the
  // power on/off fade happening on `master` at the same time.
  setKill(active) {
    if (!this.ctx || !this.kill) return;
    const now = this.ctx.currentTime;
    this.kill.gain.cancelScheduledValues(now);
    this.kill.gain.setTargetAtTime(active ? 0 : 1, now, 0.003);
  }

  isLive() {
    return !!this.ctx && this.powered;
  }

  disposeGraph() {
    for (const inst of this.instances.values()) {
      try { inst.dispose(); } catch (e) {}
    }
    this.instances.clear();
    this.scopeAnalysers.clear();
    this.bypass.clear();
  }

  async stop() {
    if (this.ctx && this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(0, now, 0.05);
    }
    this.powered = false;
    await new Promise((r) => setTimeout(r, 120)); // let the fade-out finish before tearing the graph down
    this.disposeGraph();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.master = null;
      this.kill = null;
      this.compressor = null;
      this.workletReady = false;
    }
  }

  updateParam(nodeId, name, value) {
    this.instances.get(nodeId)?.setParam(name, value);
  }
}

export const engine = new SynthEngine();
