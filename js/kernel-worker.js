// A helper thread for pool.js: waits for the main thread to start a phase, takes chunks of it until none are
// left, reports done, and waits again.
import { runChunk, PHASES } from './kernels.js';

const C_GEN = 0, C_PHASE = 1, C_NEXT = 2, C_DONE = 3, C_CHUNKS = 4, C_READY = 5;

const WT = typeof process !== 'undefined' && process.versions && process.versions.node ? await import('node:worker_threads') : null;

function serve({ V, ctl }) {
  let gen = Atomics.load(ctl, C_GEN);
  Atomics.add(ctl, C_READY, 1); // (after reading gen: the main thread starts using us only when all are ready)
  for (;;) {
    Atomics.wait(ctl, C_GEN, gen);
    gen = Atomics.load(ctl, C_GEN);
    const phase = PHASES[Atomics.load(ctl, C_PHASE)], chunks = Atomics.load(ctl, C_CHUNKS);
    for (let k; (k = Atomics.add(ctl, C_NEXT, 1)) < chunks;) runChunk(V, phase, k);
    Atomics.add(ctl, C_DONE, 1);
  }
}

if (WT) serve(WT.workerData); // Node: the arrays come with the thread
else self.onmessage = (e) => serve(e.data); // browser: in the first message
