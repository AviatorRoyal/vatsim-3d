// Zero-dependency static file server for local development.
// The VATSIM Data API sends `Access-Control-Allow-Origin: *`, so the browser
// fetches it directly; this server serves the app's own files and forwards
// /api/ to the flight-path service (server/tracks.mjs) on TRACKS_PORT, like nginx does on EC2.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TRACKS_PORT = Number(process.env.TRACKS_PORT) || 8787;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http
  .createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const up = http.request({ host: '127.0.0.1', port: TRACKS_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"tracks service not running"}'));
      req.pipe(up);
      return;
    }
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^([/\\])+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(PORT, () => console.log(`VATSIM 3D running at http://localhost:${PORT}`));
