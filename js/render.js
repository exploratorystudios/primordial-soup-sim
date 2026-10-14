// Canvas renderer. Everything is drawn at its true physical size: one world unit = 0.5 µm,
// so the habitat is 0.7 × 0.45 mm. Detail appears as you zoom ("semantic zoom"):
// molecules, membrane bilayers and organelles are drawn once they are big enough to see.
//
// To keep precision at extreme zoom (~10^5×) everything is drawn relative to the camera.
import { CFG } from './config.js';
import { LIPID, BASES } from './chemistry.js';
import { RNG } from './rng.js';
import { ribosomeModel, ribosomeAngle, AMINO, translationState } from './ribosome.js';
import { polymerases, replicationProgress, translationPhase, hash32, GENE_LEN, wallLayers, wallLayerR, WALL_LINK, WALL_UNIT, buildAnatomy, microtubules, erRibosomes, golgiCisternae, golgiVesicles, nuclearPores, piliLines, flagellumPath, capsids, mitoSize, plastSize, cristae, grana, membraneProteinAt, membraneProteinSpacing } from './anatomy.js';

export const NM_PER_UNIT = 500;
const NM = 1 / NM_PER_UNIT; // world units per nanometre
const MIN_ZOOM = 0.5, MAX_ZOOM = 250000;

// Real dimensions in nanometres.
export const DIM = {
  ntRise: 0.59,       // distance between nucleotides along single-stranded RNA
  lipidSpacing: 0.75, // between neighbouring lipid heads in a leaflet
  lipidHead: 0.35,
  lipidTail: 1.5,
  bilayer: 4,         // membrane thickness
  ribosome: 22,
  dna: 2,
  flagellum: 20,
  junction: 40,
  mitoLen: 1000, mitoW: 500,
  nuclearPore: 100, nuclearGap: 30,
  virus: 50,          // capsid radius (a ~100 nm phage head)
};

export const MONO_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#efe6c4'];
export const TYPE_COLORS = ['#9aa7b8', '#5fd16b', '#4fd2ff', '#ff5d6c', '#c79a5b', '#ffd23f'];
const OVERLAY = {
  chem: { rgb: [255, 140, 40], ref: 8 },
  organic: { rgb: [190, 120, 255], ref: 4 },
  oxygen: { rgb: [90, 230, 255], ref: 3 },
  nutrient: { rgb: [140, 255, 120], ref: 1.2 },
};
const TAU = Math.PI * 2;
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

// A deterministic "sequence" for drawn DNA so a given cell always shows the same bases.
export function dnaBase(seed, seg, k) {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seg + 1, 0xc2b2ae35) ^ Math.imul(k + 7, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) & 3;
}


export function formatLen(nm) {
  const p = (v) => String(+v.toPrecision(3));
  if (nm < 1000) return `${p(nm)} nm`;
  if (nm < 1e6) return `${p(nm / 1000)} µm`;
  return `${p(nm / 1e6)} mm`;
}

function niceNumber(x) {
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}

export function scaleName(fieldNm) {
  if (fieldNm >= 300000) return 'Habitat';
  if (fieldNm >= 40000) return 'Organisms & colonies';
  if (fieldNm >= 4000) return 'Cells';
  if (fieldNm >= 400) return 'Cell interior';
  if (fieldNm >= 40) return 'Membranes & macromolecules';
  return 'Molecules';
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: CFG.W / 2, y: CFG.H / 2, zoom: 1 };
    this.off = document.createElement('canvas');
    this.overlayKey = null;
    this.frame = 0;
    // If the browser ever drops the canvas (GPU reset, memory pressure), wait for it to come back.
    canvas.addEventListener('contextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('contextrestored', () => { this.lost = false; this.overlayKey = null; });
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.base = Math.min(this.canvas.width / CFG.W, this.canvas.height / CFG.H);
  }

  fit() { this.cam.x = CFG.W / 2; this.cam.y = CFG.H / 2; this.cam.zoom = 1; }

  // Device pixels per world unit.
  get ppu() { return this.base * this.cam.zoom; }

  fieldWidthNm() { return (this.canvas.width / this.ppu) * NM_PER_UNIT; }

  setFieldWidthNm(nm) {
    const units = nm / NM_PER_UNIT;
    this.cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.canvas.width / units / this.base));
  }

  screenToWorld(sx, sy) {
    const s = this.ppu;
    return {
      x: (sx * this.dpr - this.canvas.width / 2) / s + this.cam.x,
      y: (sy * this.dpr - this.canvas.height / 2) / s + this.cam.y,
    };
  }

  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
  }

  pan(dxScreen, dyScreen) {
    const s = this.ppu / this.dpr;
    this.cam.x -= dxScreen / s;
    this.cam.y -= dyScreen / s;
  }

  worldTransform() {
    const cv = this.canvas;
    this.ctx.setTransform(this.ppu, 0, 0, this.ppu, cv.width / 2, cv.height / 2);
  }

  updateOverlay(F, key) {
    const f = F[key], o = OVERLAY[key];
    if (this.off.width !== F.gw) { this.off.width = F.gw; this.off.height = F.gh; this.img = null; }
    const octx = this.off.getContext('2d');
    if (!this.img) this.img = octx.createImageData(F.gw, F.gh);
    const d = this.img.data;
    for (let i = 0; i < F.n; i++) {
      const a = Math.min(1, f[i] / o.ref);
      d[i * 4] = o.rgb[0]; d[i * 4 + 1] = o.rgb[1]; d[i * 4 + 2] = o.rgb[2];
      d[i * 4 + 3] = Math.round(Math.sqrt(a) * 170);
    }
    octx.putImageData(this.img, 0, 0);
  }

  // ------------------------------------------------------------------- frame
  draw(world, opts) {
    if (this.lost) return;
    const ctx = this.ctx, cv = this.canvas, cw = cv.width, ch = cv.height;
    const ppu = this.ppu, cx = this.cam.x, cy = this.cam.y;
    this.frame++;
    this.time = opts.time ?? world.t;
    this.px = 1 / ppu;          // one device pixel, in world units
    this.pxnm = ppu * NM;       // device pixels per nanometre
    this.v = { x0: cx - cw / 2 / ppu, x1: cx + cw / 2 / ppu, y0: cy - ch / 2 / ppu, y1: cy + ch / 2 / ppu };

    // Ocean background (screen space so it stays exact at any zoom).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#02050a';
    ctx.fillRect(0, 0, cw, ch);
    const sx0 = cw / 2 - cx * ppu, sx1 = cw / 2 + (CFG.W - cx) * ppu;
    const sy0 = ch / 2 - cy * ppu, sy1 = ch / 2 + (CFG.H - cy) * ppu;
    const rx0 = Math.max(0, sx0), rx1 = Math.min(cw, sx1), ry0 = Math.max(0, sy0), ry1 = Math.min(ch, sy1);
    if (rx1 > rx0 && ry1 > ry0) {
      const g = ctx.createLinearGradient(0, sy0, 0, sy1);
      g.addColorStop(0, '#1b5d8c');
      g.addColorStop(0.35, '#0d3557');
      g.addColorStop(1, '#040a16');
      ctx.fillStyle = g;
      ctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
      const dark = 1 - Math.min(1, world.dayFactor * world.lightMul);
      if (dark > 0) { ctx.fillStyle = `rgba(0,0,8,${dark * 0.55})`; ctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0); }
      if (world.timers.snowball > 0) {
        const iy = Math.min(ry1, sy0 + 14 * ppu);
        if (iy > ry0) { ctx.fillStyle = 'rgba(220,240,255,0.55)'; ctx.fillRect(rx0, ry0, rx1 - rx0, iy - ry0); }
      }
    }

    this.worldTransform();
    if (opts.overlay !== 'none') {
      if (this.overlayKey !== opts.overlay || this.frame % 6 === 0) { this.updateOverlay(world.fields, opts.overlay); this.overlayKey = opts.overlay; }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.off, -cx, -cy, world.fields.gw * world.fields.cs, world.fields.gh * world.fields.cs);
    }

    this.drawVents(world);
    this.drawWater();
    this.prepFx(world);
    if (opts.showChem) this.drawChemistry(world);
    // Dividing cells are drawn emerging from the mother's position (a stretching peanut).
    const moved = [];
    for (const e of this.fxNow) {
      if (e.type !== 'divide' || e.mx === undefined) continue;
      const k = ease(Math.min(1, e.u * 1.6));
      for (const c of [e.a, e.b]) {
        if (c.dead) continue;
        c._dividing = true;
        moved.push([c, c.x, c.y]);
        c.x = e.mx + (c.x - e.mx) * (0.55 + 0.45 * k); c.y = e.my + (c.y - e.my) * (0.55 + 0.45 * k);
      }
    }
    this.drawFxUnder();
    this.drawLife(world, opts);
    this.drawViruses(world);
    this.drawFx(world);
    for (const [c, x, y] of moved) { c.x = x; c.y = y; c._dividing = false; }

    if (opts.selection) this.drawSelection(opts.selection);
    else if (opts.selected) this.drawSelection(opts.selected);
    if (opts.flash) {
      const f = opts.flash;
      ctx.fillStyle = `rgba(255,160,60,${f.a * 0.5})`;
      ctx.beginPath(); ctx.arc(f.x - cx, f.y - cy, 350 * (1.2 - f.a), 0, TAU); ctx.fill();
    }
    this.drawScaleBar();
  }

  // At molecular zoom the ocean is visibly made of water molecules (~0.3 nm apart), jiggling
  // with thermal motion. They are drawn procedurally, anchored to the world, so when you follow
  // something you can see the water stream past it. Frozen when paused.
  drawWater() {
    const pxnm = this.pxnm;
    if (pxnm < 18) return;
    const ctx = this.ctx, v = this.v, cx = this.cam.x, cy = this.cam.y;
    const g = 0.31 * NM;
    const i0 = Math.floor(v.x0 / g), i1 = Math.ceil(v.x1 / g), j0 = Math.floor(v.y0 / g), j1 = Math.ceil(v.y1 / g);
    if ((i1 - i0) * (j1 - j0) > 9000) return;
    const t = this.time;
    ctx.globalAlpha = Math.min(0.11, (pxnm - 18) / 120 + 0.04); // a quiet backdrop, not the subject
    const oR = 0.15 * NM, hR = 0.08 * NM, bond = 0.1 * NM;
    ctx.fillStyle = '#ff7a7a';
    const pos = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1);
        h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
        const r1 = (h & 1023) / 1023, r2 = ((h >>> 10) & 1023) / 1023, r3 = ((h >>> 20) & 1023) / 1023;
        const x = (i + 0.5 + (r1 - 0.5) * 0.7) * g + Math.sin(t * 0.9 + r2 * 40) * g * 0.15 - cx;
        const y = (j + 0.5 + (r2 - 0.5) * 0.7) * g + Math.cos(t * 0.8 + r1 * 40) * g * 0.15 - cy;
        pos.push(x, y, r3 * TAU + t * 0.3);
      }
    }
    ctx.beginPath();
    for (let k = 0; k < pos.length; k += 3) { ctx.moveTo(pos[k] + oR, pos[k + 1]); ctx.arc(pos[k], pos[k + 1], oR, 0, TAU); }
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let k = 0; k < pos.length; k += 3) {
      for (const da of [-0.91, 0.91]) { // H–O–H angle ≈ 104.5°
        const a = pos[k + 2] + da, x = pos[k] + Math.cos(a) * bond, y = pos[k + 1] + Math.sin(a) * bond;
        ctx.moveTo(x + hR, y); ctx.arc(x, y, hR, 0, TAU);
      }
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Circles can be millions of pixels across at molecular zoom, which GPUs handle badly (and can
  // lose the canvas over). Big ones are drawn as just their visible part. X, Y are camera-relative.
  bigDisk(X, Y, r) {
    const ctx = this.ctx, v = this.v;
    ctx.beginPath();
    if (r * this.ppu < 20000) { ctx.arc(X, Y, r, 0, TAU); return true; }
    const half = Math.hypot(v.x1 - v.x0, v.y1 - v.y0) / 2, d = Math.hypot(X, Y);
    if (d - half >= r) return false;                       // entirely off screen
    if (d + half <= r) {                                    // the screen is inside the disk
      ctx.rect(v.x0 - this.cam.x, v.y0 - this.cam.y, v.x1 - v.x0, v.y1 - v.y0);
      return true;
    }
    // The edge crosses the screen: a band along the visible stretch of the rim.
    const { mid, phi } = this.visibleArc(X, Y, r, d, half), rin = Math.max(0, r - 3 * half);
    for (let k = 0; k <= 64; k++) { const a = mid - phi + (2 * phi * k) / 64; ctx.lineTo(X + Math.cos(a) * r, Y + Math.sin(a) * r); }
    for (let k = 64; k >= 0; k--) { const a = mid - phi + (2 * phi * k) / 64; ctx.lineTo(X + Math.cos(a) * rin, Y + Math.sin(a) * rin); }
    ctx.closePath();
    return true;
  }

  bigRing(X, Y, r) {
    const ctx = this.ctx, v = this.v;
    ctx.beginPath();
    if (r * this.ppu < 20000) { ctx.arc(X, Y, r, 0, TAU); return true; }
    const half = Math.hypot(v.x1 - v.x0, v.y1 - v.y0) / 2, d = Math.hypot(X, Y);
    if (d - half >= r || d + half <= r) return false;       // rim not on screen
    const { mid, phi } = this.visibleArc(X, Y, r, d, half);
    for (let k = 0; k <= 64; k++) { const a = mid - phi + (2 * phi * k) / 64; ctx.lineTo(X + Math.cos(a) * r, Y + Math.sin(a) * r); }
    return true;
  }

  visibleArc(X, Y, r, d, half) {
    const mid = Math.atan2(-Y, -X); // from the circle's centre toward the screen centre
    const c = (r * r + d * d - half * half) / (2 * r * Math.max(d, 1e-12));
    const phi = c <= -1 ? Math.PI : Math.min(Math.PI, Math.acos(Math.min(1, c)) * 1.1 + 1e-4);
    return { mid, phi };
  }

  inView(x, y, m) {
    const v = this.v;
    return x + m >= v.x0 && x - m <= v.x1 && y + m >= v.y0 && y - m <= v.y1;
  }

  drawVents(world) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y;
    for (const v of world.vents) {
      const r = 70 * v.strength * (world.ventMul > 1 ? 1.6 : 1);
      if (!this.inView(v.x, CFG.H, r)) continue;
      const X = v.x - cx, Y = CFG.H - cy;
      if (r * this.ppu > 20000) {
        // Zoomed far in: the glow is effectively uniform across the screen.
        const d = Math.hypot(X, Y);
        if (d < r) { ctx.fillStyle = `rgba(255,140,50,${(0.55 * (1 - d / r)).toFixed(3)})`; ctx.fillRect(this.v.x0 - cx, this.v.y0 - cy, this.v.x1 - this.v.x0, this.v.y1 - this.v.y0); }
        continue;
      }
      const g = ctx.createRadialGradient(X, Y, 0, X, Y, r);
      g.addColorStop(0, 'rgba(255,150,60,0.55)');
      g.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(X - r, Y - r, r * 2, r);
      ctx.fillStyle = '#3a2416';
      ctx.beginPath();
      ctx.moveTo(X - 18, Y); ctx.lineTo(X - 5, Y - 22); ctx.lineTo(X + 5, Y - 22); ctx.lineTo(X + 18, Y);
      ctx.fill();
    }
  }

  // --------------------------------------------------------------- chemistry
  drawChemistry(world) {
    const ctx = this.ctx, soup = world.soup, cx = this.cam.x, cy = this.cam.y;
    const mx = soup.mx, my = soup.my, mt = soup.mt;
    const molecular = this.pxnm >= 2.5; // a 1 nm molecule covers a few pixels
    const m = 3 * NM;
    if (!molecular) {
      // Sub-pixel molecules are shown as single specks (never larger than ~1.3 px).
      const h = Math.max(0.5 * NM, 0.65 * this.px);
      for (let t = 0; t <= LIPID; t++) {
        ctx.fillStyle = MONO_COLORS[t];
        ctx.globalAlpha = t === LIPID ? 0.75 : 0.9;
        for (let i = 0; i < soup.n; i++) {
          if (mt[i] !== t || !this.inView(mx[i], my[i], m)) continue;
          ctx.fillRect(mx[i] - cx - h, my[i] - cy - h, 2 * h, 2 * h);
        }
      }
      ctx.globalAlpha = 1;
    } else {
      for (let i = 0; i < soup.n; i++) {
        if (!this.inView(mx[i], my[i], m)) continue;
        const j = this.jig(soup.mid[i]);
        this.drawMonomer(mx[i] + j.x, my[i] + j.y, mt[i], (soup.mid[i] * 2.399 + this.time * 0.04) % TAU); // tumbling
      }
    }

    for (const p of soup.polymers) {
      if (!this.inView(p.x, p.y, p.seq.length * DIM.ntRise * NM)) continue;
      const ang = this.freeAngle(p), j = this.jig(p._ph * 977, 0.6);
      p._rx = p.x + j.x; p._ry = p.y + j.y; // where it is drawn this frame
      if (p._peel) { const k = ease(p._peel.u); p._rx = p._peel.x + (p._rx - p._peel.x) * k; p._ry = p._peel.y + (p._ry - p._peel.y) * k; }
      this.drawPolymer(p, p._rx, p._ry, ang);
    }

    for (const ve of soup.vesicles) {
      if (!this.inView(ve.x, ve.y, ve.r)) continue;
      this.drawVesicle(ve, molecular);
    }
  }

  rngFor(seed) { return new RNG(seed); }

  // Drawing in a local frame measured in nanometres.
  nmFrame(x, y, ang) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x - this.cam.x, y - this.cam.y);
    ctx.rotate(ang);
    ctx.scale(NM, NM);
  }

  poly(x, y, r, n, rot) {
    const ctx = this.ctx;
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * TAU;
      if (k === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
  }

  // A nucleotide in the current nm frame, base pointing along +y.
  nucleotideShape(t, alpha = 1) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#cfc6b0';
    ctx.lineWidth = 0.08;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 0.7); ctx.stroke();
    // phosphate
    ctx.fillStyle = '#f4a259';
    ctx.beginPath(); ctx.arc(0, 0, 0.2, 0, TAU); ctx.fill();
    // ribose sugar
    ctx.fillStyle = '#e8e2d0';
    ctx.beginPath(); this.poly(0, 0.38, 0.22, 5, -Math.PI / 2); ctx.fill();
    // base: purines (A, G) have two fused rings, pyrimidines (U, C) one
    ctx.fillStyle = MONO_COLORS[t];
    ctx.beginPath();
    if (t === 0 || t === 2) { this.poly(-0.14, 0.92, 0.25, 6, 0); this.poly(0.27, 0.86, 0.2, 5, 0.3); }
    else this.poly(0, 0.9, 0.25, 6, 0);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawMonomer(x, y, t, ang) {
    const ctx = this.ctx;
    this.nmFrame(x, y, ang);
    if (t === LIPID) {
      // Fatty acid: polar head + hydrophobic hydrocarbon tail.
      ctx.fillStyle = '#efe6c4';
      ctx.beginPath(); ctx.arc(0, 0, DIM.lipidHead, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#c9b98a'; ctx.lineWidth = 0.13;
      ctx.beginPath(); ctx.moveTo(0, DIM.lipidHead);
      for (let k = 1; k <= 8; k++) ctx.lineTo((k & 1 ? 0.1 : -0.1), DIM.lipidHead + (k / 8) * DIM.lipidTail);
      ctx.stroke();
    } else {
      this.nucleotideShape(t);
    }
    const label = this.pxnm >= 16 && t !== LIPID ? ctx.getTransform().transformPoint({ x: 0, y: 0.9 }) : null;
    ctx.restore();
    if (label) this.screenText(BASES[t], label.x, label.y);
  }

  screenText(text, x, y, size = 11) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `600 ${size * this.dpr}px system-ui`;
    ctx.fillStyle = '#0a0f18';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // Nucleotide positions (nm) for a chain: active ribozymes fold into a hairpin.
  layout(p) {
    const L = p.seq.length, fold = p.act > 0 && L >= 8;
    const key = L * 2 + (fold ? 1 : 0);
    if (p._lay && p._lay.key === key) return p._lay;
    const R = DIM.ntRise, pts = [], pairs = [];
    if (!fold) {
      for (let i = 0; i < L; i++) pts.push([(i - (L - 1) / 2) * R, Math.sin(i * 0.6) * 0.35, 0, 1]);
    } else {
      const h = Math.floor((L - 3) / 2), loop = L - 2 * h, off = ((h - 1) * R) / 2;
      const arr = new Array(L);
      for (let i = 0; i < h; i++) {
        arr[i] = [i * R - off, 1.15, 0, -1];
        arr[L - 1 - i] = [i * R - off, -1.15, 0, 1];
        pairs.push([i, L - 1 - i]);
      }
      const xe = (h - 1) * R - off + 0.25;
      for (let k = 0; k < loop; k++) {
        const th = Math.PI / 2 - (Math.PI * (k + 1)) / (loop + 1);
        const c = Math.cos(th), s = Math.sin(th);
        arr[h + k] = [xe + 1.4 * c, 1.15 * s, -c, -s];
      }
      for (const a of arr) pts.push(a);
    }
    let minX = Infinity, maxX = -Infinity;
    for (const q of pts) { if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0]; }
    p._lay = { key, pts, pairs, extent: maxX - minX + 1.5 };
    return p._lay;
  }

  // Where a strand inside a protocell is right now. It wanders gently as a function of simulation
  // time only, and main.js calls this before aiming the camera so following it is steady.
  placeInternal(p, ve) {
    if (p._fx === undefined) {
      const a = Math.random() * TAU, rr = Math.sqrt(Math.random()) * 0.8;
      p._fx = Math.cos(a) * rr; p._fy = Math.sin(a) * rr; p._fa = Math.random() * TAU; p._ph = Math.random() * TAU;
    }
    const inner = ve.r - DIM.bilayer * NM, t = this.time, w = (2 * NM) / inner;
    const fx = p._fx + Math.sin(t * 0.031 + p._ph) * w, fy = p._fy + Math.cos(t * 0.027 + p._ph * 1.7) * w;
    p._drawFa = p._fa + Math.sin(t * 0.013 + p._ph) * 0.6;
    p._bx = ve.x + p._fx * inner; p._by = ve.y + p._fy * inner; // its home spot in the protocell
    const j = this.jig(p._ph * 977, 0.6);
    p.x = p._rx = ve.x + fx * inner + j.x; p.y = p._ry = ve.y + fy * inner + j.y;
  }

  // ------------------------------------------------------------- event animations
  // Events from the simulation (world.fx) play out over a few dozen ticks of simulation time, so
  // they are visible at slow speeds and freeze when paused.
  prepFx(world) {
    this.fxNow = [];
    for (const e of world.fx) {
      const u = (this.time - e.t) / e.dur;
      if (u < 0 || u > 1) {
        if (e.type === 'peel' && e.kid._peel === e) e.kid._peel = null;
        if (e.type === 'copy' && e.p._copyFx === e) e.p._copyFx = null;
        continue;
      }
      e.u = u;
      this.fxNow.push(e);
      if (e.type === 'peel') e.kid._peel = e;
      if (e.type === 'copy') e.p._copyFx = e;
    }
  }

  // Pinching waists for dividing cells and vesicles, drawn beneath them so only the narrowing
  // bridge between the two daughters shows.
  drawFxUnder() {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y;
    for (const e of this.fxNow) {
      if (e.type !== 'divide' && e.type !== 'vsplit') continue;
      const a = e.a, b = e.b;
      if (a.dead || b.dead || !this.inView(a.x, a.y, a.r * 3) || a.r * this.ppu < 2) continue;
      const k = ease(e.u), ra = a.r * 0.92, rb = b.r * 0.92;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, nx = -uy, ny = ux;
      const waist = Math.min(ra, rb) * 0.95 * (1 - k); // narrows to nothing as the daughters part
      if (waist <= 0) continue;
      const mx = (a.x + b.x) / 2 - cx, my = (a.y + b.y) / 2 - cy;
      // Only the gap outside both daughters (they are translucent, so the bridge must not show through).
      ctx.save();
      const v = this.v, vr = [v.x0 - cx, v.y0 - cy, v.x1 - v.x0, v.y1 - v.y0];
      for (const o of [a, b]) {
        const clip = new Path2D();
        clip.rect(...vr);
        clip.arc(o.x - cx, o.y - cy, o.r, 0, TAU);
        ctx.clip(clip, 'evenodd');
      }
      ctx.beginPath();
      ctx.moveTo(a.x - cx + nx * ra, a.y - cy + ny * ra);
      ctx.quadraticCurveTo(mx + nx * waist, my + ny * waist, b.x - cx + nx * rb, b.y - cy + ny * rb);
      ctx.lineTo(b.x - cx - nx * rb, b.y - cy - ny * rb);
      ctx.quadraticCurveTo(mx - nx * waist, my - ny * waist, a.x - cx - nx * ra, a.y - cy - ny * ra);
      ctx.closePath();
      if (e.type === 'divide') {
        ctx.restore(); ctx.save(); // the body is one shape, so no clip: both daughters + the waist
        const body = new Path2D();
        // Wind the waist the same way as the arcs (nonzero fill), so the three pieces merge into one body.
        const P = [[a.x - cx + nx * ra, a.y - cy + ny * ra], [mx + nx * waist, my + ny * waist], [b.x - cx + nx * rb, b.y - cy + ny * rb],
          [b.x - cx - nx * rb, b.y - cy - ny * rb], [mx - nx * waist, my - ny * waist], [a.x - cx - nx * ra, a.y - cy - ny * ra]];
        const quad = [P[0], P[2], P[3], P[5]];
        let area = 0;
        for (let i = 0; i < 4; i++) { const [x1, y1] = quad[i], [x2, y2] = quad[(i + 1) % 4]; area += x1 * y2 - x2 * y1; }
        const W = area > 0 ? P : [...P].reverse();
        body.moveTo(...W[0]); body.quadraticCurveTo(...W[1], ...W[2]); body.lineTo(...W[3]); body.quadraticCurveTo(...W[4], ...W[5]); body.closePath();
        body.moveTo(a.x - cx + a.r, a.y - cy); body.arc(a.x - cx, a.y - cy, a.r, 0, TAU);
        body.moveTo(b.x - cx + b.r, b.y - cy); body.arc(b.x - cx, b.y - cy, b.r, 0, TAU);
        ctx.fillStyle = a.trophColor;
        ctx.globalAlpha = 0.35 + 0.65 * Math.max(0.15, Math.min(1, a.energy / a.cap));
        ctx.fill(body, 'nonzero');
        ctx.globalAlpha = 1;
        ctx.restore();
        continue;
      }
      ctx.strokeStyle = e.type === 'divide' ? 'rgba(255,255,255,0.35)' : 'rgba(245,232,180,0.9)';
      ctx.lineWidth = Math.max(DIM.bilayer * NM, this.px);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawFx(world) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y, px = this.px;
    for (const e of this.fxNow) {
      const u = e.u, k = ease(u);
      switch (e.type) {
        case 'divide': break; // drawn underneath the cells (drawFxUnder)
        case 'engulf': {
          // Phagocytosis: the prey is pulled into the predator inside a food vacuole.
          const p = e.pred, q = e.prey;
          if (p.dead || !this.inView(p.x, p.y, p.r * 3)) break;
          const x = q.x + (p.x - q.x) * k, y = q.y + (p.y - q.y) * k, r = q.r * (1 - 0.55 * k);
          if (r * this.ppu < 1) break;
          ctx.globalAlpha = 1 - 0.6 * u;
          ctx.fillStyle = e.endo && u > 0.5 ? '#ff9a76' : q.col;
          ctx.beginPath(); ctx.arc(x - cx, y - cy, r, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = Math.max(8 * NM, px);
          ctx.beginPath(); ctx.arc(x - cx, y - cy, r * 1.15, 0, TAU); ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'die': {
          // The cell shrivels and its contents leak away.
          const c = e.cell;
          if (!this.inView(c.x, c.y, c.r * 3) || c.r * this.ppu < 1) break;
          ctx.globalAlpha = 0.7 * (1 - u);
          ctx.fillStyle = c.col;
          ctx.beginPath(); ctx.arc(c.x - cx, c.y - cy, c.r * (1 - 0.45 * k), 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(170,130,90,1)';
          for (let i = 0; i < 14; i++) { const a = i * 2.4 + c.id, rr = c.r * (0.5 + 1.6 * k); ctx.beginPath(); ctx.arc(c.x - cx + Math.cos(a) * rr, c.y - cy + Math.sin(a) * rr, Math.max(c.r * 0.06, px), 0, TAU); ctx.fill(); }
          ctx.globalAlpha = 1;
          break;
        }
        case 'burst': {
          // Lysis: the membrane tears into fragments flying outward.
          const c = e.cell;
          if (!this.inView(c.x, c.y, c.r * 4) || c.r * this.ppu < 1) break;
          ctx.globalAlpha = 1 - u;
          ctx.fillStyle = c.col;
          ctx.globalAlpha = 0.4 * (1 - u);
          ctx.beginPath(); ctx.arc(c.x - cx, c.y - cy, c.r * (1 + 0.4 * k), 0, TAU); ctx.fill();
          ctx.globalAlpha = 1 - u;
          ctx.strokeStyle = 'rgba(240,235,215,0.95)';
          ctx.lineWidth = Math.max(DIM.bilayer * NM * 2, px);
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * TAU + c.id, rr = c.r * (1 + 1.6 * k);
            ctx.beginPath(); ctx.arc(c.x - cx, c.y - cy, rr, a, a + 0.35 - 0.2 * k); ctx.stroke();
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'inject': {
          // A virus docks on the membrane, its tail contracts, and its genome snakes inside.
          const c = e.cell;
          if (c.dead || !this.inView(c.x, c.y, c.r * 2)) break;
          if (e.ox === undefined) { e.ox = e.x - c.x; e.oy = e.y - c.y; }
          const d = Math.hypot(e.ox, e.oy) || 1, ux = e.ox / d, uy = e.oy / d;
          const x = c.x + ux * (c.r + 0.25), y = c.y + uy * (c.r + 0.25);
          if (DIM.virus * NM * this.ppu < 1.5) break;
          this.drawVirus(x, y, Math.atan2(-uy, -ux) - Math.PI / 2);
          ctx.strokeStyle = 'rgba(255,209,102,0.9)';
          ctx.lineWidth = Math.max(DIM.dna * NM, 0.7 * px);
          ctx.beginPath();
          const len = c.r * 0.6 * k;
          for (let s2 = 0; s2 <= 20; s2++) { const t2 = (s2 / 20) * len, w2 = Math.sin(t2 * 8) * 0.05; ctx.lineTo(c.x + ux * (c.r - t2) - uy * w2 - cx, c.y + uy * (c.r - t2) + ux * w2 - cy); }
          ctx.stroke();
          break;
        }
        case 'vsplit': break; // drawn underneath (drawFxUnder)
        case 'vsplit-old': {
          const a = e.a, b = e.b;
          if (a.dead || b.dead || !this.inView(a.x, a.y, a.r * 3) || a.r * this.ppu < 2) break;
          const w = Math.min(a.r, b.r) * 0.9 * (1 - k), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
          if (w <= 0) break;
          ctx.strokeStyle = 'rgba(245,232,180,0.9)';
          ctx.lineWidth = Math.max(DIM.bilayer * NM, px);
          ctx.beginPath();
          ctx.moveTo(a.x - cx + nx * w, a.y - cy + ny * w); ctx.lineTo(b.x - cx + nx * w, b.y - cy + ny * w);
          ctx.moveTo(a.x - cx - nx * w, a.y - cy - ny * w); ctx.lineTo(b.x - cx - nx * w, b.y - cy - ny * w);
          ctx.stroke();
          break;
        }
        case 'vform': {
          // Lipids drift together and close up into a bubble.
          const v = e.v;
          if (!this.inView(v.x, v.y, v.r * 3)) break;
          ctx.fillStyle = MONO_COLORS[LIPID];
          const h = Math.max(1 * NM, 0.8 * px);
          e.pts.forEach(([x0, y0], i) => {
            const a = (i / e.pts.length) * TAU, tx = v.x + Math.cos(a) * v.r, ty = v.y + Math.sin(a) * v.r;
            ctx.fillRect(x0 + (tx - x0) * k - cx - h, y0 + (ty - y0) * k - cy - h, 2 * h, 2 * h);
          });
          break;
        }
        case 'abio': {
          // A protocell becomes a living cell: a pulse of light as its machinery switches on.
          const c = e.cell;
          if (c.dead || !this.inView(c.x, c.y, c.r * 6)) break;
          ctx.globalAlpha = 1 - u;
          ctx.strokeStyle = '#ffe58a';
          ctx.lineWidth = Math.max(c.r * 0.15, px * 2);
          ctx.beginPath(); ctx.arc(c.x - cx, c.y - cy, c.r * (1 + 3 * k), 0, TAU); ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'join': {
          // A nucleotide glides onto the end of the growing strand.
          if (this.pxnm < 2.5) break;
          const p = e.p;
          if (p.dead || !this.inView(p._rx ?? p.x, p._ry ?? p.y, 0.05)) break;
          const lay = this.layout(p), q = lay.pts[lay.pts.length - 1], ang = p._drawAng ?? p.ang;
          const ex = (p._rx ?? p.x) + (q[0] * Math.cos(ang) - q[1] * Math.sin(ang)) * NM, ey = (p._ry ?? p.y) + (q[0] * Math.sin(ang) + q[1] * Math.cos(ang)) * NM;
          const x = e.x + (ex - e.x) * k, y = e.y + (ey - e.y) * k;
          if (this.inView(x, y, 3 * NM)) this.drawMonomer(x, y, e.b, ang + (1 - k) * 2);
          break;
        }
      }
    }
  }

  // Thermal jiggle (drawing only): a smooth few-tenths-of-a-nanometre wobble, so molecules look alive
  // even when the camera is holding them still. Depends only on sim time.
  jig(seed, ampNm = 0.4) {
    const t = this.time, a = ampNm * NM;
    return {
      x: (Math.sin(t * 0.27 + seed) + 0.5 * Math.sin(t * 0.71 + seed * 1.7)) * a,
      y: (Math.cos(t * 0.31 + seed * 0.6) + 0.5 * Math.sin(t * 0.59 + seed * 2.3)) * a,
    };
  }

  // Free strands turn slowly and smoothly on screen (the simulation's Brownian angle jumps every tick
  // and is not used for anything physical).
  freeAngle(p) {
    if (p._ph === undefined) p._ph = Math.random() * TAU;
    const t = this.time;
    return p._ph + Math.sin(t * 0.011 + p._ph) * 1.5 + t * 0.004;
  }

  drawPolymer(p, x, y, ang) {
    const ctx = this.ctx, lay = this.layout(p), seq = p.seq;
    p._drawAng = ang;
    const color = p.act > 0 ? `hsl(305,90%,${55 + p.act * 25}%)` : 'rgba(180,195,205,0.85)';
    const lenPx = lay.extent * this.pxnm;
    if (lenPx < 3) {
      const h = Math.max((lay.extent * NM) / 2, 0.75 * this.px);
      ctx.fillStyle = color;
      ctx.fillRect(x - this.cam.x - h, y - this.cam.y - h, 2 * h, 2 * h);
      return;
    }
    this.nmFrame(x, y, ang);
    const pts = lay.pts;
    if (this.pxnm < 4) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 1.4 / this.pxnm);
      ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.stroke();
      ctx.restore();
      return;
    }
    // Sugar–phosphate backbone.
    ctx.strokeStyle = p.act > 0 ? '#ff9de8' : '#f4a259';
    ctx.lineWidth = 0.22;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    ctx.stroke();
    // Watson–Crick hydrogen bonds holding the hairpin stem.
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 0.07;
    ctx.setLineDash([0.12, 0.1]);
    ctx.beginPath();
    for (const [i, j] of lay.pairs) {
      const a = seq[i], b = seq[j];
      if (!((a === 0 && b === 1) || (a === 1 && b === 0) || (a === 2 && b === 3) || (a === 3 && b === 2))) continue;
      ctx.moveTo(pts[i][0], pts[i][1] + pts[i][3] * 1.1);
      ctx.lineTo(pts[j][0], pts[j][1] + pts[j][3] * 1.1);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const labels = [];
    const wantLabels = this.pxnm >= 16;
    for (let i = 0; i < pts.length; i++) {
      const [qx, qy, dx, dy] = pts[i];
      ctx.save();
      ctx.translate(qx, qy);
      ctx.rotate(Math.atan2(dy, dx) - Math.PI / 2);
      this.nucleotideShape(seq[i]);
      if (wantLabels) labels.push([seq[i], ctx.getTransform().transformPoint({ x: 0, y: 0.9 })]);
      ctx.restore();
    }
    // The daughter strand being assembled base by base on the template.
    if (p.copy && p.prog > 0) {
      for (let i = 0; i < p.prog && i < pts.length; i++) {
        const [qx, qy, dx, dy] = pts[i];
        let tx = qx - dx * 0.45, ty = qy - dy * 0.45;
        const f = p._copyFx;
        if (f && f.i === i) {
          // The newest nucleotide glides in from where it was and pairs with the template.
          const k = ease(f.u), wx = (f.x - x) / NM, wy = (f.y - y) / NM, ca = Math.cos(-ang), sa = Math.sin(-ang);
          const lx = wx * ca - wy * sa, ly = wx * sa + wy * ca;
          tx = lx + (tx - lx) * k; ty = ly + (ty - ly) * k;
        }
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(Math.atan2(-dy, -dx) - Math.PI / 2);
        this.nucleotideShape(p.copy[i], 0.55);
        ctx.restore();
      }
    }
    ctx.restore();
    for (const [t, pt] of labels) this.screenText(BASES[t], pt.x, pt.y, 10);
  }

  drawVesicle(ve, molecular) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y, rp = ve.r * this.ppu;
    const alive = ve.polys.some((p) => p.act > 0);
    const X = ve.x - cx, Y = ve.y - cy;
    if (rp < 1.5) {
      ctx.fillStyle = alive ? '#ffb3f0' : '#f5e6aa';
      const h = Math.max(ve.r, 0.75 * this.px);
      ctx.fillRect(X - h, Y - h, 2 * h, 2 * h);
      return;
    }
    ctx.fillStyle = alive ? 'rgba(255,120,230,0.12)' : 'rgba(255,240,190,0.06)';
    if (this.bigDisk(X, Y, ve.r)) ctx.fill();
    this.drawBilayer(ve.x, ve.y, ve.r, alive ? 'rgba(255,190,245,0.95)' : 'rgba(245,232,180,0.95)', alive ? 'rgba(255,170,240,0.35)' : 'rgba(235,215,160,0.35)');
    if (rp < 6) return;
    // Contents, at true size inside the membrane.
    const inner = ve.r - DIM.bilayer * NM;
    for (const p of ve.polys) {
      this.placeInternal(p, ve);
      if (this.inView(p.x, p.y, 0.05)) this.drawPolymer(p, p.x, p.y, p._drawFa);
    }
    if (molecular) {
      // Free nucleotides waiting in the protocell's internal pool.
      for (let t = 0; t < 4; t++) {
        const n = Math.min(ve.pool[t], 40);
        for (let k = 0; k < n; k++) {
          const r = new RNG((ve.id * 7919 + t * 131 + k * 17) >>> 0);
          const a = r.next() * TAU, rr = Math.sqrt(r.next()) * 0.85;
          const px = ve.x + Math.cos(a) * rr * inner, py = ve.y + Math.sin(a) * rr * inner;
          if (this.inView(px, py, 3 * NM)) this.drawMonomer(px, py, t, r.next() * TAU + this.time * 0.03);
        }
      }
    }
  }

  // A lipid bilayer of radius R; individual lipids are drawn once they are resolvable,
  // and only along the arc that is on screen.
  drawBilayer(x, y, R, head, tail, twoTails = false, cell = null) {
    const ctx = this.ctx, v = this.v, t = DIM.bilayer * NM;
    const X = x - this.cam.x, Y = y - this.cam.y;
    if (DIM.lipidSpacing * this.pxnm < 2.5) {
      ctx.strokeStyle = head;
      ctx.lineWidth = Math.max(t, 1.1 * this.px);
      if (this.bigRing(X, Y, Math.max(0, R - t / 2))) ctx.stroke();
      return;
    }
    const vcx = (v.x0 + v.x1) / 2, vcy = (v.y0 + v.y1) / 2, h = Math.hypot(v.x1 - v.x0, v.y1 - v.y0) / 2;
    const d = Math.hypot(vcx - x, vcy - y);
    if (d > R + h || d + h < R - t) return;
    const mid = Math.atan2(vcy - y, vcx - x);
    let phi = Math.PI;
    if (d > 1e-12) {
      const arcCos = (r) => (r > 0 ? (r * r + d * d - h * h) / (2 * r * d) : -1);
      const c = Math.min(arcCos(R), arcCos(R - t));
      if (c > -1) phi = Math.min(Math.PI, Math.acos(Math.min(1, c)) * 1.05 + 0.002);
    }
    // Hydrophobic core.
    ctx.strokeStyle = tail;
    ctx.lineWidth = t * 0.55;
    ctx.beginPath(); ctx.arc(X, Y, R - t / 2, mid - phi, mid + phi); ctx.stroke();
    const da = (DIM.lipidSpacing * NM) / R;
    const n = Math.min(8000, Math.ceil((2 * phi) / da));
    const hr = DIM.lipidHead * NM, ro = R - hr, ri = R - t + hr;
    ctx.fillStyle = head;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const a = mid - phi + k * da, b = a + da / 2;
      const wob = Math.sin(this.time * 0.6 + k * 1.37) * 0.12 * NM; // thermal wiggle
      const ox = X + Math.cos(a) * (ro + wob), oy = Y + Math.sin(a) * (ro + wob);
      const ix = X + Math.cos(b) * (ri - wob), iy = Y + Math.sin(b) * (ri - wob);
      ctx.moveTo(ox + hr, oy); ctx.arc(ox, oy, hr, 0, TAU);
      ctx.moveTo(ix + hr, iy); ctx.arc(ix, iy, hr, 0, TAU);
    }
    ctx.fill();
    if (cell) {
      // Proteins set into the membrane (channels, pumps, transporters, receptors, ATP synthase).
      const sp = membraneProteinSpacing(R), k0 = Math.floor((mid - phi) / sp), k1 = Math.ceil((mid + phi) / sp);
      for (let k = k0; k <= k1; k++) {
        const pr = membraneProteinAt(cell, ((k % 100000) + 100000) % 100000);
        if (!pr) continue;
        const th = k * sp, w = pr.size * NM, hgt = t + 3 * NM, rc = R - t / 2;
        ctx.save();
        ctx.translate(X + Math.cos(th) * rc, Y + Math.sin(th) * rc);
        ctx.rotate(th);
        ctx.fillStyle = pr.name === 'ATP synthase' ? 'rgba(255,220,110,0.95)' : pr.name === 'Receptor' ? 'rgba(255,140,200,0.95)' : 'rgba(140,200,255,0.95)';
        ctx.beginPath(); ctx.ellipse(0, 0, hgt / 2, w / 2, 0, 0, TAU); ctx.fill();
        if (pr.name === 'ATP synthase' && this.pxnm >= 15) {
          // The rotor spins as protons flow through it.
          ctx.strokeStyle = 'rgba(120,80,20,0.9)'; ctx.lineWidth = 0.4 * NM;
          const sa = this.time * 0.9 + k;
          ctx.beginPath(); ctx.moveTo(-Math.cos(sa) * w * 0.35, -Math.sin(sa) * w * 0.35); ctx.lineTo(Math.cos(sa) * w * 0.35, Math.sin(sa) * w * 0.35); ctx.stroke();
        }
        ctx.restore();
      }
    }
    if (this.pxnm >= 7) {
      ctx.strokeStyle = 'rgba(210,190,130,0.8)';
      ctx.lineWidth = 0.13 * NM;
      ctx.beginPath();
      const tl = DIM.lipidTail * NM;
      for (let k = 0; k <= n; k++) {
        const a = mid - phi + k * da, b = a + da / 2;
        // Phospholipids have two tails; prebiotic fatty acids have one.
        const offs = twoTails ? [-0.22 * NM / R, 0.22 * NM / R] : [0];
        for (const o of offs) {
          const c1 = Math.cos(a + o), s1 = Math.sin(a + o), c2 = Math.cos(b + o), s2 = Math.sin(b + o);
          ctx.moveTo(X + c1 * (ro - hr), Y + s1 * (ro - hr)); ctx.lineTo(X + c1 * (ro - hr - tl), Y + s1 * (ro - hr - tl));
          ctx.moveTo(X + c2 * (ri + hr), Y + s2 * (ri + hr)); ctx.lineTo(X + c2 * (ri + hr + tl), Y + s2 * (ri + hr + tl));
        }
      }
      ctx.stroke();
    }
  }

  // -------------------------------------------------------------------- life
  cellColor(c, mode) {
    if (mode === 'species') return c.hueColor;
    if (mode === 'type') return c.orgSize > 1 ? TYPE_COLORS[c.type] : '#5d6878';
    return c.trophColor;
  }

  drawLife(world, opts) {
    const ctx = this.ctx, cells = world.life.cells, ppu = this.ppu, cx = this.cam.x, cy = this.cam.y, px = this.px;
    let detailed = 0;
    const focus = opts.focusOrg || 0;
    // Flagella first, so they trail behind every cell rather than across neighbours.
    for (const c of cells) {
      if (c.r * ppu > 2 && this.inView(c.x, c.y, c.r * 6)) {
        ctx.globalAlpha = focus && c.org !== focus ? 0.15 : 1;
        if (c.motil > 0.3) this.drawFlagellum(c, this.time);
        if (!c.mito && c.r * ppu > 14) this.drawPili(c);
      }
    }
    ctx.globalAlpha = 1;
    for (const c of cells) {
      if (!this.inView(c.x, c.y, c.r * 6)) continue;
      const X = c.x - cx, Y = c.y - cy, rp = c.r * ppu;
      const col = this.cellColor(c, opts.colorMode);
      const dim = focus && c.org !== focus; // spotlight one organism
      if (rp < 1.2) {
        ctx.fillStyle = col;
        ctx.globalAlpha = dim ? 0.2 : 1;
        ctx.fillRect(X - px, Y - px, 2 * px, 2 * px);
        ctx.globalAlpha = 1;
        continue;
      }
      if (dim) {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = col;
        if (this.bigDisk(X, Y, c.r)) ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }
      const fill = 0.35 + 0.65 * Math.max(0.15, Math.min(1, c.energy / c.cap));
      ctx.globalAlpha = c._dividing ? 0 : rp > 14 ? Math.max(0.85, fill) : fill; // close up, cytoplasm is opaque
      ctx.fillStyle = col;
      if (this.bigDisk(X, Y, c.r)) ctx.fill();
      ctx.globalAlpha = 1;
      if (rp > 14 && detailed < 120) { detailed++; this.drawCellInterior(c); }
      else if (c.mito && rp > 3) {
        ctx.fillStyle = 'rgba(30,20,60,0.75)';
        ctx.beginPath(); ctx.arc(X, Y, c.r * 0.34, 0, TAU); ctx.fill();
      }
      // Cell wall / pellicle (thicker when armored).
      const armor = c.armor * (c.type === 4 ? 3 : 1);
      if (armor > 0.15) {
        const wall = (20 + armor * 80) * NM;
        if (this.pxnm >= 1.5) this.drawWallMesh(c, wall);
        else {
          ctx.strokeStyle = 'rgba(205,165,105,0.85)';
          ctx.lineWidth = Math.max(wall, px);
          if (this.bigRing(X, Y, c.r + wall / 2)) ctx.stroke();
        }
      }
      if (c._dividing) { /* outline belongs to the shared body while pinching */ }
      else if (DIM.bilayer * this.pxnm >= 1.5) this.drawBilayer(c.x, c.y, c.r, 'rgba(240,235,215,0.95)', 'rgba(230,210,160,0.45)', true, c);
      else if (rp > 3 || c.mito) {
        ctx.strokeStyle = c.mito ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = Math.max(DIM.bilayer * NM, px * (c.mito ? 1.2 : 0.8));
        if (this.bigRing(X, Y, c.r)) ctx.stroke();
      }
    }
    this.drawBonds(cells);
  }

  drawFlagellum(c, t) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y;
    // Bacterial flagella are ~20 nm thick and several µm long, beating as a helix; eukaryotic ones ~250 nm.
    ctx.strokeStyle = 'rgba(220,235,255,0.4)';
    ctx.lineWidth = Math.max((c.mito ? 250 : DIM.flagellum) * NM, 0.8 * this.px);
    ctx.beginPath();
    flagellumPath(c, t).forEach((q, k) => (k ? ctx.lineTo(q.x - cx, q.y - cy) : ctx.moveTo(q.x - cx, q.y - cy)));
    ctx.stroke();
  }

  drawPili(c) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y;
    ctx.strokeStyle = 'rgba(230,240,200,0.45)';
    ctx.lineWidth = Math.max(7 * NM, 0.6 * this.px); // pili are ~7 nm thick
    ctx.beginPath();
    for (const l of piliLines(c, this.anatomy(c))) { ctx.moveTo(l.x1 - cx, l.y1 - cy); ctx.lineTo(l.x2 - cx, l.y2 - cy); }
    ctx.stroke();
  }

  // Procedural anatomy (shared with the inspector): see anatomy.js.
  anatomy(c) { return buildAnatomy(c); }

  drawCellInterior(c) {
    const ctx = this.ctx, a = this.anatomy(c), ppu = this.ppu, px = this.px;
    const X = c.x - this.cam.x, Y = c.y - this.cam.y, r = c.r, cx = this.cam.x, cy = this.cam.y;
    const line = (w) => Math.max(w * NM, 0.8 * px);
    const big = (units) => units * ppu > 1.5; // worth drawing at this zoom
    // Ribosomes (~22 nm): the protein factories filling the cytoplasm.
    const rib = (DIM.ribosome * NM) / 2;
    const drawRibos = (pts, seedBase) => {
      if (rib * 2 * ppu < 0.8) return;
      if (rib * 2 * ppu >= 40) {
        // Close enough to see the machinery: draw each on-screen ribosome as a molecular model.
        pts.forEach((q, k) => { if (this.inView(q.x, q.y, rib * 3)) this.drawRibosomeModel(q.x, q.y, seedBase + k, c.mito, c); });
        return;
      }
      const rr = Math.max(rib, 0.5 * px);
      ctx.fillStyle = 'rgba(30,20,50,0.55)';
      ctx.beginPath();
      for (const q of pts) { ctx.moveTo(q.x - cx + rr, q.y - cy); ctx.arc(q.x - cx, q.y - cy, rr, 0, TAU); }
      ctx.fill();
      if (rib * 2 * ppu > 12) {
        ctx.fillStyle = 'rgba(120,100,160,0.7)';
        ctx.beginPath();
        for (const q of pts) { const x = q.x - cx + rib * 0.5, y = q.y - cy - rib * 0.5; ctx.moveTo(x + rib * 0.6, y); ctx.arc(x, y, rib * 0.6, 0, TAU); }
        ctx.fill();
      }
    };
    const free = [];
    for (let k = 0; k < a.ribo.length; k += 2) free.push({ x: c.x + a.ribo[k] * r, y: c.y + a.ribo[k + 1] * r });
    drawRibos(free, c.id * 4099);
    const blob = (fx, fy, rad, fill, stroke) => {
      ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(X + fx * r, Y + fy * r, rad, 0, TAU); ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = line(7); ctx.stroke(); }
    };

    if (!c.mito) {
      if (a.thyl) {
        ctx.strokeStyle = 'rgba(60,200,90,0.65)';
        ctx.lineWidth = line(10);
        for (const f of [0.8, 0.72, 0.64]) if (this.bigRing(X, Y, r * f)) ctx.stroke();
      }
      // Carboxysomes (~120 nm protein shells packed with the CO2-fixing enzyme RuBisCO).
      for (const g of a.carbox) if (big(0.24)) { ctx.fillStyle = 'rgba(120,200,120,0.8)'; ctx.beginPath(); this.poly(X + g.fx * r, Y + g.fy * r, 60 * NM * g.s, 6, g.ang); ctx.fill(); }
      // Storage granules.
      for (const g of a.granules) if (big(0.2)) blob(g.fx, g.fy, 50 * NM * g.s, 'rgba(240,230,190,0.55)');
      // Plasmids: small rings of DNA.
      for (const pl of a.plasmids) {
        if (!big(0.4)) continue;
        ctx.strokeStyle = c.dna ? 'rgba(225,235,255,0.75)' : 'rgba(255,150,220,0.75)';
        ctx.lineWidth = line(DIM.dna);
        ctx.beginPath(); ctx.ellipse(X + pl.fx * r, Y + pl.fy * r, 100 * NM, 70 * NM, pl.ang, 0, TAU); ctx.stroke();
      }
      this.drawGenome(c, a.dna, c.x, c.y, r, c.dna ? 'dna' : 'rna');
      this.drawGeneActivity(c, a.dna, c.x, c.y, r);
      this.drawInfection(c);
      return;
    }
    // Microtubules radiating from the centrosome (25 nm tubes of tubulin).
    ctx.strokeStyle = 'rgba(160,220,255,0.35)';
    ctx.lineWidth = line(25);
    ctx.beginPath();
    for (const m of microtubules(c, a, this.time)) { ctx.moveTo(m.x1 - cx, m.y1 - cy); ctx.lineTo(m.x2 - cx, m.y2 - cy); }
    ctx.stroke();
    if (25 * NM * ppu > 6) this.drawTubulin(c, a);
    // Endoplasmic reticulum, studded with ribosomes (rough ER).
    ctx.strokeStyle = 'rgba(190,170,230,0.35)';
    ctx.lineWidth = line(50);
    for (const e of a.er) { ctx.beginPath(); ctx.arc(X, Y, e.rr * r, e.a0, e.a0 + e.span); ctx.stroke(); }
    if (rib * 2 * ppu >= 0.8) drawRibos(erRibosomes(c, a), c.id * 4099 + 100000);
    // Golgi apparatus: a stack of flattened cisternae, budding transport vesicles.
    ctx.strokeStyle = 'rgba(255,200,120,0.85)';
    ctx.lineWidth = line(30);
    for (const cis of golgiCisternae(c, a)) {
      ctx.beginPath();
      cis.pts.forEach((q, i) => (i ? ctx.lineTo(q.x - cx, q.y - cy) : ctx.moveTo(q.x - cx, q.y - cy)));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,200,120,0.85)';
    for (const v of golgiVesicles(c, a, this.time)) {
      ctx.globalAlpha = v.f > 0.9 ? (1 - v.f) * 10 : 1; // fusing with the membrane
      ctx.beginPath(); ctx.arc(v.x - cx, v.y - cy, Math.max(v.r, 0.5 * px), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Centrosome: two centrioles at right angles (~250 × 500 nm).
    {
      const o = a.centro, q = { x: c.x + o.fx * r - cx, y: c.y + o.fy * r - cy };
      ctx.fillStyle = 'rgba(180,230,255,0.25)';
      ctx.beginPath(); ctx.arc(q.x, q.y, 500 * NM, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(200,240,255,0.9)';
      for (const ang of [o.ang, o.ang + Math.PI / 2]) {
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(ang);
        ctx.fillRect(-250 * NM, -125 * NM, 500 * NM, 250 * NM);
        ctx.restore();
      }
    }
    // Lysosomes (digestive sacs) and peroxisomes.
    for (const l of a.lyso) blob(l.fx, l.fy, 250 * NM * l.s, 'rgba(255,120,140,0.6)', 'rgba(255,170,180,0.8)');
    for (const l of a.perox) blob(l.fx, l.fy, 200 * NM * l.s, 'rgba(255,240,140,0.55)', 'rgba(255,250,190,0.8)');
    if (a.vacuole) blob(a.vacuole.fx, a.vacuole.fy, a.vacuole.r * r, 'rgba(150,200,255,0.25)', 'rgba(190,225,255,0.7)');
    // Nucleus with double envelope, pores, chromatin and nucleolus.
    const nr = 0.34 * r;
    ctx.fillStyle = 'rgba(40,25,70,0.85)';
    if (this.bigDisk(X, Y, nr)) ctx.fill();
    this.drawGenome(c, a.chrom, c.x, c.y, nr, 'chromatin');
    this.drawGeneActivity(c, a.chrom, c.x, c.y, nr);
    ctx.fillStyle = 'rgba(100,70,150,0.95)';
    ctx.beginPath(); ctx.arc(X + a.nuc.fx * nr, Y + a.nuc.fy * nr, nr * 0.3, 0, TAU); ctx.fill();
    const gap = DIM.nuclearGap * NM;
    ctx.strokeStyle = 'rgba(220,200,255,0.85)';
    ctx.lineWidth = line(8);
    if (this.bigRing(X, Y, nr)) ctx.stroke();
    if (this.bigRing(X, Y, nr + gap)) ctx.stroke();
    const pore = (DIM.nuclearPore * NM) / 2;
    if (pore * 2 * ppu >= 2) {
      ctx.fillStyle = 'rgba(255,240,200,0.9)';
      ctx.beginPath();
      for (const q of nuclearPores(c)) { if (!this.inView(q.x, q.y, pore)) continue; ctx.moveTo(q.x - cx + pore, q.y - cy); ctx.arc(q.x - cx, q.y - cy, pore, 0, TAU); }
      ctx.fill();
      if (pore * 2 * ppu > 30) {
        // Eight-fold symmetric pore complex.
        ctx.fillStyle = 'rgba(160,120,90,0.9)';
        for (const q of nuclearPores(c)) {
          if (!this.inView(q.x, q.y, pore)) continue;
          for (let k = 0; k < 8; k++) { const th = (k / 8) * TAU; ctx.beginPath(); ctx.arc(q.x - cx + Math.cos(th) * pore * 0.75, q.y - cy + Math.sin(th) * pore * 0.75, pore * 0.18, 0, TAU); ctx.fill(); }
        }
      }
    }
    // Chloroplasts with stacked thylakoids (grana).
    for (const p of a.plast) {
      const { L, W } = plastSize(c);
      ctx.save();
      ctx.translate(X + p.fx * r, Y + p.fy * r);
      ctx.rotate(p.ang);
      ctx.fillStyle = '#2fb84f';
      ctx.strokeStyle = '#1b6e30';
      ctx.lineWidth = line(7);
      ctx.beginPath(); ctx.ellipse(0, 0, L / 2, W / 2, 0, 0, TAU); ctx.fill(); ctx.stroke();
      if (L * ppu > 25) {
        ctx.fillStyle = 'rgba(10,70,25,0.85)';
        for (const g of grana(L, W)) for (const d of g.discs) ctx.fillRect(d.x, d.y, d.w, d.h);
        // cpDNA
        ctx.strokeStyle = 'rgba(225,235,255,0.6)'; ctx.lineWidth = line(DIM.dna);
        ctx.beginPath(); ctx.ellipse(L * 0.3, W * 0.22, W * 0.08, W * 0.05, 0, 0, TAU); ctx.stroke();
        if (L / 40 * ppu > 6) {
          // Photosystems on the thylakoid discs (~20 nm complexes).
          ctx.fillStyle = 'rgba(120,255,140,0.9)';
          for (const g of grana(L, W)) for (const d of g.discs) for (let q = 0; q < 6; q++) ctx.fillRect(d.x + (q + 0.3) * d.w / 6, d.y - 10 * NM, 18 * NM, 10 * NM);
        }
      }
      ctx.restore();
    }
    // Mitochondria (~1 × 0.5 µm) with folded inner membranes (cristae).
    const budding = c.endoT !== undefined && (c.mitoN ?? 99) < 99 ? ((this.time - c.endoT) / 40) % 1 : 1;
    for (let mi = 0; mi < a.mitos.length; mi++) {
      const m = a.mitos[mi];
      let { L, W } = mitoSize(c, m);
      if (mi === a.mitos.length - 1 && budding < 1) { const g = ease(Math.min(1, budding * 2.5)); L *= g; W *= g; if (L <= 0) continue; } // the newest one is still growing out of a parent
      ctx.save();
      ctx.translate(X + m.fx * r, Y + m.fy * r);
      ctx.rotate(m.ang);
      ctx.fillStyle = '#ff9a76';
      ctx.strokeStyle = '#b8563a';
      ctx.lineWidth = line(7);
      ctx.beginPath(); ctx.ellipse(0, 0, L / 2, W / 2, 0, 0, TAU); ctx.fill(); ctx.stroke();
      if (L * ppu > 25) {
        ctx.beginPath();
        for (const k of cristae(L, W)) { ctx.moveTo(k.x, k.y1); ctx.lineTo(k.x, k.y2); }
        ctx.stroke();
        // mtDNA loop in the matrix.
        ctx.strokeStyle = 'rgba(225,235,255,0.7)'; ctx.lineWidth = line(DIM.dna);
        ctx.beginPath(); ctx.ellipse(L * 0.18, 0, W * 0.12, W * 0.08, 0, 0, TAU); ctx.stroke();
        if (10 * NM * ppu > 4) {
          // ATP synthase heads lining the cristae, every ~20 nm.
          ctx.fillStyle = 'rgba(255,230,120,0.95)';
          for (const k of cristae(L, W)) {
            const n = Math.floor(Math.abs(k.y2 - k.y1) / (20 * NM));
            for (let q = 0; q < n; q++) { const y = k.y1 + (k.y2 - k.y1) * (q + 0.5) / n; ctx.beginPath(); ctx.arc(k.x + 8 * NM, y, 5 * NM, 0, TAU); ctx.fill(); }
          }
        }
      }
      ctx.restore();
    }
    this.drawInfection(c);
  }

  // Peptidoglycan cell wall up close: layers of glycan strands (sugar chains) tied together by short
  // peptide cross-links, a molecular mesh like chain mail. Only the visible stretch is drawn.
  drawWallMesh(c, wall) {
    const ctx = this.ctx, v = this.v, X = c.x - this.cam.x, Y = c.y - this.cam.y;
    const half = Math.hypot(v.x1 - v.x0, v.y1 - v.y0) / 2, d = Math.hypot(X, Y);
    const R0 = c.r + 2 * NM, n = wallLayers(wall);
    if (d - half > R0 + wall || d + half < R0) return;
    const { mid, phi } = this.visibleArc(X, Y, R0 + wall / 2, d, half);
    ctx.fillStyle = 'rgba(205,165,105,0.18)';
    ctx.beginPath(); ctx.arc(X, Y, R0 + wall, mid - phi, mid + phi); ctx.arc(X, Y, R0, mid + phi, mid - phi, true); ctx.fill();
    ctx.strokeStyle = 'rgba(225,190,120,0.95)';
    ctx.lineWidth = 1 * NM;
    for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(X, Y, wallLayerR(c, wall, i), mid - phi, mid + phi); ctx.stroke(); }
    // Cross-links between neighbouring layers, every ~4 nm, staggered.
    ctx.strokeStyle = 'rgba(160,220,140,0.9)';
    ctx.lineWidth = 0.5 * NM;
    ctx.beginPath();
    for (let i = 0; i + 1 < n; i++) {
      const r1 = wallLayerR(c, wall, i), r2 = wallLayerR(c, wall, i + 1), da = WALL_LINK / r1, off = (i % 2) * 0.5;
      for (let k = Math.floor((mid - phi) / da); k <= Math.ceil((mid + phi) / da); k++) {
        const a = (k + off) * da;
        ctx.moveTo(X + Math.cos(a) * r1, Y + Math.sin(a) * r1); ctx.lineTo(X + Math.cos(a) * r2, Y + Math.sin(a) * r2);
      }
    }
    ctx.stroke();
    if (this.pxnm >= 6) {
      // Individual NAG–NAM sugar units along each strand (~1 nm each).
      ctx.fillStyle = 'rgba(255,230,170,0.95)';
      for (let i = 0; i < n; i++) {
        const R = wallLayerR(c, wall, i), da = WALL_UNIT / R;
        ctx.beginPath();
        for (let k = Math.floor((mid - phi) / da); k <= Math.ceil((mid + phi) / da); k++) { const a = k * da, x = X + Math.cos(a) * R, y = Y + Math.sin(a) * R; ctx.moveTo(x + 0.35 * NM, y); ctx.arc(x, y, 0.35 * NM, 0, TAU); }
        ctx.fill();
      }
    }
  }

  // A translating ribosome: two subunits of folded rRNA studded with proteins, a messenger RNA
  // threading between them, transfer RNAs in the A, P and E sites, and the new protein leaving
  // through the exit tunnel. Representative, at true scale (see ribosome.js).
  drawRibosomeModel(x, y, seed, euk, cell) {
    const ctx = this.ctx, m = ribosomeModel(seed, euk), pxnm = this.pxnm;
    const st = translationState(m, cell ? translationPhase(cell, seed, this.time) : 0);
    this.nmFrame(x, y, ribosomeAngle(seed));
    const path = (pts, w, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
    };
    const bases = (pts, r) => { for (const q of pts) { ctx.fillStyle = MONO_COLORS[q.b]; ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, TAU); ctx.fill(); } };
    // Subunit bodies.
    ctx.fillStyle = 'rgba(70,50,110,0.45)';
    ctx.beginPath(); ctx.ellipse(m.L.cx, m.L.cy, m.L.rx, m.L.ry, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(120,100,170,0.45)';
    ctx.beginPath(); ctx.ellipse(m.S.cx, m.S.cy, m.S.rx, m.S.ry, 0, 0, TAU); ctx.fill();
    // Ribosomal RNA: the folded chains that make up most of the ribosome.
    path(m.rnaL, 0.9, 'rgba(200,160,255,0.85)');
    path(m.rna5S, 0.9, 'rgba(255,200,240,0.9)');
    path(m.rnaS, 0.9, 'rgba(225,200,255,0.85)');
    if (pxnm >= 6) { bases(m.rnaL, 0.22); bases(m.rna5S, 0.22); bases(m.rnaS, 0.22); }
    // Ribosomal proteins on the surface.
    for (const pr of [...m.protL, ...m.protS]) {
      ctx.fillStyle = 'rgba(110,200,175,0.9)';
      ctx.beginPath(); ctx.arc(pr.x, pr.y, pr.r, 0, TAU); ctx.fill();
      if (pxnm >= 12) {
        // Amino-acid texture of a folded protein.
        ctx.fillStyle = 'rgba(40,120,100,0.6)';
        for (let k = 0; k < 14; k++) { const a = k * 2.4, rr = pr.r * Math.sqrt((k + 0.5) / 14) * 0.85; ctx.beginPath(); ctx.arc(pr.x + Math.cos(a) * rr, pr.y + Math.sin(a) * rr, 0.22, 0, TAU); ctx.fill(); }
      }
    }
    // Messenger RNA, ratcheting one codon (3 bases) through the groove per cycle.
    const nm = m.mrna.length, cs = (st.shift / (2.7 * m.s)) * 1.8;
    ctx.save(); ctx.translate(-cs, 0);
    path(m.mrna, 0.45, 'rgba(255,157,232,0.95)');
    if (pxnm >= 5) m.mrna.forEach((q, i) => { ctx.fillStyle = MONO_COLORS[m.mrna[(i + st.codonShift) % nm].b]; ctx.fillRect(q.x - 0.14, q.y - 0.9, 0.28, 0.75); });
    ctx.restore();
    // Transfer RNAs (L-shaped): one arrives in the A site, the chain passes to it, they all shift, one leaves.
    const comp = (b) => (b === 0 ? 1 : b === 1 ? 0 : b === 2 ? 3 : 2);
    for (const t of st.trna) {
      if (t.alpha <= 0.02) continue;
      ctx.save(); ctx.globalAlpha = t.alpha; ctx.translate(t.dx, t.dy);
      path(t.pts, 1.5, t.site === 'P' ? 'rgba(255,180,84,0.95)' : t.site === 'A' ? 'rgba(255,214,120,0.9)' : 'rgba(220,160,90,0.75)');
      const end = t.pts[t.pts.length - 1];
      if (t.aaHere) { ctx.fillStyle = `hsl(${(AMINO.indexOf(t.aa) * 18) % 360},70%,60%)`; ctx.beginPath(); ctx.arc(end.x + 0.4, end.y + 0.3, 0.45, 0, TAU); ctx.fill(); }
      if (pxnm >= 8) {
        // Its anticodon matches the codon under it.
        const ci = m.mrna.findIndex((q) => q.x >= t.x - 0.9);
        for (let i = 0; i < 3; i++) { ctx.fillStyle = MONO_COLORS[comp(m.mrna[(ci + st.codonShift + i) % nm].b)]; ctx.fillRect(t.x - 0.9 + i * 0.6 - 0.14, t.pts[0].y - 0.1, 0.28, 0.6); }
      }
      ctx.restore();
    }
    // The new protein, one amino acid longer each cycle, snaking out of the exit tunnel.
    for (let i = 0; i < st.peptideLen; i++) { const q = m.peptide[i]; ctx.fillStyle = `hsl(${(AMINO.indexOf(q.aa) * 18) % 360},65%,62%)`; ctx.beginPath(); ctx.arc(q.x, q.y, 0.24, 0, TAU); ctx.fill(); }
    ctx.restore();
  }

  // Gene expression and genome copying (cosmetic, driven by the cell's state and sim time):
  // RNA polymerases crawl along genes spinning out messenger RNA (in bacteria, ribosomes start
  // translating it straight away), and before division two replication forks copy the chromosome.
  drawGeneActivity(c, pts, ox, oy, R) {
    const ctx = this.ctx, n = pts.length / 2, cx = this.cam.x, cy = this.cam.y, px = this.px;
    const P0 = (i) => { i = ((i % n) + n) % n; return { x: ox + pts[2 * i] * R, y: oy + pts[2 * i + 1] * R }; };
    const P = (i) => { const f = Math.floor(i), u = i - f, a = P0(f); if (!u) return a; const b = P0(f + 1); return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }; };
    const normal = (i) => { const a = P(i - 1), b = P(i + 1), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1; return { x: -dy / d, y: dx / d }; };
    // Replication: the copied stretch grows out from the origin in both directions.
    const prog = c.mito ? 0 : replicationProgress(c);
    if (prog > 0.001) {
      const o = hash32(c.id, 7) % n, half = Math.max(1, Math.floor((prog * n) / 2)), off = Math.max(6 * NM, 1.2 * px);
      const col = c.dna ? 'rgba(150,255,180,0.85)' : 'rgba(255,190,240,0.85)';
      if (this.pxnm >= 2) {
        // Close up the new copy is a real double helix (2 nm wide, a turn every 3.4 nm), base pairs as rungs.
        for (let j = -half; j < half; j++) {
          const q0 = P(o + j), q1 = P(o + j + 1), n0 = normal(o + j);
          const x0 = q0.x + n0.x * off, y0 = q0.y + n0.y * off, x1 = q1.x + n0.x * off, y1 = q1.y + n0.y * off;
          if (!this.inView((x0 + x1) / 2, (y0 + y1) / 2, Math.hypot(x1 - x0, y1 - y0))) continue;
          const D = Math.hypot(x1 - x0, y1 - y0) || 1e-9, segL = D / NM, steps = Math.max(2, Math.ceil(segL / 0.4)), tx = (x1 - x0) / D, ty = (y1 - y0) / D;
          const s0 = (j + half) * segL; // nm from the copy's start, keeps the helix phase continuous
          ctx.lineWidth = 0.35 * NM;
          for (const ph of c.dna ? [0, Math.PI * 0.8] : [0]) { // an RNA copy is a single strand
            ctx.strokeStyle = col; ctx.beginPath();
            for (let i = 0; i <= steps; i++) {
              const f = i / steps, w = Math.sin(((s0 + f * segL) / 3.4) * TAU + ph) * NM;
              const X = x0 + (x1 - x0) * f - ty * w, Y = y0 + (y1 - y0) * f + tx * w;
              if (i) ctx.lineTo(X - cx, Y - cy); else ctx.moveTo(X - cx, Y - cy);
            }
            ctx.stroke();
          }
          if (this.pxnm >= 4) for (let d = Math.ceil(s0 / 0.34) * 0.34 - s0; d < segL; d += 0.34) {
            const f = d / segL, a1 = ((s0 + d) / 3.4) * TAU, w1 = Math.sin(a1) * NM, w2 = c.dna ? Math.sin(a1 + Math.PI * 0.8) * NM : w1 - 0.8 * NM; // RNA: bases stick out
            const X = x0 + (x1 - x0) * f, Y = y0 + (y1 - y0) * f;
            ctx.strokeStyle = MONO_COLORS[hash32(c.id + j, Math.round(d * 10)) & 3]; ctx.lineWidth = 0.2 * NM;
            ctx.beginPath(); ctx.moveTo(X - ty * w1 - cx, Y + tx * w1 - cy); ctx.lineTo(X - ty * w2 - cx, Y + tx * w2 - cy); ctx.stroke();
          }
        }
      } else {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(DIM.dna * NM, 0.8 * px);
        ctx.beginPath();
        for (let j = -half; j <= half; j++) { const q = P(o + j), nn = normal(o + j); if (j === -half) ctx.moveTo(q.x + nn.x * off - cx, q.y + nn.y * off - cy); else ctx.lineTo(q.x + nn.x * off - cx, q.y + nn.y * off - cy); }
        ctx.stroke();
      }
      if (prog < 1) {
        ctx.fillStyle = '#7dffa8'; // replisomes at the two forks (~30 nm)
        for (const j of [o - half, o + half]) { const q = P(j); ctx.beginPath(); ctx.arc(q.x - cx, q.y - cy, Math.max(15 * NM, 1.2 * px), 0, TAU); ctx.fill(); }
      }
    }
    // Transcription.
    const rnap = 7.5 * NM;
    if (rnap * 2 * this.ppu < 0.8) return;
    const tailMax = Math.min(R * 0.5, 3); // up to ~1.5 µm of message
    for (const pol of polymerases(c, n, this.time)) {
      const q = P(pol.idx);
      if (!this.inView(q.x, q.y, tailMax * 1.5)) continue;
      const nn = normal(pol.idx), L = tailMax * Math.min(1, pol.prog / GENE_LEN);
      const drift = pol.done ? (pol.prog - GENE_LEN) / 40 : 0, alpha = pol.done ? 1 - drift : 1;
      if (alpha <= 0) continue;
      const base = pol.done ? { x: q.x + nn.x * tailMax * (0.3 + drift), y: q.y + nn.y * tailMax * (0.3 + drift) } : q;
      const tail = [], NS = Math.max(24, Math.min(600, Math.ceil((L / NM) / 0.6))); // a point per base when close
      for (let k = 0; k <= NS; k++) {
        const sk = (k / NS) * L, w = Math.sin(sk * 9 + pol.k) * tailMax * 0.08 + Math.sin(sk * 140 + pol.k * 3) * 2 * NM;
        tail.push({ x: base.x + nn.x * sk - nn.y * w, y: base.y + nn.y * sk + nn.x * w });
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(255,157,232,0.9)';
      ctx.lineWidth = Math.max(1 * NM, 0.7 * px);
      ctx.beginPath(); tail.forEach((t, i) => (i ? ctx.lineTo(t.x - cx, t.y - cy) : ctx.moveTo(t.x - cx, t.y - cy))); ctx.stroke();
      if (this.pxnm >= 5) {
        // Bases of the new message, every ~0.6 nm along it.
        for (let i = 1; i < tail.length; i++) { ctx.fillStyle = MONO_COLORS[hash32(c.id * 31 + pol.k, i) & 3]; ctx.fillRect(tail[i].x - cx - 0.15 * NM, tail[i].y - cy - 0.15 * NM, 0.3 * NM, 0.3 * NM); }
      }
      if (!c.mito && L > 0.2) {
        // Coupled transcription–translation: ribosomes ride the message as it is made.
        ctx.fillStyle = 'rgba(40,25,70,0.85)';
        for (let sk = 0.15; sk < L; sk += 0.18) { const t = tail[Math.min(NS, Math.round((sk / L) * NS))]; ctx.beginPath(); ctx.arc(t.x - cx, t.y - cy, Math.max(DIM.ribosome * NM / 2, 0.6 * px), 0, TAU); ctx.fill(); }
      }
      if (!pol.done) { ctx.fillStyle = 'rgba(255,120,90,0.95)'; ctx.beginPath(); ctx.arc(q.x - cx, q.y - cy, Math.max(rnap, 0.7 * px), 0, TAU); ctx.fill(); } // RNA polymerase
      ctx.globalAlpha = 1;
    }
  }

  // Tubulin dimers (8 nm) along microtubules, only near the camera.
  drawTubulin(c, a) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y;
    for (const m of microtubules(c, a, this.time)) {
      const L = Math.hypot(m.x2 - m.x1, m.y2 - m.y1), ux = (m.x2 - m.x1) / L, uy = (m.y2 - m.y1) / L, step = 8 * NM;
      // Only the stretch that is on screen.
      const vx = (this.v.x0 + this.v.x1) / 2 - m.x1, vy = (this.v.y0 + this.v.y1) / 2 - m.y1;
      const along = vx * ux + vy * uy, half = Math.hypot(this.v.x1 - this.v.x0, this.v.y1 - this.v.y0) / 2;
      const s0 = Math.max(0, along - half), s1 = Math.min(L, along + half);
      if (s1 <= s0 || Math.abs(vx * uy - vy * ux) > half + 15 * NM) continue;
      for (let s = Math.floor(s0 / step) * step; s < s1; s += step) {
        const k = Math.round(s / step);
        ctx.fillStyle = k & 1 ? 'rgba(150,210,255,0.9)' : 'rgba(90,160,230,0.9)'; // alpha / beta tubulin
        for (const off of [-8, 0, 8]) ctx.fillRect(m.x1 + ux * s - uy * off * NM - cx - 2 * NM, m.y1 + uy * s + ux * off * NM - cy - 2 * NM, 4 * NM, 4 * NM);
      }
    }
  }

  // Genetic material at every scale: a tangle from afar; a double helix with base pairs (DNA) or a
  // single strand with bases (RNA genome) up close; chromatin wound on nucleosomes in eukaryotes.
  drawGenome(c, pts, cx, cy, R, mode) {
    const ctx = this.ctx, X = cx - this.cam.x, Y = cy - this.cam.y, pxnm = this.pxnm;
    const w = mode === 'chromatin' ? 30 : DIM.dna;
    const detailed = mode === 'chromatin' ? pxnm >= 0.4 : pxnm >= 2;
    if (detailed && mode === 'chromatin') {
      // Close up, chromatin is "beads on a string": thin linker DNA between nucleosomes.
      ctx.strokeStyle = 'rgba(225,235,255,0.7)';
      ctx.lineWidth = Math.max(DIM.dna * NM, 0.7 * this.px);
      ctx.beginPath();
      for (let k = 0; k < pts.length; k += 2) { const x = X + pts[k] * R, y = Y + pts[k + 1] * R; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    }
    if (!detailed) {
    ctx.strokeStyle = mode === 'rna' ? 'rgba(255,150,220,0.6)' : mode === 'chromatin' ? 'rgba(180,150,230,0.6)' : 'rgba(225,235,255,0.55)';
    ctx.lineWidth = Math.max(w * NM, 0.7 * this.px);
    ctx.beginPath();
    for (let k = 0; k < pts.length; k += 2) {
      const x = X + pts[k] * R, y = Y + pts[k + 1] * R;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    return;
    }
    // Close up: only the segments on screen get molecular detail.
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const x1 = cx + pts[k] * R, y1 = cy + pts[k + 1] * R, x2 = cx + pts[k + 2] * R, y2 = cy + pts[k + 3] * R;
      if (!this.inView((x1 + x2) / 2, (y1 + y2) / 2, Math.hypot(x2 - x1, y2 - y1) / 2 + 30 * NM)) continue;
      if (mode === 'chromatin') this.drawNucleosomes(x1, y1, x2, y2, c.id, k);
      else this.drawHelix(x1, y1, x2, y2, c.id, k, mode === 'rna');
    }
  }

  drawHelix(x1, y1, x2, y2, seed, seg, rna) {
    const ctx = this.ctx, L = Math.hypot(x2 - x1, y2 - y1) / NM; // nm
    if (L < 0.1) return;
    const ux = (x2 - x1) / (L * NM), uy = (y2 - y1) / (L * NM);
    ctx.save();
    ctx.translate(x1 - this.cam.x, y1 - this.cam.y);
    ctx.rotate(Math.atan2(uy, ux));
    ctx.scale(NM, NM);
    if (rna) {
      // Single-stranded RNA genome: one backbone, bases sticking out.
      ctx.strokeStyle = '#ff9de8'; ctx.lineWidth = 0.25;
      ctx.beginPath();
      for (let s = 0; s <= L; s += 0.3) { const y = Math.sin(s * 0.9) * 0.3; if (s) ctx.lineTo(s, y); else ctx.moveTo(s, y); }
      ctx.stroke();
      for (let k = 0, s = 0; s < L; k++, s += DIM.ntRise) {
        ctx.fillStyle = MONO_COLORS[dnaBase(seed, seg, k)];
        ctx.fillRect(s - 0.18, Math.sin(s * 0.9) * 0.3, 0.36, 0.9);
      }
    } else {
      // B-DNA: two backbones winding round each other every 3.4 nm, base pairs every 0.34 nm.
      const back = (ph) => { ctx.beginPath(); for (let s = 0; s <= L; s += 0.2) { const y = Math.sin((s / 3.4) * TAU + ph); if (s) ctx.lineTo(s, y); else ctx.moveTo(s, y); } ctx.stroke(); };
      ctx.lineWidth = 0.08;
      for (let k = 0, s = 0; s < L; k++, s += 0.34) {
        const ya = Math.sin((s / 3.4) * TAU), yb = Math.sin((s / 3.4) * TAU + 2.4);
        const b = dnaBase(seed, seg, k), pair = b === 0 ? 1 : b === 1 ? 0 : b === 2 ? 3 : 2, ym = (ya + yb) / 2;
        ctx.strokeStyle = MONO_COLORS[b]; ctx.beginPath(); ctx.moveTo(s, ya); ctx.lineTo(s, ym); ctx.stroke();
        ctx.strokeStyle = MONO_COLORS[pair]; ctx.beginPath(); ctx.moveTo(s, ym); ctx.lineTo(s, yb); ctx.stroke();
      }
      ctx.lineWidth = 0.3;
      ctx.strokeStyle = '#f4a259'; back(0);
      ctx.strokeStyle = '#e8e2d0'; back(2.4);
    }
    ctx.restore();
  }

  drawNucleosomes(x1, y1, x2, y2, seed, seg) {
    // DNA wraps 1.65 turns round a histone core every ~200 base pairs (~11 nm beads on a string).
    const ctx = this.ctx, L = Math.hypot(x2 - x1, y2 - y1) / NM, n = Math.max(1, Math.floor(L / 25));
    ctx.fillStyle = 'rgba(205,180,255,0.9)';
    ctx.strokeStyle = 'rgba(240,230,255,0.9)';
    ctx.lineWidth = Math.max(2 * NM, 0.6 * this.px);
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n, x = x1 + (x2 - x1) * f - this.cam.x, y = y1 + (y2 - y1) * f - this.cam.y;
      ctx.beginPath(); ctx.arc(x, y, 5.5 * NM, 0, TAU); ctx.fill();
      if (this.pxnm >= 3) { ctx.beginPath(); ctx.arc(x, y, 5.9 * NM, 0.3, 0.3 + TAU * 0.82); ctx.stroke(); }
    }
  }

  // New virus capsids piling up inside an infected cell until it bursts.
  drawInfection(c) {
    if (!c.infected) return;
    const R = DIM.virus * NM, ctx = this.ctx;
    if (R * this.ppu < 1) return;
    ctx.fillStyle = 'rgba(200,240,110,0.85)';
    for (const q of capsids(c, this.time)) { ctx.beginPath(); this.poly(q.x - this.cam.x, q.y - this.cam.y, R, 6, 0); ctx.fill(); }
  }

  drawViruses(world) {
    const list = world.viruses && world.viruses.list;
    if (!list || !list.length) return;
    const ctx = this.ctx, R = DIM.virus * NM, cx = this.cam.x, cy = this.cam.y;
    if (R * this.ppu < 1.5) {
      ctx.fillStyle = '#d4ff6a';
      const h = Math.max(R, 0.65 * this.px);
      for (const v of list) if (this.inView(v.x, v.y, R * 4)) ctx.fillRect(v.x - cx - h, v.y - cy - h, 2 * h, 2 * h);
      return;
    }
    for (const v of list) if (this.inView(v.x, v.y, R * 4)) this.drawVirus(v.x, v.y, v.ang);
  }

  // A tailed bacteriophage: icosahedral head (~100 nm), contractile tail, tail fibres.
  drawVirus(x, y, ang) {
    const ctx = this.ctx;
    this.nmFrame(x, y, ang);
    ctx.fillStyle = '#9fc04a';
    ctx.fillRect(-9, 40, 18, 110);
    ctx.strokeStyle = '#cfe98a'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(-34, 150); ctx.lineTo(34, 150); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const s of [-1, 1]) for (const k of [0, 1, 2]) { const bx = s * (12 + k * 10); ctx.moveTo(bx, 150); ctx.lineTo(bx + s * 30, 190 - k * 8); ctx.lineTo(bx + s * 42, 215); }
    ctx.stroke();
    ctx.fillStyle = '#b9e05a'; ctx.strokeStyle = '#efffb0'; ctx.lineWidth = 4;
    ctx.beginPath(); this.poly(0, 0, 50, 6, Math.PI / 6); ctx.fill(); ctx.stroke();
    if (this.pxnm >= 0.25) {
      // Packed genome inside the head.
      ctx.strokeStyle = 'rgba(255,209,102,0.9)'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k < 120; k++) { const a = k * 0.55, r = 4 + k * 0.28; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBonds(cells) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y, ppu = this.ppu;
    const lines = new Path2D(), joints = new Path2D();
    let nl = 0, nj = 0;
    for (const c of cells) {
      if (!c.bonds.length || !this.inView(c.x, c.y, c.r * 3)) continue;
      for (const o of c.bonds) {
        if (o.id < c.id) continue;
        const rp = Math.min(c.r, o.r) * ppu;
        if (rp < 6) {
          lines.moveTo(c.x - cx, c.y - cy); lines.lineTo(o.x - cx, o.y - cy); nl++;
        } else {
          // Cell–cell junction (cytoplasmic bridge) where the membranes touch.
          const dx = o.x - c.x, dy = o.y - c.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
          const t = c.r / (c.r + o.r);
          const mx = c.x + dx * t - cx, my = c.y + dy * t - cy, hl = Math.min(c.r, o.r) * 0.45;
          joints.moveTo(mx - uy * hl, my + ux * hl); joints.lineTo(mx + uy * hl, my - ux * hl); nj++;
        }
      }
    }
    if (nl) { ctx.strokeStyle = 'rgba(225,240,255,0.55)'; ctx.lineWidth = 0.8 * this.px; ctx.stroke(lines); }
    if (nj) { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(DIM.junction * NM, 1.5 * this.px); ctx.stroke(joints); }
  }

  // Highlight a selection along its real outline: a whole membrane ring, a thin structure along its
  // length, or a circle around a compact thing.
  drawSelection(sel) {
    const ctx = this.ctx, cx = this.cam.x, cy = this.cam.y, px = this.px;
    const o = sel.obj || sel;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([4 * px, 3 * px]);
    if (sel.outline) {
      const ol = sel.outline();
      ctx.beginPath();
      if (ol.type === 'ellipse') ctx.ellipse(ol.x - cx, ol.y - cy, ol.rx + 4 * px, ol.ry + 4 * px, ol.ang, 0, TAU);
      else { if (this.bigRing(ol.x - cx, ol.y - cy, ol.r + 4 * px)) ctx.stroke(); if (this.bigRing(ol.x - cx, ol.y - cy, Math.max(0, ol.r - (ol.w || 0) - 4 * px))) ctx.stroke(); ctx.restore(); return; }
      ctx.stroke();
    } else if (sel.shape) {
      // Two dashed rails along the structure.
      ctx.lineWidth = 1.2 * px;
      const off = sel.shape.w / 2 + 3 * px;
      for (const pts of sel.shape.lines()) {
        for (const side of [-1, 1]) {
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
            const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
            const x = pts[i].x - cx - (dy / d) * off * side, y = pts[i].y - cy + (dx / d) * off * side;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.stroke();
        }
      }
    } else {
      ctx.beginPath();
      ctx.arc((o._rx ?? o.x) - cx, (o._ry ?? o.y) - cy, (o.r || o._rad || 0) + 5 * px, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawScaleBar() {
    const ctx = this.ctx, dpr = this.dpr, ch = this.canvas.height;
    const nmPerPx = 1 / this.pxnm;
    const len = niceNumber(130 * dpr * nmPerPx), w = len / nmPerPx;
    const x = 16 * dpr, y = ch - 34 * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(4,8,15,0.72)';
    ctx.fillRect(x - 8 * dpr, y - 26 * dpr, Math.max(w + 70 * dpr, 230 * dpr), 34 * dpr);
    ctx.strokeStyle = '#e8eef7';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, y - 5 * dpr); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y - 5 * dpr);
    ctx.stroke();
    ctx.font = `600 ${12 * dpr}px system-ui`;
    ctx.fillStyle = '#e8eef7';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatLen(len), x + w + 8 * dpr, y + 2 * dpr);
    const fw = this.fieldWidthNm();
    ctx.fillStyle = '#9fb0c6';
    ctx.font = `${11 * dpr}px system-ui`;
    ctx.fillText(`Field of view ${formatLen(fw)} · ${scaleName(fw)}`, x, y - 10 * dpr);
  }
}
