// Hierarchical anatomy for the inspector. Every selectable thing can list its parts, down to the
// chemical groups of a single molecule, and every part knows where it is (at true scale) so the
// camera can zoom into it. Sub-cellular parts are procedural: they follow the cell's simulated
// state (eukaryote or not, plastids, size, armor, genome) but are not simulated one by one.
import { BASES, LIPID } from './chemistry.js';
import { NM_PER_UNIT, DIM, formatLen } from './render.js';
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
function polymerFrame(p) { return { x: p.x, y: p.y, ang: p._drawAng ?? p.ang }; }

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
  }, { parent: s });
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
    }, { parent: s, note: `×${v.pool[t]}` });
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
  }, { parent: s });
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
    kv: [['Volume', `${volUm3.toFixed(1)} µm³`], ['Energy stored', `${c.energy.toFixed(1)} / ${c.cap.toFixed(0)}`], ['Nutrient', `${c.nut.toFixed(2)} / ${c.nutNeed.toFixed(2)}`]],
    desc: 'A crowded gel of water (~70%), proteins, RNA and metabolites, where the chemistry of life happens.',
  }, { parent: s }));

  // Genetic material.
  const genome = part(c.mito ? 'Chromosomes (genome)' : 'Chromosome (nucleoid)', at(c.mito ? a.nuc.fx * 0.34 : 0, c.mito ? a.nuc.fy * 0.34 : 0, c.r * (c.mito ? 0.25 : 0.4)), {
    title: c.mito ? 'Linear chromosomes in the nucleus' : 'Circular chromosome (nucleoid)',
    kv: [['DNA width', '2 nm'], ['Simulated genes', String(Gn.NG)], ['Generation', String(c.gen)], ['Mutation rate gene', c.g[Gn.MUTR].toFixed(2)]],
    desc: 'The double-stranded DNA genome. Its genes set every trait below; each division copies it with occasional mutations.',
  }, { parent: s });
  genome.kids = () => geneGroups(c, genome);

  if (c.mito) {
    const nuc = part('Nucleus', at(0, 0, c.r * 0.34), {
      title: 'Nucleus', kv: [['Diameter', um(c.r * 0.68)], ['Envelope', 'two membranes, 30 nm apart']],
      desc: 'Walls the genome off from the cytoplasm, a defining feature of eukaryotes.',
    }, { parent: s });
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
  }, { parent: s, note: `≈ ${Math.round(volUm3 * 20000).toLocaleString()}` });
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
    }, { parent: s, note: `×${a.mitos.length}` });
    mg.kids = () => a.mitos.map((m, k) => mitochondrion(c, m, k, at, mg));
    out.push(mg);
    if (a.plast.length) {
      const pg = part('Chloroplasts', at(a.plast[0].fx, a.plast[0].fy, c.r * 0.5), {
        title: 'Chloroplasts', kv: [['Count (drawn)', String(a.plast.length)]],
        desc: 'Descendants of a photosynthetic bacterium kept by a eukaryote: this lineage is an alga.',
      }, { parent: s, note: `×${a.plast.length}` });
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
    }, { parent: s, note: `×${cells.length}` });
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

// ------------------------------------------------------------- public API
export function children(s, world, renderer) {
  if (s.gone) return [];
  switch (s.kind) {
    case 'organism': return organismParts(s, world);
    case 'cell': return cellParts(s, world, renderer);
    case 'vesicle': return vesicleParts(s, renderer);
    case 'polymer': return polymerParts(s, renderer);
    case 'molecule': return moleculeParts(s);
    case 'part': return s.kids ? s.kids() : [];
  }
  return [];
}

export function info(s, world) {
  if (s.kind === 'part') return s.info;
  if (s.kind === 'molecule') return moleculeInfo(s);
  if (s.kind === 'organism') return organismInfo(s, world);
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
  return s.kind;
}

// When zoomed in, a click inside a selected-level object resolves to the deepest visible part.
export function refine(s, p, tol, world, renderer) {
  const pxnm = renderer.ppu / NM_PER_UNIT;
  const pick = (cands) => {
    let best = null, br = Infinity;
    for (const c of cands) {
      const d = Math.hypot(c.obj.x - p.x, c.obj.y - p.y);
      if (d <= c.obj.r + tol && c.obj.r < br) { br = c.obj.r; best = c; }
    }
    return best;
  };
  const ringHit = (cx, cy, R) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - R) < DIM.bilayer * NM + tol;
  const lipidAt = (cx, cy, R, parent, label, phospho) => membraneLipid(() => cx, () => cy, () => R, Math.atan2(p.y - cy, p.x - cx), () => parent.obj.dead, parent, label, phospho);

  if (s.kind === 'cell') {
    const c = s.obj;
    if (c.r * renderer.ppu < 14) return s;
    if (ringHit(c.x, c.y, c.r)) {
      const mem = cellParts(s, world, renderer)[0];
      if (DIM.lipidSpacing * pxnm >= 2.5) return refine(lipidAt(c.x, c.y, c.r, mem, 'A phospholipid in the membrane', true), p, tol, world, renderer);
      return mem;
    }
    const kids = cellParts(s, world, renderer);
    const flat = [];
    for (const k of kids) {
      if (/^(Mitochondria|Chloroplasts|Ribosomes|Nucleus)$/.test(k.label)) for (const kk of k.kids()) flat.push(kk);
      else if (!/Plasma membrane|Cytoplasm|junctions|Cell wall/.test(k.label)) flat.push(k);
    }
    // Topmost first: organelles, then ribosomes, then the chromosome region behind them.
    const isGenome = (k) => /Chromosome/.test(k.label);
    const organelle = pick(flat.filter((k) => !isGenome(k)));
    if (organelle) return organelle;
    if (DIM.ribosome * pxnm >= 3) {
      const a = c._anat;
      for (let k = 0; k < a.ribo.length / 2; k++) {
        const x = c.x + a.ribo[k * 2] * c.r, y = c.y + a.ribo[k * 2 + 1] * c.r;
        if (Math.hypot(x - p.x, y - p.y) < DIM.ribosome * NM + tol) {
          return ribosome(c, k, (fx, fy, r) => anchored(() => ({ x: c.x + fx * c.r, y: c.y + fy * c.r }), r, () => c.dead), kids.find((q) => q.label === 'Ribosomes'));
        }
      }
    }
    return pick(flat.filter(isGenome)) || s;
  }
  if (s.kind === 'vesicle') {
    const v = s.obj;
    if (ringHit(v.x, v.y, v.r)) {
      const mem = vesicleParts(s, renderer)[0];
      if (DIM.lipidSpacing * pxnm >= 2.5) return refine(lipidAt(v.x, v.y, v.r, mem, 'A fatty acid in the membrane'), p, tol, world, renderer);
      return mem;
    }
    return s;
  }
  if (s.kind === 'polymer' && pxnm >= 4) {
    const hit = pick(polymerParts(s, renderer).filter((k) => k.kind === 'molecule'));
    return hit ? refine(hit, p, tol, world, renderer) : s;
  }
  if (s.kind === 'molecule' && pxnm >= 12) {
    return pick(moleculeParts(s)) || s;
  }
  return s;
}
