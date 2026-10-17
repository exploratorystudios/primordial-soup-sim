// Procedural cell anatomy, shared by the renderer (what you see) and the inspector (what you can
// click). Every structure is generated deterministically from the cell's id and simulated state,
// so a given cell always has the same organelles in the same places. None of it is simulated
// molecule by molecule; it represents what such a cell contains, at true size.
import { RNG } from './rng.js';

const TAU = Math.PI * 2;
export const NM = 1 / 500; // world units per nanometre

// A smooth random walk confined to a disc: how a long polymer crumples inside a small space.
function tangle(rng, n, step, rad) {
  const out = [];
  let x = 0, y = 0, th = rng.next() * TAU;
  for (let k = 0; k < n; k++) {
    th += (rng.next() - 0.5) * 1.2;
    x += Math.cos(th) * step; y += Math.sin(th) * step;
    const d = Math.hypot(x, y);
    if (d > rad) { x *= rad / d; y *= rad / d; th += Math.PI * 0.8; }
    out.push(x, y);
  }
  return out;
}

function scatter(rng, n, rMin, rMax, avoid = []) {
  const out = [];
  for (let k = 0, tries = 0; out.length < n && tries < n * 30; tries++) {
    const th = rng.next() * TAU, rr = rMin + rng.next() * (rMax - rMin);
    const p = { fx: Math.cos(th) * rr, fy: Math.sin(th) * rr, s: 0.7 + rng.next() * 0.6, ang: rng.next() * TAU };
    if (avoid.some((q) => Math.hypot(q.fx - p.fx, q.fy - p.fy) < q.rad)) continue;
    out.push(p);
  }
  return out;
}

export function buildAnatomy(c) {
  const shown = c.mitoN ?? 99;
  const key = ((c.mito ? 1 : 0) | (c.plastid ? 2 : 0) | (c.effP > 0.25 ? 4 : 0) | (c.dna ? 8 : 0) | (Math.round(c.transl * 4) << 4)) + Math.min(shown, 99) * 1024;
  const old = c._anat;
  if (old && old.key === key && old.r === c.r) return old;
  const rng = new RNG((Math.imul(c.id, 2654435761) ^ 0x9e3779b9) >>> 0);
  const a = { key, r: c.r, ribo: [], dna: [], chrom: [], mitos: [], plast: [], er: [], nuc: null, thyl: !c.mito && c.effP > 0.25 };
  const rUm = c.r * 0.5, areaUm2 = Math.PI * rUm * rUm;
  const hole = c.mito ? 0.4 : 0;
  const nr = Math.min(700, Math.round(areaUm2 * 45 * (0.3 + 0.7 * c.transl)));
  for (let k = 0, tries = 0; k < nr && tries < nr * 5; tries++) {
    const x = rng.next() * 2 - 1, y = rng.next() * 2 - 1, d2 = x * x + y * y;
    if (d2 > 0.86 || d2 < hole * hole) continue;
    a.ribo.push(x, y); k++;
  }
  if (!c.mito) {
    // Prokaryotic nucleoid: one very long chromosome crumpled into the middle of the cell.
    a.dna = tangle(rng, 900, 0.035, 0.46);
    // Plasmids: small extra DNA circles, often carrying genes that spread between cells.
    a.plasmids = scatter(rng, 1 + rng.int(3), 0.5, 0.75);
    // Pili: hair-like filaments used to attach and to pass DNA to other cells (conjugation).
    const np = 3 + rng.int(6);
    a.pili = [];
    for (let k = 0; k < np; k++) a.pili.push({ ang: rng.next() * TAU, len: 2 + rng.next() * 2 }); // 1–2 µm
    // Storage granules (polyphosphate, glycogen) and, in photosynthesisers, carboxysomes.
    a.granules = scatter(rng, 2 + rng.int(4), 0.3, 0.8);
    a.carbox = a.thyl ? scatter(rng, 3 + rng.int(4), 0.2, 0.55) : [];
  } else {
    a.nuc = { fx: (rng.next() - 0.5) * 0.3, fy: (rng.next() - 0.5) * 0.3 };
    a.chrom = tangle(rng, 900, 0.05, 0.85); // chromatin fibres inside the nucleus
    for (let k = 0; k < 5; k++) a.er.push({ rr: 0.42 + k * 0.045, a0: rng.next() * TAU, span: 1 + rng.next() * 2.2 });
    // Golgi apparatus beside the nucleus, centrosome on the other side.
    const gAng = rng.next() * TAU;
    a.golgi = { fx: Math.cos(gAng) * 0.56, fy: Math.sin(gAng) * 0.56, ang: gAng, n: 5 };
    const cAng = gAng + Math.PI * (0.6 + rng.next() * 0.8);
    a.centro = { fx: Math.cos(cAng) * 0.42, fy: Math.sin(cAng) * 0.42, ang: rng.next() * TAU };
    a.mts = [];
    for (let k = 0; k < 16; k++) a.mts.push({ ang: (k / 16) * TAU + rng.next() * 0.3, len: 0.35 + rng.next() * 0.5 });
    const avoid = [{ fx: 0, fy: 0, rad: 0.42 }, { fx: a.golgi.fx, fy: a.golgi.fy, rad: 0.15 }];
    if (c.plastid) {
      // Algae have a large central vacuole: a water-filled sac that keeps the cell firm.
      const vAng = gAng + Math.PI;
      a.vacuole = { fx: Math.cos(vAng) * 0.55, fy: Math.sin(vAng) * 0.55, r: 0.22 };
      avoid.push({ fx: a.vacuole.fx, fy: a.vacuole.fy, rad: 0.26 });
    }
    const nm = Math.max(2, Math.min(24, Math.round(areaUm2 / 5)));
    for (let k = 0; k < nm; k++) {
      const rr = 0.52 + rng.next() * 0.3, th = rng.next() * TAU;
      a.mitos.push({ fx: Math.cos(th) * rr, fy: Math.sin(th) * rr, ang: rng.next() * Math.PI, s: 0.8 + rng.next() * 0.4 });
    }
    a.mitos = a.mitos.slice(0, Math.max(1, Math.min(a.mitos.length, shown)));
    if (c.plastid) {
      const np = Math.max(1, Math.min(4, Math.round(areaUm2 / 20)));
      for (let k = 0; k < np; k++) {
        const th = (k / np) * TAU + rng.next(), rr = 0.6;
        a.plast.push({ fx: Math.cos(th) * rr, fy: Math.sin(th) * rr, ang: th + Math.PI / 2 });
      }
    }
    a.lyso = scatter(rng, 3 + rng.int(4), 0.5, 0.85, avoid);
    a.perox = scatter(rng, 2 + rng.int(3), 0.5, 0.85, avoid);
    // Drawn up close only (and drawn last, so nothing above moves): polysomes, proteasomes, clathrin-coated pits,
    // food vacuoles (cells that eat), a contractile vacuole.
    a.polysomes = scatter(rng, 6 + rng.int(5), 0.46, 0.9, avoid).map((q) => ({ ...q, n: 4 + rng.int(5) }));
    a.proteasomes = scatter(rng, 16, 0.45, 0.92, avoid);
    a.pits = [];
    for (let k = 0; k < 7; k++) a.pits.push({ ang: rng.next() * TAU, stage: rng.next() });
    a.food = c.effPred > 0.05 || c.effH > 0.3 ? scatter(rng, 1 + rng.int(3), 0.45, 0.75, avoid).map((q) => ({ ...q, prey: 0.3 + rng.next() * 0.6 })) : [];
    const cvAng = rng.next() * TAU;
    a.cv = { fx: Math.cos(cvAng) * 0.78, fy: Math.sin(cvAng) * 0.78, ph: rng.next() };
  }
  c._anat = a;
  return a;
}

// ------------------------------------------------------------------ geometry (world units)
const at = (c, fx, fy) => ({ x: c.x + fx * c.r, y: c.y + fy * c.r });

export function mitoSize(c, m) { const L = Math.min(1000 * NM * m.s, c.r * 0.5); return { L, W: L / 2 }; }
export function plastSize(c) { const L = Math.min(8, c.r * 0.75); return { L, W: L * 0.45 }; }

// Point in an organelle's local frame (lx along its long axis) to world.
export function local(c, o, lx, ly) {
  const p = at(c, o.fx, o.fy), ca = Math.cos(o.ang), sa = Math.sin(o.ang);
  return { x: p.x + lx * ca - ly * sa, y: p.y + lx * sa + ly * ca };
}
export function toLocal(c, o, x, y) {
  const p = at(c, o.fx, o.fy), dx = x - p.x, dy = y - p.y, ca = Math.cos(o.ang), sa = Math.sin(o.ang);
  return { lx: dx * ca + dy * sa, ly: -dx * sa + dy * ca };
}

// Mitochondrion internals in its local frame.
export function cristae(L, W) {
  const out = [];
  for (let k = 1; k <= 5; k++) {
    const x = -L / 2 + (k / 6) * L, s = k & 1 ? 1 : -1;
    out.push({ x, y1: s * W * 0.48, y2: -s * W * 0.15 });
  }
  return out;
}
export function grana(L, W) {
  const out = [], gw = L * 0.1, gh = W * 0.06;
  for (let g = 0; g < 4; g++) {
    const gx = -L * 0.3 + g * L * 0.2, discs = [];
    for (let s = 0; s < 5; s++) discs.push({ x: gx - gw / 2, y: -W * 0.18 + s * gh * 1.6, w: gw, h: gh });
    out.push({ x: gx, y: -W * 0.18 + 2 * gh * 1.6 + gh / 2, w: gw, h: gh * 1.6 * 5, discs });
  }
  return out;
}

// Golgi: a stack of curved cisternae (cis face toward the nucleus).
export function golgiCisternae(c, a) {
  const g = a.golgi, p = at(c, g.fx, g.fy), out = [];
  const len = Math.min(1.2 / 0.5 * 1, c.r * 0.3); // ~1.2 µm wide
  const nx = Math.cos(g.ang), ny = Math.sin(g.ang), tx = -ny, ty = nx;
  for (let i = 0; i < g.n; i++) {
    const off = (i - (g.n - 1) / 2) * 70 * NM, l = len * (1 - Math.abs(i - (g.n - 1) / 2) * 0.12), pts = [];
    for (let k = 0; k <= 10; k++) {
      const u = k / 10 - 0.5, bend = (u * u - 0.25) * len * 0.35;
      pts.push({ x: p.x + nx * (off + bend) + tx * u * l, y: p.y + ny * (off + bend) + ty * u * l });
    }
    out.push({ i, pts, face: i === 0 ? 'cis' : i === g.n - 1 ? 'trans' : 'medial' });
  }
  return out;
}
// Transport vesicles bud from the trans face and travel out to the cell membrane, where they fuse.
export function golgiVesicles(c, a, t = 0) {
  const g = a.golgi, p = at(c, g.fx, g.fy), len = Math.min(2.4, c.r * 0.3), out = [];
  const nx = Math.cos(g.ang), ny = Math.sin(g.ang), tx = -ny, ty = nx;
  for (let k = 0; k < 6; k++) {
    const u = (k / 5 - 0.5) * 0.9, off = ((g.n + 1) / 2) * 70 * NM + 50 * NM;
    const sx = p.x + nx * off + tx * u * len, sy = p.y + ny * off + ty * u * len;
    const ang = g.ang + (k - 2.5) * 0.22, ex = c.x + Math.cos(ang) * c.r * 0.97, ey = c.y + Math.sin(ang) * c.r * 0.97;
    const f = (t * 0.004 + k / 6) % 1, e = f * f * (3 - 2 * f);
    out.push({ x: sx + (ex - sx) * e, y: sy + (ey - sy) * e, r: 30 * NM, f });
  }
  return out;
}

// Gene expression and genome copying, as functions of simulation time and the cell's state.
export function hash32(a, b = 0) {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
// Fraction of its genome a cell has copied: replication runs as it builds up toward dividing.
export function replicationProgress(c) {
  const f = c.energy / c.cap, start = c.divFrac * 0.55;
  return Math.max(0, Math.min(1, (f - start) / (c.divFrac - start)));
}
// RNA polymerases transcribing genes: where each is along the chromosome path, and how much RNA it has made.
export const GENE_LEN = 70; // path points per gene
export function polymerases(c, nPts, t) {
  const out = [], n = 2 + Math.round(c.transl * 4), act = 0.3 + 0.7 * Math.max(0, Math.min(1, c.energy / c.cap));
  for (let k = 0; k < n; k++) {
    const g0 = hash32(c.id, k) % nPts, cycle = GENE_LEN + 40, speed = 0.12 * act * (0.6 + (hash32(c.id, k + 50) % 100) / 200);
    const prog = (t * speed + (hash32(c.id, k + 99) % cycle)) % cycle;
    out.push({ k, g0, prog, done: prog > GENE_LEN, idx: (g0 + Math.min(prog, GENE_LEN)) % nPts });
  }
  return out;
}
// Codons a ribosome has read: it ratchets one codon at a time, faster in a busy, well-fed cell.
export function translationPhase(c, seed, t) {
  const rate = 0.03 * (0.3 + 0.7 * c.transl) * (0.3 + 0.7 * Math.max(0, Math.min(1, c.energy / c.cap)));
  return t * rate + (seed % 97) / 97;
}

// Microtubules grow and shrink at their tips all the time (dynamic instability).
export function microtubules(c, a, t = 0) {
  const o = at(c, a.centro.fx, a.centro.fy);
  return a.mts.map((m, k) => {
    const ex = c.x + Math.cos(m.ang) * c.r * 0.9, ey = c.y + Math.sin(m.ang) * c.r * 0.9;
    const f = m.len * 1.4 * (0.78 + 0.22 * Math.sin(t * 0.017 + k * 1.7));
    return { x1: o.x, y1: o.y, x2: o.x + (ex - o.x) * f, y2: o.y + (ey - o.y) * f };
  });
}

export function erRibosomes(c, a) {
  // Rough ER: ribosomes bound along the outer face of the ER membranes, every ~60 nm.
  const out = [];
  for (const e of a.er) {
    const R = e.rr * c.r, step = (60 * NM) / R, n = Math.min(400, Math.floor(e.span / step));
    for (let k = 0; k < n; k++) {
      const th = e.a0 + k * step, rr = R + 30 * NM;
      out.push({ x: c.x + Math.cos(th) * rr, y: c.y + Math.sin(th) * rr });
    }
  }
  return out;
}

export function nuclearPores(c) {
  const nr = c.r * 0.34, gap = 30 * NM, np = Math.round((TAU * nr) / (500 * NM)), out = [];
  for (let k = 0; k < np; k++) {
    const th = (k / np) * TAU;
    out.push({ x: c.x + Math.cos(th) * (nr + gap / 2), y: c.y + Math.sin(th) * (nr + gap / 2), k });
  }
  return out;
}

export function piliLines(c, a) {
  return (a.pili || []).map((p) => ({
    x1: c.x + Math.cos(p.ang) * c.r, y1: c.y + Math.sin(p.ang) * c.r,
    x2: c.x + Math.cos(p.ang) * (c.r + p.len), y2: c.y + Math.sin(p.ang) * (c.r + p.len),
  }));
}

export function flagellumPath(c, t, n = 40) {
  const sp = Math.hypot(c.vx, c.vy);
  let ux = -Math.cos(c.heading), uy = -Math.sin(c.heading);
  if (sp > 0.02) { ux = -c.vx / sp; uy = -c.vy / sp; }
  const len = Math.min(20, c.r * 5), amp = 0.5, lambda = 5, ph = t * 0.8 + c.id, pts = [];
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * len, w = amp * Math.sin((s / lambda) * TAU - ph) * Math.min(1, s / 1.5);
    pts.push({ x: c.x + ux * (c.r + s) - uy * w, y: c.y + uy * (c.r + s) + ux * w });
  }
  return pts;
}

// New virus capsids assembling inside an infected cell.
export function capsids(c, time) {
  const inf = c.infected;
  if (!inf) return [];
  const prog = Math.min(1, (time - inf.since) / Math.max(1, inf.t - inf.since)), n = Math.floor(prog * 24);
  const rng = new RNG((c.id * 31337) >>> 0), out = [];
  for (let k = 0; k < n; k++) {
    const a = rng.next() * TAU, rr = Math.sqrt(rng.next()) * 0.8 * c.r;
    out.push({ x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr });
  }
  return out;
}

// Proteins embedded in the membrane, one every ~30 nm around the rim.
export const MEMBRANE_PROTEINS = [
  { name: 'Ion channel', size: 8, desc: 'A pore that lets specific ions (K⁺, Na⁺, Ca²⁺) cross the membrane, shaping the cell’s voltage.' },
  { name: 'ATP synthase', size: 10, desc: 'A rotary motor: protons flowing back through it spin a rotor that builds ATP, the cell’s energy currency.' },
  { name: 'Transporter', size: 7, desc: 'Carries nutrients such as sugars or phosphate across the membrane, often powered by an ion gradient.' },
  { name: 'Proton pump', size: 8, desc: 'Pushes protons out of the cell, building the electrochemical gradient that powers much of its chemistry.' },
  { name: 'Receptor', size: 6, desc: 'Senses molecules outside the cell (and, unluckily, is what viruses latch onto).' },
  { name: 'Aquaporin', size: 6, desc: 'A water channel: four subunits, each a pore so narrow that water molecules pass single file while ions are kept out.' },
];
// A eukaryote's plasma membrane has no ATP synthase (that's in its mitochondria and chloroplasts) but has aquaporins.
const EUK_MEMBRANE = [0, 2, 3, 4, 5];
export function membraneProteinSpacing(R) { return (30 * NM) / R; } // radians between protein slots
export function membraneProteinAt(c, k) {
  let h = Math.imul(c.id + 1, 0x9e3779b9) ^ Math.imul(k + 11, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  if ((h & 3) !== 0) return null; // ~1 in 4 slots holds a protein
  return c.mito ? MEMBRANE_PROTEINS[EUK_MEMBRANE[(h >>> 4) % EUK_MEMBRANE.length]] : MEMBRANE_PROTEINS[(h >>> 4) % 4];
}

// Peptidoglycan wall geometry: glycan-strand layers ~4 nm apart, cross-links every ~4 nm, sugar
// units every ~1 nm along a strand.
export const WALL_LINK = 4 * NM, WALL_UNIT = 1 * NM;
export function wallLayers(wall) { return Math.max(1, Math.round(wall / (4 * NM))); }
export function wallLayerR(c, wall, i) { const n = wallLayers(wall); return c.r + 2 * NM + (n === 1 ? wall / 2 : (i + 0.5) * (wall / n)); }
