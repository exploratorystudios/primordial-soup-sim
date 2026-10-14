// Splits a recorded voice-over into its script sections (at the long pauses between them) and
// places each section centred within its scene, then muxes it onto the rendered video.
//
//   node video/align-voiceover.mjs [--voice video/video_voiceover.mp3] [--video video/primordial-soup.mp4]
//                                  [--out video/primordial-soup-narrated.mp4]
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES } from '../js/cinema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const voice = path.resolve(args.voice || path.join(here, 'video_voiceover.mp3'));
const video = path.resolve(args.video || path.join(here, 'primordial-soup.mp4'));
const out = path.resolve(args.out || path.join(here, 'primordial-soup-narrated.mp4'));
const track = out.replace(/\.mp4$/, '-voice.wav');

const probe = (f) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
const voiceDur = probe(voice), videoDur = probe(video);

// 1. Find pauses.
const log = spawnSync('ffmpeg', ['-hide_banner', '-i', voice, '-af', 'silencedetect=noise=-38dB:d=0.35', '-f', 'null', '-']).stderr.toString();
const gaps = [];
let s0 = null;
for (const line of log.split('\n')) {
  const a = /silence_start: ([\d.]+)/.exec(line), b = /silence_end: ([\d.]+)/.exec(line);
  if (a) s0 = +a[1];
  if (b && s0 !== null) { gaps.push({ start: s0, end: +b[1], len: +b[1] - s0 }); s0 = null; }
}

// 2. The (sections - 1) longest pauses are the breaks between sections.
const n = SCENES.length;
const breaks = [...gaps].sort((x, y) => y.len - x.len).slice(0, n - 1).sort((x, y) => x.start - y.start);
if (breaks.length !== n - 1) throw new Error(`Expected ${n - 1} section breaks, found ${breaks.length}`);
const firstSpeech = gaps.length && gaps[0].start < 0.05 ? gaps[0].end : 0;
const lastGap = gaps.at(-1);
const lastSpeech = lastGap && lastGap.end > voiceDur - 0.05 ? lastGap.start : voiceDur;
const sections = [];
for (let i = 0; i < n; i++) {
  const start = i === 0 ? firstSpeech : breaks[i - 1].end;
  const end = i === n - 1 ? lastSpeech : breaks[i].start;
  sections.push({ start, end, dur: end - start });
}

// 3. Centre each section in its scene (the outro's window ends where the silent title card begins).
const TAIL = { outro: 6 };
const PAD_IN = 0.12, PAD_OUT = 0.3;
let t = 0, prevEnd = 0;
const placed = SCENES.map((sc, i) => {
  const winStart = t, winEnd = t + sc.dur - (TAIL[sc.id] || 0);
  t += sc.dur;
  const s = sections[i];
  let at = winStart + Math.max(0.4, (winEnd - winStart - s.dur) / 2);
  at = Math.max(at, prevEnd + 0.6); // never overlap the previous section
  prevEnd = at + s.dur;
  return { ...s, at, scene: sc.id, winStart, winEnd };
});

// Even out the pauses: repeatedly slide each section to sit midway between its neighbours,
// without letting it leave its own scene. Converges to (near-)equal gaps.
const videoEnd = t - (TAIL[SCENES.at(-1).id] || 0);
for (let it = 0; it < 500; it++) {
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const left = i === 0 ? 0 : placed[i - 1].at + placed[i - 1].dur;
    const right = i === placed.length - 1 ? videoEnd : placed[i + 1].at;
    const lo = p.winStart + 0.4, hi = Math.max(lo, p.winEnd - p.dur);
    p.at = Math.min(hi, Math.max(lo, (left + right - p.dur) / 2));
  }
}

console.log('section      source (s)          placed at (s)    scene window');
for (const p of placed) {
  console.log(`${p.scene.padEnd(10)} ${p.start.toFixed(2).padStart(6)}–${p.end.toFixed(2).padEnd(7)} (${p.dur.toFixed(1)}s)  ${p.at.toFixed(2).padStart(6)}–${(p.at + p.dur).toFixed(2).padEnd(7)}  ${p.winStart}–${p.winEnd}${p.at + p.dur > p.winEnd ? '  ⚠ runs past its scene' : ''}`);
}

// 4. Build the aligned track: trim each section (with a little padding and tiny fades), delay, mix.
const parts = placed.map((p, i) => {
  const a = Math.max(0, p.start - PAD_IN), b = Math.min(voiceDur, p.end + PAD_OUT), d = b - a;
  const delay = Math.round((p.at - (p.start - a)) * 1000);
  return `[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=${(d - 0.08).toFixed(3)}:d=0.08,adelay=${delay}|${delay}[s${i}]`;
});
const mix = `${placed.map((_, i) => `[s${i}]`).join('')}amix=inputs=${placed.length}:normalize=0,apad,atrim=end=${videoDur.toFixed(3)}[voice]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', voice, '-filter_complex', [...parts, mix].join(';'), '-map', '[voice]', '-ar', '48000', track], { stdio: 'inherit' });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', track, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', out], { stdio: 'inherit' });
console.log(`\nWrote ${path.relative(process.cwd(), out)} and the aligned voice track ${path.relative(process.cwd(), track)}`);
