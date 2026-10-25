// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmarks, KINETICS_REFERENCES, evaluateKineticsReference } from '../src/benchmarks.js';
import { if97Region1, if97Region2, if97SaturationPressure } from '../src/water-properties.js';
import { liquidEnthalpy, vaporEnthalpy, steamStoredEnergy, steamTemperatureFromEnergy,
  stepKinetics, DELAYED_GROUPS, GENERATION_TIME } from '../src/physics.js';

test('production kernels meet independently published CATS, IAPWS and NIST reference tolerances', () => {
  const report = runBenchmarks();
  assert.ok(report.checks.length >= 70);
  assert.equal(report.summary.failed, 0, JSON.stringify(report.checks.filter(x => !x.pass), null, 2));
  assert.equal(new Set(report.checks.map(x => x.id)).size, report.checks.length);
  for (const row of report.checks) {
    assert.ok(row.source.url.startsWith('https://'));
    assert.ok(row.source.table && row.conditions && row.units);
    assert.equal(row.error, Math.abs(row.reference - row.measured));
    assert.equal(row.pass, Number.isFinite(row.measured) && row.error <= row.tolerance);
  }
});

test('published negative-step and zigzag cases converge under time-step refinement', () => {
  for (const full of [KINETICS_REFERENCES[1], KINETICS_REFERENCES[2]]) {
    const ref = {...full, samples:full.samples.slice(0, 3)};
    const coarse = evaluateKineticsReference(ref, .002);
    const fine = evaluateKineticsReference(ref, .001);
    const maxError = rows => Math.max(...rows.map(x => Math.abs(x.measured - x.reference) / x.reference));
    assert.ok(maxError(fine) < .6 * maxError(coarse), `${ref.id}: refinement must reduce error`);
  }
});

test('production enthalpy cache has small off-grid interpolation error throughout the cold-to-hot range', () => {
  // This is numerical interpolation verification against the direct equation,
  // not independent physical validation. Published anchors are tested above.
  for (let i = 0; i < 1320; i++) {
    const tempC = 20 + (i + .5) * .25;
    const temperatureK = tempC + 273.15;
    const pressureMPa = if97SaturationPressure(temperatureK);
    assert.ok(Math.abs(liquidEnthalpy(tempC) * 1000 - if97Region1(temperatureK, pressureMPa).h) < .01);
    assert.ok(Math.abs(vaporEnthalpy(tempC) * 1000 - if97Region2(temperatureK, pressureMPa).h) < .01);
  }
});

test('refining saturated-enthalpy interpolation from 1 C to production 0.25 C reduces maximum error', () => {
  for (const [equation, production] of [[if97Region1, liquidEnthalpy], [if97Region2, vaporEnthalpy]]) {
    const direct = t => equation(t + 273.15, if97SaturationPressure(t + 273.15)).h;
    let coarse = 0, fine = 0;
    for (let t = 20.125; t < 350; t += .25) {
      const low = Math.floor(t);
      const reference = direct(t);
      const interpolated = direct(low) + (t - low) * (direct(low + 1) - direct(low));
      coarse = Math.max(coarse, Math.abs(interpolated - reference));
      fine = Math.max(fine, Math.abs(production(t) * 1000 - reference));
    }
    assert.ok(fine < coarse / 8, `maximum interpolation error ${coarse} -> ${fine}`);
  }
});

test('steam storage inverse conserves energy off-grid and at cold/hot boundaries', () => {
  for (const mass of [9000, 150000, 291000]) {
    for (const metalCapacity of [1, 400, 2000]) {
      for (const tempC of [20, 20.000001, 24.999, 25, 99.999, 100, 212.34567, 349.999999, 350]) {
        const energy = steamStoredEnergy(tempC, mass, metalCapacity);
        const recovered = steamTemperatureFromEnergy(energy, mass, metalCapacity);
        assert.ok(Math.abs(recovered - tempC) < 1e-10);
        assert.ok(Math.abs(steamStoredEnergy(recovered, mass, metalCapacity) - energy) < 1e-7);
      }
      assert.throws(() => steamTemperatureFromEnergy(steamStoredEnergy(350, mass, metalCapacity) + 1, mass, metalCapacity), RangeError);
    }
  }
});

test('IF97 functions reject unsupported phase regions and nonfinite inputs', () => {
  for (const args of [[300,.001], [624,20], [300,101], [NaN,3], [300,NaN]]) {
    assert.throws(() => if97Region1(...args), RangeError);
  }
  for (const args of [[300,.1], [700,100], [1100,.1], [300,0], [NaN,.1], [300,NaN]]) {
    assert.throws(() => if97Region2(...args), RangeError);
  }
  for (const t of [NaN,Infinity,-1,350.000001]) {
    assert.throws(() => liquidEnthalpy(t), RangeError);
    assert.throws(() => vaporEnthalpy(t), RangeError);
  }
});

test('source-driven subcritical equilibrium follows the analytic kinetics balance', () => {
  const source = 1e-6;
  const rhoPcm = -500;
  const equilibrium = -source * GENERATION_TIME / (rhoPcm * 1e-5);
  const initial = DELAYED_GROUPS.map(() => equilibrium);
  for (const dt of [.0001,.05,1,100]) {
    const next = stepKinetics(equilibrium, initial, rhoPcm, dt, {source});
    assert.ok(Math.abs(next.n / equilibrium - 1) < 1e-13);
    assert.ok(next.precursors.every(z => Math.abs(z / equilibrium - 1) < 1e-13));
  }
  const fromZero = stepKinetics(0, DELAYED_GROUPS.map(() => 0), rhoPcm, .05, {source});
  assert.ok(fromZero.n > 0 && fromZero.n < equilibrium);
  assert.ok(fromZero.precursors.every(z => z > 0 && z < fromZero.n));
});

test('configurable kinetics rejects malformed data and does not mutate supplied arrays', () => {
  const z = DELAYED_GROUPS.map(() => 1);
  const before = structuredClone(z);
  stepKinetics(1, z, 0, .01);
  assert.deepEqual(z, before);
  for (const options of [{source:-1}, {source:NaN}, {generationTime:0},
    {generationTime:Infinity}, {groups:[]}, {groups:new Array(6)},
    {groups:DELAYED_GROUPS.map((g,i) => i ? g : {...g,lambda:0})}]) {
    assert.throws(() => stepKinetics(1,z,0,.01,options), RangeError);
  }
  assert.throws(() => stepKinetics(1,new Array(6),0,.01), RangeError);
});
