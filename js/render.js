// Canvas renderer. Everything is drawn at its true physical size: one world unit = 0.5 µm,
// so the habitat is 0.7 × 0.45 mm. Detail appears as you zoom ("semantic zoom"):
// molecules, membrane bilayers and organelles are drawn once they are big enough to see.
//
// To keep precision at extreme zoom (~10^5×) everything is drawn relative to the camera.
import { CFG } from './config.js';
import { LIPID, BASES } from './chemistry.js';
import { RNG } from './rng.js';

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
    if (opts.showChem) this.drawChemistry(world);
    this.drawLife(world, opts);

    if (opts.selected) this.drawSelection(opts.selected);
    if (opts.flash) {
      const f = opts.flash;
      ctx.fillStyle = `rgba(255,160,60,${f.a * 0.5})`;
      ctx.beginPath(); ctx.arc(f.x - cx, f.y - cy, 350 * (1.2 - f.a), 0, TAU); ctx.fill();
    }
    this.drawScaleBar();
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
        this.drawMonomer(mx[i], my[i], mt[i], (soup.mid[i] * 2.399) % TAU);
      }
    }

    for (const p of soup.polymers) {
      if (!this.inView(p.x, p.y, p.seq.length * DIM.ntRise * NM)) continue;
      this.drawPolymer(p, p.x, p.y, p.ang);
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
        ctx.save();
        ctx.translate(qx - dx * 0.45, qy - dy * 0.45);
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
    ctx.beginPath(); ctx.arc(X, Y, ve.r, 0, TAU); ctx.fill();
    this.drawBilayer(ve.x, ve.y, ve.r, alive ? 'rgba(255,190,245,0.95)' : 'rgba(245,232,180,0.95)', alive ? 'rgba(255,170,240,0.35)' : 'rgba(235,215,160,0.35)');
    if (rp < 6) return;
    // Contents, at true size inside the membrane.
    const inner = ve.r - DIM.bilayer * NM;
    for (const p of ve.polys) {
      if (p._fx === undefined) {
        const a = Math.random() * TAU, rr = Math.sqrt(Math.random()) * 0.8;
        p._fx = Math.cos(a) * rr; p._fy = Math.sin(a) * rr; p._fa = Math.random() * TAU; p._ph = Math.random() * TAU;
      }
      // Gentle wandering that depends only on simulation time, so it freezes when paused.
      const t = this.time, w = (2 * NM) / inner;
      const fx = p._fx + Math.sin(t * 0.031 + p._ph) * w, fy = p._fy + Math.cos(t * 0.027 + p._ph * 1.7) * w;
      p._drawFa = p._fa + Math.sin(t * 0.013 + p._ph) * 0.6;
      const px = ve.x + fx * inner, py = ve.y + fy * inner;
      p.x = px; p.y = py; // keep the inspector/camera on it
      if (this.inView(px, py, 0.05)) this.drawPolymer(p, px, py, p._drawFa);
    }
    if (molecular) {
      // Free nucleotides waiting in the protocell's internal pool.
      for (let t = 0; t < 4; t++) {
        const n = Math.min(ve.pool[t], 40);
        for (let k = 0; k < n; k++) {
          const r = new RNG((ve.id * 7919 + t * 131 + k * 17) >>> 0);
          const a = r.next() * TAU, rr = Math.sqrt(r.next()) * 0.85;
          const px = ve.x + Math.cos(a) * rr * inner, py = ve.y + Math.sin(a) * rr * inner;
          if (this.inView(px, py, 3 * NM)) this.drawMonomer(px, py, t, r.next() * TAU);
        }
      }
    }
  }

  // A lipid bilayer of radius R; individual lipids are drawn once they are resolvable,
  // and only along the arc that is on screen.
  drawBilayer(x, y, R, head, tail, twoTails = false) {
    const ctx = this.ctx, v = this.v, t = DIM.bilayer * NM;
    const X = x - this.cam.x, Y = y - this.cam.y;
    if (DIM.lipidSpacing * this.pxnm < 2.5) {
      ctx.strokeStyle = head;
      ctx.lineWidth = Math.max(t, 1.1 * this.px);
      ctx.beginPath(); ctx.arc(X, Y, Math.max(0, R - t / 2), 0, TAU); ctx.stroke();
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
      const ox = X + Math.cos(a) * ro, oy = Y + Math.sin(a) * ro;
      const ix = X + Math.cos(b) * ri, iy = Y + Math.sin(b) * ri;
      ctx.moveTo(ox + hr, oy); ctx.arc(ox, oy, hr, 0, TAU);
      ctx.moveTo(ix + hr, iy); ctx.arc(ix, iy, hr, 0, TAU);
    }
    ctx.fill();
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
      if (c.motil > 0.3 && c.r * ppu > 2 && this.inView(c.x, c.y, c.r * 6)) {
        ctx.globalAlpha = focus && c.org !== focus ? 0.15 : 1;
        this.drawFlagellum(c, world.t);
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
        ctx.beginPath(); ctx.arc(X, Y, c.r, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }
      const fill = 0.35 + 0.65 * Math.max(0.15, Math.min(1, c.energy / c.cap));
      ctx.globalAlpha = rp > 14 ? Math.max(0.85, fill) : fill; // close up, cytoplasm is opaque
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(X, Y, c.r, 0, TAU); ctx.fill();
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
        ctx.strokeStyle = 'rgba(205,165,105,0.85)';
        ctx.lineWidth = Math.max(wall, px);
        ctx.beginPath(); ctx.arc(X, Y, c.r + wall / 2, 0, TAU); ctx.stroke();
      }
      if (DIM.bilayer * this.pxnm >= 1.5) this.drawBilayer(c.x, c.y, c.r, 'rgba(240,235,215,0.95)', 'rgba(230,210,160,0.45)', true);
      else if (rp > 3 || c.mito) {
        ctx.strokeStyle = c.mito ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = Math.max(DIM.bilayer * NM, px * (c.mito ? 1.2 : 0.8));
        ctx.beginPath(); ctx.arc(X, Y, c.r, 0, TAU); ctx.stroke();
      }
    }
    this.drawBonds(cells);
  }

  drawFlagellum(c, t) {
    const ctx = this.ctx, X = c.x - this.cam.x, Y = c.y - this.cam.y;
    const sp = Math.hypot(c.vx, c.vy);
    let ux = -Math.cos(c.heading), uy = -Math.sin(c.heading);
    if (sp > 0.02) { ux = -c.vx / sp; uy = -c.vy / sp; }
    // Bacterial flagella are ~20 nm thick and several µm long, beating as a helix.
    const len = Math.min(20, c.r * 5), amp = 0.5, lambda = 5, ph = t * 0.8 + c.id;
    ctx.strokeStyle = 'rgba(220,235,255,0.4)';
    ctx.lineWidth = Math.max((c.mito ? 250 : DIM.flagellum) * NM, 0.8 * this.px);
    ctx.beginPath();
    for (let k = 0; k <= 40; k++) {
      const s = (k / 40) * len, w = amp * Math.sin((s / lambda) * TAU - ph) * Math.min(1, s / 1.5);
      const x = X + ux * (c.r + s) - uy * w, y = Y + uy * (c.r + s) + ux * w;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  // Procedural anatomy, generated deterministically from the cell's id and state.
  anatomy(c) {
    const key = (c.mito ? 1 : 0) | (c.plastid ? 2 : 0) | (c.effP > 0.25 ? 4 : 0);
    const old = c._anat;
    if (old && old.key === key && old.r === c.r) return old;
    const rng = new RNG((Math.imul(c.id, 2654435761) ^ 0x9e3779b9) >>> 0);
    const a = { key, r: c.r, ribo: [], dna: [], chrom: [], mitos: [], plast: [], er: [], nuc: null, thyl: !c.mito && c.effP > 0.25 };
    const rUm = c.r * 0.5, areaUm2 = Math.PI * rUm * rUm;
    const hole = c.mito ? 0.4 : 0;
    const nr = Math.min(700, Math.round(areaUm2 * 45));
    for (let k = 0, tries = 0; k < nr && tries < nr * 5; tries++) {
      const x = rng.next() * 2 - 1, y = rng.next() * 2 - 1, d2 = x * x + y * y;
      if (d2 > 0.86 || d2 < hole * hole) continue;
      a.ribo.push(x, y); k++;
    }
    if (!c.mito) {
      // Prokaryotic nucleoid: one long circular chromosome, tangled in the middle.
      const ph = rng.next() * TAU;
      for (let k = 0; k < 120; k++) {
        const th = (k / 120) * TAU;
        const rr = 0.1 + 0.32 * Math.abs(Math.sin(th * 3 + ph)) + 0.05 * rng.next();
        a.dna.push(Math.cos(th * 2 + ph) * rr, Math.sin(th * 3) * rr * 0.9);
      }
    } else {
      a.nuc = { fx: (rng.next() - 0.5) * 0.3, fy: (rng.next() - 0.5) * 0.3 };
      let x = 0, y = 0;
      for (let k = 0; k < 70; k++) {
        const th = rng.next() * TAU;
        x += Math.cos(th) * 0.14; y += Math.sin(th) * 0.14;
        const d = Math.hypot(x, y); if (d > 0.8) { x *= 0.8 / d; y *= 0.8 / d; }
        a.chrom.push(x, y);
      }
      for (let k = 0; k < 5; k++) a.er.push({ rr: 0.42 + k * 0.045, a0: rng.next() * TAU, span: 1 + rng.next() * 2.2 });
      const nm = Math.max(2, Math.min(24, Math.round(areaUm2 / 5)));
      for (let k = 0; k < nm; k++) {
        const rr = 0.52 + rng.next() * 0.3, th = rng.next() * TAU;
        a.mitos.push({ fx: Math.cos(th) * rr, fy: Math.sin(th) * rr, ang: rng.next() * Math.PI, s: 0.8 + rng.next() * 0.4 });
      }
      if (c.plastid) {
        const np = Math.max(1, Math.min(4, Math.round(areaUm2 / 20)));
        for (let k = 0; k < np; k++) {
          const th = (k / np) * TAU + rng.next(), rr = 0.6;
          a.plast.push({ fx: Math.cos(th) * rr, fy: Math.sin(th) * rr, ang: th + Math.PI / 2 });
        }
      }
    }
    c._anat = a;
    return a;
  }

  drawCellInterior(c) {
    const ctx = this.ctx, a = this.anatomy(c), ppu = this.ppu, px = this.px;
    const X = c.x - this.cam.x, Y = c.y - this.cam.y, r = c.r;
    // Ribosomes (~22 nm): the protein factories filling the cytoplasm.
    const rib = (DIM.ribosome * NM) / 2;
    if (rib * 2 * ppu >= 0.8) {
      ctx.fillStyle = 'rgba(30,20,50,0.55)';
      ctx.beginPath();
      const rr = Math.max(rib, 0.5 * px);
      for (let k = 0; k < a.ribo.length; k += 2) {
        const x = X + a.ribo[k] * r, y = Y + a.ribo[k + 1] * r;
        ctx.moveTo(x + rr, y); ctx.arc(x, y, rr, 0, TAU);
      }
      ctx.fill();
      if (rib * 2 * ppu > 12) {
        // Small subunit sitting on the large one.
        ctx.fillStyle = 'rgba(120,100,160,0.7)';
        ctx.beginPath();
        for (let k = 0; k < a.ribo.length; k += 2) {
          const x = X + a.ribo[k] * r + rib * 0.5, y = Y + a.ribo[k + 1] * r - rib * 0.5;
          ctx.moveTo(x + rib * 0.6, y); ctx.arc(x, y, rib * 0.6, 0, TAU);
        }
        ctx.fill();
      }
    }
    const line = (w) => Math.max(w * NM, 0.8 * px);
    if (!c.mito) {
      if (a.thyl) {
        ctx.strokeStyle = 'rgba(60,200,90,0.65)';
        ctx.lineWidth = line(10);
        for (const f of [0.8, 0.72, 0.64]) { ctx.beginPath(); ctx.arc(X, Y, r * f, 0, TAU); ctx.stroke(); }
      }
      ctx.strokeStyle = 'rgba(225,235,255,0.6)';
      ctx.lineWidth = line(DIM.dna);
      ctx.beginPath();
      for (let k = 0; k < a.dna.length; k += 2) {
        const x = X + a.dna[k] * r, y = Y + a.dna[k + 1] * r;
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      return;
    }
    // Endoplasmic reticulum.
    ctx.strokeStyle = 'rgba(190,170,230,0.35)';
    ctx.lineWidth = line(50);
    for (const e of a.er) { ctx.beginPath(); ctx.arc(X, Y, e.rr * r, e.a0, e.a0 + e.span); ctx.stroke(); }
    // Nucleus with double envelope, pores, chromatin and nucleolus.
    const nr = 0.34 * r;
    ctx.fillStyle = 'rgba(40,25,70,0.85)';
    ctx.beginPath(); ctx.arc(X, Y, nr, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(180,150,230,0.55)';
    ctx.lineWidth = line(DIM.dna * 4);
    ctx.beginPath();
    for (let k = 0; k < a.chrom.length; k += 2) {
      const x = X + a.chrom[k] * nr, y = Y + a.chrom[k + 1] * nr;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(100,70,150,0.95)';
    ctx.beginPath(); ctx.arc(X + a.nuc.fx * nr, Y + a.nuc.fy * nr, nr * 0.3, 0, TAU); ctx.fill();
    const gap = DIM.nuclearGap * NM;
    ctx.strokeStyle = 'rgba(220,200,255,0.85)';
    ctx.lineWidth = line(8);
    ctx.beginPath(); ctx.arc(X, Y, nr, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(X, Y, nr + gap, 0, TAU); ctx.stroke();
    const pore = (DIM.nuclearPore * NM) / 2;
    if (pore * 2 * ppu >= 2) {
      ctx.fillStyle = 'rgba(255,240,200,0.9)';
      const np = Math.round((TAU * nr) / (500 * NM));
      ctx.beginPath();
      for (let k = 0; k < np; k++) {
        const th = (k / np) * TAU, x = X + Math.cos(th) * (nr + gap / 2), y = Y + Math.sin(th) * (nr + gap / 2);
        ctx.moveTo(x + pore, y); ctx.arc(x, y, pore, 0, TAU);
      }
      ctx.fill();
    }
    // Chloroplasts with stacked thylakoids (grana).
    for (const p of a.plast) {
      const L = Math.min(8, r * 0.75), W = L * 0.45;
      ctx.save();
      ctx.translate(X + p.fx * r, Y + p.fy * r);
      ctx.rotate(p.ang);
      ctx.fillStyle = '#2fb84f';
      ctx.strokeStyle = '#1b6e30';
      ctx.lineWidth = line(7);
      ctx.beginPath(); ctx.ellipse(0, 0, L / 2, W / 2, 0, 0, TAU); ctx.fill(); ctx.stroke();
      if (L * ppu > 25) {
        ctx.fillStyle = 'rgba(10,70,25,0.85)';
        const gw = L * 0.1, gh = W * 0.06;
        for (let g = 0; g < 4; g++) {
          const gx = -L * 0.3 + g * L * 0.2;
          for (let s = 0; s < 5; s++) ctx.fillRect(gx - gw / 2, -W * 0.18 + s * gh * 1.6, gw, gh);
        }
      }
      ctx.restore();
    }
    // Mitochondria (~1 × 0.5 µm) with folded inner membranes (cristae).
    for (const m of a.mitos) {
      const L = Math.min((DIM.mitoLen * NM) * m.s, r * 0.5), W = L / 2;
      ctx.save();
      ctx.translate(X + m.fx * r, Y + m.fy * r);
      ctx.rotate(m.ang);
      ctx.fillStyle = '#ff9a76';
      ctx.strokeStyle = '#b8563a';
      ctx.lineWidth = line(7);
      ctx.beginPath(); ctx.ellipse(0, 0, L / 2, W / 2, 0, 0, TAU); ctx.fill(); ctx.stroke();
      if (L * ppu > 25) {
        ctx.beginPath();
        for (let k = 1; k <= 5; k++) {
          const x = -L / 2 + (k / 6) * L, s = k & 1 ? 1 : -1;
          ctx.moveTo(x, s * W * 0.48); ctx.lineTo(x, -s * W * 0.15);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
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

  drawSelection(sel) {
    const ctx = this.ctx;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * this.px;
    ctx.setLineDash([4 * this.px, 3 * this.px]);
    ctx.beginPath();
    ctx.arc(sel.x - this.cam.x, sel.y - this.cam.y, (sel.r || sel._rad || 0) + 5 * this.px, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
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
