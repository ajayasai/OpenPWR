// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {continuousMeasuredSources,continuousMeasuredProtocolSha256,continuousMeasuredDataSha256,
  verifyContinuousMeasuredReport,verifyContinuousMeasuredEvidence} from '../scripts/continuous-measured-evidence.mjs';

const root=resolve(import.meta.dirname,'..');
const read=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const protocol=await read('validation/continuous_measured/protocol.json');
const parameters=await read('validation/continuous_measured/parameters.json');
const provenance=await read('validation/krsko2005/provenance.json');
const sourceLedger=await read('validation/krsko2005/reference-plant.json');
const sourceCoverage=await read('validation/continuous_measured/source-coverage.json');
const lines=(await readFile(join(root,'validation/krsko2005/measured.csv'),'utf8')).trim().split(/\r?\n/);
const header=lines.shift().split(',');
const rows=lines.map(line=>Object.fromEntries(line.split(',').map((value,index)=>[header[index],Number(value)])));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixedControls={heaterPowerMW:0,chargingFlowKgS:0,letdownFlowKgS:0};
const inputNames=['reactorPowerMW','steamFlowKgS','feedwaterFlowKgS'];
const channelSpecs=[['primaryPressureMPa','Primary pressure','MPa',15.48],['hotLegTemperatureC','Mean hot-leg temperature','°C',321.025],
  ['coldLegTemperatureC','Mean cold-leg temperature','°C',286.295],['steamPressureMPa','Mean secondary pressure','MPa',6.41]];
function interpolate(time,key){
  const index=Math.min(rows.length-2,Math.floor((time+49)/2)),a=rows[index],b=rows[index+1];
  return a[key]+(time-a.time)/(b.time-a.time)*(b[key]-a[key]);
}
const heldAt=time=>({...Object.fromEntries(inputNames.map(key=>[key,interpolate(time,key)])),...fixedControls});
const primitives={pumpHeatInputMW:6,shutdownCoolingMW:0,feedwaterEnthalpyJkg:1e6,steamEnthalpyJkg:2.8e6,
  chargingEnthalpyJkg:2e5,coldLegEnthalpyJkg:1.3e6,pressurizerVentPowerW:0,secondaryVentPowerW:0,
  pressurizerSteamVentKgS:0,pressurizerGasVentKgS:0,secondarySteamVentKgS:0,secondaryGasVentKgS:0};
const primitivePoint=time=>({time,...primitives});
const sourceParameters=()=>Object.fromEntries(parameters.parameters.map(item=>[item.parameter,item.value]));

// Synthetic conservation/packaging fixture, deliberately not a physical
// simulation. Real immutable measurements exercise independent scoring.
function fixture(){
  const binary=Buffer.from('synthetic measured publication fixture; not an FMU');
  const manifest={version:'fixture',gitRevision:'fixture-revision',model:'KrskoContinuousThermal',fmuSha256:sha(binary)};
  const runtime={model:manifest.model,fmuSha256:manifest.fmuSha256};
  const run=(step,scale)=>{
    const points=[],boundaryQuadrature=[];let mass=0,energy=0;
    const save=time=>points.push({time,...Object.fromEntries(channelSpecs.map(([key,,,value])=>[key,value])),...primitives,
      thermalEnergyMJ:1e5+energy,totalMassKg:1e6+mass,boundaryMassFlowKgS:0,boundaryPowerMW:0,
      energyResidualMW:0,massResidualKgS:0,integratedBoundaryEnergyMJ:energy,integratedBoundaryMassKg:mass,
      actualHeaterPowerMW:0,actualChargingFlowKgS:0,actualLetdownFlowKgS:0,pressurizerGasMassKg:0,
      secondaryGasMassKg:0,pressurizerTemperatureC:345,pressurizerLevelPercent:52.95,primarySubcoolingK:20,
      secondaryTemperatureC:280,secondaryLevelPercent:50,
      fuelTemperatureC:600,heatToSteamMW:1839,primaryFlowKgS:9000});
    save(0);
    for(let index=0;index<15/step;index++){
      const start=index/(1/step),end=(index+1)/(1/step),delta=end-start,held=heldAt(start);
      boundaryQuadrature.push({held,start:primitivePoint(start),end:primitivePoint(end)});
      mass+=delta*(held.feedwaterFlowKgS-held.steamFlowKgS);
      energy+=delta*(held.reactorPowerMW+6+held.feedwaterFlowKgS-2.8*held.steamFlowKgS);
      if(Number.isInteger(end))save(end);
    }
    const result={completed:true,status:'completed',stepSeconds:step,geometryScale:scale,parameters:{...sourceParameters(),geometryScale:scale},
      runtime:{...runtime},solverRelativeTolerance:1e-11,requestedSolverRelativeTolerance:1e-11,steps:boundaryQuadrature.length,
      points,boundaryQuadrature,integrals:{massKg:mass,energyMJ:energy}};
    result.massIntegralErrorKg=points.at(-1).totalMassKg-points[0].totalMassKg-mass;
    result.energyIntegralErrorMJ=points.at(-1).thermalEnergyMJ-points[0].thermalEnergyMJ-energy;
    result.nativeMassIntegralErrorKg=result.massIntegralErrorKg;result.nativeEnergyIntegralErrorMJ=result.energyIntegralErrorMJ;
    return result;
  };
  const primaryRun=run(.05,1),refinedRun=run(.025,1),sensitivity=[run(.05,.5),run(.05,2)];
  const times=[0,1,3,5,7,9,11,13,15];
  const channels=channelSpecs.map(([key,name,unit,simulated])=>{
    const points=times.map(time=>({time,measured:interpolate(time,key),simulated,refined:simulated}));
    const errors=points.slice(1).map(point=>simulated-point.measured);
    const squareMean=values=>Math.sqrt(values.reduce((total,x)=>total+x*x,0)/values.length);
    return {key,name,unit,points,metrics:{samples:8,rmse:squareMean(errors),maximumAbsoluteError:Math.max(...errors.map(Math.abs)),
      meanError:errors.reduce((sum,x)=>sum+x,0)/8,initialBias:simulated-points[0].measured,finalError:errors.at(-1),
      changeRmse:squareMean(points.slice(1).map(point=>points[0].measured-point.measured)),maximumStepRefinementDifference:0,
      maximumGeometrySensitivitySpread:0,maximumReferenceTimingAllowance:Math.max(...times.slice(1).flatMap(time=>
        [Math.abs(interpolate(time-1,key)-interpolate(time,key)),Math.abs(interpolate(time+1,key)-interpolate(time,key))]))}};
  });
  const numericalChecks=[];
  for(const [name,record]of [['nominal',primaryRun],['refined',refinedRun],['geometry 0.5',sensitivity[0]],['geometry 2',sensitivity[1]]])
    for(const key of ['massIntegralErrorKg','energyIntegralErrorMJ'])numericalChecks.push({name:`${name} ${key}`,value:record[key],absoluteTolerance:protocol.numericalLimits[key],pass:true});
  for(const channel of channels)numericalChecks.push({name:`${channel.name} communication refinement`,value:0,
    absoluteTolerance:protocol.numericalLimits[channel.unit==='MPa'?'pressureRefinementMPa':'temperatureRefinementK'],pass:true});
  const report={...manifest,buildManifest:{...manifest},runtime,protocolSha256:continuousMeasuredProtocolSha256,inputDataSha256:continuousMeasuredDataSha256,
    schema:'openpwr-continuous-measured-v1',executed:true,status:'inconclusive',validationPassed:false,physicalValidationPassed:false,
    caseId:protocol.caseId,comparisonWindowS:[0,15],protocol,scope:'Hot-initialized boundary replay of ContinuousPlant.thermal (ColdStartPlant), not a run of the continuous cold-start trajectory. Measured core heat and secondary flows exclude kinetics and turbine/generator/controller validation.',
    conclusion:'The shared production thermal kernel was compared with measured operating-plant data. Missing event-era inputs and model limitations prevent physical acceptance; all discrepancies remain visible.',
    productionKernel:{class:'ColdStartPlant',composition:'ContinuousPlant.thermal',sameClass:true,sameWholePlantExecutable:false,excludedSubsystems:protocol.excludedClaims},
    numericalEvidence:{physicalAcceptanceBand:null,stepsComparedS:[.05,.025],metricSampleTimesS:times.slice(1),geometrySensitivityScales:[.5,1,2],
      initialPoint:protocol.initialPointPolicy,sensitivityPolicy:protocol.domainStopPolicy},parameterSources:parameters,appliedSourceParameters:sourceParameters(),
    fixedControlAssumptions:fixedControls,primaryRun,refinedRun,sensitivity,trace:primaryRun.points,channels,numericalChecks,
    numericalPassed:true,sensitivityCoverageComplete:true,metadata:provenance,sourceLedger,sourceCoverage,source:provenance.source,sourceURL:provenance.source.url,
    inputs:inputNames.map(name=>({name,points:Array.from({length:16},(_,time)=>({time,value:interpolate(time,name)}))}))};
  return {binary,manifest,report};
}
const verify=f=>verifyContinuousMeasuredReport(f.report,f.manifest,protocol,rows,parameters);

test('measured publication recomputes forcing, integrals and held-out scores',()=>{
  const f=fixture();assert.equal(verify(f),f.report);
  const mutations=[
    ['forged aggregate pass',r=>r.numericalChecks[0].value=1],
    ['forged permissive tolerance',r=>r.numericalChecks[0].absoluteTolerance=100],
    ['missing check',r=>r.numericalChecks.pop()],
    ['truncated nominal trace',r=>r.primaryRun.points.pop()],
    ['truncated refined trace',r=>r.refinedRun.points.pop()],
    ['missing sensitivity',r=>r.sensitivity.pop()],
    ['sensitivity secretly omitted',r=>{r.sensitivity[0]={completed:false,geometryScale:.5,stepSeconds:.05};}],
    ['missing primitive history',r=>delete r.primaryRun.boundaryQuadrature],
    ['quadrature gap',r=>r.primaryRun.boundaryQuadrature.splice(2,1)],
    ['changed forcing',r=>r.primaryRun.boundaryQuadrature[2].held.steamFlowKgS+=10],
    ['hidden control input',r=>r.primaryRun.boundaryQuadrature[2].held.heaterPowerMW=1],
    ['unrecorded native state reset',r=>r.primaryRun.boundaryQuadrature[2].start.steamEnthalpyJkg+=1],
    ['forged stored integral',r=>r.primaryRun.integrals.energyMJ+=1],
    ['forged inventory',r=>r.primaryRun.points.at(-1).totalMassKg+=1],
    ['native ledger drift',r=>r.primaryRun.points[3].integratedBoundaryEnergyMJ+=1],
    ['completed state outside pressure domain',r=>r.primaryRun.points[3].primaryPressureMPa=18],
    ['completed state outside secondary temperature domain',r=>r.primaryRun.points[3].secondaryTemperatureC=350],
    ['completed state outside secondary level domain',r=>r.primaryRun.points[3].secondaryLevelPercent=97],
    ['changed scored measurement',r=>r.channels[0].points[1].measured+=.1],
    ['changed scored prediction',r=>r.channels[0].points[1].simulated+=.1],
    ['fabricated RMSE',r=>r.channels[0].metrics.rmse=0],
    ['missing initial bias',r=>delete r.channels[0].metrics.initialBias],
    ['missing held-out channel',r=>r.channels.pop()],
    ['wrong displayed inputs',r=>r.inputs[0].points[2].value+=1],
    ['altered parameter',r=>r.primaryRun.parameters.initialPressurePa+=1],
    ['foreign native binary',r=>r.refinedRun.runtime.fmuSha256='foreign'],
    ['unreported failed coverage',r=>r.sensitivityCoverageComplete=false],
    ['physical pass',r=>r.physicalValidationPassed=true],
    ['full-plant executable claim',r=>r.productionKernel.sameWholePlantExecutable=true],
    ['excluded scope omitted',r=>r.productionKernel.excludedSubsystems=[]],
    ['invented physical band',r=>r.numericalEvidence.physicalAcceptanceBand=1],
    ['promotional overclaim',r=>r.conclusion='The continuous startup is plant validated.'],
  ];
  for(const [label,mutate]of mutations){const candidate=structuredClone(f);mutate(candidate.report);assert.throws(()=>verify(candidate),undefined,label);}
  const changedRows=structuredClone(rows);changedRows[26].primaryPressureMPa+=.01;
  assert.throws(()=>verifyContinuousMeasuredReport(f.report,f.manifest,protocol,changedRows,parameters),/measured acquisition/);
  const changedProtocol=structuredClone(protocol);changedProtocol.numericalLimits.energyIntegralErrorMJ=100;
  const changedReport=structuredClone(f.report);changedReport.protocol=changedProtocol;
  assert.throws(()=>verifyContinuousMeasuredReport(changedReport,f.manifest,changedProtocol,rows,parameters),/protocol/);
});

test('finite sensitivity domain exits remain visible without becoming passes',()=>{
  const f=fixture(),original=f.report.sensitivity[0],terminal=structuredClone(original.points[5]);
  terminal.primarySubcoolingK=3;
  f.report.sensitivity[0]={completed:false,status:'failed-domain',failureKind:'NativeDomainExit',geometryScale:.5,stepSeconds:.05,
    domainStop:'Domain exit at 5 s',terminalObservation:terminal,runtime:original.runtime,parameters:original.parameters,
    solverRelativeTolerance:1e-11,requestedSolverRelativeTolerance:1e-11,domainViolations:['primarySubcoolingK']};
  f.report.sensitivityCoverageComplete=false;
  f.report.numericalChecks=f.report.numericalChecks.filter(check=>!check.name.startsWith('geometry 0.5'));
  for(const channel of f.report.channels)channel.metrics.maximumGeometrySensitivitySpread=null;
  assert.equal(verify(f),f.report);
  const missing=structuredClone(f);delete missing.report.sensitivity[0].terminalObservation.primaryPressureMPa;
  assert.throws(()=>verify(missing),/terminal observation/);
  const spread=structuredClone(f);spread.report.channels[0].metrics.maximumGeometrySensitivitySpread=0;
  assert.throws(()=>verify(spread),/maximumGeometrySensitivitySpread/);
  const claimed=structuredClone(f);claimed.report.sensitivityCoverageComplete=true;
  assert.throws(()=>verify(claimed),/coverage/);
  const falseExit=structuredClone(f);falseExit.report.sensitivity[0].terminalObservation=structuredClone(original.points[0]);
  falseExit.report.sensitivity[0].domainStop='Fabricated domain exit at t=0';
  assert.throws(()=>verify(falseExit),/no violated production predicate/);
  const misclassified=structuredClone(f);misclassified.report.sensitivity[0].domainViolations=['secondaryLevelPercent'];
  assert.throws(()=>verify(misclassified),/domain predicates/);
  for(const [label,change]of [['unidentified executable',run=>delete run.runtime],['wrong failed executable',run=>run.runtime.fmuSha256='wrong'],
    ['altered failed parameters',run=>run.parameters.pumpHeatMW=100],['unclassified failure',run=>run.failureKind='RuntimeError']]){
    const changed=structuredClone(f);change(changed.report.sensitivity[0]);assert.throws(()=>verify(changed),undefined,label);
  }
  const mandatory=structuredClone(f);mandatory.report.primaryRun=structuredClone(mandatory.report.sensitivity[0]);
  mandatory.report.primaryRun.geometryScale=1;mandatory.report.primaryRun.parameters.geometryScale=1;
  assert.throws(()=>verify(mandatory),/mandatory run failed/);
});

test('each production domain predicate is independently enforced on completed observations',()=>{
  const f=fixture();
  const violations={primaryPressureMPa:.09,hotLegTemperatureC:350,coldLegTemperatureC:340,fuelTemperatureC:1200,
    primarySubcoolingK:3,primaryFlowKgS:16001,pressurizerTemperatureC:350,pressurizerLevelPercent:3,
    pressurizerGasMassKg:-1e-7,steamPressureMPa:18,secondaryTemperatureC:350,secondaryLevelPercent:97,secondaryGasMassKg:-1e-7};
  for(const [key,value]of Object.entries(violations)){
    const candidate=structuredClone(f);candidate.report.primaryRun.points[4][key]=value;
    assert.throws(()=>verify(candidate),/completed native state leaves the production domain/,key);
  }
});

test('measured publication binds current executable and every source artifact',async t=>{
  const prefix=join(tmpdir(),'openpwr-continuous-measured-evidence-'),workspace=await mkdtemp(prefix);
  t.after(async()=>{assert.ok(resolve(workspace).startsWith(resolve(prefix)));await rm(workspace,{recursive:true,force:true});});
  const put=async(path,bytes)=>{await mkdir(dirname(join(workspace,path)),{recursive:true});await writeFile(join(workspace,path),bytes);};
  const f=fixture();
  for(const [key,path]of Object.entries(continuousMeasuredSources)){
    const bytes=await readFile(join(root,path));await put(path,bytes);f.manifest[key]=sha(bytes);f.report[key]=sha(bytes);
  }
  f.report.buildManifest={...f.manifest};
  await put('artifacts/modelica/KrskoContinuousThermal.fmu',f.binary);
  await put('artifacts/modelica/continuous-measured-manifest.json',JSON.stringify(f.manifest));
  await put('artifacts/continuous-measured-validation.json',JSON.stringify(f.report));
  const check=()=>verifyContinuousMeasuredEvidence({root:workspace,version:f.manifest.version,revision:f.manifest.gitRevision});
  await check();
  for(const path of ['artifacts/modelica/KrskoContinuousThermal.fmu',...Object.values(continuousMeasuredSources)]){
    const original=await readFile(join(workspace,path));await put(path,Buffer.concat([original,Buffer.from('changed')]));
    await assert.rejects(check(),undefined,path);await put(path,original);
  }
  await assert.rejects(verifyContinuousMeasuredEvidence({root:workspace,version:'other',revision:f.manifest.gitRevision}));
  await assert.rejects(verifyContinuousMeasuredEvidence({root:workspace,version:f.manifest.version,revision:'other'}));
  const altered=structuredClone(f.report);altered.sourceCoverage.plantValidationPassed=true;
  await put('artifacts/continuous-measured-validation.json',JSON.stringify(altered));
  await assert.rejects(check(),/sourceCoverage/);
});
