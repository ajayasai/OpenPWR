// SPDX-License-Identifier: Apache-2.0
// Publication checks are independent of the verifier's reported pass flags.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

export const continuousSources = {
  sourceSha256:'models/OpenPWR/package.mo', coldSourceSha256:'models/ColdStartPlant.mo',
  pressureSourceSha256:'models/FinitePhasePressurizer.mo',
  continuousSourceSha256:'models/ContinuousPlant.mo', verificationScriptSha256:'backend/verify_continuous.py',
  sharedRunnerSha256:'validation/native_fmi.py', hostScriptSha256:'backend/fmi_host.py',
  profileScriptSha256:'backend/profiles.py', experimentScriptSha256:'backend/experiments.py',
  protocolSha256:'validation/continuous/protocol.json',
  initialProtocolSha256:'validation/continuous/protocol-initial.json',
  kineticsOracleSha256:'backend/verify_plant.py', coldVerifierSha256:'backend/verify_cold.py',
  commonVerifierSha256:'backend/verify.py',
  kineticsReferenceSha256:'validation/continuous/kinetics-reference.json',
  buildScriptSha256:'scripts/modelica/build.py', packagingScriptSha256:'scripts/modelica/package_fmu.py',
};
const require = (condition,message) => {if (!condition) throw new Error(message);};
const small = (value,limit,label) => require(Number.isFinite(value) && Math.abs(value)<=limit, `Continuous startup ${label} exceeds its declared limit`);
const bounded = (value,range,label) => require(Number.isFinite(value) && value>=range[0] && value<=range[1], `Continuous startup ${label} is outside its declared range`);
const thermal = ['coldLegTemperatureC','hotLegTemperatureC','fuelTemperatureC','pressurizerTemperatureC','secondaryTemperatureC'];

export function verifyContinuousReport(report,manifest,protocol,reference) {
  require(report.physicalValidationPassed===false && typeof report.operatingEnvelope==='string' && report.operatingEnvelope.trim(), 'Continuous startup scope is missing or overclaimed');
  require(Array.isArray(report.checks) && report.checks.length && report.passed===report.checks.length && report.total===report.checks.length
    && report.checks.every(c=>c.pass===true && typeof c.name==='string' && c.name.trim() && Number.isFinite(c.value)
      && Number.isFinite(c.absoluteTolerance) && c.absoluteTolerance>=0 && Math.abs(c.value)<=c.absoluteTolerance), 'Continuous startup numerical checks are incomplete or unsuccessful');
  require(Array.isArray(report.scenarios) && report.scenarios.length, 'Continuous startup scenarios are missing');
  const cases = new Map(report.scenarios.map(s=>[s.id,s]));
  require(cases.size===report.scenarios.length && new Set(report.scenarios.map(s=>s.name)).size===cases.size, 'Continuous startup scenario identities are duplicated');
  for (const s of report.scenarios) {
    require(s.complete===true && typeof s.name==='string' && s.name.trim() && s.runtime?.model===manifest.model
      && s.runtime.fmuSha256===manifest.fmuSha256 && Number.isFinite(s.durationSeconds) && s.durationSeconds>0
      && Number.isFinite(s.stepSeconds) && s.stepSeconds>0 && Number.isFinite(s.sampleIntervalSeconds)
      && s.sampleIntervalSeconds>=s.stepSeconds && Array.isArray(s.trace) && s.trace.length>=2
      && s.trace.length===Math.round(s.durationSeconds/s.sampleIntervalSeconds)+1
      && s.trace.every((p,i)=>p && Object.values(p).every(Number.isFinite)
        && Math.abs(p.time-i*s.sampleIntervalSeconds)<1e-8)
      && Math.abs(s.trace.at(-1).time-s.durationSeconds)<1e-8, `Continuous startup observations are incomplete: ${s.id}`);
  }
  for (const id of [...protocol.kinetics.requiredCases,...protocol.synchronization.requiredCases,
    'cats-negative-half-dollar','cats-negative-one-dollar','trip-stop-valve','full-startup','full-startup-refined','startup-trip']) {
    require(cases.has(id), `Continuous startup required scenario is missing: ${id}`);
  }
  require(cases.has('source-removal'), 'Continuous startup source-removal evidence is missing');
  require(report.checks.filter(c=>c.category==='published-kinetics').length===12, 'Continuous startup published kinetics checks are missing');
  for (const c of reference.cases) {
    const observed=cases.get(c.id);
    require(observed.parameters?.initialNeutronFraction===reference.initialNeutronFraction
      && observed.parameters?.generationTimeSeconds===reference.generationTimeSeconds
      && observed.parameters?.initialRodReactivityPcm===c.reactivityPcm
      && observed.parameters?.thermalFeedbackScale===0, 'Continuous startup published kinetics parameters differ');
    for (let i=0;i<6;i++) require(observed.parameters[`beta[${i+1}]`]===reference.delayedFractions[i]
      && observed.parameters[`lambda[${i+1}]`]===reference.decayConstantsPerSecond[i], 'Continuous startup published delayed-neutron parameters differ');
    for (const [seconds,expected] of c.samples) {
      const p=observed.trace.find(p=>Math.abs(p.time-seconds)<1e-8);
      small((p?.neutronPowerFraction/reference.initialNeutronFraction-expected)/expected,reference.relativeTolerance,'published kinetics comparison');
      require(p?.externalSourceFractionPerSecond===0, 'Continuous startup published kinetics has an external source');
    }
  }
  const stopCase=cases.get('trip-stop-valve');
  require(stopCase.durationSeconds>=3 && stopCase.sampleIntervalSeconds<=.05
    && stopCase.controlSchedule?.some(e=>e.time===1 && e.controls.turbineTripCommand===1), 'Continuous startup lacks a resolved stop-valve transient');
  for (const p of stopCase.trace) small(p.stopValveFraction-Math.exp(-Math.max(0,p.time-1)/.2),2e-6,'independent stop-valve response');
  const limits=protocol.fullTrajectory, coarse=cases.get('full-startup'), fine=cases.get('full-startup-refined');
  require(coarse.stepSeconds===limits.communicationStepsSeconds[0] && fine.stepSeconds===limits.communicationStepsSeconds[1]
    && coarse.durationSeconds===fine.durationSeconds && coarse.sampleIntervalSeconds===fine.sampleIntervalSeconds,
    'Continuous startup refinement protocol differs');
  require(Array.isArray(coarse.controlSchedule) && coarse.controlSchedule.length
    && JSON.stringify(coarse.controlSchedule)===JSON.stringify(fine.controlSchedule), 'Continuous startup comparison uses different control schedules');
  for (const s of [coarse,fine,cases.get('startup-trip')]) {
    require(s.singleFmuInstance===true && s.resetCount===0 && s.parameters && Object.keys(s.parameters).length===0,
      'Continuous startup requires one default-initialized native instance without resets');
    const first=s.trace[0], last=s.trace.at(-1);
    for (const k of thermal) small(first[k]-limits.requiredInitialPrimaryTemperatureC,limits.requiredInitialPrimaryTemperatureToleranceK,`cold initial ${k}`);
    require(first.gridConnected===0 && first.reactivityPcm<0 && first.neutronPowerFraction>0, 'Continuous startup is not initially subcritical and disconnected');
    small(first.turbineRpm,1e-8,'initial shaft speed');
    for (const p of s.trace) {
      small(p.totalPlantStoredEnergyMJ-first.totalPlantStoredEnergyMJ-(p.integratedPlantBoundaryEnergyMJ-first.integratedPlantBoundaryEnergyMJ), limits.nativeEnergyInventoryAbsoluteToleranceMJ,'energy inventory');
      small(p.totalPlantMassKg-first.totalPlantMassKg-(p.integratedPlantBoundaryMassKg-first.integratedPlantBoundaryMassKg), limits.nativeMassInventoryAbsoluteToleranceKg,'mass inventory');
      small(p.rotorEnergyMJ-4200*(p.turbineRpm/3000)**2,protocol.synchronization.rotorEnergyIdentityAbsoluteToleranceMJ,'rotor energy identity');
      small(p.plantEnergyResidualMW,limits.instantaneousEnergyResidualAbsoluteToleranceMW,'energy residual');
      small(p.plantMassResidualKgS,limits.instantaneousMassResidualAbsoluteToleranceKgS,'mass residual');
      require(p.primarySubcoolingK>=limits.minimumPrimarySubcoolingK && p.neutronPowerFraction>=0, 'Continuous startup leaves the physical acceptance envelope');
    }
    small(last.totalPlantStoredEnergyMJ-first.totalPlantStoredEnergyMJ-s.boundaryQuadrature?.externalEnergyMJ,limits.independentBoundaryQuadratureEnergyAbsoluteToleranceMJ,'independent energy quadrature');
    small(last.totalPlantMassKg-first.totalPlantMassKg-s.boundaryQuadrature?.externalMassKg,limits.independentBoundaryQuadratureMassAbsoluteToleranceKg,'independent mass quadrature');
  }
  for (const s of [coarse,fine]) {
    const closure=s.trace.at(-1);
    bounded(closure.breakerClosingTimeS,[5,s.durationSeconds],'breaker closing time');
    small(closure.breakerClosingPhaseDeg,.5,'breaker closing phase');
    small(closure.breakerClosingFrequencyHz,.002,'breaker closing frequency');
    small(closure.breakerClosingVoltagePu-1,.01,'breaker closing voltage');
    require(closure.breakerClosingDwellS>=5, 'Continuous startup breaker closed before the synchronizing dwell');
    const plateau=s.trace.filter(p=>p.time>=s.durationSeconds-limits.requiredFinalDwellSeconds);
    require(plateau.length>=2 && plateau[0].time<=s.durationSeconds-limits.requiredFinalDwellSeconds,
      'Continuous startup lacks the complete full-power dwell');
    for (const p of plateau) {
      bounded(p.netPowerMW,limits.finalNetPowerRangeMW,'sustained net power');
      bounded(p.neutronPowerFraction,limits.finalNeutronPowerFractionRange,'sustained neutron population');
      require(p.gridConnected===1 && p.externalSourceFractionPerSecond===0 && p.fullPowerReady===1,
        'Continuous startup does not sustain source-free grid-connected full power');
    }
  }
  const fineByTime=new Map(fine.trace.map(p=>[p.time,p]));
  for (const [key,limit] of [...thermal.map(k=>[k,limits.maximumThermalRefinementDifferenceK]),
    ['primaryPressureMPa',limits.maximumPressureRefinementDifferenceMPa],['secondaryPressureMPa',limits.maximumPressureRefinementDifferenceMPa],
    ['netPowerMW',limits.maximumNetPowerRefinementDifferenceMW],['turbineRpm',limits.maximumTurbineRefinementDifferenceRpm],
    ['neutronPowerFraction',limits.maximumNeutronFractionRefinementDifference]]) {
    for (const p of coarse.trace) small(p[key]-fineByTime.get(p.time)?.[key],limit,`${key} timestep refinement`);
  }
  for (const id of protocol.synchronization.requiredCases.filter(id=>id.startsWith('sync-reject-'))) {
    require(cases.get(id).trace.every(p=>p.gridConnected===0), `Continuous startup accepted an invalid synchronization: ${id}`);
  }
  require(cases.get('sync-accept').trace.some(p=>p.gridConnected===1), 'Continuous startup never accepts a valid synchronization');
  const trip=cases.get('startup-trip'), tripped=trip.trace.at(-1);
  require(trip.durationSeconds>coarse.durationSeconds && trip.controlSchedule?.length===coarse.controlSchedule.length+1
    && JSON.stringify(trip.controlSchedule.slice(0,-1))===JSON.stringify(coarse.controlSchedule)
    && trip.controlSchedule.at(-1).time===coarse.durationSeconds
    && trip.controlSchedule.at(-1).controls.tripCommand===1, 'Continuous startup trip does not continue the complete startup schedule');
  const beforeTrip=trip.trace.find(p=>p.time===coarse.durationSeconds);
  require(beforeTrip && beforeTrip.fullPowerReady===1 && beforeTrip.gridConnected===1,
    'Continuous startup trip never reaches full power before tripping');
  require(tripped.reactorTripped===1 && tripped.turbineTripped===1 && tripped.gridConnected===0
    && tripped.neutronPowerFraction>0 && tripped.neutronPowerFraction<.01*beforeTrip.neutronPowerFraction
    && tripped.decayHeatMW>0 && tripped.externalSourceFractionPerSecond===0,
    'Continuous startup trip response is missing or physically inconsistent');
  small(tripped.stopValveFraction,2e-6,'trip stop-valve isolation');
  return report;
}

export async function verifyContinuousEvidence({root,version,revision}) {
  const read = async path => JSON.parse(await readFile(resolve(root,path),'utf8'));
  const hash = async path => createHash('sha256').update(await readFile(resolve(root,path))).digest('hex');
  const report=await read('artifacts/continuous-verification.json'), manifest=await read('artifacts/modelica/continuous-manifest.json');
  const binaryHash=await hash('artifacts/modelica/ContinuousPlant.fmu');
  for (const identity of [report,manifest,report.buildManifest]) require(identity && identity.version===version
    && (!revision || identity.gitRevision===revision), 'Continuous startup evidence belongs to a different version or revision');
  require(manifest.model==='ContinuousPlant' && report.buildManifest.model===manifest.model && report.runtime?.model===manifest.model
    && manifest.fmuSha256===binaryHash && report.runtime.fmuSha256===binaryHash && report.buildManifest.fmuSha256===binaryHash,
    'Continuous startup evidence identifies a different executable');
  for (const [key,path] of Object.entries(continuousSources)) {
    const actual=await hash(path);
    require(manifest[key]===actual && report.buildManifest[key]===actual, `Continuous startup ${key} is stale`);
  }
  return verifyContinuousReport(report,manifest,await read('validation/continuous/protocol.json'),await read('validation/continuous/kinetics-reference.json'));
}
