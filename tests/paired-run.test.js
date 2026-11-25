// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PWRPlant } from '../src/engine.js';
import {
  PAIRED_METRICS, PAIRED_MODEL_REVISION, pairedRunCsv, runPairedExperiment, validatePairedRecipe,
} from '../src/paired-run.js';

test('paired recipes pin the browser equations and the 0.05 s integration protocol', async () => {
  const hash = createHash('sha256');
  for (const name of ['engine.js', 'physics.js', 'water-properties.js']) {
    const source = await readFile(new URL('../src/' + name, import.meta.url), 'utf8');
    hash.update(name).update('\0').update(source.replaceAll('\r\n', '\n')).update('\0');
  }
  assert.equal(PAIRED_MODEL_REVISION, 'paired-0.05s-v1/' + hash.digest('hex'));
});

test('a released v0.14.0 recipe preserves its state, revision and original trajectories', async () => {
  const fixture = new URL('./fixtures/v0.14.0-paired-recipe.json', import.meta.url);
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  const replay = validatePairedRecipe(original);
  const result = await runPairedExperiment(replay.model, replay);
  assert.deepEqual(result.recipe, original);
  const expected = await readFile(new URL('./fixtures/v0.14.0-paired-output.csv', import.meta.url), 'utf8');
  const [header, ...rows] = pairedRunCsv(result).trimEnd().split('\n');
  const [expectedHeader, ...expectedRows] = expected.trimEnd().split(/\r?\n/);
  assert.equal(header, expectedHeader);
  assert.equal(rows.length, expectedRows.length);
  rows.forEach((row, i) => {
    const expectedFields = expectedRows[i].split(',');
    const fields = row.split(',');
    assert.equal(fields.length, expectedFields.length);
    assert.deepEqual(fields.slice(0, 6), expectedFields.slice(0, 6)); // times, demands and trip flags
    fields.slice(6).forEach((value, j) => {
      assert.ok(Math.abs(Number(value) - Number(expectedFields[6 + j])) < 1e-10,
        `Released CSV reading at row ${i + 1}, column ${j + 7}`);
    });
  });
  // A changed revision cannot silently choose a different enthalpy law.
  assert.throws(() => validatePairedRecipe({ ...original, modelRevision: PAIRED_MODEL_REVISION }), /revision/);
  assert.throws(() => validatePairedRecipe({ ...original, model: new PWRPlant().exportState() }), /revision/);
});

test('paired trajectories match direct control-room steps from a fractional, evolving checkpoint', async () => {
  const live = new PWRPlant();
  live.setControl('demand', 0.94);
  live.setControl('cooling', 0.88);
  live.setControl('autoTurbine', false);
  live.setControl('turbineValve', 0.91);
  live.step(5.15);
  const checkpoint = live.exportState();
  const progress = [];
  const result = await runPairedExperiment(checkpoint, { demand: 0.75, durationS: 30 }, {
    onProgress: fraction => progress.push(fraction),
  });
  assert.deepEqual(checkpoint, live.exportState());
  assert.equal(result.baselineDemand, 0.94);
  assert.equal(result.startTime, live.snapshot().time);
  assert.equal(result.complete, true);
  assert.equal(result.stopElapsedS, null);
  assert.equal(result.elapsedS, 30);
  assert.equal(result.rows.length, 31);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.deepEqual(result.rows[0].baseline, result.rows[0].alternative);
  const alternative = new PWRPlant();
  alternative.importState(checkpoint);
  alternative.setControl('demand', 0.75);
  for (let i = 0; i <= 30; i++) {
    const base = i ? live.step(1) : live.snapshot();
    const changed = i ? alternative.step(1) : alternative.snapshot();
    const row = result.rows[i];
    assert.equal(row.elapsedS, i);
    assert.equal(row.time, base.time);
    for (const metric of Object.keys(PAIRED_METRICS)) {
      assert.equal(row.baseline[metric], base[metric]);
      assert.equal(row.alternative[metric], changed[metric]);
      assert.equal(row.delta[metric], changed[metric] - base[metric]);
    }
  }
  assert.notEqual(result.rows.at(-1).delta.thermalPower, 0);
  const replay = validatePairedRecipe(JSON.parse(JSON.stringify(result.recipe)));
  const rerun = await runPairedExperiment(replay.model, replay);
  assert.deepEqual(rerun, result);
  assert.equal(pairedRunCsv(rerun), pairedRunCsv(result));
});

test('unchanged demand produces zero differences and CSV preserves readings with units and sign', async () => {
  const result = await runPairedExperiment(new PWRPlant().exportState(), { demand: 1, durationS: 2 });
  for (const row of result.rows) {
    assert.deepEqual(row.alternative, row.baseline);
    assert.ok(Object.values(row.delta).every(value => value === 0));
  }
  const csvRows = pairedRunCsv(result).trimEnd().split('\n').map(line => line.split(','));
  const [headers, ...rows] = csvRows;
  assert.equal(rows.length, result.rows.length);
  for (const row of rows) assert.equal(row.length, headers.length);
  for (const [metric, { unit }] of Object.entries(PAIRED_METRICS)) {
    for (const branch of ['baseline', 'alternative', 'delta']) {
      const column = headers.indexOf(`${branch}_${metric}_${unit}`);
      assert.equal(Number(rows[2][column]), result.rows[2][branch][metric]);
    }
  }
});

test('the first unilateral domain exit between samples ends both traces at their last valid common step', async () => {
  const checkpoint = new PWRPlant().exportState();
  // A synthetic, in-range inventory just below the generic upper model limit.
  checkpoint.state.steamMass = 290996;
  checkpoint.controls.autoFeedwater = false;
  const result = await runPairedExperiment(checkpoint, { demand: 0.75, durationS: 10 });
  assert.equal(result.complete, false);
  assert.match(result.stopReason, /^Alternative: Steam-generator inventory/);
  assert.equal(result.stopElapsedS, 0.30);
  assert.deepEqual(result.rows.map(row => row.elapsedS), [0, 0.25]);
  assert.equal(result.elapsedS, 0.25);
  for (const [branch, demand] of [['baseline', 1], ['alternative', 0.75]]) {
    const direct = new PWRPlant();
    direct.importState(checkpoint);
    direct.setControl('demand', demand);
    const valid = direct.step(0.25);
    assert.equal(valid.domainExceeded, false);
    for (const metric of Object.keys(PAIRED_METRICS)) assert.equal(result.rows[1][branch][metric], valid[metric]);
    assert.equal(direct.step(0.05).domainExceeded, branch === 'alternative');
  }
});

test('unsupported recipes, operating states and numeric options cannot run', async () => {
  const model = new PWRPlant().exportState();
  const opts = { demand: 0.85, durationS: 10 };
  const recipe = { format: 'openpwr-paired-run', version: 1, modelRevision: PAIRED_MODEL_REVISION, model, ...opts };
  for (const change of [{ demand: 1.01 }, { demand: 0.249 }, { demand: '0.85' }, { demand: NaN },
    { durationS: 0 }, { durationS: 1801 }, { durationS: 1.5 }, { durationS: Infinity }]) {
    assert.throws(() => validatePairedRecipe({ ...recipe, ...change }), RangeError);
    await assert.rejects(runPairedExperiment(model, { ...opts, ...change }), RangeError);
  }
  for (const change of [{ format: 'openpwr-session' }, { version: '1' }, { modelRevision: 'other' },
    { extra: 1 }, { model: {} }]) {
    assert.throws(() => validatePairedRecipe({ ...recipe, ...change }), TypeError);
  }
  const cold = new PWRPlant({ mode: 'cold' });
  const tripped = new PWRPlant();
  tripped.scram();
  const terminal = structuredClone(model);
  terminal.state.domainExceeded = true;
  for (const state of [cold.exportState(), tripped.exportState(), terminal]) {
    await assert.rejects(runPairedExperiment(state, opts), /grid-connected/);
    assert.throws(() => validatePairedRecipe({ ...recipe, model: state }), /grid-connected/);
  }
});

test('an in-progress cancel discards the partial run and leaves the starting model untouched', async () => {
  const plant = new PWRPlant();
  const checkpoint = plant.exportState();
  const controller = new AbortController();
  await assert.rejects(runPairedExperiment(checkpoint, { demand: 0.80, durationS: 1800 }, {
    signal: controller.signal,
    onProgress: fraction => { if (fraction > 0 && fraction < 1) controller.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(checkpoint, plant.exportState());
});
