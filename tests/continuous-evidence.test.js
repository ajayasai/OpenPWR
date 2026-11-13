// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {continuousSources,verifyContinuousReport,verifyContinuousEvidence} from '../scripts/continuous-evidence.mjs';

const protocol=JSON.parse(await readFile(new URL('../validation/continuous/protocol.json',import.meta.url)));
const reference=JSON.parse(await readFile(new URL('../validation/continuous/kinetics-reference.json',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// Deliberately synthetic packaging fixture, not physical evidence. Mutations
// below ensure that passing flags cannot replace trajectory acceptance.
function fixture() {
  const binary=Buffer.from('packaging fixture only');
  const manifest={version:'fixture',gitRevision:'fixture-revision',model:'ContinuousPlant',fmuSha256:sha(binary)};
  const runtime={model:manifest.model,fmuSha256:manifest.fmuSha256};
  const point=time=>({time,coldLegTemperatureC:40,hotLegTemperatureC:40,fuelTemperatureC:40,
    pressurizerTemperatureC:40,secondaryTemperatureC:40,primaryPressureMPa:.3,secondaryPressureMPa:.1,
    reactivityPcm:time===0?-2000:0,neutronPowerFraction:time===0?1e-8:1,gridConnected:time===0?0:1,
    turbineRpm:time===0?0:3000,rotorEnergyMJ:time===0?0:4200,netPowerMW:time===0?-2:1000,
    totalPlantStoredEnergyMJ:100,totalPlantMassKg:200,integratedPlantBoundaryEnergyMJ:0,
    integratedPlantBoundaryMassKg:0,plantEnergyResidualMW:0,plantMassResidualKgS:0,primarySubcoolingK:10,
    externalSourceFractionPerSecond:0,fullPowerReady:time===0?0:1,reactorTripped:0,turbineTripped:0,decayHeatMW:10,stopValveFraction:1,
    breakerClosingTimeS:5,breakerClosingPhaseDeg:0,breakerClosingFrequencyHz:0,
    breakerClosingVoltagePu:1,breakerClosingDwellS:5});
  const scenario=(id,duration=10,interval=1)=>({id,name:id,complete:true,runtime,parameters:{},
    durationSeconds:duration,stepSeconds:.05,sampleIntervalSeconds:interval,
    trace:Array.from({length:Math.round(duration/interval)+1},(_,i)=>point(i*interval))});
  const scenarios=[...protocol.kinetics.requiredCases,'source-removal',...protocol.synchronization.requiredCases].map(id=>scenario(id));
  for(const s of scenarios.filter(s=>s.id.startsWith('sync-reject'))) for(const p of s.trace)p.gridConnected=0;
  const stop=scenario('trip-stop-valve',3,.05);stop.controlSchedule=[{time:1,controls:{turbineTripCommand:1}}];
  for(const p of stop.trace)p.stopValveFraction=Math.exp(-Math.max(0,p.time-1)/.2);scenarios.push(stop);
  for(const c of reference.cases){
    const s=scenario(c.id,200,.1);s.parameters={initialNeutronFraction:reference.initialNeutronFraction,
      generationTimeSeconds:reference.generationTimeSeconds,initialRodReactivityPcm:c.reactivityPcm,thermalFeedbackScale:0};
    for(let i=0;i<6;i++){s.parameters[`beta[${i+1}]`]=reference.delayedFractions[i];s.parameters[`lambda[${i+1}]`]=reference.decayConstantsPerSecond[i];}
    for(const [time,value] of c.samples)s.trace[Math.round(time/.1)].neutronPowerFraction=value*reference.initialNeutronFraction;
    scenarios.push(s);
  }
  for(const [id,step] of [['full-startup',.5],['full-startup-refined',.25],['startup-trip',.5]]){
    const s=scenario(id,id==='startup-trip'?930:900,30);Object.assign(s,{stepSeconds:step,singleFmuInstance:true,resetCount:0,
      controlSchedule:[{time:0,controls:{pumpCommand:1}}],boundaryQuadrature:{externalEnergyMJ:0,externalMassKg:0}});
    if(id==='startup-trip'){Object.assign(s.trace.at(-1),{reactorTripped:1,turbineTripped:1,gridConnected:0,neutronPowerFraction:.001,stopValveFraction:0});s.controlSchedule.push({time:900,controls:{tripCommand:1}});}scenarios.push(s);
  }
  const checks=Array.from({length:12},(_,i)=>({name:`Published fixture ${i}`,category:'published-kinetics',value:0,absoluteTolerance:.001,pass:true}));
  const report={...manifest,buildManifest:{...manifest},runtime,physicalValidationPassed:false,
    operatingEnvelope:'Synthetic packaging fixture only',checks,passed:checks.length,total:checks.length,scenarios};
  return {binary,manifest,report};
}

test('continuous publication recomputes acceptance rather than trusting pass flags',()=>{
  const f=fixture();assert.equal(verifyContinuousReport(f.report,f.manifest,protocol,reference),f.report);
  const mutations=[
    ['forged numerical pass',r=>r.checks[0].value=.01],
    ['missing published benchmarks',r=>{r.checks[0].category='other';}],
    ['source-assisted benchmark',r=>r.scenarios.find(s=>s.id.startsWith('cats-')).trace[1].externalSourceFractionPerSecond=1],
    ['incorrect published value',r=>r.scenarios.find(s=>s.id.startsWith('cats-')).trace[1].neutronPowerFraction*=2],
    ['missing scenario',r=>r.scenarios=r.scenarios.filter(s=>s.id!=='source-removal')],
    ['truncated trajectory',r=>r.scenarios.find(s=>s.id==='full-startup').trace.pop()],
    ['warm preset',r=>r.scenarios.find(s=>s.id==='full-startup').trace[0].coldLegTemperatureC=280],
    ['state handoff',r=>r.scenarios.find(s=>s.id==='full-startup').resetCount=1],
    ['nominal preset parameter',r=>r.scenarios.find(s=>s.id==='full-startup').parameters.initialTemperatureK=560],
    ['inventory drift',r=>r.scenarios.find(s=>s.id==='full-startup').trace[2].totalPlantMassKg+=1],
    ['quadrature mismatch',r=>r.scenarios.find(s=>s.id==='full-startup').boundaryQuadrature.externalEnergyMJ=1001],
    ['shaft reset',r=>r.scenarios.find(s=>s.id==='full-startup').trace[2].rotorEnergyMJ=0],
    ['short full-power dwell',r=>r.scenarios.find(s=>s.id==='full-startup').trace.at(-2).netPowerMW=900],
    ['source-sustained plateau',r=>r.scenarios.find(s=>s.id==='full-startup').trace.at(-1).externalSourceFractionPerSecond=1e-6],
    ['phase rejection bypass',r=>r.scenarios.find(s=>s.id==='sync-reject-phase').trace.at(-1).gridConnected=1],
    ['unsafe native closure',r=>r.scenarios.find(s=>s.id==='full-startup').trace.at(-1).breakerClosingPhaseDeg=10],
    ['refinement failure',r=>r.scenarios.find(s=>s.id==='full-startup-refined').trace[1].hotLegTemperatureC+=.2],
    ['different refinement inputs',r=>r.scenarios.find(s=>s.id==='full-startup-refined').controlSchedule[0].controls.pumpCommand=0],
    ['trip never isolates steam',r=>r.scenarios.find(s=>s.id==='startup-trip').trace.at(-1).stopValveFraction=.1],
    ['trip without prior full power',r=>r.scenarios.find(s=>s.id==='startup-trip').trace.at(-2).fullPowerReady=0],
    ['trip erases decay heat',r=>r.scenarios.find(s=>s.id==='startup-trip').trace.at(-1).decayHeatMW=0],
    ['overclaimed physical validation',r=>r.physicalValidationPassed=true],
  ];
  for(const [label,mutate] of mutations){const r=structuredClone(f.report);mutate(r);assert.throws(()=>verifyContinuousReport(r,f.manifest,protocol,reference),undefined,label);}
});

test('continuous evidence binds executable bytes and every verification source',async t=>{
  const prefix=join(tmpdir(),'openpwr-continuous-evidence-'),root=await mkdtemp(prefix);
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(prefix)));await rm(root,{recursive:true,force:true});});
  const f=fixture();const put=async(path,data)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),data);};
  for(const [key,path]of Object.entries(continuousSources)){
    const bytes=path.endsWith('/protocol.json')?JSON.stringify(protocol):path.endsWith('/kinetics-reference.json')?JSON.stringify(reference):`fixture ${path}`;
    await put(path,bytes);f.manifest[key]=sha(bytes);
  }
  f.report.buildManifest={...f.manifest};
  await put('artifacts/modelica/ContinuousPlant.fmu',f.binary);
  await put('artifacts/modelica/continuous-manifest.json',JSON.stringify(f.manifest));
  await put('artifacts/continuous-verification.json',JSON.stringify(f.report));
  const verify=()=>verifyContinuousEvidence({root,version:f.manifest.version,revision:f.manifest.gitRevision});
  await verify();
  for(const path of ['artifacts/modelica/ContinuousPlant.fmu',...Object.values(continuousSources)]){
    const original=await readFile(join(root,path));await put(path,Buffer.concat([original,Buffer.from('changed')]));
    await assert.rejects(verify(),undefined,path);await put(path,original);
  }
  await assert.rejects(verifyContinuousEvidence({root,version:'other',revision:f.manifest.gitRevision}));
});
