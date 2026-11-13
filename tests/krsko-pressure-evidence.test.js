// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {krskoPressureSources,pressureFrozenHashes,scorePressureTrace,pressurePairedChecks,
  verifyKrskoPressureReport,verifyKrskoPressureEvidence,verifyPressureComponentReport,verifyPressureHistory,verifyConditionalSpray} from '../scripts/krsko-pressure-evidence.mjs';

const root=resolve(import.meta.dirname,'..'),read=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const baseline=await read('validation/baselines/continuous-measured-v0.10.json');
const protocol=await read('validation/krsko_pressure/protocol-initial.json');
const config=await read('validation/krsko_pressure/candidate-config.json');
const boundaries=await read('validation/krsko_pressure/initial-boundaries.json');
const sourceAudit=await read('validation/krsko_pressure/source-audit.json');
const sprayConfig=await read('validation/krsko_pressure/conditional-spray-config.json');
const originalSummary=await read('validation/krsko_pressure/original-attempt-summary.json');
const regularizationAmendment=await read('validation/krsko_pressure/regularization-amendment.json');
const coordinateAmendment=await read('validation/krsko_pressure/coordinate-amendment.json');
const finalNumericsAmendment=await read('validation/krsko_pressure/final-numerics-amendment.json');
const lines=(await readFile(join(root,'validation/krsko2005/measured.csv'),'utf8')).trim().split(/\r?\n/),header=lines.shift().split(',');
const rows=lines.map(line=>Object.fromEntries(line.split(',').map((value,index)=>[header[index],Number(value)])));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const names=['Primary pressure','Mean hot-leg temperature','Mean cold-leg temperature','Mean secondary pressure'];
const check=(name,value,absoluteTolerance)=>({name,value,absoluteTolerance,pass:Math.abs(value)<=absoluteTolerance});
const parameters={...boundaries.initialParameters,...config.commonParameters,geometryScale:1};
function saturation(pressure){
  const n=[1167.0521452767,-724213.16703206,-17.073846940092,12020.82470247,-3232555.0322333,14.91510861353,-4823.2657361591,405113.40542057,-.23855557567849,650.17534844798];
  const b=pressure**.25,e=b*b+n[2]*b+n[5],f=n[0]*b*b+n[3]*b+n[6],g=n[1]*b*b+n[4]*b+n[7],d=2*g/(-f-Math.sqrt(f*f-4*e*g));
  return (n[9]+d-Math.sqrt((n[9]+d)**2-4*(n[8]+n[9]*d)))/2;
}
// The frozen v0.10 observations supply a conservation fixture. Duplicating them
// across four model identities is packaging-only evidence, never a new run.
function interp(points,time,key){
  const exact=points.find(p=>p.time===time);if(exact)return exact[key];
  const i=points.findIndex(p=>p.time>time),a=points[i-1],b=points[i];return a[key]+(time-a.time)/(b.time-a.time)*(b[key]-a[key]);
}
function fixture(history=false){
  const binary=Buffer.from('Synthetic pressure packaging fixture, not an FMU'),manifests={};
  const cases=config.cases.map(planned=>{
    const manifest={version:'fixture',gitRevision:'fixture-revision',model:planned.model,fmuSha256:hash(binary)};
    manifests[planned.id]=manifest;
    const runs=['primaryRun','refinedRun'].map(key=>{
      const run=structuredClone(baseline[key]);
      run.caseId=planned.id;run.parameters={...parameters};run.runtime={model:planned.model,fmuSha256:manifest.fmuSha256};
      for(const p of run.points){
        if(history&&(planned.id!=='equilibrium'||[0,1,3,5,7,9,11,13,15].includes(p.time)))for(const channel of originalSummary.cases.find(record=>record.id===planned.id).channels)
          p[channel.key]=interp(channel.points,p.time,key==='primaryRun'?'simulated':'refined');
        const ts=saturation(p.primaryPressureMPa);
        if(history)p.pressurizerTemperatureC=Math.min(ts-273.15,345);
        Object.assign(p,{pressurizerLiquidTemperatureC:p.pressurizerTemperatureC,
          pressurizerVaporTemperatureC:history?Math.max(ts,p.primaryPressureMPa>=16.5291643?650:0)-273.15:p.pressurizerTemperatureC,
          pressurizerSteamPartialPressureMPa:p.primaryPressureMPa,pressurizerSaturationTemperatureC:ts-273.15,
          pressurizerWallEnergyMJ:0,pressurizerWallAmbientPowerW:0,pressurizerWallMinimumTemperatureK:ts,
          pressurizerWallMaximumTemperatureK:ts,pressureModelFinitePhase:+planned.finitePhase,pressureModelIncludesWall:+planned.wall,
          sprayControlEnabled:0,actualSprayFlowKgS:0,sprayCondensationKgS:0,sprayHeatTransferMW:0,pressurizerMinimumFilmNusseltArgument:0});
      }
      for(const segment of run.boundaryQuadrature)for(const endpoint of ['start','end'])segment[endpoint].pressurizerWallAmbientPowerW=0;
      return run;
    });
    const [nominal,refined]=runs,channels=scorePressureTrace(nominal.points,refined.points,rows)
      .map((channel,index)=>({...channel,name:names[index],label:names[index],unit:index===0||index===3?'MPa':'°C'}));
    const numericalChecks=[];
    for(const [label,run]of [['nominal',nominal],['refined',refined]]){
      numericalChecks.push(check(`${planned.id} ${label} completed`,0,0));
      for(const key of ['massIntegralErrorKg','energyIntegralErrorMJ'])numericalChecks.push(check(`${planned.id} ${label} ${key}`,run[key],protocol.numericalLimits[key]));
      for(const [inventory,integral,limit]of [['totalMassKg','integratedBoundaryMassKg',.05],['thermalEnergyMJ','integratedBoundaryEnergyMJ',.1]]){
        const first=run.points[0],value=Math.max(...run.points.map(p=>Math.abs(p[inventory]-first[inventory]-(p[integral]-first[integral]))));
        numericalChecks.push(check(`${planned.id} ${label} native ${inventory} ledger`,value,limit));
      }
      numericalChecks.push(check(`${planned.id} ${label} observed state domain`,0,0));
    }
    for(const channel of channels)numericalChecks.push(check(`${planned.id} ${channel.name} communication refinement`,channel.metrics.maximumStepRefinementDifference,channel.unit==='MPa'?.01:.05));
    return {...planned,buildManifest:manifest,nominal,refined,channels,numericalChecks,numericalPassed:true};
  });
  const candidate=cases[1],baselineReproductionChecks=[],wallMeshChecks=[];
  for(const [index,name]of names.entries()){
    const key=cases[0].channels[index].key;
    baselineReproductionChecks.push(check(`${name} equilibrium baseline reproduction`,Math.max(...cases[0].nominal.points.map(p=>Math.abs(p[key]-interp(baseline.primaryRun.points,p.time,key)))),index===0||index===3?.01:.05));
    for(const step of ['nominal','refined'])wallMeshChecks.push(check(`${name} ${step} wall mesh refinement`,Math.max(...candidate[step].points.map(p=>Math.abs(p[key]-interp(cases[3][step].points,p.time,key)))),index===0||index===3?.01:.05));
  }
  const paired=pressurePairedChecks(candidate.channels,cases[0].channels,baseline.channels,protocol);
  const channels=candidate.channels.map((channel,index)=>({...channel,
    points:channel.points.map(point=>({...point,baseline:interp(baseline.primaryRun.points,point.time,channel.key),
      equilibrium:interp(cases[0].nominal.points,point.time,channel.key),noWall:interp(cases[2].nominal.points,point.time,channel.key),refinedWall:interp(cases[3].nominal.points,point.time,channel.key)})),
    metrics:{...channel.metrics,releasedBaselineRmse:baseline.channels[index].metrics.rmse,rmseChangeFromBaseline:channel.metrics.rmse-baseline.channels[index].metrics.rmse}}));
  const report={...manifests.candidate,...pressureFrozenHashes,schema:'openpwr-krsko-pressure-development-v1',executed:true,
    status:'development-no-improvement',caseId:protocol.caseId,validationPassed:false,physicalValidationPassed:false,independentValidationPassed:false,
    defaultPromotionRecommended:false,productionDefault:'equilibrium',caseImprovementPassed:false,protocol,candidateConfiguration:config,
    initialBoundaries:boundaries,sourceAudit,regularizationAmendment,coordinateAmendment,finalNumericsAmendment,
    appliedSourceParameters:parameters,fixedControlAssumptions:boundaries.unquantifiedControls,
    comparisonWindowS:[0,15],releasedBaseline:protocol.baseline,runtime:candidate.nominal.runtime,buildManifest:manifests.candidate,
    source:baseline.source,sourceURL:baseline.sourceURL,dataURL:baseline.dataURL,
    scope:'Development comparison of the shared production thermal kernel with measured core-heat and steam/feedwater boundaries. It excludes kinetics, turbine synchronization, plant controls and complete cold-start validation.',
    conclusion:'The candidate does not establish a guarded production-accuracy improvement. Discrepancies and adverse changes are retained; the production equilibrium default remains unchanged.',
    cases,channels,trace:candidate.nominal.points,inputs:structuredClone(baseline.inputs),numericalPassed:true,
    numericalChecks:[...cases.flatMap(record=>record.numericalChecks),...baselineReproductionChecks,...wallMeshChecks],baselineReproductionChecks,wallMeshChecks,
    pairedGuards:{protocolSha256:pressureFrozenHashes.protocolSha256,baselineSha256:pressureFrozenHashes.baselineSha256,
      caseImprovementPassed:false,physicalValidationPassed:false,independentValidationPassed:false,checks:paired,meaning:protocol.pairedImprovementCriteria.meaning}};
  if(history){
    report.originalDevelopmentAttempt=originalSummary;
    report.originalAttemptReproduced=true;
    report.originalAttemptReproductionChecks=cases.flatMap(record=>record.channels.map((channel,index)=>
      check(`${record.id} ${names[index]} original-attempt reproduction`,0,index===0||index===3?.01:.05)));
  }
  return {report,manifests,binary};
}
const verify=f=>verifyKrskoPressureReport(f.report,f.manifests,protocol,config,rows,boundaries,baseline);

function addConditionalFixture(f){
  for(const [id,model]of [['spray','KrskoPressureSpray'],['spray-refined-wall','KrskoPressureSprayRefinedWall']])
    f.manifests[id]={...f.manifests.candidate,model};
  const cases=sprayConfig.cases.map(planned=>{
    const record=structuredClone(f.report.cases[1]),manifest=f.manifests[planned.model==='KrskoPressureSpray'?'spray':'spray-refined-wall'];
    Object.assign(record,planned,{finitePhase:true,wall:true,conditionalSpray:true,buildManifest:manifest});
    for(const label of ['nominal','refined']){
      const run=record[label];run.caseId=planned.id;run.runtime={model:planned.model,fmuSha256:manifest.fmuSha256};
      Object.assign(run.parameters,{sprayReferencePressureMPa:15.51,sprayGainFractionPerMPa:planned.gainFractionPerMPa,
        sprayMaximumFlowKgS:20.67,sprayContactEfficiency:planned.contactEfficiency});
      for(const point of run.points){point.sprayControlEnabled=1;
        point.actualSprayFlowKgS=20.67*Math.min(1,Math.max(0,planned.gainFractionPerMPa*(point.primaryPressureMPa-15.51)));}
    }
    record.numericalChecks.forEach(item=>item.name=item.name.replace(/^candidate /,`${planned.id} `));
    return record;
  });
  const nominal=cases[0],wallMeshChecks=[];
  for(const [index,name]of names.entries())for(const step of ['nominal','refined'])
    wallMeshChecks.push(check(`${name} ${step} conditional spray wall mesh refinement`,0,index===0||index===3?.01:.05));
  const sensitivityGuards=cases.map(record=>({id:record.id,pairedGuards:{protocolSha256:pressureFrozenHashes.protocolSha256,
    baselineSha256:pressureFrozenHashes.baselineSha256,caseImprovementPassed:false,physicalValidationPassed:false,independentValidationPassed:false,
    checks:pressurePairedChecks(record.channels,f.report.cases[0].channels,baseline.channels,protocol),meaning:protocol.pairedImprovementCriteria.meaning}}));
  const channels=nominal.channels.map((channel,index)=>({...channel,
    points:channel.points.map(point=>({...point,baseline:interp(baseline.primaryRun.points,point.time,channel.key),
      equilibrium:interp(f.report.cases[0].nominal.points,point.time,channel.key),originalNoSpray:point.simulated,
      gainLow:point.simulated,gainHigh:point.simulated,contactHalf:point.simulated,refinedWall:point.simulated})),
    metrics:{...channel.metrics,releasedBaselineRmse:baseline.channels[index].metrics.rmse,rmseChangeFromBaseline:channel.metrics.rmse-baseline.channels[index].metrics.rmse}}));
  f.report.conditionalSpray={configuration:sprayConfig,configurationSha256:pressureFrozenHashes.conditionalSprayConfigSha256,executed:true,
    scope:'Conditional development comparison with native generic spray feedback, not a measured Krško actuator-history replay. The assumed pressure reference, gain, flow cap and contact efficiency do not validate actual plant controls or full startup.',
    status:'conditional-development-no-improvement',physicalValidationPassed:false,independentValidationPassed:false,actualPlantControlValidated:false,
    defaultPromotionRecommended:false,caseImprovementPassed:false,
    conclusion:'The preselected nominal spray assumption does not establish a guarded development improvement. All sensitivities and adverse changes remain visible; no best-fitting case is substituted.',
    assumptions:[sprayConfig.selectionContext,sprayConfig.claimBoundary,...['referenceBasis','gainBasis','capacityBasis','contactBasis','actuatorDynamics'].map(key=>sprayConfig.controller[key])],
    cases,channels,numericalChecks:[...cases.flatMap(record=>record.numericalChecks),...wallMeshChecks],numericalPassed:true,wallMeshChecks,
    pairedGuards:sensitivityGuards[0].pairedGuards,sensitivityGuards,runtime:nominal.nominal.runtime,buildManifest:nominal.buildManifest,trace:nominal.nominal.points};
  return f;
}

// Synthetic numerical-gate fixture with exactly integrated piecewise constant
// boundary fluxes. This is deliberately not a thermodynamic model or FMU run.
function componentFixture(){
  const definitions=[['cold-nitrogen-equilibrium','ColdNitrogenEquilibrium','vessel',200],['adiabatic-compression','AdiabaticCompression','vessel',30],
    ['vent-headspace','VentHeadspace','vessel',60],['wall-condensation','WallCondensation','vessel',15],
    ['wall-condensation-refined','WallCondensationRefined','vessel',15],['coupled-cold-equilibrium','CoupledColdEquilibrium','coupled',200],
    ['coupled-cold-heating','CoupledColdHeating','coupled',600],['coupled-recirculation-spray','CoupledRecirculationSpray','coupled',30]]
    .map(([id,model,kind,durationSeconds])=>({id,model:`PressureComponentChecks.${model}`,kind,durationSeconds,sampleIntervalSeconds:.1}));
  const limits={nativeMassInventoryKg:1e-3,nativeEnergyInventoryMJ:1e-3,independentMassQuadratureKg:1e-3,independentEnergyQuadratureMJ:.01,
    instantaneousMassResidualKgS:1e-8,instantaneousEnergyResidualMW:1e-8,coldPressureDriftPa:.1,coldTemperatureDriftK:1e-4,wallRefinementPressureMPa:.001};
  const checks=[];
  const scenarios=definitions.map(def=>{
    const {id,kind,durationSeconds}=def,compression=id==='adiabatic-compression',vent=id==='vent-headspace',heating=id==='coupled-cold-heating';
    const grid=Array.from({length:durationSeconds*10+1},(_,i)=>i/10);
    if(compression||vent)grid.splice(50,0,5);
    let seenFive=false,mass=0,energy=0;
    const trace=[];
    for(const time of grid){
      const active=time>5||(time===5&&seenFive);if(time===5)seenFive=true;
      const liquidFlowKgS=compression&&active?5:0,gasVentKgS=vent&&active?.001:0,steamVentKgS=vent&&active?.0001:0;
      const massRate=liquidFlowKgS-gasVentKgS-steamVentKgS,power=heating?5.5:-(gasVentKgS*1040*313.15+steamVentKgS*2e6)/1e6;
      if(trace.length){const a=trace.at(-1),dt=time-a.time;mass+=dt*(massRate+a.boundaryMassFlowKgS)/2;energy+=dt*(power+a.boundaryPowerMW)/2;}
      const p={time,pressureMPa:.3+(compression?time*.001:0),liquidTemperatureK:313.15,vaporTemperatureK:313.15+(compression?time*.001:0),
        steamPartialPressurePa:7373.055421,liquidVolumeM3:25,gasMassKg:10-(vent?Math.max(0,time-5)*.001:0),vaporMassKg:1,
        totalMassKg:1e5+mass,totalEnergyMJ:1e4+energy,wallEnergyMJ:0,wallMinimumTemperatureK:313.15,wallMaximumTemperatureK:313.15,
        boundaryPowerMW:power,boundaryMassFlowKgS:massRate,integratedBoundaryEnergyMJ:energy,integratedBoundaryMassKg:mass,
        energyResidualMW:0,massResidualKgS:0,heatInputMW:heating?5:0,steamVentKgS,gasVentKgS,vaporEnthalpyJkg:2e6,wallAmbientPowerMW:0,valid:1,
        actualSprayFlowKgS:id==='coupled-recirculation-spray'&&time>=5?.5:0,
        sprayCondensationKgS:id==='coupled-recirculation-spray'&&time>=5?.05:0,
        sprayHeatTransferMW:id==='coupled-recirculation-spray'&&time>=5?.1:0,minimumFilmNusseltArgument:0};
      if(kind==='vessel')Object.assign(p,{liquidFlowKgS,liquidEnthalpyJkg:0,steamFlowKgS:0});
      else Object.assign(p,{pumpHeatMW:0,heaterPowerMW:heating?.5:0,shutdownCoolingMW:0,chargingFlowKgS:0,letdownFlowKgS:0,
        chargingEnthalpyJkg:0,coldLegEnthalpyJkg:0,secondarySteamVentKgS:0,secondaryGasVentKgS:0,secondaryVaporEnthalpyJkg:0,
        secondaryTemperatureK:313.15,hotTemperatureK:313.15+(heating?time*.01:0),coldTemperatureK:313.15+(heating?time*.008:0),
        fuelTemperatureK:320,primaryFlowKgS:0,primarySubcoolingK:50,secondaryPressureMPa:.3,secondaryLevelPercent:50,secondaryGasMassKg:1});
      trace.push(p);
    }
    const first=trace[0],last=trace.at(-1),nativeMass=Math.max(...trace.map(p=>Math.abs(p.totalMassKg-first.totalMassKg-p.integratedBoundaryMassKg))),
      nativeEnergy=Math.max(...trace.map(p=>Math.abs(p.totalEnergyMJ-first.totalEnergyMJ-p.integratedBoundaryEnergyMJ)));
    const values={nativeMassInventoryKg:nativeMass,nativeEnergyInventoryMJ:nativeEnergy,
      independentMassQuadratureKg:last.totalMassKg-first.totalMassKg-mass,independentEnergyQuadratureMJ:last.totalEnergyMJ-first.totalEnergyMJ-energy,
      instantaneousMassResidualKgS:0,instantaneousEnergyResidualMW:0};
    for(const [key,value]of Object.entries(values))checks.push(check(`${id} ${key}`,value,limits[key]));
    checks.push(check(`${id} native domain`,0,0));
    if(id.endsWith('equilibrium')){checks.push(check(`${id} coldPressureDriftPa`,0,.1));checks.push(check(`${id} coldTemperatureDriftK`,0,1e-4));}
    if(compression){checks.push(check(`${id} prescribed added mass`,last.totalMassKg-first.totalMassKg-125,1e-3));checks.push(check(`${id} compression response`,0,0));}
    if(vent)checks.push(check(`${id} both species vent`,0,0));if(heating)checks.push(check(`${id} coupled heatup response`,0,0));
    if(id==='coupled-recirculation-spray'){checks.push(check(`${id} internal spray condenses steam`,0,0));checks.push(check(`${id} no external cooling sink`,0,1e-12));}
    return {...def,complete:true,trace,runtime:{compiler:'Synthetic fixture only',solver:'DASSL',solverRelativeTolerance:1e-10,
      modelicaLibrary:'4.0.0',executableSha256:'a'.repeat(64),traceCsvSha256:'b'.repeat(64)}};
  });
  checks.push(check('wall mesh pressure refinement',0,.001));
  return {schema:'openpwr-pressure-component-verification-v1',version:'fixture',gitRevision:'fixture-revision',executed:true,
    physicalValidationPassed:false,numericalPassed:true,solver:'DASSL',solverRelativeTolerance:1e-10,modelicaLibrary:'4.0.0',numericalLimits:limits,
    scope:'Unmeasured numerical verification of the shared finite-phase pressurizer and coupled cold thermal kernel. No measured component, plant or startup qualification.',
    scenarioDefinitions:definitions,scenarios,numericalChecks:checks};
}

test('pressure publication accepts an honestly unsuccessful development comparison',()=>{
  const f=fixture();assert.equal(verify(f),f.report);assert.equal(f.report.pairedGuards.checks.length,18);
  assert.equal(f.report.numericalChecks.length,76);
});

test('pressure gate rejects omitted native evidence, forged metrics and changed boundaries',()=>{
  const mutations=[
    f=>f.report.cases.pop(),f=>f.report.cases[1].refined.points.pop(),
    f=>f.report.cases[2].nominal.completed=false,f=>f.report.cases[1].nominal.parameters.geometryScale=2,
    f=>f.report.cases[1].nominal.runtime.fmuSha256='wrong',f=>f.report.cases[1].nominal.solverRelativeTolerance=1e-3,
    f=>f.report.cases[1].nominal.boundaryQuadrature.pop(),
    f=>f.report.cases[1].nominal.boundaryQuadrature[0].held.reactorPowerMW+=10,
    f=>f.report.cases[1].nominal.boundaryQuadrature[0].held.heaterPowerMW=.1,
    f=>delete f.report.cases[1].nominal.boundaryQuadrature[0].end.pressurizerWallAmbientPowerW,
    f=>f.report.cases[1].nominal.points[8].integratedBoundaryEnergyMJ+=1,
    f=>f.report.cases[1].nominal.points[8].thermalEnergyMJ+=1,
    f=>f.report.cases[1].nominal.points[8].pressurizerVaporTemperatureC=0,
    f=>f.report.cases[1].nominal.points[8].pressurizerSaturationTemperatureC+=1,
    f=>f.report.cases[1].nominal.points[8].pressureModelFinitePhase=0,
    f=>f.report.cases[1].nominal.points[8].pressurizerWallMaximumTemperatureK=1100,
    f=>f.report.cases[1].nominal.points[8].pressurizerMinimumFilmNusseltArgument=-1,
    f=>f.report.cases[1].channels[0].metrics.rmse=0,
    f=>f.report.cases[1].channels[0].pressureDiagnostics.simulatedPeakTimeSeconds=1,
    f=>f.report.pairedGuards.checks.pop(),f=>f.report.pairedGuards.checks[0].pass=true,
    f=>f.report.pairedGuards.checks[1].communicationAllowance/=2,
    f=>f.report.channels[0].points[1].noWall+=.1,
    f=>f.report.inputs[0].points[2].value+=1,
    f=>f.report.numericalChecks[0].pass=false,f=>f.report.numericalChecks.pop(),
    f=>f.report.baselineReproductionChecks[0].absoluteTolerance=1,
    f=>f.report.wallMeshChecks.pop(),f=>f.report.caseImprovementPassed=true,
    f=>f.report.physicalValidationPassed=true,f=>f.report.defaultPromotionRecommended=true,
  ];
  for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>verify(f),/Krško pressure evidence/);}
});

test('paired guards preserve adverse channels and double the change-from-initial allowance',()=>{
  const c=structuredClone(baseline.channels),r=structuredClone(baseline.channels);
  c[0].metrics.maximumStepRefinementDifference=.001;r[0].metrics.maximumStepRefinementDifference=.002;
  for(const metric of ['rmse','changeRmse','maximumAbsoluteError'])c[0].metrics[metric]=r[0].metrics[metric]-.005;
  c[1].metrics.rmse+=1;
  const checks=pressurePairedChecks(c,r,r,protocol);
  assert.equal(checks[0].pass,true);assert.equal(checks[1].communicationAllowance,.006);assert.equal(checks[1].pass,false);
  assert.equal(checks[3].pass,false);assert.equal(checks.length,18);
  c[0].metrics.maximumStepRefinementDifference=.1;
  assert.throws(()=>pressurePairedChecks(c,r,r,protocol),/frozen limit/);
});

test('original unsuccessful attempt remains independently scored and reproduced',()=>{
  const f=fixture(true);verify(f);
  verifyPressureHistory(f.report,originalSummary,protocol,rows,baseline);
  f.report.originalAttemptReproductionChecks.pop();
  assert.throws(()=>verifyPressureHistory(f.report,originalSummary,protocol,rows,baseline),/checks were omitted/);
});

test('conditional spray retains preselected nominal, every sensitivity and all adverse guards',()=>{
  const f=addConditionalFixture(fixture(true)),verifySpray=()=>verifyConditionalSpray(f.report.conditionalSpray,f.report.cases,f.manifests,protocol,config,sprayConfig,rows,boundaries,baseline);
  verifySpray();assert.equal(f.report.conditionalSpray.numericalChecks.length,88);
  const mutations=[
    r=>r.cases.pop(),r=>[r.cases[0],r.cases[1]]=[r.cases[1],r.cases[0]],
    r=>r.cases[1].nominal.parameters.sprayGainFractionPerMPa=2,
    r=>r.cases[0].nominal.points[8].actualSprayFlowKgS=0,
    r=>r.cases[0].nominal.points[8].sprayControlEnabled=0,
    r=>r.sensitivityGuards.pop(),r=>r.sensitivityGuards[1].pairedGuards.checks.pop(),
    r=>r.channels[0].points[8].gainLow+=1,r=>r.runtime.fmuSha256='changed',
    r=>r.assumptions=[],r=>r.actualPlantControlValidated=true,r=>r.defaultPromotionRecommended=true,
  ];
  for(const mutate of mutations){const changed=structuredClone(f.report.conditionalSpray);mutate(changed);
    assert.throws(()=>verifyConditionalSpray(changed,f.report.cases,f.manifests,protocol,config,sprayConfig,rows,boundaries,baseline),/Krško pressure evidence/);}
});

test('component publication recomputes inventory, vent enthalpy and case-specific responses',()=>{
  const report=componentFixture();assert.equal(verifyPressureComponentReport(report),report);
  const eventRounded=structuredClone(report);
  for(const point of eventRounded.scenarios[1].trace)if(point.time===5)point.time=5.000000000000112;
  verifyPressureComponentReport(eventRounded);
  const mutations=[
    r=>r.scenarios.pop(),r=>r.scenarios[0].trace.pop(),r=>r.scenarios[0].trace.splice(5,1),
    r=>r.scenarios[2].trace[100].gasVentKgS+=1,r=>r.scenarios[2].trace[100].vaporTemperatureK+=1,
    r=>r.scenarios[1].trace[100].liquidFlowKgS=0,r=>r.scenarios[6].trace[100].heatInputMW=0,
    r=>r.scenarios[3].trace[50].wallMaximumTemperatureK=2000,r=>r.scenarios[6].trace[50].primarySubcoolingK=0,
    r=>r.scenarios[3].trace[50].minimumFilmNusseltArgument=-1,
    r=>r.scenarios[6].trace[100].integratedBoundaryEnergyMJ+=1,r=>r.scenarios[0].trace[50].totalMassKg+=1,
    r=>r.scenarios[0].runtime.solverRelativeTolerance=1e-3,r=>r.numericalLimits.independentEnergyQuadratureMJ=100,
    r=>r.numericalChecks[0].pass=false,r=>r.physicalValidationPassed=true,
  ];
  for(const mutate of mutations){const changed=structuredClone(report);mutate(changed);assert.throws(()=>verifyPressureComponentReport(changed),/Krško pressure evidence/);}
});

test('pressure evidence binds six binaries, frozen references and every shared source',async t=>{
  const prefix=join(tmpdir(),'openpwr-pressure-evidence-'),dir=await mkdtemp(prefix);
  t.after(async()=>{assert.ok(resolve(dir).startsWith(resolve(prefix)));await rm(dir,{recursive:true,force:true});});
  const f=addConditionalFixture(fixture(true)),component=componentFixture();
  const write=async(path,bytes)=>{await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),bytes);};
  const identities=[f.report,f.report.buildManifest,...Object.values(f.manifests),...f.report.cases.map(record=>record.buildManifest),
    f.report.conditionalSpray.buildManifest,...f.report.conditionalSpray.cases.map(record=>record.buildManifest)];
  for(const [key,path]of Object.entries(krskoPressureSources)){
    const bytes=await readFile(join(root,path));await write(path,bytes);identities.forEach(identity=>identity[key]=hash(bytes));
    if(['pressureSourceSha256','coldSourceSha256','componentModelSha256','componentScriptSha256'].includes(key))component[key]=hash(bytes);
  }
  await write(boundaries.previousParameterLedger,await readFile(join(root,boundaries.previousParameterLedger)));
  const componentBytes=Buffer.from(JSON.stringify(component));
  await write('artifacts/pressure-component-verification.json',componentBytes);
  f.report.componentVerification=component;f.report.componentVerificationSha256=hash(componentBytes);
  const reportPath='artifacts/krsko-pressure-development.json',reportBytes=Buffer.from(JSON.stringify(f.report));
  await write(reportPath,reportBytes);
  for(const [id,manifest]of Object.entries(f.manifests)){
    await write(`artifacts/modelica/krsko-pressure-${id}-manifest.json`,JSON.stringify(manifest));
    await write(`artifacts/modelica/${manifest.model}.fmu`,f.binary);
  }
  const verifyAll=()=>verifyKrskoPressureEvidence({root:dir,version:'fixture',revision:'fixture-revision'});
  await verifyAll();
  for(const path of Object.values(krskoPressureSources)){
    const original=await readFile(join(dir,path));await write(path,Buffer.concat([original,Buffer.from('altered')]));
    await assert.rejects(verifyAll(),/Krško pressure evidence/);await write(path,original);
  }
  for(const manifest of Object.values(f.manifests)){
    const path=`artifacts/modelica/${manifest.model}.fmu`;await write(path,'wrong executable');
    await assert.rejects(verifyAll(),/native executable/);await write(path,f.binary);
  }
  await write('artifacts/pressure-component-verification.json',JSON.stringify({...component,numericalPassed:false}));
  await assert.rejects(verifyAll(),/component report bytes/);
  await write('artifacts/pressure-component-verification.json',componentBytes);
  await write(reportPath,JSON.stringify({...f.report,componentVerificationSha256:undefined}));
  await assert.rejects(verifyAll(),/component report bytes/);await write(reportPath,reportBytes);
  await verifyAll();
});
