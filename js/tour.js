// A guided camera tour of whatever exists in the current world. Each stop flies the camera to a
// subject at a fitting magnification, selects it (so its parts show in the inspector) and captions it.
// Time keeps running at the user's chosen speed; any manual camera move ends the tour.
import { CFG } from './config.js';
import { NM_PER_UNIT } from './render.js';
import { sel, organismOf } from './parts.js';

const FLY = 2.5, HOLD = 7; // seconds
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const um = (units) => (units * NM_PER_UNIT / 1000).toFixed(1);

export class Tour {
  constructor(renderer, ui, onEnd) {
    this.r = renderer;
    this.ui = ui;
    this.onEnd = onEnd;
    this.active = false;
  }

  start(world) {
    this.world = world;
    this.stops = this.plan(world);
    this.i = -1;
    this.active = true;
    this.next();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    document.getElementById('tour-caption').hidden = true;
    if (this.onEnd) this.onEnd();
  }

  plan(w) {
    const stops = [{ title: 'The habitat', text: `A ${(CFG.W * NM_PER_UNIT / 1e6).toFixed(1)} mm patch of ancient seafloor, drawn at true scale. Vents glow at the bottom; sunlight comes from above.`, target: () => ({ x: CFG.W / 2, y: CFG.H / 2, fov: CFG.W * NM_PER_UNIT }) }];
    const s = w.soup, L = w.life;
    const proto = s.vesicles.filter((v) => v.polys.some((p) => p.act > 0)).sort((a, b) => b.polys.length - a.polys.length)[0];
    if (proto) stops.push({ title: 'A protocell', text: `A fatty-acid bubble ${um(proto.r * 2)} µm across, with ${proto.polys.length} RNA strands inside. Some are ribozymes that copy themselves.`, sel: () => sel('vesicle', proto), target: () => (proto.dead ? null : { x: proto.x, y: proto.y, fov: proto.r * 2 * NM_PER_UNIT * 1.6 }) });
    const pro = L.cells.filter((c) => !c.mito && c.orgSize === 1).sort((a, b) => b.r - a.r)[0];
    if (pro) stops.push({ title: 'A prokaryote', text: `A single cell ${um(pro.r * 2)} µm across with ${pro.dna ? 'a DNA chromosome' : 'an RNA genome'}, ribosomes making proteins, and ${pro.motil > 0.3 ? 'a whip-like flagellum' : 'no flagellum'}.`, sel: () => sel('cell', pro), target: () => (pro.dead ? null : { x: pro.x, y: pro.y, fov: pro.r * 2 * NM_PER_UNIT * 1.5 }) });
    const euk = L.cells.filter((c) => c.mito).sort((a, b) => (b.plastid - a.plastid) || (b.r - a.r))[0];
    if (euk) stops.push({ title: euk.plastid ? 'An alga' : 'A eukaryote', text: `${um(euk.r * 2)} µm across: a nucleus, mitochondria${euk.plastid ? ' and chloroplasts' : ''}, all descended from cells swallowed long ago (endosymbiosis).`, sel: () => sel('cell', euk), target: () => (euk.dead ? null : { x: euk.x, y: euk.y, fov: euk.r * 2 * NM_PER_UNIT * 1.3 }) });
    const org = [...L.organisms].sort((a, b) => (b.kind !== 'colony') - (a.kind !== 'colony') || b.size - a.size)[0];
    const founder = org && L.cells.find((c) => c.org === org.id);
    if (founder) {
      const os = organismOf(founder, w);
      stops.push({ title: org.kind === 'colony' ? 'A colony' : 'A multicellular organism', text: `${org.size} cells that stayed together after dividing${org.kind !== 'colony' ? ', each doing a different job' : ''}.`, sel: () => os, target: () => (os.obj.dead ? null : { x: os.obj.x, y: os.obj.y, fov: os.obj.r * 2 * NM_PER_UNIT * 1.6 }) });
    }
    const v = w.viruses.list[Math.floor(w.viruses.list.length / 2)];
    if (v) stops.push({ title: 'A virus', text: 'About 100 nm: a genome in a protein shell. It drifts until its tail fibres find a cell whose receptors fit, then takes it over.', sel: () => sel('virus', Object.assign(v, { r: 0.2 }), { world: w }), target: () => (v.dead ? null : { x: v.x, y: v.y, fov: 900 }) });
    stops.push({ ...stops[0], title: 'That’s this world so far', text: 'Every seed grows a different history. Keep watching, or press ⏭ to jump to the next milestone.' });
    return stops;
  }

  next() {
    this.i++;
    if (this.i >= this.stops.length) { this.stop(); return; }
    const st = this.stops[this.i];
    this.t = 0;
    this.from = { x: this.r.cam.x, y: this.r.cam.y, fov: this.r.fieldWidthNm() };
    if (st.sel) { const s = st.sel(); s.follow = false; this.ui.select(this.world, s); } else this.ui.select(this.world, null);
    const cap = document.getElementById('tour-caption');
    cap.innerHTML = `<b>${st.title}</b>${st.text}`;
    cap.hidden = false;
  }

  // Log-zoom between two views, keeping the smaller view's centre fixed on screen.
  dive(a, b, u, zoomingIn) {
    const fov = Math.exp(Math.log(a.fov) + (Math.log(b.fov) - Math.log(a.fov)) * u);
    let x, y;
    if (zoomingIn) {
      const k = (fov - b.fov) / (a.fov - b.fov || 1);
      x = b.x + (a.x - b.x) * k; y = b.y + (a.y - b.y) * k;
    } else {
      const k = (fov - a.fov) / (b.fov - a.fov || 1);
      x = a.x + (b.x - a.x) * k; y = a.y + (b.y - a.y) * k;
    }
    this.r.cam.x = x; this.r.cam.y = y;
    this.r.setFieldWidthNm(fov);
  }

  update(dt) {
    if (!this.active) return;
    const st = this.stops[this.i];
    const tgt = st.target();
    if (!tgt) { this.next(); return; } // the subject died or dissolved
    this.t += dt;
    const u = Math.min(1, this.t / FLY), f = this.from;
    // Far apart at high zoom? Pull back to see both, then dive in: no blurry cross-habitat pans.
    const gapNm = Math.hypot(tgt.x - f.x, tgt.y - f.y) * NM_PER_UNIT;
    if (gapNm > 3 * Math.max(f.fov, tgt.fov)) {
      const mid = { x: (f.x + tgt.x) / 2, y: (f.y + tgt.y) / 2, fov: gapNm * 1.4 };
      if (u < 0.5) this.dive(f, mid, ease(u * 2), true);
      else this.dive(mid, tgt, ease(u * 2 - 1), false);
    } else {
      this.dive(f, tgt, ease(u), tgt.fov < f.fov);
    }
    if (this.t > FLY + HOLD) this.next();
  }
}
