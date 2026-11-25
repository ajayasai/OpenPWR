// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'validation/startup_holdout');
const protocol = JSON.parse(await readFile(resolve(folder, 'protocol.json')));
const pin = protocol.prediction;
const fields = [...pin.channels, 'syncPermissive', 'gridConnected'];
const channelMap = {
  hotLegTemperature: ['hotLegTemperatureC', '°C'],
  coldLegTemperature: ['coldLegTemperatureC', '°C'],
  pressurizerTemperature: ['pressurizerTemperatureC', '°C'],
  primaryPressure: ['primaryPressureMPa', 'MPa absolute'],
  averageCoolantTemperature: ['meanLegTemperatureC', '°C'],
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value) + '\n';
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };

function extract(bytes, frozen) {
  const report = JSON.parse(bytes);
  if (frozen) {
    requireThat(digest(bytes) === pin.reportSha256 && report.gitRevision === pin.revision
      && 'v' + report.version === pin.release && report.runtime?.fmuSha256 === pin.fmuSha256,
    'The archive does not match the preregistered release.');
  }
  const cases = report.scenarios?.filter(c => c.id === pin.scenario);
  const scenario = cases?.[0];
  requireThat(cases?.length === 1 && report.runtime?.model === pin.model && scenario.runtime.model === pin.model
    && report.runtime.fmuSha256 === scenario.runtime.fmuSha256 && report.passed === report.total
    && report.checks?.every(c => c.pass === true) && report.gitDirty === false
    && scenario.complete === true && scenario.singleFmuInstance === true && scenario.resetCount === 0
    && scenario.durationSeconds === pin.durationSeconds && scenario.sampleIntervalSeconds === pin.sampleIntervalSeconds,
  'Expected a verified, uninterrupted native full-startup run.');
  const rows = scenario.trace.map((p, i) => {
    requireThat(p.time === i * pin.sampleIntervalSeconds && fields.every(k => Number.isFinite(p[k]))
      && [0,1].includes(p.gridConnected) && [0,1].includes(p.syncPermissive), 'Incomplete native observation.');
    return [p.time, ...fields.map(k => p[k])];
  });
  requireThat(rows.at(-1)?.[0] === pin.durationSeconds, 'Incomplete native clock.');
  return { columns: ['time', ...fields], rows };
}

function minutesOnClock(clock) {
  requireThat(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(clock), 'Expected a minute-resolution station clock.');
  // Both dates are on the same historical local clock. UTC arithmetic avoids host time-zone conversion.
  const ms = Date.parse(clock + ':00Z');
  requireThat(Number.isFinite(ms) && new Date(ms).toISOString().slice(0,16) === clock, 'Unknown station date or time.');
  return ms / 60000;
}

export function scorePoints(points) {
  const scored = points.filter(p => p.excluded === null && p.error !== null);
  const n = scored.length;
  if (!n) return { n, bias: null, mae: null, rmse: null, maxAbs: null, firstElapsedS: null, lastElapsedS: null };
  const errors = scored.map(p => p.error);
  return { n, bias: errors.reduce((a,b) => a+b, 0) / n,
    mae: errors.reduce((a,b) => a+Math.abs(b), 0) / n,
    rmse: Math.sqrt(errors.reduce((a,b) => a+b*b, 0) / n), maxAbs: Math.max(...errors.map(Math.abs)),
    firstElapsedS: scored[0].elapsedS, lastElapsedS: scored.at(-1).elapsedS };
}

export function interpolate(trace, seconds) {
  if (seconds < 0 || seconds > trace.at(-1).elapsedS) return null;
  const i = Math.floor(seconds / pin.sampleIntervalSeconds);
  const a = trace[i];
  if (a.elapsedS === seconds) return a.value;
  const b = trace[i+1];
  return a.value + (b.value-a.value) * ((seconds-a.elapsedS)/(b.elapsedS-a.elapsedS));
}

function compareChannel(channel, native, origin) {
  const mapping = channelMap[channel.key];
  requireThat(mapping && channel.unit === mapping[1] && channel.points.length > 0, 'Unsupported channel or unit: ' + channel.key);
  const [property, unit] = mapping;
  const idx = field => native.columns.indexOf(field);
  const modelTrace = native.rows.map(row => ({ elapsedS: row[0], value: property === 'meanLegTemperatureC'
    ? (row[idx('hotLegTemperatureC')] + row[idx('coldLegTemperatureC')]) / 2 : row[idx(property)] }));
  const points = channel.points.map(p => {
    const elapsedS = (minutesOnClock(p.at) - origin) * 60;
    requireThat(elapsedS >= 0 && Number.isFinite(p.value) && Number.isInteger(p.page) && p.page > 0,
      'Missing measurement, acquisition clock or source page.');
    const pressure = channel.key === 'primaryPressure';
    const converted = pressure ? 0.101325 + p.raw * 0.006894757293168 : (p.raw-32) * 5/9;
    requireThat(Number.isFinite(p.raw) && channel.rawUnit === (pressure ? 'psig' : '°F')
      && Math.abs(converted-p.value) <= 5.01e-10, 'Normalized measurement differs from original reading.');
    const predicted = interpolate(modelTrace, elapsedS);
    const excluded = p.excluded || null;
    return { elapsedS, observed: p.value, predicted,
      error: predicted === null || excluded ? null : predicted - p.value, excluded, page: p.page, at: p.at, raw: p.raw };
  });
  requireThat(points.every((p,i) => i === 0 || p.elapsedS > points[i-1].elapsedS), 'Expected distinct increasing acquisition times.');
  return { key: channel.key, label: channel.label, unit, rawUnit: channel.rawUnit, description: channel.description, property, modelTrace, points,
    scores: scorePoints(points), unpairedCount: points.filter(p => p.predicted === null && !p.excluded).length,
    excludedCount: points.filter(p => p.excluded).length };
}

function makeReport(native, data, observationHash, projectionHash) {
  const origin = minutesOnClock(data.origin);
  requireThat(data.source.pdfSha256 === protocol.source.pdfSha256 && data.source.catalogUrl === protocol.source.url,
    'Measurements refer to a different source.');
  const ready = native.rows.find(row => row[native.columns.indexOf('syncPermissive')] === 1 && row[native.columns.indexOf('gridConnected')] === 0);
  requireThat(ready && data.synchronism && data.channels.length && Array.isArray(data.limitations), 'Incomplete event or model metadata.');
  const observedSeconds = (minutesOnClock(data.synchronism) - origin) * 60;
  const channels = data.channels.map(c => compareChannel(c, native, origin));
  requireThat(new Set(channels.map(c=>c.key)).size === channels.length, 'Duplicate comparison channel.');
  return { schema: 'openpwr-shippingport-startup-v1', caseId: protocol.caseId, status: 'inconclusive', physicalValidationPassed: false,
    source: protocol.source, prediction: pin, observationSha256: observationHash, projectionSha256: projectionHash,
    protocolRevision: 'b53d17d39aaf42b75a4b71cd542049b61ad7ff20',
    scope: 'The released model reaches high primary coolant temperature and pressure much earlier than Shippingport did. The comparison uses the original generic startup schedule. Differences in design, initial conditions and station operating history limit what these errors establish about individual equations.',
    alignment: data.originBasis + ' Both clocks retain all elapsed time, including the interruption. Predictions end at 7.5 hours.',
    origin: data.origin, limitations: data.limitations, unreadable: data.unreadable,
    periodicLoggingGap: data.periodicLoggingGap, sourcePages: data.source.pageReference,
    milestone: { label: 'Turbine synchronism', observedSeconds, predictedSeconds: ready[0], errorSeconds: null, breakerObserved: false,
      note: 'Shippingport reported turbine synchronism with the main generator breaker open. The native marker is the first retained open-breaker synchronization permissive. These describe different criteria. Historical grid-connection timing and electrical export are unobserved.' },
    channels };
}

async function run() {
  const [mode = '--check', path] = process.argv.slice(2);
  const predictionFile = resolve(folder, 'prediction.json');
  if (mode === '--capture' || mode === '--verify-archive') {
    const projected = encode(extract(await readFile(path), true));
    if (mode === '--capture') await writeFile(predictionFile, projected);
    else requireThat(await readFile(predictionFile, 'utf8') === projected, 'Frozen projection differs from the original native report.');
    return;
  }
  const projectionBytes = await readFile(predictionFile);
  requireThat(digest(projectionBytes) === '821affffa988aae547596135c0164aed0c19b0e9179a4aa2e829064cf02b85d8',
    'Frozen v0.15.0 projection fingerprint mismatch. Reproduce it with --capture and the original release report.');
  const native = JSON.parse(projectionBytes);
  requireThat(JSON.stringify(native.columns) === JSON.stringify(['time', ...fields]) && native.rows.length === 901
    && native.rows.every((r,i) => r.length === native.columns.length && r[0] === i*pin.sampleIntervalSeconds && r.every(Number.isFinite)),
  'Invalid frozen model projection.');
  if (mode === '--repeat') {
    const bytes = await readFile(path);
    const report = JSON.parse(bytes);
    const { version } = JSON.parse(await readFile(resolve(root, 'package.json')));
    const revision = execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    requireThat(report.version === version && report.gitRevision === revision && digest(bytes) !== pin.reportSha256,
      'Re-execution requires a newly generated report for this checkout.');
    const rerun = extract(bytes, false);
    const maxDifference = Object.fromEntries(native.columns.map(name => [name, 0]));
    for (const [i,row] of native.rows.entries()) for (const [j,value] of row.entries()) {
      const field = native.columns[j];
      const limit = field.includes('TemperatureC') ? 0.01 : field === 'primaryPressureMPa' ? 0.001 : 0;
      const difference = Math.abs(rerun.rows[i][j]-value);
      maxDifference[field] = Math.max(maxDifference[field], difference);
      requireThat(difference <= limit, 'Native rerun differs from the released prediction: ' + field + ' at ' + row[0] + ' s.');
    }
    console.log('Maximum differences across the full native observation grid', maxDifference);
    console.log('Verified fresh release, revision and FMU', version, revision, report.runtime.fmuSha256);
  } else requireThat(['--write','--check'].includes(mode), 'Unknown Shippingport comparison mode.');
  const observationBytes = await readFile(resolve(folder,'shippingport/observations.json'));
  const result = makeReport(native, JSON.parse(observationBytes), digest(observationBytes), digest(projectionBytes));
  const resultFile = resolve(folder, 'result.json');
  if (mode === '--write') await writeFile(resultFile, encode(result));
  else requireThat(encode(result) === await readFile(resultFile,'utf8'), 'Published Shippingport result differs from the scored evidence.');
  for (const c of result.channels) console.log(c.label, c.unit, JSON.stringify(c.scores), 'unpaired', c.unpairedCount, 'excluded', c.excludedCount);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
