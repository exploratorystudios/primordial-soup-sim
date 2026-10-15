// A small pool of helper threads for the kernels in kernels.js. The main thread packs a phase's inputs into
// shared arrays, then it and the helpers take chunks of the work from a shared counter until all are done.
// Results don't depend on how many threads there are (each cell's result is computed the same way and the
// main thread merges chunks in order), so without shared memory everything simply runs on the main thread.
import { makeViews, runChunk, PHASES, P_CHUNKS } from './kernels.js';
import { CFG } from './config.js';

// Node has its own threads (worker_threads); browsers have Web Workers.
const WT = typeof process !== 'undefined' && process.versions && process.versions.node ? await import('node:worker_threads') : null;

const C_GEN = 0, C_PHASE = 1, C_NEXT = 2, C_DONE = 3, C_CHUNKS = 4, C_READY = 5;
const CHUNKS = 48; // more chunks than threads, so dense patches don't leave threads idle

let pool; // created on first use

// Helper threads to use: CFG.THREADS, or (0 = auto) all but one core on a browser page; none in Node or inside
// a worker (the tour's history search, batch runs that already run one world per core).
function helperCount() {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return 0;
  if (typeof window === 'undefined' || typeof document === 'undefined') return CFG.THREADS > 1 ? CFG.THREADS - 1 : 0;
  if (!globalThis.crossOriginIsolated) return 0; // shared memory needs the page to be cross-origin isolated
  if (CFG.THREADS > 0) return CFG.THREADS - 1;
  return Math.max(0, Math.min(7, (navigator.hardwareConcurrency || 2) - 1));
}

function createPool(cap, vcap, nc, fn, sunLen) {
  const helpers = helperCount();
  const shared = helpers > 0;
  const V = makeViews(cap, vcap, nc, fn, sunLen, CHUNKS, shared);
  const p = { V, helpers, shared, cap, vcap, nc, fn, sunLen, workers: [], ctl: null };
  if (!shared) return p;
  p.ctl = new Int32Array(new SharedArrayBuffer(64));
  for (let k = 0; k < helpers; k++) {
    const url = new URL('./kernel-worker.js', import.meta.url);
    const w = WT ? new WT.Worker(url, { workerData: { V, ctl: p.ctl } }) : new Worker(url, { type: 'module' });
    if (WT) w.unref(); else w.postMessage({ V, ctl: p.ctl });
    p.workers.push(w);
  }
  return p;
}

// The pool's arrays, recreated bigger (with fresh helpers) if this world doesn't fit.
export function views(cap, vcap, nc, fn, sunLen) {
  if (pool && (pool.cap < cap || pool.vcap < vcap || pool.nc !== nc || pool.fn !== fn || pool.sunLen !== sunLen)) {
    for (const w of pool.workers) w.terminate();
    pool = null;
  }
  if (!pool) pool = createPool(Math.max(Math.ceil(cap * 1.25), CFG.MAX_CELLS + 1000), Math.max(Math.ceil(vcap * 1.25), CFG.MAX_VIRUSES + 1000), nc, fn, sunLen);
  return pool.V;
}

// Run a phase over all chunks, with the helpers if V is the pool's shared set.
export function run(V, phase) {
  V.P[P_CHUNKS] = CHUNKS;
  const p = pool;
  // Helpers join only once every one of them is waiting (they load asynchronously); until then, or without
  // shared memory, the main thread does all the chunks itself (with identical results).
  if (!p || V !== p.V || !p.shared || p.helpers === 0 || Atomics.load(p.ctl, C_READY) < p.helpers) {
    for (let k = 0; k < CHUNKS; k++) runChunk(V, phase, k);
    return;
  }
  const ctl = p.ctl;
  Atomics.store(ctl, C_PHASE, PHASES.indexOf(phase));
  Atomics.store(ctl, C_CHUNKS, CHUNKS);
  Atomics.store(ctl, C_NEXT, 0);
  Atomics.store(ctl, C_DONE, 0);
  Atomics.add(ctl, C_GEN, 1);
  Atomics.notify(ctl, C_GEN);
  for (let k; (k = Atomics.add(ctl, C_NEXT, 1)) < CHUNKS;) runChunk(V, phase, k);
  // (The main thread may not block, so it spins briefly while the last helpers finish their chunks.)
  while (Atomics.load(ctl, C_DONE) < p.helpers) { /* spin */ }
}

export function threadCount() { return pool ? (pool.shared ? pool.helpers + 1 : 1) : helperCount() + 1; }
