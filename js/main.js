// Entry point: main loop and input handling.
import { World } from './world.js';
import { CFG } from './config.js';
import { Renderer, NM_PER_UNIT, DIM } from './render.js';
import { UI } from './ui.js';
import { fovFor, centreOf, topLevelAt, childAt, contains, ancestors, sel as mkSel, crumbLabel } from './parts.js';
import { Cell } from './life.js';
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
  renderer.time = opts.time;
  const sel = ui.selected;
  if (sel) trackSelection(sel);
  // A strand inside a protocell: place it for this frame before aiming the camera at it.
  for (let q = sel; q; q = q.parent) if (q.kind === 'polymer' && q.obj.home && !q.obj.home.dead) renderer.placeInternal(q.obj, q.obj.home);
  opts.selected = sel && !sel.gone ? sel.obj : null;
  opts.selection = sel && !sel.gone ? sel : null;
  // Following is a setting, not part of one selection: whatever is selected next is followed too,
  // starting from the current view so the camera doesn't jump.
  if (sel && !sel.gone && !flight && sel.follow !== followOn) {
    sel.follow = followOn;
    if (followOn) startFollow(sel);
    ui.lastHTML = null;
  }
  if (flight) fly(dt);
  else if (sel && sel.follow && !sel.gone && !tour.active) chase(sel, dt);
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
$('btn-fit').onclick = () => { renderer.fit(); reframe(); };
// Zoom presets: jump to a physical field of view, centred on the selection if there is one.
for (const b of document.querySelectorAll('[data-fov]')) {
  b.onclick = () => {
    const fov = +b.dataset.fov;
    if (!fov) { $('btn-fit').click(); return; }
    flight = null;
    renderer.setFieldWidthNm(fov);
    const sel = ui.selected;
    if (sel && !sel.gone) { const c = centreOf(sel); renderer.cam.x = c.x; renderer.cam.y = c.y; followOn = sel.follow = true; startFollow(sel); }
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
    goUp();
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
  flight = null;
  const r = canvas.getBoundingClientRect();
  const f = Math.exp(-e.deltaY * 0.0015);
  // While following something centred, zoom straight into it; once you've panned, zoom at the cursor.
  const s = ui.selected, following = s && s.follow && !s.gone;
  if (following && !(s.pan && s.pan.hold)) renderer.zoomAt(r.width / 2, r.height / 2, f);
  else { renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, f); if (following) reframe(); }
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (e.buttons === 0) { endDrag(); return; } // the button was released somewhere we didn't hear about
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  if (drag.moved > 4) {
    tour.stop();
    flight = null;
    canvas.classList.add('dragging');
    renderer.pan(dx, dy);
    reframe(); // while following, dragging moves where the subject sits on screen, and it stays there
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  if (drag && drag.moved <= 4) {
    const r = canvas.getBoundingClientRect();
    pick(renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top));
  }
  endDrag();
});
// A drag must always end, even if the pointer is released outside the window or the browser takes it over.
function endDrag() { drag = null; canvas.classList.remove('dragging'); }
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', endDrag);

// Keep the selection current. When the selected thing turns into something else (a molecule built
// into a strand, a protocell dividing or becoming a cell, a cell swallowed, a virus infecting),
// hand the selection (and the follow) over to whatever it became.
function trackSelection(sel) {
  const soup = world.soup;
  soup.watchMid = 0;
  let root = sel;
  while (root.parent) root = root.parent;
  for (let q = sel; q; q = q.parent) {
    if (!q.st) continue; // a free molecule from the soup: find it again by its stable id
    soup.watchMid = q.st.mid;
    const i = soup.indexOfMid(q.st.mid);
    if (i < 0) {
      if (!q.st.gone) { q.st.gone = true; q.st.next = soup.watchNext; }
    } else {
      const j = renderer.jig(q.st.mid);
      q.st.sx = soup.mx[i]; q.st.sy = soup.my[i];          // where the simulation has it
      q.st.x = q.st.sx + j.x; q.st.y = q.st.sy + j.y;      // where it is drawn (thermal jiggle)
      q.st.ang = (q.st.mid * 2.399 + (opts.time ?? world.t) * 0.04) % (Math.PI * 2); // molecules tumble
    }
  }
  soup.watchNext = null;
  if (!sel.obj.dead) { sel.gone = false; return; }
  // Find the innermost thing in the chain that turned into something we can follow.
  for (let q = sel; q; q = q.parent) {
    const o = q.st || q.obj;
    if (!(o.dead || o.gone)) continue;
    const nxt = q.st ? q.st.next : { obj: o.next, why: o.nextWhy };
    if (nxt && nxt.obj && !nxt.obj.dead) { handOff(sel, q, nxt.obj, nxt.why); return; }
    if (!sel.gone) ui.toast(`${crumbLabel(q)} ${(nxt && nxt.why) || o.nextWhy || 'is gone'}`, world.t);
    break;
  }
  sel.gone = true;
}

// What the camera tracks: the moving body a selection belongs to (so a part's own motion, a strand
// wandering inside its protocell, or a molecule's jiggle stays visible on screen).
function followTarget(sel) {
  for (let q = sel; q; q = q.parent) {
    if (q.st) return { x: q.st.sx ?? q.st.x, y: q.st.sy ?? q.st.y };
    if (q.kind === 'polymer') {
      const p = q.obj;
      return p.home && !p.home.dead && p._bx !== undefined ? { x: p._bx, y: p._by } : { x: p.x, y: p.y };
    }
    if (q.kind === 'cell' || q.kind === 'vesicle' || q.kind === 'virus' || q.kind === 'organism') return { x: q.obj.x, y: q.obj.y };
  }
  return { x: sel.obj.x, y: sel.obj.y };
}

// Locked camera: the followed thing stays exactly in the middle of the screen, so it never jitters
// however it moves. When following starts (or after a drag or Fit) the camera glides the last bit
// into the centre and then holds.
function startFollow(sel) {
  const t = followTarget(sel);
  let c = t;
  try { c = centreOf(sel); } catch { /* parts without a centre are followed by their body */ }
  sel.offset = { x: c.x - t.x, y: c.y - t.y };
  sel.pan = { x: renderer.cam.x - c.x, y: renderer.cam.y - c.y, hold: false }; // glides into the centre
}

function chase(sel, dt) {
  const t = followTarget(sel), o = sel.offset || { x: 0, y: 0 }, p = sel.pan || (sel.pan = { x: 0, y: 0 });
  if (!p.hold) { const k = Math.exp(-dt / 0.35); p.x *= k; p.y *= k; } // ease into the centre
  // After a pan the view rides along with the subject at that offset (you can look anywhere, even
  // well away from it, and everything stays still relative to it).
  renderer.cam.x = t.x + o.x + p.x;
  renderer.cam.y = t.y + o.y + p.y;
}

function kindOf(o) {
  if (o instanceof Cell) return 'cell';
  if (o.polys) return 'vesicle';
  if (o.seq) return 'polymer';
  if (o.k1 !== undefined) { o.r = o.r || 0.2; return 'virus'; }
  return null;
}

function handOff(old, from, obj, why) {
  const kind = kindOf(obj);
  if (!kind) { old.gone = true; return; }
  const s = mkSel(kind, obj, kind === 'virus' ? { world } : {});
  if (kind === 'polymer') s.obj._rad = polymerRadius(obj);
  if (kind === 'polymer' && obj.home) s.parent = mkSel('vesicle', obj.home);
  s.follow = old.follow;
  if (s.follow) startFollow(s); // glides over to the successor, then locks on
  ui.toast(`${crumbLabel(from)} ${why || 'changed'}`, world.t);
  ui.select(world, s);
}

// Select a part from the inspector and fly the camera to it, framed to fit.
let flight = null;
function focus(s) {
  if (s.kind === 'polymer') s.obj._rad = polymerRadius(s.obj);
  ui.select(world, s);
  if (s.obj.dead) return;
  s.follow = followOn; // chasing waits until we arrive (the flight steers the camera meanwhile)
  flight = { sel: s, t: 0, dur: 0.9, from: { x: renderer.cam.x, y: renderer.cam.y, fov: renderer.fieldWidthNm() } };
}

// Log-zoom flight that keeps the destination steady on screen; far jumps pull back first.
function fly(dt) {
  const f = flight, s = f.sel;
  if (s.gone || s.obj.dead || ui.selected !== s) { flight = null; return; }
  f.t += dt;
  const c = centreOf(s), to = { x: c.x, y: c.y, fov: fovFor(s) }, from = f.from;
  const u = Math.min(1, f.t / f.dur), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  const lerpFov = (a, b, k) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * k);
  const gapNm = Math.hypot(to.x - from.x, to.y - from.y) * NM_PER_UNIT;
  const leg = (a, b, k) => {
    const fov = lerpFov(a.fov, b.fov, k), shrink = b.fov < a.fov;
    const w = shrink ? (fov - b.fov) / (a.fov - b.fov || 1) : 1 - (fov - a.fov) / (b.fov - a.fov || 1);
    renderer.cam.x = b.x + (a.x - b.x) * w; renderer.cam.y = b.y + (a.y - b.y) * w;
    renderer.setFieldWidthNm(fov);
  };
  if (gapNm > 3 * Math.max(from.fov, to.fov)) {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, fov: gapNm * 1.4 };
    if (e < 0.5) leg(from, mid, e * 2); else leg(mid, to, e * 2 - 1);
  } else leg(from, to, e);
  if (u >= 1) {
    flight = null;
    followOn = s.follow = true; // a fly-to ends following its destination
    const ft = followTarget(s);
    s.offset = { x: c.x - ft.x, y: c.y - ft.y }; // keep the part itself in the middle
    s.pan = { x: 0, y: 0 };
  }
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

// Only the Follow button and the F key turn following off.
let followOn = false;
function toggleFollow() {
  const s = ui.selected;
  if (!s || s.gone) return;
  followOn = s.follow = !followOn;
  // Keep the object where it is on screen instead of snapping it to the centre.
  if (s.follow) startFollow(s);
  ui.lastHTML = null;
}
ui.onFollow = toggleFollow;

// Keep the current view as the following framing (after a drag or Fit): following carries on from there.
function reframe() {
  const s = ui.selected;
  if (!s || s.gone || !s.follow) return;
  const t = followTarget(s);
  const o = s.offset || { x: 0, y: 0 };
  s.pan = { x: renderer.cam.x - t.x - o.x, y: renderer.cam.y - t.y - o.y, hold: true }; // stays where you put it
}


// Up one level (inspector button or Esc); keeps following and keeps the view steady.
function goUp() {
  const s = ui.selected;
  const up = s ? ancestors(s, world).at(-1) : null;
  if (up && s.follow) { up.follow = true; startFollow(up); }
  ui.select(world, up || null);
}
ui.onUp = goUp;

function polymerRadius(q) { return (q.seq.length * DIM.ntRise) / 2 / NM_PER_UNIT; }

// Console handle for tinkering, e.g. soup.world.life.cells.length
window.soup = { get world() { return world; }, renderer, ui, opts, tour, frame: frameStep, draw: () => { renderer.draw(world, opts); ui.update(world, 0); } };

requestAnimationFrame(loop);
