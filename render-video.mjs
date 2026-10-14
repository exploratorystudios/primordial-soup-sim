// Renders the showcase film (no audio) by driving cinema.html in headless Chrome and piping
// frames into ffmpeg. No npm dependencies: uses the Chrome DevTools Protocol directly.
//
//   node render-video.mjs [--seed 11] [--out video/primordial-soup.mp4]
//                         [--preview N]   only write every Nth frame as a PNG still, for checking
//                         [--events '{"cell":1800,...}']  skip the scouting pass
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const seed = +(args.seed || 11);
const out = path.resolve(root, args.out || 'video/primordial-soup.mp4');
const preview = args.preview ? +args.preview : 0;
const CHROME = process.env.CHROME || 'google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Static server.
const server = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: '5600' } });
const port = await new Promise((res, rej) => {
  server.stdout.on('data', (d) => { const m = /localhost:(\d+)/.exec(String(d)); if (m) res(+m[1]); });
  server.on('exit', () => rej(new Error('server exited')));
});

// 2. Headless Chrome.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--window-size=1920,1080',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) throw new Error('Chrome did not start');

// 3. Minimal CDP client.
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') console.error('page error:', msg.params.exceptionDetails.exception?.description);
  if (msg.method === 'Runtime.consoleAPICalled') console.log('page:', msg.params.args.map((a) => a.value).join(' '));
});
const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
  return r.result.result.value;
};

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://localhost:${port}/cinema.html?seed=${seed}` });
while (!(await evaluate('!!window.cinemaReady').catch(() => false))) await sleep(200);

// 4. Scout when the key events happen, then render.
let events = args.events ? JSON.parse(args.events) : null;
if (!events) {
  console.log(`Scouting seed ${seed}…`);
  const t0 = Date.now();
  events = await evaluate('cinema.scout()');
  console.log(`  events (${((Date.now() - t0) / 1000).toFixed(0)}s):`, JSON.stringify(events));
}
for (const k of ['cell', 'eukaryote', 'organism']) if (events[k] === undefined) console.warn(`  warning: "${k}" never happened in this seed; that scene will be weaker.`);
await evaluate(`cinema.start(${JSON.stringify(events)})`);
const total = await evaluate('cinema.frames');
console.log(`Rendering ${total} frames (${(total / 30).toFixed(0)} s at 30 fps)${preview ? `, preview every ${preview}` : ''}`);

let ffmpeg = null;
if (!preview) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
} else {
  fs.mkdirSync(path.join(root, 'video', 'preview'), { recursive: true });
}

const t0 = Date.now();
for (let f = 0; f < total; f++) {
  const want = !preview || f % preview === 0;
  const url = await evaluate(`cinema.frame(${want}, 0.93)`);
  if (url === null) break;
  if (want && url) {
    const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    if (ffmpeg) { if (!ffmpeg.stdin.write(buf)) await new Promise((r) => ffmpeg.stdin.once('drain', r)); }
    else fs.writeFileSync(path.join(root, 'video', 'preview', `f${String(f).padStart(5, '0')}.jpg`), buf);
  }
  if (f % 150 === 0) {
    const el = (Date.now() - t0) / 1000, eta = (el / (f + 1)) * (total - f - 1);
    console.log(`  frame ${f}/${total}  ${(f / 30).toFixed(0)}s of film  elapsed ${el.toFixed(0)}s  eta ${eta.toFixed(0)}s`);
  }
}

if (ffmpeg) { ffmpeg.stdin.end(); await new Promise((r) => ffmpeg.on('close', r)); console.log(`Wrote ${out}`); }
ws.close();
chrome.kill();
server.kill();
fs.rmSync(profile, { recursive: true, force: true });
