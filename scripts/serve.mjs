// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv.includes('--source');
const root = source ? project : resolve(project, 'dist');
const requestedPort = process.argv.find(a => a.startsWith('--port='));
const port = requestedPort ? Number(requestedPort.split('=')[1]) : 4173;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    const url = new URL(req.url, 'http://localhost');
    let route = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (route.split(/[\\/]/).some(part => part === '..' || part === '.')) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const reports = { 'verification.json': 'artifacts/verification.json', 'benchmarks.json': 'artifacts/benchmarks.json', 'engineering-verification.json': 'artifacts/modelica-verification.json', 'modelica-property-verification.json': 'artifacts/modelica/property-verification.json', 'plant-verification.json': 'artifacts/plant-verification.json', 'measured-validation.json': 'artifacts/measured-validation.json' };
    if (source && reports[route]) route = reports[route];
    if (!/^(index\.html|engineering\.html|engineering-evidence\.html|plant\.html|plant-evidence\.html|verification\.html|verification\.json|benchmarks\.json|engineering-verification\.json|modelica-property-verification\.json|plant-verification\.json|measured-validation\.json|version\.json|LICENSE|NOTICE|src\/[^.][\w./-]*|docs\/[^.][\w./-]*|artifacts\/(verification|benchmarks|modelica-verification|plant-verification|measured-validation|modelica\/property-verification)\.json)$/.test(route)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const path = resolve(root, route);
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('Not a public file');
    const data = await readFile(path);
    res.writeHead(200, {
      'Content-Type': types[extname(path)] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found. Run npm run build first, or use npm run dev.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`OpenPWR: http://127.0.0.1:${port} (${source ? 'source' : 'built site'})`));
