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
let includeMeasured = false;
try {
  const report = JSON.parse(await readFile(resolve(root, 'artifacts/measured-validation.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(root, 'artifacts/modelica/krsko-manifest.json'), 'utf8'));
  const compiledHash = createHash('sha256').update(await readFile(resolve(root, 'artifacts/modelica/KrskoTransient.fmu'))).digest('hex');
  const sources = { sourceSha256: 'models/OpenPWR/package.mo', benchmarkModelSha256: 'models/KrskoTransient.mo', inputDataSha256: 'validation/krsko2005/measured.csv', referenceMetadataSha256: 'validation/krsko2005/provenance.json', comparisonScriptSha256: 'validation/krsko2005/compare.py' };
  for (const [key, path] of Object.entries(sources)) {
    const actual = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
    if (report[key] !== actual || manifest[key] !== actual) throw new Error(`Measured case ${key} is stale`);
  }
  if (report.version !== pkg.version || (revision && report.gitRevision !== revision)
      || manifest.fmuSha256 !== compiledHash || report.runtime?.fmuSha256 !== compiledHash
      || report.runtime?.model !== 'OpenPWR.KrskoTransient' || report.executed !== true
      || report.schema !== 'openpwr-measured-validation-v1' || !['inconclusive', 'failed', 'passed'].includes(report.status)
      || !Array.isArray(report.channels) || !report.channels.length
      || report.channels.some(channel => !Array.isArray(channel.points) || !channel.points.length
        || channel.points.some(point => !Number.isFinite(point.time) || !Number.isFinite(point.measured) || !Number.isFinite(point.simulated)))) throw new Error('Measured case report or model provenance is incomplete');
  // An inconclusive or failed physical comparison remains publishable evidence.
  // Requiring provenance must never silently discard unfavorable measurements.
  includeMeasured = true;
} catch (error) {
  if (process.argv.includes('--require-measured')) throw new Error(`Measured comparison required: ${error.message}`);
  console.log('Measured comparison omitted; run the current measured-case model to include it.');
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
