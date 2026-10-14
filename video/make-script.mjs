// Generates script.md (to read from) and script.srt (timed cues) from the narration below.
// Scene lengths come from the film director, so the script always matches the video.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES } from '../js/cinema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const NARRATION = {
  title: {
    screen: 'Fade up on the whole habitat. Title: PRIMORDIAL SOUP.',
    lines: ['Four billion years ago, there was no life on Earth.', 'Only water, rock… and chemistry.'],
  },
  ocean: {
    screen: 'Chapter I, The Hadean Ocean. The camera drifts down toward a glowing vent.',
    lines: ['This is a simulation of how that changed.', 'We’re looking at a patch of ancient seafloor less than a millimetre wide,', 'where hydrothermal vents pump out heat and raw chemicals.'],
  },
  molecules: {
    screen: 'Chapter II, Molecules. One continuous dive from 150 micrometres down to a single RNA strand; labels for phosphate and base.',
    lines: ['Everything here is drawn at its true size.', 'Zoom in tens of thousands of times, and those specks become molecules:', 'nucleotides, each a phosphate, a sugar and a base, about a nanometre across.', 'On warm mineral surfaces, they link into chains.', 'This is RNA, the molecule that may have started it all.'],
  },
  protocell: {
    screen: 'Chapter III, The RNA World. Close-up of a ribozyme inside a protocell, then pull back to reveal the membrane bubble.',
    lines: ['Some chains fold into shapes that do something remarkable:', 'they copy themselves, letter by letter, from the nucleotides around them.', 'The copies aren’t perfect, so the best copiers win.', 'Meanwhile, fatty molecules gather into bubbles that trap these replicators inside.', 'A protocell: heredity, wrapped in a membrane.'],
  },
  cell: {
    screen: 'Chapter IV, Life. The first cell; zoom to its interior with ribosomes and chromosome labelled.',
    lines: ['When a protocell lineage keeps growing, dividing and copying its genes,', 'it becomes something new: a living cell, a few micrometres across,', 'with ribosomes building proteins, and a chromosome carrying its genes.'],
  },
  evolution: {
    screen: 'Chapter V, Evolution. Time-lapse of the whole habitat with live counters; milestone banners; oxygen overlay fades in.',
    lines: ['Now, time speeds up.', 'Every division copies the genome with occasional mistakes, and natural selection does the rest.', 'Lineages split into species.', 'Some learn to harvest sunlight, flooding the ocean with oxygen:', 'a poison to the old world, and fuel for the new.', 'Others learn to eat each other.'],
  },
  eukaryote: {
    screen: 'Chapter VI, The Complex Cell. Dive into a eukaryote; nucleus, mitochondrion and chloroplast labelled.',
    lines: ['Then, a lucky accident.', 'A cell swallows an oxygen-breathing bacterium… and doesn’t digest it.', 'It becomes a mitochondrion, a power plant inside the cell.', 'This is a eukaryote: bigger, with a nucleus, and the ancestor of every plant and animal.'],
  },
  multicell: {
    screen: 'Chapter VII, Many Becoming One. Short time-lapse, then dive into the largest organism, coloured by cell type, with each type labelled.',
    lines: ['Some cells stop drifting apart after they divide.', 'Stuck together, they share food and protection, and something new appears: a division of labour.', 'Cells take on jobs: feeding, defending, moving.', 'A few become a germline, budding off to start the next generation.', 'Many cells… one organism.'],
  },
  outro: {
    screen: 'Pull back to the habitat; the tree of life of this world fills the screen; end title.',
    lines: ['Nothing in this story was scripted.', 'Every step emerged from the one before it: chemistry, then heredity, then evolution.', 'This is the tree of life that grew in this one world.', 'Start a new one, and history unfolds differently every time.'],
  },
};

// The outro ends on a silent title card.
const TAIL_SILENCE = { outro: 6 };

const ts = (s) => {
  const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const words = (t) => t.split(/\s+/).filter(Boolean).length;

let t = 0, n = 1, srt = '', txt = '', totalWords = 0;
let md = `# Primordial Soup — narration script

**Video:** \`video/primordial-soup.mp4\` · ${mmss(SCENES.reduce((a, s) => a + s.dur, 0))} · 1920×1080 · 30 fps · no audio

**How to record.** Each block starts at its timecode. The pace is about **2 words per second**,
slower than normal speech on purpose, so pause at the ellipses and line breaks and let the visuals land.
If you run long, trim the last sentence of a block rather than speeding up. \`script.srt\` has the same
lines as timed cues, so you can load it next to the video in any player and read along as a prompter.

`;

for (const sc of SCENES) {
  const nar = NARRATION[sc.id];
  const start = t, end = t + sc.dur;
  const w = nar.lines.reduce((a, l) => a + words(l), 0);
  totalWords += w;
  md += `## ${mmss(start)} – ${mmss(end)} · ${sc.id[0].toUpperCase() + sc.id.slice(1)}  \n*${sc.dur} s · ${w} words · on screen: ${nar.screen}*\n\n`;
  md += nar.lines.map((l) => `> ${l}`).join('  \n') + '\n\n';
  txt += `[${mmss(start)}]\n${nar.lines.join(' ')}\n\n`;
  // Spread the cues across the scene in proportion to their length, with a lead-in and breathing room.
  const a = start + 0.8, b = end - 0.7 - (TAIL_SILENCE[sc.id] || 0);
  let c = a;
  for (const l of nar.lines) {
    const d = ((b - a) * words(l)) / w;
    srt += `${n++}\n${ts(c)} --> ${ts(c + d - 0.15)}\n${l}\n\n`;
    c += d;
  }
  t = end;
}
md += `---\nTotal: ${totalWords} words over ${mmss(t)} (${(totalWords / t).toFixed(1)} words/second).\n`;

fs.writeFileSync(path.join(here, 'script.md'), md);
fs.writeFileSync(path.join(here, 'script.srt'), srt);
fs.writeFileSync(path.join(here, 'script.txt'), txt.trimEnd() + '\n');
console.log(`Wrote script.md, script.srt and script.txt: ${totalWords} words, ${mmss(t)}, ${(totalWords / t).toFixed(2)} words/s`);
