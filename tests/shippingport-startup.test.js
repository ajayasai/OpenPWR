// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { interpolate, scorePoints } from '../scripts/shippingport-startup.mjs';

test('the Shippingport assessment preserves the event coverage and qualified outcome', async () => {
  const file = new URL('../validation/startup_holdout/result.json', import.meta.url);
  const report = JSON.parse(await readFile(file, 'utf8'));
  const coverage = Object.fromEntries(report.channels.map(channel =>
    [channel.key, [channel.scores.n, channel.unpairedCount, channel.excludedCount]]));
  assert.deepEqual(coverage, {
    primaryPressure: [25, 28, 1],
    averageCoolantTemperature: [3, 13, 0],
    coldLegTemperature: [0, 9, 0],
    pressurizerTemperature: [2, 15, 0],
  });
  assert.equal(report.unreadable.length, 12);
  assert.equal(report.milestone.observedSeconds, 28 * 3600 + 59 * 60);
  assert.equal(report.milestone.breakerObserved, false);
  assert.equal(report.milestone.errorSeconds, null);
  assert.equal(report.physicalValidationPassed, false);
});

test('continuous model readings interpolate only within retained time support', () => {
  const trace = [{ elapsedS: 0, value: 20 }, { elapsedS: 30, value: 25 }, { elapsedS: 60, value: 30 }];
  assert.equal(interpolate(trace, -1), null);
  assert.equal(interpolate(trace, 0), 20);
  assert.equal(interpolate(trace, 45), 27.5);
  assert.equal(interpolate(trace, 60), 30);
  assert.equal(interpolate(trace, 61), null);
});

test('matched errors keep their sign and count each eligible measurement once', () => {
  const points = [
    { elapsedS: 300, error: -2, excluded: null },
    { elapsedS: 420, error: 3, excluded: null },
    { elapsedS: 900, error: 77, excluded: 'source flags instrument' },
    { elapsedS: 40000, error: null, excluded: null },
  ];
  assert.deepEqual(scorePoints(points), { n: 2, bias: 0.5, mae: 2.5, rmse: Math.sqrt(6.5), maxAbs: 3,
    firstElapsedS: 300, lastElapsedS: 420 });
  assert.deepEqual(scorePoints(points.slice(2)), { n: 0, bias: null, mae: null, rmse: null, maxAbs: null,
    firstElapsedS: null, lastElapsedS: null });
});
