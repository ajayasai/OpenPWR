// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { PWRPlant } from '../src/engine.js';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const simulate = resolve(root, 'scripts/simulate.mjs');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'openpwr-cli-'));
  t.after(async () => {
    const target = resolve(dir);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('openpwr-cli-')) throw new Error('Unexpected test cleanup target');
    await rm(target, { recursive: true, force: true });
  });
  return dir;
}
async function run(args) {
  return exec(process.execPath, [simulate, ...args], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
}
function parseCsv(text) {
  const [header, ...rows] = text.trim().split('\n');
  const keys = header.trim().split(',');
  return rows.map(line => Object.fromEntries(line.trim().split(',').map((value, i) => [keys[i], value === 'true' ? true : value === 'false' ? false : Number(value)])));
}

test('headless runner lands on exact 1 s sample boundaries with a nondividing step', async (t) => {
  const dir = await fixture(t);
  const output = join(dir, 'nondividing.csv');
  const result = await run(['--scenario=nominal', '--duration=3.4', '--dt=0.03', `--output=${output}`]);
  const summary = JSON.parse(result.stdout);
  assert.ok(Math.abs(summary.simulationTime - 3.4) < 1e-9);
  const rows = parseCsv(await readFile(output, 'utf8'));
  assert.equal(rows.length, 5);
  const expected = [0, 1, 2, 3, 3.4];
  rows.forEach((row, index) => {
    assert.ok(Math.abs(row.time - expected[index]) < 1e-9, `sample ${index}: ${row.time}`);
    assert.ok(Math.abs(row.electricPower - 1000) < 1);
  });
  const metadata = JSON.parse(await readFile(output + '.json', 'utf8'));
  assert.equal(metadata.schema, 'openpwr-run/v1');
  assert.equal(metadata.units.primaryPressure, 'MPa');
  assert.equal(metadata.final.domainExceeded, false);
});

test('headless SCRAM occurs at 60 s and retains residual heat and negative auxiliary import', async (t) => {
  const dir = await fixture(t);
  const output = join(dir, 'scram.csv');
  await run(['--scenario=scram', '--duration=90', '--dt=0.03', `--output=${output}`]);
  const rows = parseCsv(await readFile(output, 'utf8'));
  assert.equal(rows.length, 91, 'one row per integer second without duplicate final row');
  rows.forEach((row, index) => assert.ok(Math.abs(row.time - index) < 1e-8));
  const metadata = JSON.parse(await readFile(output + '.json', 'utf8'));
  const event = metadata.final.events.find(event => event.message.includes('Headless scenario'));
  assert.ok(event, 'scenario must produce a journal entry');
  assert.ok(Math.abs(event.time - 60) < 1e-9);
  assert.equal(metadata.final.tripped, true);
  assert.ok(metadata.final.neutronPower < .05);
  assert.ok(metadata.final.decayPower > 0);
  assert.ok(metadata.final.electricPower < 0, 'tripped plant continues importing auxiliary electricity');
  assert.equal(metadata.final.domainExceeded, false);
});

test('invalid command-line parameters fail without creating output', async (t) => {
  const dir = await fixture(t);
  for (const bad of ['--scenario=not-a-scenario', '--duration=NaN', '--duration=0', '--dt=0']) {
    const output = join(dir, 'should-not-exist.csv');
    await assert.rejects(run([bad, `--output=${output}`]), error => error.code !== 0);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  const help = await run(['--help']);
  assert.match(help.stdout, /Events occur at t=60 s/);
});

test('negative electrical output survives the same JSON model round trip used by the UI', () => {
  const original = new PWRPlant();
  original.scram('Saved-state import test');
  for (let i = 0; i < 600; i++) original.step(.05);
  assert.ok(original.snapshot().electricPower < 0);
  const session = JSON.parse(JSON.stringify({ format: 'openpwr-session', version: 1, model: original.exportState(), simulationSpeed: 20, paused: true }));
  const restored = new PWRPlant();
  restored.importState(session.model);
  assert.equal(restored.snapshot().electricPower, original.snapshot().electricPower);
  assert.equal(restored.snapshot().tripped, true);
  for (let i = 0; i < 20; i++) { original.step(.05); restored.step(.05); }
  assert.deepEqual(restored.exportState(), original.exportState());
});

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}
async function awaitListening(child) {
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Preview server did not start in time')), 8000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('OpenPWR: http://')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview server exited before readiness: ${code}`)); });
  });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

test('local preview serves only public files, blocks traversal, and implements HEAD', { timeout: 15000 }, async (t) => {
  const dir = await fixture(t);
  for (const name of ['scripts', 'src', 'docs', 'artifacts']) await mkdir(join(dir, name));
  await cp(join(root, 'scripts/serve.mjs'), join(dir, 'scripts/serve.mjs'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Test plant</title>');
  await writeFile(join(dir, 'src/app.js'), 'export const test = true;');
  await writeFile(join(dir, 'docs/MODEL.md'), '# Public model');
  await writeFile(join(dir, 'package.json'), '{"private":"must not be exposed"}');
  await writeFile(join(dir, 'artifacts/verification.json'), '{"passed":10}');
  const port = await unusedPort();
  const child = spawn(process.execPath, [join(dir, 'scripts/serve.mjs'), '--source', `--port=${port}`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await awaitListening(child);
    const origin = `http://127.0.0.1:${port}`;
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /Test plant/);
    const script = await fetch(origin + '/src/app.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    const head = await fetch(origin + '/docs/MODEL.md', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const evidence = await fetch(origin + '/verification.json');
    assert.deepEqual(await evidence.json(), { passed: 10 });
    for (const route of ['/package.json', '/scripts/serve.mjs', '/src/a%2f..%2f..%2fpackage.json', '/src/%5c..%5cpackage.json', '/%FF']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 404, `excluded route ${route}`);
      assert.doesNotMatch(await response.text(), /must not be exposed/);
    }
    assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
  } finally { await stop(child); }
});
