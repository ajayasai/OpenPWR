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
  for (const path of ['scripts', 'src', 'docs', 'backend', 'models/OpenPWR', 'validation/krsko2005', 'validation/pactel1998', 'validation/baselines', 'artifacts/modelica']) await mkdir(join(dir, path), { recursive: true });
  await cp(join(root, 'scripts/build.mjs'), join(dir, 'scripts/build.mjs'));
  const json = (path, value) => writeFile(join(dir, path), JSON.stringify(value));
  const version = '0.6.0';
  await json('package.json', { name: 'openpwr-evidence-fixture', version, type: 'module' });
  for (const path of ['index.html', 'engineering.html', 'engineering-evidence.html', 'plant.html', 'startup.html', 'plant-evidence.html', 'verification.html', 'LICENSE', 'NOTICE']) await writeFile(join(dir, path), path);
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

test('cold startup publication binds its own model and host, and rejects forged verification or missing traces', async t => {
  const f = await fixture(t);
  const sources = { coldSourceSha256: ['models/ColdStartPlant.mo', 'model ColdStartPlant end ColdStartPlant;\n'],
    verificationScriptSha256: ['backend/verify_cold.py', '# Cold verification fixture\n'],
    hostScriptSha256: ['backend/fmi_host.py', '# FMI host fixture\n'],
    profileScriptSha256: ['backend/profiles.py', '# Cold contract fixture\n'],
    sharedRunnerSha256: ['validation/native_fmi.py', '# Native runner fixture\n'] };
  const hashes = { sourceSha256: f.sourceSha256 };
  for (const [key, [path, bytes]] of Object.entries(sources)) { await writeFile(join(f.dir, path), bytes); hashes[key] = sha(bytes); }
  const compiled = await f.artifact('ColdStartPlant', 'cold-manifest.json', { model: 'ColdStartPlant', ...hashes });
  const thermalState = (time, temperature, extras = {}) => ({ time, hotLegTemperatureC: temperature,
    coldLegTemperatureC: temperature, fuelTemperatureC: temperature, pressurizerTemperatureC: temperature,
    secondaryTemperatureC: temperature, primaryPressureMPa: 15.5, secondaryPressureMPa: 6,
    hotStandbyReady: 1, pumpSpeed: 1 - Math.exp(-time / 7), surgeFlowKgS: 0, ...extras });
  const scenario = (id, duration, sample, step, point = time => thermalState(time, 40)) => ({ id, name: id,
    complete: true, durationSeconds: duration, sampleIntervalSeconds: sample, stepSeconds: step,
    runtime: { model: 'ColdStartPlant', fmuSha256: compiled.manifest.fmuSha256 },
    trace: Array.from({ length: duration / sample + 1 }, (_, index) => point(index * sample)) });
  const startupPoint = time => thermalState(time, 40 + 250 * time / 18000);
  const report = { ...f.passed, buildManifest: compiled.manifest, runtime: { model: 'ColdStartPlant', fmuSha256: compiled.manifest.fmuSha256 },
    physicalValidationPassed: false, operatingEnvelope: 'Synthetic packaging fixture only.',
    checks: [{ name: 'Synthetic cold conservation', value: .001, absoluteTolerance: .01, pass: true }],
    scenarios: [scenario('cold-equilibrium', 600, 60, 5), scenario('pump-fine', 600, 1, .5), scenario('pump-coarse', 600, 5, 5),
      scenario('initialization-50c', 10, 1, .5, time => thermalState(time, 50)),
      scenario('charging', 120, 5, 5, time => thermalState(time, 40, { surgeFlowKgS: 1 })),
      scenario('letdown', 120, 5, 5, time => thermalState(time, 40, { surgeFlowKgS: -1 })),
      scenario('startup', 18000, 60, 5, startupPoint), scenario('startup-refined', 18000, 60, 2.5, startupPoint),
      scenario('startup-cooldown', 21600, 60, 5, time => time <= 18000 ? startupPoint(time) : thermalState(time, 290 - 30 * (time - 18000) / 3600))] };
  await f.json('artifacts/cold-verification.json', report);
  await f.build('--require-cold');
  const saved = await readFile(join(f.dir, 'dist/cold-verification.json'), 'utf8');
  const marker = join(f.dir, 'dist/last-good.txt'); await writeFile(marker, 'previous cold assessment');
  for (const [path, original] of [['artifacts/modelica/ColdStartPlant.fmu', compiled.bytes], ['models/OpenPWR/package.mo', f.source], ...Object.values(sources)]) {
    await writeFile(join(f.dir, path), Buffer.concat([Buffer.from(original), Buffer.from('changed')]));
    await assert.rejects(f.build('--require-cold'), /Cold startup evidence required/, path);
    assert.equal(await readFile(marker, 'utf8'), 'previous cold assessment');
    await writeFile(join(f.dir, path), original);
  }
  for (const invalid of [{ ...report, physicalValidationPassed: true }, { ...report, operatingEnvelope: '' },
    { ...report, checks: [{ ...report.checks[0], value: .02 }] },
    { ...report, checks: [{ ...report.checks[0], value: null }] }, { ...report, passed: 0 },
    { ...report, scenarios: [] }, { ...report, scenarios: [{ trace: [] }] },
    { ...report, scenarios: [{ ...report.scenarios[0], complete: false }] },
    { ...report, scenarios: [{ ...report.scenarios[0], durationSeconds: 2 }] },
    { ...report, scenarios: [{ ...report.scenarios[0], sampleIntervalSeconds: .5 }] },
    { ...report, scenarios: [{ ...report.scenarios[0], runtime: { model: 'ColdStartPlant', fmuSha256: 'wrong' } }] },
    { ...report, scenarios: [report.scenarios[0], report.scenarios[0]] },
    { ...report, scenarios: report.scenarios.filter(item => item.id !== 'startup-refined') },
    { ...report, scenarios: report.scenarios.map(item => item.id === 'startup' ? { ...item, trace: item.trace.map((point, i) => i === item.trace.length - 1 ? { ...point, hotStandbyReady: 0 } : point) } : item) },
    { ...report, scenarios: report.scenarios.map(item => item.id === 'startup-refined' ? { ...item, trace: item.trace.map((point, i) => i === 1 ? { ...point, primaryPressureMPa: point.primaryPressureMPa + .01 } : point) } : item) },
    { ...report, scenarios: report.scenarios.map(item => item.id === 'pump-coarse' ? { ...item, trace: item.trace.map((point, i) => i === 1 ? { ...point, coldLegTemperatureC: point.coldLegTemperatureC + .01 } : point) } : item) },
    { ...report, scenarios: report.scenarios.map(item => item.id === 'startup-cooldown' ? { ...item, trace: item.trace.map(point => point.time > 18000 ? { ...point, coldLegTemperatureC: 290 } : point) } : item) },
    { ...report, scenarios: [{ trace: [{ time: 0 }, { time: 0 }] }] },
    { ...report, scenarios: [{ trace: [{ time: 0, temperatureK: 300 }, { time: 1, temperatureK: null }] }] },
    { ...report, buildManifest: { ...compiled.manifest, hostScriptSha256: '0'.repeat(64) } },
    { ...report, runtime: { ...report.runtime, model: 'OpenPWR.CoupledPlant' } },
    { ...report, gitRevision: 'other-commit' }]) {
    await f.json('artifacts/cold-verification.json', invalid);
    await assert.rejects(f.build('--require-cold'), /Cold startup evidence required/);
    assert.equal(await readFile(marker, 'utf8'), 'previous cold assessment');
    assert.equal(await readFile(join(f.dir, 'dist/cold-verification.json'), 'utf8'), saved);
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
  const prior = JSON.parse(await readFile(join(root, 'validation/baselines/pressurizer-v0.7.json'), 'utf8'));
  const protocol = JSON.parse(await readFile(join(root, 'validation/pactel1998/holdout-protocol.json'), 'utf8'));
  const withBaseline = old => {
    const points = old.points.map(point => ({ ...point, baseline: point.simulated, simulated: point.simulated + .1 }));
    const oldRmse = Math.sqrt(old.points.reduce((sum, point) => sum + (point.simulated - point.measured) ** 2, 0) / points.length);
    const newRmse = Math.sqrt(points.reduce((sum, point) => sum + (point.simulated - point.measured) ** 2, 0) / points.length);
    return { ...old, points, metrics: { ...old.metrics, v07BaselineRmse: oldRmse,
      rmseChangeFromV07: newRmse - oldRmse, rmseReductionFractionFromV07: 1 - newRmse / oldRmse } };
  };
  const sources = {
    benchmarkModelSha256: ['models/PactelPressurizer.mo', 'within OpenPWR; model PactelPressurizer end PactelPressurizer;\n'],
    inputDataSha256: ['validation/pactel1998/measured.csv', 'time,pressureMPa\n0,5.9\n1,6.0\n'],
    referenceMetadataSha256: ['validation/pactel1998/provenance.json', '{"source":"fixture only"}'],
    comparisonScriptSha256: ['validation/pactel1998/compare.py', '# Packaging fixture comparison\n'],
    sharedRunnerSha256: ['validation/native_fmi.py', '# Packaging fixture native runner\n'],
    developmentComparatorSha256: ['validation/pactel1998/post_unblinding_compare.py', '# Development comparison fixture\n'],
  };
  for (const [key, path] of Object.entries({ holdoutDataSha256: 'validation/pactel1998/holdout-measured.csv',
    holdoutMetadataSha256: 'validation/pactel1998/holdout-provenance.json', holdoutComparatorSha256: 'validation/pactel1998/holdout_compare.py',
    holdoutExtractorSha256: 'validation/pactel1998/holdout_extract.py', holdoutProtocolSha256: 'validation/pactel1998/holdout-protocol.json',
    holdoutFreezeSha256: 'validation/pactel1998/holdout-freeze.json', v07BaselineSha256: 'validation/baselines/pressurizer-v0.7.json' })) {
    sources[key] = [path, await readFile(join(root, path), 'utf8')];
  }
  const hashes = { sourceSha256: f.sourceSha256 };
  for (const [key, [path, bytes]] of Object.entries(sources)) { await writeFile(join(f.dir, path), bytes); hashes[key] = sha(bytes); }
  const compiled = await f.artifact('PactelPressurizer', 'pactel-manifest.json', hashes);
  const report = { version: f.passed.version, gitRevision: f.passed.gitRevision, ...hashes,
    schema: 'openpwr-measured-validation-v1', runtime: { model: 'OpenPWR.PactelPressurizer', fmuSha256: compiled.manifest.fmuSha256 },
    buildManifest: compiled.manifest, executed: true, validationPassed: false, ...numericalEvidence(), status: 'inconclusive',
    releasedBaseline: { version: prior.version, gitRevision: prior.gitRevision, reportSha256: hashes.v07BaselineSha256 },
    channels: [withBaseline(prior.channels[0])] };
  report.holdoutComparison = { ...structuredClone(report), inputDataSha256: hashes.holdoutDataSha256,
    referenceMetadataSha256: hashes.holdoutMetadataSha256, comparisonScriptSha256: hashes.developmentComparatorSha256,
    historicalCandidateFreeze: prior.holdoutComparison.candidateFreeze,
    comparisonRole: 'post-unblinding-development', heldOutFromCurrentDevelopment: false,
    appliedParameters: protocol.modelParameters, caseId: protocol.caseId, comparisonWindowS: [5, 295], simulationWindowS: [0, 295],
    channels: [withBaseline(prior.holdoutComparison.channels[0])],
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
    { ...report, holdoutComparison: { ...report.holdoutComparison, heldOutFromCurrentDevelopment: true } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, comparisonRole: 'independent-holdout' } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, candidateFreeze: report.holdoutComparison.historicalCandidateFreeze } },
    { ...report, holdoutComparison: { ...report.holdoutComparison, historicalCandidateFreeze: {} } },
    { ...report, releasedBaseline: { ...report.releasedBaseline, version: '0.8.0' } },
    { ...report, channels: [{ ...report.channels[0], metrics: { ...report.channels[0].metrics, v07BaselineRmse: 0 } }] },
    { ...report, channels: [{ ...report.channels[0], points: report.channels[0].points.map((point, i) => i ? point : { ...point, baseline: 0 }) }] },
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
