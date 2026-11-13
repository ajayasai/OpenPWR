// SPDX-License-Identifier: Apache-2.0
// Presentation contract only: every physical value is returned by the native FMU.
import {controls as coldControls, validHash} from './cold-state.js';
export {validHash};
export const MODEL = 'ContinuousPlant';
export const PROFILE = 'continuous';
const toggled = (key,label,group,options=['Disabled','Enabled'],help='') => ({key,label,group,min:0,max:1,discrete:true,options,help});
export const controls = [
  toggled('automaticReactorEnable','Automatic reactor control','Reactor'),
  {key:'reactorDemandPercent',label:'Reactor demand',group:'Reactor',min:0,max:100,step:.01,unit:'%',digits:2,help:'The controller moves the native rod state. This demand does not impose neutron power.'},
  {key:'rodDemandPcm',label:'Manual rod demand',group:'Reactor',min:-6000,max:8000,step:1,unit:'pcm',digits:0,help:'Used with automatic reactor control disabled.'},
  {key:'reactivityBiasPcm',label:'Reactivity bias',group:'Reactor',min:-300,max:300,step:5,unit:'pcm',digits:0},
  toggled('sourceEnable','External neutron source','Reactor'),
  toggled('tripCommand','Reactor trip request','Reactor',['Released','Trip requested'],'The native trip latch is shown separately from this command.'),
  toggled('turbineEnable','Turbine admission','Turbine and grid'),
  {key:'speedDemandRpm',label:'Shaft speed demand',group:'Turbine and grid',min:0,max:3000,step:10,unit:'rpm',digits:0},
  {key:'loadDemandMW',label:'Electrical load demand',group:'Turbine and grid',min:0,max:1000,step:10,unit:'MWe',digits:0},
  toggled('automaticSyncEnable','Automatic synchronization','Turbine and grid'),
  {key:'excitationCommandPu',label:'Generator excitation',group:'Turbine and grid',min:0,max:1.1,step:.01,unit:'pu',digits:2},
  toggled('gridBreakerCommand','Breaker request','Turbine and grid',['Open requested','Close requested'],'Closing requires the native synchronization permissive. A request does not imply connection.'),
  toggled('turbineTripCommand','Turbine trip request','Turbine and grid',['Released','Trip requested']),
  {key:'feedwaterFraction',label:'Feedwater availability',group:'Thermal and inventory',min:0,max:1.2,step:.05,unit:'%',scale:100,digits:0},
  {key:'coolingFraction',label:'Condenser cooling',group:'Thermal and inventory',min:0,max:1.2,step:.05,unit:'%',scale:100,digits:0},
  ...coldControls.filter(c=>c.key!=='startupHeatMW').map(c=>({...c,group:'Thermal and inventory'})),
];
export const outputs = [
  'hotLegTemperatureC','coldLegTemperatureC','fuelTemperatureC','primaryPressureMPa','primarySubcoolingK',
  'pressurizerLevelPercent','secondaryPressureMPa','secondaryTemperatureC','secondaryLevelPercent',
  'primaryFlowKgS','pumpSpeed','reactorPowerMW','fissionPowerMW','neutronPowerFraction','reactivityPcm',
  'rodReactivityPcm','externalSourceFractionPerSecond','turbineRpm','turbineFlowKgS','turbineMechanicalPowerMW',
  'feedwaterFlowKgS','grossPowerMW','netPowerMW','gridConnected','phaseDifferenceDeg','generatorVoltagePu',
  'frequencyDifferenceHz','syncPermissive','rotorEnergyMJ','condenserPressureKPa','coolingPowerMW',
  'plantEnergyResidualMW','plantMassResidualKgS','totalPlantStoredEnergyMJ','totalPlantMassKg',
  'reactorTripped','turbineTripped','hotStandbyReady','fullPowerReady','loadReferenceMW','synchronizationDwellS',
  'breakerClosingTimeS','breakerClosingPhaseDeg','breakerClosingFrequencyHz','breakerClosingVoltagePu','breakerClosingDwellS',
  'governorValveFraction','stopValveFraction',
];
const nativeFlags = ['gridConnected','syncPermissive','reactorTripped','turbineTripped','hotStandbyReady','fullPowerReady'];
export function validateState(state) {
  if (!state || state.backend!=='fmi2' || state.model!==MODEL || state.profile!==PROFILE
      || !Number.isFinite(state.time) || state.time<0 || typeof state.halted!=='boolean'
      || typeof state.outputs?.valid!=='boolean' || outputs.some(key=>!Number.isFinite(state.outputs[key]))
      || nativeFlags.some(key=>![0,1].includes(state.outputs[key]))
      || controls.some(({key,min,max,discrete})=>!Number.isFinite(state.controls?.[key])
        || state.controls[key]<min || state.controls[key]>max || (discrete && ![0,1].includes(state.controls[key])))) {
    throw new Error('Incomplete or incompatible continuous native plant state.');
  }
  return state;
}
export function validateHealth(health) {
  if (!health?.available || health.backend!=='fmi2' || health.model!==MODEL || health.profile!==PROFILE
      || !validHash(health.fmuSha256) || ![.05,.1,.25,.5].includes(health.stepSize)
      || health.maxStepSeconds!==120
      || outputs.some(key=>!health.realOutputs?.includes(key))
      || controls.some(({key,min,max})=>health.controlLimits?.[key]?.[0]!==min || health.controlLimits[key][1]!==max)) {
    throw new Error('This page requires the continuous native plant service on port 8004.');
  }
  return health;
}
export function validateEvidence(report) {
  if (report?.runtime?.model!==MODEL || !validHash(report.runtime.fmuSha256)
      || report.physicalValidationPassed!==false || !Array.isArray(report.checks) || !report.checks.length
      || report.checks.some(c=>typeof c.name!=='string' || !c.name.trim() || typeof c.pass!=='boolean')
      || report.total!==report.checks.length || report.passed!==report.checks.filter(c=>c.pass===true).length) {
    throw new Error('Incomplete or incompatible continuous native verification report.');
  }
  return report;
}
export function operatingState(state) {
  if (!state) return {label:'Awaiting native model',stage:-1,tone:'neutral'};
  const o=state.outputs;
  if (state.halted || !o.valid) return {label:'Model domain boundary',stage:-1,tone:'halted'};
  if (o.reactorTripped) return {label:'Reactor trip latched',stage:-1,tone:'halted'};
  if (o.turbineTripped) return {label:'Turbine trip latched',stage:-1,tone:'halted'};
  if (o.fullPowerReady) return {label:'Full-power conditions reached',stage:4,tone:''};
  if (o.gridConnected) return {label:'Grid-connected generation',stage:3,tone:''};
  if (o.turbineRpm>1) return {label:o.syncPermissive?'Synchronization permitted':'Turbine runup',stage:2,tone:''};
  if (o.hotStandbyReady) return {label:'Hot standby reached',stage:1,tone:''};
  if (o.fissionPowerMW>=.1 || o.hotLegTemperatureC>=100) return {label:'Reactor heatup',stage:1,tone:''};
  return {label:'Source-range neutron response',stage:0,tone:'neutral'};
}
export function synchronization(state) {
  if (!state) return {label:'Awaiting model',permitted:'Unavailable',tone:'neutral',detail:'The native model evaluates speed, voltage and phase before connecting.'};
  const o=state.outputs;
  if (state.halted || !o.valid) return {label:'Model stopped',permitted:'Unavailable',tone:'halted',detail:'Reset or reconnect before requesting further native steps.'};
  if (o.gridConnected) return {label:'Grid connected',permitted:o.syncPermissive?'Satisfied':'No close request needed',tone:'',detail:'The native breaker is closed. Electrical output and shaft dynamics continue in the same model.'};
  if (o.turbineTripped || o.reactorTripped) return {label:'Trip latched',permitted:'Blocked',tone:'halted',detail:'The native protection latch prevents generator connection.'};
  return o.syncPermissive
    ? {label:'Ready to connect',permitted:'Satisfied',tone:'',detail:'The native speed, phase and voltage conditions permit closing. The breaker command remains a separate input.'}
    : {label:o.synchronizationDwellS>0?'Holding sync window':'Not synchronized',permitted:'Not satisfied',tone:'neutral',detail:'The breaker remains open until the native speed, phase, voltage and dwell conditions permit connection.'};
}
export function motion(state,running,reducedMotion=false) {
  const off={pump:0,turbine:0,primary:0,steam:0,feed:0,cooling:0,electrical:0};
  if (!state || !running || state.halted || !state.outputs.valid || reducedMotion) return off;
  const o=state.outputs, bounded=(x,scale)=>Math.max(0,Math.min(1,x/scale));
  return {pump:bounded(o.pumpSpeed,1),turbine:bounded(o.turbineRpm,3000),primary:bounded(Math.abs(o.primaryFlowKgS),15000),
    steam:bounded(o.turbineFlowKgS,1500),feed:bounded(o.feedwaterFlowKgS,1500),cooling:bounded(o.coolingPowerMW,2000),
    electrical:o.gridConnected?bounded(Math.max(0,o.netPowerMW),1000):0};
}
export function formatReading(value,digits=1,format='number') {
  if (!Number.isFinite(value)) return '—';
  if (format==='scientific' || (format==='power' && value!==0 && Math.abs(value)<.01)) return value.toExponential(2);
  return (Math.abs(value)<.5*10**-digits?0:value).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});
}
