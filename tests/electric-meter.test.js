// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {averageMeterIntervals, parseNativePowerCsv, readNativePowerFile} from '../src/electric-meter.js';

const point = (time, net, gross) => ({elapsedSeconds: time, netPowerMW: net, grossPowerMW: gross});

test('meter accounts for signed linear power and splits segments at complete window boundaries', () => {
  const points = [0, 830, 2050, 3600].map(t => point(t, -90 + t / 10, 2*t / 10));
  assert.deepEqual(averageMeterIntervals(points, 1800), [
    {startSeconds: 0, endSeconds: 1800, energyMWh: 0, averageNetMW: 0, grossEnergyMWh: 90, averageGrossMW: 180},
    {startSeconds: 1800, endSeconds: 3600, energyMWh: 90, averageNetMW: 180, grossEnergyMWh: 270, averageGrossMW: 540}
  ]);
});

test('partial first and last windows are excluded and missing coverage is rejected', () => {
  const points = [300, 1801, 3000, 3700].map(t => point(t, -6, 0));
  assert.deepEqual(averageMeterIntervals(points, 1800), [
    {startSeconds: 1800, endSeconds: 3600, energyMWh: -3, averageNetMW: -6, grossEnergyMWh: 0, averageGrossMW: 0}
  ]);
  assert.deepEqual(averageMeterIntervals(points.slice(1, 3), 1800), []);
  assert.throws(() => averageMeterIntervals([point(0, 2, 3), point(1900, 3, 4)], 1800), /far apart/);
});

test('reads native exports including event rows, a truncated history and signed station consumption', async () => {
  const csv = '\uFEFFtime,valid,grossPowerMW,netPowerMW,halted\r\n125.25,True,0,-6,False\r\n126,True,0,-6,False\r\n127,True,8,2,False\r\n';
  assert.deepEqual(await readNativePowerFile(new Blob([csv])), [point(125.25,-6,0), point(126,-6,0), point(127,2,8)]);
  assert.deepEqual(parseNativePowerCsv(csv), await readNativePowerFile(new Blob([csv])));
});

test('malformed exports cannot silently change the metering period or fabricate zero readings', () => {
  const header = 'time,netPowerMW,grossPowerMW\n';
  for (const rows of ['0,0,0\n2,2,2', '0,0,0\n1,,4', '0,0,0\n1,0x10,4', '0,0,0\n0,4,4', '0,0,0\n1,2']) {
    assert.throws(() => parseNativePowerCsv(header + rows));
  }
});
