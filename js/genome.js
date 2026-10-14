// Fixed-locus genome. Trait genes live in [0,1]; behaviour/regulatory weights in [-1,1].
import { RNG, hashSeq } from './rng.js';

export const SIZE = 0, PHOTO = 1, CHEMO = 2, HETERO = 3, PRED = 4, MOTIL = 5, AEROBIC = 6,
  DIVTH = 7, ADHES = 8, SHARE = 9, ARMOR = 10, MUTR = 11, HUE = 12, LIFESPAN = 13, COLMAX = 14;
export const W_LIGHT = 15, W_CHEM = 16, W_ORG = 17, W_PREY = 18, W_FLEE = 19, W_OXY = 20;
export const FIRST_SIGNED = W_LIGHT;
// Gene-regulatory weights deciding cell fate inside a colony: for each cell type,
// a weighted sum of [bias, #neighbours, depth from founder, colony size, light].
export const DIFF = 21, NTYPES = 6, NDIFF_IN = 5;
export const NG = DIFF + NTYPES * NDIFF_IN;

export const GENE_NAMES = [
  'Size', 'Photosynthesis', 'Chemosynthesis', 'Heterotrophy', 'Predation', 'Motility', 'Aerobic resp.',
  'Division threshold', 'Adhesion', 'Energy sharing', 'Armor', 'Mutation rate', 'Pigment hue', 'Lifespan', 'Colony size',
  'Seek light', 'Seek chemicals', 'Seek organics', 'Chase prey', 'Flee predators', 'Seek oxygen',
];

// The first cell's genome is derived from the sequence of the replicator that founded it.
export function fromSequence(seq) {
  const r = new RNG(hashSeq(seq));
  const g = new Float32Array(NG);
  g[SIZE] = 0.25 + r.next() * 0.15;
  g[PHOTO] = r.next() * 0.04;
  g[CHEMO] = 0.6 + r.next() * 0.2;
  g[HETERO] = 0.15 + r.next() * 0.2;
  g[PRED] = r.next() * 0.03;
  g[MOTIL] = 0.1 + r.next() * 0.2;
  g[AEROBIC] = r.next() * 0.03;
  g[DIVTH] = 0.4 + r.next() * 0.3;
  g[ADHES] = r.next() * 0.06;
  g[SHARE] = r.next() * 0.2;
  g[ARMOR] = r.next() * 0.05;
  g[MUTR] = 0.3 + r.next() * 0.2;
  g[HUE] = r.next();
  g[LIFESPAN] = 0.3 + r.next() * 0.3;
  g[COLMAX] = r.next() * 0.1;
  g[W_LIGHT] = (r.next() - 0.5) * 0.4;
  g[W_CHEM] = 0.4 + r.next() * 0.3;
  g[W_ORG] = r.next() * 0.2;
  g[W_PREY] = r.next() * 0.3;
  g[W_FLEE] = r.next() * 0.3;
  g[W_OXY] = -r.next() * 0.2;
  for (let i = DIFF; i < NG; i++) g[i] = (r.next() - 0.5) * 0.3;
  return g;
}

export function mutate(p, rng) {
  const g = new Float32Array(p);
  const rate = 0.01 + p[MUTR] * 0.05; // the mutation rate itself evolves
  for (let i = 0; i < NG; i++) {
    if (i === HUE || rng.next() >= rate) continue;
    if (rng.next() < 0.04) g[i] = i >= FIRST_SIGNED ? rng.range(-1, 1) : rng.next(); // large-effect mutation
    else g[i] += rng.gauss() * 0.1;
    const lo = i >= FIRST_SIGNED ? -1 : 0;
    if (g[i] < lo) g[i] = lo; else if (g[i] > 1) g[i] = 1;
  }
  // Neutral pigment drifts every generation: a visible molecular clock.
  g[HUE] = (g[HUE] + rng.gauss() * 0.004 + 1) % 1;
  return g;
}

export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < NG; i++) {
    if (i === HUE) continue;
    const d = Math.abs(a[i] - b[i]);
    s += i >= FIRST_SIGNED ? d * 0.5 : d;
  }
  return s / (NG - 1);
}
