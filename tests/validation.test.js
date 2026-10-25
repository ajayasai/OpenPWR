// SPDX-License-Identifier: Apache-2.0
// Independent numerical/reference checks. These do not establish plant validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PWRPlant } from '../src/engine.js';
import { DELAYED_GROUPS, GENERATION_TIME, stepKinetics, saturationPressure, saturationTemperature, liquidEnthalpy, vaporEnthalpy } from '../src/physics.js';

const relativeError = (actual, expected) => Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
const multiply = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((sum, x, k) => sum + x * b[k][j], 0)));

// Independent reference: Taylor matrix exponential with scaling and squaring.
// Production uses implicit integration, not this algorithm. The PKE system is
// written in the engine's normalized precursor coordinates z_i=lambda_i*Lambda*C_i/beta_i.
function constantReactivityReference(rhoPcm, time) {
  const n = DELAYED_GROUPS.length + 1;
  const a = Array.from({ length: n }, () => Array(n).fill(0));
  const beta = DELAYED_GROUPS.reduce((sum, group) => sum + group.beta, 0);
  a[0][0] = (rhoPcm * 1e-5 - beta) / GENERATION_TIME;
  DELAYED_GROUPS.forEach((group, i) => {
    a[0][i + 1] = group.beta / GENERATION_TIME;
    a[i + 1][0] = group.lambda;
    a[i + 1][i + 1] = -group.lambda;
  });
  const norm = Math.max(...a.map(row => row.reduce((sum, x) => sum + Math.abs(x), 0))) * time;
  const scale = Math.max(0, Math.ceil(Math.log2(Math.max(norm / 0.25, 1))));
  const b = a.map(row => row.map(x => x * time / 2 ** scale));
  let exp = identity(n);
  let term = identity(n);
  for (let k = 1; k <= 28; k++) {
    term = multiply(term, b).map(row => row.map(x => x / k));
    exp = exp.map((row, i) => row.map((x, j) => x + term[i][j]));
  }
  for (let k = 0; k < scale; k++) exp = multiply(exp, exp);
  // Initial state is [1,1,...,1], the zero-reactivity equilibrium.
  return exp.map(row => row.reduce((sum, x) => sum + x, 0));
}

function advance(plant, duration, dt = 0.05) {
  const count = Math.round(duration / dt);
  for (let i = 0; i < count; i++) plant.step(dt);
  return plant.snapshot();
}

test('IAPWS saturation pressure agrees with external NIST table anchors', () => {
  // NISTIR5078 Table 1, temperatures in C, pressure in MPa.
  // https://www.nist.gov/document/nistir5078-tab1pdf
  const anchors = [[100, 0.10142], [200, 1.5549], [280, 6.4166], [300, 8.5879]];
  for (const [temperature, pressure] of anchors) {
    assert.ok(relativeError(saturationPressure(temperature), pressure) < 0.0005,
      `saturation pressure at ${temperature} C must agree within 0.05%`);
    assert.ok(Math.abs(saturationTemperature(pressure) - temperature) < 0.03,
      `inverse saturation at ${pressure} MPa must agree within 0.03 C`);
  }
});

test('production IF97 enthalpies agree with NIST at 200 and 300 C', () => {
  // These externally tabulated points supplement the broader published
  // benchmark suite. Production now uses interpolated IF97 enthalpy values.
  const anchors = [[200, 0.85227, 2.7920], [300, 1.3450, 2.7496]];
  for (const [temperature, hLiquid, hVapor] of anchors) {
    assert.ok(relativeError(liquidEnthalpy(temperature), hLiquid) < 0.0005);
    assert.ok(relativeError(vaporEnthalpy(temperature), hVapor) < 0.0005);
    assert.ok(relativeError(vaporEnthalpy(temperature) - liquidEnthalpy(temperature), hVapor - hLiquid) < 0.0005);
  }
});

test('six-group kinetics agrees with independent constant-reactivity matrix exponential', () => {
  for (const reactivity of [-500, -50, 0, 50, 150]) {
    let state = { n: 1, precursors: DELAYED_GROUPS.map(() => 1) };
    const dt = 0.001;
    for (let i = 0; i < 5000; i++) state = stepKinetics(state.n, state.precursors, reactivity, dt);
    const reference = constantReactivityReference(reactivity, 5);
    assert.ok(relativeError(state.n, reference[0]) < 0.0015,
      `neutron power at ${reactivity} pcm differs from independent reference`);
    state.precursors.forEach((value, index) => {
      assert.ok(relativeError(value, reference[index + 1]) < 0.0015,
        `precursor ${index + 1} at ${reactivity} pcm differs from reference`);
    });
  }
});

test('constant-reactivity error reduces when the kinetics time step is halved', () => {
  const reference = constantReactivityReference(100, 10)[0];
  const errorAt = dt => {
    let state = { n: 1, precursors: DELAYED_GROUPS.map(() => 1) };
    for (let i = 0; i < Math.round(10 / dt); i++) state = stepKinetics(state.n, state.precursors, 100, dt);
    return Math.abs(state.n - reference);
  };
  const coarse = errorAt(0.04);
  const fine = errorAt(0.02);
  assert.ok(fine < 0.7 * coarse, `refinement should reduce error: ${coarse} -> ${fine}`);
});

test('nominal and half-power initial states remain at equilibrium for five minutes', () => {
  for (const initialPower of [1, 0.5]) {
    const plant = new PWRPlant({ initialPower });
    const start = plant.snapshot();
    const end = advance(plant, 300);
    assert.equal(end.tripped, false);
    assert.ok(relativeError(end.thermalPower, start.thermalPower) < 0.01);
    assert.ok(relativeError(end.electricPower, start.electricPower) < 0.01);
    assert.ok(Math.abs(end.hotLegTemp - start.hotLegTemp) < 0.5);
    assert.ok(Math.abs(end.steamLevel - start.steamLevel) < 1);
  }
});

test('a demand change acts through dynamics instead of overwriting measured output', () => {
  const plant = new PWRPlant();
  const before = plant.snapshot();
  plant.setControl('demand', 0.7);
  assert.equal(plant.snapshot().electricPower, before.electricPower);
  const after = advance(plant, 600);
  assert.equal(after.tripped, false);
  assert.ok(after.electricPower < before.electricPower - 150, 'output must respond materially');
  assert.ok(Math.abs(after.electricPower - 700) < 2, 'output should settle within 2 MWe of requested net load');
  assert.ok(after.neutronPower < before.neutronPower, 'reactor must follow reduced heat removal');
});

test('coupled load-transient results are consistent under time-step refinement', () => {
  const run = dt => {
    const plant = new PWRPlant();
    plant.setControl('demand', 0.8);
    return advance(plant, 120, dt);
  };
  const coarse = run(0.05);
  const fine = run(0.025);
  assert.equal(coarse.tripped, false);
  assert.equal(fine.tripped, false);
  for (const key of ['thermalPower', 'electricPower', 'fuelTemp', 'steamPressure', 'steamLevel']) {
    assert.ok(relativeError(coarse[key], fine[key]) < 0.01, `${key} changes by more than 1% on refinement`);
  }
});

test('thermal-accounting residual stays small during a load transient', () => {
  const plant = new PWRPlant();
  plant.setControl('demand', 0.8);
  for (let i = 0; i < 2400; i++) {
    plant.step(0.05);
    const { energyResidual } = plant.snapshot();
    assert.ok(Number.isFinite(energyResidual));
    assert.ok(Math.abs(energyResidual) < 0.001, `thermal-accounting residual is ${energyResidual} MW`);
  }
});

test('manual reactor trip retains thermal inertia and nonzero decay heat', () => {
  const plant = new PWRPlant();
  const before = plant.snapshot();
  plant.scram('Validation manual trip');
  const instant = plant.snapshot();
  assert.equal(instant.tripped, true);
  assert.equal(instant.fuelTemp, before.fuelTemp, 'trip cannot instantly erase stored heat');
  const after = advance(plant, 30);
  assert.ok(after.neutronPower < 0.1);
  assert.ok(after.decayPower > 0, 'shutdown must not erase fission-product inventory');
  assert.ok(after.thermalPower > after.neutronPower * 2800, 'decay heat contributes to thermal power');
});

test('a cleared fault does not silently clear a latched reactor trip', () => {
  const plant = new PWRPlant();
  plant.setFault('primaryPumpTrip', true);
  const failure = advance(plant, 30);
  assert.equal(failure.tripped, true);
  assert.equal(plant.resetTrip(), false, 'an active initiating fault must inhibit trip reset');
  plant.setFault('primaryPumpTrip', false);
  assert.equal(plant.snapshot().faults.primaryPumpTrip, false);
  assert.equal(plant.snapshot().tripped, true);
});

test('saved-state continuation is deterministic across a JSON round trip', () => {
  const first = new PWRPlant();
  first.setControl('demand', 0.8);
  advance(first, 23);
  const second = new PWRPlant();
  second.importState(JSON.parse(JSON.stringify(first.exportState())));
  const a = advance(first, 17);
  const b = advance(second, 17);
  for (const key of ['neutronPower', 'fuelTemp', 'electricPower', 'steamPressure', 'xenon', 'time']) {
    assert.equal(a[key], b[key], `${key} must replay deterministically`);
  }
});

test('invalid inputs cannot mutate an existing valid simulation', () => {
  const plant = new PWRPlant();
  const saved = JSON.stringify(plant.exportState());
  for (const invalid of [null, {}, [], { version: 'unknown' }]) {
    assert.throws(() => plant.importState(invalid));
    assert.equal(JSON.stringify(plant.exportState()), saved);
  }
  assert.throws(() => plant.setControl('demand', Number.NaN));
  assert.throws(() => plant.setControl('notAControl', 0.5));
  assert.throws(() => plant.setFault('notAFault', true));
  assert.throws(() => plant.step(Number.NaN));
  assert.throws(() => plant.step(-1));
  assert.equal(JSON.stringify(plant.exportState()), saved);
});

test('finite but physically impossible saved inventories are rejected atomically', () => {
  const plant = new PWRPlant();
  const before = JSON.stringify(plant.exportState());
  for (const key of ['precursors', 'decay']) {
    const invalid = plant.exportState();
    invalid.state[key][0] = 1e300;
    assert.throws(() => plant.importState(invalid), `${key} must have physical bounds, not only finiteness`);
    assert.equal(JSON.stringify(plant.exportState()), before);
  }
  for (const key of ['xenon', 'iodine']) {
    const invalid = plant.exportState();
    invalid.state[key] = 1e300;
    assert.throws(() => plant.importState(invalid), `${key} must have physical bounds`);
    assert.equal(JSON.stringify(plant.exportState()), before);
  }
});

test('saved-state schema, typed fields and primary phase envelope are enforced', () => {
  const plant = new PWRPlant();
  const before = JSON.stringify(plant.exportState());
  const mutations = [
    ['unknown top-level field', state => { state.extra = true; }],
    ['unknown control', state => { state.controls.extra = 1; }],
    ['unknown state field', state => { state.state.extra = 1; }],
    ['invalid boolean control', state => { state.controls.autoReactor = 'true'; }],
    ['invalid fault type', state => { state.faults.feedwaterTrip = 1; }],
    ['oversized finite precursor array', state => { state.state.precursors.push(1); }],
    ['oversized trip reason', state => { state.state.tripReason = 'x'.repeat(301); }],
    ['invalid trip reason type', state => { state.state.tripReason = {}; }],
    ['invalid event severity', state => { state.events[0].level = 'success'; }],
    ['future event', state => { state.events[0].time = 100; }],
    ['unmodeled primary boiling', state => { state.state.primaryPressure = 0.1; }],
  ];
  for (const [label, mutate] of mutations) {
    const invalid = plant.exportState();
    mutate(invalid);
    assert.throws(() => plant.importState(invalid), label);
    assert.equal(JSON.stringify(plant.exportState()), before, `failed ${label} import must be atomic`);
  }
});
