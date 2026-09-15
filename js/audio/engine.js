import { NODE_TYPES } from '../nodeLibrary.js';
import { state } from '../state.js';

// Compiles the visual patch graph into a real, playable polyphonic synth.
// Each "voice" is an independent clone of the whole node graph (generators
// through processors up to the Output node); voices share one master bus.
// This keeps the model simple: whatever you patch is exactly what each
// played note runs through.

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

class Voice {
  constructor(ctx, masterBus) {
    this.ctx = ctx;
    this.instances = new Map();
    for (const [id, node] of state.nodes) {
      const def = NODE_TYPES[node.typeId];
      if (!def) continue;
      const inst = def.build(ctx);
      for (const p of def.params) inst.setParam(p.name, node.params[p.name] ?? p.default);
      this.instances.set(id, inst);
    }
    wireEdge(this.instances);
    for (const [id, node] of state.nodes) {
      if (node.typeId === 'output') {
        const inst = this.instances.get(id);
        if (inst && inst.output) inst.output.connect(masterBus);
      }
    }
    this.busy = false;
    this.note = null;
  }

  noteOn(freq) {
    const t = this.ctx.currentTime;
    for (const inst of this.instances.values()) {
      inst.applyNote?.(freq);
      inst.gateOn?.(t);
    }
  }

  noteOff() {
    const t = this.ctx.currentTime;
    for (const inst of this.instances.values()) inst.gateOff?.(t);
  }

  setParam(nodeId, name, value) {
    this.instances.get(nodeId)?.setParam(name, value);
  }

  dispose() {
    for (const inst of this.instances.values()) {
      try { inst.dispose(); } catch (e) {}
    }
    this.instances.clear();
  }
}

export class SynthEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.voices = [];
    this.noteMap = new Map();
    this.workletReady = false;
  }

  async ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.compressor = this.ctx.createDynamicsCompressor();
    this.master.connect(this.compressor).connect(this.ctx.destination);
    await this.ctx.audioWorklet.addModule('js/audio/worklets/mathProcessor.js');
    this.workletReady = true;
  }

  async start(polyphony) {
    await this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.rebuild(polyphony);
  }

  rebuild(polyphony) {
    this.disposeVoices();
    const count = Math.max(1, Math.min(16, polyphony | 0));
    this.voices = Array.from({ length: count }, () => new Voice(this.ctx, this.master));
  }

  isLive() {
    return !!this.ctx && this.voices.length > 0;
  }

  disposeVoices() {
    for (const v of this.voices) v.dispose();
    this.voices = [];
    this.noteMap.clear();
  }

  async stop() {
    this.disposeVoices();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.master = null;
      this.compressor = null;
      this.workletReady = false;
    }
  }

  noteOn(noteKey, freq) {
    if (!this.isLive()) return;
    let voice = this.voices.find((v) => !v.busy);
    if (!voice) {
      voice = this.voices.reduce((oldest, v) => (v.startedAt < oldest.startedAt ? v : oldest), this.voices[0]);
      // Stealing a busy voice: drop whatever old note key still points to it,
      // or that key's later note-off would wrongly cut the new note short.
      for (const [k, v] of this.noteMap) if (v === voice) this.noteMap.delete(k);
    }
    voice.busy = true;
    voice.note = noteKey;
    voice.startedAt = this.ctx.currentTime;
    voice.noteOn(freq);
    this.noteMap.set(noteKey, voice);
  }

  noteOff(noteKey) {
    const voice = this.noteMap.get(noteKey);
    if (!voice) return;
    voice.noteOff();
    voice.busy = false;
    this.noteMap.delete(noteKey);
  }

  updateParam(nodeId, name, value) {
    for (const v of this.voices) v.setParam(nodeId, name, value);
  }
}

export const engine = new SynthEngine();
