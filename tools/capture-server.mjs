// Frame-capture sink for trailer recording.
// Usage: node tools/capture-server.mjs [outDir]
// The in-page trailer recorder POSTs JPEG frames here; assemble with ffmpeg:
//   ffmpeg -framerate 30 -i frame_%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 trailer.mp4
import http from 'http';
import fs from 'fs';
import path from 'path';

const outDir = process.argv[2] || 'trailer-frames';
fs.mkdirSync(outDir, { recursive: true });
let received = 0;
let done = false;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/frame') {
    const n = parseInt(url.searchParams.get('n'), 10);
    if (!Number.isFinite(n)) { res.writeHead(400); res.end('bad n'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const file = path.join(outDir, `frame_${String(n).padStart(5, '0')}.jpg`);
      fs.writeFile(file, Buffer.concat(chunks), (err) => {
        if (!err) received++;
        res.writeHead(err ? 500 : 200);
        res.end(err ? 'err' : 'ok');
      });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/done') {
    done = true;
    res.writeHead(200); res.end('ok');
    return;
  }
  // Trailer audio pipeline: the page POSTs the event log (JSON) captured during
  // recording and, after offline synthesis, the rendered soundtrack (WAV).
  if (req.method === 'POST' && (url.pathname === '/audiolog' || url.pathname === '/wav')) {
    const file = path.join(outDir, url.pathname === '/wav' ? 'soundtrack.wav' : 'audiolog.json');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.writeFile(file, Buffer.concat(chunks), (err) => {
        res.writeHead(err ? 500 : 200);
        res.end(err ? 'err' : 'ok');
      });
    });
    return;
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received, done }));
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(8021, () => console.log(`[capture] listening on :8021 → ${outDir}`));
