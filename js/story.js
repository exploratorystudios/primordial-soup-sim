// Story mode, part 2: play back the transitions found by the search worker (story-scout.js).
// Each chapter restores the world shortly before the moment, follows what it happens to, and can be
// rewound or scrubbed: restoring a snapshot and stepping forward replays the history exactly.
// The camera stays free (pan, zoom, select other things) and the speed slider still works.
import { deserialize, serialize } from './persist.js';
import { CHAPTERS, ORDER } from './story-chapters.js';
import { sel, molecule, organismOf } from './parts.js';
import { DIM, NM_PER_UNIT } from './render.js';

const NM = 1 / NM_PER_UNIT;
const $ = (id) => document.getElementById(id);
const ORGANISM_SCENES = new Set(['colony', 'multicellular', 'complex']);

export class Story {
  // app: { world, setWorld(w), setRunning(b), setSpeed(i), follow(sel, view), setOverlay(name), renderer, ui }
  constructor(app) {
    this.app = app;
    this.active = false;
    this.list = [];
    $('st-prev').onclick = () => this.go(this.idx - 1);
    $('st-next').onclick = () => this.go(this.idx + 1);
    $('st-replay').onclick = () => this.cur && this.seek(this.cur.start, false);
    $('st-back').onclick = () => this.cur && this.seek(this.now() - this.step(), true);
    $('st-fwd').onclick = () => this.cur && this.seek(this.now() + this.step(), true);
    $('st-play').onclick = () => {
      if (!this.cur) return;
      if (this.app.world.t >= this.cur.end) { this.seek(this.cur.start, false); this.app.setRunning(true); return; }
      this.app.setRunning(!this.app.running);
    };
    $('st-subject').onclick = () => this.cur && this.frameSubject();
    $('st-exit').onclick = () => this.stop();
    $('st-chapters').onchange = (e) => this.go(+e.target.value);
    const time = $('st-time');
    time.oninput = () => { this.scrubbing = true; this.label(+time.value); };
    time.onchange = () => { this.scrubbing = false; this.seek(+time.value, true); };
  }

  start(seed) {
    if (this.active) return;
    this.active = true;
    this.seed = seed;
    this.home = structuredClone(serialize(this.app.world)); // the world to return to afterwards
    this.overlay0 = this.app.opts.overlay;
    this.list = [];
    this.idx = -1;
    this.cur = null;
    this.searching = true;
    $('story').hidden = false;
    $('st-cap').innerHTML = '<b>Searching this world’s history…</b>Replaying it from the very beginning to find every transition. Chapters appear here as they are found; the first ones take only seconds.';
    this.app.setRunning(false);
    this.worker = new Worker(new URL('./story-scout.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => { $('st-status').textContent = `Search failed: ${e.message}`; };
    this.worker.postMessage({ cmd: 'start', seed });
    this.refreshList();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    $('story').hidden = true;
    this.app.setOverlay(this.overlay0);
    this.app.setWorld(deserialize(this.home));
    this.home = null;
    this.list = [];
    this.cur = null;
  }

  onMessage(m) {
    if (m.type === 'progress') {
      this.progress = m;
      this.status();
    } else if (m.type === 'chapter') {
      const ch = { ...m.ch, ...CHAPTERS[m.ch.key] };
      this.list.push(ch);
      this.list.sort((a, b) => a.T - b.T || ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
      if (this.cur) this.idx = this.list.indexOf(this.cur);
      this.refreshList();
      if (!this.cur) this.go(this.list.indexOf(ch)); // start watching as soon as there is something to watch
    } else if (m.type === 'done') {
      this.searching = false;
      this.progress = m;
      this.status();
      this.refreshList();
    }
  }

  status() {
    const p = this.progress, n = this.list.length, total = ORDER.length;
    $('st-status').textContent = this.searching
      ? `Searching history… tick ${(p ? p.t : 0).toLocaleString()} · ${n} of ${total} transitions found`
      : `${n} of ${total} transitions happened in this world (searched ${(p ? p.t : 0).toLocaleString()} ticks)`;
  }

  refreshList() {
    const s = $('st-chapters');
    const found = new Set(this.list.map((c) => c.key));
    let html = this.list.map((c, i) => `<option value="${i}">${i + 1}. ${c.title} · tick ${c.T.toLocaleString()}</option>`).join('');
    const missing = ORDER.filter((k) => !found.has(k));
    if (missing.length) html += `<optgroup label="${this.searching ? 'Not found yet' : 'Didn’t happen in this world'}">${missing.map((k) => `<option disabled>${CHAPTERS[k].title}</option>`).join('')}</optgroup>`;
    s.innerHTML = html;
    if (this.idx >= 0) s.value = this.idx;
    $('st-prev').disabled = this.idx <= 0;
    $('st-next').disabled = this.idx < 0 || this.idx >= this.list.length - 1;
    this.status();
  }

  go(i) {
    if (i < 0 || i >= this.list.length) return;
    this.idx = i;
    this.cur = this.list[i];
    const c = this.cur;
    $('st-cap').innerHTML = `<b><span class="muted">${i + 1}/${this.list.length}</span> ${c.title}</b>${c.text}`;
    const time = $('st-time');
    time.min = c.start; time.max = c.end; time.step = 1;
    $('st-marker').style.left = `${((c.T - c.start) / (c.end - c.start)) * 100}%`;
    this.app.setOverlay(c.overlay || this.overlay0);
    this.seek(c.start, false);
    this.app.setSpeed(c.speed);
    this.app.setRunning(true);
    this.refreshList();
  }

  // How far the back/forward buttons jump: a tenth of the scene, at least 10 ticks.
  step() { return Math.max(10, Math.round((this.cur.end - this.cur.start) / 10)); }

  // The tick being shown, or about to be (repeated ◀◀ presses add up).
  now() { return this.pending ? this.pending.t : this.app.world.t; }

  // Restore the world at tick t (from the nearest earlier snapshot, then replay forward). Deferred a
  // moment so the busy cursor shows: late in a run a restore takes a second or two.
  seek(t, keepView) {
    const c = this.cur;
    t = Math.max(c.start, Math.min(c.end, Math.round(t)));
    this.pending = { t, keepView, c };
    document.body.classList.add('busy');
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      const p = this.pending;
      this.pending = null;
      if (p && p.c === this.cur) this.restore(p.t, p.keepView);
      document.body.classList.remove('busy');
    }, 30);
  }

  restore(t, keepView) {
    const c = this.cur;
    let s = c.snaps[0];
    for (const q of c.snaps) if (q.t <= t) s = q;
    const w = deserialize(structuredClone(s.data));
    while (w.t < t) w.step();
    this.endedAt = 0;
    const old = this.app.ui.selected, pan = keepView && old && old.follow && old.pan ? { ...old.pan } : null;
    this.app.setWorld(w);
    this.waiting = true;
    this.subject = null;
    if (!this.resolveSubject(keepView ? pan : null) && !keepView) this.frameLocation();
  }

  // Find the chapter's subject in the current world and follow it.
  resolveSubject(pan) {
    const c = this.cur, w = this.app.world;
    // After the moment, follow what the subject became (if it changed into something else).
    const refs = c.ref2 && w.t >= c.T ? [c.ref2, c.ref] : [c.ref, c.ref2];
    let s = null;
    for (const r of refs) if (r && (s = this.find(r, w))) break;
    if (!s) return false;
    this.waiting = false;
    this.subject = s;
    this.viaParent = c.ref.kind === 'cell' && s.obj.id !== c.ref.id && w.t < c.T;
    this.app.follow(s, pan ? { pan } : { fov: this.cur.fov });
    return true;
  }

  frameLocation() {
    const c = this.cur, at = c.at;
    if (!at) return;
    this.app.follow(null, { x: at.x, y: at.y, fov: c.fov });
  }

  // Back to the subject: centred, at the chapter's framing.
  frameSubject() {
    if (!this.resolveSubject(null)) this.frameLocation();
  }

  find(ref, w) {
    switch (ref.kind) {
      case 'cell': {
        let c = w.life.cells.find((q) => q.id === ref.id);
        // Not born yet: watch its parent, which is about to divide into it.
        if (!c && ref.parent && w.t < this.cur.T) c = w.life.cells.find((q) => q.id === ref.parent);
        if (!c) return null;
        // Colony and organism scenes outline the whole organism once there is more than one cell.
        if (ORGANISM_SCENES.has(this.cur.key) && c.orgSize > 1) return organismOf(c, w);
        return sel('cell', c);
      }
      case 'vesicle': { const v = w.soup.vesicles.find((q) => q.id === ref.id); return v ? sel('vesicle', v) : null; }
      case 'virus': { const v = w.viruses.list.find((q) => q.id === ref.id); return v ? sel('virus', Object.assign(v, { r: DIM.virus * NM * 2 }), { world: w }) : null; }
      case 'polymer': {
        let p = w.soup.polymers.find((q) => q.id === ref.id), home = null;
        if (!p) for (const v of w.soup.vesicles) { p = v.polys.find((q) => q.id === ref.id); if (p) { home = v; break; } }
        if (!p) return null;
        p._rad = (p.seq.length * DIM.ntRise * NM) / 2;
        const s = sel('polymer', p);
        if (home) s.parent = sel('vesicle', home);
        return s;
      }
      case 'monomer': {
        const soup = w.soup, i = soup.indexOfMid(ref.id);
        if (i < 0) return null;
        const st = { mid: ref.id, x: soup.mx[i], y: soup.my[i], ang: (ref.id * 2.399) % (Math.PI * 2), gone: false };
        return molecule(soup.mt[i], () => st, () => st.gone, null, { st });
      }
      default: return null;
    }
  }

  label(t) {
    const c = this.cur, d = c.T - t;
    const when = Math.abs(d) <= 3 ? '<b class="now">happening now</b>' : d > 0 ? `in ${d.toLocaleString()} ticks` : `${(-d).toLocaleString()} ticks ago`;
    $('st-tick').innerHTML = `tick ${t.toLocaleString()} · ${when}`;
  }

  update() {
    if (!this.active || !this.cur || this.pending) return; // (a restore is about to replace the world)
    const w = this.app.world, c = this.cur;
    if (this.waiting && c.ref.kind !== 'none' && w.t <= c.end) this.resolveSubject(null);
    if (ORGANISM_SCENES.has(c.key) && w.t % 10 === 0) {
      const s = this.app.ui.selected;
      if (s && s.kind === 'cell' && (s.obj.id === c.ref.id || s.obj.id === c.ref.parent) && s.obj.orgSize > 1 && !s.obj.dead) { const pan = s.pan ? { ...s.pan } : null; this.app.follow(organismOf(s.obj, w), pan ? { pan } : {}); }
    }
    // Was watching the parent of a newborn subject: switch to the subject once it exists.
    if (this.viaParent && w.t % 5 === 0) {
      const s = this.app.ui.selected, own = w.life.cells.find((q) => q.id === c.ref.id);
      if (own && s && s.obj && s.obj.id === c.ref.parent) { const pan = s && s.pan ? { ...s.pan } : null; this.viaParent = false; this.app.follow(sel('cell', own), pan ? { pan } : { fov: c.fov }); }
    }
    if (w.t >= c.end && !this.endedAt) { this.app.setRunning(false); this.endedAt = performance.now(); }
    // Auto-play: a few seconds after a scene ends, go on to the next transition (once it has been found).
    if (this.endedAt && $('st-auto').checked && !this.app.running && performance.now() - this.endedAt > 3500 && this.idx < this.list.length - 1) this.go(this.idx + 1);
    if (!this.scrubbing) { $('st-time').value = Math.min(w.t, c.end); this.label(Math.min(w.t, c.end)); }
    const ended = w.t >= c.end;
    $('st-play').textContent = ended ? '↺' : this.app.running ? '❚❚' : '▶';
    $('st-next').classList.toggle('glow', ended && this.idx < this.list.length - 1);
  }
}
