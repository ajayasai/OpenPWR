// SPDX-License-Identifier: Apache-2.0
// Presentation adapter only. No thermodynamic state, controls or integration is
// owned by the 3D view. Null means unobserved, never an invented zero reading.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bounded = (value, low, high) => value === null ? 0 : Math.max(low, Math.min(high, value));
const relative = (value, scale = 1) => bounded(value === null ? null : value / scale, -2, 2);

export function plant3DState(snapshot, mode = 'browser') {
  if (!['browser', 'native', 'plant'].includes(mode)) throw new TypeError('Unknown 3D observation source');
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const o = mode !== 'browser' ? (s.outputs || {}) : s;
  const c = s.controls || {};
  const native = mode !== 'browser', coupled = mode === 'plant';
  const values = native ? {
    thermalPower: number(c.reactorPowerMW), hotTemperature: number(o.hotLegTemperatureC),
    coldTemperature: number(o.coldLegTemperatureC), fuelTemperature: number(o.fuelTemperatureC),
    pressure: number(o.primaryPressureMPa), primaryFlow: number(o.primaryFlowKgS),
    pumpSpeed: number(o.pumpSpeed), steamTemperature: number(c.steamTemperatureC),
    heatToSteam: number(o.heatToSteamMW), pressurizerLevel: number(o.pressurizerLevelPercent),
    pressurizerMass: number(o.pressurizerMassKg), heaterPower: number(c.heaterPowerMW),
    sprayFlow: number(c.sprayFlowKgS), energyResidual: number(o.energyResidualMW),
    steamLevel: null, steamFlow: null, feedFlow: null, turbineSpeed: null,
    electricPower: null, grossPower: null, condenserPressure: null, condenserTemperature: null,
    steamPressure: null, turbineSteamFlow: null, bypassSteamFlow: null,
  } : {
    thermalPower: number(o.thermalPower), hotTemperature: number(o.hotLegTemp),
    coldTemperature: number(o.coldLegTemp), fuelTemperature: number(o.fuelTemp),
    pressure: number(o.primaryPressure), primaryFlow: number(o.primaryFlow),
    pumpSpeed: number(o.pumpSpeed), steamTemperature: number(o.steamTemp),
    heatToSteam: number(o.heatToSteam), pressurizerLevel: null, pressurizerMass: null,
    heaterPower: null, sprayFlow: null, energyResidual: number(o.energyResidual),
    steamLevel: number(o.steamLevel), steamFlow: number(o.steamFlow), feedFlow: number(o.feedFlow),
    turbineSpeed: number(o.turbineSpeed), electricPower: number(o.electricPower),
    grossPower: number(o.grossPower), condenserPressure: number(o.condenserPressure),
    condenserTemperature: number(o.condenserTemp), steamPressure: number(o.steamPressure),
    turbineSteamFlow: number(o.turbineSteamFlow), bypassSteamFlow: number(o.bypassSteamFlow),
  };
  Object.assign(values, { auxFlow: null, auxAFlow: null, auxBFlow: null, auxASpeed: null, auxBSpeed: null,
    auxTankLevel: null, auxTankMass: null, auxTankTemperature: null, auxPumpPower: null });
  if (coupled) Object.assign(values, {
    thermalPower: number(o.reactorPowerMW), steamTemperature: number(o.secondaryTemperatureC),
    steamLevel: number(o.secondaryLevelPercent), steamPressure: number(o.secondaryPressureMPa),
    steamFlow: Number.isFinite(o.turbineFlowKgS) && Number.isFinite(o.bypassFlowKgS) ? o.turbineFlowKgS + o.bypassFlowKgS : null,
    turbineSteamFlow: number(o.turbineFlowKgS), bypassSteamFlow: number(o.bypassFlowKgS),
    feedFlow: number(o.feedwaterFlowKgS), turbineSpeed: number(o.turbineRpm),
    electricPower: number(o.netPowerMW), grossPower: number(o.grossPowerMW),
    condenserPressure: number(o.condenserPressureKPa), condenserTemperature: number(o.condenserTemperatureC),
    energyResidual: number(o.plantEnergyResidualMW),
    auxFlow: number(o.auxFeedwaterFlowKgS), auxAFlow: number(o.auxTrainAFlowKgS), auxBFlow: number(o.auxTrainBFlowKgS),
    auxASpeed: number(o.auxPumpASpeed), auxBSpeed: number(o.auxPumpBSpeed),
    auxTankLevel: number(o.auxTankLevelPercent), auxTankMass: number(o.auxTankMassKg),
    auxTankTemperature: number(o.auxTankTemperatureC), auxPumpPower: number(o.auxPumpPowerMW),
  });
  const time = number(s.time);
  const identity = !native || (s.backend === 'fmi2' && s.model === (coupled ? 'OpenPWR.CoupledPlant' : 'OpenPWR.PrimaryLoop') && typeof o.valid === 'boolean');
  const available = identity && time !== null && time >= 0
    && ['hotTemperature', 'coldTemperature', 'pressure', 'primaryFlow', 'pumpSpeed'].every(key => values[key] !== null);
  const halted = native ? s.halted === true || o.valid === false : s.domainExceeded === true;
  const activity = {
    primary: relative(values.primaryFlow, 15584.415584415585),
    pump: relative(values.pumpSpeed),
    // A native secondary temperature boundary is not a simulated steam flow.
    steam: relative(values.turbineSteamFlow, 1500),
    steamHeader: relative(values.steamFlow, 1500),
    bypass: relative(values.bypassSteamFlow, 1500),
    feed: relative(values.feedFlow, 1500),
    auxiliary: relative(values.auxFlow, 120), auxAFlow: relative(values.auxAFlow, 60), auxBFlow: relative(values.auxBFlow, 60),
    auxAPump: relative(values.auxASpeed), auxBPump: relative(values.auxBSpeed),
    cooling: coupled ? relative(number(o.coolingPowerMW), 2000) : native || s.faults?.lossOfHeatSink ? 0 : relative(number(c.cooling)),
    turbine: relative(values.turbineSpeed, 3000),
    generator: relative(values.turbineSpeed, 3000),
    electricity: (coupled ? o.gridConnected === 1 : !native && s.gridConnected === true) ? relative(values.grossPower, 1050) : 0,
    heat: bounded(values.thermalPower === null ? null : values.thermalPower / 3000, 0, 1),
    heater: bounded(values.heaterPower === null ? null : values.heaterPower / 3, 0, 1),
    spray: bounded(values.sprayFlow === null ? null : values.sprayFlow / 30, 0, 1),
  };
  if (!available) for (const key of Object.keys(activity)) activity[key] = 0;
  return { mode, available, time, halted, tripped: coupled ? o.reactorTripped === 1 : !native && s.tripped === true,
    gridConnected: coupled ? o.gridConnected === 1 : !native && s.gridConnected === true, values, activity,
    levels: {
      pressurizer: available && values.pressurizerLevel !== null ? bounded(values.pressurizerLevel / 100, 0, 1) : null,
      steam: available && values.steamLevel !== null ? bounded(values.steamLevel / 100, 0, 1) : null,
      auxTank: available && values.auxTankLevel !== null ? bounded(values.auxTankLevel / 100, 0, 1) : null,
    } };
}

// Bounded visual phase, deliberately not physical shaft revolutions or fluid
// velocity. Wall-clock gaps cannot advance either the model or visual phase.
export function advanceVisualPhase(phase, rate, seconds) {
  const elapsed = bounded(number(seconds), 0, 0.1);
  const next = (number(phase) ?? 0) + bounded(number(rate), -2, 2) * elapsed;
  return ((next % 1) + 1) % 1;
}

export function visualMotionAllowed(state, { paused = false, hidden = false, animate = true, reducedMotion = false } = {}) {
  return Boolean(state?.available && !state.halted && !paused && !hidden && animate && !reducedMotion);
}
