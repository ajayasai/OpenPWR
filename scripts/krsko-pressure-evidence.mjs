// SPDX-License-Identifier: Apache-2.0
// Recompute evidence from observations. A development tradeoff is publishable;
// a forged improvement, incomplete run or stale executable is not.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const pressureFrozenHashes={
  protocolSha256:'1e1e4c21730c12b68b69a7628130e7365c6ff17851860612ef33c3b5347ac408',
  parameterSourcesSha256:'8797b3b5c10f0ae16b6b1522dadf61afd8858294c3b509f32c4df44b7c57b000',
  conditionalSprayConfigSha256:'649e2e0b2bcff358d5a60fdec1c1d0ebdf75ddeb65d96112f5bc9c7e1df255a7',
  conditionalSprayInitialConfigSha256:'6108ca2516d529e840995d2f89c5c9d19e2f574805b4296e43312aadd0734511',
  conditionalSprayAmendmentSha256:'3e0401fa0219c88182b00cd771467d9487972e04fcdbde4f30f2b9361da0c320',
  originalAttemptSummarySha256:'7e6f25a45a369bfa4765a471d9cfc3a2f21921adccce8e1c8f4c9d52575819d2',
  originalAttemptArchiveSha256:'fe622629b2343e351467fc31b8054b0e628cd3493a38ea4e49f886168be99b42',
  regularizationAmendmentSha256:'f7426e4f3d0fdd5eec848773869f1ebe409b4686b6f1f03b982f12c98489c60c',
  coordinateAmendmentSha256:'9372410b2e249c9be342f269dfd65f1d3b76b0adddef3ae614fd132f9f7a34fb',
  finalNumericsAmendmentSha256:'641f62040be06a68587b63a6926274aabcc139c57aab686470ba1ae278d11541',
  inputDataSha256:'f2160bb33271b1b80774df8edee13d805a2b7abe24a6a7a4de356035001b0407',
  baselineSha256:'f2b32994e9205f13c3f841684ba1ad0f628d77ab60b310edf7dbebb5ca030d5a',
};
export const krskoPressureSources={
  sourceSha256:'models/OpenPWR/package.mo',pressureSourceSha256:'models/FinitePhasePressurizer.mo',
  coldSourceSha256:'models/ColdStartPlant.mo',continuousSourceSha256:'models/ContinuousPlant.mo',
  thermalBenchmarkModelSha256:'models/KrskoContinuousThermal.mo',benchmarkModelSha256:'models/KrskoPressureDevelopment.mo',
  inputDataSha256:'validation/krsko2005/measured.csv',referenceMetadataSha256:'validation/krsko2005/provenance.json',
  sourceLedgerSha256:'validation/krsko2005/reference-plant.json',parameterSourcesSha256:'validation/krsko_pressure/candidate-config.json',
  initialBoundariesSha256:'validation/krsko_pressure/initial-boundaries.json',sourceAuditSha256:'validation/krsko_pressure/source-audit.json',
  protocolSha256:'validation/krsko_pressure/protocol-initial.json',baselineSha256:'validation/baselines/continuous-measured-v0.10.json',
  comparisonScriptSha256:'validation/krsko_pressure/compare.py',referenceScriptSha256:'validation/krsko_pressure/reference.py',
  thermalComparisonScriptSha256:'validation/continuous_measured/compare.py',sharedRunnerSha256:'validation/native_fmi.py',
  packagingScriptSha256:'scripts/modelica/package_fmu.py',
  componentModelSha256:'models/PressureComponentChecks.mo',componentScriptSha256:'validation/krsko_pressure/component_checks.py',
  conditionalSprayConfigSha256:'validation/krsko_pressure/conditional-spray-config.json',
  conditionalSprayInitialConfigSha256:'validation/krsko_pressure/conditional-spray-config-initial.json',
  conditionalSprayAmendmentSha256:'validation/krsko_pressure/conditional-spray-amendment.json',
  originalAttemptSummarySha256:'validation/krsko_pressure/original-attempt-summary.json',
  conditionalSprayScriptSha256:'validation/krsko_pressure/conditional_spray.py',
  originalAttemptArchiveSha256:'validation/baselines/krsko-pressure-initial-v011.zip',
  regularizationAmendmentSha256:'validation/krsko_pressure/regularization-amendment.json',
  coordinateAmendmentSha256:'validation/krsko_pressure/coordinate-amendment.json',
  finalNumericsAmendmentSha256:'validation/krsko_pressure/final-numerics-amendment.json',
};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const require=(condition,message)=>{if(!condition)throw new Error(`Krško pressure evidence: ${message}`);};
const equal=(actual,expected,label)=>require(isDeepStrictEqual(actual,expected),`${label} differs`);
const close=(actual,expected,label,absolute=1e-9,relative=1e-11)=>require(Number.isFinite(actual)&&Number.isFinite(expected)
  &&Math.abs(actual-expected)<=Math.max(absolute,relative*Math.max(Math.abs(actual),Math.abs(expected))),`${label} differs`);
const keys=(value,expected,label)=>equal(Object.keys(value??{}).sort(),[...expected].sort(),label);
const finiteRecord=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(Number.isFinite);
const within=(value,limit,label)=>require(Number.isFinite(value)&&Number.isFinite(limit)&&limit>=0&&Math.abs(value)<=limit,`${label} exceeds frozen limit`);
const compareNumbers=(actual,expected,label)=>{
  keys(actual,Object.keys(expected),label);
  for(const [key,value]of Object.entries(expected))typeof value==='number'?close(actual[key],value,`${label} ${key}`):equal(actual[key],value,`${label} ${key}`);
};
const channels=['primaryPressureMPa','hotLegTemperatureC','coldLegTemperatureC','steamPressureMPa'];
const inputNames=['reactorPowerMW','steamFlowKgS','feedwaterFlowKgS'];
const controls={heaterPowerMW:0,chargingFlowKgS:0,letdownFlowKgS:0};
const metricTimes=[1,3,5,7,9,11,13,15],times=[0,...metricTimes];
const models={equilibrium:'KrskoPressureEquilibrium',candidate:'KrskoPressureCandidate',
  'no-wall':'KrskoPressureNoWall','refined-wall':'KrskoPressureRefinedWall'};
const sprayModels={spray:'KrskoPressureSpray','spray-refined-wall':'KrskoPressureSprayRefinedWall'};
const channelNames=['Primary pressure','Mean hot-leg temperature','Mean cold-leg temperature','Mean secondary pressure'];
const primitives=['pumpHeatInputMW','shutdownCoolingMW','feedwaterEnthalpyJkg','steamEnthalpyJkg','chargingEnthalpyJkg',
  'coldLegEnthalpyJkg','pressurizerVentPowerW','secondaryVentPowerW','pressurizerSteamVentKgS','pressurizerGasVentKgS',
  'secondarySteamVentKgS','secondaryGasVentKgS','pressurizerWallAmbientPowerW'];
const diagnostics=['thermalEnergyMJ','totalMassKg','boundaryMassFlowKgS','boundaryPowerMW','energyResidualMW','massResidualKgS',
  'integratedBoundaryEnergyMJ','integratedBoundaryMassKg','pumpHeatInputMW','actualHeaterPowerMW','actualChargingFlowKgS',
  'actualLetdownFlowKgS','shutdownCoolingMW','steamEnthalpyJkg','chargingEnthalpyJkg','coldLegEnthalpyJkg','feedwaterEnthalpyJkg',
  'pressurizerVentPowerW','secondaryVentPowerW','pressurizerSteamVentKgS','pressurizerGasVentKgS','secondarySteamVentKgS',
  'secondaryGasVentKgS','pressurizerGasMassKg','secondaryGasMassKg','pressurizerTemperatureC','pressurizerLevelPercent',
  'primarySubcoolingK','fuelTemperatureC','heatToSteamMW','primaryFlowKgS','secondaryTemperatureC','secondaryLevelPercent',
  'pressurizerLiquidTemperatureC','pressurizerVaporTemperatureC','pressurizerSteamPartialPressureMPa',
  'pressurizerSaturationTemperatureC','pressurizerWallEnergyMJ','pressurizerWallAmbientPowerW',
  'pressurizerWallMinimumTemperatureK','pressurizerWallMaximumTemperatureK','pressureModelFinitePhase','pressureModelIncludesWall',
  'sprayControlEnabled','actualSprayFlowKgS','sprayCondensationKgS','sprayHeatTransferMW','pressurizerMinimumFilmNusseltArgument'];

function at(rows,time,key){
  require(rows.length>=2&&time>=rows[0].time&&time<=rows.at(-1).time,'trace extrapolation is forbidden');
  for(let i=1;i<rows.length;i++)if(rows[i-1].time<=time&&time<=rows[i].time){
    const a=rows[i-1],b=rows[i];require(b.time>a.time,'trace grid is unordered');
    return a[key]+(time-a.time)/(b.time-a.time)*(b[key]-a[key]);
  }
  throw new Error('Krško pressure evidence: missing reference interval');
}
const rms=values=>Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)/values.length);

export function scorePressureTrace(nominal,refined,rows){
  return channels.map(key=>{
    const points=times.map(time=>({time,measured:at(rows,time,key),simulated:at(nominal,time,key),refined:at(refined,time,key)}));
    require(points.every(finiteRecord),'nonfinite held-out observation');
    const first=points[0],scored=points.slice(1),errors=scored.map(point=>point.simulated-point.measured);
    const result={key,points,metrics:{samples:8,rmse:rms(errors),changeRmse:rms(scored.map(point=>(point.simulated-first.simulated)-(point.measured-first.measured))),
      maximumAbsoluteError:Math.max(...errors.map(Math.abs)),meanError:errors.reduce((sum,value)=>sum+value,0)/8,
      initialBias:first.simulated-first.measured,finalError:errors.at(-1),
      maximumStepRefinementDifference:Math.max(...points.map(point=>Math.abs(point.simulated-point.refined)))}};
    if(key==='primaryPressureMPa'){
      const peak=field=>scored.reduce((best,point)=>point[field]>best[field]?point:best);
      const measured=peak('measured'),simulated=peak('simulated');
      result.pressureDiagnostics={sampleGridSeconds:metricTimes,measuredPeakMPa:measured.measured,simulatedPeakMPa:simulated.simulated,
        measuredPeakTimeSeconds:measured.time,simulatedPeakTimeSeconds:simulated.time,
        peakMagnitudeErrorMPa:simulated.simulated-measured.measured,peakTimeDifferenceSeconds:simulated.time-measured.time,
        measuredPeakRiseMPa:measured.measured-first.measured,simulatedPeakRiseMPa:simulated.simulated-first.simulated,
        measuredFinalRiseMPa:scored.at(-1).measured-first.measured,simulatedFinalRiseMPa:scored.at(-1).simulated-first.simulated};
    }
    return result;
  });
}

export function pressurePairedChecks(candidate,equilibrium,baseline,protocol){
  const checks=[];
  for(const [reference,values]of [['immutable-v0.10-baseline',baseline],['same-boundary-equilibrium-ablation',equilibrium]]){
    equal(candidate.map(item=>item.key),channels,'candidate response channels');
    equal(values.map(item=>item.key),channels,'reference response channels');
    for(const [index,key]of channels.entries()){
      const primary=index===0,c=candidate[index].metrics,r=values[index].metrics;
      const limit=protocol.numericalLimits[key.endsWith('PressureMPa')?'pressureRefinementMPa':'temperatureRefinementK'];
      for(const item of [c,r]){
        require(item.maximumStepRefinementDifference>=0,'negative refinement allowance');
        within(item.maximumStepRefinementDifference,limit,'communication refinement');
      }
      for(const metric of primary?['rmse','changeRmse','maximumAbsoluteError']:['rmse','maximumAbsoluteError']){
        require(Number.isFinite(c[metric])&&c[metric]>=0&&Number.isFinite(r[metric])&&r[metric]>=0,'invalid paired metric');
        const delta=c[metric]-r[metric],communicationAllowance=(metric==='changeRmse'?2:1)*(c.maximumStepRefinementDifference+r.maximumStepRefinementDifference);
        checks.push({reference,channel:key,metric,kind:primary?'pressure-improvement':'other-channel-non-degradation',
          candidate:c[metric],referenceValue:r[metric],delta,communicationAllowance,pass:primary?delta< -communicationAllowance:delta<=communicationAllowance});
      }
    }
  }
  return checks;
}

function saturationTemperature(pressureMPa){
  const n=[1167.0521452767,-724213.16703206,-17.073846940092,12020.82470247,-3232555.0322333,
    14.91510861353,-4823.2657361591,405113.40542057,-.23855557567849,650.17534844798];
  const beta=pressureMPa**.25,e=beta*beta+n[2]*beta+n[5],f=n[0]*beta*beta+n[3]*beta+n[6],g=n[1]*beta*beta+n[4]*beta+n[7];
  const d=2*g/(-f-Math.sqrt(f*f-4*e*g));
  return (n[9]+d-Math.sqrt((n[9]+d)**2-4*(n[8]+n[9]*d)))/2;
}
function requireDomain(p,finitePhase,wall){
  require(p.primaryPressureMPa>=.1&&p.primaryPressureMPa<17.5
    &&p.hotLegTemperatureC+273.15>=280&&p.hotLegTemperatureC+273.15<620
    &&p.coldLegTemperatureC+273.15>=280&&p.coldLegTemperatureC+273.15<610
    &&p.fuelTemperatureC+273.15>=280&&p.fuelTemperatureC+273.15<1400
    &&p.primarySubcoolingK>3&&p.primaryFlowKgS>=-.1&&p.primaryFlowKgS<=16000
    &&p.pressurizerTemperatureC+273.15>=280&&p.pressurizerTemperatureC+273.15<623.15
    &&p.pressurizerLevelPercent>3&&p.pressurizerLevelPercent<97&&p.pressurizerGasMassKg>=-1e-8
    &&p.steamPressureMPa>.002&&p.steamPressureMPa<18
    &&p.secondaryTemperatureC+273.15>=280&&p.secondaryTemperatureC+273.15<623.15
    &&p.secondaryLevelPercent>3&&p.secondaryLevelPercent<97&&p.secondaryGasMassKg>=-1e-8,'completed state leaves production domain');
  equal(p.pressureModelFinitePhase,finitePhase?1:0,'executed pressure formulation');
  equal(p.pressureModelIncludesWall,wall?1:0,'executed wall formulation');
  if(finitePhase){
    const tl=p.pressurizerLiquidTemperatureC+273.15,tv=p.pressurizerVaporTemperatureC+273.15,
      ps=p.pressurizerSteamPartialPressureMPa;
    const ts=saturationTemperature(ps);
    close(p.pressurizerSaturationTemperatureC+273.15,ts,'independent IF97 saturation temperature',1e-7);
    const boundary23=.34805185628969e3-.11671859879975e1*tv+.10192970039326e-2*tv*tv;
    require(ps>.000611657&&ps<19&&tl>=280&&tl<623.15&&tl<ts+2&&tv>=280&&tv<800&&tv>ts-2
      &&(ps<16.5291643||(tv>=623.15&&ps<boundary23)),'finite-phase property domain is violated');
    if(wall)require(p.pressurizerMinimumFilmNusseltArgument>=0&&p.pressurizerWallMinimumTemperatureK>=273.15&&p.pressurizerWallMaximumTemperatureK<=1073.15
      &&p.pressurizerWallMinimumTemperatureK<=p.pressurizerWallMaximumTemperatureK,'wall temperature domain is violated');
  }
}

const boundaryMass=(held,p)=>held.feedwaterFlowKgS-held.steamFlowKgS+held.chargingFlowKgS-held.letdownFlowKgS
  -['pressurizerSteamVentKgS','pressurizerGasVentKgS','secondarySteamVentKgS','secondaryGasVentKgS'].reduce((sum,key)=>sum+p[key],0);
const boundaryEnergy=(held,p)=>held.reactorPowerMW+p.pumpHeatInputMW+held.heaterPowerMW-p.shutdownCoolingMW
  +(held.feedwaterFlowKgS*p.feedwaterEnthalpyJkg-held.steamFlowKgS*p.steamEnthalpyJkg
    +held.chargingFlowKgS*p.chargingEnthalpyJkg-held.letdownFlowKgS*p.coldLegEnthalpyJkg
    -p.pressurizerVentPowerW-p.secondaryVentPowerW-p.pressurizerWallAmbientPowerW)/1e6;

function inspectRun(run,{step,record,manifest,parameters,rows,protocol}){
  require(run?.completed===true&&run.status==='completed'&&run.stepSeconds===step,'required native run is incomplete');
  equal(run.parameters,parameters,'applied native parameters');
  equal(run.solverRelativeTolerance,protocol.solverRelativeTolerance,'solver tolerance');
  equal(run.requestedSolverRelativeTolerance,protocol.solverRelativeTolerance,'requested solver tolerance');
  require(run.runtime?.model===record.model&&run.runtime.fmuSha256===manifest.fmuSha256,'executed model identity differs');
  if(manifest.compiler!==undefined)equal(run.runtime.compiler,`OpenModelica Compiler ${manifest.compiler}`,'executed compiler identity');
  if(run.runtime.fmiVersion!==undefined)equal(run.runtime.fmiVersion,'2.0','executed FMI version');
  require(run.points?.length===16,'native observations were omitted');
  for(const [index,point]of run.points.entries()){
    keys(point,['time',...channels,...diagnostics],'native observation fields');
    require(finiteRecord(point)&&point.time===index,'native observation grid or finiteness differs');
    requireDomain(point,record.finitePhase,record.wall);
    const spray=Object.hasOwn(parameters,'sprayReferencePressureMPa');
    equal(point.sprayControlEnabled,spray?1:0,'native spray control enabled');
    if(spray){
      const flow=parameters.sprayMaximumFlowKgS*Math.min(1,Math.max(0,parameters.sprayGainFractionPerMPa*(point.primaryPressureMPa-parameters.sprayReferencePressureMPa)));
      close(point.actualSprayFlowKgS,flow,'generic spray-controller flow');
      require(point.sprayCondensationKgS>=0&&point.sprayHeatTransferMW>=0,'spray contact transfer is invalid');
    }else for(const key of ['actualSprayFlowKgS','sprayCondensationKgS','sprayHeatTransferMW'])equal(point[key],0,'zero-spray original case');
  }
  require(Array.isArray(run.boundaryQuadrature)&&run.boundaryQuadrature.length===run.steps&&run.steps>0,'quadrature is truncated');
  require(run.boundaryQuadrature[0].start.time===0&&run.boundaryQuadrature.at(-1).end.time===15,'quadrature window differs');
  let previous=null,massKg=0,energyMJ=0;
  const endpoints=new Map();
  for(const {held,start,end}of run.boundaryQuadrature){
    keys(held,[...inputNames,...Object.keys(controls)],'boundary forcing fields');
    require(finiteRecord(held),'nonfinite forcing');
    for(const key of inputNames)close(held[key],at(rows,start.time,key),'measured forcing',1e-9,1e-12);
    for(const [key,value]of Object.entries(controls))equal(held[key],value,'unmeasured control assumption');
    require(held.reactorPowerMW>=0&&held.reactorPowerMW<=3300&&held.steamFlowKgS>=0&&held.feedwaterFlowKgS>=0,'forcing outside input domain');
    for(const point of [start,end]){keys(point,['time',...primitives],'quadrature primitives');require(finiteRecord(point),'nonfinite quadrature');}
    if(previous)equal(start,previous,'quadrature continuity');
    const delta=end.time-start.time;require(delta>0&&delta<=step+1e-9,'quadrature step differs');
    massKg+=delta*.5*(boundaryMass(held,start)+boundaryMass(held,end));
    energyMJ+=delta*.5*(boundaryEnergy(held,start)+boundaryEnergy(held,end));
    endpoints.set(start.time,start);endpoints.set(end.time,end);previous=end;
  }
  for(const point of run.points)equal(Object.fromEntries(['time',...primitives].map(key=>[key,point[key]])),endpoints.get(point.time),'observations/primitive endpoints');
  compareNumbers(run.integrals,{massKg,energyMJ},'independent quadrature');
  const first=run.points[0],last=run.points.at(-1),errors={};
  for(const [field,inventory,integral,native,error]of [
    ['massIntegralErrorKg','totalMassKg',massKg,'integratedBoundaryMassKg','nativeMassIntegralErrorKg'],
    ['energyIntegralErrorMJ','thermalEnergyMJ',energyMJ,'integratedBoundaryEnergyMJ','nativeEnergyIntegralErrorMJ']]){
    errors[field]=last[inventory]-first[inventory]-integral;
    close(run[field],errors[field],field);within(errors[field],protocol.numericalLimits[field],field);
    for(const point of run.points)within(point[inventory]-first[inventory]-(point[native]-first[native]),protocol.numericalLimits[field],`native ${inventory} ledger`);
    close(run[error],last[inventory]-first[inventory]-(last[native]-first[native]),error);
  }
  return errors;
}

function verifyChannels(actual,expected,label){
  require(actual?.length===4,`${label} held-out channels are missing`);
  for(const [index,scored]of expected.entries()){
    const channel=actual[index],unit=index===0||index===3?'MPa':'°C';
    require(channel.key===scored.key&&channel.name===channelNames[index]&&channel.label===channelNames[index]&&channel.unit===unit,`${label} channel identity differs`);
    require(channel.points?.length===9,`${label} scoring grid differs`);
    channel.points.forEach((point,i)=>compareNumbers(point,scored.points[i],`${label} scored point`));
    compareNumbers(channel.metrics,scored.metrics,`${label} recomputed metrics`);
    if(scored.pressureDiagnostics)compareNumbers(channel.pressureDiagnostics,scored.pressureDiagnostics,`${label} peak diagnostics`);
    else require(channel.pressureDiagnostics===undefined,`${label} unexpected pressure diagnostics`);
  }
}
function verifyChecks(actual,expected,label){
  require(actual?.length===expected.length,`${label} checks were omitted`);
  actual.forEach((check,index)=>compareNumbers(check,expected[index],label));
}
const numericCheck=(name,value,absoluteTolerance)=>({name,value,absoluteTolerance,pass:Math.abs(value)<=absoluteTolerance});

const componentCases=[['cold-nitrogen-equilibrium','ColdNitrogenEquilibrium','vessel',200],
  ['adiabatic-compression','AdiabaticCompression','vessel',30],['vent-headspace','VentHeadspace','vessel',60],
  ['wall-condensation','WallCondensation','vessel',15],['wall-condensation-refined','WallCondensationRefined','vessel',15],
  ['coupled-cold-equilibrium','CoupledColdEquilibrium','coupled',200],['coupled-cold-heating','CoupledColdHeating','coupled',600],
  ['coupled-recirculation-spray','CoupledRecirculationSpray','coupled',30]];
const componentLimits={nativeMassInventoryKg:1e-3,nativeEnergyInventoryMJ:1e-3,independentMassQuadratureKg:1e-3,
  independentEnergyQuadratureMJ:.01,instantaneousMassResidualKgS:1e-8,instantaneousEnergyResidualMW:1e-8,
  coldPressureDriftPa:.1,coldTemperatureDriftK:1e-4,wallRefinementPressureMPa:.001};
const componentCommon=['pressureMPa','liquidTemperatureK','vaporTemperatureK','steamPartialPressurePa','liquidVolumeM3',
  'gasMassKg','vaporMassKg','totalMassKg','totalEnergyMJ','wallEnergyMJ','wallMinimumTemperatureK','wallMaximumTemperatureK',
  'boundaryPowerMW','boundaryMassFlowKgS','integratedBoundaryEnergyMJ','integratedBoundaryMassKg','energyResidualMW','massResidualKgS',
  'heatInputMW','steamVentKgS','gasVentKgS','vaporEnthalpyJkg','wallAmbientPowerMW','valid',
  'actualSprayFlowKgS','sprayCondensationKgS','sprayHeatTransferMW','minimumFilmNusseltArgument'];
const componentVessel=['liquidFlowKgS','liquidEnthalpyJkg','steamFlowKgS'];
const componentCoupled=['pumpHeatMW','heaterPowerMW','shutdownCoolingMW','chargingFlowKgS','letdownFlowKgS',
  'chargingEnthalpyJkg','coldLegEnthalpyJkg','secondarySteamVentKgS','secondaryGasVentKgS','secondaryVaporEnthalpyJkg',
  'secondaryTemperatureK','hotTemperatureK','coldTemperatureK','fuelTemperatureK','primaryFlowKgS','primarySubcoolingK',
  'secondaryPressureMPa','secondaryLevelPercent','secondaryGasMassKg'];
function componentFlux(p,kind){
  const vapor=p.steamVentKgS*p.vaporEnthalpyJkg,gas=p.gasVentKgS*1040*p.vaporTemperatureK;
  if(kind==='vessel')return [p.liquidFlowKgS-p.steamVentKgS-p.gasVentKgS-p.steamFlowKgS,
    (p.liquidFlowKgS*p.liquidEnthalpyJkg-vapor-gas-p.steamFlowKgS*p.vaporEnthalpyJkg)/1e6+p.heatInputMW-p.wallAmbientPowerMW];
  return [p.chargingFlowKgS-p.letdownFlowKgS-p.steamVentKgS-p.gasVentKgS-p.secondarySteamVentKgS-p.secondaryGasVentKgS,
    p.heatInputMW+p.pumpHeatMW+p.heaterPowerMW-p.shutdownCoolingMW-p.wallAmbientPowerMW
    +(p.chargingFlowKgS*p.chargingEnthalpyJkg-p.letdownFlowKgS*p.coldLegEnthalpyJkg-vapor-gas
      -p.secondarySteamVentKgS*p.secondaryVaporEnthalpyJkg-p.secondaryGasVentKgS*1040*p.secondaryTemperatureK)/1e6];
}

export function verifyPressureComponentReport(report){
  require(report?.schema==='openpwr-pressure-component-verification-v1'&&report.executed===true
    &&report.physicalValidationPassed===false&&report.numericalPassed===true,'component evidence identity or pass differs');
  equal(report.scope,'Unmeasured numerical verification of the shared finite-phase pressurizer and coupled cold thermal kernel. No measured component, plant or startup qualification.','component scope');
  require(report.solver==='DASSL'&&report.solverRelativeTolerance===1e-10&&report.modelicaLibrary==='4.0.0','component solver changed');
  equal(report.numericalLimits,componentLimits,'component numerical limits');
  const definitions=componentCases.map(([id,model,kind,durationSeconds])=>({id,model:`PressureComponentChecks.${model}`,kind,durationSeconds,sampleIntervalSeconds:.1}));
  equal(report.scenarioDefinitions,definitions,'component scenario definitions');
  equal(report.scenarios?.map(s=>s.id),definitions.map(s=>s.id),'component scenarios omitted');
  const checks=[];
  for(const [index,scenario]of report.scenarios.entries()){
    const definition=definitions[index],{trace,kind,id}=scenario;
    for(const [key,value]of Object.entries(definition))equal(scenario[key],value,`component ${key}`);
    require(scenario.complete===true&&trace?.length>1&&trace[0].time===0&&trace.at(-1).time===definition.durationSeconds,'component interval incomplete');
    require(scenario.runtime?.solver==='DASSL'&&scenario.runtime.solverRelativeTolerance===1e-10&&scenario.runtime.modelicaLibrary==='4.0.0'
      &&typeof scenario.runtime.compiler==='string'&&scenario.runtime.compiler.trim()
      &&/^[a-f0-9]{64}$/.test(scenario.runtime.executableSha256)&&/^[a-f0-9]{64}$/.test(scenario.runtime.traceCsvSha256),'component runtime identity missing');
    const grid=new Set();let mass=0,energy=0;
    for(const [i,p]of trace.entries()){
      keys(p,['time',...componentCommon,...(kind==='vessel'?componentVessel:componentCoupled)],'component primitive fields');
      require(finiteRecord(p),'nonfinite component observation');
      const [massRate,power]=componentFlux(p,kind);
      close(p.boundaryMassFlowKgS,massRate,'component reported boundary mass',1e-8);
      close(p.boundaryPowerMW,power,'component reported boundary energy',1e-8);
      // Native pre/post-event rows can share a timestamp a few ulps beyond
      // the prescribed event. Preserve both sides within 1 ns of that time.
      const atFiveSecondEvent=Math.abs(p.time-5)<=1e-9;
      if(id==='coupled-recirculation-spray'){
        require(atFiveSecondEvent?[0,.5].includes(p.actualSprayFlowKgS):p.actualSprayFlowKgS===(p.time<5?0:.5),'internal spray forcing differs');
        require(p.sprayCondensationKgS>=0&&p.sprayHeatTransferMW>=0,'internal spray transfer is invalid');
      }else for(const key of ['actualSprayFlowKgS','sprayCondensationKgS','sprayHeatTransferMW'])equal(p[key],0,'unsprayed component boundary');
      const q=p.time/.1;if(Math.abs(q-Math.round(q))<1e-6)grid.add(Math.round(q));
      const ts=saturationTemperature(p.steamPartialPressurePa/1e6),tv=p.vaporTemperatureK,
        b23=348.05185628969+tv*(-1.1671859879975+tv*.0010192970039326);
      require(p.valid===1&&p.pressureMPa>.002&&p.pressureMPa<18&&p.steamPartialPressurePa>611.657&&p.steamPartialPressurePa<19e6
        &&p.liquidVolumeM3>1.5&&p.liquidVolumeM3<48.5&&p.gasMassKg>=-1e-8
        &&p.liquidTemperatureK>=280&&p.liquidTemperatureK<623.15&&p.liquidTemperatureK<ts+2
        &&tv>=280&&tv<800&&tv>ts-2&&(p.steamPartialPressurePa<16.5291643e6||(tv>=623.15&&p.steamPartialPressurePa/1e6<b23)),
      'component finite-phase state leaves its declared domain');
      if(!['adiabatic-compression','vent-headspace','coupled-recirculation-spray'].includes(id))require(p.minimumFilmNusseltArgument>=0&&p.wallMinimumTemperatureK>=273.15&&p.wallMaximumTemperatureK<=1073.15
        &&p.wallMinimumTemperatureK<=p.wallMaximumTemperatureK,'component wall domain differs');
      if(kind==='vessel'){
        equal(p.heatInputMW,0,'component prescribed heat');equal(p.steamFlowKgS,0,'component steam boundary');
        if(id==='adiabatic-compression')require(atFiveSecondEvent?[0,5].includes(p.liquidFlowKgS):p.liquidFlowKgS===(p.time<5?0:5),'compression forcing differs');
        else equal(p.liquidFlowKgS,0,'closed vessel forcing');
      }else{
        const heating=id==='coupled-cold-heating';
        equal(p.heatInputMW,heating?5:0,'coupled prescribed heat');equal(p.heaterPowerMW,heating?.5:0,'coupled heater');
        for(const key of ['chargingFlowKgS','letdownFlowKgS','shutdownCoolingMW'])equal(p[key],0,'coupled prescribed zero boundary');
        require(p.pressureMPa>=.1&&p.pressureMPa<17.5&&p.hotTemperatureK>=280&&p.hotTemperatureK<600
          &&p.coldTemperatureK>=280&&p.coldTemperatureK<590&&p.fuelTemperatureK>=280&&p.fuelTemperatureK<650
          &&p.primarySubcoolingK>3&&p.primaryFlowKgS>=-.1&&p.primaryFlowKgS<=16000
          &&p.secondaryPressureMPa>.002&&p.secondaryPressureMPa<18&&p.secondaryTemperatureK>=280&&p.secondaryTemperatureK<623.15
          &&p.secondaryLevelPercent>3&&p.secondaryLevelPercent<97&&p.secondaryGasMassKg>=-1e-8,'coupled component state domain differs');
      }
      if(i){const a=trace[i-1],dt=p.time-a.time;require(dt>=0&&dt<=.1+1e-7,'component trace truncated or reordered');
        const fa=componentFlux(a,kind),fb=componentFlux(p,kind);mass+=.5*dt*(fa[0]+fb[0]);energy+=.5*dt*(fa[1]+fb[1]);}
    }
    equal([...grid].sort((a,b)=>a-b),Array.from({length:Math.round(definition.durationSeconds/.1)+1},(_,i)=>i),'component regular sample grid');
    const first=trace[0],last=trace.at(-1),maximum=fn=>Math.max(...trace.map(fn));
    const values={nativeMassInventoryKg:maximum(p=>Math.abs(p.totalMassKg-first.totalMassKg-p.integratedBoundaryMassKg+first.integratedBoundaryMassKg)),
      nativeEnergyInventoryMJ:maximum(p=>Math.abs(p.totalEnergyMJ-first.totalEnergyMJ-p.integratedBoundaryEnergyMJ+first.integratedBoundaryEnergyMJ)),
      independentMassQuadratureKg:last.totalMassKg-first.totalMassKg-mass,independentEnergyQuadratureMJ:last.totalEnergyMJ-first.totalEnergyMJ-energy,
      instantaneousMassResidualKgS:maximum(p=>Math.abs(p.massResidualKgS)),instantaneousEnergyResidualMW:maximum(p=>Math.abs(p.energyResidualMW))};
    for(const [key,value]of Object.entries(values))checks.push(numericCheck(`${id} ${key}`,value,componentLimits[key]));
    checks.push(numericCheck(`${id} native domain`,maximum(p=>Math.abs(p.valid-1)),0));
    if(['cold-nitrogen-equilibrium','coupled-cold-equilibrium'].includes(id)){
      checks.push(numericCheck(`${id} coldPressureDriftPa`,maximum(p=>Math.abs(p.pressureMPa-.3)*1e6),.1));
      checks.push(numericCheck(`${id} coldTemperatureDriftK`,maximum(p=>Math.max(Math.abs(p.liquidTemperatureK-313.15),Math.abs(p.vaporTemperatureK-313.15))),1e-4));
    }
    if(id==='adiabatic-compression'){
      checks.push(numericCheck(`${id} prescribed added mass`,last.totalMassKg-first.totalMassKg-125,1e-3));
      checks.push(numericCheck(`${id} compression response`,last.pressureMPa>first.pressureMPa&&last.vaporTemperatureK>last.liquidTemperatureK?0:1,0));
    }
    if(id==='vent-headspace')checks.push(numericCheck(`${id} both species vent`,last.gasMassKg<first.gasMassKg&&maximum(p=>p.gasVentKgS)>0&&maximum(p=>p.steamVentKgS)>0?0:1,0));
    if(id==='coupled-cold-heating')checks.push(numericCheck(`${id} coupled heatup response`,last.hotTemperatureK>first.hotTemperatureK&&last.coldTemperatureK>first.coldTemperatureK?0:1,0));
    if(id==='coupled-recirculation-spray'){
      checks.push(numericCheck(`${id} internal spray condenses steam`,maximum(p=>p.actualSprayFlowKgS)===.5&&maximum(p=>p.sprayCondensationKgS)>0&&maximum(p=>p.sprayHeatTransferMW)>0?0:1,0));
      checks.push(numericCheck(`${id} no external cooling sink`,maximum(p=>Math.abs(p.boundaryPowerMW)),1e-12));
    }
  }
  const coarse=new Map(report.scenarios[3].trace.map(p=>[p.time,p])),fine=new Map(report.scenarios[4].trace.map(p=>[p.time,p]));
  const differences=[...coarse].map(([time,p])=>{require(fine.has(time),'wall mesh comparison sample missing');return Math.abs(p.pressureMPa-fine.get(time).pressureMPa);});
  checks.push(numericCheck('wall mesh pressure refinement',Math.max(...differences),.001));
  require(checks.every(check=>check.pass),'component numerical verification failed');verifyChecks(report.numericalChecks,checks,'component numerical');
  return report;
}

function verifyCase(record,planned,manifest,parameters,rows,protocol){
  for(const key of ['id','model','finitePhase','wall'])equal(record[key],planned[key],`case ${key}`);
  equal(record.buildManifest,manifest,'embedded native manifest');
  require(manifest.model===record.model,'manifest native class differs');
  const checks=[];
  for(const [label,step]of [['nominal',.05],['refined',.025]]){
    const run=record[label],errors=inspectRun(run,{step,record,manifest,parameters,rows,protocol});
    equal(run.caseId,record.id,'native run case');
    checks.push(numericCheck(`${record.id} ${label} completed`,0,0));
    for(const [field,value]of Object.entries(errors))checks.push(numericCheck(`${record.id} ${label} ${field}`,value,protocol.numericalLimits[field]));
    for(const [inventory,integral,limit]of [['totalMassKg','integratedBoundaryMassKg',protocol.numericalLimits.massIntegralErrorKg],
      ['thermalEnergyMJ','integratedBoundaryEnergyMJ',protocol.numericalLimits.energyIntegralErrorMJ]]){
      const first=run.points[0],value=Math.max(...run.points.map(point=>Math.abs(point[inventory]-first[inventory]-(point[integral]-first[integral]))));
      checks.push(numericCheck(`${record.id} ${label} native ${inventory} ledger`,value,limit));
    }
    checks.push(numericCheck(`${record.id} ${label} observed state domain`,0,0));
  }
  const scores=scorePressureTrace(record.nominal.points,record.refined.points,rows);
  verifyChannels(record.channels,scores,record.id);
  for(const [i,channel]of scores.entries()){
    const limit=protocol.numericalLimits[i===0||i===3?'pressureRefinementMPa':'temperatureRefinementK'];
    within(channel.metrics.maximumStepRefinementDifference,limit,'communication refinement');
    checks.push(numericCheck(`${record.id} ${channelNames[i]} communication refinement`,channel.metrics.maximumStepRefinementDifference,limit));
  }
  require(record.numericalPassed===true,'case numerical success is required');
  verifyChecks(record.numericalChecks,checks,`${record.id} numerical`);
  return {scores,checks};
}

export function verifyPressureHistory(report,summary,protocol,rows,baseline){
  equal(report.originalDevelopmentAttempt,summary,'retained original development attempt');
  require(summary.schema==='openpwr-pressure-original-attempt-summary-v1'
    &&summary.historicalReportSha256==='892ccf51a317417b40f9d279dc34d6f3b4acb8bba505aa9abde343b86ed93f87'
    &&summary.historicalReportBytes===6634911&&summary.historicalGitDirty===true,'historical attempt identity differs');
  equal(summary.originalConfigurationSha256,pressureFrozenHashes.parameterSourcesSha256,'historical candidate configuration');
  equal(summary.originalProtocolSha256,pressureFrozenHashes.protocolSha256,'historical protocol');
  equal(summary.cases?.map(record=>record.id),Object.keys(models),'historical cases omitted');
  const checks=[],scores={};
  for(const [i,record]of summary.cases.entries()){
    equal(record.model,models[record.id],'historical native class');
    const traces=field=>times.map((time,index)=>({time,...Object.fromEntries(record.channels.map(channel=>[channel.key,channel.points[index][field]]))}));
    scores[record.id]=scorePressureTrace(traces('simulated'),traces('refined'),rows);
    verifyChannels(record.channels,scores[record.id],'historical');
    for(const [j,channel]of record.channels.entries()){
      const current=report.cases[i].channels[j];equal(current.key,channel.key,'historical reproduction response');
      const value=Math.max(...channel.points.flatMap((point,index)=>['simulated','refined'].map(field=>Math.abs(current.points[index][field]-point[field]))));
      checks.push(numericCheck(`${record.id} ${channelNames[j]} original-attempt reproduction`,value,
        protocol.numericalLimits[j===0||j===3?'equilibriumBaselineDifferenceMPa':'equilibriumBaselineDifferenceK']));
    }
  }
  const baselineScores=scorePressureTrace(baseline.primaryRun.points,baseline.refinedRun.points,rows);
  verifyChecks(summary.pairedGuards.checks,pressurePairedChecks(scores.candidate,scores.equilibrium,baselineScores,protocol),'historical paired guards');
  require(summary.numericalChecks.length===76&&summary.numericalChecks.every(check=>check.pass===true),'original unsuccessful numerical result changed');
  require(checks.every(check=>check.pass),'current zero-spray cases do not reproduce retained original attempt');
  equal(report.originalAttemptReproduced,true,'original attempt reproduction result');
  verifyChecks(report.originalAttemptReproductionChecks,checks,'original attempt reproduction');
  return checks;
}

export function verifyConditionalSpray(report,originals,manifests,protocol,config,sprayConfig,rows,boundaries,baseline){
  require(report?.executed===true,'conditional spray was not executed');
  equal(report.configuration,sprayConfig,'conditional frozen configuration');
  equal(report.configurationSha256,pressureFrozenHashes.conditionalSprayConfigSha256,'conditional configuration digest');
  for(const key of ['physicalValidationPassed','independentValidationPassed','actualPlantControlValidated','defaultPromotionRecommended'])equal(report[key],false,`conditional ${key}`);
  equal(report.scope,'Conditional development comparison with native generic spray feedback, not a measured Krško actuator-history replay. The assumed pressure reference, gain, flow cap and contact efficiency do not validate actual plant controls or full startup.','conditional scope');
  equal(report.assumptions,[sprayConfig.selectionContext,sprayConfig.claimBoundary,...['referenceBasis','gainBasis','capacityBasis','contactBasis','actuatorDynamics'].map(key=>sprayConfig.controller[key])],'conditional assumptions');
  equal(report.cases?.map(record=>record.id),sprayConfig.cases.map(record=>record.id),'conditional nominal/sensitivity selection');
  const baseParameters={...boundaries.initialParameters,...config.commonParameters,geometryScale:1},scores={},checks=[];
  for(const [index,record]of report.cases.entries()){
    const planned={...sprayConfig.cases[index],finitePhase:true,wall:true,conditionalSpray:true};
    for(const key of ['conditionalSpray','gainFractionPerMPa','contactEfficiency'])equal(record[key],planned[key],`conditional ${key}`);
    const manifest=manifests[record.model==='KrskoPressureSpray'?'spray':'spray-refined-wall'];
    require(record.model===planned.model,'conditional executable selection changed');
    const parameters={...baseParameters,sprayReferencePressureMPa:sprayConfig.controller.referencePressureMPa,
      sprayGainFractionPerMPa:planned.gainFractionPerMPa,sprayMaximumFlowKgS:sprayConfig.controller.maximumSprayFlowKgS,
      sprayContactEfficiency:planned.contactEfficiency};
    const result=verifyCase(record,planned,manifest,parameters,rows,protocol);scores[record.id]=result.scores;checks.push(...result.checks);
  }
  const byId=Object.fromEntries(report.cases.map(record=>[record.id,record])),nominal=report.cases[0],fine=report.cases.at(-1),mesh=[];
  for(const [index,key]of channels.entries())for(const step of ['nominal','refined']){
    const value=Math.max(...nominal[step].points.map(point=>Math.abs(point[key]-at(fine[step].points,point.time,key))));
    mesh.push(numericCheck(`${channelNames[index]} ${step} conditional spray wall mesh refinement`,value,
      config.wallMesh[index===0||index===3?'maximumPressureDifferenceMPa':'maximumTemperatureDifferenceK']));
  }
  require(mesh.every(check=>check.pass),'conditional wall mesh verification failed');verifyChecks(report.wallMeshChecks,mesh,'conditional wall mesh');
  checks.push(...mesh);require(report.numericalPassed===true,'conditional numerical success is required');verifyChecks(report.numericalChecks,checks,'conditional numerical');
  const baselineScores=scorePressureTrace(baseline.primaryRun.points,baseline.refinedRun.points,rows),original=Object.fromEntries(originals.map(record=>[record.id,record]));
  require(report.sensitivityGuards?.length===5,'conditional sensitivity guards omitted');
  for(const [index,record]of report.cases.entries()){
    const actual=report.sensitivityGuards[index];equal(actual.id,record.id,'conditional sensitivity identity');
    const expected=pressurePairedChecks(scores[record.id],original.equilibrium.channels,baselineScores,protocol);
    verifyChecks(actual.pairedGuards?.checks,expected,'all conditional paired guards');
    for(const [key,value]of Object.entries({protocolSha256:pressureFrozenHashes.protocolSha256,baselineSha256:pressureFrozenHashes.baselineSha256,
      caseImprovementPassed:expected.every(check=>check.pass),physicalValidationPassed:false,independentValidationPassed:false,
      meaning:protocol.pairedImprovementCriteria.meaning}))equal(actual.pairedGuards[key],value,`conditional paired ${key}`);
  }
  equal(report.pairedGuards,report.sensitivityGuards[0].pairedGuards,'preselected nominal guards');
  const improvement=report.pairedGuards.caseImprovementPassed;equal(report.caseImprovementPassed,improvement,'conditional improvement claim');
  equal(report.status,improvement?'conditional-development-improvement':'conditional-development-no-improvement','conditional status');
  equal(report.conclusion,improvement?
    'The preselected nominal spray assumption passes the relative development guards. Its pressure response is improved conditionally; the actual plant spray history and controls remain unvalidated.':
    'The preselected nominal spray assumption does not establish a guarded development improvement. All sensitivities and adverse changes remain visible; no best-fitting case is substituted.','conditional conclusion');
  const publicChannels=scores[nominal.id].map((channel,index)=>({...channel,
    points:channel.points.map(point=>({...point,baseline:at(baseline.primaryRun.points,point.time,channel.key),
      ...Object.fromEntries([['equilibrium',original.equilibrium],['originalNoSpray',original.candidate],['gainLow',byId['spray-gain-low']],
        ['gainHigh',byId['spray-gain-high']],['contactHalf',byId['spray-contact-half']],['refinedWall',fine]]
        .map(([name,record])=>[name,at(record.nominal.points,point.time,channel.key)]))})),
    metrics:{...channel.metrics,releasedBaselineRmse:baselineScores[index].metrics.rmse,rmseChangeFromBaseline:channel.metrics.rmse-baselineScores[index].metrics.rmse}}));
  verifyChannels(report.channels,publicChannels,'conditional displayed');
  equal(report.trace,nominal.nominal.points,'conditional nominal displayed trace');
  equal(report.runtime,nominal.nominal.runtime,'conditional nominal runtime');equal(report.buildManifest,nominal.buildManifest,'conditional nominal manifest');
  return report;
}

export function verifyKrskoPressureReport(report,manifests,protocol,config,rows,boundaries,baseline){
  require(report?.schema==='openpwr-krsko-pressure-development-v1'&&report.executed===true,'report identity differs');
  require(report.validationPassed===false&&report.physicalValidationPassed===false&&report.independentValidationPassed===false,'physical validation is overclaimed');
  require(report.defaultPromotionRecommended===false&&report.productionDefault==='equilibrium','unqualified production-default promotion');
  equal(report.protocol,protocol,'embedded frozen protocol');equal(report.candidateConfiguration,config,'embedded frozen candidate');
  equal(report.initialBoundaries,boundaries,'embedded initial boundaries');equal(report.releasedBaseline,protocol.baseline,'released baseline identity');
  equal(report.caseId,protocol.caseId,'case identity');equal(report.comparisonWindowS,[0,15],'comparison window');
  equal(report.fixedControlAssumptions,controls,'fixed controls');equal(boundaries.unquantifiedControls,controls,'frozen controls');
  equal(protocol.communicationStepsSeconds,[.05,.025],'communication steps');equal(protocol.solverRelativeTolerance,1e-11,'solver tolerance');
  equal(protocol.reference.metricSampleTimesSeconds,metricTimes,'measured scoring times');
  equal(report.scope,'Development comparison of the shared production thermal kernel with measured core-heat and steam/feedwater boundaries. It excludes kinetics, turbine synchronization, plant controls and complete cold-start validation.','physical scope');
  const parameters={...boundaries.initialParameters,...config.commonParameters,geometryScale:1};
  equal(report.appliedSourceParameters,parameters,'applied source parameters');
  equal(report.cases?.map(record=>record.id),Object.keys(models),'required ablations and refined mesh');
  equal(config.cases.map(record=>record.id),Object.keys(models),'frozen case identities');
  const scores={},checks=[];
  for(const [index,record]of report.cases.entries()){
    equal(record.model,models[record.id],'fixed native class');
    const result=verifyCase(record,config.cases[index],manifests[record.id],parameters,rows,protocol);
    scores[record.id]=result.scores;checks.push(...result.checks);
  }
  const byId=Object.fromEntries(report.cases.map(record=>[record.id,record]));
  equal(report.runtime,byId.candidate.nominal.runtime,'report candidate runtime');equal(report.buildManifest,manifests.candidate,'report candidate manifest');
  equal(report.trace,byId.candidate.nominal.points,'published candidate trace');
  // The byte-frozen historical report is never restamped or substituted with
  // current observations; independently recompute its recorded scoring values.
  const historical=scorePressureTrace(baseline.primaryRun.points,baseline.refinedRun.points,rows);
  for(const [i,channel]of historical.entries())for(const [key,value]of Object.entries(channel.metrics))close(baseline.channels[i].metrics[key],value,`released baseline ${key}`);
  const reproduction=[],mesh=[];
  for(const [index,key]of channels.entries()){
    const pressure=index===0||index===3;
    const value=Math.max(...byId.equilibrium.nominal.points.map(point=>Math.abs(point[key]-at(baseline.primaryRun.points,point.time,key))));
    reproduction.push(numericCheck(`${channelNames[index]} equilibrium baseline reproduction`,value,
      protocol.numericalLimits[pressure?'equilibriumBaselineDifferenceMPa':'equilibriumBaselineDifferenceK']));
    for(const step of ['nominal','refined']){
      const difference=Math.max(...byId.candidate[step].points.map(point=>Math.abs(point[key]-at(byId['refined-wall'][step].points,point.time,key))));
      mesh.push(numericCheck(`${channelNames[index]} ${step} wall mesh refinement`,difference,
        config.wallMesh[pressure?'maximumPressureDifferenceMPa':'maximumTemperatureDifferenceK']));
    }
  }
  require([...reproduction,...mesh].every(check=>check.pass),'baseline reproduction or wall mesh refinement failed');
  verifyChecks(report.baselineReproductionChecks,reproduction,'baseline reproduction');verifyChecks(report.wallMeshChecks,mesh,'wall mesh');
  checks.push(...reproduction,...mesh);
  require(report.numericalPassed===true,'aggregate numerical success is required');verifyChecks(report.numericalChecks,checks,'aggregate numerical');
  const paired=pressurePairedChecks(scores.candidate,scores.equilibrium,historical,protocol),improvement=paired.every(check=>check.pass);
  verifyChecks(report.pairedGuards?.checks,paired,'all 18 paired development guards');
  for(const [key,value]of Object.entries({protocolSha256:pressureFrozenHashes.protocolSha256,baselineSha256:pressureFrozenHashes.baselineSha256,
    caseImprovementPassed:improvement,physicalValidationPassed:false,independentValidationPassed:false,meaning:protocol.pairedImprovementCriteria.meaning}))equal(report.pairedGuards[key],value,`paired guard ${key}`);
  equal(report.caseImprovementPassed,improvement,'case improvement claim');
  equal(report.status,improvement?'development-improvement':'development-no-improvement','development status');
  equal(report.conclusion,improvement?
    'The candidate passes the prospective pressure-improvement and other-channel guards on this previously observed event; independent plant validation remains unestablished.':
    'The candidate does not establish a guarded production-accuracy improvement. Discrepancies and adverse changes are retained; the production equilibrium default remains unchanged.','development conclusion');
  const publicChannels=scores.candidate.map((channel,index)=>({...channel,
    points:channel.points.map(point=>({...point,baseline:at(baseline.primaryRun.points,point.time,channel.key),
      equilibrium:at(byId.equilibrium.nominal.points,point.time,channel.key),noWall:at(byId['no-wall'].nominal.points,point.time,channel.key),
      refinedWall:at(byId['refined-wall'].nominal.points,point.time,channel.key)})),
    metrics:{...channel.metrics,releasedBaselineRmse:historical[index].metrics.rmse,rmseChangeFromBaseline:channel.metrics.rmse-historical[index].metrics.rmse}}));
  verifyChannels(report.channels,publicChannels,'displayed');
  require(report.inputs?.length===3,'measured forcing display is missing');
  for(const [index,name]of inputNames.entries()){
    equal(report.inputs[index].name,name,'forcing display channel');require(report.inputs[index].points?.length===16,'forcing display omitted samples');
    report.inputs[index].points.forEach((point,time)=>compareNumbers(point,{time,value:at(rows,time,name)},'forcing display'));
  }
  return report;
}

export async function verifyKrskoPressureEvidence({root,version,revision}){
  const read=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
  const report=await read('artifacts/krsko-pressure-development.json'),manifests={};
  for(const [id,model]of Object.entries({...models,...sprayModels})){
    const manifest=await read(`artifacts/modelica/krsko-pressure-${id}-manifest.json`);
    require(manifest.model===model&&manifest.fmuSha256===hash(await readFile(resolve(root,`artifacts/modelica/${model}.fmu`))),'current native executable differs');
    manifests[id]=manifest;
  }
  const identities=[report,report.buildManifest,...Object.values(manifests),...(report.cases??[]).map(record=>record.buildManifest),
    report.conditionalSpray?.buildManifest,...(report.conditionalSpray?.cases??[]).map(record=>record.buildManifest)];
  for(const identity of identities)require(identity?.version===version&&(!revision||identity.gitRevision===revision),'evidence belongs to another version/revision');
  for(const [key,path]of Object.entries(krskoPressureSources)){
    const actual=hash(await readFile(resolve(root,path)));
    for(const identity of identities)equal(identity[key],actual,`${key} current source`);
    if(key in pressureFrozenHashes)equal(actual,pressureFrozenHashes[key],`${key} frozen bytes`);
  }
  const protocol=await read(krskoPressureSources.protocolSha256),config=await read(krskoPressureSources.parameterSourcesSha256),
    boundaries=await read(krskoPressureSources.initialBoundariesSha256),baseline=await read(krskoPressureSources.baselineSha256);
  require(baseline.version===protocol.baseline.version&&baseline.gitRevision===protocol.baseline.gitRevision&&baseline.gitDirty===false
    &&baseline.runtime.fmuSha256===protocol.baseline.fmuSha256,'historical baseline identity changed');
  equal((await readFile(resolve(root,krskoPressureSources.baselineSha256))).length,protocol.baseline.bytes,'baseline byte count');
  for(const [pathKey,hashKey]of [['previousParameterLedger','previousParameterLedgerSha256'],['measurementProvenance','measurementProvenanceSha256'],['sourceLedger','sourceLedgerSha256']])
    equal(hash(await readFile(resolve(root,boundaries[pathKey]))),boundaries[hashKey],`initial boundary ${pathKey}`);
  const ledger=await read(boundaries.previousParameterLedger);
  equal(boundaries.initialParameters,Object.fromEntries(ledger.parameters.map(item=>[item.parameter,item.value])),'original initial parameter values');
  equal(report.sourceAudit,await read(krskoPressureSources.sourceAuditSha256),'embedded source audit');
  equal(report.regularizationAmendment,await read(krskoPressureSources.regularizationAmendmentSha256),'accepted-model regularization and historical archive disclosure');
  equal(report.coordinateAmendment,await read(krskoPressureSources.coordinateAmendmentSha256),'exact state coordinate disclosure');
  equal(report.finalNumericsAmendment,await read(krskoPressureSources.finalNumericsAmendmentSha256),'final numerical selection disclosure');
  const metadata=await read(krskoPressureSources.referenceMetadataSha256);
  equal(report.source,metadata.source,'source attribution');equal(report.sourceURL,metadata.source.url,'source URL');
  equal(report.dataURL,baseline.dataURL,'measured data link');
  const lines=(await readFile(resolve(root,krskoPressureSources.inputDataSha256),'utf8')).trim().split(/\r?\n/),header=lines.shift().split(',');
  const rows=lines.map(line=>Object.fromEntries(line.split(',').map((value,index)=>[header[index],Number(value)])));
  const componentBytes=await readFile(resolve(root,'artifacts/pressure-component-verification.json'));
  equal(report.componentVerificationSha256,hash(componentBytes),'executed component report bytes');
  const component=JSON.parse(componentBytes.toString('utf8'));
  equal(report.componentVerification,component,'embedded component verification');
  require(component.version===version&&(!revision||component.gitRevision===revision),'component evidence belongs to another version/revision');
  for(const key of ['pressureSourceSha256','coldSourceSha256','componentModelSha256','componentScriptSha256'])equal(component[key],report[key],`component ${key}`);
  verifyPressureComponentReport(component);
  verifyKrskoPressureReport(report,manifests,protocol,config,rows,boundaries,baseline);
  verifyPressureHistory(report,await read(krskoPressureSources.originalAttemptSummarySha256),protocol,rows,baseline);
  verifyConditionalSpray(report.conditionalSpray,report.cases,manifests,protocol,config,
    await read(krskoPressureSources.conditionalSprayConfigSha256),rows,boundaries,baseline);
  return report;
}
