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
import { createHash } from 'node:crypto';
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
  return rows.map(line => Object.fromEntries(line.trim().split(',').map((value, i) => [keys[i], value === 'true' ? true : value === 'false' ? false : value !== '' && Number.isFinite(Number(value)) ? Number(value) : value])));
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
  assert.equal(rows[59].tripped, false);
  assert.equal(rows[60].tripped, true, 'the event-boundary sample includes the command applied at that time');
  assert.equal(rows[60].gridConnected, false);
  assert.equal(typeof rows[60].startupStage, 'string');
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

test('short cold-start CLI records measured stage changes, exact sampling, and action provenance', async (t) => {
  const dir = await fixture(t);
  const output = join(dir, 'cold-start.csv');
  const result = await run(['--scenario=cold-start', '--duration=30.4', '--dt=0.03', `--output=${output}`]);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.scenario, 'cold-start');
  assert.equal(summary.domainExceeded, false);
  assert.ok(Math.abs(summary.simulationTime - 30.4) < 1e-8);
  const rows = parseCsv(await readFile(output, 'utf8'));
  assert.equal(rows.length, 32);
  rows.slice(0, -1).forEach((row, index) => assert.ok(Math.abs(row.time - index) < 1e-8));
  assert.ok(Math.abs(rows.at(-1).time - 30.4) < 1e-8);
  assert.equal(rows[0].startupStage, 'prepared');
  assert.equal(rows[0].hotLegTemp, 25, 'the prepare command must not teleport temperature');
  assert.equal(rows.at(-1).startupStage, 'heatup');
  assert.ok(rows.every(row => row.gridConnected === false && row.electricPower <= 0));
  const report = JSON.parse(await readFile(output + '.json', 'utf8'));
  assert.equal(report.final.startupMode, true);
  assert.equal(report.final.startupStage, 'heatup');
  assert.equal(report.final.tripped, false);
  assert.deepEqual(report.actions.map(action => action.action), ['prepare', 'startHeatup']);
  assert.equal(report.actions[0].time, 0);
  const heatupTime = report.actions[1].time;
  assert.ok(heatupTime > 0 && heatupTime < 30);
  assert.ok(Math.abs(heatupTime - Math.round(heatupTime)) < 1e-8);
  assert.equal(rows[Math.round(heatupTime)].startupStage, 'heatup');
  assert.equal(report.units.auxiliaryHeatMW, 'MW');
  assert.equal(report.units.rotorEnergyMJ, 'MJ');
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
  await writeFile(join(dir, 'artifacts/benchmarks.json'), '{"passed":20}');
  const pressurizerBytes = '{"executed":true,"status":"inconclusive","caseId":"saved-pactel"}';
  await writeFile(join(dir, 'artifacts/pressurizer-validation.json'), pressurizerBytes);
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
    const benchmarks = await fetch(origin + '/benchmarks.json');
    assert.deepEqual(await benchmarks.json(), { passed: 20 });
    const pressurizer = await fetch(origin + '/pressurizer-validation.json');
    assert.equal(pressurizer.status, 200);
    assert.equal(await pressurizer.text(), pressurizerBytes);
    const pressurizerHead = await fetch(origin + '/pressurizer-validation.json', { method: 'HEAD' });
    assert.equal(pressurizerHead.status, 200);
    assert.equal(await pressurizerHead.text(), '');
    for (const route of ['/package.json', '/scripts/serve.mjs', '/src/a%2f..%2f..%2fpackage.json', '/src/%5c..%5cpackage.json', '/%FF']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 404, `excluded route ${route}`);
      assert.doesNotMatch(await response.text(), /must not be exposed/);
    }
    assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
  } finally { await stop(child); }
});

test('release build rejects stale or failed evidence without replacing the last build', async (t) => {
  const dir = await fixture(t);
  for (const name of ['scripts', 'src', 'docs', 'artifacts', 'dist']) await mkdir(join(dir, name));
  await cp(join(root, 'scripts/build.mjs'), join(dir, 'scripts/build.mjs'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'openpwr-fixture', version: '0.2.0', type: 'module' }));
  for (const name of ['index.html', 'engineering.html', 'engineering-evidence.html', 'plant.html', 'startup.html', 'plant-evidence.html', 'verification.html', 'LICENSE', 'NOTICE']) await writeFile(join(dir, name), name);
  const marker = join(dir, 'dist', 'previous.txt');
  await writeFile(marker, 'previous successful build');
  const valid = { version: '0.2.0', gitRevision: null, passed: 1, checks: [{ name: 'Fixture evidence', pass: true }] };
  const saveReport = (name, report) => writeFile(join(dir, 'artifacts', name + '.json'), JSON.stringify(report));
  const build = () => exec(process.execPath, [join(dir, 'scripts/build.mjs')], { cwd: dir, timeout: 10000 });
  await saveReport('verification', valid);
  await saveReport('benchmarks', { ...valid, version: '0.1.0' });
  await assert.rejects(build(), /different version/);
  assert.equal(await readFile(marker, 'utf8'), 'previous successful build');
  await saveReport('benchmarks', { ...valid, passed: 0, checks: [{ pass: false }] });
  await assert.rejects(build(), /unsuccessful or incomplete/);
  assert.equal(await readFile(marker, 'utf8'), 'previous successful build');
  await saveReport('benchmarks', valid);
  await assert.rejects(exec(process.execPath, [join(dir, 'scripts/build.mjs'), '--require-native'], { cwd: dir, timeout: 10000 }), /Native evidence required/);
  assert.equal(await readFile(marker, 'utf8'), 'previous successful build');
  await build();
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'dist/benchmarks.json'), 'utf8')), valid);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('native release evidence binds both reports to the exact compiled bytes before replacing dist', async (t) => {
  const dir = await fixture(t);
  for (const name of ['scripts', 'src', 'docs', 'artifacts/modelica', 'models/OpenPWR']) await mkdir(join(dir, name), { recursive: true });
  await cp(join(root, 'scripts/build.mjs'), join(dir, 'scripts/build.mjs'));
  const version = '0.4.0';
  const json = (path, value) => writeFile(join(dir, path), JSON.stringify(value));
  const sha = value => createHash('sha256').update(value).digest('hex');
  await json('package.json', { name: 'openpwr-native-fixture', version, type: 'module' });
  for (const name of ['index.html', 'engineering.html', 'engineering-evidence.html', 'plant.html', 'startup.html', 'plant-evidence.html', 'verification.html', 'LICENSE', 'NOTICE']) await writeFile(join(dir, name), name);
  // An isolated empty commit exercises the real revision guard without touching
  // the working repository or depending on the developer's identity/signing setup.
  await exec('git', ['init', '--quiet'], { cwd: dir });
  await exec('git', ['-c', 'user.name=Packaging fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(dir, '.git', 'empty-hooks')}`,
    'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Native packaging fixture'], { cwd: dir });
  const gitRevision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  const source = 'within; package OpenPWR "Packaging fixture only" end OpenPWR;\n';
  await writeFile(join(dir, 'models/OpenPWR/package.mo'), source);
  const sourceSha256 = sha(source);
  const passed = { version, gitRevision, passed: 1, total: 1, checks: [{ name: 'Packaging fixture check', pass: true }] };
  await json('artifacts/verification.json', passed); await json('artifacts/benchmarks.json', passed);
  const fixtures = [
    { model: 'OpenPWR.PrimaryLoop', fmu: 'PrimaryLoop.fmu', manifest: 'manifest.json', report: 'modelica-verification.json', published: 'engineering-verification.json', primary: true },
    { model: 'OpenPWR.PropertyReferenceChecks', fmu: 'PropertyReferenceChecks.fmu', manifest: 'property-manifest.json', report: 'modelica/property-verification.json', published: 'modelica-property-verification.json', primary: false },
  ];
  for (const item of fixtures) {
    // The packaging guard hashes bytes; it does not execute or unzip an FMU.
    item.bytes = Buffer.from(`Fake ${item.model} FMU bytes for packaging-only tests\n`);
    const manifest = { version, gitRevision, model: item.model, fmiVersion: '2.0', sourceSha256, fmuSha256: sha(item.bytes) };
    item.evidence = item.primary
      ? { ...passed, schemaVersion: 1, buildManifest: manifest, runtime: { backend: 'fmi2', model: item.model, fmiVersion: '2.0', fmuSha256: manifest.fmuSha256 } }
      : { ...passed, model: item.model, sourceSha256, fmuSha256: manifest.fmuSha256 };
    await writeFile(join(dir, 'artifacts/modelica', item.fmu), item.bytes);
    await json(`artifacts/modelica/${item.manifest}`, manifest);
    await json(`artifacts/${item.report}`, item.evidence);
  }
  const build = () => exec(process.execPath, [join(dir, 'scripts/build.mjs'), '--require-native'], { cwd: dir, timeout: 10000 });
  await build();
  for (const item of fixtures) assert.deepEqual(JSON.parse(await readFile(join(dir, 'dist', item.published), 'utf8')), item.evidence);
  const marker = join(dir, 'dist/last-good.txt'); await writeFile(marker, 'last successful native build');
  for (const item of fixtures) {
    for (const corruption of ['compiled bytes', 'report hash']) {
      if (corruption === 'compiled bytes') await writeFile(join(dir, 'artifacts/modelica', item.fmu), Buffer.concat([item.bytes, Buffer.from('changed without changing source')]));
      else {
        const mismatched = structuredClone(item.evidence);
        if (item.primary) mismatched.runtime.fmuSha256 = '0'.repeat(64);
        else mismatched.fmuSha256 = '0'.repeat(64);
        await json(`artifacts/${item.report}`, mismatched);
      }
      await assert.rejects(build(), /Native evidence required:.*does not identify the current compiled model/, `${item.model}: ${corruption}`);
      assert.equal(await readFile(marker, 'utf8'), 'last successful native build');
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'dist', item.published), 'utf8')), item.evidence, 'the previously published report must remain intact');
      await writeFile(join(dir, 'artifacts/modelica', item.fmu), item.bytes);
      await json(`artifacts/${item.report}`, item.evidence);
    }
  }
});
