import { NODE_TYPES } from './nodeLibrary.js';
import { state, onChange, moveNode, removeNode, setParam, addEdge, removeEdge, toggleBypass, setBypassState } from './state.js';
import { engine } from './audio/engine.js';

const viewport = document.getElementById('canvas-viewport');
const inner = document.getElementById('canvas-inner');
const nodesLayer = document.getElementById('nodes-layer');
const svg = document.getElementById('wires-svg');

const nodeEls = new Map(); // id -> element
let dragState = null; // node drag
let wireDraft = null; // {fromNodeId, fromPort, x1, y1}
let panState = null;
let selectedId = null;
let scopeMode = 'wave'; // 'wave' | 'spectrum' — global, toggled from the toolbar, same as Pulse Train's Scopes button
const VIDEO_PORTS = ['in1', 'in2', 'in3', 'in4'];

export function setScopeMode(mode) {
  scopeMode = mode;
}

// Reshuffle every continuous knob on the board — a "Chance" button for live
// performance, same idea as Pulse Train's randomizer, but general-purpose
// across whatever nodes happen to be patched in right now.
export function randomizeAllParams() {
  for (const node of state.nodes.values()) {
    const def = NODE_TYPES[node.typeId];
    if (!def) continue;
    for (const p of def.params) {
      if (p.type === 'select' || p.type === 'bool') continue;
      const raw = p.min + Math.random() * (p.max - p.min);
      const stepped = p.step ? Math.round(raw / p.step) * p.step : raw;
      const value = Math.min(p.max, Math.max(p.min, stepped));
      setParam(node.id, p.name, value);
      if (engine.isLive()) engine.updateParam(node.id, p.name, value);
    }
  }
  fullRender();
}

// Apply a preset by role name (see js/presets.js): `roles` maps a role like
// 'tone2' or 'space' to the actual node id in the current patch, so this
// works against whatever the starter rack currently is, not fixed ids.
export function applyPreset(roles, params, bypass) {
  for (const [role, values] of Object.entries(params || {})) {
    const id = roles[role];
    if (!id || !state.nodes.has(id)) continue;
    for (const [name, value] of Object.entries(values)) {
      setParam(id, name, value);
      if (engine.isLive()) engine.updateParam(id, name, value);
    }
  }
  for (const [role, bypassed] of Object.entries(bypass || {})) {
    const id = roles[role];
    if (!id || !state.nodes.has(id)) continue;
    setBypassState(id, bypassed);
    if (engine.isLive()) engine.setBypass(id, bypassed);
  }
  fullRender();
}

export function screenToInner(clientX, clientY) {
  const r = inner.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

export function currentViewportCell() {
  return { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, w: viewport.clientWidth, h: viewport.clientHeight };
}

function nubEl(nodeId, portId, dir) {
  return nodesLayer.querySelector(`.module[data-id="${nodeId}"] .nub[data-port="${portId}"][data-dir="${dir}"]`);
}

function portPos(nodeId, portId, dir) {
  const el = nubEl(nodeId, portId, dir);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const innerR = inner.getBoundingClientRect();
  return { x: r.left + r.width / 2 - innerR.left, y: r.top + r.height / 2 - innerR.top };
}

function bezier(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function renderWires() {
  svg.innerHTML = '';
  for (const edge of state.edges.values()) {
    const p1 = portPos(edge.from.nodeId, edge.from.port, 'out');
    const p2 = portPos(edge.to.nodeId, edge.to.port, 'in');
    if (!p1 || !p2) continue;
    const fromNode = state.nodes.get(edge.from.nodeId);
    const color = (fromNode && NODE_TYPES[fromNode.typeId]?.color) || '#F5F5F0';
    const d = bezier(p1.x, p1.y, p2.x, p2.y);
    const disconnect = (e) => { e.stopPropagation(); removeEdge(edge.id); };

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.8');
    svg.appendChild(path);

    // A thin 2px stroke is nearly impossible to click precisely — this
    // invisible, much fatter twin sits on top and does the actual hit
    // testing, so clicking anywhere near the cable disconnects it.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '16');
    hit.setAttribute('fill', 'none');
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', disconnect);
    svg.appendChild(hit);

    // Explicit "disconnect" marker at the cable's midpoint — a real tool,
    // not just a hope that the click lands on the wire.
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    marker.setAttribute('class', 'wire-marker');
    marker.style.cursor = 'pointer';
    marker.style.pointerEvents = 'auto'; // parent svg is pointer-events:none for background panning; this element opts back in
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', mx); dot.setAttribute('cy', my); dot.setAttribute('r', '7');
    dot.setAttribute('fill', '#141414'); dot.setAttribute('stroke', color); dot.setAttribute('stroke-width', '1.5');
    const cross = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    cross.setAttribute('x', mx); cross.setAttribute('y', my);
    cross.setAttribute('text-anchor', 'middle'); cross.setAttribute('dominant-baseline', 'central');
    cross.setAttribute('font-size', '10'); cross.setAttribute('fill', '#F5F5F0');
    cross.textContent = '×';
    marker.append(dot, cross);
    marker.addEventListener('click', disconnect);
    svg.appendChild(marker);
  }
  if (wireDraft) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', bezier(wireDraft.x1, wireDraft.y1, wireDraft.x2, wireDraft.y2));
    path.setAttribute('stroke', '#F5F5F0');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '4 3');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  }
}

function fmt(v) {
  if (typeof v !== 'number') return v;
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
}

function onParamInput(nodeId, name, value) {
  setParam(nodeId, name, value);
  if (engine.isLive()) engine.updateParam(nodeId, name, value);
  if (name === 'resolution') {
    const canvas = nodeEls.get(nodeId)?.querySelector('.mvideo-canvas');
    if (canvas) applyVideoResolution(canvas, value);
  }
}

function applyVideoResolution(canvas, resStr) {
  const [w, h] = (resStr || '640x480').split('x').map(Number);
  canvas.width = w || 640;
  canvas.height = h || 480;
}

// --- Rotary knob: drag vertically to change value, like a real pot. ---
function buildKnob(nodeId, def, node) {
  const wrap = document.createElement('div');
  wrap.className = 'knobwrap';

  const klabel = document.createElement('span');
  klabel.className = 'klabel';
  klabel.textContent = def.label;

  const knob = document.createElement('div');
  knob.className = 'knob';
  const ind = document.createElement('div');
  ind.className = 'ind';
  knob.appendChild(ind);

  const kval = document.createElement('span');
  kval.className = 'kval';

  const range = def.max - def.min;
  const apply = (value) => {
    const t = range === 0 ? 0 : (value - def.min) / range;
    knob.style.setProperty('--t', t);
    ind.style.transform = `rotate(${-135 + t * 270}deg)`;
    kval.textContent = fmt(value);
  };
  apply(node.params[def.name]);

  knob.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startValue = node.params[def.name];
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      const step = def.step || (range / 100) || 1;
      let value = startValue + (dy / 150) * range;
      value = Math.round(value / step) * step;
      value = Math.min(def.max, Math.max(def.min, value));
      apply(value);
      onParamInput(nodeId, def.name, value);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  wrap.append(klabel, knob, kval);
  return wrap;
}

function buildSwitch(nodeId, def, node) {
  const wrap = document.createElement('div');
  wrap.className = 'switchwrap';
  const klabel = document.createElement('span');
  klabel.className = 'klabel';
  klabel.textContent = def.label;
  const sw = document.createElement('div');
  sw.className = 'fswitch';
  const led = document.createElement('div');
  led.className = 'led';
  sw.appendChild(led);
  const setEngaged = (on) => sw.classList.toggle('engaged', !!on);
  setEngaged(node.params[def.name]);
  sw.addEventListener('mousedown', (e) => e.stopPropagation());
  sw.addEventListener('click', () => {
    const value = !node.params[def.name];
    setEngaged(value);
    onParamInput(nodeId, def.name, value);
  });
  wrap.append(sw, klabel);
  return wrap;
}

function buildSelect(nodeId, def, node) {
  const wrap = document.createElement('div');
  wrap.className = 'selectfield';
  const sel = document.createElement('select');
  sel.className = 'mselect';
  for (const opt of def.options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === node.params[def.name]) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('mousedown', (e) => e.stopPropagation());
  sel.addEventListener('change', () => onParamInput(nodeId, def.name, sel.value));
  wrap.appendChild(sel);
  return wrap;
}

function paramControl(nodeId, def, node) {
  if (def.type === 'select') return buildSelect(nodeId, def, node);
  if (def.type === 'bool') return buildSwitch(nodeId, def, node);
  return buildKnob(nodeId, def, node);
}

function buildJack(nodeId, port, dir) {
  const jack = document.createElement('div');
  jack.className = `jack ${dir}` + (port.kind === 'param' ? ' cv' : '');
  const nub = document.createElement('div');
  nub.className = 'nub';
  nub.dataset.node = nodeId;
  nub.dataset.port = port.id;
  nub.dataset.dir = dir;
  const lbl = document.createElement('span');
  lbl.textContent = port.label;
  if (dir === 'out') {
    nub.addEventListener('mousedown', (e) => startWire(e, nodeId, port.id));
  } else {
    nub.addEventListener('mouseup', () => finishWire(nodeId, port.id));
  }
  jack.append(nub, lbl);
  return jack;
}

function renderNode(node) {
  const def = NODE_TYPES[node.typeId];
  if (!def) return;
  let el = nodeEls.get(node.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'module';
    el.dataset.id = node.id;
    nodesLayer.appendChild(el);
    nodeEls.set(node.id, el);
  }
  el.style.left = node.x + 'px';
  el.style.top = node.y + 'px';
  el.style.setProperty('--acc', def.color);
  el.classList.toggle('bypassed', !!node.bypassed);
  el.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'mhead';
  const headLeft = document.createElement('div');
  headLeft.className = 'mhead-left';
  const name = document.createElement('span');
  name.className = 'mname';
  name.textContent = def.label;
  headLeft.appendChild(name);

  const bypassBtn = document.createElement('button');
  bypassBtn.className = 'fswitch' + (node.bypassed ? '' : ' engaged');
  bypassBtn.title = (def.id === 'videoOutput' ? 'Пауза видео: ' : 'Байпас: ') + def.label;
  bypassBtn.appendChild(Object.assign(document.createElement('span'), { className: 'led' }));
  bypassBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  bypassBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const bypassed = toggleBypass(node.id);
    bypassBtn.classList.toggle('engaged', !bypassed);
    el.classList.toggle('bypassed', bypassed);
    if (engine.isLive()) engine.setBypass(node.id, bypassed);
  });
  headLeft.appendChild(bypassBtn);
  head.appendChild(headLeft);

  const del = document.createElement('button');
  del.className = 'mdel';
  del.textContent = '×';
  del.title = 'Удалить ноду';
  del.addEventListener('mousedown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => { e.stopPropagation(); removeNode(node.id); });
  head.appendChild(del);
  head.addEventListener('mousedown', (e) => startNodeDrag(e, node));
  el.appendChild(head);

  const tag = document.createElement('span');
  tag.className = 'mtag';
  tag.textContent = def.desc;
  el.appendChild(tag);

  if (def.inputs.length || def.outputs.length) {
    const jackgroups = document.createElement('div');
    jackgroups.className = 'jackgroups';
    const colIn = document.createElement('div');
    colIn.className = 'jackcol in';
    for (const p of def.inputs) colIn.appendChild(buildJack(node.id, p, 'in'));
    const colOut = document.createElement('div');
    colOut.className = 'jackcol out';
    for (const p of def.outputs) colOut.appendChild(buildJack(node.id, p, 'out'));
    jackgroups.append(colIn, colOut);
    el.appendChild(jackgroups);
  }

  const body = document.createElement('div');
  body.className = 'mbody';
  for (const p of def.params) body.appendChild(paramControl(node.id, p, node));
  if (def.id === 'envelope') {
    const btn = document.createElement('button');
    btn.className = 'btn mtest';
    btn.textContent = 'Test ▸';
    btn.addEventListener('mousedown', (e) => { e.stopPropagation(); engine.isLive() && engine.instances.get(node.id)?.gateOn(engine.ctx.currentTime); });
    btn.addEventListener('mouseup', () => engine.isLive() && engine.instances.get(node.id)?.gateOff(engine.ctx.currentTime));
    body.appendChild(btn);
  }
  el.appendChild(body);

  if (def.outputs.length) {
    const scopeWrap = document.createElement('div');
    scopeWrap.className = 'scopewrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'mscope-canvas';
    canvas.width = 260;
    canvas.height = 56;
    scopeWrap.appendChild(canvas);
    el.appendChild(scopeWrap);
  }

  if (def.id === 'videoOutput') {
    const canvas = document.createElement('canvas');
    canvas.className = 'mvideo-canvas';
    applyVideoResolution(canvas, node.params.resolution);
    el.appendChild(canvas);
    const actions = document.createElement('div');
    actions.className = 'mvideo-actions';
    const fsBtn = document.createElement('button');
    fsBtn.className = 'btn mvideo-fullscreen';
    fsBtn.textContent = '⛶ Fullscreen';
    fsBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    fsBtn.addEventListener('click', (e) => { e.stopPropagation(); canvas.requestFullscreen?.(); });
    actions.appendChild(fsBtn);
    el.appendChild(actions);
  }

  el.addEventListener('mousedown', () => selectNode(node.id));
}

function selectNode(id) {
  selectedId = id;
  for (const [nid, el] of nodeEls) el.classList.toggle('selected', nid === id);
}

function startNodeDrag(e, node) {
  e.preventDefault();
  e.stopPropagation();
  selectNode(node.id);
  const startX = e.clientX, startY = e.clientY;
  const origX = node.x, origY = node.y;
  dragState = { node, startX, startY, origX, origY };
  document.addEventListener('mousemove', onNodeDragMove);
  document.addEventListener('mouseup', onNodeDragEnd);
}
function onNodeDragMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  moveNode(dragState.node.id, Math.max(0, dragState.origX + dx), Math.max(0, dragState.origY + dy));
}
function onNodeDragEnd() {
  dragState = null;
  document.removeEventListener('mousemove', onNodeDragMove);
  document.removeEventListener('mouseup', onNodeDragEnd);
}

function startWire(e, nodeId, portId) {
  e.preventDefault();
  e.stopPropagation();
  const p = portPos(nodeId, portId, 'out');
  wireDraft = { fromNodeId: nodeId, fromPort: portId, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  document.addEventListener('mousemove', onWireMove);
  document.addEventListener('mouseup', cancelWire);
}
function onWireMove(e) {
  if (!wireDraft) return;
  const p = screenToInner(e.clientX, e.clientY);
  wireDraft.x2 = p.x; wireDraft.y2 = p.y;
  renderWires();
}
function finishWire(toNodeId, toPortId) {
  if (!wireDraft) return;
  addEdge(wireDraft.fromNodeId, wireDraft.fromPort, toNodeId, toPortId);
  cancelWire();
}
function cancelWire() {
  wireDraft = null;
  document.removeEventListener('mousemove', onWireMove);
  document.removeEventListener('mouseup', cancelWire);
  renderWires();
}

// Pan the canvas by dragging empty background.
viewport.addEventListener('mousedown', (e) => {
  // nodesLayer fully covers the canvas, so an "empty background" click
  // actually lands on it (or inner/svg) rather than the viewport itself.
  if (e.target !== viewport && e.target !== inner && e.target !== nodesLayer && e.target !== svg) return;
  panState = { startX: e.clientX, startY: e.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
  selectNode(null);
});
document.addEventListener('mousemove', (e) => {
  if (!panState) return;
  viewport.scrollLeft = panState.scrollLeft - (e.clientX - panState.startX);
  viewport.scrollTop = panState.scrollTop - (e.clientY - panState.startY);
});
document.addEventListener('mouseup', () => { panState = null; });

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
    removeNode(selectedId);
    selectedId = null;
  }
});

function drawScope(canvas, analyser, color) {
  const ctx2d = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx2d.fillStyle = '#000';
  ctx2d.fillRect(0, 0, w, h);
  if (scopeMode === 'spectrum') {
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    const barCount = Math.min(48, freqData.length);
    const barW = w / barCount;
    ctx2d.fillStyle = color;
    for (let i = 0; i < barCount; i++) {
      const v = (freqData[i] / 255) * h;
      ctx2d.fillRect(i * barW, h - v, Math.max(1, barW - 1), v);
    }
  } else {
    const timeData = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeData);
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const n = timeData.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h / 2 - timeData[i] * (h / 2 - 2);
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
  }
}

function connectedVideoPorts(nodeId) {
  return VIDEO_PORTS.filter((pid) =>
    [...state.edges.values()].some((e) => e.to.nodeId === nodeId && e.to.port === pid)
  );
}

function combineSamples(op, vals) {
  switch (op) {
    case 'sub': return vals.reduce((a, b, i) => (i === 0 ? a : a - b));
    case 'mul': return vals.reduce((a, b) => a * b, 1);
    case 'min': return Math.min(...vals);
    case 'max': return Math.max(...vals);
    case 'avg': return vals.reduce((a, b) => a + b, 0) / vals.length;
    default: return vals.reduce((a, b) => a + b, 0); // add
  }
}

function drawVideoNode(node, canvas) {
  const ctx2d = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx2d.fillStyle = '#000';
  ctx2d.fillRect(0, 0, w, h);
  const inst = engine.instances.get(node.id);
  if (!inst?.analysers) return;
  const ports = connectedVideoPorts(node.id);
  if (!ports.length) return;
  const arrays = ports.map((pid) => {
    const analyser = inst.analysers[VIDEO_PORTS.indexOf(pid)];
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    return buf;
  });
  const op = node.params.operation || 'add';
  const gain = node.params.gain ?? 1;
  const n = arrays[0].length;
  ctx2d.strokeStyle = NODE_TYPES.videoOutput.color;
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, combineSamples(op, arrays.map((a) => a[i])) * gain));
    const x = (i / (n - 1)) * w;
    const y = h / 2 - v * (h / 2 - 4);
    if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}

function tickScopes() {
  if (engine.isLive()) {
    for (const node of state.nodes.values()) {
      const canvas = nodeEls.get(node.id)?.querySelector('.mscope-canvas');
      const analyser = engine.getScopeAnalyser(node.id);
      if (!canvas || !analyser) continue;
      drawScope(canvas, analyser, NODE_TYPES[node.typeId]?.color || '#F5F5F0');
    }
    for (const node of state.nodes.values()) {
      if (node.typeId !== 'videoOutput' || node.bypassed) continue;
      const canvas = nodeEls.get(node.id)?.querySelector('.mvideo-canvas');
      if (canvas) drawVideoNode(node, canvas);
    }
  }
  requestAnimationFrame(tickScopes);
}

function fullRender() {
  for (const id of [...nodeEls.keys()]) {
    if (!state.nodes.has(id)) { nodeEls.get(id).remove(); nodeEls.delete(id); }
  }
  for (const node of state.nodes.values()) renderNode(node);
  svg.setAttribute('width', inner.offsetWidth);
  svg.setAttribute('height', inner.offsetHeight);
  renderWires();
}

onChange((kind, payload) => {
  if (kind === 'param-change') return; // params re-render locally, no full redraw needed
  if (kind === 'node-move') {
    // Fast path: dragging fires on every mousemove, avoid rebuilding all DOM.
    const el = nodeEls.get(payload);
    const node = state.nodes.get(payload);
    if (el && node) {
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      renderWires();
    }
    return;
  }
  fullRender();
});

export function initCanvas() {
  fullRender();
  requestAnimationFrame(tickScopes);
}
