// "Replay the tape of life": run many seeds in parallel and report when each milestone happened.
// Doubles as a regression check that every evolutionary stage still emerges after a change.
//
//   node check-evolution.mjs [--seeds 1-8] [--ticks 60000] [--jobs 6] [--cfg '{"PRED_P":0.4}'] [--md report.md]
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));

// Stages we expect, in rough historical order, with the share of seeds that should reach each.
const STAGES = [
  ['replicator', 'Replicator', 1.0],
  ['protocell', 'Protocell', 1.0],
  ['cell', 'Living cell', 1.0],
  ['translation', 'Proteins / genetic code', 0.9],
  ['dna', 'DNA genome', 0.8],
  ['photo', 'Photosynthesis', 0.8],
  ['virus', 'Viruses', 0.8],
  ['goe', 'Great Oxidation', 0.6],
  ['eukaryote', 'Eukaryote', 0.5],
  ['sex', 'Sexual reproduction', 0.4],
  ['multicellular', 'Multicellular', 0.4],
  ['complex', 'Complex organism', 0.2],
];

if (args.worker !== undefined) {
  // Child process: simulate one seed and print a JSON summary.
  const { World } = await import('./js/world.js');
  const { CFG } = await import('./js/config.js');
  if (args.cfg) Object.assign(CFG, JSON.parse(args.cfg));
  const Gn = await import('./js/genome.js');
  const w = new World(+args.seed);
  const ticks = +args.ticks;
  // Watch (without changing anything) the first cells to come alive: their genomes are built from
  // the founding replicator's sequence, so early chemistry shapes every lineage after it.
  const founders = [];
  const spawnFrom = w.life.spawnFromProtocell.bind(w.life);
  w.life.spawnFromProtocell = (v, poly) => {
    const c = spawnFrom(v, poly);
    if (founders.length < 10) founders.push({ t: w.t, len: poly.seq.length, act: +poly.act.toFixed(3), g: Array.from(c.g.slice(0, Gn.DIFF), (x) => +x.toFixed(4)) });
    return c;
  };
  const t0 = Date.now();
  let peakCells = 0;
  const keys = STAGES.map(([k]) => k);
  while (w.t < ticks) {
    w.step();
    // Every stage reached: no need to keep simulating this world.
    if (w.t % 1000 === 0 && keys.every((k) => w.mset.has(k))) break;
    if (w.t % 1000 === 0) peakCells = Math.max(peakCells, w.life.cells.length);
    if (w.t % 2000 === 0) process.stderr.write(`PROGRESS ${w.t}\n`);
  }
  const st = w.life.stats;
  const ms = Object.fromEntries(w.milestones.map((m) => [m.key, m.t]));
  console.log(JSON.stringify({
    seed: +args.seed, ms, secs: (Date.now() - t0) / 1000, ticks: w.t, node: process.version, cfg: args.cfg ? JSON.parse(args.cfg) : {}, origins: w.life.origins, founders,
    geneNames: args.genes ? Gn.GENE_NAMES.slice(0, Gn.DIFF) : undefined,
    final: { cells: w.life.cells.length, peakCells, species: st.speciesAlive, euk: st.euk, multi: st.multicellular, largest: st.largest, viruses: w.viruses ? w.viruses.list.length : 0, o2: +w.o2.toFixed(2), era: w.era().name },
  }));
  process.exit(0);
}

const [a, b] = (args.seeds || '1-8').split('-').map(Number);
const seeds = [];
for (let s = a; s <= (b || a); s++) seeds.push(s);
const ticks = +(args.ticks || 60000);
const jobs = +(args.jobs || os.cpus().length); // each world is one busy core; use them all
const self = fileURLToPath(import.meta.url);

console.log(`Replaying ${seeds.length} worlds × ${ticks.toLocaleString()} ticks on ${jobs} cores…`);
const results = [];
const progress = new Map();
let next = 0;
const tStart = Date.now();
const ticker = setInterval(() => {
  const done = results.length, total = seeds.length;
  const ticksDone = [...progress.values()].reduce((x, y) => x + y, 0) + 0;
  const frac = Math.min(1, ticksDone / (total * ticks));
  const el = (Date.now() - tStart) / 1000;
  const eta = frac > 0.02 ? el / frac - el : NaN;
  console.log(`  … ${(frac * 100).toFixed(0)}% overall (${done}/${total} worlds finished, ${el.toFixed(0)}s elapsed${isNaN(eta) ? '' : `, ~${Math.round(eta)}s left`})`);
}, 30000);
await new Promise((done) => {
  let running = 0;
  const launch = () => {
    while (running < jobs && next < seeds.length) {
      const seed = seeds[next++];
      running++;
      const cp = spawn(process.execPath, [self, '--worker', '1', '--seed', String(seed), '--ticks', String(ticks), ...(args.cfg ? ['--cfg', args.cfg] : [])]);
      let out = '';
      cp.stdout.on('data', (d) => (out += d));
      cp.stderr.on('data', (d) => {
        for (const line of String(d).split('\n')) {
          const m = /^PROGRESS (\d+)/.exec(line);
          if (m) progress.set(seed, +m[1]); else if (line.trim()) process.stderr.write(line + '\n');
        }
      });
      cp.on('close', () => {
        running--;
        progress.set(seed, ticks);
        try { const r = JSON.parse(out.trim().split('\n').pop()); results.push(r); process.stdout.write(`  seed ${seed} done (${r.secs.toFixed(0)}s)\n`); }
        catch { results.push({ seed, error: true, ms: {}, final: {} }); console.log(`  seed ${seed} FAILED`); }
        if (next >= seeds.length && running === 0) done(); else launch();
      });
    }
  };
  launch();
});
clearInterval(ticker);
results.sort((x, y) => x.seed - y.seed);

// Table: one row per seed, one column per stage (tick in thousands).
const fmt = (t) => (t === undefined ? '   –  ' : `${(t / 1000).toFixed(1).padStart(5)}k`);
const head = 'seed  ' + STAGES.map(([, n]) => n.slice(0, 6).padStart(7)).join('') + '   cells  sp  euk viru  era';
const lines = [head];
for (const r of results) {
  lines.push(String(r.seed).padStart(4) + '  ' + STAGES.map(([k]) => ' ' + fmt(r.ms[k])).join('') +
    `  ${String(r.final.cells ?? '').padStart(6)} ${String(r.final.species ?? '').padStart(3)} ${String(r.final.euk ?? '').padStart(4)} ${String(r.final.viruses ?? '').padStart(4)}  ${r.final.era ?? ''}`);
}
console.log('\n' + lines.join('\n'));

console.log('\nHow often each stage happened (and its median time):');
let ok = true;
const summary = [];
for (const [k, name, want] of STAGES) {
  const ts = results.map((r) => r.ms[k]).filter((t) => t !== undefined).sort((x, y) => x - y);
  const share = ts.length / results.length;
  const med = ts.length ? ts[Math.floor(ts.length / 2)] : undefined;
  const pass = share >= want;
  if (!pass) ok = false;
  const row = `  ${pass ? '✓' : '✗'} ${name.padEnd(24)} ${String(Math.round(share * 100)).padStart(3)}%  (want ≥ ${Math.round(want * 100)}%)   median ${med === undefined ? '—' : med.toLocaleString() + ' ticks'}`;
  console.log(row);
  summary.push({ name, share, med, want, pass });
}
console.log(ok ? '\nAll stages emerge as expected.' : '\nSome stages emerge less often than expected (see ✗).');

if (args.md) {
  const md = [`# Replaying the tape of life\n`, `${results.length} worlds, ${ticks.toLocaleString()} ticks each.\n`,
    '| Stage | Worlds reaching it | Median tick |', '| --- | --- | --- |',
    ...summary.map((s) => `| ${s.name} | ${Math.round(s.share * 100)}% | ${s.med === undefined ? '—' : s.med.toLocaleString()} |`),
    '', '```', ...lines, '```', ''];
  fs.writeFileSync(args.md, md.join('\n'));
  console.log(`Wrote ${args.md}`);
}
process.exit(ok ? 0 : 1);
