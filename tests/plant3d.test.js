// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PWRPlant } from '../src/engine.js';
import { plant3DState, advanceVisualPhase, visualMotionAllowed } from '../src/plant3d-state.js';

const native = () => ({ backend: 'fmi2', model: 'OpenPWR.PrimaryLoop', time: 12, halted: false,
  controls: { reactorPowerMW: 3000, steamTemperatureC: 275, heaterPowerMW: 0, sprayFlowKgS: 0 },
  outputs: { valid: true, hotLegTemperatureC: 325, coldLegTemperatureC: 290, fuelTemperatureC: 600,
    primaryPressureMPa: 15.5, primaryFlowKgS: 15584.415584415585, pumpSpeed: 1,
    heatToSteamMW: 3000, pressurizerLevelPercent: 47, pressurizerMassKg: 22000, energyResidualMW: 0 } });

test('3D browser adapter preserves measured values and does not invent pressurizer inventory', () => {
  const plant = new PWRPlant(); const before = plant.exportState();
  const snapshot = plant.snapshot(); const view = plant3DState(snapshot);
  assert.equal(view.available, true);
  assert.equal(view.values.thermalPower, snapshot.thermalPower);
  assert.equal(view.values.steamLevel, snapshot.steamLevel);
  assert.equal(view.levels.pressurizer, null);
  assert.equal(view.values.heaterPower, null);
  assert.equal(view.activity.pump, 1);
  assert.equal(view.activity.turbine, 1);
  assert.deepEqual(plant.exportState(), before);
});

test('3D native adapter has no invented secondary-cycle or electrical observations', () => {
  const snapshot = native(); const before = structuredClone(snapshot);
  const view = plant3DState(snapshot, 'native');
  assert.equal(view.available, true);
  assert.equal(view.levels.pressurizer, .47);
  assert.equal(view.levels.steam, null);
  for (const key of ['steam', 'steamHeader', 'feed', 'turbine', 'generator', 'cooling', 'electricity']) assert.equal(view.activity[key], 0, key);
  assert.equal(view.values.electricPower, null);
  assert.equal(view.values.steamTemperature, 275);
  assert.deepEqual(snapshot, before);
});

test('cold shutdown, rotor coastdown and natural circulation stay distinct', () => {
  const cold = plant3DState(new PWRPlant({ mode: 'cold' }).snapshot());
  assert.equal(cold.activity.pump, 0); assert.equal(cold.activity.turbine, 0);
  assert.ok(cold.activity.primary > 0); assert.equal(cold.activity.steam, 0);
  const plant = new PWRPlant(); plant.setFault('primaryPumpTrip', true);
  const tripped = plant3DState(plant.snapshot());
  assert.equal(tripped.activity.pump, 1, 'coastdown is read from actual rotor state');
  assert.equal(tripped.activity.electricity, 0, 'generator breaker gates export');
  const later = plant3DState(plant.step(3));
  assert.ok(later.activity.pump > 0 && later.activity.pump < 1);
});

test('missing, wrong-engine and nonfinite observations never activate equipment', () => {
  for (const input of [undefined, {}, { ...native(), backend: 'fake' }, { ...native(), time: -1 }, { ...native(), outputs: { ...native().outputs, primaryPressureMPa: NaN } }]) {
    const state = plant3DState(input, 'native');
    assert.equal(state.available, false);
    assert.ok(Object.values(state.activity).every(value => value === 0));
  }
  assert.equal(plant3DState({}).values.thermalPower, null);
  assert.throws(() => plant3DState({}, 'unknown'), TypeError);
});

test('halt, pause, hidden tab and reduced motion freeze animation independently of observations', () => {
  const state = plant3DState(native(), 'native');
  assert.equal(visualMotionAllowed(state), true);
  for (const flags of [{ paused: true }, { hidden: true }, { animate: false }, { reducedMotion: true }]) assert.equal(visualMotionAllowed(state, flags), false);
  assert.equal(visualMotionAllowed({ ...state, halted: true }), false);
  assert.equal(visualMotionAllowed({ ...state, available: false }), false);
  assert.ok(Math.abs(advanceVisualPhase(.4, 1, 0) - .4) < 1e-12);
  assert.ok(Math.abs(advanceVisualPhase(.4, 1, 10) - .5) < 1e-12);
  assert.ok(Math.abs(advanceVisualPhase(.05, -1, .1) - .95) < 1e-12);
});

test('visual normalization bounds geometry without clamping the displayed engineering readings', () => {
  const snapshot = native(); snapshot.outputs.pressurizerLevelPercent = 120;
  snapshot.outputs.pumpSpeed = 3; snapshot.controls.reactorPowerMW = 10000;
  const state = plant3DState(snapshot, 'native');
  assert.equal(state.values.pressurizerLevel, 120);
  assert.equal(state.levels.pressurizer, 1);
  assert.equal(state.activity.pump, 2);
  assert.equal(state.activity.heat, 1);
});
