// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const prefix = join(tmpdir(), 'openpwr-evidence-');
  const dir = await mkdtemp(prefix);
  t.after(async () => { assert.ok(resolve(dir).startsWith(resolve(prefix))); await rm(dir, { recursive: true, force: true }); });
  for (const path of ['scripts', 'src', 'docs', 'models/OpenPWR', 'validation/krsko2005', 'artifacts/modelica']) await mkdir(join(dir, path), { recursive: true });
  await cp(join(root, 'scripts/build.mjs'), join(dir, 'scripts/build.mjs'));
  const json = (path, value) => writeFile(join(dir, path), JSON.stringify(value));
  const version = '0.5.0';
  await json('package.json', { name: 'openpwr-evidence-fixture', version, type: 'module' });
  for (const path of ['index.html', 'engineering.html', 'engineering-evidence.html', 'plant.html', 'plant-evidence.html', 'verification.html', 'LICENSE', 'NOTICE']) await writeFile(join(dir, path), path);
  await exec('git', ['init', '--quiet'], { cwd: dir });
  await exec('git', ['-c', 'user.name=Packaging fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(dir, '.git/empty-hooks')}`, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Evidence fixture'], { cwd: dir });
  const gitRevision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  const passed = { version, gitRevision, passed: 1, total: 1, checks: [{ name: 'Packaging-only fixture', pass: true }] };
  await json('artifacts/verification.json', passed); await json('artifacts/benchmarks.json', passed);
  const source = 'within; package OpenPWR end OpenPWR;\n';
  await writeFile(join(dir, 'models/OpenPWR/package.mo'), source);
  const sourceSha256 = sha(source);
  const build = (...flags) => exec(process.execPath, [join(dir, 'scripts/build.mjs'), ...flags], { cwd: dir, timeout: 15000 });
  const artifact = async (name, manifestName, extra = {}) => {
    const bytes = Buffer.from(`Packaging test only: ${name}`);
    const manifest = { version, gitRevision, model: `OpenPWR.${name}`, sourceSha256, fmuSha256: sha(bytes), ...extra };
    await writeFile(join(dir, `artifacts/modelica/${name}.fmu`), bytes);
    await json(`artifacts/modelica/${manifestName}`, manifest);
    return { bytes, manifest };
  };
  return { dir, json, source, sourceSha256, passed, build, artifact };
}

test('coupled plant publication binds both FMUs and current source before replacing prior dist', async t => {
  const f = await fixture(t);
  const plant = await f.artifact('CoupledPlant', 'plant-manifest.json');
  const kinetics = await f.artifact('KineticsReference', 'kinetics-manifest.json');
  const report = { ...f.passed, buildManifest: plant.manifest, kineticsManifest: kinetics.manifest,
    runtime: { model: 'OpenPWR.CoupledPlant', fmuSha256: plant.manifest.fmuSha256 } };
  await f.json('artifacts/plant-verification.json', report);
  await f.build('--require-plant');
  const saved = await readFile(join(f.dir, 'dist/plant-verification.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), report);
  const marker = join(f.dir, 'dist/last-good.txt'); await writeFile(marker, 'previous successful evidence');
  const corruptions = [
    ['plant binary', 'artifacts/modelica/CoupledPlant.fmu', Buffer.concat([plant.bytes, Buffer.from('changed')]), plant.bytes],
    ['kinetics binary', 'artifacts/modelica/KineticsReference.fmu', Buffer.concat([kinetics.bytes, Buffer.from('changed')]), kinetics.bytes],
    ['model source', 'models/OpenPWR/package.mo', f.source + '// changed', f.source],
    ['kinetics manifest', 'artifacts/modelica/kinetics-manifest.json', JSON.stringify({ ...kinetics.manifest, sourceSha256: '0'.repeat(64) }), JSON.stringify(kinetics.manifest)],
    ['plant manifest', 'artifacts/modelica/plant-manifest.json', JSON.stringify({ ...plant.manifest, fmuSha256: '0'.repeat(64) }), JSON.stringify(plant.manifest)],
    ['kinetics report', 'artifacts/plant-verification.json', JSON.stringify({ ...report, kineticsManifest: { ...kinetics.manifest, fmuSha256: '0'.repeat(64) } }), JSON.stringify(report)],
    ['failed verification', 'artifacts/plant-verification.json', JSON.stringify({ ...report, passed: 0, checks: [{ pass: false }] }), JSON.stringify(report)],
  ];
  for (const [label, path, corrupt, original] of corruptions) {
    await writeFile(join(f.dir, path), corrupt);
    await assert.rejects(f.build('--require-plant'), /Coupled plant evidence required/, label);
    assert.equal(await readFile(marker, 'utf8'), 'previous successful evidence', label);
    assert.equal(await readFile(join(f.dir, 'dist/plant-verification.json'), 'utf8'), saved, label);
    await writeFile(join(f.dir, path), original);
  }
});

test('measured publication preserves executed unfavorable results while binding model, data and provenance', async t => {
  const f = await fixture(t);
  const sources = {
    benchmarkModelSha256: ['models/KrskoTransient.mo', 'within OpenPWR; model KrskoTransient end KrskoTransient;\n'],
    inputDataSha256: ['validation/krsko2005/measured.csv', 'time,measured\n0,1\n1,0.9\n'],
    referenceMetadataSha256: ['validation/krsko2005/provenance.json', '{"source":"test fixture only"}'],
    comparisonScriptSha256: ['validation/krsko2005/compare.py', '# Packaging fixture comparison script\n'],
  };
  const hashes = { sourceSha256: f.sourceSha256 };
  for (const [key, [path, bytes]] of Object.entries(sources)) { await writeFile(join(f.dir, path), bytes); hashes[key] = sha(bytes); }
  const compiled = await f.artifact('KrskoTransient', 'krsko-manifest.json', hashes);
  const report = { version: f.passed.version, gitRevision: f.passed.gitRevision, ...hashes, schema: 'openpwr-measured-validation-v1',
    runtime: { model: 'OpenPWR.KrskoTransient', fmuSha256: compiled.manifest.fmuSha256 }, executed: true,
    status: 'inconclusive', channels: [{ name: 'Power', points: [{ time: 0, measured: 1, simulated: 1 }, { time: 1, measured: .9, simulated: .99 }] }] };
  for (const status of ['inconclusive', 'failed', 'passed']) {
    report.status = status;
    await f.json('artifacts/measured-validation.json', report);
    await f.build('--require-measured');
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8')), report);
  }
  report.status = 'failed'; await f.json('artifacts/measured-validation.json', report); await f.build('--require-measured');
  const saved = await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8');
  const marker = join(f.dir, 'dist/last-good.txt'); await writeFile(marker, 'previous measured assessment');
  const alteredFiles = [['artifacts/modelica/KrskoTransient.fmu', compiled.bytes], ['models/OpenPWR/package.mo', f.source], ...Object.values(sources)];
  for (const [path, original] of alteredFiles) {
    await writeFile(join(f.dir, path), Buffer.concat([Buffer.from(original), Buffer.from('changed')]));
    await assert.rejects(f.build('--require-measured'), /Measured comparison required/, path);
    assert.equal(await readFile(marker, 'utf8'), 'previous measured assessment');
    assert.equal(await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8'), saved);
    await writeFile(join(f.dir, path), original);
  }
  for (const invalid of [{ ...report, executed: false }, { ...report, channels: [] },
    { ...report, channels: [{ points: [{ time: 1, measured: .9, simulated: null }] }] },
    { ...report, referenceMetadataSha256: '0'.repeat(64) },
    { ...report, runtime: { ...report.runtime, fmuSha256: '0'.repeat(64) } }]) {
    await f.json('artifacts/measured-validation.json', invalid);
    await assert.rejects(f.build('--require-measured'), /Measured comparison required/);
    assert.equal(await readFile(marker, 'utf8'), 'previous measured assessment');
    assert.equal(await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8'), saved);
  }
});
