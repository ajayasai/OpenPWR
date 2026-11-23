// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {averageMeterIntervals} from '../src/electric-meter.js';

const data = new URL('../validation/', import.meta.url);
const read = name => readFileSync(new URL(name, data));
const observed = JSON.parse(read('grid_return/sizewell-b-2024.json'));
const simulated = JSON.parse(read('startup_output/model.json'));
const halfHourMs = 30 * 60 * 1000;

test('both generator-meter readings survive the conversion from settlement MWh to mean MW', () => {
  assert.equal(observed.schema, 'openpwr-grid-return-observation-v1');
  assert.equal(observed.intervalMinutes, 30);
  assert.equal(observed.sources.dataset, 'B1610');
  assert.deepEqual(observed.sources.meterResponses.map(source => source.bmUnit), ['T_SIZB-1', 'T_SIZB-2']);
  assert.equal(observed.attribution, 'Contains BMRS data © Elexon Limited copyright and database right 2024.');
  assert.match(observed.licenceUrl, /^https:\/\/www\.elexon\.co\.uk\//);
  const meterData = observed.sources.meterResponses.map(source => {
    const bytes = read('grid_return/' + source.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    const rows = JSON.parse(bytes);
    assert.equal(rows.length, 336);
    // Key by settlement date and period. Upstream JSON need not be sorted.
    const bySlot = new Map(rows.map(row => {
      assert.equal(row.bmUnit, source.bmUnit);
      assert.equal(row.settlementRunType, 'RF');
      assert.ok(Number.isFinite(row.quantity));
      return [row.settlementDate + '/' + row.settlementPeriod, row.quantity];
    }));
    assert.equal(bySlot.size, 336);
    return bySlot;
  });
  assert.equal(observed.points.length, 336);
  for (const [index, point] of observed.points.entries()) {
    const start = Date.UTC(2024, 10, 30) + index * halfHourMs;
    assert.equal(Date.parse(point.startUtc), start);
    assert.equal(Date.parse(point.endUtc), start + halfHourMs);
    const slot = point.startUtc.slice(0, 10) + '/' + (1 + index % 48);
    const [first, second] = meterData.map(meter => meter.get(slot));
    assert.equal(point.unit1MWh, first);
    assert.equal(point.unit2MWh, second);
    assert.equal(point.unit1MW, 2 * first);
    assert.equal(point.unit2MW, 2 * second);
    assert.ok(Math.abs(point.combinedMW - 2 * (first + second)) < 1e-9);
  }
  assert.equal(observed.points[0].combinedMW, -13.4);
  assert.equal(observed.points.at(-1).combinedMW, 1161.34);
});

test('native gross and net output come from the same released trace on its elapsed clock', () => {
  const replay = JSON.parse(read('startup_output/replay.json'));
  assert.equal(simulated.schema, 'openpwr-startup-electrical-output-v1');
  assert.deepEqual(simulated.source, replay.source);
  assert.equal(simulated.source.release, 'v0.11.0');
  assert.equal(simulated.source.scenarioId, 'full-startup');
  assert.equal(simulated.source.reportSha256, '9952b17ef7718a4fcff5c219d4cee87921ebc9897e596e4767b429fd091589a2');
  assert.equal(simulated.source.fmuSha256, '61c5c2c14dc546d3a808e445ebd01affcb7b2f6c4d26d91e487f788b16733a7c');
  const time = replay.columns.indexOf('time');
  const net = replay.columns.indexOf('netPowerMW');
  const gross = replay.columns.indexOf('grossPowerMW');
  assert.ok([time, net, gross].every(index => index >= 0));
  assert.equal(simulated.sampleIntervalSeconds, 30);
  assert.equal(simulated.durationSeconds, 27000);
  assert.equal(simulated.points.length, 901);
  assert.equal(simulated.points.length, replay.rows.length);
  for (const [index, point] of simulated.points.entries()) {
    assert.equal(point.elapsedSeconds, index * 30);
    assert.equal(point.elapsedSeconds, replay.rows[index][time]);
    assert.equal(point.netPowerMW, replay.rows[index][net]);
    assert.equal(point.grossPowerMW, replay.rows[index][gross]);
    assert.ok([point.netPowerMW, point.grossPowerMW].every(Number.isFinite));
    assert.ok(point.netPowerMW <= point.grossPowerMW);
  }
  assert.equal(simulated.points[0].grossPowerMW, 0);
  assert.equal(simulated.points[0].netPowerMW, -5);
});

test('observed UTC and simulated elapsed threshold intervals retain distinct time bases', () => {
  const modelBins = averageMeterIntervals(simulated.points, 1800);
  assert.equal(modelBins.length, 15);
  const observedCrossings = [100, 900].map(value => observed.points.find(point => point.combinedMW >= value));
  assert.deepEqual(observedCrossings.map(point => [point.startUtc, point.endUtc, point.combinedMW]), [
    ['2024-12-01T09:00:00Z', '2024-12-01T09:30:00Z', 111.32],
    ['2024-12-05T23:30:00Z', '2024-12-06T00:00:00Z', 912.9],
  ]);
  // These are means over complete intervals, independently calculated from
  // the archived 30-second samples with the trapezoid rule.
  for (const [key, means] of [
    ['averageGrossMW', [658.9032366662243, 1050.0048333059938]],
    ['averageNetMW', [608.6407587160448, 999.9999201283550]],
  ]) {
    const crossings = [100, 900].map(value => modelBins.find(bin => bin[key] >= value));
    assert.deepEqual(crossings.map(bin => [bin.startSeconds, bin.endSeconds]), [[23400, 25200], [25200, 27000]]);
    crossings.forEach((bin, index) => assert.ok(Math.abs(bin[key] - means[index]) < 1e-8));
  }
});
