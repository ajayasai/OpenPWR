// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareAcquiredPressure } from '../src/acquired-pressure.js';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const archive = await json('../validation/krsko_pressure/original-attempt-summary.json');
const protocol = await json('../validation/krsko_pressure/protocol-initial.json');
const times = protocol.reference.metricSampleTimesSeconds;

function retainedPressure() {
  const pressure = id => archive.cases.find(record => record.id === id).channels.find(c => c.key === 'primaryPressureMPa');
  const original = pressure('candidate'), equilibrium = pressure('equilibrium');
  return {
    ...original, unit: 'MPa',
    pressureDiagnostics: { sampleGridSeconds: times },
    points: original.points.map(p => ({ ...p, baseline: equilibrium.points.find(b => b.time === p.time).simulated })),
    metrics: { ...original.metrics, releasedBaselineRmse: equilibrium.metrics.rmse },
  };
}

test('reconstructs retained pressure scores at acquired times in chronological order', () => {
  const channel = retainedPressure();
  channel.points[0].measured = 900; // Excluded initialization reference must have no influence.
  channel.points.reverse();
  const { rows, baseline, candidate } = compareAcquiredPressure(channel, times);
  assert.deepEqual(rows.map(p => p.time), [1, 3, 5, 7, 9, 11, 13, 15]);
  assert.ok(Math.abs(baseline.rmse - 0.35737102588903974) < 1e-12);
  assert.ok(Math.abs(baseline.bias - (-0.30007027996764757)) < 1e-12);
  assert.ok(Math.abs(candidate.rmse - channel.metrics.rmse) < 1e-12);
  assert.ok(Math.abs(candidate.bias - channel.metrics.meanError) < 1e-12);
  assert.equal(rows[0].closer, 'Candidate');
  assert.equal(rows.at(-1).closer, 'Released');
  assert.equal(rows.at(-1).candidateError, rows.at(-1).simulated - rows.at(-1).measured);
});

test('the closer prediction uses signed readings at full precision and recognizes numeric ties', () => {
  const channel = retainedPressure();
  const compare = (baseline, simulated) => {
    const point = { time: 1, measured: 15, baseline, simulated };
    return compareAcquiredPressure({ ...channel, points: [point], pressureDiagnostics: { sampleGridSeconds: [1] },
      metrics: { samples: 1, releasedBaselineRmse: Math.abs(baseline - 15), rmse: Math.abs(simulated - 15), meanError: simulated - 15 } }, [1]).rows[0];
  };
  // Both display as 15.000000 MPa at six decimals but differ before rounding.
  assert.equal(compare(14.99999991, 15.00000020).closer, 'Released');
  assert.equal(compare(15.00000020, 14.99999991).closer, 'Candidate');
  assert.equal(compare(14.5, 15.5).closer, 'Tie');
});

test('missing, shifted, ambiguous or nonfinite points and inconsistent scores cannot be displayed as acquired', () => {
  for (const change of [
    c => c.points.splice(1, 1),
    c => { c.points[1].time += 1e-10; },
    c => c.points.push({ ...c.points[1] }),
    c => { c.points[1].baseline = null; },
    c => { c.points[1].simulated = Infinity; },
    c => { c.metrics.rmse += 0.001; },
    c => { c.metrics.releasedBaselineRmse += 0.001; },
    c => { c.metrics.meanError *= -1; },
    c => { c.metrics.samples++; },
    c => { c.pressureDiagnostics = { sampleGridSeconds: times.slice(1) }; },
  ]) {
    const channel = retainedPressure();
    change(channel);
    assert.throws(() => compareAcquiredPressure(channel, times), /pressure|sample count/);
  }
  const channel = retainedPressure();
  assert.throws(() => compareAcquiredPressure(channel, [0, ...times]), /time grid/);
});
