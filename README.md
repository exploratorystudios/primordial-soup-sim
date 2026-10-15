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

No dependencies or build step: plain ES modules. `?seed=42&speed=0.1` in the URL picks a world and a speed in ticks per frame (0.01 to 250, or `max`). For experiments, `?day=always` gives constant full sunlight, and `?cfg={"DAY_SWING":0}` overrides any setting in `js/config.js` (shown in the panel while active; the tour uses them too).

Check that every stage of evolution still emerges (and how often), across many worlds in parallel:

```bash
npm run check -- --seeds 1-8 --ticks 70000          # table of when each milestone happened, per seed
node check-evolution.mjs --seeds 1-20 --md tape.md  # also write a markdown report
node check-replay.mjs 1                            # save/restore replays exactly (the tour's rewind relies on it)

**Comparing settings at scale (Jupyter).** `node notebook/make-notebook.mjs` writes `notebook/primordial-soup-ab.ipynb` (and the same as a plain script, `primordial-soup-ab.py`; add `--compact` to gzip the embedded code into short lines for editors that choke on big cells), a self-contained notebook for any Jupyter server or Kaggle (the headless simulation is embedded; it fetches Node.js and pandas/scipy/matplotlib if missing, and respects container CPU and memory limits) that replays many seeds under each setting in `CONFIGS`, using every core it finds, and reports how often and when each stage emerged per setting (Fisher's exact and Mann-Whitney tests, Holm-corrected), a chart with 95% intervals, and how the first cells' genomes and the number of independent origins differ. Results are saved per world, so a stopped session resumes. Rebuild the notebook after changing the simulation.
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
- **F** (or the inspector's Follow button) locks the camera onto the selection, so it stays still in the middle of the screen however it moves. Following stays on until you press F or the button again: pan anywhere you like, even right away from it, and the view keeps moving with it as if you were riding along (zooming then works at the cursor as usual); whatever you select next is followed too. Press F twice to re-centre it
- **Space** pause · **+ / -** speed, from one tick every 100 frames up to 250 ticks per frame and **max**. At speeds below one tick per frame, motion is smoothly interpolated between ticks; paused means truly frozen. When a setting asks for more than the CPU can deliver, the label shows the rate actually achieved (max gives the simulation most of each frame, so the view gets choppier).
- **⏪ Rewind** (or **R**) plays the recent past backwards at the current speed: smoothly below one tick per frame, tick by tick up to 20 per frame, and hopping between saved moments faster than that. What you have selected stays selected (a cell that wasn't born yet hands over to its parent). The world is saved every so often while it runs (at most ~5% of the simulation time and ~100 MB), so how far back you can go depends on how big the world has become; going back replays from a save, so the history is reproduced exactly. Press Play to carry on forward from there.
- **⏭ Next milestone** runs at full speed until something new happens · **Tour** lets you watch every transition this world went through (see below)
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
Chromosomes › Gene*) and a **Parts** list. Clicking a part in the list selects it and flies the camera there, framed to fit, then follows it. Selections are highlighted along their real outline (a whole membrane ring, a strand along its length). When zoomed in, clicking on the canvas picks the deepest visible part:
an organelle, a ribosome, a lipid in the membrane, one nucleotide in an RNA strand, or a chemical group
of a molecule.

- **Organism** → its cells grouped by fate
- **Cell** → membrane (→ phospholipids and membrane proteins: channels, pumps, transporters, receptors, ATP synthase), cell wall (→ glycan strands → NAG–NAM sugar units, peptide cross-links), cytoplasm, chromosome (→ base pairs up close, or every gene with its value), ribosomes (→ large and small subunits → rRNA nucleotides and ribosomal proteins; messenger RNA → nucleotides; tRNAs in the A, P and E sites → anticodon, amino acid; the new protein → individual amino acids → backbone and side chain), flagellum, junctions to neighbour cells, assembling virus capsids if infected
  - *prokaryotes* add plasmids, pili, storage granules, carboxysomes, thylakoids
  - *eukaryotes* add the nucleus (→ envelope, individual pores, nucleolus, chromatin → nucleosomes → histones), rough ER (→ bound ribosomes), Golgi (→ cisternae, transport vesicles), centrosome (→ centrioles), microtubules (→ tubulin dimers), lysosomes, peroxisomes, mitochondria (→ outer membrane, cristae → ATP synthase, mtDNA, matrix), and in algae chloroplasts (→ grana → thylakoid discs → photosystems I and II, cpDNA, stroma) and a central vacuole
- **Protocell** → membrane (→ fatty acid), every RNA strand inside (ribozymes list their Mg²⁺ ions), its nucleotide pool, and as it matures its peptides (→ each peptide) and proto-ribosome
- **RNA strand** → every nucleotide (→ phosphate, ribose, base), hairpin stem, daughter strand being copied
- **Free molecule** → its chemical groups

### Animated processes

Nothing pops into existence. Events in the simulation play out over a few dozen ticks of simulation
time, so they freeze when paused and can be watched slowly at low speed:

- **Events:** cells divide by binary fission (one body pinching into two), predators engulf prey into a food vacuole, dying cells shrivel and leak, viruses dock and inject their genome, infected cells burst into membrane fragments, lipids gather into vesicles, fatty acids slip into protocell membranes, protocells divide through a string of beads (pearling), a protocell becoming a cell switches on (a glow, its genome strand lighting up), contracts around the new cell as it fades in, and sends out a pulse of light, nucleotides glide onto growing strands, and finished RNA copies peel away from their templates. When a ribozyme copies itself (free in the water or inside a protocell), each nucleotide glides in and pairs with the template one at a time, the copy growing as a short double strand with its own backbone and hydrogen bonds across, which then comes apart; in RNA-genome cells the copy grows as a single strand beside the original. A new eukaryote grows to full size gradually, and its mitochondria multiply from the single engulfed one.
- **Inside cells, all the time:** RNA polymerases crawl along genes spinning out messenger RNA (in bacteria, ribosomes ride the message while it is still being made); as a cell builds up toward dividing, two replication forks copy its chromosome, with the new double helix running beside the old one; every ribosome runs the elongation cycle (a tRNA docks in the A site, the chain is handed over, the mRNA ratchets one codon, the empty tRNA leaves, and the protein grows); microtubules grow and shrink; transport vesicles travel from the Golgi to the membrane and fuse with it; ATP synthase rotors spin; membrane lipids jiggle.

These run faster in well-fed cells and in cells with more translation machinery. They are drawn from each cell's state rather than simulated molecule by molecule (an exact simulation of a cell's chemistry is far beyond a browser), so they never change the outcome of a run.

## The tour: watch every transition

**Tour** replays the current seed from the very beginning in the background and finds one clear
example of every transition that happened in it, in order:

molecules forming at a vent → two nucleotides bonding → a chain growing → RNA copying itself → a
membrane bubble forming → RNA copying inside a protocell → a protocell dividing → the first living
cell → cell division → proteins (ribosomes at work) → DNA (transcription and replication) → the first
predator → the first viruses → infection → a cell bursting → gene swapping → photosynthesis → the
Great Oxidation Event (a time-lapse with the oxygen overlay) → endosymbiosis and the first eukaryote →
the first alga → sex → the first colony → a multicellular organism → a complex organism → the next
generation budding off.

Each chapter restores the world shortly before the moment and follows what it happens to (and what it
turns into: a protocell into a cell, prey into its predator). Chapters appear as they are found, so
you can start watching within seconds while the search carries on. Not every world gets through every
transition; the list shows which ones didn't happen.

- **Timeline**: drag to scrub; the orange mark is the moment itself. **◀◀ / ▶▶** (or ← / →) jump back
  and forward, **↺** replays the scene, **⏮ / ⏭** change chapter, **◎ Subject** re-centres on it.
- The camera stays yours: pan, zoom, select other things and change the speed as usual.
- Rewinding restores a snapshot from the search and replays forward, so you see exactly the same
  history every time (`node check-replay.mjs` checks this). **✕ Exit** returns to your own world.

## What is modelled

### 1. Prebiotic chemistry (`js/chemistry.js`)
- Hydrothermal vents emit reduced chemicals and monomers; lightning/UV makes a trickle at the surface (Miller–Urey).
- Four nucleotide types (A, U, G, C) condense into polymers, fastest where chemical energy is high and on mineral surfaces near the vents. Hydrolysis breaks chains down, and UV makes that worse near the surface. G–C-rich chains are more stable.
- A chain's sequence decides whether it folds into a **ribozyme**: complementary ends form a hairpin stem, and a rugged hidden fitness landscape scores its triplet motifs. Active ribozymes copy themselves base by base from free nucleotides. Better catalysts copy more accurately (the error threshold), and copying adds substitutions and indels.
- Lipids cluster and self-assemble into **vesicles**. Vesicles absorb lipids and nucleotides, trap polymers, and split when large. Ones full of RNA hold onto their membrane better, so they grow at the expense of empty ones (Chen & Szostak). Overfull vesicles burst.
- Fatty-acid membranes are leaky: while the ocean is still lifeless, protocells draw in nucleotides diffusing up to ~2 µm away (`VES_NT_REACH_EARLY`), which roughly doubles the RNA copying inside them; the extra reach fades as living cells multiply (halved at 50 cells), so the established biosphere sees the same chemistry as before. Tested over 112 worlds: life started in all of them and no later stage changed significantly.
- **Multicellularity as on Earth** (setting `REALISTIC_MULTI`, being tested): bacteria form colonies and simple multicellular organisms (like cyanobacterial filaments with heterocysts) but no mouth or germline cells, so complex organisms are eukaryotic; bodies above 16 cells need local oxygen, up to 62 cells when fully oxygenated.
- **Eukaryotes** (settings being tested): `MITO_AER` gives a eukaryote aerobic respiration from its mitochondria (without it, oxygen poisons the many whose host never evolved it), and `SYMBIO_P` adds a second route to mitochondria besides predation: a host with a DNA genome and an aerobic bacterium living in contact merge (closer to the leading hypothesis that the host was an archaeon partner, not a hunter).
- **On the road to life** (drawn from each protocell lineage's progress: generations, completed self-copies, its best ribozyme; not simulated themselves, see `js/protocell.js`): phospholipids gradually mix into the fatty-acid membrane (up to ~60%), ribozymes hold magnesium ions, short peptides of prebiotic amino acids appear (some stuck to the RNA), and finally the best ribozyme grows into a proto-ribosome joining amino acids. The inspector shows the stage and says which of these are well established and which are hypotheses.
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
| `js/story.js`, `js/story-scout.js`, `js/story-chapters.js` | the tour: finding each transition in the world's history (a Web Worker), and playing it back with rewind |
| `js/fields.js`, `js/spatial.js` | diffusing chemical grids, spatial hash |
| `js/render.js` | true-scale renderer with semantic zoom (molecules, bilayers, organelles) |
| `js/parts.js` | part hierarchy for the inspector, deep picking |
| `js/ui.js`, `js/main.js` | side panel, main loop, camera and input |
| `headless.js` | run one world without a browser |
| `check-replay.mjs` | strict check that a restored snapshot continues exactly like the original |
| `check-evolution.mjs` | "replay the tape of life": many seeds in parallel, reports when each stage emerged |
