import { NODE_TYPES } from './nodeLibrary.js';
import { state, onChange, moveNode, removeNode, setParam, addEdge, removeEdge, toggleBypass, setBypassState, checkpoint, undo, redo } from './state.js';
import { engine } from './audio/engine.js';
import { toggleRecord, togglePlay, getStatus, setApplyHook, setStatusHook, setTrim, BYPASS_KEY, MAX_RECORD_MS } from './recorder.js';

const viewport = document.getElementById('canvas-viewport');
const inner = document.getElementById('canvas-inner');
const nodesLayer = document.getElementById('nodes-layer');
const svg = document.getElementById('wires-svg');

const nodeEls = new Map(); // id -> element
// nodeId -> Map(paramName -> fn(value)) that repaints that control's own visuals.
// Loop playback (recorder.js) changes params without the user touching the
// controls, so it needs a way to move the knobs/switches/selects on screen.
const controlSync = new Map();
let dragState = null; // node drag
let wireDraft = null; // {fromNodeId, fromPort, x1, y1, x2, y2, snapTarget, snapEl} while dragging a new wire
let panState = null;
let selectedId = null;
let scopeMode = 'wave'; // 'wave' | 'spectrum' — global, toggled from the toolbar, same as Pulse Train's Scopes button
let compactMode = false;
const VIDEO_PORTS = ['in1', 'in2', 'in3', 'in4'];

// Compact mode doesn't just hide the scope with CSS — renderNode() below
// skips creating the scope canvas at all, and applies a `.compact` class
// directly on each module (not a body-level ancestor class), so there's no
// cascade/specificity path for this to silently not take effect.
//
// It also repacks the whole board: turning compact on snaps every node into
// a tight grid (nearest-neighbor column clustering on current x, then
// stacked by y within each column) instead of just shrinking cards and
// leaving the old, wide gaps between them. The pre-compact positions are
// remembered and restored exactly when compact turns back off.
let expandedPositions = null; // Map<nodeId, {x, y}> captured just before packing

export function setCompactMode(on) {
  compactMode = on;
  if (on) packLayout(); else unpackLayout();
  fullRender();
}

const PACK_COL_GAP = 150, PACK_ROW_GAP = 112, PACK_MARGIN = 24, PACK_COL_TOLERANCE = 150;

function packLayout() {
  checkpoint();
  expandedPositions = new Map();
  for (const [id, node] of state.nodes) expandedPositions.set(id, { x: node.x, y: node.y });

  const columns = [];
  for (const node of [...state.nodes.values()].sort((a, b) => a.x - b.x)) {
    let col = columns.find((c) => Math.abs(c.x - node.x) < PACK_COL_TOLERANCE);
    if (!col) { col = { x: node.x, items: [] }; columns.push(col); }
    col.items.push(node);
  }
  columns.sort((a, b) => a.x - b.x);
  columns.forEach((col, ci) => {
    col.items.sort((a, b) => a.y - b.y);
    col.items.forEach((node, ri) => {
      moveNode(node.id, PACK_MARGIN + ci * PACK_COL_GAP, PACK_MARGIN + ri * PACK_ROW_GAP);
    });
  });
}

function unpackLayout() {
  if (!expandedPositions) return;
  checkpoint();
  for (const [id, pos] of expandedPositions) {
    if (state.nodes.has(id)) moveNode(id, pos.x, pos.y);
  }
  expandedPositions = null;
}

// Canvas zoom: a CSS transform on #canvas-inner, scaled around its top-left
// (transform-origin: 0 0). Node positions (node.x/node.y) and everything
// drawn into the wires SVG stay in this untransformed "logical" coordinate
// space — the transform is what makes it visually bigger/smaller. Anything
// that mixes a raw mouse-screen delta with a logical coordinate (dragging a
// node, drawing a wire, placing a new node from the menu) has to divide that
// screen delta by `zoom` first, or it drifts out of sync with the cursor as
// soon as zoom != 1.
let zoom = 1;
const ZOOM_MIN = 0.3, ZOOM_MAX = 2.5;

export function getZoom() {
  return zoom;
}

function applyZoom() {
  inner.style.transform = `scale(${zoom})`;
  const readout = document.getElementById('zoom-readout');
  if (readout) readout.textContent = Math.round(zoom * 100) + '%';
}

// Zooms while keeping the logical point currently under (clientX, clientY)
// visually fixed in place — the standard "zoom toward the cursor" feel.
// Omit clientX/clientY to zoom around the current viewport center instead
// (used by the toolbar +/- buttons, which have no cursor position of their own).
export function zoomTo(newZoom, clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  const anchorX = clientX != null ? clientX - rect.left : viewport.clientWidth / 2;
  const anchorY = clientY != null ? clientY - rect.top : viewport.clientHeight / 2;
  const logicalX = (viewport.scrollLeft + anchorX) / zoom;
  const logicalY = (viewport.scrollTop + anchorY) / zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  applyZoom();
  viewport.scrollLeft = logicalX * zoom - anchorX;
  viewport.scrollTop = logicalY * zoom - anchorY;
}

export function setScopeMode(mode) {
  scopeMode = mode;
}

// Reshuffle every continuous knob on the board — a "Chance" button for live
// performance, same idea as Pulse Train's randomizer, but general-purpose
// across whatever nodes happen to be patched in right now.
export function randomizeAllParams() {
  checkpoint();
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
  checkpoint();
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

// Both of these read real, on-screen (getBoundingClientRect) positions, which
// are already scaled by the canvas zoom — dividing by `zoom` converts back
// to the logical coordinate space that node.x/node.y and the wires SVG use.
export function screenToInner(clientX, clientY) {
  const r = inner.getBoundingClientRect();
  return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
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
  return { x: (r.left + r.width / 2 - innerR.left) / zoom, y: (r.top + r.height / 2 - innerR.top) / zoom };
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
  controlSync.get(nodeId).set(def.name, apply);

  knob.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    checkpoint(); // once per drag, not once per mousemove (see the undo/redo note in state.js)
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
  controlSync.get(nodeId).set(def.name, setEngaged);
  sw.addEventListener('mousedown', (e) => e.stopPropagation());
  sw.addEventListener('click', () => {
    checkpoint();
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
  controlSync.get(nodeId).set(def.name, (value) => { sel.value = value; });
  sel.addEventListener('mousedown', (e) => e.stopPropagation());
  sel.addEventListener('change', () => { checkpoint(); onParamInput(nodeId, def.name, sel.value); });
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
  // Starting a wire fires from the whole row (nub + label), not just the
  // 11px dot — dropping one is handled globally in endWire() via a snap
  // radius (see findNearestInJack), so 'in' jacks need no listener at all.
  if (dir === 'out') {
    jack.addEventListener('mousedown', (e) => startWire(e, nodeId, port.id));
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
  el.classList.toggle('compact', compactMode || !!def.alwaysCompact);
  el.innerHTML = '';
  controlSync.set(node.id, new Map());

  const head = document.createElement('div');
  head.className = 'mhead';
  const headLeft = document.createElement('div');
  headLeft.className = 'mhead-left';
  const name = document.createElement('span');
  name.className = 'mname';
  name.textContent = def.label;
  name.title = def.label;
  headLeft.appendChild(name);

  const bypassBtn = document.createElement('button');
  bypassBtn.className = 'fswitch' + (node.bypassed ? '' : ' engaged');
  bypassBtn.title = (def.id === 'videoOutput' ? 'Pause video: ' : 'Bypass: ') + def.label;
  bypassBtn.appendChild(Object.assign(document.createElement('span'), { className: 'led' }));
  bypassBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  bypassBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    checkpoint();
    const bypassed = toggleBypass(node.id);
    bypassBtn.classList.toggle('engaged', !bypassed);
    el.classList.toggle('bypassed', bypassed);
    if (engine.isLive()) engine.setBypass(node.id, bypassed);
  });
  headLeft.appendChild(bypassBtn);
  if (def.params.length) {
    const recBtn = document.createElement('button');
    recBtn.className = 'fswitch loopbtn rec';
    const playBtn = document.createElement('button');
    playBtn.className = 'fswitch loopbtn play';
    for (const b of [recBtn, playBtn]) {
      b.appendChild(Object.assign(document.createElement('span'), { className: 'glyph' }));
      b.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    recBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRecord(node.id); });
    playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(node.id); });
    headLeft.append(recBtn, playBtn);
    const bar = document.createElement('div');
    bar.className = 'loopbar';
    const win = document.createElement('div'); // the active (trimmed) window; the progress fill lives inside it
    win.className = 'loopwin';
    win.appendChild(document.createElement('i'));
    bar.appendChild(win);
    for (const side of ['start', 'end']) {
      const h = document.createElement('div');
      h.className = 'loophandle ' + side;
      h.title = `Drag to trim the loop ${side} (double-click to reset)`;
      attachTrimHandle(h, bar, node.id, side);
      bar.appendChild(h);
    }
    head.appendChild(bar);
  }
  head.appendChild(headLeft);

  const del = document.createElement('button');
  del.className = 'mdel';
  del.textContent = '×';
  del.title = 'Delete node';
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

  // Output has no output port of its own (outputs:[]), so it never qualified
  // for the ordinary per-node scope — it's the master signal, always worth
  // seeing, so it gets one unconditionally, ignoring Compact entirely.
  if ((def.outputs.length && !compactMode && !def.alwaysCompact) || def.id === 'output') {
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
  paintLoopUi(node.id);
}

// Repaints one node's Record/Play buttons and the progress bar under its
// header from the recorder's current status. Called after every render of the
// node (renders rebuild the DOM) and whenever recorder.js reports a change.
function paintLoopUi(nodeId) {
  const el = nodeEls.get(nodeId);
  if (!el) return;
  const recBtn = el.querySelector('.loopbtn.rec');
  const playBtn = el.querySelector('.loopbtn.play');
  const bar = el.querySelector('.loopbar');
  if (!recBtn || !playBtn || !bar) return;
  const st = getStatus(nodeId);
  recBtn.classList.toggle('engaged', st.recording);
  recBtn.title = st.recording
    ? 'Stop recording'
    : `Record every change to this node's settings, including on/off (up to ${MAX_RECORD_MS / 1000} s; click again to stop)` + (st.hasLoop ? ' — replaces the saved loop' : '');
  playBtn.classList.toggle('engaged', st.playing);
  playBtn.classList.toggle('empty', !st.hasLoop && !st.recording);
  playBtn.title = st.playing ? 'Stop the loop' : st.hasLoop ? 'Play the recorded settings in a loop' : 'Nothing recorded yet — press record first';
  const win = bar.querySelector('.loopwin');
  const fill = win.firstChild;
  fill.style.animation = 'none';
  bar.classList.toggle('recording', st.recording);
  bar.classList.toggle('playing', st.playing);
  bar.classList.toggle('trimmable', st.hasLoop && !st.recording);
  // Window position on the take's timeline (the whole bar while recording).
  const total = st.hasLoop && !st.recording ? st.loopDuration : 1;
  const a = st.hasLoop && !st.recording ? st.trimStart / total : 0;
  const z = st.hasLoop && !st.recording ? st.trimEnd / total : 1;
  win.style.left = a * 100 + '%';
  win.style.width = (z - a) * 100 + '%';
  bar.style.setProperty('--ts', a * 100 + '%');
  bar.style.setProperty('--te', z * 100 + '%');
  if (st.recording || st.playing) {
    void fill.offsetWidth; // restart the CSS animation
    // Negative delay: after a re-render mid-loop, resume at the true phase instead of from zero.
    const phase = (performance.now() - st.startedAt) % st.duration;
    fill.style.animation = `loopfill ${st.duration}ms linear ${-phase}ms ${st.recording ? '1 forwards' : 'infinite'}`;
  }
}

// Drag one end of the loop bar to trim the looping window. Pointer capture keeps
// the drag alive off the handle; the bar's on-screen width (already zoom-scaled)
// maps linearly onto the take's timeline.
function attachTrimHandle(handle, bar, nodeId, side) {
  const stop = (e) => e.stopPropagation(); // don't start a node drag / wire
  handle.addEventListener('mousedown', stop);
  handle.addEventListener('dblclick', (e) => {
    stop(e);
    const st = getStatus(nodeId);
    if (!st.hasLoop) return;
    setTrim(nodeId, side === 'start' ? 0 : st.trimStart, side === 'end' ? st.loopDuration : st.trimEnd);
  });
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const st = getStatus(nodeId);
    if (!st.hasLoop) return;
    const r = bar.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * st.loopDuration;
    if (side === 'start') setTrim(nodeId, t, st.trimEnd);
    else setTrim(nodeId, st.trimStart, t);
  });
  const done = (e) => { handle.classList.remove('dragging'); if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); };
  handle.addEventListener('pointerup', done);
  handle.addEventListener('pointercancel', done);
}

setStatusHook(paintLoopUi);
// Loop playback pushes values through the same path a knob drag uses (state +
// live audio + Video Output resolution), then repaints the control itself.
setApplyHook((nodeId, name, value) => {
  if (name === BYPASS_KEY) { // the node's on/off switch is part of a take too
    setBypassState(nodeId, !!value);
    if (engine.isLive()) engine.setBypass(nodeId, !!value);
    return;
  }
  onParamInput(nodeId, name, value);
  controlSync.get(nodeId)?.get(name)?.(value);
});

function selectNode(id) {
  selectedId = id;
  for (const [nid, el] of nodeEls) el.classList.toggle('selected', nid === id);
}

function startNodeDrag(e, node) {
  e.preventDefault();
  e.stopPropagation();
  selectNode(node.id);
  checkpoint(); // once per drag gesture (a plain click-no-drag just checkpoints a no-op, harmless)
  const startX = e.clientX, startY = e.clientY;
  const origX = node.x, origY = node.y;
  dragState = { node, startX, startY, origX, origY };
  document.addEventListener('mousemove', onNodeDragMove);
  document.addEventListener('mouseup', onNodeDragEnd);
}
function onNodeDragMove(e) {
  if (!dragState) return;
  // Raw screen-pixel mouse delta -> logical canvas units, same conversion as
  // screenToInner/portPos, or a node drifts away from the cursor once zoom != 1.
  const dx = (e.clientX - dragState.startX) / zoom;
  const dy = (e.clientY - dragState.startY) / zoom;
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
  wireDraft = { fromNodeId: nodeId, fromPort: portId, x1: p.x, y1: p.y, x2: p.x, y2: p.y, snapTarget: null, snapEl: null };
  document.addEventListener('mousemove', onWireMove);
  document.addEventListener('mouseup', endWire);
}

// The actual 11px dot is a near-impossible drop target on its own — this
// finds the closest 'in' jack within a fixed screen-pixel radius (constant
// regardless of canvas zoom, since it's comparing real cursor position to
// real rendered jack position) so releasing *near* a jack still connects,
// the same "don't require pixel-perfect aim" fix already applied to
// disconnecting a wire.
const SNAP_RADIUS = 24;
function findNearestInJack(clientX, clientY) {
  let best = null, bestDist = SNAP_RADIUS;
  for (const nub of nodesLayer.querySelectorAll('.nub[data-dir="in"]')) {
    const r = nub.getBoundingClientRect();
    const d = Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
    if (d < bestDist) { bestDist = d; best = nub; }
  }
  return best;
}

function onWireMove(e) {
  if (!wireDraft) return;
  const target = findNearestInJack(e.clientX, e.clientY);
  if (wireDraft.snapEl && wireDraft.snapEl !== target) wireDraft.snapEl.classList.remove('jack-target');
  if (target) {
    target.classList.add('jack-target');
    wireDraft.snapEl = target;
    wireDraft.snapTarget = { nodeId: target.dataset.node, portId: target.dataset.port };
    const p = portPos(target.dataset.node, target.dataset.port, 'in');
    wireDraft.x2 = p.x; wireDraft.y2 = p.y;
  } else {
    wireDraft.snapEl = null;
    wireDraft.snapTarget = null;
    const p = screenToInner(e.clientX, e.clientY);
    wireDraft.x2 = p.x; wireDraft.y2 = p.y;
  }
  renderWires();
}

function endWire() {
  if (wireDraft) {
    if (wireDraft.snapTarget) addEdge(wireDraft.fromNodeId, wireDraft.fromPort, wireDraft.snapTarget.nodeId, wireDraft.snapTarget.portId);
    wireDraft.snapEl?.classList.remove('jack-target');
  }
  wireDraft = null;
  document.removeEventListener('mousemove', onWireMove);
  document.removeEventListener('mouseup', endWire);
  renderWires();
}

// Ctrl/Cmd + wheel zooms toward the cursor, same gesture as Figma/Google Maps.
// Plain wheel keeps doing the browser's native scroll (pan), untouched.
viewport.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.002);
  zoomTo(getZoom() * factor, e.clientX, e.clientY);
}, { passive: false });

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
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    removeNode(selectedId);
    selectedId = null;
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    // undo()/redo() restore via the same 'load' event deserialize() uses,
    // which the onChange listener below already re-renders on — no need to
    // fullRender() again here.
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
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
    if (!state.nodes.has(id)) { nodeEls.get(id).remove(); nodeEls.delete(id); controlSync.delete(id); }
  }
  for (const node of state.nodes.values()) renderNode(node);
  svg.setAttribute('width', inner.offsetWidth);
  svg.setAttribute('height', inner.offsetHeight);
  renderWires();
}

onChange((kind, payload) => {
  if (kind === 'param-change' || kind === 'loop-change') return; // params/loops repaint locally, no full redraw needed
  if (kind === 'bypass-change') {
    // Loop playback can flip a node's power at any moment — repaint just that node
    // (a full redraw would tear down a knob the user may be dragging elsewhere).
    const el = nodeEls.get(payload.id);
    if (el) {
      el.classList.toggle('bypassed', payload.bypassed);
      el.querySelector('.fswitch:not(.loopbtn)')?.classList.toggle('engaged', !payload.bypassed);
    }
    return;
  }
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
