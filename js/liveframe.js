// Live view (sim-server): the server runs the world and sends compact frames about once a second; a page
// watching it keeps a copy of the world built from an occasional full snapshot and updates it from each frame.
// A frame carries everything that changes from moment to moment (each cell's position, size, job, bonds and
// state, the viruses, the molecule soup, the census and records) but not genomes: a cell born since the last
// full snapshot is drawn from its parent's genome (or its species') until the next one.
import { Cell, decode } from './life.js';
import * as Gn from './genome.js';
import { CFG } from './config.js';

function b64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str, Type) {
  let bytes;
  if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(str, 'base64'));
  else { const s = atob(str); bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i); }
  return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

const TURN = 6.283185307;
const F_MITO = 1, F_PLASTID = 2, F_INFECTED = 4, F_SEXUAL = 8;
const polyOut = (p) => ({ id: p.id, x: p.x, y: p.y, ang: p.ang, seq: p.seq, prog: p.prog, copy: p.copy });

// Server: the frame for the world as it is now. withFields adds the chemical fields (they change slowly).
export function buildFrame(w, seq, withFields) {
  const L = w.life, cells = L.cells, n = cells.length, soup = w.soup, ns = soup.n;
  const id = new Int32Array(n), parent = new Int32Array(n), species = new Int32Array(n), org = new Int32Array(n), orgSize = new Int32Array(n), gen = new Int32Array(n);
  const x = new Float32Array(n), y = new Float32Array(n), r = new Float32Array(n), age = new Float32Array(n);
  const energy = new Uint16Array(n), heading = new Uint8Array(n); // (fraction of capacity; angle in 256ths of a turn)
  const type = new Uint8Array(n), flags = new Uint8Array(n), bondStart = new Int32Array(n + 1);
  let nb = 0;
  for (let i = 0; i < n; i++) nb += cells[i].bonds.length;
  const bonds = new Int32Array(nb);
  nb = 0;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    id[i] = c.id; parent[i] = c.parentId; species[i] = c.species; org[i] = c.org; orgSize[i] = c.orgSize; gen[i] = c.gen;
    x[i] = c.x; y[i] = c.y; r[i] = c.r; age[i] = c.age;
    energy[i] = Math.round(Math.max(0, Math.min(1, c.energy / c.cap)) * 65535);
    heading[i] = Math.round((((c.heading % TURN) + TURN) % TURN) / TURN * 256) & 255;
    type[i] = c.type;
    flags[i] = (c.mito ? F_MITO : 0) | (c.plastid ? F_PLASTID : 0) | (c.infected ? F_INFECTED : 0) | (c.sexual ? F_SEXUAL : 0);
    bondStart[i] = nb;
    for (const o of c.bonds) bonds[nb++] = o.id;
  }
  bondStart[n] = nb;
  // Viruses as arrays too (keys and turn quantized: nothing visible depends on finer detail).
  const vl = w.viruses.list, nv = vl.length;
  const vid = new Int32Array(nv), vx = new Float32Array(nv), vy = new Float32Array(nv), vk1 = new Uint16Array(nv), vk2 = new Uint16Array(nv);
  const vlin = new Int32Array(nv), vage = new Int32Array(nv), vang = new Uint8Array(nv), veuk = new Uint8Array(nv), vci = new Int16Array(nv), vcv = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const v = vl[i];
    vid[i] = v.id; vx[i] = v.x; vy[i] = v.y; vk1[i] = Math.round(v.k1 * 65535); vk2[i] = Math.round(v.k2 * 65535);
    vlin[i] = v.lineage; vage[i] = v.age; vang[i] = Math.round((((v.ang % TURN) + TURN) % TURN) / TURN * 256) & 255; veuk[i] = v.euk ? 1 : 0;
    vci[i] = v.cargo ? v.cargo.i : -1; vcv[i] = v.cargo ? v.cargo.v : 0;
  }
  const F = w.fields;
  return {
    live: 1, seq, t: w.t, seed: w.seed,
    env: { vents: w.vents, lightMul: w.lightMul, ventMul: w.ventMul, timers: w.timers, phase: w.phase, o2: w.o2, atmO2: w.atmO2 },
    record: { milestones: w.milestones, logs: w.logs, history: w.history, historyEvery: w.historyEvery },
    fields: withFields ? { chem: b64(F.chem), organic: b64(F.organic), oxygen: b64(F.oxygen), nutrient: b64(F.nutrient) } : null,
    soup: {
      n: ns, mx: b64(soup.mx.slice(0, ns)), my: b64(soup.my.slice(0, ns)), mt: b64(soup.mt.slice(0, ns)), mid: b64(soup.mid.slice(0, ns)),
      stats: soup.stats, polymers: soup.polymers.map(polyOut),
      vesicles: soup.vesicles.map((v) => ({ id: v.id, x: v.x, y: v.y, L: v.L, gen: v.gen, copies: v.copies, age: v.age, pool: v.pool, polys: v.polys.map(polyOut) })),
    },
    life: {
      stats: L.stats, births: L.births, deaths: L.deaths, sexualBirths: L.sexualBirths, nextId: L.nextId, nextSpecies: L.nextSpecies, origins: L.origins,
      organisms: L.organisms,
      n, id: b64(id), parent: b64(parent), species: b64(species), org: b64(org), orgSize: b64(orgSize), gen: b64(gen),
      x: b64(x), y: b64(y), r: b64(r), energy: b64(energy), age: b64(age), heading: b64(heading),
      type: b64(type), flags: b64(flags), bondStart: b64(bondStart), bonds: b64(bonds),
    },
    viruses: {
      n: nv, id: b64(vid), x: b64(vx), y: b64(vy), k1: b64(vk1), k2: b64(vk2), lineage: b64(vlin), age: b64(vage), ang: b64(vang), euk: b64(veuk), ci: b64(vci), cv: b64(vcv),
      nextId: w.viruses.nextId, lineages: w.viruses.lineages, stats: w.viruses.stats, domain: !!CFG.VIRUS_DOMAIN,
    },
  };
}

// Page: bring the world up to date with a frame. a is how far the view had glided toward the last frame (0 … 1):
// everything starts its next glide from where it is drawn right now, so nothing jumps when a frame comes early or
// late. Molecules, protocells, cells and viruses stay the same objects from frame to frame (the renderer keeps
// per-object details on them, like where a strand sits inside its protocell). approx collects the cells drawn from
// a stand-in genome (born since the last full snapshot), for mergeFull to put right.
export function applyFrame(w, f, a = 1, approx = null) {
  const shown = (o) => { if (o.x0 === undefined) return; o.x0 += (o.x - o.x0) * a; o.y0 += (o.y - o.y0) * a; };
  w.t = f.t;
  Object.assign(w, f.env);
  w.milestones = f.record.milestones;
  w.mset = new Set(w.milestones.map((m) => m.key));
  w.logs = f.record.logs; w.history = f.record.history; w.historyEvery = f.record.historyEvery;
  if (f.fields) for (const k of ['chem', 'organic', 'oxygen', 'nutrient']) w.fields[k].set(unb64(f.fields[k], Float32Array));

  // Free molecules (plain arrays, matched by id).
  const soup = w.soup, S = f.soup;
  const prevM = new Map();
  for (let i = 0; i < soup.n; i++) prevM.set(soup.mid[i], i);
  const pmx = new Float32Array(soup.n), pmy = new Float32Array(soup.n);
  for (let i = 0; i < soup.n; i++) { pmx[i] = soup.px0[i] + (soup.mx[i] - soup.px0[i]) * a; pmy[i] = soup.py0[i] + (soup.my[i] - soup.py0[i]) * a; }
  soup.n = S.n;
  soup.mx.set(unb64(S.mx, Float32Array)); soup.my.set(unb64(S.my, Float32Array));
  soup.mt.set(unb64(S.mt, Uint8Array)); soup.mid.set(unb64(S.mid, Int32Array));
  for (let i = 0; i < S.n; i++) {
    const j = prevM.get(soup.mid[i]);
    if (j === undefined) { soup.px0[i] = soup.mx[i]; soup.py0[i] = soup.my[i]; } else { soup.px0[i] = pmx[j]; soup.py0[i] = pmy[j]; }
  }
  soup.mdead.fill(0);
  soup.stats = S.stats;
  // Strands and protocells.
  const oldP = new Map(); for (const p of soup.polymers) oldP.set(p.id, p);
  for (const v of soup.vesicles) for (const p of v.polys) oldP.set(p.id, p);
  const polyIn = (q) => {
    let p = oldP.get(q.id);
    if (p) {
      if (p.a0 !== undefined) p.a0 += (p.ang - p.a0) * a;
      shown(p);
      const reseq = p.seq !== q.seq;
      p.x = q.x; p.y = q.y; p.ang = q.ang; p.prog = q.prog; p.copy = q.copy; p.dead = false;
      if (reseq) { p.seq = q.seq; soup.evalPolymer(p); }
    } else {
      p = { id: q.id, x: q.x, y: q.y, ang: q.ang, seq: q.seq, act: 0, fid: 0.8, stab: 0, prog: q.prog, copy: q.copy, dead: false };
      soup.evalPolymer(p);
      p.x0 = p.x; p.y0 = p.y; p.a0 = p.ang;
    }
    p.home = undefined;
    return p;
  };
  const oldV = new Map(); for (const v of soup.vesicles) oldV.set(v.id, v);
  soup.polymers = S.polymers.map(polyIn);
  const vesId = soup.vesId;
  soup.vesicles = S.vesicles.map((q) => {
    let v = oldV.get(q.id);
    if (v) { shown(v); v.x = q.x; v.y = q.y; v.L = q.L; v.r = 2.5 + Math.sqrt(q.L) * 1.25; v.gen = q.gen; v.dead = false; }
    else { v = { ...soup.makeVesicle(q.x, q.y, q.L, q.gen), id: q.id }; v.x0 = v.x; v.y0 = v.y; }
    v.copies = q.copies; v.age = q.age; v.pool = q.pool; v.polys = q.polys.map(polyIn);
    for (const p of v.polys) p.home = v;
    return v;
  });
  soup.vesId = vesId;

  // Cells: update the ones we know, make the newborns (from their parent's or species' genome), drop the dead.
  const L = w.life, D = f.life;
  Object.assign(L, { stats: D.stats, births: D.births, deaths: D.deaths, sexualBirths: D.sexualBirths, nextId: D.nextId, nextSpecies: D.nextSpecies, origins: D.origins });
  L.organisms = D.organisms;
  const old = new Map();
  for (const c of L.cells) { old.set(c.id, c); shown(c); } // (x0 is now where it is drawn)
  const A = (k, T) => unb64(D[k], T);
  const id = A('id', Int32Array), parent = A('parent', Int32Array), species = A('species', Int32Array), org = A('org', Int32Array), orgSize = A('orgSize', Int32Array), gen = A('gen', Int32Array);
  const x = A('x', Float32Array), y = A('y', Float32Array), r = A('r', Float32Array), age = A('age', Float32Array), energy = A('energy', Uint16Array), heading = A('heading', Uint8Array);
  const type = A('type', Uint8Array), flags = A('flags', Uint8Array), bondStart = A('bondStart', Int32Array), bonds = A('bonds', Int32Array);
  const cells = new Array(D.n), byId = new Map(), oldAll = new Map(old);
  for (let i = 0; i < D.n; i++) {
    let c = old.get(id[i]);
    if (c) old.delete(id[i]);
    else {
      const p = byId.get(parent[i]) || oldAll.get(parent[i]) || null;
      const sp = L.species.get(species[i]);
      const g = p ? p.g : sp ? sp.rep : null;
      if (!g) continue; // (nothing to draw it from until the next full snapshot)
      c = new Cell(id[i], x[i], y[i], g, null);
      c.parentId = parent[i]; c.species = species[i]; c.origin = p ? p.origin : 0;
      c.mito = !!(flags[i] & F_MITO); c.plastid = !!(flags[i] & F_PLASTID);
      decode(c);
      // Born out of its parent: start from where the parent is drawn.
      c.x0 = p ? p.x0 : x[i]; c.y0 = p ? p.y0 : y[i];
      if (approx) approx.add(c.id);
    }
    c.x = x[i]; c.y = y[i]; c.age = age[i]; c.gen = gen[i]; c.heading = (heading[i] / 256) * TURN;
    setRadius(c, r[i]);
    c.energy = (energy[i] / 65535) * c.cap;
    c.type = type[i]; c.org = org[i]; c.orgSize = orgSize[i];
    c.infected = flags[i] & F_INFECTED ? c.infected || { t: f.t, since: f.t } : null;
    c.sexual = !!(flags[i] & F_SEXUAL);
    c.dead = false;
    cells[i] = c; byId.set(c.id, c);
  }
  for (const c of old.values()) { c.dead = true; if (approx) approx.delete(c.id); } // (a selection of it shows it gone)
  L.cells = cells.filter(Boolean);
  for (let i = 0; i < D.n; i++) {
    const c = cells[i];
    if (!c) continue;
    const list = [];
    for (let k = bondStart[i]; k < bondStart[i + 1]; k++) { const o = byId.get(bonds[k]); if (o) list.push(o); }
    c.bonds = list;
  }

  // Viruses (the same objects too).
  const V = f.viruses, B = (k, T) => unb64(V[k], T);
  const vid = B('id', Int32Array), vx = B('x', Float32Array), vy = B('y', Float32Array), vk1 = B('k1', Uint16Array), vk2 = B('k2', Uint16Array);
  const vlin = B('lineage', Int32Array), vage = B('age', Int32Array), vang = B('ang', Uint8Array), veuk = B('euk', Uint8Array), vci = B('ci', Int16Array), vcv = B('cv', Float32Array);
  const oldVir = new Map(); for (const v of w.viruses.list) oldVir.set(v.id, v);
  const list = new Array(V.n);
  for (let i = 0; i < V.n; i++) {
    let v = oldVir.get(vid[i]);
    if (v) shown(v); else v = { id: vid[i], x0: vx[i], y0: vy[i] };
    v.x = vx[i]; v.y = vy[i]; v.k1 = vk1[i] / 65535; v.k2 = vk2[i] / 65535; v.lineage = vlin[i];
    v.cargo = vci[i] >= 0 ? { i: vci[i], v: vcv[i] } : null; v.age = vage[i]; v.ang = (vang[i] / 256) * TURN;
    if (V.domain) v.euk = veuk[i] === 1;
    list[i] = v;
  }
  w.viruses.list = list;
  Object.assign(w.viruses, { nextId: V.nextId, lineages: V.lineages, stats: V.stats });
  w.smooth = true;
}

// The frame's radius, and what scales with it.
function setRadius(c, r) {
  if (c.r === r) return;
  c.r = r; c.area = (r / 2) * (r / 2); c.m = Math.pow(c.area, 0.75); c.cap = CFG.CAP_K * c.m * (c.mito ? 2.2 : 1);
}

// Page: a full snapshot puts right what frames can't carry, without rebuilding the world (which would redraw
// everything slightly differently): the species, and the true genomes of cells drawn from a stand-in.
export function mergeFull(w, d, approx) {
  const L = w.life;
  L.species = new Map(d.life.species.map((s) => [s.id, { ...s, rep: Gn.fitGenome(unb64(s.rep, Float32Array), s.id) }]));
  const byId = new Map(d.life.cells.map((q) => [q.id, q]));
  const alive = new Set(L.cells.map((c) => c.id));
  for (const c of L.cells) {
    if (!approx.has(c.id)) continue;
    const q = byId.get(c.id);
    if (!q) continue;
    const r = c.r;
    c.g = Gn.fitGenome(unb64(q.g, Float32Array), c.id);
    c.origin = q.origin; c.founderSeq = q.founderSeq;
    decode(c);
    c.r = NaN; setRadius(c, r); // (keep its drawn size)
    approx.delete(c.id);
  }
  for (const id of approx) if (!alive.has(id)) approx.delete(id);
}
