// Entry point: main loop and input handling.
import { World } from './world.js';
import { CFG } from './config.js';
import { Renderer, NM_PER_UNIT, DIM } from './render.js';
import { UI } from './ui.js';
import { fovFor, topLevelAt, childAt, contains, ancestors } from './parts.js';
import { Tour } from './tour.js';
import { saveToFile, loadFromFile } from './persist.js';

const SPEEDS = [0.25, 1, 2, 5, 10, 20, 50, 100, 250]; // ticks per frame
const $ = (id) => document.getElementById(id);

const canvas = $('world');
const renderer = new Renderer(canvas);
const ui = new UI();
const opts = { colorMode: 'troph', overlay: 'none', showChem: true, selected: null, flash: null };

const params = new URLSearchParams(location.search);
let seed = +params.get('seed') || Math.floor(Math.random() * 1e6) + 1;
$('seed').value = seed;
let world = new World(seed);
let running = true;
let speedIdx = 3;
let frame = 0;
let acc = 0;
let alpha = 1; // how far between the previous and current tick to draw (smoothing at slow speeds)

function setSpeed(i) {
  speedIdx = i;
  $('speed').value = i;
  const s = SPEEDS[i];
  $('speed-val').textContent = s < 1 ? `${s}×/frame` : `${s}/frame`;
}
setSpeed(+params.get('speed') || speedIdx);
$('scale-note').textContent = `Everything is drawn at true size (habitat ${(CFG.W / 2000).toFixed(1)} × ${(CFG.H / 2000).toFixed(1)} mm). Select something first and the preset zooms into it.`;

function newWorld(s) {
  if (typeof tour !== 'undefined') tour.stop();
  seed = s;
  world = new World(seed);
  ui.reset();
  opts.selected = null;
  history.replaceState(null, '', `?seed=${seed}`);
}

let seeking = null; // { from: milestone count, start: tick } while jumping to the next milestone
let lastNow = performance.now();
const tour = new Tour(renderer, ui, () => $('btn-tour').classList.remove('active'));

function loop() {
  frameStep();
  requestAnimationFrame(loop);
}

function frameStep() {
  frame++;
  const now = performance.now(), dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (seeking) {
    // Full speed (within the frame budget) until something new happens.
    const t0 = performance.now();
    while (performance.now() - t0 < 40) {
      world.step();
      if (world.milestones.length > seeking.from || world.t - seeking.start > 400000) { stopSeek(); break; }
    }
    alpha = 1;
    if (seeking) $('btn-seek').textContent = `⏭ Seeking… tick ${world.t.toLocaleString()}`;
  } else if (running) {
    acc += SPEEDS[speedIdx];
    const t0 = performance.now();
    // Stay responsive: never spend more than ~30 ms simulating per frame.
    while (acc >= 1 && performance.now() - t0 < 30) { world.step(); acc--; }
    if (acc > 1) acc = 0;
    alpha = SPEEDS[speedIdx] >= 1 ? 1 : acc;
    world.smooth = SPEEDS[speedIdx] < 1; // only pay for in-between frames when they're visible
  }
  // Draw everything partway between ticks (the simulation itself never sees these positions).
  tour.update(dt);
  world.beginInterp(alpha);
  opts.time = world.t - 1 + alpha;
  const sel = ui.selected;
  if (sel) trackSelection(sel);
  opts.selected = sel && !sel.gone ? sel.obj : null;
  if (sel && sel.follow && !sel.gone) {
    const o = sel.offset || { x: 0, y: 0 };
    renderer.cam.x = sel.obj.x + o.x; renderer.cam.y = sel.obj.y + o.y;
  }
  if (opts.flash) { opts.flash.a -= 0.02; if (opts.flash.a <= 0) opts.flash = null; }
  renderer.draw(world, opts);
  ui.update(world, frame);
  world.endInterp();
}

// ---------------------------------------------------------------- controls
$('btn-play').onclick = () => { running = !running; $('btn-play').textContent = running ? 'Pause' : 'Play'; };
$('btn-step').onclick = () => { world.step(); alpha = 1; };

function stopSeek() {
  seeking = null;
  $('btn-seek').textContent = '⏭ Next milestone';
  $('btn-seek').classList.remove('active');
}
$('btn-seek').onclick = () => {
  if (seeking) { stopSeek(); return; }
  seeking = { from: world.milestones.length, start: world.t };
  $('btn-seek').classList.add('active');
};
$('btn-tour').onclick = () => {
  if (tour.active) { tour.stop(); return; }
  $('btn-tour').classList.add('active');
  tour.start(world);
};
$('btn-save').onclick = async () => {
  const bytes = await saveToFile(world);
  ui.toast(`World saved (${(bytes / 1e6).toFixed(1)} MB)`, world.t);
};
$('btn-load').onclick = () => $('file-load').click();
$('file-load').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const w = await loadFromFile(f);
    tour.stop(); stopSeek();
    world = w;
    seed = w.seed;
    $('seed').value = seed;
    ui.reset();
    ui.seenLogs = w.logs.length; // don't replay old notifications
    history.replaceState(null, '', `?seed=${seed}`);
    ui.toast(`Loaded seed ${seed} at tick ${w.t.toLocaleString()}`, w.t);
  } catch (err) {
    ui.toast(`Could not load: ${err.message}`, world.t);
  }
};
$('btn-fit').onclick = () => { renderer.fit(); if (ui.selected) ui.selected.follow = false; };
// Zoom presets: jump to a physical field of view, centred on the selection if there is one.
for (const b of document.querySelectorAll('[data-fov]')) {
  b.onclick = () => {
    const fov = +b.dataset.fov;
    if (!fov) { $('btn-fit').click(); return; }
    renderer.setFieldWidthNm(fov);
    const sel = ui.selected;
    if (sel && !sel.gone) { sel.follow = true; sel.offset = { x: 0, y: 0 }; renderer.cam.x = sel.obj.x; renderer.cam.y = sel.obj.y; }
  };
}
$('speed').oninput = (e) => setSpeed(+e.target.value);
$('btn-new').onclick = () => newWorld(Math.max(1, +$('seed').value || 1));
$('seed').onkeydown = (e) => { if (e.key === 'Enter') $('btn-new').click(); };
$('color-mode').onchange = (e) => { opts.colorMode = e.target.value; };
$('overlay').onchange = (e) => { opts.overlay = e.target.value; };
$('show-chem').onchange = (e) => { opts.showChem = e.target.checked; };
$('ev-meteor').onclick = () => { const p = world.meteor(); opts.flash = { x: p.x, y: p.y, a: 1 }; };
$('ev-snowball').onclick = () => world.snowball();
$('ev-volcano').onclick = () => world.volcano();
$('btn-tree').onclick = () => { $('tree-modal').hidden = false; ui.drawTree(world); };
$('tree-close').onclick = () => { $('tree-modal').hidden = true; };
$('tree-modal').onclick = (e) => { if (e.target.id === 'tree-modal') $('tree-modal').hidden = true; };

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
  else if (e.key === 'Escape') {
    $('tree-modal').hidden = true;
    // Go up one level; from the outermost level, deselect.
    const s = ui.selected;
    const up = s ? ancestors(s, world).at(-1) : null;
    ui.select(world, up || null);
  }
  else if (e.key === 'f' || e.key === 'F') toggleFollow();
  else if (e.key === '+' || e.key === '=') setSpeed(Math.min(SPEEDS.length - 1, speedIdx + 1));
  else if (e.key === '-') setSpeed(Math.max(0, speedIdx - 1));
});

window.addEventListener('resize', () => renderer.resize());

// --------------------------------------------------------- camera & picking
let drag = null;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  tour.stop();
  const r = canvas.getBoundingClientRect();
  const f = Math.exp(-e.deltaY * 0.0015);
  // While following something, zoom straight into it.
  if (ui.selected && ui.selected.follow && !ui.selected.gone) renderer.zoomAt(r.width / 2, r.height / 2, f);
  else renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, f);
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  if (drag.moved > 4) {
    tour.stop();
    canvas.classList.add('dragging');
    renderer.pan(dx, dy);
    if (ui.selected) ui.selected.follow = false;
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  if (drag && drag.moved <= 4) {
    const r = canvas.getBoundingClientRect();
    pick(renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top));
  }
  drag = null;
});

// Keep the selection's position current; molecules and polymers can vanish into other structures.
function trackSelection(sel) {
  const soup = world.soup;
  for (let q = sel; q; q = q.parent) {
    if (!q.st) continue; // a free molecule from the soup: find it again by its stable id
    const i = soup.indexOfMid(q.st.mid);
    if (i < 0) q.st.gone = true;
    else { q.st.x = soup.mx[i]; q.st.y = soup.my[i]; }
  }
  sel.gone = !!sel.obj.dead;
}

// Select a part from the inspector and fly the camera to it at a fitting magnification.
function focus(s) {
  if (s.kind === 'polymer') s.obj._rad = polymerRadius(s.obj);
  ui.select(world, s);
  s.follow = true;
  s.offset = { x: 0, y: 0 };
  renderer.setFieldWidthNm(fovFor(s));
  if (!s.obj.dead) { renderer.cam.x = s.obj.x; renderer.cam.y = s.obj.y; }
}
ui.onPick = focus;
ui.renderer = renderer;

// Nested selection: click selects the outermost thing; click again inside it to go one level deeper.
function pick(p) {
  const tol = (6 * renderer.dpr) / renderer.ppu;
  const cur = ui.selected;
  if (cur && !cur.gone) {
    const chain = [...ancestors(cur, world), cur];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!contains(chain[i], p, tol)) continue;
      const child = childAt(chain[i], p, tol, world, renderer);
      if (child) ui.select(world, child);
      else if (i < chain.length - 1) ui.select(world, chain[i]); // inside a parent, between its parts
      return; // inside the current selection but on nothing smaller: keep it
    }
  }
  ui.select(world, topLevelAt(world, p, tol, opts.showChem));
}

function toggleFollow() {
  const s = ui.selected;
  if (!s || s.gone) return;
  s.follow = !s.follow;
  // Keep the object where it is on screen instead of snapping it to the centre.
  if (s.follow) s.offset = { x: renderer.cam.x - s.obj.x, y: renderer.cam.y - s.obj.y };
  ui.lastHTML = null;
}
ui.onFollow = toggleFollow;

function polymerRadius(q) { return (q.seq.length * DIM.ntRise) / 2 / NM_PER_UNIT; }

// Console handle for tinkering, e.g. soup.world.life.cells.length
window.soup = { get world() { return world; }, renderer, ui, opts, tour, frame: frameStep, draw: () => { renderer.draw(world, opts); ui.update(world, 0); } };

requestAnimationFrame(loop);
