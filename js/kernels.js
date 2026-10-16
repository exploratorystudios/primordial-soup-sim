// The heavy per-tick work of the living world, as pure functions over flat arrays so it can run on several
// threads at once. Each kernel computes one phase for a range of cells (or grid squares, or viruses),
// reading only the shared inputs and writing only that range's outputs, so a cell's result is the same
// whichever thread computes it and however the work is split: one thread or eight give identical worlds.
//
// Each living cell owns a fixed slot in the arrays for its whole life (Life.slot), so traits that rarely
// change are written only when they change. ORDER lists the slots in the cells' order this tick (RANK is
// the inverse); kernels walk cells in that order, so results never depend on which slot a cell has.
//
// Phases (see Life.step):
//  'cells'   light, metabolism (what each cell wants from the fields, the oxygen it makes, its upkeep),
//            sensing and the new heading (every third tick)
//  'share'   per field square: share out chemicals, organic food and nutrient fairly among the cells there
//            (each gets the same fraction of its request when demand exceeds supply), add their oxygen
//  'contact' collision pushes (all from the same positions, applied together) and the touching pairs where
//            eating, symbiosis or gene transfer can happen (resolved one by one afterwards, in order)
//  'relax'   the gentler extra push pass
//  'virus'   which cells each virus touches (infections are resolved afterwards, in order)

// Cell flags: static ones (packed with the traits) and per-tick ones.
export const F_DEAD = 1, F_MITO = 2, F_INFECTED = 4, F_NODIR = 8, F_HUNTS = 16,
  F_EATS = 32, F_SHOST = 64, F_SPART = 128; // can eat; could host / become a mitochondrion
export const STATIC_FLAGS = F_MITO | F_HUNTS | F_EATS | F_SHOST | F_SPART;
// Output flags of the cells phase.
export const O_SENSED = 1, O_RETHINK = 2, O_OXDEATH = 4;

// Indices into the parameter array P.
export const P_T = 0, P_SEED = 1, P_MAXR = 2, P_HCS = 3, P_HGW = 4, P_HGH = 5, P_FCS = 6, P_FGW = 7, P_FGH = 8,
  P_LIGHT = 9, P_SUNSCALE = 10, P_H = 11, P_VENTGLOW = 12, P_NVENTS = 13, P_N = 14, P_NV = 15, P_DOMAIN = 16,
  P_CHUNKS = 17, P_SEGCAP = 18, P_VSEGCAP = 19, P_HGT = 20, P_SYMB = 21, P_FN = 22, P_O2REF = 23,
  P_AERO = 24, P_O2YIELD = 25, P_SQ = 26, P_DAMP = 27, P_DRIFT = 28, P_W = 29, P_REACH = 30, P_VENTS = 32; // vents: x, y, strength from P_VENTS
export const MAX_VENTS = 32;

// Allocate the arrays for cap cell slots, vcap viruses, nc hash squares and fn field squares. With
// shared = true they live in SharedArrayBuffers that helper threads can read and write.
export function makeViews(cap, vcap, nc, fn, sunLen, chunks, shared) {
  const B = shared ? SharedArrayBuffer : ArrayBuffer;
  const f64 = (n) => new Float64Array(new B(n * 8)), f32 = (n) => new Float32Array(new B(n * 4));
  const i32 = (n) => new Int32Array(new B(n * 4)), u8 = (n) => new Uint8Array(new B(n));
  const segCap = Math.ceil((cap * 24) / chunks) + 512, vsegCap = Math.ceil((vcap * 6) / chunks) + 256;
  return {
    cap, vcap, nc, fn, chunks, segCap, vsegCap, owner: null,
    P: f64(P_VENTS + MAX_VENTS * 3),
    // traits (written when a cell's version changes)
    SVER: i32(cap), SFLAGS: u8(cap), ID: i32(cap), R: f64(cap), AREA: f64(cap), EFFPRED: f64(cap), SENSE: f64(cap), MOT: f64(cap),
    WCHEM: f64(cap), WORG: f64(cap), WOXY: f64(cap), WLIGHT: f64(cap), WPREY: f64(cap), WFLEE: f64(cap),
    PHOTOF: f64(cap), DCHEMK: f64(cap), DORGK: f64(cap), CF: f64(cap), HPROT: f64(cap), AER: f64(cap), COSTS: f64(cap),
    RNAF: f64(cap), TOXB: f64(cap), TOXM: f64(cap), NUTNEED: f64(cap), NUTUP: f64(cap), INFC: f64(cap),
    // per tick
    X: f64(cap), Y: f64(cap), VXC: f64(cap), VYC: f64(cap), ORG: i32(cap), NUT: f64(cap), FLAGS: u8(cap), ORDER: i32(cap), RANK: i32(cap),
    // kept per slot between ticks (written by the cells phase, mirrored to the cell objects)
    HEAD: f64(cap), PX: f64(cap), PY: f64(cap), FX: f64(cap), FY: f64(cap),
    // outputs
    OUTF: u8(cap), HEADOUT: f64(cap), DIRX: f64(cap), DIRY: f64(cap), FI: i32(cap), DCHEM: f64(cap), DORG: f64(cap),
    DNUT: f64(cap), O2ADD: f64(cap), NETB: f64(cap), HF: f64(cap), DE: f64(cap), GNUT: f64(cap), PUSHX: f64(cap), PUSHY: f64(cap), FPUSHX: f64(cap), FPUSHY: f64(cap),
    // grids and fields
    HSTART: i32(nc + 1), HITEMS: i32(cap), PSTART: i32(nc + 1), PITEMS: i32(cap), PIDX: i32(cap), COV: f32(nc),
    FSTART: i32(fn + 1), FITEMS: i32(cap), CURX: f32(fn), CURY: f32(fn), FCHEM: f32(fn), FORG: f32(fn), FOXY: f32(fn), FNUT: f32(fn), SUN: f32(sunLen),
    // viruses
    VX: f64(vcap), VY: f64(vcap), VFLAGS: u8(vcap), // bit 1: searches this tick, bit 2: infects eukaryotes
    EV: i32(segCap * chunks), EVN: i32(chunks), VC: i32(vsegCap * chunks), VCN: i32(chunks), VSTART: i32(vcap), VCOUNT: i32(vcap),
  };
}

// A hash of (seed, tick, id) to [0, 1): a cell's (or pair's) own random stream, independent of the order
// things are processed in (the shared random generator would depend on it).
export function hrand(seed, t, id) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(t + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(id + 1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// The grid squares a query box covers (same rule as SpatialHash.box), written into out[0..3].
function box(P, x, y, r, out) {
  const cs = P[P_HCS], gw = P[P_HGW], gh = P[P_HGH];
  let x0 = Math.floor((x - r) / cs), x1 = Math.floor((x + r) / cs);
  let y0 = Math.floor((y - r) / cs), y1 = Math.floor((y + r) / cs);
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 >= gw) x1 = gw - 1; if (y1 >= gh) y1 = gh - 1;
  out[0] = x0; out[1] = x1; out[2] = y0; out[3] = y1;
}

// Field square of a point (same rule as Fields.idx).
function fieldIdx(P, x, y) {
  const cs = P[P_FCS], gw = P[P_FGW], gh = P[P_FGH];
  let cx = (x / cs) | 0, cy = (y / cs) | 0;
  if (cx < 0) cx = 0; else if (cx >= gw) cx = gw - 1;
  if (cy < 0) cy = 0; else if (cy >= gh) cy = gh - 1;
  return cy * gw + cx;
}

// Cell-grid square of a point (same rule as SpatialHash.cell).
function hashIdx(P, x, y) {
  const cs = P[P_HCS], gw = P[P_HGW], gh = P[P_HGH];
  let cx = Math.floor(x / cs), cy = Math.floor(y / cs);
  if (cx < 0) cx = 0; else if (cx >= gw) cx = gw - 1;
  if (cy < 0) cy = 0; else if (cy >= gh) cy = gh - 1;
  return cy * gw + cx;
}

// Gradient of a field (same rule as Fields.grad), written into g[0..1].
function grad(P, f, x, y, g) {
  const cs = P[P_FCS], gw = P[P_FGW], gh = P[P_FGH];
  let cx = (x / cs) | 0, cy = (y / cs) | 0;
  if (cx < 1) cx = 1; else if (cx > gw - 2) cx = gw - 2;
  if (cy < 1) cy = 1; else if (cy > gh - 2) cy = gh - 2;
  const i = cy * gw + cx;
  const gx = f[i + 1] - f[i - 1], gy = f[i + gw] - f[i - gw];
  const m = Math.hypot(gx, gy);
  if (m < 1e-6) { g[0] = 0; g[1] = 0; return; }
  const rel = Math.min(1, (m / (f[i] + 0.5)) * 5);
  g[0] = (gx / m) * rel; g[1] = (gy / m) * rel;
}

// Sunlight at a depth (same rule as World.sunAt), and light including the vents' glow (World.lightAt).
function sunAt(P, SUN, y) {
  let i = (y * P[P_SUNSCALE]) | 0;
  if (i < 0) i = 0; else if (i >= SUN.length) i = SUN.length - 1;
  return P[P_LIGHT] * SUN[i];
}
function lightAt(P, SUN, x, y) {
  let l = sunAt(P, SUN, y);
  if (y > P[P_H] - 140) {
    for (let k = 0, nv = P[P_NVENTS]; k < nv; k++) {
      const vx = P[P_VENTS + k * 3], vy = P[P_VENTS + k * 3 + 1], vs = P[P_VENTS + k * 3 + 2];
      const dx = x - vx, dy = y - vy, d2 = dx * dx + dy * dy;
      if (d2 < 22500) l += P[P_VENTGLOW] * vs * (1 - Math.sqrt(d2) / 150);
    }
  }
  return l;
}

// --- cells: metabolism for every living cell; sensing and heading for motile ones.
export function cellsKernel(V, k0, k1) {
  const P = V.P, t = P[P_T], seed = P[P_SEED], o2ref = P[P_O2REF], aero = P[P_AERO], o2yield = P[P_O2YIELD], sq = P[P_SQ];
  const { ORDER, X, Y, R, ORG, FLAGS, EFFPRED, SENSE, MOT, ID, HEAD, PX, PY, FX, FY, OUTF, SUN } = V;
  const bx = [0, 0, 0, 0], g = [0, 0];
  for (let k = k0; k < k1; k++) {
    const i = ORDER[k];
    OUTF[i] = 0;
    const fl = FLAGS[i];
    if (fl & F_DEAD) continue;
    const x = X[i], y = Y[i], r = R[i];

    // Metabolism. Light falls when neighbours shade much of the grid square around the cell.
    let light = lightAt(P, SUN, x, y);
    const shade = V.COV[hashIdx(P, x, y)] - Math.min(Math.PI * r * r, sq) / sq;
    if (shade > 0.35) light /= 1 + (shade - 0.35) * 3;
    const fi = fieldIdx(P, x, y);
    V.FI[i] = fi;
    const o2 = V.FOXY[fi], o2f = o2 > o2ref ? 1 : o2 / o2ref;
    const resp = 1 + V.AER[i] * aero * o2f * ((fl & F_MITO) ? 2.5 : 1);
    let gp = 0, o2add = 0;
    if (V.PHOTOF[i] > 0) {
      gp = light * V.PHOTOF[i];
      // Oxygenic photosynthesis needs strong light; dim vent-light photosynthesis is anoxygenic.
      o2add = gp * o2yield * Math.min(1, sunAt(P, SUN, y) * 2);
    }
    V.O2ADD[i] = o2add;
    V.DCHEM[i] = V.DCHEMK[i];
    V.DORG[i] = V.DORGK[i];
    V.HF[i] = V.HPROT[i] * resp;
    // Upkeep: fixed costs, plus an RNA genome's repairs (worse with oxygen) and a virus's hijacking.
    const cost = V.COSTS[i] + V.RNAF[i] * (1 + 2 * o2f) + ((fl & F_INFECTED) ? V.INFC[i] : 0);
    // Oxygen is toxic to cells without antioxidant / aerobic machinery.
    const tox = o2f - V.TOXB[i], toxCost = tox > 0 ? tox * V.TOXM[i] : 0;
    V.NETB[i] = gp - cost - toxCost;
    if (toxCost > cost * 0.5) OUTF[i] |= O_OXDEATH;
    const nut = V.NUT[i], need = V.NUTNEED[i];
    V.DNUT[i] = nut < need ? Math.min(need - nut, V.NUTUP[i]) : 0;

    if (MOT[i] < 0.03) continue;
    const id = ID[i];
    // Sensing prey and predators (only lineages that react to them, every sixth tick).
    if ((id + t) % 6 === 0 && (Math.abs(V.WPREY[i]) > 0.1 || Math.abs(V.WFLEE[i]) > 0.1)) {
      let px = 0, py = 0, fx = 0, fy = 0, bp = 1e9, bf = 1e9;
      const s = SENSE[i], s2 = s * s, org = ORG[i], hunts = (fl & F_HUNTS) !== 0;
      // Non-hunters only react to predators: walk the predator grid (same squares, same order).
      const start = hunts ? V.HSTART : V.PSTART, items = hunts ? V.HITEMS : V.PITEMS, gw = P[P_HGW];
      box(P, x, y, s, bx);
      for (let cy = bx[2]; cy <= bx[3]; cy++) {
        for (let q = cy * gw + bx[0], qe = cy * gw + bx[1]; q <= qe; q++) {
          for (let e = start[q], ee = start[q + 1]; e < ee; e++) {
            const j = hunts ? items[e] : V.PIDX[items[e]];
            if (j === i || (FLAGS[j] & F_DEAD) || ORG[j] === org) continue;
            const dx = X[j] - x, dy = Y[j] - y, d2 = dx * dx + dy * dy;
            if (d2 > s2) continue;
            if (hunts && R[j] * 1.2 < r && d2 < bp) { bp = d2; px = dx; py = dy; }
            if (EFFPRED[j] > 0.05 && R[j] > r * 1.2 && d2 < bf) { bf = d2; fx = -dx; fy = -dy; }
          }
        }
      }
      let m = Math.hypot(px, py); if (m > 0) { px /= m; py /= m; }
      m = Math.hypot(fx, fy); if (m > 0) { fx /= m; fy /= m; }
      PX[i] = px; PY[i] = py; FX[i] = fx; FY[i] = fy;
      OUTF[i] |= O_SENSED;
    }
    // Gradients change slowly: rethink the heading every third tick (and the first time).
    if ((id + t) % 3 === 0 || (fl & F_NODIR)) {
      let dx = 0, dy = 0;
      grad(P, V.FCHEM, x, y, g); dx += g[0] * V.WCHEM[i]; dy += g[1] * V.WCHEM[i];
      grad(P, V.FORG, x, y, g); dx += g[0] * V.WORG[i]; dy += g[1] * V.WORG[i];
      grad(P, V.FOXY, x, y, g); dx += g[0] * V.WOXY[i]; dy += g[1] * V.WOXY[i];
      dy -= V.WLIGHT[i] * 0.8; // phototaxis: light comes from above
      dx += PX[i] * V.WPREY[i] + FX[i] * V.WFLEE[i];
      dy += PY[i] * V.WPREY[i] + FY[i] * V.WFLEE[i];
      const heading = HEAD[i] + (hrand(seed, t, id) - 0.5) * 0.5;
      dx += Math.cos(heading) * 0.3;
      dy += Math.sin(heading) * 0.3;
      const m = Math.hypot(dx, dy) || 1;
      V.HEADOUT[i] = heading; V.DIRX[i] = dx / m; V.DIRY[i] = dy / m;
      OUTF[i] |= O_RETHINK;
    }
  }
}

// --- share: per field square, the cells there (FSTART/FITEMS, in their order) split what it holds. When
// they ask for more than there is, each gets the same fraction of its request. Their oxygen is added after.
export function shareKernel(V, q0, q1) {
  const { FSTART, FITEMS, FCHEM, FORG, FNUT, FOXY, DCHEM, DORG, DNUT, O2ADD, NETB, CF, HF, DE, GNUT } = V;
  for (let q = q0; q < q1; q++) {
    const s0 = FSTART[q], s1 = FSTART[q + 1];
    if (s0 === s1) continue;
    let dc = 0, dor = 0, dn = 0, ox = 0;
    for (let e = s0; e < s1; e++) { const i = FITEMS[e]; dc += DCHEM[i]; dor += DORG[i]; dn += DNUT[i]; ox += O2ADD[i]; }
    const ac = FCHEM[q], ao = FORG[q], an = FNUT[q];
    const fc = dc > ac ? (ac > 0 ? ac / dc : 0) : 1, fo = dor > ao ? (ao > 0 ? ao / dor : 0) : 1, fn = dn > an ? (an > 0 ? an / dn : 0) : 1;
    for (let e = s0; e < s1; e++) {
      const i = FITEMS[e];
      DE[i] = NETB[i] + DCHEM[i] * fc * CF[i] + DORG[i] * fo * HF[i];
      GNUT[i] = DNUT[i] * fn;
    }
    FCHEM[q] = Math.max(0, ac - dc * fc); FORG[q] = Math.max(0, ao - dor * fo); FNUT[q] = Math.max(0, an - dn * fn);
    FOXY[q] += ox;
  }
}

// --- contact / relax: each cell's push from every neighbour it overlaps, all computed from the same
// positions. The contact pass also lists the touching pairs from different organisms where something can
// happen: one could eat the other, they could merge (symbiosis), or genes pass between them (decided here,
// from the pair's own random stream). Entries are (slot a, slot b, gene transfer?), a before b in order.
export function contactKernel(V, k0, k1, relax, chunk) {
  const P = V.P, maxR = P[P_MAXR], gw = P[P_HGW], { ORDER, RANK, X, Y, R, AREA, ORG, FLAGS, ID, HSTART, HITEMS, PUSHX, PUSHY, FPUSHX, FPUSHY, EV } = V;
  const seed = P[P_SEED], t = P[P_T], hgtP = P[P_HGT], symb = P[P_SYMB] !== 0;
  const bx = [0, 0, 0, 0], segCap = P[P_SEGCAP], base = chunk * segCap;
  let ne = 0, overflow = false;
  for (let k = k0; k < k1; k++) {
    const i = ORDER[k];
    let pushx = 0, pushy = 0, fpx = 0, fpy = 0; // (fp: the part from other organisms)
    if (FLAGS[i] & F_DEAD) { PUSHX[i] = 0; PUSHY[i] = 0; FPUSHX[i] = 0; FPUSHY[i] = 0; continue; }
    const ax = X[i], ay = Y[i], ar = R[i], aarea = AREA[i], org = ORG[i];
    box(P, ax, ay, ar + maxR, bx);
    for (let cy = bx[2]; cy <= bx[3]; cy++) {
      for (let q = cy * gw + bx[0], qe = cy * gw + bx[1]; q <= qe; q++) {
        for (let e = HSTART[q], ee = HSTART[q + 1]; e < ee; e++) {
          const j = HITEMS[e];
          if (j === i || (FLAGS[j] & F_DEAD)) continue;
          const dx = X[j] - ax, dy = Y[j] - ay, d2 = dx * dx + dy * dy;
          const rr = relax ? (ar + R[j]) * 0.97 : ar + R[j];
          if (d2 >= rr * rr) continue;
          const d = Math.sqrt(d2) || 0.01, s = aarea + AREA[j];
          const ov = (rr - d) * (relax ? 0.7 : 0.8); // membranes barely interpenetrate
          const px = (dx / d) * ov * (AREA[j] / s), py = (dy / d) * ov * (AREA[j] / s);
          pushx -= px; pushy -= py;
          if (ORG[j] !== org) { fpx -= px; fpy -= py; }
          if (!relax && RANK[j] > k && ORG[j] !== org) {
            const fi = FLAGS[i], fj = FLAGS[j];
            const hgt = hrand(seed, t, Math.imul(ID[i], 73856093) ^ Math.imul(ID[j], 19349663)) < hgtP ? 1 : 0;
            const eats = ((fi | fj) & F_EATS) !== 0;
            const merge = symb && (((fi & F_SHOST) && (fj & F_SPART)) || ((fj & F_SHOST) && (fi & F_SPART)));
            if (hgt || eats || merge) {
              if (ne + 3 > segCap) overflow = true;
              else { EV[base + ne] = i; EV[base + ne + 1] = j; EV[base + ne + 2] = hgt; ne += 3; }
            }
          }
        }
      }
    }
    PUSHX[i] = pushx; PUSHY[i] = pushy; FPUSHX[i] = fpx; FPUSHY[i] = fpy;
  }
  if (!relax) V.EVN[chunk] = overflow ? -1 : ne;
}

// --- virus: for each virus searching this tick, the cells (slots) it touches, in grid order, skipping cells
// already dead or infected and, with domains on, cells of the other domain.
export function virusKernel(V, v0, v1, chunk) {
  const P = V.P, maxR = P[P_MAXR], gw = P[P_HGW], domain = P[P_DOMAIN] !== 0;
  const { X, Y, R, FLAGS, HSTART, HITEMS, VX, VY, VFLAGS, VC, VSTART, VCOUNT } = V;
  const bx = [0, 0, 0, 0], cap = P[P_VSEGCAP], base = chunk * cap;
  let nc = 0, overflow = false;
  for (let k0 = v0; k0 < v1; k0++) {
    VSTART[k0] = base + nc; VCOUNT[k0] = 0;
    if (!(VFLAGS[k0] & 1)) continue;
    const vx = VX[k0], vy = VY[k0], veuk = (VFLAGS[k0] & 2) !== 0;
    box(P, vx, vy, maxR + 1, bx);
    for (let cy = bx[2]; cy <= bx[3]; cy++) {
      for (let q = cy * gw + bx[0], qe = cy * gw + bx[1]; q <= qe; q++) {
        for (let e = HSTART[q], ee = HSTART[q + 1]; e < ee; e++) {
          const j = HITEMS[e], f = FLAGS[j];
          if (f & (F_DEAD | F_INFECTED)) continue;
          if (domain && veuk !== ((f & F_MITO) !== 0)) continue;
          const dx = X[j] - vx, dy = Y[j] - vy;
          if (dx * dx + dy * dy > (R[j] + 0.1) * (R[j] + 0.1)) continue;
          if (nc + 1 > cap) { overflow = true; continue; }
          VC[base + nc++] = j; VCOUNT[k0]++;
        }
      }
    }
  }
  V.VCN[chunk] = overflow ? -1 : nc;
}

// --- move: currents and vent plumes carry each cell, plus a little random jostling from its own random
// stream; then velocity, damping and the walls (bonds between colony cells were applied before).
export function moveKernel(V, k0, k1) {
  const P = V.P, t = P[P_T], seed = P[P_SEED], damp = P[P_DAMP], drift = P[P_DRIFT], W = P[P_W], H = P[P_H], reach = P[P_REACH];
  const { ORDER, X, Y, VXC, VYC, R, FLAGS, ID, CURX, CURY } = V;
  for (let k = k0; k < k1; k++) {
    const i = ORDER[k];
    if (FLAGS[i] & F_DEAD) continue;
    let x = X[i], y = Y[i], vx = VXC[i], vy = VYC[i];
    const r = R[i], id = ID[i], fi = fieldIdx(P, x, y);
    // Hot water rises from the vents (same rule as World.plume).
    let plume = 0;
    if (y >= H - reach) {
      for (let v = 0, nv = P[P_NVENTS]; v < nv; v++) if (Math.abs(x - P[P_VENTS + v * 3]) < 35) { plume = -0.45 * (1 - (H - y) / reach); break; }
    }
    vx += (hrand(seed, t, Math.imul(id, 2) + 1) - 0.5) * 0.1 + CURX[fi] * drift;
    vy += (hrand(seed, t, Math.imul(id, 2) + 2) - 0.5) * 0.1 + CURY[fi] * drift + plume * 0.3;
    x += vx; y += vy;
    vx *= damp; vy *= damp;
    if (x < r) { x = r; vx = Math.abs(vx) * 0.5; } else if (x > W - r) { x = W - r; vx = -Math.abs(vx) * 0.5; }
    if (y < r) { y = r; vy = Math.abs(vy) * 0.5; } else if (y > H - r) { y = H - r; vy = -Math.abs(vy) * 0.5; }
    X[i] = x; Y[i] = y; VXC[i] = vx; VYC[i] = vy;
  }
}

export function runChunk(V, phase, chunk) {
  const P = V.P, K = P[P_CHUNKS], total = phase === 'virus' ? P[P_NV] : phase === 'share' ? P[P_FN] : P[P_N];
  const i0 = Math.floor((chunk * total) / K), i1 = Math.floor(((chunk + 1) * total) / K);
  if (phase === 'cells') cellsKernel(V, i0, i1);
  else if (phase === 'share') shareKernel(V, i0, i1);
  else if (phase === 'contact') contactKernel(V, i0, i1, false, chunk);
  else if (phase === 'relax') contactKernel(V, i0, i1, true, chunk);
  else if (phase === 'virus') virusKernel(V, i0, i1, chunk);
  else if (phase === 'move') moveKernel(V, i0, i1);
}
export const PHASES = ['cells', 'share', 'contact', 'relax', 'virus', 'move'];
