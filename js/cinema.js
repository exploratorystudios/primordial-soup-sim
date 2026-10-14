// Scripted "documentary" director: drives the simulation and camera frame by frame and draws
// titles, callouts and HUD on top. Used by render-video.mjs through cinema.html.
import { World } from './world.js';
import { Renderer, NM_PER_UNIT, DIM } from './render.js';
import { TYPE_NAMES } from './life.js';
import { drawTreeOn } from './ui.js';
import { CFG } from './config.js';

export const FPS = 30;
const NM = 1 / NM_PER_UNIT;
const HABITAT_FOV = CFG.W * NM_PER_UNIT; // 0.7 mm

// Scene list. Durations (seconds) must match script.md / script.srt.
export const SCENES = [
  { id: 'title', dur: 8 },
  { id: 'ocean', dur: 16 },
  { id: 'molecules', dur: 22 },
  { id: 'protocell', dur: 22 },
  { id: 'cell', dur: 18 },
  { id: 'evolution', dur: 26 },
  { id: 'eukaryote', dur: 20 },
  { id: 'multicell', dur: 26 },
  { id: 'outro', dur: 22 },
];

const clamp01 = (u) => (u < 0 ? 0 : u > 1 ? 1 : u);
const ease = (u) => { u = clamp01(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
const seg = (u, a, b) => clamp01((u - a) / (b - a));
const logLerp = (a, b, u) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u);
// Fade in over [a, a+f], out over [b-f, b].
const window_ = (u, a, b, f) => Math.min(seg(u, a, a + f), 1 - seg(u, b - f, b));

const FONT = 'Ubuntu, "Noto Sans", "DejaVu Sans", sans-serif';

export class Cinema {
  constructor(canvas, seed) {
    this.canvas = canvas;
    this.seed = seed;
    this.renderer = new Renderer(canvas);
    this.ctx = canvas.getContext('2d');
    this.opts = { colorMode: 'troph', overlay: 'none', showChem: true, selected: null, flash: null };
    this.frames = SCENES.reduce((a, s) => a + Math.round(s.dur * FPS), 0);
    this.f = 0;
    this.sceneIdx = -1;
    this.tree = document.createElement('canvas');
  }

  // Pass 1: run the same world once to learn when the key events happen.
  async scout(maxTicks = 90000) {
    const w = new World(this.seed);
    const ev = {};
    while (w.t < maxTicks) {
      for (let k = 0; k < 500; k++) w.step();
      for (const m of w.milestones) if (ev[m.key] === undefined) ev[m.key] = m.t;
      const st = w.life.stats;
      if (ev.euk20 === undefined && st.euk >= 20) ev.euk20 = w.t;
      if (ev.organism === undefined && w.life.organisms.some((o) => o.kind !== 'colony' && o.size >= 12)) ev.organism = w.t;
      if (ev.organism !== undefined && ev.euk20 !== undefined) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    this.ev = ev;
    return ev;
  }

  start(ev) {
    if (ev) this.ev = ev;
    this.world = new World(this.seed);
    this.f = 0;
    this.sceneIdx = -1;
    this.ms = [];
  }

  sceneAt(f) {
    let acc = 0;
    for (let i = 0; i < SCENES.length; i++) {
      const n = Math.round(SCENES[i].dur * FPS);
      if (f < acc + n) return { i, lf: f - acc, n };
      acc += n;
    }
    return null;
  }

  step(n) { for (let k = 0; k < n; k++) this.world.step(); }
  runTo(t) { while (this.world.t < t) this.world.step(); }

  setCam(x, y, fov) {
    const R = this.renderer;
    R.cam.x = x; R.cam.y = y;
    R.setFieldWidthNm(fov);
  }

  // Dive toward a target while keeping it fixed on screen: the offset shrinks with the zoom.
  dive(from, target, fov0, fov1, u) {
    const fov = logLerp(fov0, fov1, ease(u));
    const k = (fov - fov1) / (fov0 - fov1 || 1);
    this.setCam(target.x + (from.x - target.x) * k, target.y + (from.y - target.y) * k, fov);
  }

  toScreen(x, y) {
    const R = this.renderer;
    return { x: this.canvas.width / 2 + (x - R.cam.x) * R.ppu, y: this.canvas.height / 2 + (y - R.cam.y) * R.ppu };
  }

  // Returns a JPEG data URL for the next frame, or null when finished. render=false only advances.
  frame(render = true, quality = 0.92) {
    if (this.f >= this.frames) return null;
    const sc = this.sceneAt(this.f);
    if (sc.i !== this.sceneIdx) { this.sceneIdx = sc.i; this.s = {}; this.enter(SCENES[sc.i].id); }
    const u = sc.lf / sc.n;
    this.update(SCENES[sc.i].id, u, sc.lf, sc.n);
    this.trackMilestones();
    this.f++;
    if (!render) return '';
    this.renderer.draw(this.world, this.opts);
    this.overlay(SCENES[sc.i].id, u, sc.lf, sc.n);
    return this.canvas.toDataURL('image/jpeg', quality);
  }

  // ----------------------------------------------------------------- scenes
  enter(id) {
    const w = this.world, s = this.s;
    this.opts.overlay = 'none';
    this.opts.colorMode = 'troph';
    this.opts.showChem = true;
    this.opts.focusOrg = 0;
    if (id === 'molecules') {
      // Freeze time and pick the most impressive free RNA strand near a vent.
      const v = this.mainVent();
      let best = null, bs = -1;
      for (const p of w.soup.polymers) {
        const d = Math.hypot(p.x - v.x, p.y - (CFG.H - 60));
        if (d > 260) continue;
        const sc = p.seq.length + (p.act > 0 ? 12 : 0) - d * 0.01;
        if (sc > bs) { bs = sc; best = p; }
      }
      s.poly = best || w.soup.polymers[0];
      s.from = { x: this.renderer.cam.x, y: this.renderer.cam.y };
    }
    if (id === 'protocell') {
      let best = null, bs = -1;
      for (const v of w.soup.vesicles) {
        for (const p of v.polys) {
          if (!(p.act > 0)) continue;
          const sc = p.seq.length * 2 + v.polys.length + p.act * 10;
          if (sc > bs) { bs = sc; best = { v, p }; }
        }
      }
      s.v = best ? best.v : w.soup.vesicles[0];
      s.p = best ? best.p : s.v.polys[0];
    }
    if (id === 'cell') {
      this.runTo(Math.max(w.t, this.ev.cell || 0));
      while (!w.life.cells.length) w.step();
      s.c = w.life.cells[0];
    }
    if (id === 'evolution') {
      s.t0 = w.t;
      s.t1 = Math.max(w.t + 1000, (this.ev.euk20 || this.ev.eukaryote || w.t + 20000) + 200);
    }
    if (id === 'eukaryote') {
      s.c = this.pickEukaryote();
      s.from = { x: this.renderer.cam.x, y: this.renderer.cam.y };
    }
    if (id === 'multicell') {
      s.t0 = w.t;
      s.t1 = Math.max(w.t + 500, (this.ev.organism || this.ev.multicellular || w.t + 10000) + 300);
    }
    if (id === 'outro') {
      s.from = { x: this.renderer.cam.x, y: this.renderer.cam.y, fov: this.renderer.fieldWidthNm() };
    }
  }

  mainVent() {
    const vs = this.world.vents;
    return vs.reduce((a, b) => (b.strength > a.strength ? b : a), vs[0]);
  }

  pickEukaryote() {
    const cells = this.world.life.cells.filter((c) => c.mito);
    if (!cells.length) return this.world.life.cells[0];
    return cells.reduce((a, b) => {
      const sa = a.r + (a.plastid ? 4 : 0) + (a.motil > 0.3 ? 1 : 0), sb = b.r + (b.plastid ? 4 : 0) + (b.motil > 0.3 ? 1 : 0);
      return sb > sa ? b : a;
    });
  }

  pickOrganism() {
    const orgs = this.world.life.organisms;
    const rank = (o) => (o.kind === 'complex' ? 3 : o.kind === 'multicellular' ? 2 : 1) * 1000 + o.size;
    return orgs.reduce((a, b) => (!a || rank(b) > rank(a) ? b : a), null);
  }

  orgCells(id) { return this.world.life.cells.filter((c) => c.org === id && !c.dead); }

  update(id, u, lf, n) {
    const w = this.world, s = this.s, R = this.renderer;
    const habitat = () => this.setCam(CFG.W / 2, CFG.H / 2, HABITAT_FOV);
    switch (id) {
      case 'title':
        habitat();
        this.step(1);
        break;
      case 'ocean': {
        this.step(1);
        const v = this.mainVent();
        s.target = { x: v.x, y: CFG.H - 70 };
        this.dive({ x: CFG.W / 2, y: CFG.H / 2 }, s.target, HABITAT_FOV, 150000, seg(u, 0.15, 1));
        break;
      }
      case 'molecules': {
        // Time is frozen; the camera dives from 150 µm to the strand, then drifts around it.
        const p = s.poly;
        p.ang += 0.0015;
        const fov = 22;
        if (u < 0.62) this.dive(s.from, p, 150000, fov, seg(u, 0, 0.6));
        else this.setCam(p.x, p.y, fov * (1 - 0.15 * ease(seg(u, 0.62, 1))));
        break;
      }
      case 'protocell': {
        // Inside a protocell: watch its ribozyme copy itself, then pull out to see the whole vesicle.
        if (lf % 2 === 0) this.step(1);
        const p = s.p, v = s.v;
        if (v.dead || !v.polys.includes(p)) { if (!s.lost) s.lost = { x: R.cam.x, y: R.cam.y }; }
        // Compute where the renderer will place the strand inside its (moving) protocell this frame.
        if (p._fx === undefined) { p._fx = 0.2; p._fy = -0.1; p._fa = 0.3; p._ph = 1; }
        const inner = v.r - DIM.bilayer * NM, tt = w.t, ww = (2 * NM) / inner;
        const fx = p._fx + Math.sin(tt * 0.031 + p._ph) * ww, fy = p._fy + Math.cos(tt * 0.027 + p._ph * 1.7) * ww;
        const target = s.lost || { x: v.x + fx * inner, y: v.y + fy * inner };
        if (u < 0.5) this.setCam(target.x, target.y, 26);
        else {
          // Reverse dive: pan in proportion to the zoom so the strand stays in shot as we pull back.
          const from = v.dead ? target : { x: v.x, y: v.y };
          this.dive(from, target, v.r * 2 * NM_PER_UNIT * 2.2, 26, 1 - seg(u, 0.5, 0.95));
        }
        break;
      }
      case 'cell': {
        this.step(1);
        const c = s.c.dead ? (w.life.cells[0] || s.c) : s.c;
        s.c = c;
        const d = c.r * 2 * NM_PER_UNIT;
        this.setCam(c.x, c.y, logLerp(d * 6, d * 1.25, ease(seg(u, 0, 0.55))));
        break;
      }
      case 'evolution': {
        // Time-lapse across the Archean and the Great Oxidation.
        const target = Math.round(s.t0 + (s.t1 - s.t0) * seg(u, 0.05, 1));
        this.runTo(target);
        const fov = u < 0.08 ? logLerp(R.fieldWidthNm(), HABITAT_FOV, ease(seg(u, 0, 0.08))) : HABITAT_FOV;
        this.setCam(CFG.W / 2 + (R.cam.x - CFG.W / 2) * (1 - ease(seg(u, 0, 0.08))), CFG.H / 2, fov);
        if (this.world.mset.has('goe') && u > 0.55) this.opts.overlay = u > 0.6 ? 'oxygen' : 'none';
        break;
      }
      case 'eukaryote': {
        this.step(1);
        if (s.c.dead) s.c = this.pickEukaryote();
        const c = s.c, d = c.r * 2 * NM_PER_UNIT;
        if (u < 0.45) this.dive(s.from, c, HABITAT_FOV, d * 1.3, seg(u, 0, 0.45));
        else this.setCam(c.x, c.y, logLerp(d * 1.3, d * 0.9, ease(seg(u, 0.45, 1))));
        break;
      }
      case 'multicell': {
        if (u < 0.2) {
          this.runTo(Math.round(s.t0 + (s.t1 - s.t0) * seg(u, 0, 0.19)));
          this.setCam(CFG.W / 2, CFG.H / 2, logLerp(R.fieldWidthNm(), HABITAT_FOV, ease(seg(u, 0, 0.05))));
          break;
        }
        this.step(1);
        if (!s.org || !this.orgCells(s.org.id).length) {
          s.org = this.pickOrganism();
          s.from = { x: R.cam.x, y: R.cam.y };
          this.opts.colorMode = 'type';
        }
        this.opts.colorMode = 'type';
        this.opts.focusOrg = s.org ? s.org.id : 0;
        const cells = s.org ? this.orgCells(s.org.id) : [];
        if (!cells.length) { this.setCam(CFG.W / 2, CFG.H / 2, HABITAT_FOV); break; }
        const cx = cells.reduce((a, c) => a + c.x, 0) / cells.length, cy = cells.reduce((a, c) => a + c.y, 0) / cells.length;
        const span = Math.max(...cells.map((c) => Math.hypot(c.x - cx, c.y - cy) + c.r)) * 2;
        s.center = { x: cx, y: cy };
        const fov1 = span * NM_PER_UNIT * 2.0;
        if (u < 0.55) this.dive(s.from, s.center, HABITAT_FOV, fov1, seg(u, 0.2, 0.55));
        else this.setCam(cx, cy, logLerp(fov1, fov1 * 0.8, ease(seg(u, 0.55, 1))));
        break;
      }
      case 'outro': {
        this.step(3);
        this.opts.colorMode = 'troph';
        const k = ease(seg(u, 0, 0.25));
        this.setCam(s.from.x + (CFG.W / 2 - s.from.x) * k, s.from.y + (CFG.H / 2 - s.from.y) * k, logLerp(s.from.fov, HABITAT_FOV, k));
        break;
      }
    }
  }

  trackMilestones() {
    const w = this.world;
    if (!this.msSeen) this.msSeen = w.milestones.length;
    while (this.msSeen < w.milestones.length) {
      const m = w.milestones[this.msSeen++];
      this.ms.push({ text: m.text, f: this.f });
    }
  }

  // ---------------------------------------------------------------- overlays
  overlay(id, u, lf, n) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, s = this.s, w = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Vignette.
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const t = lf / FPS, dur = n / FPS;
    switch (id) {
      case 'title': {
        const a = window_(t, 1.2, dur + 1, 1.5);
        this.text('PRIMORDIAL SOUP', W / 2, H * 0.42, 110, a, 'center', 700, 14);
        this.text('From chemistry to complex life, simulated at true scale', W / 2, H * 0.42 + 90, 36, window_(t, 2.4, dur + 1, 1.5) * 0.9, 'center', 400);
        break;
      }
      case 'ocean':
        this.chapter('I', 'The Hadean Ocean', 'A 0.7 mm patch of seafloor, four billion years ago', t);
        if (u > 0.5) {
          const v = this.mainVent();
          this.callout(v.x, CFG.H - 12, 'Hydrothermal vent', window_(t, dur * 0.55, dur - 0.3, 0.6), -1);
        }
        break;
      case 'molecules': {
        this.chapter('II', 'Molecules', 'Everything is drawn at its real size', t);
        const p = s.poly, a = window_(t, dur * 0.66, dur - 0.2, 0.7);
        if (a > 0 && p) {
          const pos = this.nucleotidePoint(p, 0);
          if (pos) {
            this.callout(pos.phosphate.x, pos.phosphate.y, 'Phosphate', a, -1);
            this.callout(pos.base.x, pos.base.y, 'Base', window_(t, dur * 0.72, dur - 0.2, 0.7), 1);
          }
          this.label(`RNA strand · ${p.seq.length} nucleotides · ${(p.seq.length * DIM.ntRise).toFixed(1)} nm`, a);
        }
        break;
      }
      case 'protocell': {
        this.chapter('III', 'The RNA World', 'A ribozyme copying itself inside a protocell', t);
        const p = s.p;
        if (u < 0.48) this.label(p.act > 0 ? `Ribozyme · ${p.seq.length} nt · copy ${p.prog}/${p.seq.length}` : 'RNA', window_(t, 3.5, dur * 0.48, 0.6));
        if (u > 0.75 && !s.v.dead) {
          const a = window_(t, dur * 0.78, dur - 0.2, 0.6);
          this.callout(s.v.x + s.v.r * 0.7, s.v.y - s.v.r * 0.7, `Fatty-acid membrane · 4 nm thick`, a, 1);
          this.label(`Protocell · ${(s.v.r * 2 * 0.5).toFixed(1)} µm`, a);
        }
        break;
      }
      case 'cell': {
        this.chapter('IV', 'Life', 'The first cell', t);
        const c = s.c, a = window_(t, dur * 0.55, dur - 0.2, 0.6);
        if (a > 0 && c) {
          const an = this.renderer.anatomy(c);
          this.callout(c.x + an.ribo[0] * c.r, c.y + an.ribo[1] * c.r, 'Ribosomes · 22 nm', a, 1);
          this.callout(c.x + an.dna[0] * c.r, c.y + an.dna[1] * c.r, 'Chromosome', window_(t, dur * 0.62, dur - 0.2, 0.6), -1);
          this.label(`Cell · ${(c.r).toFixed(1)} µm across · generation ${c.gen}`, a);
        }
        break;
      }
      case 'evolution':
        this.chapter('V', 'Evolution', 'Mutation, selection, and an oxygen revolution', t);
        this.hud(window_(t, 1, dur, 0.8));
        this.milestoneBanners();
        break;
      case 'eukaryote': {
        this.chapter('VI', 'The Complex Cell', 'Endosymbiosis builds the eukaryote', t);
        const c = s.c, a = window_(t, dur * 0.5, dur - 0.2, 0.6);
        if (a > 0 && c && c.mito) {
          const an = this.renderer.anatomy(c);
          this.callout(c.x, c.y, 'Nucleus', a, -1);
          if (an.mitos[0]) this.callout(c.x + an.mitos[0].fx * c.r, c.y + an.mitos[0].fy * c.r, 'Mitochondrion', window_(t, dur * 0.56, dur - 0.2, 0.6), 1);
          if (an.plast[0]) this.callout(c.x + an.plast[0].fx * c.r, c.y + an.plast[0].fy * c.r, 'Chloroplast', window_(t, dur * 0.62, dur - 0.2, 0.6), 1);
          this.label(`${c.plastid ? 'Eukaryotic alga' : 'Eukaryote'} · ${(c.r).toFixed(1)} µm across`, a);
        }
        break;
      }
      case 'multicell': {
        this.chapter('VII', 'Many Becoming One', 'Cells that stay together, divide the labour', t, 0.2 * dur);
        if (u < 0.2) { this.hud(window_(t, 0, 0.2 * dur, 0.4)); this.milestoneBanners(); }
        const cells = s.org ? this.orgCells(s.org.id) : [];
        const a = window_(t, dur * 0.58, dur - 0.2, 0.6);
        if (a > 0 && cells.length) {
          const seen = new Set();
          let k = 0;
          for (const c of cells) {
            if (seen.has(c.type)) continue;
            seen.add(c.type);
            this.callout(c.x, c.y, `${TYPE_NAMES[c.type]} cell`, window_(t, dur * (0.58 + 0.04 * k), dur - 0.2, 0.6), k % 2 ? 1 : -1);
            k++;
          }
          this.label(`Organism · ${cells.length} cells · ${seen.size} cell type${seen.size > 1 ? 's' : ''}`, a);
        }
        break;
      }
      case 'outro': {
        const ta = window_(t, 5.5, 15.5, 1.2);
        if (ta > 0) {
          const tc = this.tree;
          tc.width = W - 240; tc.height = H - 300;
          drawTreeOn(tc, w, 1.6);
          ctx.globalAlpha = ta * 0.92;
          ctx.fillStyle = '#04080f';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = ta;
          ctx.drawImage(tc, 120, 190);
          ctx.globalAlpha = 1;
          this.text('The tree of life in this world', 120, 130, 48, ta, 'left', 650);
          this.text(`${w.life.species.size} recorded species · ${w.t.toLocaleString()} ticks`, 120, 172, 26, ta * 0.85, 'left', 400);
        }
        const ea = window_(t, 16, dur + 1, 1.2);
        if (ea > 0) {
          ctx.fillStyle = `rgba(0,0,0,${ea * 0.85})`;
          ctx.fillRect(0, 0, W, H);
          this.text('PRIMORDIAL SOUP', W / 2, H * 0.45, 96, ea, 'center', 700, 12);
          this.text('Every seed is a different history of life', W / 2, H * 0.45 + 80, 34, ea * 0.9, 'center', 400);
        }
        break;
      }
    }
    // Cross-fade from/to black at scene edges.
    const edge = id === 'title' ? window_(t, 0, dur + 1, 1.5) : window_(t, 0, dur + (id === 'outro' ? 0 : 0.5), 0.5);
    const out = id === 'outro' ? 1 - seg(t, dur - 1.2, dur) : 1;
    const black = 1 - Math.min(edge, out);
    if (black > 0) { ctx.fillStyle = `rgba(0,0,0,${black})`; ctx.fillRect(0, 0, W, H); }
  }

  text(str, x, y, size, a, align = 'left', weight = 600, spacing = 0) {
    if (a <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    if (spacing) ctx.letterSpacing = `${spacing}px`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#f2f6fb';
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  chapter(num, title, sub, t, start = 0) {
    const a = window_(t, start + 0.6, start + 6, 0.8);
    if (a <= 0) return;
    this.text(`${num}`, 90, 120, 26, a * 0.8, 'left', 700, 6);
    this.text(title, 90, 172, 58, a, 'left', 650);
    this.text(sub, 92, 214, 26, a * 0.85, 'left', 400);
  }

  label(str, a) {
    if (a <= 0) return;
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `500 30px ${FONT}`;
    const tw = ctx.measureText(str).width;
    ctx.fillStyle = 'rgba(4,8,15,0.6)';
    ctx.fillRect(W / 2 - tw / 2 - 22, H - 132, tw + 44, 50);
    ctx.fillStyle = '#e8eef7';
    ctx.textAlign = 'center';
    ctx.fillText(str, W / 2, H - 97);
    ctx.restore();
  }

  callout(wx, wy, str, a, side = 1) {
    if (a <= 0) return;
    const ctx = this.ctx, p = this.toScreen(wx, wy);
    const ex = p.x + side * 110, ey = p.y - 90;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x + side * 5, p.y - 5); ctx.lineTo(ex, ey); ctx.lineTo(ex + side * 26, ey); ctx.stroke();
    ctx.font = `600 28px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = side > 0 ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, ex + side * 34, ey);
    ctx.restore();
  }

  hud(a) {
    if (a <= 0) return;
    const w = this.world, st = w.life.stats, W = this.canvas.width;
    const ctx = this.ctx;
    const lines = [
      [w.era().name, 30, 650],
      [`tick ${w.t.toLocaleString()}`, 24, 400],
      [`${w.life.cells.length.toLocaleString()} cells · ${st.speciesAlive} species`, 24, 400],
      [`O₂ ${w.o2.toFixed(2)} · eukaryotes ${st.euk}`, 24, 400],
    ];
    ctx.save();
    ctx.globalAlpha = a * 0.65;
    ctx.fillStyle = 'rgba(4,8,15,0.75)';
    ctx.fillRect(W - 470, 64, 400, 170);
    ctx.restore();
    let y = 108;
    for (const [s, size, wt] of lines) { this.text(s, W - 445, y, size, a, 'left', wt); y += size + 14; }
  }

  milestoneBanners() {
    const W = this.canvas.width, H = this.canvas.height;
    const live = this.ms.filter((m) => this.f - m.f < FPS * 3.2);
    let y = H - 200;
    for (const m of live.slice(-2)) {
      const t = (this.f - m.f) / FPS, a = Math.min(clamp01(t / 0.4), clamp01((3.2 - t) / 0.5));
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = `600 32px ${FONT}`;
      const tw = ctx.measureText(m.text).width;
      ctx.fillStyle = 'rgba(4,8,15,0.7)';
      ctx.fillRect(W / 2 - tw / 2 - 30, y - 40, tw + 60, 58);
      ctx.fillStyle = '#ffb454';
      ctx.fillRect(W / 2 - tw / 2 - 30, y - 40, 5, 58);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(m.text, W / 2, y);
      ctx.restore();
      y -= 70;
    }
  }

  // World positions of a nucleotide's phosphate and base inside a polymer.
  nucleotidePoint(p, i) {
    const lay = this.renderer.layout(p), q = lay.pts[i];
    if (!q) return null;
    const ang = p._drawAng ?? p.ang, c = Math.cos(ang), s = Math.sin(ang);
    const at = (lx, ly) => ({ x: p.x + (lx * c - ly * s) * NM, y: p.y + (lx * s + ly * c) * NM });
    return { phosphate: at(q[0], q[1]), base: at(q[0] + q[2] * 0.9, q[1] + q[3] * 0.9) };
  }
}
