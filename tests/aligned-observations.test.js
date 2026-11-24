// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { alignedObservations, observationsCsv } from '../src/aligned-observations.js';

const archived = async file => JSON.parse(await readFile(new URL('../validation/baselines/' + file, import.meta.url)));
const hot = await archived('krsko-v0.7.json');
const startup = await archived('continuous-measured-v0.10.json');
const pactel = await archived('pressurizer-v0.7.json');

test('all four plant-response channels reconcile on their acquired scoring grid', () => {
  for (const report of [hot, startup]) {
    assert.equal(report.channels.length, 4);
    for (const c of report.channels) {
      const view = alignedObservations(report, c);
      assert.equal(view.graphical, false);
      assert.deepEqual(view.rows.map(r => r.time), [1, 3, 5, 7, 9, 11, 13, 15]);
      assert.equal(view.unit, c.unit);
      const lines = observationsCsv(view).trimEnd().split('\n');
      const header = lines[0].split(',');
      assert.equal(lines.length, 9);
      assert.equal(header.includes('conditional_lower'), false);
      for (const [i, line] of lines.slice(1).entries()) {
        const row = Object.fromEntries(line.split(',').map((value, j) => [header[j], value]));
        assert.equal(row.time_basis, 'acquired sample');
        assert.equal(row.git_revision, report.gitRevision);
        assert.equal(row.data_sha256, report.inputDataSha256);
        const point = c.points[i + 1];
        assert.equal(Number(row.measured), point.measured);
        assert.equal(Number(row.simulated_minus_measured), point.simulated - point.measured);
        if (report === hot) assert.equal(Number(row.baseline_minus_measured), point.baseline - point.measured);
        else assert.equal(header.includes('baseline'), false);
      }
    }
  }
});

test('the graphical PACTEL grids export all aligned positions and conditional bounds', () => {
  for (const [report, length] of [[pactel, 491], [pactel.holdoutComparison, 291]]) {
    const channel = report.channels[0];
    const view = alignedObservations(report, channel);
    assert.equal(view.graphical, true);
    const lines = observationsCsv(view).trimEnd().split('\n');
    assert.equal(lines.length, length + 1);
    const header = lines[0].split(',');
    for (const [i, source] of channel.points.entries()) {
      const fields = lines[i + 1].split(',');
      assert.equal(fields[header.indexOf('time_basis')], 'graphical position');
      assert.equal(Number(fields[header.indexOf('time_s')]), 5 + i);
      assert.equal(Number(fields[header.indexOf('conditional_lower')]), source.lowerAllowance);
      assert.equal(Number(fields[header.indexOf('conditional_upper')]), source.upperAllowance);
      assert.equal(Number(fields[header.indexOf('simulated')]), source.simulated);
    }
  }
});

test('shifted samples, incomplete allowances or inconsistent scores cannot produce a scored export', () => {
  const hotChannel = structuredClone(hot.channels[0]);
  hotChannel.points[1].time += 0.1;
  assert.throws(() => alignedObservations(hot, hotChannel), /missing measurement/i);
  const graphical = structuredClone(pactel.channels[0]);
  graphical.metrics.meanError += 0.01;
  assert.throws(() => alignedObservations(pactel, graphical), /error scores/);
  graphical.metrics.meanError -= 0.01;
  delete graphical.points[0].upperAllowance;
  assert.throws(() => alignedObservations(pactel, graphical), /conditional allowance/);
  graphical.points.pop();
  assert.throws(() => alignedObservations(pactel, graphical), /comparison window/);
});
