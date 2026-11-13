"""Reproducible numerical checks of the shared finite-phase pressure component.

These unmeasured experiments check conservation, closed equilibrium, gas vent
enthalpy, compression and wall discretization. They do not qualify plant physics.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import csv
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import signal
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/pressure-component-verification.json'
SOURCES = {
    'pressureSourceSha256': 'models/FinitePhasePressurizer.mo',
    'coldSourceSha256': 'models/ColdStartPlant.mo',
    'componentModelSha256': 'models/PressureComponentChecks.mo',
    'componentScriptSha256': 'validation/krsko_pressure/component_checks.py',
}
COMMON = ('pressureMPa', 'liquidTemperatureK', 'vaporTemperatureK', 'steamPartialPressurePa',
    'liquidVolumeM3', 'gasMassKg', 'vaporMassKg', 'totalMassKg', 'totalEnergyMJ',
    'wallEnergyMJ', 'wallMinimumTemperatureK', 'wallMaximumTemperatureK', 'minimumFilmNusseltArgument',
    'boundaryPowerMW', 'boundaryMassFlowKgS', 'integratedBoundaryEnergyMJ',
    'integratedBoundaryMassKg', 'energyResidualMW', 'massResidualKgS',
    'heatInputMW', 'steamVentKgS', 'gasVentKgS', 'vaporEnthalpyJkg', 'wallAmbientPowerMW',
    'actualSprayFlowKgS', 'sprayCondensationKgS', 'sprayHeatTransferMW', 'valid')
VESSEL = ('liquidFlowKgS', 'liquidEnthalpyJkg', 'steamFlowKgS')
COUPLED = ('pumpHeatMW', 'heaterPowerMW', 'shutdownCoolingMW', 'chargingFlowKgS',
    'letdownFlowKgS', 'chargingEnthalpyJkg', 'coldLegEnthalpyJkg',
    'secondarySteamVentKgS', 'secondaryGasVentKgS', 'secondaryVaporEnthalpyJkg',
    'secondaryTemperatureK', 'hotTemperatureK', 'coldTemperatureK', 'fuelTemperatureK',
    'primaryFlowKgS', 'primarySubcoolingK', 'secondaryPressureMPa', 'secondaryLevelPercent', 'secondaryGasMassKg')
CASES = (
    ('cold-nitrogen-equilibrium', 'ColdNitrogenEquilibrium', 'vessel', 200),
    ('adiabatic-compression', 'AdiabaticCompression', 'vessel', 30),
    ('vent-headspace', 'VentHeadspace', 'vessel', 60),
    ('wall-condensation', 'WallCondensation', 'vessel', 15),
    ('wall-condensation-refined', 'WallCondensationRefined', 'vessel', 15),
    ('coupled-cold-equilibrium', 'CoupledColdEquilibrium', 'coupled', 200),
    ('coupled-cold-heating', 'CoupledColdHeating', 'coupled', 600),
    ('coupled-recirculation-spray', 'CoupledRecirculationSpray', 'coupled', 30),
)
LIMITS = {'nativeMassInventoryKg': 1e-3, 'nativeEnergyInventoryMJ': 1e-3,
    'independentMassQuadratureKg': 1e-3, 'independentEnergyQuadratureMJ': .01,
    'instantaneousMassResidualKgS': 1e-8, 'instantaneousEnergyResidualMW': 1e-8,
    'coldPressureDriftPa': .1, 'coldTemperatureDriftK': 1e-4,
    'wallRefinementPressureMPa': .001}
SAMPLE_INTERVAL = .1
SOLVER_TOLERANCE = 1e-10
CASE_TIMEOUT_SECONDS = 180


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity():
    return {'version': json.loads((ROOT / 'package.json').read_text())['version'],
        'gitRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'gitDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
        **{key: sha(ROOT / path) for key, path in SOURCES.items()}}


def independent_flux(point, kind):
    """Primitive boundary flux; never use the model's reported total rate."""
    vapor_loss = point['steamVentKgS']*point['vaporEnthalpyJkg']
    gas_loss = point['gasVentKgS']*(743.2+296.8)*point['vaporTemperatureK']
    if kind == 'vessel':
        mass = point['liquidFlowKgS']-point['steamVentKgS']-point['gasVentKgS']-point['steamFlowKgS']
        energy = (point['liquidFlowKgS']*point['liquidEnthalpyJkg']-vapor_loss-gas_loss
                  -point['steamFlowKgS']*point['vaporEnthalpyJkg'])/1e6+point['heatInputMW']-point['wallAmbientPowerMW']
    else:
        mass = point['chargingFlowKgS']-point['letdownFlowKgS']-point['steamVentKgS']-point['gasVentKgS']
        mass -= point['secondarySteamVentKgS']+point['secondaryGasVentKgS']
        energy = point['heatInputMW']+point['pumpHeatMW']+point['heaterPowerMW']-point['shutdownCoolingMW']-point['wallAmbientPowerMW']
        energy += (point['chargingFlowKgS']*point['chargingEnthalpyJkg']-point['letdownFlowKgS']*point['coldLegEnthalpyJkg']
            -vapor_loss-gas_loss-point['secondarySteamVentKgS']*point['secondaryVaporEnthalpyJkg']
            -point['secondaryGasVentKgS']*(743.2+296.8)*point['secondaryTemperatureK'])/1e6
    return mass, energy


def numerical_checks(scenarios):
    checks = []
    def check(name, value, limit):
        checks.append({'name': name, 'value': value, 'absoluteTolerance': limit,
                       'pass': math.isfinite(value) and abs(value) <= limit})
    by_id = {scenario['id']: scenario for scenario in scenarios}
    for scenario in scenarios:
        trace, case_id = scenario['trace'], scenario['id']
        first, last = trace[0], trace[-1]
        native_mass = max(abs(p['totalMassKg']-first['totalMassKg']-p['integratedBoundaryMassKg']+first['integratedBoundaryMassKg']) for p in trace)
        native_energy = max(abs(p['totalEnergyMJ']-first['totalEnergyMJ']-p['integratedBoundaryEnergyMJ']+first['integratedBoundaryEnergyMJ']) for p in trace)
        mass, energy = 0.0, 0.0
        for a, b in zip(trace, trace[1:]):
            fa, fb = independent_flux(a, scenario['kind']), independent_flux(b, scenario['kind'])
            delta = b['time']-a['time']
            mass += .5*delta*(fa[0]+fb[0])
            energy += .5*delta*(fa[1]+fb[1])
        values = {'nativeMassInventoryKg': native_mass, 'nativeEnergyInventoryMJ': native_energy,
            'independentMassQuadratureKg': last['totalMassKg']-first['totalMassKg']-mass,
            'independentEnergyQuadratureMJ': last['totalEnergyMJ']-first['totalEnergyMJ']-energy,
            'instantaneousMassResidualKgS': max(abs(p['massResidualKgS']) for p in trace),
            'instantaneousEnergyResidualMW': max(abs(p['energyResidualMW']) for p in trace)}
        for key, value in values.items():
            check(case_id+' '+key, value, LIMITS[key])
        check(case_id+' native domain', max(abs(p['valid']-1) for p in trace), 0)
        if case_id in ('cold-nitrogen-equilibrium', 'coupled-cold-equilibrium'):
            check(case_id+' coldPressureDriftPa', max(abs(p['pressureMPa']-.3)*1e6 for p in trace), LIMITS['coldPressureDriftPa'])
            check(case_id+' coldTemperatureDriftK', max(abs(p[key]-313.15) for p in trace
                for key in ('liquidTemperatureK', 'vaporTemperatureK')), LIMITS['coldTemperatureDriftK'])
        if case_id == 'adiabatic-compression':
            check(case_id+' prescribed added mass', last['totalMassKg']-first['totalMassKg']-125, LIMITS['nativeMassInventoryKg'])
            check(case_id+' compression response', 0 if last['pressureMPa']>first['pressureMPa'] and last['vaporTemperatureK']>last['liquidTemperatureK'] else 1, 0)
        if case_id == 'vent-headspace':
            check(case_id+' both species vent', 0 if last['gasMassKg']<first['gasMassKg'] and max(p['gasVentKgS'] for p in trace)>0
                  and max(p['steamVentKgS'] for p in trace)>0 else 1, 0)
        if case_id == 'coupled-cold-heating':
            check(case_id+' coupled heatup response', 0 if last['hotTemperatureK']>first['hotTemperatureK'] and last['coldTemperatureK']>first['coldTemperatureK'] else 1, 0)
        if case_id == 'coupled-recirculation-spray':
            check(case_id+' internal spray condenses steam', 0 if max(p['actualSprayFlowKgS'] for p in trace)==.5
                and max(p['sprayCondensationKgS'] for p in trace)>0 and max(p['sprayHeatTransferMW'] for p in trace)>0 else 1, 0)
            check(case_id+' no external cooling sink', max(abs(p['boundaryPowerMW']) for p in trace), 1e-12)
    coarse = {p['time']: p for p in by_id['wall-condensation']['trace']}
    fine = {p['time']: p for p in by_id['wall-condensation-refined']['trace']}
    check('wall mesh pressure refinement', max(abs(p['pressureMPa']-fine[time]['pressureMPa']) for time, p in coarse.items()), LIMITS['wallRefinementPressureMPa'])
    return checks


def verify_trace(trace, kind, duration):
    expected = {'time', *COMMON, *(VESSEL if kind == 'vessel' else COUPLED)}
    if not trace or trace[0]['time'] != 0 or trace[-1]['time'] != duration:
        raise ValueError('Component check did not complete its declared window.')
    if any(set(point) != expected or any(not math.isfinite(value) for value in point.values()) for point in trace):
        raise ValueError('Component trace has missing/nonfinite primitive diagnostics.')
    if any(not 0 <= b['time']-a['time'] <= SAMPLE_INTERVAL+1e-7 for a, b in zip(trace, trace[1:])):
        raise ValueError('Component trace is truncated or reordered.')
    # Native event samples may repeat a timestamp; retain both sides of jumps.
    grid = {round(point['time']/SAMPLE_INTERVAL) for point in trace
            if abs(point['time']/SAMPLE_INTERVAL-round(point['time']/SAMPLE_INTERVAL)) < 1e-6}
    if grid != set(range(round(duration/SAMPLE_INTERVAL)+1)):
        raise ValueError('Component trace is missing a regular sample.')


def run():
    current = identity()
    compiler = os.environ.get('OPENPWR_OMC', 'omc')
    compiler_version = subprocess.check_output([compiler, '--version'], text=True).strip()
    scenarios = []
    artifact_dir = ROOT / 'artifacts/pressure-components'
    artifact_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='openpwr-pressure-components-') as directory:
        work = Path(directory)
        loads = ['loadModel(Modelica,{"4.0.0"},requireExactVersion=true);', 'getErrorString();']
        for path in ('models/FinitePhasePressurizer.mo', 'models/ColdStartPlant.mo', 'models/PressureComponentChecks.mo'):
            loads += [f'loadFile({json.dumps((ROOT / path).as_posix())});', 'getErrorString();']
        for case_id, name, kind, duration in CASES:
            model = 'PressureComponentChecks.'+name
            prefix = case_id.replace('-', '_')
            names = ['time', *COMMON, *(VESSEL if kind == 'vessel' else COUPLED)]
            model_filter = '^('+'|'.join(names)+')$'
            script = work / (prefix+'.mos')
            script.write_text('\n'.join([*loads,
                f'simulate({model},startTime=0,stopTime={duration},numberOfIntervals={round(duration/SAMPLE_INTERVAL)},'
                f'tolerance={SOLVER_TOLERANCE},method="dassl",outputFormat="csv",fileNamePrefix="{prefix}",'
                f'variableFilter={json.dumps(model_filter)});', 'getErrorString();']), encoding='utf-8')
            log_path = artifact_dir / (case_id+'-build.log')
            timed_out = False
            with log_path.open('w', encoding='utf-8') as log_stream:
                process = subprocess.Popen([compiler, str(script)], cwd=work,
                    stdout=log_stream, stderr=subprocess.STDOUT,
                    start_new_session=os.name != 'nt',
                    env={**os.environ, 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'})
                try:
                    returncode = process.wait(timeout=CASE_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, check=False)
                    else:
                        os.killpg(process.pid, signal.SIGTERM)
                    returncode = process.wait(timeout=10)
            log = log_path.read_text(encoding='utf-8')
            csv_path = work / (prefix+'_res.csv')
            if timed_out or returncode or 'The simulation finished successfully.' not in log or not csv_path.is_file():
                saved_partial = artifact_dir / (case_id+'-partial.csv')
                if csv_path.is_file():
                    saved_partial.write_bytes(csv_path.read_bytes())
                failure = {'schema': 'openpwr-pressure-component-failure-v1', **current,
                    'generatedAt': datetime.now(timezone.utc).isoformat(), 'executed': True,
                    'physicalValidationPassed': False, 'numericalPassed': False,
                    'failedScenario': case_id, 'completedScenarios': scenarios,
                    'timedOut': timed_out, 'timeoutSeconds': CASE_TIMEOUT_SECONDS, 'returnCode': returncode,
                    'solver': 'DASSL', 'solverRelativeTolerance': SOLVER_TOLERANCE,
                    'compiler': compiler_version, 'logSha256': sha(log_path),
                    'partialCsvSha256': sha(saved_partial) if saved_partial.is_file() else None}
                failure_text = json.dumps(failure, indent=2)+'\n'
                (artifact_dir / (case_id+'-failure.json')).write_text(failure_text, encoding='utf-8')
                OUTPUT.write_text(failure_text, encoding='utf-8')
                raise RuntimeError('Native component check failed: '+case_id+'; log and partial evidence retained.')
            with csv_path.open(newline='', encoding='utf-8') as stream:
                trace = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(stream)]
            verify_trace(trace, kind, duration)
            saved_csv = artifact_dir / (case_id+'.csv')
            saved_csv.write_bytes(csv_path.read_bytes())
            scenarios.append({'id': case_id, 'model': model, 'kind': kind, 'complete': True,
                'durationSeconds': duration, 'sampleIntervalSeconds': SAMPLE_INTERVAL,
                'runtime': {'compiler': compiler_version, 'solver': 'DASSL', 'solverRelativeTolerance': SOLVER_TOLERANCE,
                    'modelicaLibrary': '4.0.0', 'executableSha256': sha(work / (prefix+('.exe' if os.name == 'nt' else ''))), 'traceCsvSha256': sha(saved_csv)},
                'trace': trace})
            print('Completed component check', case_id, flush=True)
    if any(identity()[key] != value for key, value in current.items() if key.endswith('Sha256')):
        raise RuntimeError('Component verification source changed during execution; rerun.')
    checks = numerical_checks(scenarios)
    report = {'schema': 'openpwr-pressure-component-verification-v1', **current,
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'executed': True,
        'scope': 'Unmeasured numerical verification of the shared finite-phase pressurizer and coupled cold thermal kernel. No measured component, plant or startup qualification.',
        'physicalValidationPassed': False, 'solver': 'DASSL', 'solverRelativeTolerance': SOLVER_TOLERANCE,
        'modelicaLibrary': '4.0.0', 'numericalLimits': LIMITS,
        'scenarioDefinitions': [{'id': case_id, 'model': 'PressureComponentChecks.'+model, 'kind': kind,
            'durationSeconds': duration, 'sampleIntervalSeconds': SAMPLE_INTERVAL} for case_id, model, kind, duration in CASES],
        'scenarios': scenarios, 'numericalChecks': checks,
        'numericalPassed': all(check['pass'] for check in checks)}
    OUTPUT.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(f"Component numerical checks {sum(check['pass'] for check in checks)}/{len(checks)}", flush=True)
    for check in checks:
        if not check['pass']:
            print('FAILED', check, flush=True)
    if not report['numericalPassed']:
        raise RuntimeError('Component numerical verification failed; report retained.')
    return report


if __name__ == '__main__':
    run()
