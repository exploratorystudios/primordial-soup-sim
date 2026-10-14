// Run the simulation without a browser and print its history.
// Usage: node headless.js [ticks=60000] [seed=1]
import { World } from './js/world.js';
import { CFG } from './js/config.js';

// Optional overrides for experiments, e.g. CFG='{"PRED_P":0.4}' node headless.js
if (process.env.CFG) Object.assign(CFG, JSON.parse(process.env.CFG));

const ticks = +(process.argv[2] || 60000);
const seed = +(process.argv[3] || 1);
const w = new World(seed);
const t0 = Date.now();
let seen = 0;
for (let i = 0; i < ticks; i++) {
  w.step();
  while (seen < w.milestones.length) {
    const m = w.milestones[seen++];
    console.log(`  * t=${m.t}  ${m.text}`);
  }
  if (i % 5000 === 0) {
    const s = w.soup, st = w.life.stats;
    console.log(`t=${w.t} [${((Date.now() - t0) / 1000).toFixed(1)}s] mono=${s.n} poly=${s.polymers.length} maxLen=${s.stats.maxLen} reps=${s.stats.replicators} ves=${s.vesicles.length} proto=${s.stats.protocells} | cells=${w.life.cells.length} P/C/H/X=${st.photo}/${st.chemo}/${st.hetero}/${st.pred} euk=${st.euk} aer=${st.aerobic} colonyCells=${st.inColonies} largest=${st.largest} multi=${st.multicellular} sp=${st.speciesAlive} O2=${w.o2.toFixed(2)} gen=${st.maxGen} | era: ${w.era().name}`);
  }
}
const cs = w.life.cells, mean = (i) => (cs.reduce((a, c) => a + c.g[i], 0) / (cs.length || 1)).toFixed(3);
console.log(`final genes: adhesion=${mean(8)} colonyMax=${mean(14)} predation=${mean(4)} armor=${mean(10)} | organisms: ${w.life.organisms.slice(0, 5).map((o) => `${o.size}:${o.kind}[${o.types}]`).join(' ')}`);
console.log('deaths', w.life.deaths, 'births', w.life.births, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
