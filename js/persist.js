// Save and restore a whole world: chemistry, cells, genomes, species, viruses and the RNG state,
// so a run can be bookmarked and resumed exactly where it left off.
import { World } from './world.js';
import { Cell, decode } from './life.js';

const VERSION = 1;

// Typed arrays travel as base64 to keep files compact.
function b64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str, Type) {
  let bytes;
  if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(str, 'base64'));
  else { const s = atob(str); bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i); }
  return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

const polyOut = (p) => ({ x: p.x, y: p.y, ang: p.ang, seq: p.seq, prog: p.prog, copy: p.copy });

export function serialize(w) {
  const F = w.fields, soup = w.soup, L = w.life, n = soup.n;
  return {
    version: VERSION, seed: w.seed, t: w.t, rng: { s: w.rng.s, spare: w.rng._spare },
    env: { vents: w.vents, lightMul: w.lightMul, ventMul: w.ventMul, timers: w.timers, phase: w.phase, o2: w.o2 },
    fields: { chem: b64(F.chem), organic: b64(F.organic), oxygen: b64(F.oxygen), nutrient: b64(F.nutrient) },
    record: { milestones: w.milestones, logs: w.logs, history: w.history, historyEvery: w.historyEvery },
    soup: {
      n, mx: b64(soup.mx.slice(0, n)), my: b64(soup.my.slice(0, n)), mt: b64(soup.mt.slice(0, n)), mid: b64(soup.mid.slice(0, n)),
      nextMid: soup.nextMid, vesId: soup.vesId, landscape: b64(soup.landscape), stats: soup.stats,
      polymers: soup.polymers.map(polyOut),
      vesicles: soup.vesicles.map((v) => ({ id: v.id, x: v.x, y: v.y, L: v.L, gen: v.gen, copies: v.copies, age: v.age, pool: v.pool, polys: v.polys.map(polyOut) })),
    },
    life: {
      nextId: L.nextId, nextSpecies: L.nextSpecies, origins: L.origins, births: L.births, deaths: L.deaths, sexualBirths: L.sexualBirths, stats: L.stats,
      cells: L.cells.map((c) => ({
        id: c.id, x: c.x, y: c.y, vx: c.vx, vy: c.vy, g: b64(c.g), energy: c.energy, age: c.age, gen: c.gen, mito: c.mito, plastid: c.plastid,
        species: c.species, origin: c.origin, parentId: c.parentId, bonds: c.bonds.map((o) => o.id), type: c.type, org: c.org, orgSize: c.orgSize,
        depth: c.depth, heading: c.heading, nut: c.nut, infected: c.infected, born: c.born, founderSeq: c.founderSeq, sexual: c.sexual,
        px: c.px, py: c.py, fx: c.fx, fy: c.fy, dirX: c.dirX, dirY: c.dirY, // sensed directions and current heading
      })),
      species: [...L.species.values()].map((s) => ({ ...s, rep: b64(s.rep) })),
      organisms: L.organisms, stamp: L.stamp,
    },
    viruses: { list: w.viruses.list.map((v) => ({ ...v, x0: undefined, y0: undefined })), nextId: w.viruses.nextId, lineages: w.viruses.lineages, stats: w.viruses.stats },
  };
}

export function deserialize(d) {
  if (!d || d.version !== VERSION) throw new Error('Not a Primordial Soup save file (or from an incompatible version).');
  const w = new World(d.seed);
  w.t = d.t;
  w.rng.s = d.rng.s; w.rng._spare = d.rng.spare;
  Object.assign(w, d.env);
  for (const k of ['chem', 'organic', 'oxygen', 'nutrient']) w.fields[k].set(unb64(d.fields[k], Float32Array));
  w.milestones = d.record.milestones;
  w.mset = new Set(w.milestones.map((m) => m.key));
  w.logs = d.record.logs; w.history = d.record.history; w.historyEvery = d.record.historyEvery;

  const soup = w.soup, S = d.soup;
  soup.n = S.n;
  soup.mx.set(unb64(S.mx, Float32Array)); soup.my.set(unb64(S.my, Float32Array));
  soup.mt.set(unb64(S.mt, Uint8Array)); soup.mid.set(unb64(S.mid, Int32Array));
  soup.px0.set(soup.mx.subarray(0, S.n)); soup.py0.set(soup.my.subarray(0, S.n));
  soup.mdead.fill(0);
  soup.nextMid = S.nextMid; soup.stats = S.stats;
  soup.landscape.set(unb64(S.landscape, Float32Array));
  const polyIn = (q) => { const p = { x: q.x, y: q.y, ang: q.ang, seq: q.seq, act: 0, fid: 0.8, stab: 0, prog: q.prog, copy: q.copy, dead: false }; soup.evalPolymer(p); return p; };
  soup.polymers = S.polymers.map(polyIn);
  soup.vesicles = S.vesicles.map((v) => ({ ...soup.makeVesicle(v.x, v.y, v.L, v.gen), id: v.id, copies: v.copies, age: v.age, pool: v.pool, polys: v.polys.map(polyIn) }));
  soup.vesId = S.vesId; // after makeVesicle, which advances the counter
  for (const v of soup.vesicles) for (const p of v.polys) p.home = v;

  const L = w.life, D = d.life;
  Object.assign(L, { nextId: D.nextId, nextSpecies: D.nextSpecies, origins: D.origins, births: D.births, deaths: D.deaths, sexualBirths: D.sexualBirths, stats: D.stats });
  L.species = new Map(D.species.map((s) => [s.id, { ...s, rep: unb64(s.rep, Float32Array) }]));
  const byId = new Map();
  L.cells = D.cells.map((q) => {
    const c = new Cell(q.id, q.x, q.y, unb64(q.g, Float32Array), null);
    const { bonds, g, ...rest } = q;
    Object.assign(c, rest);
    c.x0 = c.x; c.y0 = c.y;
    decode(c);
    byId.set(c.id, c);
    return c;
  });
  for (let i = 0; i < D.cells.length; i++) L.cells[i].bonds = D.cells[i].bonds.map((id) => byId.get(id)).filter(Boolean);
  L.organisms = D.organisms; L.stamp = D.stamp; // keep cell fates exactly as they were

  Object.assign(w.viruses, { list: d.viruses.list.map((v) => ({ ...v, x0: v.x, y0: v.y })), nextId: d.viruses.nextId, lineages: d.viruses.lineages, stats: d.viruses.stats });
  w.updateCurrents();
  return w;
}

// Browser helpers: gzip-compressed download and upload.
export async function saveToFile(w) {
  const json = JSON.stringify(serialize(w));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(stream).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `primordial-soup-seed${w.seed}-t${w.t}.json.gz`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return blob.size;
}

export async function loadFromFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let text;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(buf);
  }
  return deserialize(JSON.parse(text));
}
