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
const numericalEvidence = () => ({ numericalPassed: true,
  numericalChecks: [{ name: 'Packaging fixture conservation', value: -.01, absoluteTolerance: .1, pass: true }] });

function invalidNumericalReports(report) {
  const check = report.numericalChecks[0];
  return [
    ['failed aggregate', { ...report, numericalPassed: false }],
    ['missing aggregate', { ...report, numericalPassed: undefined }],
    ['failed check with passing aggregate', { ...report, numericalChecks: [{ ...check, pass: false }] }],
    ['out-of-tolerance value with forged passes', { ...report, numericalChecks: [{ ...check, value: -.11 }] }],
    ['missing checks', { ...report, numericalChecks: undefined }],
    ['empty checks', { ...report, numericalChecks: [] }],
    ['nonfinite value', { ...report, numericalChecks: [{ ...check, value: null }] }],
    ['nonfinite tolerance', { ...report, numericalChecks: [{ ...check, absoluteTolerance: null }] }],
    ['negative tolerance', { ...report, numericalChecks: [{ ...check, absoluteTolerance: -.1 }] }],
    ['unnamed check', { ...report, numericalChecks: [{ ...check, name: '' }] }],
  ];
}

async function fixture(t) {
  const prefix = join(tmpdir(), 'openpwr-evidence-');
  const dir = await mkdtemp(prefix);
  t.after(async () => { assert.ok(resolve(dir).startsWith(resolve(prefix))); await rm(dir, { recursive: true, force: true }); });
  for (const path of ['scripts', 'src', 'docs', 'models/OpenPWR', 'validation/krsko2005', 'validation/pactel1998', 'validation/baselines', 'artifacts/modelica']) await mkdir(join(dir, path), { recursive: true });
  await cp(join(root, 'scripts/build.mjs'), join(dir, 'scripts/build.mjs'));
  const json = (path, value) => writeFile(join(dir, path), JSON.stringify(value));
  const version = '0.6.0';
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
    sharedRunnerSha256: ['validation/native_fmi.py', '# Packaging fixture shared native runner\n'],
    parameterSourcesSha256: ['validation/krsko2005/reference-plant.json', '{"parameters":"fixture only"}'],
    baselineSha256: ['validation/baselines/krsko-v0.5.json', '{"baseline":"fixture only"}'],
  };
  const hashes = { sourceSha256: f.sourceSha256 };
  for (const [key, [path, bytes]] of Object.entries(sources)) { await writeFile(join(f.dir, path), bytes); hashes[key] = sha(bytes); }
  const compiled = await f.artifact('KrskoTransient', 'krsko-manifest.json', hashes);
  const equilibrium = await f.artifact('KrskoEquilibrium', 'krsko-equilibrium-manifest.json', hashes);
  const report = { version: f.passed.version, gitRevision: f.passed.gitRevision, ...hashes, schema: 'openpwr-measured-validation-v1',
    runtime: { model: 'OpenPWR.KrskoTransient', fmuSha256: compiled.manifest.fmuSha256 }, buildManifest: compiled.manifest, executed: true,
    equilibriumComparison: { runtime: { model: 'OpenPWR.KrskoEquilibrium', fmuSha256: equilibrium.manifest.fmuSha256 }, buildManifest: equilibrium.manifest },
    ...numericalEvidence(), status: 'inconclusive', channels: [{ name: 'Power', points: [{ time: 0, measured: 1, simulated: 1 }, { time: 1, measured: .9, simulated: .99 }] }] };
  for (const status of ['inconclusive', 'failed', 'passed']) {
    report.status = status;
    await f.json('artifacts/measured-validation.json', report);
    await f.build('--require-measured');
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8')), report);
  }
  report.status = 'failed'; await f.json('artifacts/measured-validation.json', report); await f.build('--require-measured');
  const saved = await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8');
  const marker = join(f.dir, 'dist/last-good.txt'); await writeFile(marker, 'previous measured assessment');
  const alteredFiles = [['artifacts/modelica/KrskoTransient.fmu', compiled.bytes], ['artifacts/modelica/KrskoEquilibrium.fmu', equilibrium.bytes], ['models/OpenPWR/package.mo', f.source], ...Object.values(sources)];
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
    { ...report, equilibriumComparison: null },
    { ...report, equilibriumComparison: { ...report.equilibriumComparison, runtime: { ...report.equilibriumComparison.runtime, fmuSha256: '0'.repeat(64) } } },
    { ...report, equilibriumComparison: { ...report.equilibriumComparison, buildManifest: { ...equilibrium.manifest, sharedRunnerSha256: '0'.repeat(64) } } },
    { ...report, buildManifest: { ...compiled.manifest, baselineSha256: '0'.repeat(64) } },
    { ...report, runtime: { ...report.runtime, fmuSha256: '0'.repeat(64) } }]) {
    await f.json('artifacts/measured-validation.json', invalid);
    await assert.rejects(f.build('--require-measured'), /Measured comparison required/);
    assert.equal(await readFile(marker, 'utf8'), 'previous measured assessment');
    assert.equal(await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8'), saved);
  }
  // report.status is deliberately "failed": physical failure was accepted
  // above, while any numerical failure must preserve the previous publication.
  for (const [label, invalid] of invalidNumericalReports(report)) {
    await f.json('artifacts/measured-validation.json', invalid);
    await assert.rejects(f.build('--require-measured'), /numerical acceptance failed/, label);
    assert.equal(await readFile(marker, 'utf8'), 'previous measured assessment', label);
    assert.equal(await readFile(join(f.dir, 'dist/measured-validation.json'), 'utf8'), saved, label);
  }
  await f.json('artifacts/measured-validation.json', report);
  for (const [path, original] of [['krsko-manifest.json', compiled.manifest], ['krsko-equilibrium-manifest.json', equilibrium.manifest]]) {
    const { sharedRunnerSha256, ...missingRunner } = original;
    await f.json(`artifacts/modelica/${path}`, missingRunner);
    await assert.rejects(f.build('--require-measured'), /sharedRunnerSha256 is stale/);
    assert.equal(await readFile(marker, 'utf8'), 'previous measured assessment');
    await f.json(`artifacts/modelica/${path}`, original);
  }
});

test('independent pressurizer publication requires current runner, reference and executable while retaining disagreement', async t => {
  const f = await fixture(t);
  const sources = {
    benchmarkModelSha256: ['models/PactelPressurizer.mo', 'within OpenPWR; model PactelPressurizer end PactelPressurizer;\n'],
    inputDataSha256: ['validation/pactel1998/measured.csv', 'time,pressureMPa\n0,5.9\n1,6.0\n'],
    referenceMetadataSha256: ['validation/pactel1998/provenance.json', '{"source":"fixture only"}'],
    comparisonScriptSha256: ['validation/pactel1998/compare.py', '# Packaging fixture comparison\n'],
    sharedRunnerSha256: ['validation/native_fmi.py', '# Packaging fixture native runner\n'],
    holdoutDataSha256: ['validation/pactel1998/holdout-measured.csv', 'time,pressureMPa\n5,5.9\n'],
    holdoutMetadataSha256: ['validation/pactel1998/holdout-provenance.json', '{}'],
    holdoutComparatorSha256: ['validation/pactel1998/holdout_compare.py', '# Reserved-event fixture\n'],
    holdoutExtractorSha256: ['validation/pactel1998/holdout_extract.py', '# Extraction fixture\n'],
    holdoutProtocolSha256: ['validation/pactel1998/holdout-protocol.json', '{"caseId":"fixture","modelParameters":{"initialLevelM":3.5},"comparisonWindowS":[5,295],"simulationWindowS":[0,295]}'],
    holdoutFreezeSha256: ['validation/pactel1998/holdout-freeze.json', '{"frozen":true}'],
  };
  const hashes = { sourceSha256: f.sourceSha256 };
  for (const [key, [path, bytes]] of Object.entries(sources)) { await writeFile(join(f.dir, path), bytes); hashes[key] = sha(bytes); }
  const compiled = await f.artifact('PactelPressurizer', 'pactel-manifest.json', hashes);
  const report = { version: f.passed.version, gitRevision: f.passed.gitRevision, ...hashes,
    schema: 'openpwr-measured-validation-v1', runtime: { model: 'OpenPWR.PactelPressurizer', fmuSha256: compiled.manifest.fmuSha256 },
    buildManifest: compiled.manifest, executed: true, validationPassed: false, ...numericalEvidence(), status: 'inconclusive',
    channels: [{ name: 'Pressure', unit: 'MPa', points: [{ time: 0, measured: 5.9, simulated: 5.9 }, { time: 1, measured: 6.0, simulated: 6.3 }] }] };
  report.holdoutComparison = { ...structuredClone(report), inputDataSha256: hashes.holdoutDataSha256,
    referenceMetadataSha256: hashes.holdoutMetadataSha256, comparisonScriptSha256: hashes.holdoutComparatorSha256,
    appliedParameters: { initialLevelM: 3.5 }, caseId: 'fixture', comparisonWindowS: [5, 295], simulationWindowS: [0, 295],
    channels: [{ name: 'Pressure', points: Array.from({ length: 291 }, (_, index) => ({ time: index + 5, measured: 5.9, simulated: 6.1 })) }],
    trace: Array.from({ length: 296 }, (_, time) => ({ time, pressureMPa: 6.1 })),
    refinedTrace: Array.from({ length: 296 }, (_, time) => ({ time, pressureMPa: 6.1 })) };
  report.spatialComparisons = [];
  const meshArtifacts = [];
  for (const [model, manifest, axial, radial] of [['PactelCoarse', 'pactel-coarse-manifest.json', 12, 4], ['PactelRadialRefined', 'pactel-radial-manifest.json', 12, 8], ['PactelSpatialRefined', 'pactel-spatial-manifest.json', 24, 8]]) {
    const artifact = await f.artifact(model, manifest, hashes); meshArtifacts.push([`artifacts/modelica/${model}.fmu`, artifact.bytes]);
    report.spatialComparisons.push({ wallMesh: { axialSegments: axial, radialCells: radial },
      runtime: { model: `OpenPWR.${model}`, fmuSha256: artifact.manifest.fmuSha256 }, buildManifest: artifact.manifest,
      maximumPressureChangeToNextMeshMPa: .01, balance: { checks: [{ pass: true, error: .001, tolerance: .005 }] } });
  }
  for (const status of ['inconclusive', 'failed']) {
    report.status = status;
    await f.json('artifacts/pressurizer-validation.json', report);
    await f.build('--require-pressurizer');
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'dist/pressurizer-validation.json'), 'utf8')), report);
  }
  const saved = await readFile(join(f.dir, 'dist/pressurizer-validation.json'), 'utf8');
  const marker = join(f.dir, 'dist/last-good.txt'); await writeFile(marker, 'previous pressurizer assessment');
  const changedFiles = [['artifacts/modelica/PactelPressurizer.fmu', compiled.bytes], ...meshArtifacts, ['models/OpenPWR/package.mo', f.source], ...Object.values(sources)];
  for (const [path, original] of changedFiles) {
    await writeFile(join(f.dir, path), Buffer.concat([Buffer.from(original), Buffer.from('changed')]));
    await assert.rejects(f.build('--require-pressurizer'), /Pressurizer comparison required/, path);
    assert.equal(await readFile(marker, 'utf8'), 'previous pressurizer assessment');
    assert.equal(await readFile(join(f.dir, 'dist/pressurizer-validation.json'), 'utf8'), saved);
    await writeFile(join(f.dir, path), original);
  }
  for (const invalid of [{ ...report, executed: false }, { ...report, channels: [] },
    { ...report, channels: [{ points: [{ time: 0, measured: null, simulated: 5.9 }] }] },
    { ...report, buildManifest: { ...compiled.manifest, sharedRunnerSha256: '0'.repeat(64) } },
    { ...report, runtime: { ...report.runtime, model: 'OpenPWR.KrskoTransient' } },
    { ...report, spatialComparisons: [] },
    { ...report, holdoutComparison: { ...report.holdoutComparison, inputDataSha256: '0'.repeat(64) } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, appliedParameters: { initialLevelM: 4 } } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, numericalPassed: false } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, gitRevision: 'other' } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, caseId: 'other' } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, trace: report.holdoutComparison.trace.slice(0, 295) } },
    { ...report, gitRevision: 'other-commit' }]) {
    await f.json('artifacts/pressurizer-validation.json', invalid);
    await assert.rejects(f.build('--require-pressurizer'), /Pressurizer comparison required/);
    assert.equal(await readFile(marker, 'utf8'), 'previous pressurizer assessment');
  }
  for (const [label, invalid] of invalidNumericalReports(report)) {
    await f.json('artifacts/pressurizer-validation.json', invalid);
    await assert.rejects(f.build('--require-pressurizer'), /numerical acceptance failed/, label);
    assert.equal(await readFile(marker, 'utf8'), 'previous pressurizer assessment', label);
    assert.equal(await readFile(join(f.dir, 'dist/pressurizer-validation.json'), 'utf8'), saved, label);
  }
  await f.json('artifacts/pressurizer-validation.json', report);
  const { sharedRunnerSha256, ...missingRunner } = compiled.manifest;
  await f.json('artifacts/modelica/pactel-manifest.json', missingRunner);
  await assert.rejects(f.build('--require-pressurizer'), /sharedRunnerSha256 is stale/);
  assert.equal(await readFile(marker, 'utf8'), 'previous pressurizer assessment');
  await f.build();
  await assert.rejects(readFile(join(f.dir, 'dist/pressurizer-validation.json')), { code: 'ENOENT' }, 'optional build must omit stale evidence');
});
