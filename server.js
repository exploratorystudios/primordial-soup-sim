// Tiny dependency-free static server (ES modules need http://, not file://).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = +process.env.PORT || 8080;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  // (The page asks whether it's watching a world on a simulation server; this one serves the page only.)
  if (url === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"live":false}'); return; }
  const file = path.normalize(path.join(root, url === '/' ? 'index.html' : url));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      // Cross-origin isolation: lets the page use shared memory, so the simulation can run on several threads.
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
});

// If the port is taken, try the next one.
let tryPort = port;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && tryPort < port + 20) server.listen(++tryPort, '127.0.0.1');
  else throw e;
});
server.on('listening', () => console.log(`Primordial Soup running at http://localhost:${tryPort}`));
server.listen(tryPort, '127.0.0.1');
