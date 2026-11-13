// SPDX-License-Identifier: Apache-2.0
// Independent publication gate: measured discrepancies remain publishable,
// but passing flags never substitute for complete, reproducible observations.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const continuousMeasuredSources = {
  sourceSha256:'models/OpenPWR/package.mo', coldSourceSha256:'models/ColdStartPlant.mo',
  pressureSourceSha256:'models/FinitePhasePressurizer.mo',
  continuousSourceSha256:'models/ContinuousPlant.mo', benchmarkModelSha256:'models/KrskoContinuousThermal.mo',
  inputDataSha256:'validation/krsko2005/measured.csv', referenceMetadataSha256:'validation/krsko2005/provenance.json',
  sourceLedgerSha256:'validation/krsko2005/reference-plant.json', parameterSourcesSha256:'validation/continuous_measured/parameters.json',
  protocolSha256:'validation/continuous_measured/protocol.json', sourceCoverageSha256:'validation/continuous_measured/source-coverage.json',
  comparisonScriptSha256:'validation/continuous_measured/compare.py', sharedRunnerSha256:'validation/native_fmi.py',
  packagingScriptSha256:'scripts/modelica/package_fmu.py',
};
export const continuousMeasuredProtocolSha256='256a36d82cee86fc4d9c3c03e29c7b074489f1ff219c2ff6847e735908817309';
export const continuousMeasuredDataSha256='f2160bb33271b1b80774df8edee13d805a2b7abe24a6a7a4de356035001b0407';
const protocolContentSha256='3119380925e5d62bfca389951efe2ff7afd620283cc9c0b967b1eba040a0d54c';
const dataContentSha256='700b286f056fd399017977cb31c72fa45cffda3248fb4fb6426568dbfc063c42';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const require=(condition,message)=>{if(!condition)throw new Error(`Continuous measured comparison: ${message}`);};
const equal=(actual,expected,label)=>require(isDeepStrictEqual(actual,expected),`${label} differs`);
const close=(actual,expected,label,absolute=1e-9,relative=1e-11)=>require(Number.isFinite(actual)&&Number.isFinite(expected)
  && Math.abs(actual-expected)<=Math.max(absolute,relative*Math.max(Math.abs(actual),Math.abs(expected))),`${label} differs`);
const within=(value,limit,label)=>require(Number.isFinite(value)&&Math.abs(value)<=limit,`${label} exceeds frozen numerical limit`);
const finiteRecord=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(Number.isFinite);
const keys=(value,expected,label)=>equal(Object.keys(value??{}).sort(),[...expected].sort(),label);
const fixedControls={heaterPowerMW:0,chargingFlowKgS:0,letdownFlowKgS:0};
const inputs=['reactorPowerMW','steamFlowKgS','feedwaterFlowKgS'];
const channels=[['primaryPressureMPa','Primary pressure','MPa'],['hotLegTemperatureC','Mean hot-leg temperature','°C'],
  ['coldLegTemperatureC','Mean cold-leg temperature','°C'],['steamPressureMPa','Mean secondary pressure','MPa']];
const diagnostics=['thermalEnergyMJ','totalMassKg','boundaryMassFlowKgS','boundaryPowerMW','energyResidualMW','massResidualKgS',
  'integratedBoundaryEnergyMJ','integratedBoundaryMassKg','pumpHeatInputMW','actualHeaterPowerMW','actualChargingFlowKgS',
  'actualLetdownFlowKgS','shutdownCoolingMW','steamEnthalpyJkg','chargingEnthalpyJkg','coldLegEnthalpyJkg','feedwaterEnthalpyJkg',
  'pressurizerVentPowerW','secondaryVentPowerW','pressurizerSteamVentKgS','pressurizerGasVentKgS','secondarySteamVentKgS',
  'secondaryGasVentKgS','pressurizerGasMassKg','secondaryGasMassKg','pressurizerTemperatureC','pressurizerLevelPercent',
  'primarySubcoolingK','fuelTemperatureC','heatToSteamMW','primaryFlowKgS','secondaryTemperatureC','secondaryLevelPercent'];
const primitives=['pumpHeatInputMW','shutdownCoolingMW','feedwaterEnthalpyJkg','steamEnthalpyJkg','chargingEnthalpyJkg',
  'coldLegEnthalpyJkg','pressurizerVentPowerW','secondaryVentPowerW','pressurizerSteamVentKgS','pressurizerGasVentKgS',
  'secondarySteamVentKgS','secondaryGasVentKgS'];
const observationKeys=['time',...channels.map(([key])=>key),...diagnostics];
const scope='Hot-initialized boundary replay of ContinuousPlant.thermal (ColdStartPlant), not a run of the continuous cold-start trajectory. Measured core heat and secondary flows exclude kinetics and turbine/generator/controller validation.';
const conclusion='The shared production thermal kernel was compared with measured operating-plant data. Missing event-era inputs and model limitations prevent physical acceptance; all discrepancies remain visible.';

// These are the production ColdStartPlant/WaterGasVessel validity predicates
// under this wrapper's declared operating envelope, not fitted acceptance bands.
// The primary pressure interval also implies the pressurizer vessel's limits.
function domainViolations(point) {
  const predicates=[
    ['primaryPressureMPa',point.primaryPressureMPa>=.1&&point.primaryPressureMPa<17.5],
    ['hotLegTemperatureC',point.hotLegTemperatureC+273.15>=280&&point.hotLegTemperatureC+273.15<620],
    ['coldLegTemperatureC',point.coldLegTemperatureC+273.15>=280&&point.coldLegTemperatureC+273.15<610],
    ['fuelTemperatureC',point.fuelTemperatureC+273.15>=280&&point.fuelTemperatureC+273.15<1400],
    ['primarySubcoolingK',point.primarySubcoolingK>3],
    ['primaryFlowKgS',point.primaryFlowKgS>=-.1&&point.primaryFlowKgS<=16000],
    ['pressurizerTemperatureC',point.pressurizerTemperatureC+273.15>=280&&point.pressurizerTemperatureC+273.15<623.15],
    ['pressurizerLevelPercent',point.pressurizerLevelPercent>3&&point.pressurizerLevelPercent<97],
    ['pressurizerGasMassKg',point.pressurizerGasMassKg>=-1e-8],
    ['steamPressureMPa',point.steamPressureMPa>.002&&point.steamPressureMPa<18],
    ['secondaryTemperatureC',point.secondaryTemperatureC+273.15>=280&&point.secondaryTemperatureC+273.15<623.15],
    ['secondaryLevelPercent',point.secondaryLevelPercent>3&&point.secondaryLevelPercent<97],
    ['secondaryGasMassKg',point.secondaryGasMassKg>=-1e-8],
  ];
  return predicates.filter(([,valid])=>!valid).map(([key])=>key);
}

function requireInputDomain(held) {
  require(held.reactorPowerMW>=0&&held.reactorPowerMW<=3300&&held.steamFlowKgS>=-1e-8
    &&held.feedwaterFlowKgS>=-1e-8&&held.heaterPowerMW>=0&&held.heaterPowerMW<=3
    &&held.chargingFlowKgS>=0&&held.chargingFlowKgS<=10&&held.letdownFlowKgS>=0&&held.letdownFlowKgS<=20,
  'replay forcing leaves the production input domain');
}

function at(rows,time,key) {
  require(rows.length>=2&&time>=rows[0].time&&time<=rows.at(-1).time,'reference extrapolation is forbidden');
  for(let i=1;i<rows.length;i++)if(rows[i-1].time<=time&&time<=rows[i].time){
    const a=rows[i-1],b=rows[i];return a[key]+(time-a.time)/(b.time-a.time)*(b[key]-a[key]);
  }
  throw new Error('Continuous measured comparison: missing reference interval');
}
const boundaryMass=(held,p)=>held.feedwaterFlowKgS-held.steamFlowKgS+held.chargingFlowKgS-held.letdownFlowKgS
  -['pressurizerSteamVentKgS','pressurizerGasVentKgS','secondarySteamVentKgS','secondaryGasVentKgS'].reduce((sum,key)=>sum+p[key],0);
const boundaryEnergy=(held,p)=>held.reactorPowerMW+p.pumpHeatInputMW+held.heaterPowerMW-p.shutdownCoolingMW
  +(held.feedwaterFlowKgS*p.feedwaterEnthalpyJkg-held.steamFlowKgS*p.steamEnthalpyJkg
    +held.chargingFlowKgS*p.chargingEnthalpyJkg-held.letdownFlowKgS*p.coldLegEnthalpyJkg
    -p.pressurizerVentPowerW-p.secondaryVentPowerW)/1e6;

function quadrature(run,rows) {
  const segments=run.boundaryQuadrature;
  require(Array.isArray(segments)&&segments.length>0&&segments.length===run.steps,'independent quadrature is missing or truncated');
  require(segments[0].start?.time===0&&segments.at(-1).end?.time===15,'independent quadrature window differs');
  let previous=null,massKg=0,energyMJ=0;
  const endpoints=new Map();
  for(const segment of segments){
    const {held,start,end}=segment;
    keys(held,[...inputs,...Object.keys(fixedControls)],'held input keys');
    require(finiteRecord(held),'held inputs are nonfinite');
    for(const point of [start,end]){
      keys(point,['time',...primitives],'quadrature primitive keys');
      require(finiteRecord(point),'quadrature primitive observation is nonfinite');
    }
    if(previous)equal(start,previous,'quadrature state/time continuity');
    const delta=end.time-start.time;
    require(delta>0&&delta<=run.stepSeconds+1e-9,'quadrature communication step differs');
    for(const key of inputs)close(held[key],at(rows,start.time,key),'original measured forcing',1e-9,1e-12);
    for(const [key,value]of Object.entries(fixedControls))equal(held[key],value,'unmeasured control assumption');
    requireInputDomain(held);
    massKg+=.5*delta*(boundaryMass(held,start)+boundaryMass(held,end));
    energyMJ+=.5*delta*(boundaryEnergy(held,start)+boundaryEnergy(held,end));
    endpoints.set(start.time,start);endpoints.set(end.time,end);previous=end;
  }
  for(const point of run.points)equal(Object.fromEntries(['time',...primitives].map(key=>[key,point[key]])),endpoints.get(point.time),'trace/quadrature native state');
  close(run.integrals?.massKg,massKg,'independent mass integral');
  close(run.integrals?.energyMJ,energyMJ,'independent energy integral');
  return {massKg,energyMJ};
}

function inspectRun(run,{step,scale,required,manifest,protocol,rows,parameters}) {
  require(run&&run.stepSeconds===step&&run.geometryScale===scale,'required run configuration differs');
  equal(run.parameters,{...parameters,geometryScale:scale},'applied native parameters');
  require(run.runtime?.model===manifest.model&&run.runtime.fmuSha256===manifest.fmuSha256,'mixed native executables');
  equal(run.solverRelativeTolerance,protocol.solverRelativeTolerance,'solver tolerance');
  equal(run.requestedSolverRelativeTolerance,protocol.solverRelativeTolerance,'requested solver tolerance');
  if(run.completed===false){
    require(!required&&run.status==='failed-domain'&&run.failureKind==='NativeDomainExit'
      &&typeof run.domainStop==='string'&&run.domainStop.trim(),'mandatory run failed or sensitivity failure is unclassified');
    const terminal=run.terminalObservation;
    keys(terminal,observationKeys,'failed sensitivity terminal observation');
    require(finiteRecord(terminal)&&terminal.time>=0&&terminal.time<=15,'failed sensitivity terminal state is missing');
    const violations=domainViolations(terminal);
    require(violations.length>0,'claimed domain exit has no violated production predicate');
    equal(run.domainViolations,violations,'failed sensitivity domain predicates');
    require(run.points===undefined&&run.integrals===undefined,'failed sensitivity is represented as a complete trace');
    return null;
  }
  require(run.completed===true&&run.status==='completed','native run is incomplete');
  require(Array.isArray(run.points)&&run.points.length===16,'native trace is truncated');
  for(const [index,point]of run.points.entries()){
    keys(point,observationKeys,'native trace diagnostics');
    require(finiteRecord(point)&&point.time===index,'native trace is incomplete or nonfinite');
    require(domainViolations(point).length===0,'completed native state leaves the production domain');
  }
  const sums=quadrature(run,rows),first=run.points[0],last=run.points.at(-1),limits=protocol.numericalLimits;
  const errors={};
  for(const [field,inventory,integral,native,error]of [
    ['massIntegralErrorKg','totalMassKg','massKg','integratedBoundaryMassKg','nativeMassIntegralErrorKg'],
    ['energyIntegralErrorMJ','thermalEnergyMJ','energyMJ','integratedBoundaryEnergyMJ','nativeEnergyIntegralErrorMJ']]){
    errors[field]=last[inventory]-first[inventory]-sums[integral];
    close(run[field],errors[field],`${field} recomputation`);
    within(errors[field],limits[field],field);
    for(const point of run.points)within(point[inventory]-first[inventory]-(point[native]-first[native]),limits[field],`native ${inventory} ledger`);
    close(run[error],last[inventory]-first[inventory]-(last[native]-first[native]),error);
  }
  return errors;
}

const rms=values=>Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)/values.length);

export function verifyContinuousMeasuredReport(report,manifest,protocol,rows,parameterLedger) {
  require(hash(JSON.stringify(protocol))===protocolContentSha256&&report.protocolSha256===continuousMeasuredProtocolSha256,'frozen prospective protocol was changed');
  equal(report.protocol,protocol,'embedded protocol');
  require(hash(JSON.stringify(rows))===dataContentSha256&&report.inputDataSha256===continuousMeasuredDataSha256,'original measured acquisition values changed');
  require(report.schema==='openpwr-continuous-measured-v1'&&report.executed===true&&report.status==='inconclusive','measured report identity/status differs');
  require(report.validationPassed===false&&report.physicalValidationPassed===false,'physical validation is overclaimed');
  equal(report.caseId,protocol.caseId,'case identity');
  equal(report.comparisonWindowS,protocol.windowSeconds,'comparison window');
  equal(report.scope,scope,'comparison scope');equal(report.conclusion,conclusion,'physical conclusion');
  require(report.productionKernel?.class==='ColdStartPlant'&&report.productionKernel.composition==='ContinuousPlant.thermal'
    &&report.productionKernel.sameClass===true&&report.productionKernel.sameWholePlantExecutable===false,'shared-kernel coverage is overclaimed');
  equal(report.productionKernel.excludedSubsystems,protocol.excludedClaims,'excluded subsystem claims');
  require(report.numericalEvidence?.physicalAcceptanceBand===null,'physical acceptance band is invented');
  equal(report.numericalEvidence.stepsComparedS,protocol.communicationStepsSeconds,'displayed communication steps');
  equal(report.numericalEvidence.metricSampleTimesS,protocol.metricSampleTimesSeconds,'displayed scoring times');
  equal(report.numericalEvidence.geometrySensitivityScales,protocol.geometrySensitivityScales,'displayed geometry scales');
  equal(report.numericalEvidence.initialPoint,protocol.initialPointPolicy,'displayed initialization policy');
  equal(report.numericalEvidence.sensitivityPolicy,protocol.domainStopPolicy,'displayed sensitivity policy');
  equal(report.fixedControlAssumptions,fixedControls,'fixed control assumptions');
  require(Array.isArray(parameterLedger.parameters)&&parameterLedger.parameters.length>0,'source parameter ledger is missing');
  const parameters=Object.fromEntries(parameterLedger.parameters.map(item=>[item.parameter,item.value]));
  require(Object.keys(parameters).length===parameterLedger.parameters.length&&finiteRecord(parameters),'source parameter ledger is malformed');
  require(parameters.initialPressurePa/1e6>=.2&&parameters.initialPressurePa/1e6<=15.5,'wrapper pressure-target parameter leaves the production input domain');
  // Measured boundaries are piecewise linear; checking the original knots and
  // window endpoints proves their ranges throughout, including failed runs.
  for(const time of [0,...protocol.metricSampleTimesSeconds])requireInputDomain({...Object.fromEntries(inputs.map(key=>[key,at(rows,time,key)])),...fixedControls});
  equal(report.parameterSources,parameterLedger,'embedded parameter ledger');
  equal(report.appliedSourceParameters,parameters,'applied source parameters');
  require(manifest.model===protocol.model&&report.buildManifest?.model===manifest.model
    &&report.runtime?.model===manifest.model&&report.runtime.fmuSha256===manifest.fmuSha256
    &&report.buildManifest.fmuSha256===manifest.fmuSha256,'report executable identity differs');
  require(Array.isArray(report.sensitivity)&&report.sensitivity.length===2,'geometry sensitivity evidence is missing');
  equal(report.sensitivity.map(run=>run.geometryScale),[.5,2],'geometry sensitivity cases');
  const configurations=[['nominal',report.primaryRun,.05,1,true],['refined',report.refinedRun,.025,1,true],
    ...report.sensitivity.map(run=>[`geometry ${run.geometryScale}`,run,.05,run.geometryScale,false])];
  const expectedChecks=[];
  for(const [label,run,step,scale,required]of configurations){
    const result=inspectRun(run,{step,scale,required,manifest,protocol,rows,parameters});
    if(result)for(const [key,value]of Object.entries(result))expectedChecks.push({name:`${label} ${key}`,value,absoluteTolerance:protocol.numericalLimits[key],pass:true});
  }
  equal(report.trace,report.primaryRun.points,'published native trace');
  equal(report.sensitivityCoverageComplete,report.sensitivity.every(run=>run.completed),'sensitivity coverage claim');
  require(Array.isArray(report.inputs)&&report.inputs.length===inputs.length,'displayed forcing is missing');
  for(const [index,key]of inputs.entries()){
    const input=report.inputs[index];require(input.name===key&&input.points?.length===16,'displayed forcing channel differs');
    for(const [time,point]of input.points.entries()){equal(point.time,time,'displayed forcing time');close(point.value,at(rows,time,key),'displayed measured forcing');}
  }
  require(Array.isArray(report.channels)&&report.channels.length===channels.length,'held-out channels are missing');
  for(const [index,[key,name,unit]]of channels.entries()){
    const channel=report.channels[index],times=[0,...protocol.metricSampleTimesSeconds];
    require(channel.key===key&&channel.name===name&&channel.unit===unit&&channel.points?.length===times.length,'held-out channel identity/grid differs');
    const points=times.map(time=>({time,measured:at(rows,time,key),simulated:at(report.primaryRun.points,time,key),refined:at(report.refinedRun.points,time,key)}));
    for(const [i,expected]of points.entries()){
      keys(channel.points[i],Object.keys(expected),'held-out point fields');
      for(const [field,value]of Object.entries(expected))close(channel.points[i][field],value,`held-out ${key} ${field}`);
    }
    const errors=points.slice(1).map(point=>point.simulated-point.measured);
    const metrics={samples:errors.length,rmse:rms(errors),maximumAbsoluteError:Math.max(...errors.map(Math.abs)),
      meanError:errors.reduce((sum,value)=>sum+value,0)/errors.length,initialBias:points[0].simulated-points[0].measured,
      finalError:errors.at(-1),changeRmse:rms(points.slice(1).map(point=>(point.simulated-points[0].simulated)-(point.measured-points[0].measured))),
      maximumStepRefinementDifference:Math.max(...points.map(point=>Math.abs(point.simulated-point.refined))),
      maximumGeometrySensitivitySpread:report.sensitivity.every(run=>run.completed)?Math.max(...times.map(time=>Math.abs(at(report.sensitivity[0].points,time,key)-at(report.sensitivity[1].points,time,key)))):null,
      maximumReferenceTimingAllowance:Math.max(...times.slice(1).flatMap(time=>[-1,1].map(offset=>Math.abs(at(rows,time+offset,key)-at(rows,time,key)))))};
    keys(channel.metrics,Object.keys(metrics),'held-out metric fields');
    for(const [field,value]of Object.entries(metrics))value===null?equal(channel.metrics[field],null,field):close(channel.metrics[field],value,`recomputed ${key} ${field}`);
    const limit=protocol.numericalLimits[unit==='MPa'?'pressureRefinementMPa':'temperatureRefinementK'];
    within(metrics.maximumStepRefinementDifference,limit,`${key} communication refinement`);
    expectedChecks.push({name:`${name} communication refinement`,value:metrics.maximumStepRefinementDifference,absoluteTolerance:limit,pass:true});
  }
  require(report.numericalPassed===true&&report.numericalChecks?.length===expectedChecks.length,'numerical checks are missing or unsuccessful');
  for(const [index,expected]of expectedChecks.entries()){
    const check=report.numericalChecks[index];require(check.name===expected.name&&check.pass===true&&check.absoluteTolerance===expected.absoluteTolerance,'numerical check or frozen tolerance differs');
    close(check.value,expected.value,'recomputed numerical check');
  }
  return report;
}

export async function verifyContinuousMeasuredEvidence({root,version,revision}) {
  const read=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
  const report=await read('artifacts/continuous-measured-validation.json');
  const manifest=await read('artifacts/modelica/continuous-measured-manifest.json');
  const binaryHash=hash(await readFile(resolve(root,'artifacts/modelica/KrskoContinuousThermal.fmu')));
  for(const identity of [report,manifest,report.buildManifest])require(identity&&identity.version===version
    &&(!revision||identity.gitRevision===revision),'evidence belongs to another version/revision');
  require(manifest.fmuSha256===binaryHash&&report.buildManifest.fmuSha256===binaryHash&&report.runtime?.fmuSha256===binaryHash,'compiled executable bytes differ');
  for(const [key,path]of Object.entries(continuousMeasuredSources)){
    const actual=hash(await readFile(resolve(root,path)));
    for(const identity of [report,manifest,report.buildManifest])require(identity[key]===actual,`${key} is stale`);
  }
  require(report.protocolSha256===continuousMeasuredProtocolSha256&&report.inputDataSha256===continuousMeasuredDataSha256,'immutable protocol/data bytes changed');
  for(const [field,path]of [['metadata',continuousMeasuredSources.referenceMetadataSha256],['sourceLedger',continuousMeasuredSources.sourceLedgerSha256],
    ['sourceCoverage',continuousMeasuredSources.sourceCoverageSha256]])equal(report[field],await read(path),`embedded ${field}`);
  equal(report.source,report.metadata.source,'source attribution');equal(report.sourceURL,report.metadata.source.url,'source URL');
  const lines=(await readFile(resolve(root,continuousMeasuredSources.inputDataSha256),'utf8')).trim().split(/\r?\n/);
  const header=lines.shift().split(',');
  const rows=lines.map(line=>Object.fromEntries(line.split(',').map((value,index)=>[header[index],Number(value)])));
  return verifyContinuousMeasuredReport(report,manifest,await read(continuousMeasuredSources.protocolSha256),rows,
    await read(continuousMeasuredSources.parameterSourcesSha256));
}
