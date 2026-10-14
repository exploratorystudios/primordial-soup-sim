# Primordial Soup

An evolution simulation that starts with nothing but chemistry in a Hadean ocean and lets life
emerge, evolve and, if things go well, assemble itself into multicellular organisms.

Nothing past the initial chemistry is scripted. Each stage arises from the mechanics of the one before
it, so every seed tells a different history: some worlds reach complex organisms quickly, others stay
microbial for a long time (as Earth did for ~2 billion years).

## Running

```bash
npm start            # http://localhost:8080 (or the next free port; PORT=5173 npm start to choose)
```

No dependencies or build step: plain ES modules. `?seed=42&speed=6` in the URL picks a world and speed.

Check that every stage of evolution still emerges (and how often), across many worlds in parallel:

```bash
npm run check -- --seeds 1-8 --ticks 70000          # table of when each milestone happened, per seed
node check-evolution.mjs --seeds 1-20 --md tape.md  # also write a markdown report
```

Headless (no browser), useful for tuning:

```bash
node headless.js 80000 3                       # ticks, seed
CFG='{"PRED_P":0.5}' node headless.js 60000 1  # override any constant from js/config.js
```

## Showcase video

`video/primordial-soup.mp4` is a 3-minute, 1080p, silent explainer rendered straight from the simulation
(seed 21). The narration to record over it is in `video/script.md`; `video/script.srt` has the same
lines as timed cues.

To re-render it (about 15–20 minutes, no npm packages needed, uses headless Chrome + ffmpeg):

```bash
node render-video.mjs --seed 21                 # scouts the seed, then renders video/primordial-soup.mp4
node render-video.mjs --seed 21 --preview 30    # quick check: one still per second into video/preview/
node video/make-script.mjs                      # regenerate script.md / script.srt after editing the narration
```

The director (`js/cinema.js`) defines the scenes and their lengths; edit `SCENES` there and the
narration in `video/make-script.mjs` together, then regenerate the script so the timings match.

## Controls

- **Scroll** zoom (habitat → single molecules) · **drag** pan
- **Click** selects the outermost thing under the cursor (an organism, protocell, strand, molecule or virus). **Click again inside the selection** to select the part under the cursor, one level deeper; click inside a parent to pick a sibling; click outside to start over. **Esc** goes up a level. Clicking never moves the camera.
- **F** (or the inspector's Follow button) keeps the camera on the selection, wherever it is on screen
- **Space** pause · **+ / -** speed. At speeds below one tick per frame, motion is smoothly interpolated between ticks; paused means truly frozen.
- **⏭ Next milestone** runs at full speed until something new happens · **Tour** flies the camera through what exists in this world, with captions
- **Save world / Load world** write and resume a compressed `.json.gz` snapshot; a resumed world continues exactly as the original would have
- Colour cells by metabolism, by species (neutral pigment gene, so related lineages share a hue), or by cell type
- Overlays show vent chemicals, organic matter, oxygen and nutrients
- Planetary events: asteroid impact (mass extinction + impact winter), Snowball Earth, volcanic surge
- **Tree of life** shows the phylogeny of every species that reached a population of 5+

## True scale and zooming down to molecules

Everything is drawn at its real physical size: **1 world unit = 0.5 µm**, so the habitat is a
1.6 × 0.9 mm patch of ocean. A scale bar and field-of-view readout (bottom left) show where you are.
Zoom presets jump between levels: *Habitat → Organism (120 µm) → Cell (15 µm) → Interior (1.5 µm) →
Membrane (150 nm) → Molecule (15 nm)*.

| thing | real size here |
| --- | --- |
| nucleotide (A, U, G, C) | ~1 nm: phosphate, ribose ring and base drawn separately |
| RNA strand | 0.59 nm per base; active ribozymes fold into hairpins with visible base pairs |
| membrane | 4 nm bilayer of individual lipids (fatty acids in protocells, two-tailed phospholipids in cells) |
| ribosome | 22 nm (70S) / 25 nm (80S) |
| protocell | 5–10 µm |
| virus | ~100 nm head and 200 nm tail: capsid, packed genome, tail fibres |
| prokaryote | 1–3.5 µm, with a dense nucleoid (a 2 nm double helix with base pairs up close, or a single-stranded RNA genome in early cells), ribosomes, flagellum (20 nm thick), thylakoids if photosynthetic |
| eukaryote | 6–30 µm, with nucleus (double envelope, 100 nm pores, chromatin on 11 nm nucleosomes), mitochondria (~1 µm), chloroplasts, ER, 250 nm flagellum |
| colony / organism | tens to hundreds of µm |

Things smaller than a pixel are shown as single specks; they are never enlarged.

**What is and isn't literal.** The simulation tracks real positions for every free molecule, RNA
strand, vesicle and cell. Sub-cellular anatomy (organelles, ribosomes, individual membrane lipids) is
*drawn* procedurally from each cell's simulated state (size, eukaryote or not, plastids, armor,
motility). It is not simulated molecule by molecule, which would need ~10¹⁶ molecules for even a
small droplet. The prebiotic soup is also far more dilute than a real ocean. Water molecules are drawn
procedurally at molecular zoom (they are not simulated). Two things are not to scale at all: the environment's gradients (sunlit surface to deep
vents spans hundreds of metres, compressed here into 0.9 mm) and time. Era banners give a rough "on Earth" date for orientation; ticks are not years.

### Inspecting parts

Select anything and the inspector shows its **breadcrumb path** (e.g. *Organism › Cell › Nucleus ›
Chromosomes › Gene*) and a **Parts** list. Clicking a part selects it and flies the camera to it at a
fitting magnification. When zoomed in, clicking on the canvas picks the deepest visible part:
an organelle, a ribosome, a lipid in the membrane, one nucleotide in an RNA strand, or a chemical group
of a molecule.

- **Organism** → its cells grouped by fate
- **Cell** → membrane (→ phospholipid → head / glycerol / tails), cell wall, cytoplasm, chromosome (→ every gene with its value), nucleus (→ envelope & pores, nucleolus), ribosomes (→ subunits), mitochondria (→ membranes, matrix, mtDNA), chloroplasts (→ grana, stroma, cpDNA), flagellum (→ motor, hook, filament), ER, thylakoids, junctions to neighbour cells
- **Protocell** → fatty-acid membrane (→ fatty acid), every RNA strand inside, its nucleotide pool
- **RNA strand** → every nucleotide (→ phosphate, ribose, base), hairpin stem, daughter strand being copied
- **Free molecule** → its chemical groups

## What is modelled

### 1. Prebiotic chemistry (`js/chemistry.js`)
- Hydrothermal vents emit reduced chemicals and monomers; lightning/UV makes a trickle at the surface (Miller–Urey).
- Four nucleotide types (A, U, G, C) condense into polymers, fastest where chemical energy is high and on mineral surfaces near the vents. Hydrolysis breaks chains down, and UV makes that worse near the surface. G–C-rich chains are more stable.
- A chain's sequence decides whether it folds into a **ribozyme**: complementary ends form a hairpin stem, and a rugged hidden fitness landscape scores its triplet motifs. Active ribozymes copy themselves base by base from free nucleotides. Better catalysts copy more accurately (the error threshold), and copying adds substitutions and indels.
- Lipids cluster and self-assemble into **vesicles**. Vesicles absorb lipids and nucleotides, trap polymers, and split when large. Ones full of RNA hold onto their membrane better, so they grow at the expense of empty ones (Chen & Szostak). Overfull vesicles burst.
- A vesicle lineage that has divided repeatedly while carrying good replicators becomes the first **living cell**. Its genome is seeded from its founding replicator's sequence. Abiogenesis can happen several times, giving independent lineages.

### 2. Cellular evolution (`js/life.js`, `js/genome.js`)
- Each cell has a 51-gene genome: body size, investment in photosynthesis, chemosynthesis, heterotrophy and predation, motility, aerobic respiration, armor, adhesion, energy sharing, lifespan, colony size, an evolvable mutation rate, a neutral pigment, chemotaxis/phototaxis weights, and a gene-regulatory network for cell fate.
- **Trade-offs**: metabolic investment is a budget, and specialists beat generalists. Everything costs upkeep.
- **Reproduction** by division with point mutations and occasional large-effect mutations. **Horizontal gene transfer** between touching prokaryotes.
- **Limiting nutrient**: a phosphate-like nutrient locked in bodies and recycled on death caps the biosphere. Vents and surface weathering add more, and burial removes it.
- **Oxygen**: oxygenic photosynthesis releases O₂. Reduced vent chemicals mop it up, so the Great Oxidation Event lags behind the origin of photosynthesis. O₂ is toxic to unadapted cells and greatly boosts aerobic respiration.
- **RNA world → DNA and proteins**: the first cells run on ribozymes and keep their genes in RNA. Evolving protein translation makes every metabolic pathway more efficient; a DNA genome lowers the mutation rate and avoids constant RNA repair (worse once oxygen appears). Both benefits rise gradually with their genes. Only DNA-genome, protein-making cells can become eukaryotes.
- **Viruses as particles** (`js/viruses.js`): once life is common, selfish genetic elements escape as viruses. They drift, decay in surface UV, and infect cells whose two receptor genes match their binding key; the cell is hijacked, then bursts and releases mutated copies. Hosts escape by mutating receptors or investing in a CRISPR-like defence, so an arms race emerges. Viruses sometimes deliver a gene from their last host (transduction).
- **Sex**: eukaryotes can recombine their genome with a nearby mate of their own kind. It costs both parents energy; its payoff (shuffling receptors and good mutations) has to emerge.
- **Metabolic scaling**: costs and gains scale with size^0.75 (as Kleiber's law suggests), so large eukaryotes are viable but few.
- **Predation**: big cells engulf smaller ones. Being part of a large colony protects you.
- **Endosymbiosis**: occasionally an engulfed aerobe survives as a mitochondrion. This creates a **eukaryote**: bigger, with more energy capacity, and inherited by its descendants. A eukaryote that engulfs a phototroph may keep it as a chloroplast and become an **alga**.
- **Speciation**: a new species is recorded when a lineage drifts far enough from its species' founding genome. Together these records form the phylogeny.

### 3. Multicellularity
- With the adhesion gene, daughter cells may stay bonded after division. Bonded cells move together and share energy.
- Every 10 ticks colonies are identified. Each cell's regulatory network reads its positional cues: number of neighbours, distance from the founder cell, colony size, and light. From these it chooses a **fate**: generalist, feeder (doubles its own metabolism), motor, mouth (feeding/predation), armor, or **germline**. Specialised cells do one job very well and rely on the colony for the rest.
- Germline cells soak up shared energy and bud off to start the next generation, giving a germ–soma life cycle.
- An organism counts as **multicellular** with 8+ cells and 2+ specialised types. It counts as **complex** with 16+ cells, 3+ specialised types and a germline.

## Files

| file | role |
| --- | --- |
| `js/config.js` | every tunable constant |
| `js/world.js` | environment (light, vents, currents, fields), milestones, eras, events |
| `js/chemistry.js` | monomers, polymers, ribozymes, vesicles, protocells |
| `js/life.js` | cells, metabolism, behaviour, predation, endosymbiosis, colonies, species |
| `js/genome.js` | gene layout, mutation, recombination, genetic distance |
| `js/viruses.js` | virus particles, infection, lysis, transduction |
| `js/persist.js` | save / load worlds |
| `js/tour.js` | guided camera tour |
| `js/fields.js`, `js/spatial.js` | diffusing chemical grids, spatial hash |
| `js/render.js` | true-scale renderer with semantic zoom (molecules, bilayers, organelles) |
| `js/parts.js` | part hierarchy for the inspector, deep picking |
| `js/ui.js`, `js/main.js` | side panel, main loop, camera and input |
| `headless.js` | run one world without a browser |
| `check-evolution.mjs` | "replay the tape of life": many seeds in parallel, reports when each stage emerged |
