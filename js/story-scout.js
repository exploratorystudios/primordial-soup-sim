// Story mode, part 1 (a Web Worker): replay the world from tick 0 and find one clear example of every
// transition. For each, keep a snapshot from shortly before it plus snapshots until the scene ends, so
// the player can restore the world, watch the transition happen, and rewind. Only watches: it never
// changes the simulation, so a restored snapshot replays exactly what happened here.
import { World } from './world.js';
import { serialize } from './persist.js';
import { CFG } from './config.js';

const NMU = 500; // nanometres per world unit
const FINE_MAX = 48, COARSE_EVERY = 1000, COARSE_MAX = 12;

let stopped = false;
self.onmessage = (e) => {
  if (e.data.cmd === 'start') run(e.data.seed, e.data.maxTicks || 150000);
  else if (e.data.cmd === 'stop') stopped = true;
};

function snapshot(w) {
  return {
    t: w.t,
    ids: { mid: w.soup.nextMid, pid: w.soup.nextPid, ves: w.soup.vesId, cell: w.life.nextId, virus: w.viruses.nextId },
    data: structuredClone(serialize(w)), // a deep copy: the live world keeps changing
  };
}

// Did the subject already exist when this snapshot was taken? (Ids only ever increase.)
function existed(ref, s) {
  switch (ref.kind) {
    case 'monomer': return ref.id < s.ids.mid;
    case 'polymer': return ref.id < s.ids.pid;
    case 'vesicle': return ref.id < s.ids.ves;
    case 'cell': return ref.id < s.ids.cell || (ref.parent != null && ref.parent < s.ids.cell);
    case 'virus': return ref.id < s.ids.virus;
    default: return true;
  }
}

async function run(seed, maxTicks) {
  const w = new World(seed);
  const fine = [], coarse = [];
  const found = new Set(), pending = [];
  const copyStart = new Map(); // strand id -> tick its current copy began
  let lastFine = -1e9, lastPost = 0;

  // Queue a chapter if a snapshot from early enough (with the subject already in it) is available.
  function propose(key, ref, o) {
    if (found.has(key)) return;
    const T = w.t, all = [...fine, ...coarse].sort((a, b) => b.t - a.t);
    const ok = (s) => o.appears || existed(ref, s); // appears: the subject may be born during the scene (watch its spot until then)
    let start = all.find((s) => s.t <= T - o.lead && ok(s));
    if (!start) start = all.find((s) => s.t <= T - (o.leadMin ?? 0) && ok(s));
    if (!start) return; // the subject is too new to watch from before: wait for another example
    found.add(key);
    pending.push({ key, T, start: start.t, end: T + o.tail, ref, ref2: o.ref2 || null, at: o.at || null, fov: o.fovNm, snaps: all.filter((s) => s.t >= start.t).sort((a, b) => a.t - b.t) });
  }
  const fov = (r, k) => Math.max(60, r * 2 * NMU * k);
  const cellRef = (c) => ({ kind: 'cell', id: c.id, parent: c.parentId || null }); // a newborn is watched via its parent until it exists
  const pickCell = (score) => { let best = null, bs = -Infinity; for (const c of w.life.cells) { const s = score(c); if (s > bs) { bs = s; best = c; } } return best; };
  const orgFounder = (want) => {
    const o = w.life.organisms.find(want);
    if (!o) return null;
    let f = null;
    for (const c of w.life.cells) if (c.org === o.id && (!f || c.born < f.born)) f = c;
    return f && { o, f };
  };

  const emit = w.emit.bind(w);
  w.emit = (type, dur, d) => {
    emit(type, dur, d);
    switch (type) {
      case 'spawn': if (d.vent && w.t > 40) propose('vent', { kind: 'monomer', id: d.mid }, { lead: 4, leadMin: 1, tail: 50, fovNm: 35, at: { x: d.x, y: d.y }, appears: true }); break;
      case 'bond': propose('bond', { kind: 'monomer', id: d.a }, { lead: 14, leadMin: 5, tail: 40, fovNm: Math.min(150, Math.max(22, Math.hypot(d.ax - d.bx, d.ay - d.by) * NMU * 2.6)), ref2: { kind: 'polymer', id: d.p.id } }); break;
      case 'join': if (!d.p.home && d.p.seq.length >= 5) propose('chain', { kind: 'polymer', id: d.p.id }, { lead: 90, leadMin: 25, tail: 30, fovNm: 28 }); break;
      case 'copy': {
        if (d.i === 0) copyStart.set(d.p.id, w.t);
        if (d.p.home && d.i === d.p.seq.length - 1) {
          const lead = Math.min(140, w.t - (copyStart.get(d.p.id) ?? w.t - 140) + 10);
          propose('innercopy', { kind: 'polymer', id: d.p.id }, { lead, leadMin: 15, tail: 40, fovNm: Math.max(40, d.p.home.r * 2 * NMU * 1.4) });
          copyStart.delete(d.p.id);
        }
        break;
      }
      case 'peel': if (d.parent && !d.parent.home) {
        const lead = Math.min(300, w.t - (copyStart.get(d.parent.id) ?? w.t - 200) + 10);
        propose('replicator', { kind: 'polymer', id: d.parent.id }, { lead, leadMin: 30, tail: 50, fovNm: 30 });
        copyStart.delete(d.parent.id);
        break;
      }
      case 'vform': propose('vesicle', { kind: 'vesicle', id: d.v.id }, { lead: 22, leadMin: 8, tail: 60, fovNm: fov(d.v.r, 2.2), at: { x: d.v.x, y: d.v.y }, appears: true }); break;
      case 'vsplit': if (d.v && (d.a.polys.some((p) => p.act > 0) || d.b.polys.some((p) => p.act > 0))) propose('protocell', { kind: 'vesicle', id: d.v.id }, { lead: 160, leadMin: 40, tail: 90, fovNm: fov(d.v.r, 4), ref2: { kind: 'vesicle', id: (d.a.polys.length >= d.b.polys.length ? d.a : d.b).id }, at: { x: d.v.x, y: d.v.y }, appears: true }); break;
      case 'abio': propose('cell', { kind: 'vesicle', id: d.v.id }, { lead: 160, leadMin: 30, tail: 150, fovNm: fov(d.vr, 3), ref2: cellRef(d.cell), at: { x: d.cell.x, y: d.cell.y }, appears: true }); break;
      case 'divide': propose('division', cellRef(d.a), { lead: 60, leadMin: 15, tail: 50, fovNm: fov(d.a.r, 4.5) }); break;
      case 'engulf': if (!d.endo) propose('predator', cellRef(d.pred), { lead: 60, leadMin: 15, tail: 60, fovNm: fov(d.pred.r, 5) }); break;
      case 'vescape': propose('virus', cellRef(d.host), { lead: 40, leadMin: 10, tail: 160, fovNm: fov(d.host.r, 6) }); break;
      case 'inject': if (d.v) propose('infection', { kind: 'virus', id: d.v.id }, { lead: 80, leadMin: 20, tail: 80, fovNm: Math.max(1500, d.cell.r * 2 * NMU * 3), ref2: cellRef(d.cell) }); break;
      case 'burst': propose('lysis', cellRef(d.cell), { lead: 90, leadMin: 20, tail: 70, fovNm: fov(d.cell.r, 6) }); break;
      case 'hgt': propose('hgt', cellRef(d.b), { lead: 40, leadMin: 10, tail: 50, fovNm: fov(d.b.r, 5) }); break;
      case 'mate': propose('sex', cellRef(d.a), { lead: 40, leadMin: 10, tail: 60, fovNm: Math.hypot(d.a.x - d.b.x, d.a.y - d.b.y) * NMU * 2 + fov(d.a.r, 2) }); break;
    }
  };

  const milestone = w.milestone.bind(w);
  w.milestone = (key, text, subj) => {
    const isNew = !w.mset.has(key);
    milestone(key, text, subj);
    if (!isNew) return;
    const L = w.life;
    switch (key) {
      case 'eukaryote': case 'plastid':
        propose(key, cellRef(subj), { lead: 60, leadMin: 15, tail: key === 'eukaryote' ? 420 : 220, fovNm: fov(subj.rTarget ?? subj.r, 1.8) });
        break;
      case 'germline': propose('germline', cellRef(subj), { lead: 30, leadMin: 5, tail: 260, fovNm: fov(subj.r, 10) }); break;
      case 'translation': {
        const c = pickCell((c) => c.transl - c.id * 1e-9);
        if (c) propose('protein', cellRef(c), { lead: 5, leadMin: 0, tail: 260, fovNm: fov(c.r, 0.55) });
        break;
      }
      case 'dna': {
        const c = pickCell((c) => (c.dna ? 1 : 0) - Math.abs(c.energy / c.cap - c.divFrac * 0.7));
        if (c) propose('dna', cellRef(c), { lead: 5, leadMin: 0, tail: 320, fovNm: fov(c.r, 0.9) });
        break;
      }
      case 'photo': {
        const c = pickCell((c) => c.effP);
        if (c) propose('photo', cellRef(c), { lead: 5, leadMin: 0, tail: 260, fovNm: fov(c.r, 3) });
        break;
      }
      case 'goe':
        propose('goe', { kind: 'none' }, { lead: 6000, leadMin: 1500, tail: 1000, fovNm: CFG.W * NMU, at: { x: CFG.W / 2, y: CFG.H / 2 }, appears: true });
        break;
      case 'colony': case 'multicellular': case 'complex': {
        const want = key === 'colony' ? (o) => o.size >= 4 : key === 'multicellular' ? (o) => o.kind !== 'colony' : (o) => o.kind === 'complex';
        const r = orgFounder(want);
        if (!r) break;
        const lead = Math.min(key === 'colony' ? 2500 : 4000, w.t - r.f.born + 20);
        const extent = Math.sqrt(r.o.size) * r.f.r * 2 * NMU * 3.2;
        propose(key, cellRef(r.f), { lead, leadMin: Math.min(lead, 100), tail: key === 'colony' ? 150 : 600, fovNm: Math.max(fov(r.f.r, 6), extent) });
        break;
      }
    }
  };

  const t0 = performance.now();
  while (!stopped && w.t < maxTicks) {
    w.step();
    // Rolling snapshots: dense recently (for short scenes), sparse further back (for time-lapses).
    const n = w.life.cells.length, every = n < 300 ? 25 : n < 2000 ? 100 : 200;
    if (w.t - lastFine >= every) {
      const s = snapshot(w);
      lastFine = w.t;
      fine.push(s); if (fine.length > FINE_MAX) fine.shift();
      if (w.t % COARSE_EVERY < every) { coarse.push(s); if (coarse.length > COARSE_MAX) coarse.shift(); }
      for (const p of pending) if (p.snaps.at(-1) !== s && s.t <= p.end + every) p.snaps.push(s);
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (w.t < p.end) continue;
      pending.splice(i, 1);
      // Long scenes: keep the snapshot count (and memory) bounded; rewinding replays the gaps.
      if (p.snaps.length > 24) { const n = p.snaps.length; p.snaps = Array.from({ length: 24 }, (_, k) => p.snaps[Math.round((k * (n - 1)) / 23)]); }
      self.postMessage({ type: 'chapter', ch: { key: p.key, T: p.T, start: p.start, end: p.end, ref: p.ref, ref2: p.ref2, at: p.at, fov: p.fov, snaps: p.snaps.map((s) => ({ t: s.t, data: s.data })) } });
    }
    if (performance.now() - lastPost > 250) {
      lastPost = performance.now();
      self.postMessage({ type: 'progress', t: w.t, found: [...found], milestones: [...w.mset], tps: Math.round(w.t / ((performance.now() - t0) / 1000)) });
      await new Promise((r) => setTimeout(r, 0)); // let 'stop' messages in
    }
    if (found.size >= 25 && !pending.length) break; // everything found
  }
  self.postMessage({ type: 'done', t: w.t, found: [...found], milestones: [...w.mset] });
}
