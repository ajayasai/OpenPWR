// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeEvidenceView } from '../scripts/evidence-view.mjs';

test('the measured view keeps acquired samples, uncertainty and signed errors in both nested comparisons', () => {
  const points = [{ time: 0, measured: null, simulated: 15.123456789012345, baseline: 15, refined: 17 },
    { time: 1.5, measured: 15.4, simulated: 15.35, noWall: 15.34, originalNoSpray: 15.39, lowerAllowance: 15.1, upperAllowance: 15.7 }];
  const channel = { key: 'primaryPressureMPa', name: 'Pressure', unit: 'MPa', points, metrics: { meanError: -0.05 },
    pressureDiagnostics: { sampleGridSeconds: [1.5], extra: [1, 2] } };
  const run = { channels: [channel], assumptions: ['Digitized points'], numericalChecks: [{ name: 'Refinement', pass: true }],
    protocol: { reference: { metricSampleTimesSeconds: [1.5] } }, trace: ['solver history'] };
  const raw = Buffer.from(JSON.stringify({ ...run, conditionalSpray: run, holdoutComparison: run }, null, 2));
  const projected = JSON.parse(makeEvidenceView('krsko-pressure-development.json', raw));
  assert.deepEqual(projected.source, { file: 'krsko-pressure-development.json', bytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex') });
  assert.equal(projected.schema, 'openpwr-evidence-view-v1');
  for (const result of [projected.report, projected.report.conditionalSpray, projected.report.holdoutComparison]) {
    assert.deepEqual(result.channels[0], { ...channel, points: points.map(({ refined, ...displayed }) => displayed),
      pressureDiagnostics: { sampleGridSeconds: [1.5] } });
    assert.deepEqual(result.protocol, run.protocol);
    assert.deepEqual(result.assumptions, run.assumptions);
    assert.deepEqual(result.numericalChecks, run.numericalChecks);
    assert.ok(!Object.hasOwn(result, 'trace'));
  }
});
