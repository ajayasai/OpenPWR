// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEvidenceView, viewSources } from './evidence-view.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv.includes('--source');
const startupReports = new Map([
  ['open-loop-startup-native.json', 'validation/open_loop_startup/native.json'],
  ['open-loop-startup.json', 'validation/open_loop_startup/result.json'],
  ['startup-transfer.json', 'validation/startup_transfer/result.json'],
  ['shippingport-startup.json', 'validation/startup_holdout/result.json'],
  ['shippingport-development.json', 'validation/shippingport_development/result.json'],
]);
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
    const reports = { 'krsko-pressure-development.json': 'artifacts/krsko-pressure-development.json', 'continuous-verification.json': 'artifacts/continuous-verification.json', 'continuous-measured-validation.json': 'artifacts/continuous-measured-validation.json', 'cold-verification.json': 'artifacts/cold-verification.json', 'verification.json': 'artifacts/verification.json', 'benchmarks.json': 'artifacts/benchmarks.json', 'engineering-verification.json': 'artifacts/modelica-verification.json', 'modelica-property-verification.json': 'artifacts/modelica/property-verification.json', 'plant-verification.json': 'artifacts/plant-verification.json', 'measured-validation.json': 'artifacts/measured-validation.json', 'pressurizer-validation.json': 'artifacts/pressurizer-validation.json' };
    const startupView = route === 'continuous-index.json' || route === 'continuous-recording.json';
    const viewSource = startupView ? 'continuous-verification.json' : viewSources.get(route);
    if (source && reports[route]) route = reports[route];
    const startupData = /^validation\/(grid_return|startup_output)\/(raw\/)?[\w.-]+\.(json|md)$/.test(route);
    const startupReport = startupReports.get(route);
    if (!startupReport && !viewSource && !startupData && !/^(experiments\.html|startup-evidence\.html|krsko-pressure-development\.json|continuous\.html|continuous-verification\.json|continuous-measured-validation\.json|startup\.html|cold-verification\.json|index\.html|engineering\.html|engineering-evidence\.html|plant\.html|plant-evidence\.html|verification\.html|verification\.json|benchmarks\.json|engineering-verification\.json|modelica-property-verification\.json|plant-verification\.json|measured-validation\.json|pressurizer-validation\.json|version\.json|LICENSE|NOTICE|src\/[^.][\w./-]*|docs\/[^.][\w./-]*|artifacts\/(krsko-pressure-development|continuous-verification|continuous-measured-validation|cold-verification|verification|benchmarks|modelica-verification|plant-verification|measured-validation|pressurizer-validation|modelica\/property-verification)\.json)$/.test(route)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    if (source && startupReport) route = startupReport;
    const path = resolve(root, source && viewSource ? reports[viewSource] : route);
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('Not a public file');
    let data = await readFile(path);
    if (source && viewSource) {
      try {
        if (startupView) {
          const { makeStartupViews } = await import('./startup-recording.mjs');
          const views = makeStartupViews(data);
          data = Buffer.from(route === 'continuous-index.json' ? views.index : views.recording);
        } else {
          data = Buffer.from(makeEvidenceView(viewSource, data));
        }
      } catch {
        res.writeHead(422); res.end('The source report could not produce this evidence view.'); return;
      }
    }
    res.writeHead(200, {
      'Content-Type': types[extname(path)] || 'text/plain; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found. Run npm run build first, or use npm run dev.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`OpenPWR: http://127.0.0.1:${port} (${source ? 'source' : 'built site'})`));
