// SPDX-License-Identifier: Apache-2.0
// Display contract only. All physical observations come from the native FMU.
export const MODEL = 'ColdStartPlant';
export const controls = [
  {key:'pumpCommand', label:'Primary pump', min:0, max:1, step:.05, unit:'%', scale:100, digits:0},
  {key:'startupHeatMW', label:'Prescribed startup heat', min:0, max:90, step:1, unit:'MW', digits:0},
  {key:'shutdownCoolingFraction', label:'Shutdown cooling', min:0, max:1, step:.05, unit:'%', scale:100, digits:0},
  {key:'heaterPowerMW', label:'Pressurizer heater', min:0, max:3, step:.1, unit:'MW', digits:1},
  {key:'ventFraction', label:'Pressurizer vent', min:0, max:1, step:.05, unit:'%', scale:100, digits:0},
  {key:'pressureTargetMPa', label:'Pressure target', min:.2, max:15.5, step:.1, unit:'MPa', digits:1},
  {key:'pressureControlEnable', label:'Automatic pressure control', min:0, max:1, discrete:true},
  {key:'inventoryControlEnable', label:'Automatic inventory control', min:0, max:1, discrete:true},
  {key:'chargingFlowKgS', label:'Manual charging', min:0, max:10, step:.5, unit:'kg/s', digits:1},
  {key:'letdownFlowKgS', label:'Manual letdown', min:0, max:20, step:.5, unit:'kg/s', digits:1},
];
export const outputs = ['hotLegTemperatureC','coldLegTemperatureC','fuelTemperatureC','primaryPressureMPa',
  'pressurizerTemperatureC','pressurizerLevelPercent','primaryFlowKgS','pumpSpeed','pumpHeatMW','reactorPowerMW',
  'heatToSteamMW','shutdownCoolingMW','secondaryTemperatureC','secondaryPressureMPa','secondaryLevelPercent',
  'secondaryMassKg','pressurizerGasMassKg','pressurizerVaporMassKg','ventSteamFlowKgS','ventGasFlowKgS',
  'actualHeaterPowerMW','actualLetdownFlowKgS','actualChargingFlowKgS','primarySubcoolingK',
  'totalPlantStoredEnergyMJ','totalPlantMassKg','plantBoundaryPowerMW','plantBoundaryMassFlowKgS',
  'integratedPlantBoundaryEnergyMJ','integratedPlantBoundaryMassKg','plantEnergyResidualMW','plantMassResidualKgS','hotStandbyReady',
  'secondaryGasMassKg','secondarySteamVentKgS','secondaryGasVentKgS','surgeFlowKgS','primaryMassKg',
  'coldLegEnthalpyJkg','chargingEnthalpyJkg','pressurizerSteamEnthalpyJkg','secondarySteamEnthalpyJkg','secondaryVaporMassKg'];
export const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
export function validateState(state) {
  if (!state || state.backend !== 'fmi2' || state.model !== MODEL || state.profile !== 'cold'
      || !Number.isFinite(state.time) || state.time < 0 || typeof state.halted !== 'boolean'
      || typeof state.outputs?.valid !== 'boolean' || outputs.some(key=>!Number.isFinite(state.outputs[key]))
      || controls.some(({key,min,max,discrete}) => !Number.isFinite(state.controls?.[key])
        || state.controls[key] < min || state.controls[key] > max || (discrete && ![0,1].includes(state.controls[key])))
      || ![0,1].includes(state.outputs.hotStandbyReady)) throw new Error('Incomplete or incompatible native cold-start state.');
  return state;
}
export function validateHealth(health) {
  if (!health?.available || health.backend !== 'fmi2' || health.model !== MODEL || health.profile !== 'cold'
      || !validHash(health.fmuSha256) || ![.25,.5,2.5,5].includes(health.stepSize)
      || health.maxStepSeconds !== 120 || outputs.some(key=>!health.realOutputs?.includes(key))
      || controls.some(({key,min,max})=>health.controlLimits?.[key]?.[0] !== min || health.controlLimits[key][1] !== max)) {
    throw new Error('This page requires the native cold-start service on port 8003.');
  }
  return health;
}
export function motion(state, running, reducedMotion=false) {
  return state && running && state.outputs.valid && !state.halted && !reducedMotion
    ? Math.max(0, Math.min(1, state.outputs.pumpSpeed)) : 0;
}
export function milestone(state) {
  if (!state) return 'Awaiting native model';
  if (state.halted || !state.outputs.valid) return 'Model domain boundary';
  if (state.outputs.hotStandbyReady === 1) return 'Hot standby conditions reached';
  return state.outputs.hotLegTemperatureC < 100 ? 'Cold primary system' : 'Heatup in progress';
}
