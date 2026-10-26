// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
let revision = null;
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { /* Source archives can be built without a Git checkout. */ }
// Check evidence before replacing the last successful build.
for (const name of ['verification.json', 'benchmarks.json']) {
  let report;
  try { report = JSON.parse(await readFile(resolve(root, 'artifacts', name), 'utf8')); }
  catch { throw new Error(`${name} evidence missing or unreadable. Run npm run verify before building.`); }
  if (report.version !== pkg.version || (revision && report.gitRevision !== revision)) {
    throw new Error(`${name} belongs to a different version or commit. Run npm run verify again.`);
  }
  if (!Array.isArray(report.checks) || !report.checks.length || report.checks.some(check => check.pass !== true)
      || report.passed !== report.checks.length) throw new Error(`${name} contains unsuccessful or incomplete checks.`);
}
const nativeFiles = [['modelica-verification.json', 'engineering-verification.json'], ['modelica/property-verification.json', 'modelica-property-verification.json']];
let includeNative = false;
try {
  const sourceHash = createHash('sha256').update(await readFile(resolve(root, 'models/OpenPWR/package.mo'))).digest('hex');
  for (const [name] of nativeFiles) {
    const report = JSON.parse(await readFile(resolve(root, 'artifacts', name), 'utf8'));
    const reportedSource = report.buildManifest?.sourceSha256 || report.sourceSha256;
    const primary = name === 'modelica-verification.json';
    const manifest = JSON.parse(await readFile(resolve(root, 'artifacts/modelica', primary ? 'manifest.json' : 'property-manifest.json'), 'utf8'));
    const actualHash = createHash('sha256').update(await readFile(resolve(root, 'artifacts/modelica', primary ? 'PrimaryLoop.fmu' : 'PropertyReferenceChecks.fmu'))).digest('hex');
    if (manifest.fmuSha256 !== actualHash || (primary ? report.runtime?.fmuSha256 : report.fmuSha256) !== actualHash
        || manifest.sourceSha256 !== sourceHash) throw new Error(`${name} does not identify the current compiled model`);
    if (report.version !== pkg.version || (revision && report.gitRevision !== revision) || reportedSource !== sourceHash
        || !Array.isArray(report.checks) || !report.checks.length || report.checks.some(check => check.pass !== true)
        || report.passed !== report.checks.length || report.total !== report.checks.length) throw new Error(`${name} is stale or unsuccessful`);
  }
  includeNative = true;
} catch (error) {
  if (process.argv.includes('--require-native')) throw new Error(`Native evidence required: ${error.message}`);
  console.log('Native reports omitted; build/verify the current native model to include them.');
}
let includePlant = false;
try {
  const report = JSON.parse(await readFile(resolve(root, 'artifacts/plant-verification.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(root, 'artifacts/modelica/plant-manifest.json'), 'utf8'));
  const compiledHash = createHash('sha256').update(await readFile(resolve(root, 'artifacts/modelica/CoupledPlant.fmu'))).digest('hex');
  const sourceHash = createHash('sha256').update(await readFile(resolve(root, 'models/OpenPWR/package.mo'))).digest('hex');
  const kineticsManifest = JSON.parse(await readFile(resolve(root, 'artifacts/modelica/kinetics-manifest.json'), 'utf8'));
  const kineticsHash = createHash('sha256').update(await readFile(resolve(root, 'artifacts/modelica/KineticsReference.fmu'))).digest('hex');
  if (report.version !== pkg.version || (revision && report.gitRevision !== revision)
      || manifest.sourceSha256 !== sourceHash || report.buildManifest?.sourceSha256 !== sourceHash
      || manifest.fmuSha256 !== compiledHash || report.runtime?.fmuSha256 !== compiledHash
      || report.runtime.model !== 'OpenPWR.CoupledPlant'
      || kineticsManifest.sourceSha256 !== sourceHash || report.kineticsManifest?.sourceSha256 !== sourceHash
      || kineticsManifest.fmuSha256 !== kineticsHash || report.kineticsManifest?.fmuSha256 !== kineticsHash
      || !Array.isArray(report.checks) || !report.checks.length || report.checks.some(item => item.pass !== true)
      || report.passed !== report.checks.length || report.total !== report.checks.length) throw new Error('Coupled plant report or compiled model is stale or unsuccessful');
  includePlant = true;
} catch (error) {
  if (process.argv.includes('--require-plant')) throw new Error(`Coupled plant evidence required: ${error.message}`);
  console.log('Coupled plant report omitted; build and verify the current native plant to include it.');
}
// Bind every comparison to the executable, its embedded report manifest and all
// inputs to the experiment. Physical disagreement is evidence, not a build error.
async function checkComparisonModel(report, record, model, manifestName, sources) {
  const manifest = JSON.parse(await readFile(resolve(root, 'artifacts/modelica', manifestName), 'utf8'));
  const compiledHash = createHash('sha256').update(await readFile(resolve(root, 'artifacts/modelica', `${model}.fmu`))).digest('hex');
  const embedded = record?.buildManifest;
  if (!embedded || manifest.model !== `OpenPWR.${model}` || embedded.model !== manifest.model
      || record.runtime?.model !== manifest.model || manifest.fmuSha256 !== compiledHash
      || embedded.fmuSha256 !== compiledHash || record.runtime?.fmuSha256 !== compiledHash) {
    throw new Error(`${model} report does not identify the current compiled model`);
  }
  for (const identity of [report, manifest, embedded]) {
    if (identity.version !== pkg.version || (revision && identity.gitRevision !== revision)) {
      throw new Error(`${model} belongs to a different version or commit`);
    }
  }
  for (const [key, path] of Object.entries(sources)) {
    const actual = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
    if (report[key] !== actual || manifest[key] !== actual || embedded[key] !== actual) throw new Error(`${model} ${key} is stale`);
  }
}
function checkComparisonResults(report) {
  if (report.executed !== true || report.schema !== 'openpwr-measured-validation-v1'
      || !['inconclusive', 'failed', 'passed'].includes(report.status)
      || !Array.isArray(report.channels) || !report.channels.length
      || report.channels.some(channel => !Array.isArray(channel.points) || !channel.points.length
        || channel.points.some(point => !Number.isFinite(point.time) || !Number.isFinite(point.measured) || !Number.isFinite(point.simulated)))) throw new Error('Measured case report or model provenance is incomplete');
  // Physical disagreement is evidence; numerically invalid execution is not.
  // Recompute each predicate so a forged aggregate or per-check pass cannot
  // promote an out-of-tolerance residual into publishable evidence.
  if (report.numericalPassed !== true || !Array.isArray(report.numericalChecks) || !report.numericalChecks.length
      || report.numericalChecks.some(check => !check || typeof check.name !== 'string' || !check.name.trim()
        || !Number.isFinite(check.value) || !Number.isFinite(check.absoluteTolerance) || check.absoluteTolerance < 0
        || check.pass !== true || Math.abs(check.value) > check.absoluteTolerance)) throw new Error('Measured case numerical acceptance failed or is incomplete');
}
function comparisonSources(directory, model) {
  return { sourceSha256: 'models/OpenPWR/package.mo', benchmarkModelSha256: `models/${model}.mo`,
    inputDataSha256: `validation/${directory}/measured.csv`, referenceMetadataSha256: `validation/${directory}/provenance.json`,
    comparisonScriptSha256: `validation/${directory}/compare.py`, sharedRunnerSha256: 'validation/native_fmi.py' };
}
let includeMeasured = false;
try {
  const report = JSON.parse(await readFile(resolve(root, 'artifacts/measured-validation.json'), 'utf8'));
  const sources = { ...comparisonSources('krsko2005', 'KrskoTransient'),
    parameterSourcesSha256: 'validation/krsko2005/reference-plant.json', baselineSha256: 'validation/baselines/krsko-v0.5.json' };
  await checkComparisonModel(report, report, 'KrskoTransient', 'krsko-manifest.json', sources);
  await checkComparisonModel(report, report.equilibriumComparison, 'KrskoEquilibrium', 'krsko-equilibrium-manifest.json', sources);
  checkComparisonResults(report);
  // An inconclusive or failed physical comparison remains publishable evidence.
  // Requiring provenance must never silently discard unfavorable measurements.
  includeMeasured = true;
} catch (error) {
  if (process.argv.includes('--require-measured')) throw new Error(`Measured comparison required: ${error.message}`);
  console.log('Measured comparison omitted; run the current measured-case model to include it.');
}
let includePressurizer = false;
try {
  const report = JSON.parse(await readFile(resolve(root, 'artifacts/pressurizer-validation.json'), 'utf8'));
  const sources = { ...comparisonSources('pactel1998', 'PactelPressurizer'),
    holdoutDataSha256: 'validation/pactel1998/holdout-measured.csv', holdoutMetadataSha256: 'validation/pactel1998/holdout-provenance.json',
    holdoutComparatorSha256: 'validation/pactel1998/holdout_compare.py', holdoutExtractorSha256: 'validation/pactel1998/holdout_extract.py',
    holdoutProtocolSha256: 'validation/pactel1998/holdout-protocol.json', holdoutFreezeSha256: 'validation/pactel1998/holdout-freeze.json' };
  await checkComparisonModel(report, report, 'PactelPressurizer', 'pactel-manifest.json', sources);
  checkComparisonResults(report);
  if (!Array.isArray(report.spatialComparisons) || report.spatialComparisons.length !== 3) throw new Error('Wall mesh evidence is incomplete');
  for (const [index, model, manifest, axial, radial] of [[0, 'PactelCoarse', 'pactel-coarse-manifest.json', 12, 4], [1, 'PactelRadialRefined', 'pactel-radial-manifest.json', 12, 8], [2, 'PactelSpatialRefined', 'pactel-spatial-manifest.json', 24, 8]]) {
    const record = report.spatialComparisons[index];
    await checkComparisonModel(report, record, model, manifest, sources);
    if (record.wallMesh?.axialSegments !== axial || record.wallMesh?.radialCells !== radial
        || !Number.isFinite(record.maximumPressureChangeToNextMeshMPa)
        || !Array.isArray(record.balance?.checks) || !record.balance.checks.length
        || record.balance.checks.some(check => check.pass !== true || !Number.isFinite(check.error)
          || !Number.isFinite(check.tolerance) || check.tolerance < 0 || Math.abs(check.error) > check.tolerance)) throw new Error('Wall mesh numerical acceptance failed');
  }
  const held = report.holdoutComparison;
  await checkComparisonModel(report, held, 'PactelPressurizer', 'pactel-manifest.json', sources);
  checkComparisonResults(held);
  for (const [key, parent] of [['inputDataSha256', 'holdoutDataSha256'], ['referenceMetadataSha256', 'holdoutMetadataSha256'],
      ['comparisonScriptSha256', 'holdoutComparatorSha256'], ['sourceSha256', 'sourceSha256'], ['benchmarkModelSha256', 'benchmarkModelSha256'],
      ['sharedRunnerSha256', 'sharedRunnerSha256'], ['holdoutProtocolSha256', 'holdoutProtocolSha256'],
      ['holdoutExtractorSha256', 'holdoutExtractorSha256'], ['holdoutFreezeSha256', 'holdoutFreezeSha256']]) {
    if (held[key] !== report[parent]) throw new Error(`Reserved event ${key} is stale`);
  }
  const protocol = JSON.parse(await readFile(resolve(root, sources.holdoutProtocolSha256), 'utf8'));
  if (JSON.stringify(held.appliedParameters) !== JSON.stringify(protocol.modelParameters)) throw new Error('Reserved event parameters differ from its protocol');
  if (held.version !== report.version || held.gitRevision !== report.gitRevision || held.caseId !== protocol.caseId
      || JSON.stringify(held.comparisonWindowS) !== JSON.stringify(protocol.comparisonWindowS)
      || JSON.stringify(held.simulationWindowS) !== JSON.stringify(protocol.simulationWindowS)
      || held.channels.length !== 1 || held.channels[0].points.length !== 291
      || held.channels[0].points.some((point, index) => point.time !== index + 5)
      || !Array.isArray(held.trace) || held.trace.length !== 296 || held.trace.some((point, index) => point.time !== index || !Number.isFinite(point.pressureMPa))
      || !Array.isArray(held.refinedTrace) || held.refinedTrace.length !== 296 || held.refinedTrace.some((point, index) => point.time !== index || !Number.isFinite(point.pressureMPa))) throw new Error('Reserved event window or identity differs from its protocol');
  includePressurizer = true;
} catch (error) {
  if (process.argv.includes('--require-pressurizer')) throw new Error(`Pressurizer comparison required: ${error.message}`);
  console.log('Pressurizer comparison omitted; run the current independent pressurizer case to include it.');
}
const output = resolve(root, 'dist');
if (output !== root + sep + 'dist') throw new Error('Refusing unexpected build directory');
try {
  const stat = await lstat(output);
  if (stat.isSymbolicLink()) throw new Error('Build directory must not be a symlink');
  await rm(output, { recursive: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'engineering.html', 'engineering-evidence.html', 'plant.html', 'plant-evidence.html', 'verification.html', 'src', 'docs', 'LICENSE', 'NOTICE']) {
  await cp(resolve(root, name), resolve(output, name), { recursive: true });
}
if (includeNative) for (const [from, to] of nativeFiles) await cp(resolve(root, 'artifacts', from), resolve(output, to));
if (includePlant) await cp(resolve(root, 'artifacts/plant-verification.json'), resolve(output, 'plant-verification.json'));
if (includeMeasured) await cp(resolve(root, 'artifacts/measured-validation.json'), resolve(output, 'measured-validation.json'));
if (includePressurizer) await cp(resolve(root, 'artifacts/pressurizer-validation.json'), resolve(output, 'pressurizer-validation.json'));
for (const name of ['verification.json', 'benchmarks.json']) {
  try {
    await cp(resolve(root, 'artifacts', name), resolve(output, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`${name} evidence missing. Run npm run verify before building.`);
  }
}
await writeFile(resolve(output, '.nojekyll'), '');
await writeFile(resolve(output, 'version.json'), JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2));
console.log(`Built ${pkg.name} ${pkg.version} in ${output}. Vendored assets included; no runtime CDN dependencies.`);
