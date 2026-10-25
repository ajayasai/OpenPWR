// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PWRPlant } from '../src/engine.js';

const actions = ['prepare', 'startHeatup', 'holdHotStandby', 'rollTurbine', 'connectGrid'];
const physicalKeys = ['fuelTemp', 'coolantTemp', 'steamTemp', 'steamMass', 'neutronPower', 'precursors', 'decay', 'iodine', 'xenon', 'rotorEnergyMJ'];
let coldRun;

function getColdRun() {
  if (coldRun) return coldRun;
  const plant = new PWRPlant({ mode: 'cold' });
  const initial = plant.snapshot();
  const checkpoints = {};
  const actionTimes = {};
  let actionIndex = 0;
  for (let seconds = 0; seconds < 24000 && actionIndex < actions.length; seconds++) {
    const snapshot = plant.snapshot();
    const action = actions[actionIndex];
    if (snapshot.startupPermissives[action].allowed) {
      checkpoints[action] = plant.exportState();
      const before = plant.exportState().state;
      assert.equal(plant.startupAction(action).ok, true);
      const after = plant.exportState().state;
      for (const key of physicalKeys) assert.deepEqual(after[key], before[key], `${action} cannot teleport ${key}`);
      actionTimes[action] = snapshot.time;
      actionIndex++;
    }
    if (actionIndex === actions.length) break;
    plant.step(1);
    const current = plant.snapshot();
    assert.equal(current.tripped, false, `unexpected trip: ${current.tripReason}`);
    assert.equal(current.domainExceeded, false, `unexpected boundary: ${current.domainReason}`);
    assert.ok(Math.abs(current.energyResidual) < 1e-5);
    if (seconds === 2000) checkpoints.warm = plant.exportState();
  }
  assert.equal(actionIndex, actions.length, 'all startup actions must become physically permissible');
  const connected = plant.exportState();
  coldRun = { initial, checkpoints, actionTimes, connected };
  return coldRun;
}

test('cold initialization has ambient thermal states, subcritical source support, and no inherited decay heat', () => {
  const plant = new PWRPlant({ mode: 'cold' });
  const start = plant.snapshot();
  assert.equal(start.startupStage, 'cold');
  assert.equal(start.gridConnected, false);
  for (const key of ['fuelTemp', 'coolantTemp', 'steamTemp', 'condenserTemp']) assert.equal(start[key], 25);
  assert.equal(start.decayPower, 0);
  assert.equal(start.grossPower, 0);
  assert.equal(start.turbineSpeed, 0);
  assert.ok(start.neutronPower > 0 && start.neutronPower < 1e-7);
  assert.ok(start.reactivity < 0);
  assert.equal(start.steamPressure, 0.101325, 'cold secondary headspace is atmospheric, not a fictional vacuum');
  const end = plant.step(60);
  assert.ok(Math.abs(end.neutronPower / start.neutronPower - 1) < 1e-5);
  assert.ok(Math.abs(end.coolantTemp - 25) < 0.001);
  assert.equal(end.steamFlow, 0, 'subcooled secondary cannot emit saturated steam');
});

test('startup actions reject invalid sequence without changing physical states', () => {
  const plant = new PWRPlant({ mode: 'cold' });
  for (const action of ['startHeatup', 'holdHotStandby', 'rollTurbine', 'connectGrid', 'disconnectGrid']) {
    const before = plant.exportState().state;
    const result = plant.startupAction(action);
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 5);
    assert.deepEqual(plant.exportState().state, before);
  }
  assert.throws(() => plant.startupAction('skipToPower'), /Unknown/);
  assert.equal(plant.startupAction('prepare').ok, true);
  assert.equal(plant.startupAction('startHeatup').ok, false, 'pump and pressure cannot become ready instantly');
  plant.step(15);
  assert.equal(plant.snapshot().startupPermissives.startHeatup.allowed, true);
});

test('complete cold-to-grid sequence heats physical inventories and spins the rotor without state jumps', () => {
  const run = getColdRun();
  assert.ok(run.actionTimes.holdHotStandby > 4 * 3600, 'heatup must take physical simulated time');
  assert.ok(run.actionTimes.connectGrid < 7 * 3600, 'default generic sequence should complete within seven simulated hours');
  assert.ok(run.actionTimes.connectGrid - run.actionTimes.rollTurbine > 300, 'turbine acceleration cannot be instantaneous');
  const end = new PWRPlant();
  end.importState(run.connected);
  const snapshot = end.snapshot();
  assert.equal(snapshot.gridConnected, true);
  assert.equal(snapshot.startupStage, 'power');
  assert.ok(snapshot.coolantTemp >= 275);
  assert.ok(snapshot.steamTemp >= 265);
  assert.ok(snapshot.turbineSpeed >= 2950);
  assert.ok(snapshot.decayPower > 0);
  assert.ok(snapshot.iodine > 0);
  assert.ok(snapshot.xenon > 0);
  assert.ok(Math.abs(snapshot.storedEnergyMJ - run.initial.storedEnergyMJ - snapshot.integratedBoundaryEnergyMJ) < 1e-3);
});

test('cold-start plant accepts load, synchronizes continuously, and ramps to nominal output', () => {
  const plant = new PWRPlant();
  plant.importState(getColdRun().connected);
  const before = plant.snapshot();
  const immediate = plant.step(0.05);
  assert.ok(immediate.turbineSpeed > before.turbineSpeed && immediate.turbineSpeed < 3000, 'grid coupling must integrate rotor synchronization');
  assert.ok(Math.abs(immediate.rotorEnergyResidualMW) < 1e-6);
  const savedWhileMotoring = new PWRPlant();
  savedWhileMotoring.importState(plant.exportState());
  assert.equal(savedWhileMotoring.snapshot().electricPower, immediate.electricPower);
  plant.step(600);
  let snapshot = plant.snapshot();
  assert.equal(snapshot.tripped, false, snapshot.tripReason);
  assert.equal(snapshot.domainExceeded, false, snapshot.domainReason);
  assert.ok(Math.abs(snapshot.electricPower - 250) < 5);
  for (let demand = 0.3; demand < 1.001; demand += 0.05) {
    plant.setControl('demand', Math.min(1, demand));
    plant.step(80);
    snapshot = plant.snapshot();
    assert.equal(snapshot.tripped, false, snapshot.tripReason);
    assert.equal(snapshot.domainExceeded, false, snapshot.domainReason);
  }
  plant.step(600);
  snapshot = plant.snapshot();
  assert.ok(Math.abs(snapshot.electricPower - 1000) < 5, `nominal net output was ${snapshot.electricPower}`);
  assert.ok(Math.abs(snapshot.turbineSpeed - 3000) < 1e-6);
  assert.ok(Math.abs(snapshot.energyResidual) < 1e-5);
});

test('cold heatup results converge under time-step refinement', () => {
  const run = dt => {
    const plant = new PWRPlant({ mode: 'cold' });
    plant.startupAction('prepare');
    for (let i = 0; i < Math.round(15 / dt); i++) plant.step(dt);
    assert.equal(plant.startupAction('startHeatup').ok, true);
    for (let i = 0; i < Math.round(900 / dt); i++) plant.step(dt);
    return plant.snapshot();
  };
  const coarse = run(0.05);
  const fine = run(0.025);
  for (const key of ['neutronPower', 'thermalPower', 'coolantTemp', 'fuelTemp', 'primaryPressure']) {
    assert.ok(Math.abs(coarse[key] - fine[key]) / Math.max(Math.abs(fine[key]), 1e-9) < 0.005, `${key} must converge`);
  }
});

test('warm startup state saves and replays every physical state deterministically', () => {
  const a = new PWRPlant();
  const b = new PWRPlant();
  a.importState(getColdRun().checkpoints.warm);
  b.importState(JSON.parse(JSON.stringify(a.exportState())));
  a.step(30); b.step(30);
  assert.deepEqual(a.exportState(), b.exportState());
});

test('startup trip blocks progress and preserves evolving precursor and decay inventories', () => {
  const plant = new PWRPlant();
  plant.importState(getColdRun().checkpoints.holdHotStandby);
  const before = plant.exportState().state;
  plant.setFault('primaryPumpTrip', true);
  const instant = plant.exportState().state;
  assert.deepEqual(instant.precursors, before.precursors);
  assert.deepEqual(instant.decay, before.decay);
  assert.equal(instant.fuelTemp, before.fuelTemp);
  assert.equal(plant.startupAction('holdHotStandby').ok, false);
  const end = plant.step(30);
  assert.equal(end.tripped, true);
  assert.ok(end.neutronPower < before.neutronPower);
  assert.ok(end.decayPower > 0);
  assert.equal(end.gridConnected, false);
  assert.equal(end.domainExceeded, false);
});

test('generator load rejection trips and limits physical turbine overspeed', () => {
  const plant = new PWRPlant();
  assert.equal(plant.startupAction('disconnectGrid').ok, true);
  let peakRpm = 0;
  for (let i = 0; i < 200; i++) {
    const s = plant.step(0.05);
    peakRpm = Math.max(peakRpm, s.turbineSpeed);
    assert.equal(s.tripped, true);
    assert.equal(s.gridConnected, false);
    assert.equal(s.domainExceeded, false, s.domainReason);
    assert.ok(Math.abs(s.rotorEnergyResidualMW) < 1e-6);
  }
  assert.ok(peakRpm > 3000 && peakRpm < 3300);
  assert.match(plant.snapshot().tripReason, /load rejection/);
});

test('authentic v0.1 hot save migrates without changing temperatures or nuclear inventories', () => {
  const legacy = JSON.parse(readFileSync(new URL('./fixtures/v0.1.0-hot-state.json', import.meta.url), 'utf8'));
  const plant = new PWRPlant();
  plant.importState(legacy);
  const migrated = plant.exportState();
  assert.equal(migrated.schema, 'openpwr-state-v2');
  for (const key of ['time', 'fuelTemp', 'coolantTemp', 'steamTemp', 'steamMass', 'neutronPower', 'precursors', 'decay', 'iodine', 'xenon']) {
    assert.deepEqual(migrated.state[key], legacy.state[key], `migration preserves ${key}`);
  }
  assert.equal(migrated.state.integratedBoundaryEnergyMJ, 0);
  const end = plant.step(60);
  assert.equal(end.domainExceeded, false, end.domainReason);
  assert.equal(end.tripped, false, end.tripReason);
  assert.ok(Number.isFinite(end.electricPower));
});

test('saved startup stage, grid status, and rotor energy must be physically consistent', () => {
  const plant = new PWRPlant({ mode: 'cold' });
  const original = JSON.stringify(plant.exportState());
  const contradictoryRotor = plant.exportState();
  contradictoryRotor.state.startupStage = 'turbineRoll';
  contradictoryRotor.state.turbineSpeed = 3000;
  contradictoryRotor.state.rotorEnergyMJ = 0;
  assert.throws(() => plant.importState(contradictoryRotor), /rotor speed/);
  const coldConnection = plant.exportState();
  coldConnection.state.startupStage = 'power';
  coldConnection.state.gridConnected = true;
  coldConnection.state.turbineSpeed = 3000;
  coldConnection.state.rotorEnergyMJ = 2000;
  assert.throws(() => plant.importState(coldConnection), /hot steam/);
  const disconnectedPower = plant.exportState();
  disconnectedPower.state.startupStage = 'power';
  assert.throws(() => plant.importState(disconnectedPower), /connected generator/);
  assert.equal(JSON.stringify(plant.exportState()), original, 'all semantic rejections must be atomic');
});

test('natural startup connections and trip transients remain saveable under semantic validation', () => {
  const plant = new PWRPlant();
  plant.importState(getColdRun().connected);
  for (const elapsed of [0.05, 0.5, 3, 20]) {
    plant.step(elapsed);
    const restored = new PWRPlant();
    restored.importState(JSON.parse(JSON.stringify(plant.exportState())));
    assert.deepEqual(restored.exportState(), plant.exportState());
  }
  plant.scram('Serialization recovery check');
  for (const elapsed of [0.05, 0.5, 3, 20]) {
    plant.step(elapsed);
    const restored = new PWRPlant();
    restored.importState(JSON.parse(JSON.stringify(plant.exportState())));
    assert.deepEqual(restored.exportState(), plant.exportState());
  }
});

test('finite terminal overshoots remain inspectable after a save/reload and cannot advance', () => {
  const cases = [
    { neutronPower: 0, precursors: Array(6).fill(3), autoRod: 499 },
    { steamMass: 9000, steamTemp: 330, coolantTemp: 340, fuelTemp: 1400, heatToCoolant: 0, primaryPressure: 22 },
  ];
  for (const changes of cases) {
    const plant = new PWRPlant();
    const candidate = plant.exportState();
    Object.assign(candidate.state, changes);
    plant.importState(candidate);
    const terminal = plant.step(0.05);
    assert.equal(terminal.domainExceeded, true);
    assert.ok(Object.values(terminal).filter(value => typeof value === 'number').every(Number.isFinite));
    const restored = new PWRPlant();
    restored.importState(JSON.parse(JSON.stringify(plant.exportState())));
    assert.deepEqual(restored.exportState(), plant.exportState());
    const frozen = restored.exportState();
    restored.step(10);
    assert.deepEqual(restored.exportState(), frozen);
    const unhalted = restored.exportState();
    unhalted.state.domainExceeded = false;
    assert.throws(() => restored.importState(unhalted), 'clearing a terminal flag cannot bypass the active physical envelope');
  }
});

test('halted imports retain actuator bounds and cannot introduce non-finite diagnostic temperatures', () => {
  const plant = new PWRPlant();
  const original = JSON.stringify(plant.exportState());
  for (const pumpSpeed of [-0.08 / 0.92, -0.001, 1.001]) {
    const corrupt = plant.exportState();
    corrupt.state.domainExceeded = true;
    corrupt.state.domainReason = 'Imported diagnostic state';
    corrupt.state.pumpSpeed = pumpSpeed;
    assert.throws(() => plant.importState(corrupt));
    assert.equal(JSON.stringify(plant.exportState()), original);
  }
  assert.ok(Object.values(plant.snapshot()).filter(value => typeof value === 'number').every(Number.isFinite));
});

test('paused breaker opening immediately exposes zero gross and imported auxiliary power in public/exported data', () => {
  for (const action of ['scram', 'disconnectGrid']) {
    const plant = new PWRPlant();
    plant.importState(getColdRun().connected);
    plant.step(600);
    const before = plant.exportState().state;
    assert.ok(before.electricPower > 240);
    if (action === 'scram') plant.scram('Paused electrical accounting check');
    else assert.equal(plant.startupAction('disconnectGrid').ok, true);
    const after = plant.exportState().state;
    const snapshot = plant.snapshot();
    assert.equal(snapshot.time, before.time, 'no solver advancement is needed');
    assert.equal(snapshot.gridConnected, false);
    assert.equal(snapshot.tripped, true);
    assert.equal(snapshot.grossPower, 0);
    const expectedNet = -(30 + 20 * before.pumpSpeed ** 3);
    assert.equal(snapshot.electricPower, expectedNet);
    assert.equal(after.electricPower, expectedNet);
    assert.equal(after.grossPower, 0);
    for (const key of physicalKeys) assert.deepEqual(after[key], before[key], `opening the breaker cannot teleport ${key}`);
    // These are the exact public numeric fields consumed by the UI's CSV rows.
    const csvFields = ['electricPower', 'grossPower', 'gridConnected'];
    const row = csvFields.map(key => Number(snapshot[key])).join(',');
    assert.equal(row, `${expectedNet},0,0`);
    const restored = new PWRPlant();
    restored.importState(plant.exportState());
    assert.equal(restored.snapshot().electricPower, expectedNet);
  }
});

test('a paused trip switches off startup auxiliary heat without changing stored temperatures', () => {
  const plant = new PWRPlant({ mode: 'cold' });
  plant.startupAction('prepare');
  plant.step(15);
  const before = plant.exportState().state;
  assert.equal(before.auxiliaryHeatMW, 5);
  plant.scram();
  const after = plant.snapshot();
  assert.equal(after.auxiliaryHeatMW, 0);
  assert.equal(after.grossPower, 0);
  assert.equal(after.electricPower, -(30 + 20 * before.pumpSpeed ** 3));
  assert.equal(after.coolantTemp, before.coolantTemp);
  assert.equal(after.fuelTemp, before.fuelTemp);
});
