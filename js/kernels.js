// The heavy per-tick work of the living world, as pure functions over flat arrays so it can run on several
// threads at once. Each kernel computes one phase for a range of cells (or viruses), reading only the
// shared input arrays and writing only that range's outputs, so a cell's result is the same whichever
// thread computes it and however the work is split: one thread or eight give identical worlds.
//
// Phases (see Life.step): 'steer' (light, sensing, heading), 'contact' (collision pushes and the contacts
// that may lead to eating, gene transfer or symbiosis), 'relax' (gentler extra push pass), 'virus' (which
// cells each virus touches). The main thread packs the inputs, runs the phase (itself or with helpers),
// then applies the results in a fixed order.

// Cell flags.
export const F_DEAD = 1, F_MITO = 2, F_INFECTED = 4, F_NODIR = 8, F_HUNTS = 16,
  F_EATS = 32, F_SHOST = 64, F_SPART = 128; // can eat; could host / become a mitochondrion
// Output flags of the steer phase.
export const O_SENSED = 1, O_RETHINK = 2;

// Indices into the parameter array P.
export const P_T = 0, P_SEED = 1, P_MAXR = 2, P_HCS = 3, P_HGW = 4, P_HGH = 5, P_FCS = 6, P_FGW = 7, P_FGH = 8,
  P_LIGHT = 9, P_SUNSCALE = 10, P_H = 11, P_VENTGLOW = 12, P_NVENTS = 13, P_N = 14, P_NV = 15, P_DOMAIN = 16,
  P_CHUNKS = 17, P_SEGCAP = 18, P_VSEGCAP = 19, P_HGT = 20, P_SYMB = 21, P_VENTS = 24; // vents: x, y, strength from P_VENTS
export const MAX_VENTS = 32;

// Allocate the arrays for cap cells, vcap viruses, nc hash squares and fn field squares. With shared = true
// they live in SharedArrayBuffers that helper threads can read and write.
export function makeViews(cap, vcap, nc, fn, sunLen, chunks, shared) {
  const B = shared ? SharedArrayBuffer : ArrayBuffer;
  const f64 = (n) => new Float64Array(new B(n * 8)), f32 = (n) => new Float32Array(new B(n * 4));
  const i32 = (n) => new Int32Array(new B(n * 4)), u8 = (n) => new Uint8Array(new B(n));
  const segCap = Math.ceil((cap * 24) / chunks) + 512, vsegCap = Math.ceil((vcap * 6) / chunks) + 256;
  return {
    cap, vcap, nc, fn, chunks, segCap, vsegCap,
    P: f64(P_VENTS + MAX_VENTS * 3),
    X: f64(cap), Y: f64(cap), R: f64(cap), AREA: f64(cap), EFFPRED: f64(cap), SENSE: f64(cap), MOT: f64(cap),
    WCHEM: f64(cap), WORG: f64(cap), WOXY: f64(cap), WLIGHT: f64(cap), WPREY: f64(cap), WFLEE: f64(cap),
    HEAD: f64(cap), PX: f64(cap), PY: f64(cap), FX: f64(cap), FY: f64(cap),
    DIRX: f64(cap), DIRY: f64(cap), HEADOUT: f64(cap), LIGHTOUT: f64(cap), PUSHX: f64(cap), PUSHY: f64(cap),
    ID: i32(cap), ORG: i32(cap), FLAGS: u8(cap), OUTF: u8(cap),
    HSTART: i32(nc + 1), HITEMS: i32(cap), PSTART: i32(nc + 1), PITEMS: i32(cap), PIDX: i32(cap),
    FCHEM: f32(fn), FORG: f32(fn), FOXY: f32(fn), SUN: f32(sunLen),
    VX: f64(vcap), VY: f64(vcap), VFLAGS: u8(vcap), // bit 1: searches this tick, bit 2: infects eukaryotes
    EV: i32(segCap * chunks), EVN: i32(chunks), VC: i32(vsegCap * chunks), VCN: i32(chunks), VSTART: i32(vcap), VCOUNT: i32(vcap),
  };
}

// A hash of (seed, tick, id) to [0, 1): each cell's own random stream, independent of the order cells are
// processed in (the shared random generator would depend on it).
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

// Gradient of a field (same rule as Fields.grad), written into g[0..1].
function grad(V, f, x, y, g) {
  const P = V.P, cs = P[P_FCS], gw = P[P_FGW], gh = P[P_FGH];
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

// Light at a point (same rule as World.lightAt).
function lightAt(P, SUN, x, y) {
  let i = (y * P[P_SUNSCALE]) | 0;
  if (i < 0) i = 0; else if (i >= SUN.length) i = SUN.length - 1;
  let l = P[P_LIGHT] * SUN[i];
  if (y > P[P_H] - 140) {
    for (let k = 0, nv = P[P_NVENTS]; k < nv; k++) {
      const vx = P[P_VENTS + k * 3], vy = P[P_VENTS + k * 3 + 1], vs = P[P_VENTS + k * 3 + 2];
      const dx = x - vx, dy = y - vy, d2 = dx * dx + dy * dy;
      if (d2 < 22500) l += P[P_VENTGLOW] * vs * (1 - Math.sqrt(d2) / 150);
    }
  }
  return l;
}

// --- steer: light at each cell, and for motile cells their sensing and (every third tick) a new heading.
export function steerKernel(V, i0, i1) {
  const P = V.P, t = P[P_T], seed = P[P_SEED], n = P[P_N];
  const { X, Y, R, ORG, FLAGS, EFFPRED, SENSE, MOT, ID, HEAD, PX, PY, FX, FY, OUTF } = V;
  const bx = [0, 0, 0, 0], g = [0, 0];
  for (let i = i0; i < i1; i++) {
    OUTF[i] = 0;
    if (FLAGS[i] & F_DEAD) continue;
    const x = X[i], y = Y[i];
    V.LIGHTOUT[i] = lightAt(P, V.SUN, x, y);
    if (MOT[i] < 0.03) continue;
    const id = ID[i];
    // Sensing prey and predators (only lineages that react to them, every sixth tick).
    if ((id + t) % 6 === 0 && (Math.abs(V.WPREY[i]) > 0.1 || Math.abs(V.WFLEE[i]) > 0.1)) {
      let px = 0, py = 0, fx = 0, fy = 0, bp = 1e9, bf = 1e9;
      const s = SENSE[i], s2 = s * s, r = R[i], org = ORG[i], hunts = (FLAGS[i] & F_HUNTS) !== 0;
      // Non-hunters only react to predators: walk the predator grid (same squares, same order).
      const start = hunts ? V.HSTART : V.PSTART, items = hunts ? V.HITEMS : V.PITEMS, gw = P[P_HGW];
      box(P, x, y, s, bx);
      for (let cy = bx[2]; cy <= bx[3]; cy++) {
        for (let q = cy * gw + bx[0], qe = cy * gw + bx[1]; q <= qe; q++) {
          for (let k = start[q], e = start[q + 1]; k < e; k++) {
            const j = hunts ? items[k] : V.PIDX[items[k]];
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
      OUTF[i] |= 1;
    }
    // Gradients change slowly: rethink the heading every third tick (and the first time).
    if ((id + t) % 3 === 0 || (FLAGS[i] & F_NODIR)) {
      let dx = 0, dy = 0;
      grad(V, V.FCHEM, x, y, g); dx += g[0] * V.WCHEM[i]; dy += g[1] * V.WCHEM[i];
      grad(V, V.FORG, x, y, g); dx += g[0] * V.WORG[i]; dy += g[1] * V.WORG[i];
      grad(V, V.FOXY, x, y, g); dx += g[0] * V.WOXY[i]; dy += g[1] * V.WOXY[i];
      dy -= V.WLIGHT[i] * 0.8; // phototaxis: light comes from above
      dx += PX[i] * V.WPREY[i] + FX[i] * V.WFLEE[i];
      dy += PY[i] * V.WPREY[i] + FY[i] * V.WFLEE[i];
      const heading = HEAD[i] + (hrand(seed, t, id) - 0.5) * 0.5;
      dx += Math.cos(heading) * 0.3;
      dy += Math.sin(heading) * 0.3;
      const m = Math.hypot(dx, dy) || 1;
      V.HEADOUT[i] = heading; V.DIRX[i] = dx / m; V.DIRY[i] = dy / m;
      OUTF[i] |= 2;
    }
  }
}

// --- contact / relax: each cell's push from every neighbour it overlaps (all computed from the same
// positions, then applied together). The contact pass also lists the touching pairs from different organisms
// where something can happen: one could eat the other, they could merge (symbiosis), or genes pass between
// them (decided here, from the pair's own random stream). Each entry is (i, j, gene transfer?); they are
// resolved one by one afterwards, in this order.
export function contactKernel(V, i0, i1, relax, chunk) {
  const P = V.P, maxR = P[P_MAXR], gw = P[P_HGW], { X, Y, R, AREA, ORG, FLAGS, ID, HSTART, HITEMS, PUSHX, PUSHY, EV } = V;
  const seed = P[P_SEED], t = P[P_T], hgtP = P[P_HGT], symb = P[P_SYMB] !== 0;
  const bx = [0, 0, 0, 0], segCap = P[P_SEGCAP], base = chunk * segCap;
  let ne = 0, overflow = false;
  for (let i = i0; i < i1; i++) {
    let pushx = 0, pushy = 0;
    if (FLAGS[i] & F_DEAD) { PUSHX[i] = 0; PUSHY[i] = 0; continue; }
    const ax = X[i], ay = Y[i], ar = R[i], aarea = AREA[i], org = ORG[i];
    box(P, ax, ay, ar + maxR, bx);
    for (let cy = bx[2]; cy <= bx[3]; cy++) {
      for (let q = cy * gw + bx[0], qe = cy * gw + bx[1]; q <= qe; q++) {
        for (let k = HSTART[q], e = HSTART[q + 1]; k < e; k++) {
          const j = HITEMS[k];
          if (j === i || (FLAGS[j] & F_DEAD)) continue;
          const dx = X[j] - ax, dy = Y[j] - ay, d2 = dx * dx + dy * dy;
          const rr = relax ? (ar + R[j]) * 0.97 : ar + R[j];
          if (d2 >= rr * rr) continue;
          const d = Math.sqrt(d2) || 0.01, s = aarea + AREA[j];
          const ov = (rr - d) * (relax ? 0.7 : 0.8); // membranes barely interpenetrate
          pushx -= (dx / d) * ov * (AREA[j] / s); pushy -= (dy / d) * ov * (AREA[j] / s);
          if (!relax && j > i && ORG[j] !== org) {
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
    PUSHX[i] = pushx; PUSHY[i] = pushy;
  }
  if (!relax) V.EVN[chunk] = overflow ? -1 : ne;
}

// --- virus: for each virus searching this tick, the cells it touches (in grid order), skipping cells
// already dead or infected and, with domains on, cells of the other domain. Infections are resolved
// afterwards, one virus at a time.
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
        for (let k = HSTART[q], e = HSTART[q + 1]; k < e; k++) {
          const j = HITEMS[k], f = FLAGS[j];
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

export function runChunk(V, phase, chunk) {
  const P = V.P, K = P[P_CHUNKS], total = phase === 'virus' ? P[P_NV] : P[P_N];
  const i0 = Math.floor((chunk * total) / K), i1 = Math.floor(((chunk + 1) * total) / K);
  if (phase === 'steer') steerKernel(V, i0, i1);
  else if (phase === 'contact') contactKernel(V, i0, i1, false, chunk);
  else if (phase === 'relax') contactKernel(V, i0, i1, true, chunk);
  else if (phase === 'virus') virusKernel(V, i0, i1, chunk);
}
export const PHASES = ['steer', 'contact', 'relax', 'virus'];
