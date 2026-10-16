// Watching a world that runs on a server (primordial-soup-sim-fly/sim-server.mjs) instead of simulating it in
// the page. The page asks /api/status whether it is being served live; if so it loads the server's world from
// a full snapshot (/api/full, now and then) and keeps it current from compact frames (/api/frame, about once a
// second; see liveframe.js), drawing everything gliding between the last two frames.
import { deserialize } from './persist.js';
import { setCfg } from './config.js';
import { applyFrame, mergeFull } from './liveframe.js';

export const FULL_EVERY = 60000; // ms between full snapshots (true genomes and species for cells born meanwhile)

export async function detectLive() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) return null;
    const s = await r.json();
    return s && s.live ? s : null;
  } catch { return null; }
}

export class LiveFeed {
  constructor() {
    this.arrived = performance.now(); // when the last frame arrived
    this.interval = 1000;             // ms between frames (smoothed), so motion takes as long as the gap
    this.lastFull = 0;
    this.seq = -1;
    this.tps = 0;                     // the server's ticks per second
    this._t = null;
    this.seed = null;               // the world the frames should belong to
    this.t0 = 0;                     // the clock glides from t0 (where it was drawn) to the latest frame's tick
    this.approx = new Set();         // cells drawn from a stand-in genome until the next full snapshot
    this.ctl = null;                 // the server's clock state (paused, speed limit, seeking)
  }

  // The server's whole world, with its settings.
  async full() {
    const r = await fetch('/api/full', { cache: 'no-store' });
    if (!r.ok) throw new Error(`server said ${r.status}`);
    const d = await r.json();
    setCfg(d.cfg || {});
    const w = deserialize(d);
    w.smooth = true;
    w.soupAlpha = (a) => a; // (molecules glide between frames like everything else)
    this.lastFull = performance.now();
    this.seed = w.seed; this._t = w.t; this.t0 = w.t;
    this.approx.clear();
    return w;
  }

  // Now and then: the true genomes of cells born since the last snapshot, and the species, merged into the
  // world on screen (rebuilding it would redraw everything slightly differently). 'reset' if it's a new world.
  async refresh(w) {
    const r = await fetch('/api/full', { cache: 'no-store' });
    if (!r.ok) return false;
    const d = await r.json();
    this.lastFull = performance.now();
    if (d.seed !== w.seed) return 'reset';
    mergeFull(w, d, this.approx);
    return true;
  }

  // Update the world from the latest frame. Returns false if there was nothing new, and 'reset' if the frame is
  // from a different world (the server started a new one): then the page loads it with full().
  async frame(w) {
    const r = await fetch('/api/frame', { cache: 'no-store' });
    if (!r.ok) return false;
    const f = await r.json();
    if (f.seq === this.seq) return false;
    if (this.seed !== null && (f.seed !== this.seed || f.t < this._t)) return 'reset';
    const now = performance.now();
    if (this._t !== null && f.t > this._t) {
      const gap = now - this.arrived;
      this.interval = Math.max(300, Math.min(4000, this.interval * 0.7 + gap * 0.3));
      this.tps = ((f.t - this._t) * 1000) / gap;
    }
    const a = this.alpha(now);
    this.t0 = this.time(now); // (keep the clock where it is drawn)
    this._t = f.t;
    this.seq = f.seq;
    this.ctl = f.ctl || null;
    applyFrame(w, f, a, this.approx);
    this.arrived = now;
    return true;
  }

  // How far between the previous frame and the latest one to draw (0 … 1).
  alpha(now) { return Math.min(1, (now - this.arrived) / this.interval); }
  // The tick to draw at (animations follow it), gliding like the positions.
  time(now) { return this._t === null ? 0 : this.t0 + (this._t - this.t0) * this.alpha(now); }
}
