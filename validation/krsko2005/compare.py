"""Unfitted Krško boundary replay with a controlled pressure-model ablation."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations
import argparse
import csv
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'validation'))
from native_fmi import NativeDomainExit, build_case, run_case, sha

COMMON = ROOT / 'models/OpenPWR/package.mo'
MODEL = ROOT / 'models/KrskoTransient.mo'
DATA = HERE / 'measured.csv'
PROVENANCE = HERE / 'provenance.json'
PARAMETERS = HERE / 'reference-plant.json'
BASELINE = ROOT / 'validation/baselines/krsko-v0.5.json'
FMU = ROOT / 'artifacts/modelica/KrskoTransient.fmu'
MANIFEST = ROOT / 'artifacts/modelica/krsko-manifest.json'
EQUILIBRIUM_FMU = FMU.with_name('KrskoEquilibrium.fmu')
EQUILIBRIUM_MANIFEST = MANIFEST.with_name('krsko-equilibrium-manifest.json')
OUTPUT = ROOT / 'artifacts/measured-validation.json'
# These are measured forcing; missing controls are explicit zero assumptions.
INPUTS = ('reactorPowerMW', 'steamFlowKgS', 'feedwaterFlowKgS')
FIXED_CONTROLS = dict.fromkeys(('heaterPowerMW', 'sprayFlowKgS', 'chargingFlowKgS', 'letdownFlowKgS'), 0.0)
NATIVE_INPUTS = (*INPUTS, *FIXED_CONTROLS)
CHANNELS = {'primaryPressureMPa': ('Primary pressure', 'MPa'),
            'hotLegTemperatureC': ('Mean hot-leg temperature', '°C'),
            'coldLegTemperatureC': ('Mean cold-leg temperature', '°C'),
            'steamPressureMPa': ('Mean secondary pressure', 'MPa')}
DIAGNOSTICS = ('thermalEnergyMJ', 'totalMassKg', 'boundaryMassFlowKgS',
    'boundaryPowerMW', 'energyResidualMW', 'massResidualKgS', 'pumpHeatInputMW',
    'steamEnthalpyJkg', 'chargingEnthalpyJkg', 'coldLegEnthalpyJkg', 'feedwaterEnthalpyJkg',
    'pressurizerLiquidTemperatureC', 'pressurizerVaporTemperatureC', 'pressurizerLevelPercent')


def identity():
    try:
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        revision, dirty = None, None
    return {'version': json.loads((ROOT / 'package.json').read_text())['version'],
        'gitRevision': revision, 'gitDirty': dirty, 'sourceSha256': sha(COMMON),
        'benchmarkModelSha256': sha(MODEL), 'inputDataSha256': sha(DATA),
        'referenceMetadataSha256': sha(PROVENANCE), 'parameterSourcesSha256': sha(PARAMETERS),
        'baselineSha256': sha(BASELINE), 'comparisonScriptSha256': sha(Path(__file__)),
        'sharedRunnerSha256': sha(ROOT / 'validation/native_fmi.py')}


def build():
    resources = [(path, 'documentation/reference/krsko2005-' + path.name)
                 for path in (DATA, PROVENANCE, PARAMETERS)]
    for name, fmu, manifest in [('OpenPWR.KrskoTransient', FMU, MANIFEST),
                              ('OpenPWR.KrskoEquilibrium', EQUILIBRIUM_FMU, EQUILIBRIUM_MANIFEST)]:
        result = build_case(name, MODEL, fmu, manifest, identity, resources)
        print('Built', name, result['fmuSha256'], flush=True)


def load_data():
    with DATA.open(newline='', encoding='utf-8') as stream:
        rows = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(stream)]
    if len(rows) != 50 or [row['time'] for row in rows] != list(range(-49, 50, 2)):
        raise ValueError('Reference must preserve the 50 original acquisition times.')
    if any(not math.isfinite(value) for row in rows for value in row.values()):
        raise ValueError('Non-finite reference data.')
    return rows


def at(rows, time, key):
    if not rows[0]['time'] <= time <= rows[-1]['time']:
        raise ValueError('Reference extrapolation is not allowed.')
    for a, b in zip(rows, rows[1:]):
        if a['time'] <= time <= b['time']:
            weight = (time - a['time']) / (b['time'] - a['time'])
            return a[key] + weight * (b[key] - a[key])
    raise ValueError('Missing reference interval.')


def sourced_parameters():
    return {item['parameter']: item['value'] for item in
            json.loads(PARAMETERS.read_text(encoding='utf-8'))['modelParameters']
            if item['value'] is not None}


def boundary_mass(held, point):
    return held['feedwaterFlowKgS'] - held['steamFlowKgS'] + held['chargingFlowKgS'] - held['letdownFlowKgS']


def boundary_energy(held, point):
    return (held['reactorPowerMW'] + point['pumpHeatInputMW'] + held['heaterPowerMW']
        + (held['feedwaterFlowKgS'] * point['feedwaterEnthalpyJkg']
           - held['steamFlowKgS'] * point['steamEnthalpyJkg']
           + held['chargingFlowKgS'] * point['chargingEnthalpyJkg']
           - held['letdownFlowKgS'] * point['coldLegEnthalpyJkg']) / 1e6)


def simulate(rows, step=.05, geometry_scale=1, equilibrium=False, phase_time=.1):
    parameters = {**sourced_parameters(), 'geometryScale': geometry_scale,
                  'pressurizerPhaseRelaxationTimeS': phase_time}
    run = run_case(EQUILIBRIUM_FMU if equilibrium else FMU,
        'OpenPWR.KrskoEquilibrium' if equilibrium else 'OpenPWR.KrskoTransient',
        (*CHANNELS, *DIAGNOSTICS), NATIVE_INPUTS,
        lambda time: {**{name: at(rows, time, name) for name in INPUTS}, **FIXED_CONTROLS},
        15, step, parameters=parameters, event_times=range(1, 16, 2),
        solver_tolerance=1e-11,
        boundary_integrals=(('massKg', boundary_mass), ('energyMJ', boundary_energy)))
    first, last = run['points'][0], run['points'][-1]
    return {**run, 'geometryScale': geometry_scale,
            'massIntegralErrorKg': last['totalMassKg'] - first['totalMassKg'] - run['integrals']['massKg'],
            'energyIntegralErrorMJ': last['thermalEnergyMJ'] - first['thermalEnergyMJ'] - run['integrals']['energyMJ']}


def checked_manifest(path, fmu, current):
    manifest = json.loads(path.read_text())
    for key, value in current.items():
        if key.endswith('Sha256') and manifest.get(key) != value:
            raise ValueError(f'Stale native measured-case {key}; rebuild first.')
    if manifest['fmuSha256'] != sha(fmu):
        raise ValueError('Measured-case FMU bytes do not match the build manifest.')
    return manifest


def rms(values):
    return math.sqrt(sum(value * value for value in values) / len(values))


def sensitivity_run(rows, **parameters):
    try:
        return {'completed': True, **simulate(rows, **parameters)}
    except NativeDomainExit as error:
        return {'completed': False, 'parameters': parameters,
                'domainStop': str(error), 'terminalObservation': error.observation}


def compare():
    current_identity = identity()
    manifest = checked_manifest(MANIFEST, FMU, current_identity)
    equilibrium_manifest = checked_manifest(EQUILIBRIUM_MANIFEST, EQUILIBRIUM_FMU, current_identity)
    rows = load_data()
    provenance = json.loads(PROVENANCE.read_text(encoding='utf-8'))
    ledger = json.loads(PARAMETERS.read_text(encoding='utf-8'))
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
    primary = simulate(rows)
    refined = simulate(rows, step=.025)
    equilibrium = simulate(rows, equilibrium=True)
    sensitivity = [sensitivity_run(rows, geometry_scale=scale) for scale in (.5, 2)]
    phase_sensitivity = [sensitivity_run(rows, phase_time=value) for value in (.05, .2)]
    after = identity()
    if any(after[key] != value for key, value in current_identity.items() if key.endswith('Sha256')):
        raise RuntimeError('Benchmark sources changed during execution; rebuild before reporting.')
    if sha(FMU) != manifest['fmuSha256'] or sha(EQUILIBRIUM_FMU) != equilibrium_manifest['fmuSha256']:
        raise RuntimeError('Benchmark executable changed during execution; rerun from stable files.')
    measured_times = [0] + list(range(1, 16, 2))
    channels = []
    for key, (name, unit) in CHANNELS.items():
        old = next(channel for channel in baseline['channels'] if channel['key'] == key)
        initial_reference, initial_simulation = at(rows, 0, key), primary['points'][0][key]
        points = [{'time': time, 'measured': at(rows, time, key),
            'simulated': at(primary['points'], time, key), 'refined': at(refined['points'], time, key),
            'equilibrium': at(equilibrium['points'], time, key),
            'baseline': at(old['points'], time, 'simulated')} for time in measured_times]
        errors = [point['simulated'] - point['measured'] for point in points[1:]]
        metrics = {'samples': len(errors), 'rmse': rms(errors),
            'maximumAbsoluteError': max(map(abs, errors)), 'meanError': sum(errors) / len(errors),
            'initialBias': initial_simulation - initial_reference, 'finalError': errors[-1],
            'changeRmse': rms([(point['simulated'] - initial_simulation) - (point['measured'] - initial_reference) for point in points[1:]]),
            'releasedBaselineRmse': old['metrics']['rmse'],
            'rmseChangeFromBaseline': rms(errors) - old['metrics']['rmse'],
            'sameBoundaryEquilibriumRmse': rms([point['equilibrium'] - point['measured'] for point in points[1:]]),
            'maximumStepRefinementDifference': max(abs(point['simulated'] - point['refined']) for point in points),
            'maximumGeometrySensitivitySpread': max(abs(at(sensitivity[0]['points'], time, key) - at(sensitivity[1]['points'], time, key)) for time in measured_times) if all(run['completed'] for run in sensitivity) else None,
            'maximumPhaseTimeSensitivitySpread': max(abs(at(phase_sensitivity[0]['points'], time, key) - at(phase_sensitivity[1]['points'], time, key)) for time in measured_times) if all(run['completed'] for run in phase_sensitivity) else None,
            'maximumReferenceTimingAllowance': max(abs(at(rows, time + offset, key) - at(rows, time, key)) for time in measured_times[1:] for offset in (-1, 1))}
        channels.append({'key': key, 'name': name, 'unit': unit, 'metrics': metrics, 'points': points})
    checks = []
    runs = [('nominal', primary), ('refined', refined), ('equilibrium ablation', equilibrium)]
    runs.extend((f'geometry {run["geometryScale"]}', run) for run in sensitivity if run['completed'])
    runs.extend((f'phase time {value}', run) for value, run in zip((.05, .2), phase_sensitivity) if run['completed'])
    for label, run in runs:
        for key, tolerance in [('massIntegralErrorKg', .05), ('energyIntegralErrorMJ', .1)]:
            checks.append({'name': f'{label} {key}', 'value': run[key],
                           'absoluteTolerance': tolerance, 'pass': abs(run[key]) <= tolerance})
    for channel in channels:
        value = channel['metrics']['maximumStepRefinementDifference']
        tolerance = .01 if channel['unit'] == 'MPa' else .05
        checks.append({'name': channel['name'] + ' communication refinement',
                       'value': value, 'absoluteTolerance': tolerance, 'pass': value <= tolerance})
    report = {'schema': 'openpwr-measured-validation-v1', **current_identity,
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'executed': True,
        'status': 'inconclusive', 'validationPassed': False,
        'conclusion': 'The measured comparison and controlled pressure-model ablation completed. Missing event-era geometry, control histories and instrument uncertainty still prevent plant validation; every discrepancy is retained.',
        'scope': 'Boundary-driven early thermal response; measured reactor power and steam/feedwater flows do not validate reactor kinetics or plant controls.',
        'caseId': provenance['caseId'], 'title': provenance['title'],
        'source': provenance['source'], 'sourceURL': provenance['source']['url'],
        'dataURL': 'https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/measured.csv',
        'runtime': primary['runtime'], 'buildManifest': manifest, 'metadata': provenance,
        'parameterSources': ledger, 'appliedSourceParameters': sourced_parameters(),
        'fixedControlAssumptions': FIXED_CONTROLS, 'comparisonWindowS': [0, 15],
        'inputs': [{'name': name, 'points': [{'time': time, 'value': at(rows, time, name)} for time in range(16)]} for name in INPUTS],
        'assumptions': [*provenance['limitations'],
            'Documented nominal pump heat is 6 MW. It is a constant boundary assumption, not a measured time history.',
            'Charging and letdown are preserved as measured L/s but not replayed without meter reference density and inlet enthalpy. Heater/spray histories are unavailable; these controls are explicitly held at zero.',
            'Reported pressurizer indicated level is an explicitly unverified volume-fraction approximation. No event-era geometry has been inferred from pressure.',
            'The dynamic pressurizer separates liquid and vapor temperatures. Its unmeasured phase relaxation time is declared before comparison; 0.05/0.2 s runs are sensitivities, not calibration.',
            'The released baseline differs in model form and pump-heat boundary. The same-boundary equilibrium run isolates pressurizer model form. Neither comparison is an independent validation event.'],
        'channels': channels,
        'numericalChecks': checks, 'numericalPassed': all(check['pass'] for check in checks),
        'numericalEvidence': {'massIntegralErrorKg': primary['massIntegralErrorKg'],
            'solverRelativeTolerance': primary['solverRelativeTolerance'],
            'solverToleranceBasis': primary['solverToleranceBasis'],
            'energyIntegralErrorMJ': primary['energyIntegralErrorMJ'],
            'refinedMassIntegralErrorKg': refined['massIntegralErrorKg'],
            'refinedEnergyIntegralErrorMJ': refined['energyIntegralErrorMJ'],
            'stepsComparedS': [.05, .025], 'geometrySensitivityScales': [.5, 1, 2],
            'phaseRelaxationSensitivityS': [.05, .1, .2],
            'sensitivityDomainStops': [run for run in sensitivity + phase_sensitivity if not run['completed']],
            'sensitivityPolicy': 'A declared property-domain stop is retained with its terminal observation. No full-window spread is calculated for an incomplete sensitivity pair; no parameter is changed to avoid the stop.',
            'metricSampleTimesS': list(range(1, 16, 2)),
            'initialPoint': 'Interpolated t=0 exposes initialization bias and is excluded from error statistics.',
            'boundaryQuadrature': 'Both endpoints use the same externally held inputs; cached FMI algebraic outputs cannot introduce a fictitious forcing ramp.',
            'scope': 'Numerical conservation and unfitted sensitivities; not physical acceptance or uncertainty propagation.'},
        'releasedBaseline': {'version': baseline['version'], 'gitRevision': baseline['gitRevision'], 'reportSha256': sha(BASELINE)},
        'equilibriumComparison': {'runtime': equilibrium['runtime'], 'buildManifest': equilibrium_manifest, 'points': equilibrium['points']},
        'sensitivity': [{'geometryScale': scale, **run} for scale, run in zip((.5, 2), sensitivity)],
        'phaseSensitivity': [{'timeConstantS': value, **run} for value, run in zip((.05, .2), phase_sensitivity)],
        'trace': primary['points']}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    for channel in channels:
        print(f"{channel['name']}: RMSE {channel['metrics']['rmse']:.6g} {channel['unit']}; released baseline {channel['metrics']['releasedBaselineRmse']:.6g}")
    print('Comparison executed; plant validation INCONCLUSIVE. See artifacts/measured-validation.json')
    if not report['numericalPassed']:
        raise RuntimeError('Numerical acceptance failed; discrepancies retained in the report, publication must wait.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    if args.build:
        build()
    compare()
