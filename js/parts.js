// Hierarchical anatomy for the inspector. Every selectable thing can list its parts, down to the
// chemical groups of a single molecule, and every part knows where it is (at true scale) so the
// camera can zoom into it. Sub-cellular parts are procedural: they follow the cell's simulated
// state (eukaryote or not, plastids, size, armor, genome) but are not simulated one by one.
import { BASES, LIPID } from './chemistry.js';
import { NM_PER_UNIT, DIM, formatLen, dnaBase } from './render.js';
import { TYPE_NAMES } from './life.js';
import * as Gn from './genome.js';

const NM = 1 / NM_PER_UNIT;
const TAU = Math.PI * 2;
const um = (units) => formatLen(units * NM_PER_UNIT);

export const NT_INFO = [
  { name: 'Adenosine monophosphate (AMP)', base: 'Adenine', formula: 'C₁₀H₁₄N₅O₇P', baseFormula: 'C₅H₅N₅', ring: 'purine: two fused rings', pair: 'U' },
  { name: 'Uridine monophosphate (UMP)', base: 'Uracil', formula: 'C₉H₁₃N₂O₉P', baseFormula: 'C₄H₄N₂O₂', ring: 'pyrimidine: one ring', pair: 'A' },
  { name: 'Guanosine monophosphate (GMP)', base: 'Guanine', formula: 'C₁₀H₁₄N₅O₈P', baseFormula: 'C₅H₅N₅O', ring: 'purine: two fused rings', pair: 'C' },
  { name: 'Cytidine monophosphate (CMP)', base: 'Cytosine', formula: 'C₉H₁₄N₃O₈P', baseFormula: 'C₄H₅N₃O', ring: 'pyrimidine: one ring', pair: 'G' },
];

const GENE_DESC = {
  [Gn.SIZE]: 'Cell size. Bigger cells store more energy and are hard to swallow, but cost more to run.',
  [Gn.PHOTO]: 'Investment in photosynthetic pigments and photosystems.',
  [Gn.CHEMO]: 'Investment in enzymes that harvest energy from vent chemicals (H₂, H₂S).',
  [Gn.HETERO]: 'Investment in absorbing dissolved organic matter.',
  [Gn.PRED]: 'Investment in engulfing other cells (phagocytosis).',
  [Gn.MOTIL]: 'Flagellum strength: swimming speed.',
  [Gn.AEROBIC]: 'Aerobic respiration and antioxidant defences: uses oxygen, resists its toxicity.',
  [Gn.DIVTH]: 'How much energy the cell banks before dividing.',
  [Gn.ADHES]: 'Chance that daughter cells stay stuck together after division.',
  [Gn.SHARE]: 'Strength of cytoplasmic bridges that pass energy and nutrients to neighbours.',
  [Gn.ARMOR]: 'Cell wall / pellicle thickness: defence against predators.',
  [Gn.MUTR]: 'Fidelity of DNA copying (higher means more mutations per division).',
  [Gn.HUE]: 'A neutral pigment gene that drifts randomly: a molecular clock for lineages.',
  [Gn.LIFESPAN]: 'Maintenance and repair investment: longer life at a small upkeep cost.',
  [Gn.COLMAX]: 'How large a colony may grow before it fragments.',
  [Gn.W_LIGHT]: 'Phototaxis: swim toward (+) or away from (−) light.',
  [Gn.W_CHEM]: 'Chemotaxis toward (+) or away from (−) vent chemicals.',
  [Gn.W_ORG]: 'Chemotaxis toward organic matter.',
  [Gn.W_PREY]: 'Hunting drive: steer toward smaller cells.',
  [Gn.W_FLEE]: 'Escape drive: steer away from predators.',
  [Gn.W_OXY]: 'Aerotaxis: swim toward (+) or away from (−) oxygen.',
};
const DIFF_INPUTS = ['bias', 'number of neighbours', 'distance from founder cell', 'colony size', 'light'];

// ------------------------------------------------------------------ helpers
export function sel(kind, obj, extra = {}) { return { kind, obj, follow: true, ...extra }; }

// A point that moves with its parent; pos() returns {x, y} in world units.
function anchored(pos, r, isDead) {
  return { get x() { return pos().x; }, get y() { return pos().y; }, r, get dead() { return isDead(); } };
}

function part(label, obj, info, extra = {}) {
  return sel('part', obj, { label, info, ...extra });
}

// Point (lx, ly) in nm inside a frame {x, y, ang}.
function inFrame(f, lx, ly) {
  const c = Math.cos(f.ang), s = Math.sin(f.ang);
  return { x: f.x + (lx * c - ly * s) * NM, y: f.y + (lx * s + ly * c) * NM };
}

// Field of view (nm) that frames an object of radius r (world units) nicely.
export function fovFor(s) {
  const r = s.obj.r || s.obj._rad || 1 * NM;
  return Math.max(6, r * NM_PER_UNIT * 2 * 3.5);
}

// ------------------------------------------------------------ molecules
// A molecule (free, in a polymer, in a membrane or in a pool), positioned by a frame function.
export function molecule(t, frame, isDead, parent, extra = {}) {
  const r = (t === LIPID ? 1.0 : 0.7) * NM;
  const obj = anchored(() => inFrame(frame(), 0, t === LIPID ? 0.9 : 0.5), r, isDead);
  return sel('molecule', obj, { label: t === LIPID ? 'Fatty acid' : `${BASES[t]} · ${NT_INFO[t].base}`, t, frame, parent, ...extra });
}

function moleculeParts(s) {
  const { t, frame } = s, dead = () => s.obj.dead;
  const at = (lx, ly, r) => anchored(() => inFrame(frame(), lx, ly), r * NM, dead);
  if (s.phospho) {
    return [
      part('Phosphate head (choline)', at(0, 0, 0.35), { title: 'Polar head: phosphate + choline', kv: [['Size', '≈ 0.8 nm'], ['Character', 'hydrophilic']], desc: 'The charged phosphate group (with a small alcohol such as choline or ethanolamine) faces the water.' }, { parent: s }),
      part('Glycerol backbone', at(0, 0.45, 0.25), { title: 'Glycerol backbone (C₃)', kv: [], desc: 'Links the head to the two tails via ester bonds (ether bonds in archaea).' }, { parent: s }),
      part('Two fatty-acid tails', at(0, 1.3, 0.8), { title: 'Two hydrocarbon tails (C₁₆–C₁₈)', kv: [['Length', '≈ 2 nm']], desc: 'Twice the tails of a prebiotic fatty acid make a much tighter, less leaky membrane, good enough to hold ion gradients.' }, { parent: s }),
    ];
  }
  if (t === LIPID) {
    return [
      part('Carboxyl head', at(0, 0, 0.35), { title: 'Carboxyl head group (–COOH)', kv: [['Size', '≈ 0.3 nm'], ['Character', 'hydrophilic (water-loving)']], desc: 'Ionises to –COO⁻ in water. In a membrane the heads face the water on both sides.' }, { parent: s }),
      part('Hydrocarbon tail', at(0, 1.1, 0.8), { title: 'Hydrocarbon tail (C₉H₁₉)', kv: [['Length', '≈ 1.2 nm'], ['Character', 'hydrophobic (water-fearing)']], desc: 'Tails hide from water by pairing up inside the membrane. That is what makes fatty acids assemble into vesicles by themselves.' }, { parent: s }),
    ];
  }
  const n = NT_INFO[t];
  return [
    part('Phosphate group', at(0, 0, 0.3), { title: 'Phosphate group (PO₄)', kv: [['Size', '≈ 0.3 nm'], ['Charge', 'negative']], desc: 'In a chain, each phosphate bridges the sugars of two neighbouring nucleotides (a phosphodiester bond), forming the RNA backbone.' }, { parent: s }),
    part('Ribose sugar', at(0, 0.38, 0.28), { title: 'Ribose (C₅H₁₀O₅)', kv: [['Size', '≈ 0.5 nm'], ['Ring', 'five-membered']], desc: 'A five-carbon sugar. Its extra 2′-OH group (absent in DNA) lets RNA fold into shapes that catalyse reactions.' }, { parent: s }),
    part(`${n.base} base`, at(0, 0.9, 0.4), { title: `${n.base} (${n.baseFormula})`, kv: [['Type', n.ring], ['Pairs with', n.pair], ['Size', '≈ 0.6 nm']], desc: `The information-carrying part. ${n.base} pairs with ${n.pair} through hydrogen bonds, which is how RNA templates its own copies.` }, { parent: s }),
  ];
}

function moleculeInfo(s) {
  if (s.phospho) {
    return { title: 'Phospholipid (e.g. phosphatidylcholine)', kv: [['Length', '≈ 2.5 nm'], ['Area in membrane', '≈ 0.65 nm²'], ['Tails', 'two']], desc: 'The building block of modern cell membranes. Cells evolved these from the simpler fatty acids of protocells.' };
  }
  if (s.t === LIPID) {
    return { title: 'Fatty acid (decanoic acid, C₁₀H₂₀O₂)', kv: [['Length', '≈ 1.5 nm'], ['Head', 'carboxyl (hydrophilic)'], ['Tail', 'hydrocarbon (hydrophobic)']], desc: 'A simple amphiphile likely present in the prebiotic ocean. In water such molecules self-assemble into bilayer membranes 4 nm thick.' };
  }
  const n = NT_INFO[s.t];
  return { title: n.name, kv: [['Formula', n.formula], ['Size', '≈ 1 nm'], ['Base', `${n.base} (${n.ring})`], ['Pairs with', n.pair]], desc: 'An RNA building block: phosphate + ribose sugar + nucleobase. Free nucleotides are drawn from the soup by replicators and protocells.' };
}

// ------------------------------------------------------------- polymers
function polymerFrame(p) { return { x: p._rx ?? p.x, y: p._ry ?? p.y, ang: p._drawAng ?? p.ang }; }

function nucleotideIn(p, i, renderer, parent) {
  const frame = () => {
    const lay = renderer.layout(p), q = lay.pts[Math.min(i, lay.pts.length - 1)];
    const f = polymerFrame(p), pos = inFrame(f, q[0], q[1]);
    return { x: pos.x, y: pos.y, ang: f.ang + Math.atan2(q[3], q[2]) - Math.PI / 2 };
  };
  return molecule(p.seq[i], frame, () => p.dead || i >= p.seq.length, parent, { label: `${i + 1}. ${BASES[p.seq[i]]} · ${NT_INFO[p.seq[i]].base}`, polymer: p, index: i });
}

function polymerParts(s, renderer) {
  const p = s.obj, lay = renderer.layout(p), out = [];
  if (p.prog > 0) {
    out.push(part(`Daughter strand (${p.prog}/${p.seq.length})`, anchored(() => p, s.obj._rad || 0.01, () => p.dead), {
      title: 'Daughter strand being copied',
      kv: [['Copied so far', `${p.prog} of ${p.seq.length} bases`], ['Copy fidelity', `${(p.fid * 100).toFixed(1)}% per base`]],
      desc: `The ribozyme is building a copy of itself, one nucleotide at a time, from free nucleotides: ${p.copy.map((b) => BASES[b]).join('')}…`,
    }, { parent: s }));
  }
  if (lay.pairs.length) {
    out.push(part('Hairpin stem', anchored(() => p, s.obj._rad || 0.01, () => p.dead), {
      title: 'Hairpin fold',
      kv: [['Stem pairs', String(lay.pairs.length)], ['Loop', `${p.seq.length - lay.pairs.length * 2} nt`]],
      desc: 'Complementary ends of the chain zip together, folding it into a shape. Folding is what turns an inert chain into a catalyst (ribozyme).',
    }, { parent: s }));
  }
  for (let i = 0; i < p.seq.length; i++) out.push(nucleotideIn(p, i, renderer, s));
  return out;
}

// --------------------------------------------------------------- membranes
function membraneLipid(cx, cy, R, theta, isDead, parent, label, phospho = false) {
  const hr = DIM.lipidHead * NM;
  const frame = () => { const c = { x: cx(), y: cy() }; return { x: c.x + Math.cos(theta) * (R() - hr), y: c.y + Math.sin(theta) * (R() - hr), ang: theta + Math.PI / 2 }; };
  return molecule(LIPID, frame, isDead, parent, { label, phospho });
}

function lipidCount(rUnits, areaPerLipid) {
  const rNm = rUnits * NM_PER_UNIT;
  const n = (2 * 4 * Math.PI * rNm * rNm) / areaPerLipid;
  return n.toExponential(1).replace('e+', ' × 10^');
}

// --------------------------------------------------------------- vesicles
function vesicleParts(s, renderer) {
  const v = s.obj, dead = () => v.dead, out = [];
  const mem = part('Fatty-acid bilayer membrane', anchored(() => ({ x: v.x + v.r, y: v.y }), DIM.bilayer * NM * 3, dead), {
    title: 'Fatty-acid bilayer',
    kv: [['Thickness', '≈ 4 nm'], ['Diameter', um(v.r * 2)], ['Molecules (3D estimate)', lipidCount(v.r, 0.3)]],
    desc: 'Two layers of fatty acids, tails inward. Leaky enough to let nucleotides diffuse in, tight enough to keep RNA chains trapped.',
  }, { parent: s, ring: { c: v, phospho: false, label: 'A fatty acid in the membrane' } });
  mem.kids = () => [membraneLipid(() => v.x, () => v.y, () => v.r, 0, dead, mem, 'A fatty acid in the membrane')];
  out.push(mem);
  for (const p of v.polys) {
    out.push(sel('polymer', p, { parent: s, label: `RNA, ${p.seq.length} nt${p.act > 0 ? ' · ribozyme' : ''}`, note: p.act > 0 ? `${(p.act * 100).toFixed(0)}% active` : '' }));
  }
  const inner = () => v.r - DIM.bilayer * NM;
  for (let t = 0; t < 4; t++) {
    if (!v.pool[t]) continue;
    const g = part(`Free ${BASES[t]} nucleotides`, anchored(() => v, v.r * 0.6, dead), {
      title: `Pool of ${NT_INFO[t].name}`, kv: [['Count (simulated)', String(v.pool[t])]],
      desc: 'Nucleotides that diffused in through the membrane, waiting to be built into RNA.',
    }, { parent: s, group: true, note: `×${v.pool[t]}` });
    g.kids = () => {
      const out2 = [];
      for (let k = 0; k < Math.min(v.pool[t], 5); k++) {
        // Same positions the renderer uses for pool molecules.
        const seed = (v.id * 7919 + t * 131 + k * 17) >>> 0;
        const frame = () => {
          const r = renderer.rngFor(seed), a = r.next() * TAU, rr = Math.sqrt(r.next()) * 0.85;
          return { x: v.x + Math.cos(a) * rr * inner(), y: v.y + Math.sin(a) * rr * inner(), ang: r.next() * TAU };
        };
        out2.push(molecule(t, frame, dead, g));
      }
      return out2;
    };
    out.push(g);
  }
  return out;
}

// ------------------------------------------------------------------ cells
function cellParts(s, world, renderer) {
  const c = s.obj, a = renderer.anatomy(c), dead = () => c.dead, out = [];
  const at = (fx, fy, r) => anchored(() => ({ x: c.x + fx * c.r, y: c.y + fy * c.r }), r, dead);
  const volUm3 = (4 / 3) * Math.PI * Math.pow(c.r * 0.5, 3);

  const mem = part('Plasma membrane', anchored(() => ({ x: c.x + c.r, y: c.y }), DIM.bilayer * NM * 3, dead), {
    title: 'Plasma membrane (phospholipid bilayer)',
    kv: [['Thickness', '≈ 4 nm'], ['Lipid molecules (estimate)', lipidCount(c.r, 0.65)]],
    desc: 'Phospholipids with two tails each, studded with transport and energy proteins. It holds the proton gradient that powers ATP synthesis.',
  }, { parent: s, ring: { c, phospho: true, label: 'A phospholipid in the membrane' } });
  mem.kids = () => [membraneLipid(() => c.x, () => c.y, () => c.r, 0, dead, mem, 'A phospholipid in the membrane', true)];
  out.push(mem);

  const armor = c.armor * (c.type === 4 ? 3 : 1);
  if (armor > 0.15) {
    out.push(part('Cell wall', anchored(() => ({ x: c.x - c.r, y: c.y }), (20 + armor * 80) * NM * 2, dead), {
      title: c.mito ? 'Pellicle / cell wall' : 'Cell wall (peptidoglycan)',
      kv: [['Thickness', formatLen(20 + armor * 80)], ['Armor gene', c.armor.toFixed(2)]],
      desc: 'A tough mesh outside the membrane that resists bursting and makes the cell harder for predators to digest.',
    }, { parent: s }));
  }

  out.push(part('Cytoplasm', at(0.6, 0.3, c.r * 0.3), {
    title: 'Cytoplasm',
    kv: [['Volume', `${volUm3.toFixed(1)} µm³`], ['Energy stored', `${c.energy.toFixed(1)} / ${c.cap.toFixed(0)}`], ['Nutrient', `${c.nut.toFixed(2)} / ${c.nutNeed.toFixed(2)}`],
      ['Protein machinery', `${Math.round(c.transl * 100)}%`], ...(c.infected ? [['Infected by virus lineage', `#${c.infected.lineage}`]] : [])],
    desc: 'A crowded gel of water (~70%), proteins, RNA and metabolites, where the chemistry of life happens.',
  }, { parent: s }));

  // Genetic material.
  const genome = part(c.mito ? 'Chromosomes (genome)' : c.dna ? 'Chromosome (nucleoid)' : 'RNA genome', at(c.mito ? a.nuc.fx * 0.34 : 0, c.mito ? a.nuc.fy * 0.34 : 0, c.r * (c.mito ? 0.25 : 0.46)), {
    title: c.mito ? 'Chromatin: DNA wound on nucleosomes' : c.dna ? 'Circular DNA chromosome (nucleoid)' : 'RNA genome (RNA-world cell)',
    kv: [['Genome', c.dna ? 'DNA, double-stranded, proofread' : 'RNA, single-stranded, error-prone'], ['Width', c.mito ? '30 nm fibre / 11 nm nucleosomes' : c.dna ? '2 nm' : '≈ 1 nm'],
      ['Simulated genes', String(Gn.NG)], ['Generation', String(c.gen)], ['Mutation rate gene', c.g[Gn.MUTR].toFixed(2)]],
    desc: c.dna
      ? 'The genome, stored as DNA. Its genes set every trait of the cell; each division copies it, with occasional mutations. Real chromosomes are hundreds of times longer than the cell; this tangle is scaled down.'
      : 'This early cell still keeps its genes in RNA, a leftover of the RNA world. RNA is fragile and copied sloppily; lineages that switch to DNA mutate less.',
  }, { parent: s, genomeOf: c });
  genome.kids = () => geneGroups(c, genome);

  if (c.mito) {
    const nuc = part('Nucleus', at(0, 0, c.r * 0.34), {
      title: 'Nucleus', kv: [['Diameter', um(c.r * 0.68)], ['Envelope', 'two membranes, 30 nm apart']],
      desc: 'Walls the genome off from the cytoplasm, a defining feature of eukaryotes.',
    }, { parent: s, nucleusOf: c });
    genome.parent = nuc; // in eukaryotes the genome lives inside the nucleus
    nuc.kids = () => [
      part('Nuclear envelope & pores', at(0.34, 0, DIM.nuclearPore * NM), { title: 'Nuclear envelope', kv: [['Pore diameter', '≈ 100 nm'], ['Gap between membranes', '≈ 30 nm']], desc: 'A double membrane perforated by pore complexes, gates that let RNA out and proteins in.' }, { parent: nuc }),
      part('Nucleolus', at(a.nuc.fx * 0.34, a.nuc.fy * 0.34, c.r * 0.1), { title: 'Nucleolus', kv: [['Diameter', um(c.r * 0.2)]], desc: 'Dense region where ribosomal RNA is made and ribosomes are assembled.' }, { parent: nuc }),
      genome,
    ];
    out.push(nuc);
  } else {
    out.push(genome);
  }

  // Ribosomes.
  const nRib = a.ribo.length / 2;
  const ribs = part('Ribosomes', at(a.ribo[0] || 0, a.ribo[1] || 0, c.r * 0.5), {
    title: `Ribosomes (${c.mito ? '80S' : '70S'})`,
    kv: [['Size', c.mito ? '≈ 25–30 nm' : '≈ 22 nm'], ['In this cell (estimate)', `≈ ${Math.round(volUm3 * 20000).toLocaleString()}`], ['Drawn (2D slice)', String(nRib)]],
    desc: 'Molecular machines that read messenger RNA and build proteins. They are largely made of RNA, a living echo of the RNA world.',
  }, { parent: s, group: true, note: `≈ ${Math.round(volUm3 * 20000).toLocaleString()}` });
  ribs.kids = () => {
    const list = [];
    for (let k = 0; k < Math.min(nRib, 8); k++) list.push(ribosome(c, k, at, ribs));
    return list;
  };
  out.push(ribs);

  if (a.thyl) {
    out.push(part('Thylakoid membranes', at(0.72, 0, c.r * 0.1), {
      title: 'Thylakoid membranes', kv: [['Spacing', '≈ 50 nm'], ['Photosynthesis gene', c.g[Gn.PHOTO].toFixed(2)]],
      desc: 'Internal membranes packed with chlorophyll and photosystems that turn light into chemical energy, as in cyanobacteria.',
    }, { parent: s }));
  }

  if (c.mito) {
    out.push(part('Endoplasmic reticulum', at(a.er[0].rr * Math.cos(a.er[0].a0), a.er[0].rr * Math.sin(a.er[0].a0), c.r * 0.1), {
      title: 'Endoplasmic reticulum', kv: [['Tubule width', '≈ 50 nm']], desc: 'A folded membrane network continuous with the nuclear envelope; rough ER is studded with ribosomes making proteins for export.',
    }, { parent: s }));
    const mg = part(`Mitochondria`, at(a.mitos[0].fx, a.mitos[0].fy, c.r * 0.5), {
      title: 'Mitochondria', kv: [['Count (drawn)', String(a.mitos.length)], ['Aerobic gene', c.aer.toFixed(2)]],
      desc: 'Descendants of an aerobic bacterium engulfed by this lineage’s ancestor (endosymbiosis). They burn food with oxygen for far more energy.',
    }, { parent: s, group: true, note: `×${a.mitos.length}` });
    mg.kids = () => a.mitos.map((m, k) => mitochondrion(c, m, k, at, mg));
    out.push(mg);
    if (a.plast.length) {
      const pg = part('Chloroplasts', at(a.plast[0].fx, a.plast[0].fy, c.r * 0.5), {
        title: 'Chloroplasts', kv: [['Count (drawn)', String(a.plast.length)]],
        desc: 'Descendants of a photosynthetic bacterium kept by a eukaryote: this lineage is an alga.',
      }, { parent: s, group: true, note: `×${a.plast.length}` });
      pg.kids = () => a.plast.map((p, k) => chloroplast(c, p, k, at, pg));
      out.push(pg);
    }
  }

  if (c.motil > 0.3) {
    const len = Math.min(20, c.r * 5);
    const fpos = () => {
      const sp = Math.hypot(c.vx, c.vy);
      let ux = -Math.cos(c.heading), uy = -Math.sin(c.heading);
      if (sp > 0.02) { ux = -c.vx / sp; uy = -c.vy / sp; }
      return { x: c.x + ux * (c.r + len * 0.3), y: c.y + uy * (c.r + len * 0.3) };
    };
    const fl = part('Flagellum', anchored(fpos, len * 0.3, dead), c.mito ? {
      title: 'Eukaryotic flagellum (undulipodium)', kv: [['Length', um(len)], ['Width', '≈ 250 nm'], ['Motility gene', c.motil.toFixed(2)]],
      desc: 'A whip of 9+2 microtubules that bends by dynein motors, a completely different machine from the bacterial flagellum.',
    } : {
      title: 'Bacterial flagellum', kv: [['Length', um(len)], ['Filament width', '≈ 20 nm'], ['Motility gene', c.motil.toFixed(2)]],
      desc: 'A rigid helical propeller spun at hundreds of revolutions per second by a rotary motor in the membrane.',
    }, { parent: s });
    if (!c.mito) {
      fl.kids = () => [
        part('Rotary motor (basal body)', at(-1, 0, 45 * NM), { title: 'Basal body motor', kv: [['Diameter', '≈ 45 nm'], ['Power', 'proton flow across the membrane']], desc: 'A true rotary engine of about 20 protein types, spinning the hook and filament.' }, { parent: fl }),
        part('Hook', at(-1.05, 0, 30 * NM), { title: 'Hook', kv: [['Length', '≈ 55 nm']], desc: 'A flexible universal joint between motor and filament.' }, { parent: fl }),
        part('Filament (flagellin)', anchored(fpos, 20 * NM, dead), { title: 'Filament', kv: [['Width', '≈ 20 nm'], ['Made of', 'thousands of flagellin proteins']], desc: 'The helical propeller itself.' }, { parent: fl }),
      ];
    }
    out.push(fl);
  }

  // Junctions to neighbouring cells in the same organism.
  if (c.bonds.length) {
    const jg = part(`Cell junctions (${c.bonds.length})`, at(0.9, 0, c.r * 0.2), {
      title: 'Cell–cell junctions', kv: [['Neighbours', String(c.bonds.length)], ['Sharing gene', c.share.toFixed(2)]],
      desc: 'Adhesion between daughter cells that never fully separated. Cytoplasmic bridges let energy and nutrients flow between them.',
    }, { parent: s });
    jg.kids = () => c.bonds.map((o) => sel('cell', o, { label: `Neighbour cell #${o.id}`, note: TYPE_NAMES[o.type] }));
    out.push(jg);
  }
  return out;
}

function ribosome(c, k, at, parent) {
  const a = c._anat, fx = a.ribo[k * 2], fy = a.ribo[k * 2 + 1];
  const r = (DIM.ribosome * NM) / 2;
  const rb = part(`Ribosome ${k + 1}`, at(fx, fy, r), {
    title: c.mito ? '80S ribosome' : '70S ribosome',
    kv: [['Diameter', c.mito ? '≈ 25 nm' : '≈ 22 nm'], ['Mass', c.mito ? '≈ 4.3 MDa' : '≈ 2.5 MDa'], ['RNA content', '≈ 60%']],
    desc: 'Two subunits clamp a messenger RNA. The catalytic heart that joins amino acids is made of RNA, not protein.',
  }, { parent });
  rb.kids = () => [
    part(c.mito ? 'Large subunit (60S)' : 'Large subunit (50S)', at(fx, fy, r * 0.8), { title: 'Large subunit', kv: [['Contains', c.mito ? '28S, 5.8S, 5S rRNA + ~47 proteins' : '23S + 5S rRNA + ~33 proteins']], desc: 'Holds the peptidyl-transferase centre, a ribozyme that forges peptide bonds.' }, { parent: rb }),
    part(c.mito ? 'Small subunit (40S)' : 'Small subunit (30S)', anchored(() => { const p = at(fx, fy, 0); return { x: p.x + r * 0.5, y: p.y - r * 0.5 }; }, r * 0.6, () => c.dead), { title: 'Small subunit', kv: [['Contains', c.mito ? '18S rRNA + ~33 proteins' : '16S rRNA + ~21 proteins']], desc: 'Reads the messenger RNA codon by codon.' }, { parent: rb }),
  ];
  return rb;
}

function mitochondrion(c, m, k, at, parent) {
  const L = Math.min((DIM.mitoLen * NM) * m.s, c.r * 0.5);
  const mt = part(`Mitochondrion ${k + 1}`, at(m.fx, m.fy, L / 2), {
    title: 'Mitochondrion', kv: [['Length', um(L)], ['Membranes', 'outer + folded inner']],
    desc: 'The cell’s power plant: pumps protons across its inner membrane and lets them flow back through ATP synthase.',
  }, { parent });
  mt.kids = () => [
    part('Outer membrane', at(m.fx, m.fy, L / 2), { title: 'Outer membrane', kv: [['Thickness', '≈ 7 nm']], desc: 'Smooth and porous: a remnant of the ancestral bacterium’s outer envelope.' }, { parent: mt }),
    part('Inner membrane & cristae', at(m.fx, m.fy, L / 3), { title: 'Inner membrane (cristae)', kv: [['Holds', 'electron transport chain, ATP synthase']], desc: 'Folded into cristae to pack in more respiratory machinery.' }, { parent: mt }),
    part('Matrix', at(m.fx, m.fy, L / 5), { title: 'Matrix', kv: [], desc: 'Interior where the citric-acid cycle runs.' }, { parent: mt }),
    part('Mitochondrial DNA', at(m.fx, m.fy, L / 8), { title: 'mtDNA', kv: [['Form', 'small circular chromosome']], desc: 'Its own little genome, proof of its bacterial origin.' }, { parent: mt }),
  ];
  return mt;
}

function chloroplast(c, p, k, at, parent) {
  const L = Math.min(8, c.r * 0.75);
  const cp = part(`Chloroplast ${k + 1}`, at(p.fx, p.fy, L / 2), {
    title: 'Chloroplast', kv: [['Length', um(L)]], desc: 'Captures sunlight; releases oxygen as a by-product.',
  }, { parent });
  cp.kids = () => [
    part('Thylakoid grana', at(p.fx, p.fy, L / 6), { title: 'Grana (stacked thylakoids)', kv: [['Disc diameter', '≈ 0.5 µm']], desc: 'Stacks of membrane discs carrying chlorophyll and photosystems I and II.' }, { parent: cp }),
    part('Stroma', at(p.fx, p.fy, L / 3), { title: 'Stroma', kv: [], desc: 'Fluid where the Calvin cycle fixes CO₂ into sugar.' }, { parent: cp }),
    part('Chloroplast DNA', at(p.fx, p.fy, L / 10), { title: 'cpDNA', kv: [['Form', 'circular']], desc: 'Inherited from the engulfed cyanobacterium.' }, { parent: cp }),
  ];
  return cp;
}

function geneGroups(c, parent) {
  const groups = [
    ['Metabolism & body genes', [Gn.SIZE, Gn.PHOTO, Gn.CHEMO, Gn.HETERO, Gn.PRED, Gn.AEROBIC, Gn.ARMOR, Gn.LIFESPAN, Gn.DIVTH, Gn.MUTR, Gn.HUE]],
    ['Behaviour genes', [Gn.MOTIL, Gn.W_LIGHT, Gn.W_CHEM, Gn.W_ORG, Gn.W_OXY, Gn.W_PREY, Gn.W_FLEE]],
    ['Multicellularity genes', [Gn.ADHES, Gn.SHARE, Gn.COLMAX]],
  ];
  const out = groups.map(([name, idx]) => {
    const g = part(name, parent.obj, { title: name, kv: [['Genes', String(idx.length)]], desc: 'Click a gene to see its value and what it does.' }, { parent, note: String(idx.length) });
    g.kids = () => idx.map((i) => gene(c, i, g));
    return g;
  });
  const dev = part('Cell-fate network genes', parent.obj, { title: 'Gene-regulatory network for cell fate', kv: [['Genes', String(Gn.NTYPES * Gn.NDIFF_IN)]], desc: 'Inside a colony, each cell weighs these cues to decide what it becomes: generalist, feeder, motor, mouth, armor or germline.' }, { parent, note: String(Gn.NTYPES * Gn.NDIFF_IN) });
  dev.kids = () => {
    const list = [];
    for (let t = 0; t < Gn.NTYPES; t++) for (let k = 0; k < Gn.NDIFF_IN; k++) list.push(gene(c, Gn.DIFF + t * Gn.NDIFF_IN + k, dev, `${TYPE_NAMES[t]} ← ${DIFF_INPUTS[k]}`));
    return list;
  };
  out.push(dev);
  return out;
}

function gene(c, i, parent, name) {
  const v = c.g[i];
  const label = name || Gn.GENE_NAMES[i];
  return part(label, parent.obj, {
    title: `Gene: ${label}`,
    kv: [['Value', v.toFixed(3)], ['Range', i >= Gn.FIRST_SIGNED ? '−1 … 1' : '0 … 1'], ['Locus', `#${i}`]],
    desc: name ? `A weight in the cell-fate network: how strongly “${DIFF_INPUTS[(i - Gn.DIFF) % Gn.NDIFF_IN]}” pushes the cell toward becoming a ${TYPE_NAMES[Math.floor((i - Gn.DIFF) / Gn.NDIFF_IN)]} cell.` : GENE_DESC[i],
    gene: i,
  }, { parent, note: v.toFixed(2) });
}

// ------------------------------------------------------------- organisms
export function organismOf(cell, world) {
  const id = cell.org;
  const members = () => world.life.cells.filter((c) => c.org === id && !c.dead);
  const obj = {
    get x() { const m = members(); return m.length ? m.reduce((a, c) => a + c.x, 0) / m.length : cell.x; },
    get y() { const m = members(); return m.length ? m.reduce((a, c) => a + c.y, 0) / m.length : cell.y; },
    get r() { const m = members(); if (!m.length) return cell.r; const x = this.x, y = this.y; return Math.max(...m.map((c) => Math.hypot(c.x - x, c.y - y) + c.r)); },
    get dead() { return members().length < 2; },
  };
  return sel('organism', obj, { id, members, label: `Organism #${id}` });
}

function organismParts(s, world) {
  const m = s.members();
  const byType = new Map();
  for (const c of m) { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
  return [...byType.entries()].map(([t, cells]) => {
    const g = part(`${TYPE_NAMES[t]} cells`, anchored(() => cells[0], cells[0].r, () => cells[0].dead), {
      title: `${TYPE_NAMES[t]} cells`, kv: [['Count', String(cells.length)]], desc: FATE_DESC[t],
    }, { parent: s, group: true, note: `×${cells.length}` });
    g.kids = () => cells.map((c) => sel('cell', c, { parent: s, label: `Cell #${c.id}`, note: `${c.bonds.length} junctions` }));
    return g;
  });
}

const FATE_DESC = [
  'Undifferentiated cells that do a bit of everything.',
  'Feeding specialists: double the cell’s own metabolism (photosynthesis, chemosynthesis or absorption) and give up motility.',
  'Motor cells with strong flagella that move the whole organism.',
  'Mouth cells specialised for absorbing food and engulfing prey.',
  'Armor cells with thick walls that protect the organism.',
  'Germline cells: they draw energy from the body and bud off to found the next generation.',
];

function organismInfo(s, world) {
  const m = s.members(), types = [0, 0, 0, 0, 0, 0];
  for (const c of m) types[c.type]++;
  const o = world.life.organisms.find((x) => x.id === s.id);
  return {
    title: `Organism #${s.id}`,
    kv: [['Cells', String(m.length)], ['Span', um(s.obj.r * 2)], ['Classification', o ? o.kind : 'colony'], ['Cell types', types.map((n, t) => (n ? `${TYPE_NAMES[t]} ${n}` : '')).filter(Boolean).join(', ')]],
    desc: 'A body of bonded cells that descend from one founder. Selection now acts on the whole organism, not just on single cells.',
  };
}

// ------------------------------------------------------------------ viruses
function virusParts(s) {
  const v = s.obj, dead = () => !!v.dead;
  const at = (lx, ly, r) => anchored(() => inFrame({ x: v.x, y: v.y, ang: v.ang }, lx, ly), r * NM, dead);
  return [
    part('Capsid (protein shell)', at(0, 0, 50), { title: 'Icosahedral capsid', kv: [['Diameter', '≈ 100 nm'], ['Made of', 'hundreds of copies of a few proteins']], desc: 'A geometric protein shell that protects the viral genome outside a host.' }, { parent: s }),
    part('Viral genome', at(0, 0, 30), { title: 'Packed viral genome', kv: [['Size', 'tens of kilobases'], ...(v.cargo ? [['Carrying host gene', Gn.GENE_NAMES[v.cargo.i] || `#${v.cargo.i}`]] : [])], desc: 'Just enough genes to make more viruses. Sometimes it carries a stolen host gene into the next host.' }, { parent: s }),
    part('Tail', at(0, 100, 50), { title: 'Contractile tail', kv: [['Length', '≈ 110 nm']], desc: 'Contracts like a syringe to inject the genome through the host’s envelope.' }, { parent: s }),
    part('Tail fibres', at(0, 190, 35), { title: 'Tail fibres (receptor-binding proteins)', kv: [['Binding key', `${v.k1.toFixed(2)} / ${v.k2.toFixed(2)}`]], desc: 'They grab the host only if its surface receptors have the matching shape. Hosts escape by mutating their receptors; viruses follow.' }, { parent: s }),
  ];
}

function virusInfo(s) {
  const v = s.obj;
  return {
    title: `Virus (phage) · lineage #${v.lineage}`,
    kv: [['Size', '≈ 100 nm head, 200 nm tail'], ['Binding key', `${v.k1.toFixed(2)} / ${v.k2.toFixed(2)}`], ['Age', `${v.age} ticks`], ['Carries host gene', v.cargo ? (Gn.GENE_NAMES[v.cargo.i] || `#${v.cargo.i}`) : 'no']],
    desc: 'Not alive on its own: a packaged genome that drifts until it meets a cell with matching receptors, takes it over, and bursts it to release ~10–40 copies.',
  };
}

// A base pair in a drawn chromosome near point p (only when the double helix is visible).
function basePairAt(gs, p, tol, renderer) {
  const c = gs.genomeOf, a = renderer.anatomy(c);
  const euk = c.mito, pts = euk ? a.chrom : a.dna, R = euk ? c.r * 0.34 : c.r;
  let best = null, bd = Infinity;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const x1 = c.x + pts[k] * R, y1 = c.y + pts[k + 1] * R, x2 = c.x + pts[k + 2] * R, y2 = c.y + pts[k + 3] * R;
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-12;
    const f = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / L2));
    const d = Math.hypot(x1 + dx * f - p.x, y1 + dy * f - p.y);
    if (d < bd) { bd = d; best = { k, f, L: Math.sqrt(L2) / NM, x: x1 + dx * f, y: y1 + dy * f }; }
  }
  if (!best || bd > 2 * NM + tol) return null;
  const NAMES = ['A', c.dna ? 'T' : 'U', 'G', 'C'];
  const FULL = ['Adenine', c.dna ? 'Thymine' : 'Uracil', 'Guanine', 'Cytosine'];
  const spacing = c.dna ? 0.34 : DIM.ntRise, i = Math.round((best.f * best.L) / spacing);
  const b = dnaBase(c.id, best.k, i);
  const pos = { x: best.x, y: best.y };
  const dead = () => c.dead;
  if (!c.dna) {
    return part(`RNA base ${NAMES[b]}`, anchored(() => pos, 0.6 * NM, dead), { title: `${FULL[b]} in the RNA genome`, kv: [['Rise', '0.59 nm per base']], desc: 'A single strand: there is no partner to check copying errors against.' }, { parent: gs });
  }
  const pair = b === 0 ? 1 : b === 1 ? 0 : b === 2 ? 3 : 2;
  const bp = part(`Base pair ${NAMES[b]}–${NAMES[pair]}`, anchored(() => pos, 1 * NM, dead), {
    title: `DNA base pair ${NAMES[b]}–${NAMES[pair]}`,
    kv: [['Hydrogen bonds', b >= 2 ? '3 (G–C)' : '2 (A–T)'], ['Rise', '0.34 nm per base pair'], ['Helix', '10.5 bp per turn, 2 nm wide']],
    desc: 'One rung of the double helix. Each strand is a template for the other, so errors can be detected and repaired.',
  }, { parent: gs });
  bp.kids = () => [
    part(`${FULL[b]} (strand 1)`, anchored(() => pos, 0.5 * NM, dead), { title: FULL[b], kv: [['Type', b === 0 || b === 2 ? 'purine' : 'pyrimidine']], desc: 'Read by the cell three bases at a time.' }, { parent: bp }),
    part(`${FULL[pair]} (strand 2)`, anchored(() => pos, 0.5 * NM, dead), { title: FULL[pair], kv: [['Type', pair === 0 || pair === 2 ? 'purine' : 'pyrimidine']], desc: 'The complementary partner on the opposite strand.' }, { parent: bp }),
    part('Deoxyribose–phosphate backbone', anchored(() => pos, 0.9 * NM, dead), { title: 'Sugar–phosphate backbone', kv: [['Sugar', 'deoxyribose (no 2′-OH)']], desc: 'Missing one oxygen compared with RNA’s ribose, which makes DNA far more chemically stable.' }, { parent: bp }),
  ];
  return bp;
}

// ------------------------------------------------------------- public API
export function children(s, world, renderer) {
  if (s.gone) return [];
  switch (s.kind) {
    case 'organism': return organismParts(s, world);
    case 'cell': return cellParts(s, world, renderer);
    case 'vesicle': return vesicleParts(s, renderer);
    case 'polymer': return polymerParts(s, renderer);
    case 'molecule': return moleculeParts(s);
    case 'virus': return virusParts(s);
    case 'part': return s.kids ? s.kids() : [];
  }
  return [];
}

export function info(s, world) {
  if (s.kind === 'part') return s.info;
  if (s.kind === 'molecule') return moleculeInfo(s);
  if (s.kind === 'organism') return organismInfo(s, world);
  if (s.kind === 'virus') return virusInfo(s);
  return null;
}

// Chain of enclosing selections, outermost first.
export function ancestors(s, world) {
  const chain = [];
  let p = s.parent;
  let last = s;
  while (p) { chain.unshift(p); last = p; p = p.parent; }
  if (last.kind === 'cell' && last.obj.orgSize > 1 && !last.obj.dead) chain.unshift(organismOf(last.obj, world));
  return chain;
}

export function crumbLabel(s) {
  if (s.label) return s.label;
  if (s.kind === 'cell') return `Cell #${s.obj.id}`;
  if (s.kind === 'vesicle') return s.obj.polys.some((p) => p.act > 0) ? 'Protocell' : 'Vesicle';
  if (s.kind === 'polymer') return `RNA ${s.obj.seq.length} nt`;
  if (s.kind === 'virus') return `Virus #${s.obj.id}`;
  return s.kind;
}

// ---------------------------------------------------------- nested picking
// Selection works like nested groups: the first click selects the outermost thing; clicking again
// inside the current selection goes one level deeper (list-only groups are skipped); clicking inside
// an ancestor selects the sibling under the cursor; clicking outside starts over.

const flatten = (kids) => kids.flatMap((k) => (k.group && k.kids ? k.kids() : [k]));
const dist = (s, p) => Math.hypot(s.obj.x - p.x, s.obj.y - p.y);
const radius = (s) => s.obj.r ?? s.obj._rad ?? 0;

function smallestHit(cands, p, tol, maxR = Infinity) {
  let best = null, br = Infinity;
  for (const c of cands) {
    const r = radius(c);
    if (r >= maxR || dist(c, p) > r + tol) continue;
    if (r < br) { br = r; best = c; }
  }
  return best;
}

export function contains(s, p, tol) {
  return !!s && !s.gone && !s.obj.dead && dist(s, p) <= radius(s) + tol;
}

// The outermost object under the cursor.
export function topLevelAt(world, p, tol, showChem) {
  const cands = [];
  for (const c of world.life.cells) {
    if (Math.hypot(c.x - p.x, c.y - p.y) > c.r + tol) continue;
    cands.push(c.orgSize > 1 ? organismOf(c, world) : sel('cell', c));
  }
  if (world.viruses) {
    for (const v of world.viruses.list) {
      if (Math.hypot(v.x - p.x, v.y - p.y) <= DIM.virus * NM * 2 + tol) cands.push(sel('virus', Object.assign(v, { r: DIM.virus * NM * 2 }), { world }));
    }
  }
  if (showChem) {
    const soup = world.soup;
    for (const v of soup.vesicles) if (Math.hypot(v.x - p.x, v.y - p.y) <= v.r + tol) cands.push(sel('vesicle', v));
    for (const q of soup.polymers) {
      q._rad = (q.seq.length * DIM.ntRise * NM) / 2;
      if (Math.hypot(q.x - p.x, q.y - p.y) <= q._rad + tol) cands.push(sel('polymer', q));
    }
    for (let i = 0; i < soup.n; i++) {
      const dx = soup.mx[i] - p.x, dy = soup.my[i] - p.y;
      if (Math.abs(dx) > tol + NM || Math.abs(dy) > tol + NM) continue;
      const st = { mid: soup.mid[i], x: soup.mx[i], y: soup.my[i], ang: (soup.mid[i] * 2.399) % TAU, gone: false };
      cands.push(molecule(soup.mt[i], () => st, () => st.gone, null, { st }));
    }
  }
  let best = null;
  for (const c of cands) if (!best || radius(c) < radius(best)) best = c;
  if (best) best.follow = false;
  return best;
}

// The part of s directly under the cursor (one level down), or null.
export function childAt(s, p, tol, world, renderer) {
  const pxnm = renderer.ppu / NM_PER_UNIT;
  const out = (c) => { if (c) c.follow = false; return c; };
  if (s.kind === 'organism') {
    return out(smallestHit(s.members().map((c) => sel('cell', c, { parent: s })), p, tol));
  }
  if (s.kind === 'cell') {
    const c = s.obj;
    if (c.r * renderer.ppu < 14) return null; // too small on screen to show its parts
    const kids = cellParts(s, world, renderer);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (Math.abs(d - c.r) < DIM.bilayer * NM + tol) return out(kids[0]);
    if (d > c.r) return out(kids.find((k) => k.label === 'Cell wall') || null);
    const isGenome = (k) => /Chromosome/.test(k.label);
    const organelles = flatten(kids).filter((k) => !k.ring && !/Cytoplasm|junctions|Cell wall|Ribosome /.test(k.label) && !isGenome(k));
    const hit = smallestHit(organelles, p, tol);
    if (hit) return out(hit);
    const a = c._anat, ribs = kids.find((k) => k.label === 'Ribosomes');
    if (DIM.ribosome * pxnm >= 3) {
      const at = (fx, fy, r) => anchored(() => ({ x: c.x + fx * c.r, y: c.y + fy * c.r }), r, () => c.dead);
      for (let k = 0; k < a.ribo.length / 2; k++) {
        if (Math.hypot(c.x + a.ribo[k * 2] * c.r - p.x, c.y + a.ribo[k * 2 + 1] * c.r - p.y) < DIM.ribosome * NM + tol) return out(ribosome(c, k, at, ribs));
      }
    }
    return out(smallestHit(kids.filter(isGenome), p, tol) || kids.find((k) => k.label === 'Cytoplasm'));
  }
  if (s.kind === 'vesicle') {
    const v = s.obj, kids = vesicleParts(s, renderer);
    const d = Math.hypot(p.x - v.x, p.y - v.y);
    if (Math.abs(d - v.r) < DIM.bilayer * NM + tol) return out(kids[0]);
    const strands = kids.filter((k) => k.kind === 'polymer' && k.obj._fx !== undefined);
    for (const k of strands) k.obj._rad = (k.obj.seq.length * DIM.ntRise * NM) / 2;
    const hit = smallestHit(strands, p, tol);
    if (hit) return out(hit);
    if (pxnm >= 2.5) {
      const inner = v.r - DIM.bilayer * NM;
      for (let t = 0; t < 4; t++) {
        const group = kids.find((k) => k.label === `Free ${BASES[t]} nucleotides`);
        for (let k = 0; k < Math.min(v.pool[t], 40); k++) {
          const seed = (v.id * 7919 + t * 131 + k * 17) >>> 0;
          const frame = () => { const r = renderer.rngFor(seed), a = r.next() * TAU, rr = Math.sqrt(r.next()) * 0.85; return { x: v.x + Math.cos(a) * rr * inner, y: v.y + Math.sin(a) * rr * inner, ang: r.next() * TAU }; };
          const m = molecule(t, frame, () => v.dead, group || s);
          if (dist(m, p) < m.obj.r + tol) return out(m);
        }
      }
    }
    return null;
  }
  if (s.kind === 'polymer') {
    if (pxnm < 4) return null;
    return out(smallestHit(polymerParts(s, renderer).filter((k) => k.kind === 'molecule'), p, tol));
  }
  if (s.kind === 'molecule' || s.kind === 'virus') {
    if (pxnm < 10) return null;
    return out(smallestHit(children(s, world, renderer), p, tol));
  }
  if (s.kind === 'part') {
    if (s.ring) {
      // A membrane: drill into the individual lipid under the cursor once lipids are resolvable.
      if (DIM.lipidSpacing * pxnm < 2.5) return null;
      const o = s.ring.c;
      return out(membraneLipid(() => o.x, () => o.y, () => o.r, Math.atan2(p.y - o.y, p.x - o.x), () => o.dead, s, s.ring.label, s.ring.phospho));
    }
    if (s.nucleusOf) {
      const c = s.nucleusOf, nr = c.r * 0.34, kids = s.kids();
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (Math.abs(d - nr) < (DIM.nuclearGap + 20) * NM + tol) return out(kids[0]);
      return out(smallestHit([kids[1]], p, tol) || kids[2]);
    }
    if (s.genomeOf) {
      const pxOK = s.genomeOf.mito ? renderer.ppu / NM_PER_UNIT >= 0.4 : renderer.ppu / NM_PER_UNIT >= 2;
      return pxOK ? out(basePairAt(s, p, tol, renderer)) : null;
    }
    return out(smallestHit(s.kids ? flatten(s.kids()) : [], p, tol, s.obj.r || Infinity));
  }
  return null;
}
