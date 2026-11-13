// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MODEL,PROFILE,controls,outputs,validateState,validateHealth,validateEvidence,operatingState,synchronization,motion,formatReading} from '../src/continuous-state.js';

const sample=()=>({backend:'fmi2',model:MODEL,profile:PROFILE,time:0,halted:false,
  controls:Object.fromEntries(controls.map(c=>[c.key,c.min])),
  outputs:{...Object.fromEntries(outputs.map(k=>[k,0])),valid:true,hotLegTemperatureC:40,pumpSpeed:.8}});
const health=()=>({available:true,backend:'fmi2',model:MODEL,profile:PROFILE,fmuSha256:'a'.repeat(64),stepSize:.5,
  maxStepSeconds:120,realOutputs:outputs,controlLimits:Object.fromEntries(controls.map(c=>[c.key,[c.min,c.max]]))});

test('continuous UI requires the actual continuous native model and complete physical observations',()=>{
  assert.equal(validateState(sample()).model,MODEL);
  for(const model of ['ColdStartPlant','OpenPWR.CoupledPlant','javascript'])assert.throws(()=>validateState({...sample(),model}));
  for(const key of ['neutronPowerFraction','phaseDifferenceDeg','gridConnected','fullPowerReady','governorValveFraction','stopValveFraction']){
    const state=sample();delete state.outputs[key];assert.throws(()=>validateState(state));
  }
  for(const value of [NaN,Infinity]){const state=sample();state.outputs.primaryPressureMPa=value;assert.throws(()=>validateState(state));}
});
test('continuous display rejects incompatible native controls and nonbinary permissives',()=>{
  const state=sample();state.controls.gridBreakerCommand=.5;assert.throws(()=>validateState(state));
  state.controls.gridBreakerCommand=1;state.outputs.syncPermissive=.5;assert.throws(()=>validateState(state));
  state.outputs.syncPermissive=0;state.controls.rodDemandPcm=8001;assert.throws(()=>validateState(state));
  state.controls.rodDemandPcm=0;assert.equal(validateState(state),state);
});
test('connection checks executable identity, synchronization step grid and exact control limits',()=>{
  assert.equal(validateHealth(health()).profile,PROFILE);
  for(const stepSize of [0,1,5,NaN])assert.throws(()=>validateHealth({...health(),stepSize}));
  assert.throws(()=>validateHealth({...health(),fmuSha256:'not-a-hash'}));
  assert.throws(()=>validateHealth({...health(),maxStepSeconds:1000}));
  const h=health();h.controlLimits.reactorDemandPercent=[0,105];assert.throws(()=>validateHealth(h));
});
test('displayed evidence belongs to this numerical model and does not claim plant validation',()=>{
  const report={runtime:{model:MODEL,fmuSha256:'a'.repeat(64)},physicalValidationPassed:false,
    checks:[{name:'Example numerical check',pass:true}],total:1,passed:1};
  assert.equal(validateEvidence(report),report);
  assert.throws(()=>validateEvidence({...report,runtime:{...report.runtime,model:'ColdStartPlant'}}));
  assert.throws(()=>validateEvidence({...report,physicalValidationPassed:true}));
  assert.throws(()=>validateEvidence({...report,passed:2}));
  const failed={...report,checks:[{name:'Example numerical check',pass:false}],passed:0};
  assert.equal(validateEvidence(failed).passed,0);
});
test('full-power presentation follows the native readiness flag rather than a guessed power threshold',()=>{
  const state=sample();state.outputs.gridConnected=1;state.outputs.netPowerMW=1000;state.outputs.reactorPowerMW=3000;
  assert.equal(operatingState(state).stage,3);
  state.outputs.fullPowerReady=1;assert.equal(operatingState(state).stage,4);
  state.outputs.reactorTripped=1;assert.equal(operatingState(state).label,'Reactor trip latched');
  state.halted=true;assert.equal(operatingState(state).label,'Model domain boundary');
});
test('synchronization display never substitutes UI thresholds or a close request for the native breaker',()=>{
  const state=sample();state.controls.gridBreakerCommand=1;
  Object.assign(state.outputs,{turbineRpm:3000,phaseDifferenceDeg:0,frequencyDifferenceHz:0,generatorVoltagePu:1});
  assert.equal(synchronization(state).label,'Not synchronized');
  state.outputs.syncPermissive=1;assert.equal(synchronization(state).label,'Ready to connect');
  state.outputs.gridConnected=1;state.outputs.syncPermissive=0;
  assert.equal(synchronization(state).label,'Grid connected');
  assert.equal(synchronization(state).permitted,'No close request needed');
});
test('equipment motion follows observed native flows and freezes without altering observations',()=>{
  const state=sample();Object.assign(state.outputs,{turbineRpm:1500,primaryFlowKgS:7500,turbineFlowKgS:750,
    feedwaterFlowKgS:750,coolingPowerMW:1000,netPowerMW:500,gridConnected:1});
  assert.deepEqual(motion(state,true),{pump:.8,turbine:.5,primary:.5,steam:.5,feed:.5,cooling:.5,electrical:.5});
  const copy=structuredClone(state);
  for(const rates of [motion(state,false),motion(state,true,true),motion({...state,halted:true},true)])assert.ok(Object.values(rates).every(v=>v===0));
  assert.deepEqual(state,copy);
  state.outputs.gridConnected=0;assert.equal(motion(state,true).electrical,0);
});
test('source-range physical values remain visible rather than rounding to zero',()=>{
  assert.equal(formatReading(1e-9,1,'power'),'1.00e-9');
  assert.equal(formatReading(1e-12,1,'scientific'),'1.00e-12');
  assert.equal(formatReading(-12,1,'power'),'-12.0');
  assert.equal(formatReading(NaN),'—');
});
test('every visible physical reading has a required native contract field',()=>{
  const html=readFileSync(new URL('../continuous.html',import.meta.url),'utf8');
  const readings=[...html.matchAll(/data-reading="([^"]+)"/g)].map(m=>m[1]);
  for(const key of readings)assert.ok(outputs.includes(key),`${key} is not validated before rendering`);
  assert.match(html,/http:\/\/127\.0\.0\.1:8004\/continuous\.html/);
  assert.match(html,/does not establish measured whole-plant validation/);
});
