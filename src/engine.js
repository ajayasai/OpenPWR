// SPDX-License-Identifier: Apache-2.0
import {
  stepKinetics, saturationPressure, saturationTemperature, liquidEnthalpy,
  vaporEnthalpy, steamStoredEnergy, steamTemperatureFromEnergy, clamp, relax,
} from './physics.js';

const STEAM_T_NOM = saturationTemperature(6);
const FEED_T = 220;
const FEED_H = liquidEnthalpy(FEED_T);
const STEAM_DH = vaporEnthalpy(STEAM_T_NOM) - FEED_H;

/** Generic calibrated design assumptions, not data for any named facility.
 * Energy units MW=MJ/s; stored energies MJ; temperatures C; mass kg.
 * IAPWS saturation is a property correlation; all capacities, controllers,
 * turbine performance and trip settings below are transparent surrogate choices.
 */
export const PARAMETERS = Object.freeze({
  thermalMW: 3000,
  netElectricMW: 1000,
  steamPressureMPa: 6,
  steamTempC: STEAM_T_NOM,
  coolantTempC: 307.5,
  fuelTempC: 600,
  primaryPressureMPa: 15.5,
  primaryFlowKgS: 15584.415584415585,
  primaryCpMJkgK: 0.0055,
  fuelCapacityMJK: 60,
  coolantCapacityMJK: 1100,
  steamMetalCapacityMJK: 400,
  steamMassKg: 150000,
  steamFullMassKg: 300000,
  fuelConductanceMWK: 3000 / (600 - 307.5),
  steamConductanceMWK: 3000 / (307.5 - STEAM_T_NOM),
  nominalSteamFlowKgS: 3000 / STEAM_DH,
  feedwaterTempC: FEED_T,
  condenserCapacityMJK: 12000,
  condenserTempC: 40,
  coolingWaterTempC: 20,
  condenserConductanceMWK: 1950 / 20,
  turbineEfficiency: 0.35,
  fuelFeedbackPcmK: -2,
  moderatorFeedbackPcmK: -12,
  xenonWorthPcm: -80,
  xenonDecayPerS: Math.log(2) / (9.14 * 3600),
  iodineDecayPerS: Math.log(2) / (6.57 * 3600),
  xenonBurnPerS: 2e-5,
  maxStepS: 0.05,
  minInitialThermalFraction: 2 / 7, // 250 MWe net at nominal 35% gross efficiency and 50 MW auxiliaries
});

// Illustrative six-exponential decay-power history approximation; NOT ANS-5.1.
// Group fractions sum to 0.066 of nominal thermal power at long-term equilibrium.
export const DECAY_GROUPS = Object.freeze([
  { fraction: 0.013, tau: 1 }, { fraction: 0.016, tau: 5 },
  { fraction: 0.012, tau: 25 }, { fraction: 0.010, tau: 150 },
  { fraction: 0.008, tau: 1000 }, { fraction: 0.007, tau: 10000 },
].map(Object.freeze));
const PROMPT_HEAT_FRACTION = 1 - DECAY_GROUPS.reduce((sum, g) => sum + g.fraction, 0);
const CONTROL_RANGES = Object.freeze({ demand: [0.25, 1], rodReactivity: [-250, 250], primaryPump: [0, 1], feedwater: [0, 1.2], turbineValve: [0, 1], cooling: [0, 1] });
const BOOLEAN_CONTROLS = ['autoReactor', 'autoFeedwater', 'autoTurbine'];
const FAULT_NAMES = ['primaryPumpTrip', 'feedwaterTrip', 'turbineTrip', 'lossOfHeatSink'];
const SCHEMA = 'openpwr-state-v1';
const clone = value => JSON.parse(JSON.stringify(value));

export class PWRPlant {
  constructor(options = {}) { this.reset(options); }

  reset({ initialPower = 1 } = {}) {
    if (!Number.isFinite(initialPower) || initialPower < PARAMETERS.minInitialThermalFraction || initialPower > 1) {
      throw new RangeError('Initial reactor thermal-power fraction must be between 2/7 (about 28.57%) and 1');
    }
    const p = PARAMETERS;
    const n = initialPower;
    const coolant = STEAM_T_NOM + n * (p.coolantTempC - STEAM_T_NOM);
    const fuel = coolant + n * (p.fuelTempC - p.coolantTempC);
    const xe = (p.xenonDecayPerS + p.xenonBurnPerS) * n / (p.xenonDecayPerS + p.xenonBurnPerS * n);
    // Cooling-flow schedule preserves 40 C at all initialized loads; thereafter
    // cooling demand is an independent operator control, not tied to reactor power.
    this.controls = {
      demand: clamp((1050 * n - 50) / 1000, 0.25, 1), autoReactor: true, rodReactivity: 0, primaryPump: 1,
      autoFeedwater: true, feedwater: n, autoTurbine: true, turbineValve: n, cooling: n,
    };
    this.faults = Object.fromEntries(FAULT_NAMES.map(name => [name, false]));
    const feedback = this._feedback(fuel, coolant, xe);
    this.state = {
      time: 0, neutronPower: n, precursors: Array(6).fill(n),
      decay: DECAY_GROUPS.map(g => g.fraction * n),
      fuelTemp: fuel, coolantTemp: coolant, steamTemp: STEAM_T_NOM,
      steamMass: p.steamMassKg, primaryPressure: p.primaryPressureMPa,
      condenserTemp: p.condenserTempC, pumpSpeed: 1,
      turbineValve: n, feedFlow: n * p.nominalSteamFlowKgS,
      turbineSpeed: 3000, iodine: n, xenon: xe, autoRod: -feedback,
      reactivity: 0, tripped: false, tripReason: '',
      domainExceeded: false, domainReason: '', energyResidual: 0,
      integratedEnergyResidualMJ: 0, integratedBoundaryEnergyMJ: 0,
      thermalPower: n * p.thermalMW, decayPower: n * p.thermalMW * (1 - PROMPT_HEAT_FRACTION),
      electricPower: n * 1050 - 50, grossPower: n * 1050,
      steamFlow: n * p.nominalSteamFlowKgS, turbineSteamFlow: n * p.nominalSteamFlowKgS,
      bypassSteamFlow: 0, heatToSteam: n * p.thermalMW,
      heatToCoolant: n * p.thermalMW, condenserHeat: n * 1950,
      coolingHeat: n * 1950, energyInMJ: 0, energyOutMJ: 0,
    };
    this.events = [];
    this._event('info', `Initialized at ${(n * 100).toFixed(0)}% reactor power; equilibrium precursor and decay inventory`);
    return this.snapshot();
  }

  _feedback(fuel, coolant, xenon) {
    const p = PARAMETERS;
    return p.fuelFeedbackPcmK * (fuel - p.fuelTempC)
      + p.moderatorFeedbackPcmK * (coolant - p.coolantTempC)
      + p.xenonWorthPcm * (xenon - 1);
  }

  _event(level, message) {
    this.events.push({ time: this.state.time, level, message });
    if (this.events.length > 200) this.events.shift();
  }

  setControl(key, value) {
    if (BOOLEAN_CONTROLS.includes(key)) {
      if (typeof value !== 'boolean') throw new TypeError(`${key} must be boolean`);
    } else if (Object.hasOwn(CONTROL_RANGES, key)) {
      if (!Number.isFinite(value)) throw new TypeError(`${key} must be finite`);
      value = clamp(value, ...CONTROL_RANGES[key]);
    } else throw new TypeError(`Unknown control: ${key}`);
    if (this.controls[key] === value) return;
    // Manual offset is relative to the current rod bank worth. Transfer is bumpless.
    if (key === 'autoReactor' && value === false) this.controls.rodReactivity = 0;
    if (key === 'autoReactor' && value === true) this.state.autoRod = clamp(this.state.autoRod + this.controls.rodReactivity, -2500, 2500);
    this.controls[key] = value;
    this._event('info', `${key}: ${typeof value === 'number' ? Number(value.toFixed(3)) : value}`);
  }

  setFault(key, active) {
    if (!FAULT_NAMES.includes(key)) throw new TypeError(`Unknown fault: ${key}`);
    if (typeof active !== 'boolean') throw new TypeError('Fault state must be boolean');
    if (this.faults[key] === active) return;
    this.faults[key] = active;
    this._event(active ? 'warning' : 'info', `${active ? 'Applied' : 'Cleared'} ${key}`);
    if (active && key === 'primaryPumpTrip') this.scram('Primary coolant pump trip');
    if (active && key === 'turbineTrip') this.scram('Turbine trip');
  }

  scram(reason = 'Manual reactor trip') {
    if (typeof reason !== 'string' || reason.length > 240) throw new TypeError('Trip reason must be a short string');
    if (this.state.tripped) return;
    this.state.tripped = true;
    this.state.tripReason = reason;
    this.state.reactivity = -8000 + this._feedback(this.state.fuelTemp, this.state.coolantTemp, this.state.xenon);
    this._event('critical', `Reactor trip: ${reason}`);
  }

  resetTrip() {
    const s = this.state;
    if (!s.tripped) return true;
    if (Object.values(this.faults).some(Boolean) || s.domainExceeded || s.neutronPower > 0.1
        || s.coolantTemp > 320 || s.primaryPressure > 16.2 || s.steamMass < 75000 || s.pumpSpeed < 0.5) {
      this._event('warning', 'Trip reset blocked: restore equipment, inventory, flow, and low-power conditions');
      return false;
    }
    // Preserve low power on release; auto controller subsequently withdraws gradually.
    s.autoRod = clamp(-this._feedback(s.fuelTemp, s.coolantTemp, s.xenon) - 100, -2500, 2500);
    this.controls.rodReactivity = 0;
    s.tripped = false;
    s.tripReason = '';
    this._event('info', 'Reactor trip latch reset; automatic power recovery enabled');
    return true;
  }

  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 3600) throw new RangeError('Time step must be >0 and <=3600 seconds');
    if (this.state.domainExceeded) return this.snapshot();
    const count = Math.ceil(dt / PARAMETERS.maxStepS);
    const h = dt / count;
    for (let i = 0; i < count && !this.state.domainExceeded; i++) this._advance(h);
    return this.snapshot();
  }

  _advance(h) {
    const p = PARAMETERS;
    const s = this.state;
    const c = this.controls;
    const beforeEnergy = this._storedEnergy();
    const oldCoolant = s.coolantTemp;
    const targetPump = this.faults.primaryPumpTrip ? 0 : c.primaryPump;
    s.pumpSpeed = relax(s.pumpSpeed, targetPump, h, 7);
    const circulation = 0.08 + 0.92 * s.pumpSpeed; // generic natural-circulation floor
    const auxiliaries = 30 + 20 * s.pumpSpeed ** 3;
    const efficiency = p.turbineEfficiency * (1 - 0.008 * (s.condenserTemp - p.condenserTempC));
    // Net-load feedforward schedule accounts for measured condenser temperature
    // and pump auxiliaries. It moves physical actuators; it never sets power.
    const requestedShaftMW = 1000 * c.demand + auxiliaries;
    const targetThermalFraction = clamp(requestedShaftMW / (efficiency * p.thermalMW), 0.1, 1);

    if (c.autoReactor && !s.tripped) {
      const targetCoolant = STEAM_T_NOM + targetThermalFraction * (p.coolantTempC - STEAM_T_NOM);
      const rodRate = clamp(0.8 * (targetCoolant - s.coolantTemp) + 18 * (targetThermalFraction - s.neutronPower), -12, 12);
      s.autoRod = clamp(s.autoRod + rodRate * h, -2500, 2500);
    }
    const rod = s.tripped ? -8000 : s.autoRod + (c.autoReactor ? 0 : c.rodReactivity);
    s.reactivity = rod + this._feedback(s.fuelTemp, s.coolantTemp, s.xenon);
    if (s.reactivity > 500) {
      this.scram('High positive reactivity (generic protection)');
      s.reactivity = -8000 + this._feedback(s.fuelTemp, s.coolantTemp, s.xenon);
    }
    const kinetics = stepKinetics(s.neutronPower, s.precursors, s.reactivity, h);
    s.neutronPower = kinetics.n;
    s.precursors = kinetics.precursors;
    s.decay = s.decay.map((d, i) => relax(d, DECAY_GROUPS[i].fraction * s.neutronPower, h, DECAY_GROUPS[i].tau));
    s.decayPower = p.thermalMW * s.decay.reduce((a, b) => a + b, 0);
    s.thermalPower = p.thermalMW * PROMPT_HEAT_FRACTION * s.neutronPower + s.decayPower;
    s.iodine = relax(s.iodine, s.neutronPower, h, 1 / p.iodineDecayPerS);
    const xeRemoval = p.xenonDecayPerS + p.xenonBurnPerS * s.neutronPower;
    const xeSource = (p.xenonDecayPerS + p.xenonBurnPerS) * (0.05 * s.neutronPower + 0.95 * s.iodine);
    s.xenon = relax(s.xenon, xeSource / xeRemoval, h, 1 / xeRemoval);

    const steamPressure = saturationPressure(s.steamTemp);
    const availableValveMW = p.nominalSteamFlowKgS * Math.sqrt(steamPressure / p.steamPressureMPa)
      * (vaporEnthalpy(s.steamTemp) - FEED_H) * efficiency;
    const automaticValve = clamp(requestedShaftMW / availableValveMW, 0, 1);
    const valveTarget = (s.tripped || this.faults.turbineTrip) ? 0 : (c.autoTurbine ? automaticValve : c.turbineValve);
    s.turbineValve = relax(s.turbineValve, valveTarget, h, s.tripped ? 1 : 4);
    s.turbineSteamFlow = p.nominalSteamFlowKgS * s.turbineValve * Math.sqrt(steamPressure / p.steamPressureMPa);
    // Passive pressure dump / residual-heat steam path. This is an idealized train,
    // not a model of plant-specific auxiliary feedwater or emergency cooling.
    const bypass = clamp((steamPressure - 6.2) * 0.75, 0, 1.2) + (s.tripped ? 0.055 : 0);
    s.bypassSteamFlow = p.nominalSteamFlowKgS * bypass * Math.sqrt(steamPressure / p.steamPressureMPa);
    s.steamFlow = s.turbineSteamFlow + s.bypassSteamFlow;
    const autoFeed = s.steamFlow + 0.025 * (p.steamMassKg - s.steamMass);
    const feedTarget = this.faults.feedwaterTrip ? 0 : (c.autoFeedwater ? clamp(autoFeed, 0, 1.2 * p.nominalSteamFlowKgS) : c.feedwater * p.nominalSteamFlowKgS);
    s.feedFlow = relax(s.feedFlow, feedTarget, h, 4);
    s.heatToCoolant = p.fuelConductanceMWK * circulation ** 0.8 * (s.fuelTemp - s.coolantTemp);
    s.heatToSteam = p.steamConductanceMWK * circulation ** 0.8 * (s.coolantTemp - s.steamTemp);
    const vaporH = vaporEnthalpy(s.steamTemp);
    const incomingEnergy = s.thermalPower + s.feedFlow * FEED_H;
    const outgoingEnergy = s.steamFlow * vaporH;
    const steamEnergy = steamStoredEnergy(s.steamTemp, s.steamMass, p.steamMetalCapacityMJK)
      + h * (s.heatToSteam + s.feedFlow * FEED_H - s.steamFlow * vaporH);
    const newMass = s.steamMass + h * (s.feedFlow - s.steamFlow);
    // Exit before invalid property calls; retain last physical thermodynamic state.
    if (newMass <= 0 || steamEnergy <= 0) {
      this._domain('Steam inventory depleted; two-phase/dryout physics outside this model');
      return;
    }
    s.fuelTemp += h * (s.thermalPower - s.heatToCoolant) / p.fuelCapacityMJK;
    s.coolantTemp += h * (s.heatToCoolant - s.heatToSteam) / p.coolantCapacityMJK;
    s.steamTemp = steamTemperatureFromEnergy(steamEnergy, newMass, p.steamMetalCapacityMJK);
    s.steamMass = newMass;
    s.primaryPressure += 0.09 * (s.coolantTemp - oldCoolant) - h * (s.primaryPressure - p.primaryPressureMPa) / 45;

    // An infinite electrical bus fixes speed while connected. Upon trip the rotor
    // coasts down with a generic 45 s time constant; no grid-frequency model.
    const gridConnected = !s.tripped && !this.faults.turbineTrip && s.turbineSteamFlow > 1;
    s.turbineSpeed = gridConnected ? 3000 : relax(s.turbineSpeed, 0, h, 45);
    s.grossPower = gridConnected ? s.turbineSteamFlow * (vaporH - FEED_H) * efficiency : 0;
    s.electricPower = s.grossPower - auxiliaries;
    // Regenerative feedwater train is an algebraic closure returning condensate
    // to fixed FEED_H. Condenser heat is cycle heat input minus shaft output.
    s.condenserHeat = s.steamFlow * (vaporH - FEED_H) - s.grossPower;
    const coolingFraction = this.faults.lossOfHeatSink ? 0 : c.cooling;
    s.coolingHeat = p.condenserConductanceMWK * coolingFraction * (s.condenserTemp - p.coolingWaterTempC);
    s.condenserTemp += h * (s.condenserHeat - s.coolingHeat) / p.condenserCapacityMJK;
    s.time += h;
    const energyAfter = this._storedEnergy();
    s.energyResidual = (energyAfter - beforeEnergy) / h - incomingEnergy + outgoingEnergy;
    s.integratedEnergyResidualMJ += s.energyResidual * h;
    s.integratedBoundaryEnergyMJ += h * (incomingEnergy - outgoingEnergy);
    s.energyInMJ += incomingEnergy * h;
    s.energyOutMJ += outgoingEnergy * h;

    this._protection();
    this._checkDomain();
  }

  _storedEnergy() {
    const p = PARAMETERS;
    const s = this.state;
    return p.fuelCapacityMJK * s.fuelTemp + p.coolantCapacityMJK * s.coolantTemp
      + steamStoredEnergy(s.steamTemp, s.steamMass, p.steamMetalCapacityMJK);
  }

  _protection() {
    const s = this.state;
    if (s.tripped) return;
    if (s.neutronPower > 1.15) this.scram('High neutron power');
    else if (s.coolantTemp > 326) this.scram('High primary coolant temperature');
    else if (s.primaryPressure > 16.8) this.scram('High primary pressure');
    else if (s.steamMass < 60000) this.scram('Low steam-generator inventory');
    else if (s.pumpSpeed < 0.5 && s.neutronPower > 0.15) this.scram('Low primary coolant flow');
    else if (s.condenserTemp > 65) this.scram('High condenser backpressure');
    else if (s.steamTemp > saturationTemperature(7.5)) this.scram('High secondary pressure');
  }

  _domain(reason) {
    this.state.domainExceeded = true;
    this.state.domainReason = reason;
    this._event('critical', `Model boundary: ${reason}. Simulation halted.`);
  }

  _checkDomain() {
    const s = this.state;
    const badNumber = Object.entries(s).find(([, value]) => typeof value === 'number' && !Number.isFinite(value));
    if (badNumber) { this._domain(`Non-finite ${badNumber[0]}`); return; }
    if (s.fuelTemp > 1400 || s.fuelTemp < 80) this._domain('Fuel temperature outside lumped solid-fuel model (80–1400 C)');
    else if (s.coolantTemp < 100 || s.coolantTemp > 340) this._domain('Primary average temperature outside single-phase model (100–340 C)');
    else if (s.steamTemp < 100 || s.steamTemp > 330) this._domain('Steam temperature outside declared enthalpy-closure range (100–330 C)');
    else if (s.steamMass < 9000 || s.steamMass > 291000) this._domain('Steam-generator inventory outside 3–97% model range');
    else if (s.condenserTemp < 20 || s.condenserTemp > 95) this._domain('Condenser temperature outside 20–95 C model range');
    else if (s.neutronPower > 2 || s.neutronPower < 0) this._domain('Neutron power outside 0–200% model range');
    else if (s.primaryPressure < 0.1 || s.primaryPressure > 22) this._domain('Primary pressure outside single-phase property range');
    else {
      const flow = PARAMETERS.primaryFlowKgS * (0.08 + 0.92 * s.pumpSpeed);
      const hotLeg = s.coolantTemp + s.heatToCoolant / (2 * flow * PARAMETERS.primaryCpMJkgK);
      if (hotLeg >= saturationTemperature(s.primaryPressure)) this._domain('Primary hot leg reaches saturation; two-phase primary-flow physics not represented');
    }
  }

  _alarms() {
    const s = this.state;
    const alarms = [];
    const add = (id, level, message) => alarms.push({ id, level, message });
    if (s.domainExceeded) add('model-boundary', 'critical', s.domainReason);
    if (s.tripped) add('reactor-trip', 'critical', `Reactor trip latched: ${s.tripReason}`);
    if (s.steamMass < 105000) add('sg-low', 'warning', 'Steam generator level below 35%');
    if (s.steamMass > 225000) add('sg-high', 'warning', 'Steam generator level above 75%');
    if (s.coolantTemp > 320) add('primary-hot', 'warning', 'High average primary coolant temperature');
    if (s.pumpSpeed < 0.7) add('low-flow', 'warning', 'Primary pump speed below 70%');
    if (s.condenserTemp > 52) add('condenser-hot', 'warning', 'Condenser heat sink degraded');
    if (s.primaryPressure > 16.2) add('primary-pressure', 'warning', 'High primary pressure');
    const availableThermalNet = 3000 * PARAMETERS.turbineEfficiency * (1 - 0.008 * (s.condenserTemp - PARAMETERS.condenserTempC))
      - (30 + 20 * s.pumpSpeed ** 3);
    if (!s.tripped && this.controls.demand * 1000 > availableThermalNet + 10) add('load-limited', 'warning', 'Electrical demand exceeds output available at rated thermal power');
    if (s.xenon > 1.1) add('xenon', 'warning', 'Xenon inventory above full-power equilibrium');
    for (const fault of FAULT_NAMES) if (this.faults[fault]) add(`fault-${fault}`, 'warning', `Active fault: ${fault}`);
    return alarms;
  }

  snapshot() {
    const s = this.state;
    const p = PARAMETERS;
    const flow = p.primaryFlowKgS * (0.08 + 0.92 * s.pumpSpeed);
    const coreDeltaT = s.heatToCoolant / (flow * p.primaryCpMJkgK);
    const pressureSafe = t => saturationPressure(clamp(t, 0.01, 373.945));
    return {
      time: s.time, neutronPower: s.neutronPower, thermalPower: s.thermalPower,
      electricPower: s.electricPower, grossPower: s.grossPower, decayPower: s.decayPower,
      fuelTemp: s.fuelTemp, hotLegTemp: s.coolantTemp + coreDeltaT / 2,
      coldLegTemp: s.coolantTemp - coreDeltaT / 2, coolantTemp: s.coolantTemp,
      primaryPressure: s.primaryPressure, steamPressure: pressureSafe(s.steamTemp),
      steamTemp: s.steamTemp, steamLevel: 100 * s.steamMass / p.steamFullMassKg,
      steamFlow: s.steamFlow, feedFlow: s.feedFlow, primaryFlow: flow,
      condenserPressure: pressureSafe(s.condenserTemp) * 1000,
      condenserTemp: s.condenserTemp, turbineSpeed: s.turbineSpeed,
      reactivity: s.reactivity,
      rodReactivity: s.tripped ? -8000 : s.autoRod + (this.controls.autoReactor ? 0 : this.controls.rodReactivity),
      xenon: s.xenon, iodine: s.iodine, pumpSpeed: s.pumpSpeed, turbineValve: s.turbineValve,
      energyResidual: s.energyResidual, integratedEnergyResidualMJ: s.integratedEnergyResidualMJ,
      storedEnergyMJ: this._storedEnergy(), integratedBoundaryEnergyMJ: s.integratedBoundaryEnergyMJ,
      energyInMJ: s.energyInMJ, energyOutMJ: s.energyOutMJ,
      heatToCoolant: s.heatToCoolant, heatToSteam: s.heatToSteam,
      condenserHeat: s.condenserHeat, coolingHeat: s.coolingHeat,
      turbineSteamFlow: s.turbineSteamFlow, bypassSteamFlow: s.bypassSteamFlow,
      efficiency: s.thermalPower > 1 ? 100 * s.electricPower / s.thermalPower : 0,
      tripped: s.tripped, tripReason: s.tripReason,
      domainExceeded: s.domainExceeded, domainReason: s.domainReason,
      controls: { ...this.controls }, faults: { ...this.faults },
      alarms: this._alarms(), events: this.events.map(event => ({ ...event })),
    };
  }

  exportState() {
    return { schema: SCHEMA, model: 'OpenPWR reduced-order PWR 1.0', controls: clone(this.controls), faults: clone(this.faults), state: clone(this.state), events: clone(this.events) };
  }

  importState(input) {
    // Validate without mutating this instance. Reject extra/missing fields to avoid
    // prototype keys, schema drift, incomplete physics and arbitrary user content.
    if (!input || typeof input !== 'object' || input.schema !== SCHEMA) throw new TypeError('Unsupported OpenPWR save format');
    const incoming = clone(input);
    const reference = new PWRPlant();
    const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
      && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
    if (!exactKeys(incoming, ['schema', 'model', 'controls', 'faults', 'state', 'events'])
        || incoming.model !== 'OpenPWR reduced-order PWR 1.0'
        || !exactKeys(incoming.controls, Object.keys(reference.controls)) || !exactKeys(incoming.faults, FAULT_NAMES)
        || !exactKeys(incoming.state, Object.keys(reference.state))) throw new TypeError('Save has missing or unknown state fields');
    for (const key of BOOLEAN_CONTROLS) if (typeof incoming.controls[key] !== 'boolean') throw new TypeError('Invalid automatic control flag');
    for (const [key, [lo, hi]] of Object.entries(CONTROL_RANGES)) {
      const value = incoming.controls[key];
      if (!Number.isFinite(value) || value < lo || value > hi) throw new RangeError(`Invalid ${key}`);
    }
    for (const key of FAULT_NAMES) if (typeof incoming.faults[key] !== 'boolean') throw new TypeError('Invalid fault flag');
    for (const [key, original] of Object.entries(reference.state)) {
      const value = incoming.state[key];
      if (Array.isArray(original)) {
        if (!Array.isArray(value) || value.length !== original.length
          || value.some((x, index) => !Number.isFinite(x) || x < 0 || x > (key === 'decay' ? 3 * DECAY_GROUPS[index].fraction : 3))) throw new TypeError(`Invalid ${key} array`);
      } else if (typeof original === 'number') {
        if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new TypeError(`Invalid numeric ${key}`);
      } else if (typeof value !== typeof original || (typeof value === 'string' && value.length > 300)) throw new TypeError(`Invalid ${key}`);
    }
    const s = incoming.state;
    if (s.time < 0 || s.time > 1e8 || s.neutronPower < 0 || s.neutronPower > 2.1 || s.fuelTemp < 0 || s.fuelTemp > 1500
      || s.coolantTemp < 50 || s.coolantTemp > 360 || s.steamTemp < 50 || s.steamTemp > 350
      || s.steamMass <= 0 || s.steamMass > 310000 || s.condenserTemp < 10 || s.condenserTemp > 100
      || s.primaryPressure < 0.1 || s.primaryPressure > 22 || s.pumpSpeed < 0 || s.pumpSpeed > 1
      || s.turbineValve < 0 || s.turbineValve > 1 || s.feedFlow < 0 || s.feedFlow > 1.21 * PARAMETERS.nominalSteamFlowKgS
      || s.iodine < 0 || s.iodine > 10 || s.xenon < 0 || s.xenon > 10 || Math.abs(s.autoRod) > 2500
      || s.turbineSpeed < 0 || s.turbineSpeed > 3000 || Math.abs(s.reactivity) > 15000
      || s.thermalPower < 0 || s.thermalPower > 10000 || s.decayPower < 0 || s.decayPower > 1000
      || s.grossPower < 0 || s.grossPower > 3000 || s.electricPower < -100 || s.electricPower > 3000
      || s.steamFlow < 0 || s.steamFlow > 10000 || s.turbineSteamFlow < 0 || s.turbineSteamFlow > 5000
      || s.bypassSteamFlow < 0 || s.bypassSteamFlow > 5000 || Math.abs(s.energyResidual) > 1
      || Math.abs(s.heatToSteam) > 1e5 || Math.abs(s.heatToCoolant) > 1e5
      || Math.abs(s.condenserHeat) > 1e5 || Math.abs(s.coolingHeat) > 1e5
      || s.energyInMJ < 0 || s.energyOutMJ < 0) throw new RangeError('Save outside physical state domain');
    if (!Array.isArray(incoming.events) || incoming.events.length > 200
      || incoming.events.some(e => !exactKeys(e, ['time', 'level', 'message']) || !Number.isFinite(e.time) || e.time < 0 || e.time > s.time + 1e-8
        || !['info', 'warning', 'critical'].includes(e.level) || typeof e.message !== 'string' || e.message.length > 400)) throw new TypeError('Invalid event history');
    reference.state = s;
    reference.controls = incoming.controls;
    reference.faults = incoming.faults;
    reference.events = incoming.events;
    if (!s.domainExceeded) {
      reference._checkDomain();
      if (reference.state.domainExceeded) throw new RangeError(`Imported state outside model domain: ${reference.state.domainReason}`);
    }
    reference.snapshot(); // verifies thermodynamic derived quantities are evaluable
    this.state = s;
    this.controls = incoming.controls;
    this.faults = incoming.faults;
    this.events = incoming.events;
    return this.snapshot();
  }
}
