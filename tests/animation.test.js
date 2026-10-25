// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PWRPlant, PARAMETERS } from '../src/engine.js';
import { diagramState, advancePhase } from '../src/animation-state.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `${actual} differs from ${expected}`);

test('cold shutdown shows natural circulation without turning stopped pumps or inventing steam', () => {
  const plant = new PWRPlant({ mode: 'cold' });
  const before = plant.exportState();
  const state = diagramState(plant.snapshot());
  near(state.rates.primary, 0.08);
  for (const key of ['steamHeader', 'steam', 'bypass', 'feed', 'cooling', 'grid']) {
    assert.equal(state.rates[key], 0, key);
  }
  for (const value of Object.values(state.rotors)) assert.equal(value, 0);
  assert.equal(state.steamActivity, 0);
  assert.deepEqual(plant.exportState(), before, 'presentation must not mutate physics');
});

test('nominal operation activates all running systems and leaves the bypass inactive', () => {
  const state = diagramState(new PWRPlant().snapshot());
  for (const key of ['primary', 'steamHeader', 'steam', 'feed', 'cooling', 'grid']) near(state.rates[key], 1);
  for (const value of Object.values(state.rotors)) near(value, 1);
  assert.equal(state.rates.bypass, 0);
  assert.equal(state.heat, 1);
  assert.equal(state.steamActivity, 1);
});

test('a pump trip preserves physical pump and turbine coastdown while cutting generator export', () => {
  const plant = new PWRPlant();
  plant.setFault('primaryPumpTrip', true);
  const immediate = diagramState(plant.snapshot());
  assert.equal(immediate.rotors.primary, 1, 'trip does not instantly stop the pump rotor');
  assert.equal(immediate.rotors.turbine, 1, 'trip does not instantly stop the turbine rotor');
  assert.equal(immediate.rates.grid, 0);
  const later = diagramState(plant.step(7));
  assert.ok(later.rotors.primary > 0 && later.rotors.primary < immediate.rotors.primary);
  assert.ok(later.rotors.turbine > 0 && later.rotors.turbine < immediate.rotors.turbine);
  assert.ok(later.rates.primary > later.rotors.primary, 'natural circulation remains as forced flow falls');
});

test('bypass-only steam still travels from the SG through the common header', () => {
  const snapshot = new PWRPlant().snapshot();
  const state = diagramState({ ...snapshot, steamFlow: PARAMETERS.nominalSteamFlowKgS / 2,
    turbineSteamFlow: 0, bypassSteamFlow: PARAMETERS.nominalSteamFlowKgS / 2 });
  assert.equal(state.rates.steamHeader, 0.5);
  assert.equal(state.rates.bypass, 0.5);
  assert.equal(state.rates.steam, 0);
  assert.equal(state.steamActivity, 0.5);
});

test('generator lead respects its breaker, gross power, and the sign of synchronization power', () => {
  const snapshot = new PWRPlant().snapshot();
  assert.equal(diagramState({ ...snapshot, gridConnected: false, grossPower: 1050 }).rates.grid, 0);
  assert.equal(diagramState({ ...snapshot, grossPower: 0, electricPower: -50 }).rates.grid, 0);
  near(diagramState({ ...snapshot, grossPower: 10, electricPower: -40 }).rates.grid, 10 / 1050);
  near(diagramState({ ...snapshot, grossPower: -20, electricPower: -70 }).rates.grid, -20 / 1050);
});

test('cooling loss stops cooling tracers without freezing unrelated equipment', () => {
  const plant = new PWRPlant();
  plant.setFault('lossOfHeatSink', true);
  const state = diagramState(plant.snapshot());
  assert.equal(state.rates.cooling, 0);
  assert.equal(state.rotors.turbine, 1);
  assert.equal(state.rates.primary, 1);
});

test('invalid and extreme observations cannot produce nonfinite or unbounded visual activity', () => {
  const state = diagramState({ primaryFlow: Infinity, steamFlow: NaN, turbineSpeed: -30000,
    feedFlow: 1e20, grossPower: -1e20, gridConnected: true, thermalPower: 1e20,
    controls: { cooling: Infinity } });
  assert.equal(state.rates.primary, 0);
  assert.equal(state.rates.steamHeader, 0);
  assert.equal(state.rates.feed, 2);
  assert.equal(state.rates.grid, -2);
  assert.equal(state.rotors.turbine, -2);
  assert.equal(state.heat, 1);
  for (const group of [state.rates, state.rotors]) {
    for (const value of Object.values(group)) assert.ok(Number.isFinite(value) && Math.abs(value) <= 2);
  }
  assert.doesNotThrow(() => diagramState(null));
});

test('visual phases freeze when paused, wrap in either direction, and do not catch up after long gaps', () => {
  near(advancePhase(0.4, 1, 0), 0.4);
  near(advancePhase(0.4, 0, 0.1), 0.4);
  near(advancePhase(0.95, 1, 0.1), 0.05);
  near(advancePhase(0.05, -1, 0.1), 0.95);
  near(advancePhase(0.4, 1, 60), 0.5);
  near(advancePhase(0.4, 1, -1), 0.4);
  near(advancePhase(350, 200, 0.1, 360), 10);
  near(advancePhase(0.2, 1, Infinity), 0.2);
  assert.ok(Number.isFinite(advancePhase(NaN, Infinity, 0.1, 0)));
});
