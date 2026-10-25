// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PWRPlant, PARAMETERS } from '../src/engine.js';
import { stepKinetics, DELAYED_GROUPS, saturationPressure, saturationTemperature } from '../src/physics.js';

const finiteSnapshot = snapshot => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must be finite`);
  }
};

test('fuel-primary-SG storage change equals its integrated boundary energy during a feed transient', () => {
  const plant = new PWRPlant();
  const initial = plant.snapshot();
  plant.setControl('autoFeedwater', false);
  plant.setControl('feedwater', 0.85);
  plant.step(45);
  const final = plant.snapshot();
  assert.ok(final.steamLevel < initial.steamLevel, 'mass disturbance must be exercised');
  const storedChange = final.storedEnergyMJ - initial.storedEnergyMJ;
  const boundaryChange = final.integratedBoundaryEnergyMJ - initial.integratedBoundaryEnergyMJ;
  assert.ok(Math.abs(storedChange - boundaryChange) < 1e-4,
    `storage change ${storedChange} MJ differs from boundary ${boundaryChange} MJ`);
  assert.ok(Math.abs(final.integratedEnergyResidualMJ) < 1e-4);
});

test('steam-generator mass accounting includes unequal inlet and outlet flow', () => {
  const plant = new PWRPlant();
  const initialMass = plant.snapshot().steamLevel / 100 * PARAMETERS.steamFullMassKg;
  plant.setControl('autoFeedwater', false);
  plant.setControl('feedwater', 0.9);
  let integratedMass = 0;
  for (let i = 0; i < 400; i++) {
    const snapshot = plant.step(0.05);
    integratedMass += (snapshot.feedFlow - snapshot.steamFlow) * 0.05;
  }
  const finalMass = plant.snapshot().steamLevel / 100 * PARAMETERS.steamFullMassKg;
  assert.ok(Math.abs(finalMass - initialMass - integratedMass) < 1e-6);
});

test('load increase from a half-thermal initial condition settles near requested net output', () => {
  const plant = new PWRPlant({ initialPower: 0.5 });
  assert.equal(plant.snapshot().controls.demand, 0.475);
  plant.setControl('cooling', 1);
  plant.setControl('demand', 0.9);
  const end = plant.step(600);
  assert.equal(end.tripped, false);
  assert.equal(end.domainExceeded, false);
  assert.ok(Math.abs(end.electricPower - 900) < 5);
  assert.ok(end.neutronPower > 0.8);
});

test('loss of feedwater halts at the inventory validity boundary with finite outputs', () => {
  const plant = new PWRPlant();
  plant.setFault('feedwaterTrip', true);
  const end = plant.step(600);
  assert.equal(end.tripped, true);
  assert.equal(end.domainExceeded, true);
  assert.match(end.domainReason, /inventory/);
  assert.ok(end.time < 600);
  finiteSnapshot(end);
  const frozen = JSON.stringify(plant.exportState());
  plant.step(30);
  assert.equal(JSON.stringify(plant.exportState()), frozen);
  const restored = new PWRPlant();
  restored.importState(plant.exportState());
  assert.equal(restored.snapshot().domainExceeded, true);
  assert.equal(restored.snapshot().time, end.time);
});

test('heat-sink loss raises condenser pressure and eventually actuates the generic trip', () => {
  const plant = new PWRPlant();
  const before = plant.snapshot();
  plant.setFault('lossOfHeatSink', true);
  const early = plant.step(30);
  assert.ok(early.condenserPressure > before.condenserPressure);
  assert.ok(early.electricPower < before.electricPower, 'backpressure reduces shaft output');
  const late = plant.step(180);
  assert.equal(late.tripped, true);
  assert.match(late.tripReason, /condenser/);
  finiteSnapshot(late);
});

test('manual rod transfer is bumpless and manual offset affects reactivity', () => {
  const plant = new PWRPlant({ initialPower: 0.5 });
  const originalWorth = plant.snapshot().rodReactivity;
  plant.setControl('autoReactor', false);
  assert.equal(plant.snapshot().rodReactivity, originalWorth);
  plant.setControl('rodReactivity', 50);
  const beforeTransfer = plant.snapshot().rodReactivity;
  assert.equal(beforeTransfer, originalWorth + 50);
  plant.setControl('autoReactor', true);
  assert.equal(plant.snapshot().rodReactivity, beforeTransfer);
});

test('trip reset requires safe conditions and never clears active equipment faults', () => {
  const plant = new PWRPlant();
  plant.scram();
  assert.equal(plant.resetTrip(), false, 'full-power state inhibits immediate reset');
  plant.step(40);
  assert.equal(plant.resetTrip(), true);
  assert.equal(plant.snapshot().tripped, false);
  plant.setFault('primaryPumpTrip', true);
  plant.step(40);
  assert.equal(plant.resetTrip(), false);
});

test('all faults can be cleared while trips remain explicitly latched', () => {
  for (const fault of ['primaryPumpTrip', 'feedwaterTrip', 'turbineTrip', 'lossOfHeatSink']) {
    const plant = new PWRPlant();
    plant.setFault(fault, true);
    plant.step(0.5);
    plant.setFault(fault, false);
    assert.equal(plant.snapshot().faults[fault], false);
    finiteSnapshot(plant.snapshot());
  }
});

test('negative-reactivity kinetics preserves nonnegative precursor inventories', () => {
  let state = { n: 1, precursors: DELAYED_GROUPS.map(() => 1) };
  for (let i = 0; i < 600; i++) {
    state = stepKinetics(state.n, state.precursors, -8000, 0.05);
    assert.ok(state.n >= 0);
    assert.ok(state.precursors.every(value => value >= 0));
  }
  assert.ok(state.n < 0.02);
});

test('property helpers reject inputs outside their published domain', () => {
  for (const value of [NaN, Infinity, -1, 400]) assert.throws(() => saturationPressure(value));
  for (const value of [NaN, Infinity, -1, 25]) assert.throws(() => saturationTemperature(value));
});

test('impossible single-phase imports and unknown schema fields are rejected atomically', () => {
  const plant = new PWRPlant();
  const start = JSON.stringify(plant.exportState());
  const boilingPrimary = plant.exportState();
  boilingPrimary.state.primaryPressure = 0.1;
  assert.throws(() => plant.importState(boilingPrimary), /two-phase/);
  const unknownField = plant.exportState();
  unknownField.extra = 'not part of schema';
  assert.throws(() => plant.importState(unknownField));
  const futureEvent = plant.exportState();
  futureEvent.events.push({ time: 900, level: 'info', message: 'invalid future event' });
  assert.throws(() => plant.importState(futureEvent));
  assert.equal(JSON.stringify(plant.exportState()), start);
});

test('event history is bounded and snapshots cannot mutate engine controls', () => {
  const plant = new PWRPlant();
  for (let i = 0; i < 300; i++) plant.setControl('demand', i % 2 ? 0.8 : 0.9);
  assert.equal(plant.snapshot().events.length, 200);
  const snapshot = plant.snapshot();
  snapshot.controls.demand = 0.3;
  snapshot.faults.turbineTrip = true;
  snapshot.events[0].message = 'modified outside';
  assert.equal(plant.snapshot().controls.demand, 0.8);
  assert.equal(plant.snapshot().faults.turbineTrip, false);
  assert.notEqual(plant.snapshot().events[0].message, 'modified outside');
});

test('lowest supported hot equilibrium is consistent with the minimum 250 MWe demand', () => {
  assert.throws(() => new PWRPlant({ initialPower: 0.25 }), /2\/7/);
  const plant = new PWRPlant({ initialPower: 2 / 7 });
  const start = plant.snapshot();
  assert.equal(start.controls.demand, 0.25);
  assert.ok(Math.abs(start.electricPower - 250) < 1e-10);
  const end = plant.step(300);
  assert.equal(end.domainExceeded, false);
  assert.equal(end.tripped, false);
  assert.ok(Math.abs(end.electricPower - start.electricPower) < 1e-6);
  assert.ok(Math.abs(end.thermalPower - start.thermalPower) < 1e-6);
});

test('unflagged imports reject every declared thermodynamic validity limit', () => {
  const plant = new PWRPlant();
  const original = JSON.stringify(plant.exportState());
  const invalidStates = [
    ['fuelTemp', 50], ['fuelTemp', 1450],
    ['coolantTemp', 90], ['coolantTemp', 345],
    ['steamTemp', 90], ['steamTemp', 335],
    ['steamMass', 8000], ['steamMass', 295000],
    ['condenserTemp', 15], ['condenserTemp', 96],
    ['neutronPower', 2.05],
  ];
  for (const [field, value] of invalidStates) {
    const invalid = plant.exportState();
    invalid.state[field] = value;
    assert.throws(() => plant.importState(invalid), /model domain/);
    assert.equal(JSON.stringify(plant.exportState()), original, `${field} rejection must be atomic`);
  }
});
