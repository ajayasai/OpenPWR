"""Execute the fixed PACTEL ATWS-10 case and retain measured discrepancies.

The pressure envelope is a descriptive combination of published error/reading
bounds, not a confidence interval or a whole-plant validation criterion.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from bisect import bisect_left
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
sys.path.insert(0, str(HERE))
from native_fmi import COMMON, build_case, run_case, sha
from post_unblinding_compare import (run_development, historical_evidence,
    attach_baseline, baseline_identity, BASELINE)

MODEL_NAME = 'OpenPWR.PactelPressurizer'
MODEL = ROOT / 'models/PactelPressurizer.mo'
DATA = HERE / 'measured.csv'
PROVENANCE = HERE / 'provenance.json'
SHARED_RUNNER = ROOT / 'validation/native_fmi.py'
FMU = ROOT / 'artifacts/modelica/PactelPressurizer.fmu'
MANIFEST = ROOT / 'artifacts/modelica/pactel-manifest.json'
OUTPUT = ROOT / 'artifacts/pressurizer-validation.json'
DURATION = 500.0
STEPS = (.1, .05)
SOLVER_RELATIVE_TOLERANCE = 1e-9
MASS_TOLERANCE_KG = 1e-4
ENERGY_TOLERANCE_MJ = .005
MESH_CASES = (('PactelCoarse', 'pactel-coarse-manifest.json', 12, 4),
              ('PactelRadialRefined', 'pactel-radial-manifest.json', 12, 8),
              ('PactelSpatialRefined', 'pactel-spatial-manifest.json', 24, 8))
HOLDOUT_SOURCES = {'holdoutDataSha256': HERE / 'holdout-measured.csv',
    'holdoutMetadataSha256': HERE / 'holdout-provenance.json',
    'holdoutComparatorSha256': HERE / 'holdout_compare.py',
    'holdoutProtocolSha256': HERE / 'holdout-protocol.json',
    'holdoutExtractorSha256': HERE / 'holdout_extract.py',
    'holdoutFreezeSha256': HERE / 'holdout-freeze.json',
    'developmentComparatorSha256': HERE / 'post_unblinding_compare.py',
    'v07BaselineSha256': BASELINE}
INPUTS = ('surgeFlowKgS', 'surgeTemperatureK', 'heaterPowerMW')
OUTPUTS = ('pressureMPa', 'liquidLevelM', 'liquidTemperatureK', 'vaporTemperatureK', 'maximumFilmReynolds',
           'totalMassKg', 'thermalEnergyMJ', 'boundaryMassFlowKgS', 'boundaryPowerMW',
           'surgeInletEnthalpyJkg', 'surgeOutflowEnthalpyJkg', 'wallHeatLossMW',
           'wallCondensationKgS', 'bulkEvaporationKgS', 'bulkCondensationKgS',
           'massResidualKgS', 'energyResidualMW',
           'integratedBoundaryMassKg', 'integratedBoundaryEnergyMJ')


def identity():
    try:
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        revision, dirty = None, None
    return {'version': json.loads((ROOT / 'package.json').read_text())['version'],
            'gitRevision': revision, 'gitDirty': dirty, 'sourceSha256': sha(COMMON),
            'benchmarkModelSha256': sha(MODEL), 'inputDataSha256': sha(DATA),
            'referenceMetadataSha256': sha(PROVENANCE),
            'comparisonScriptSha256': sha(Path(__file__)), 'sharedRunnerSha256': sha(SHARED_RUNNER),
            **{key: sha(path) for key, path in HOLDOUT_SOURCES.items()}}


def build():
    resources = ((DATA, 'documentation/reference/pactel1998-measured.csv'),
                 (PROVENANCE, 'documentation/reference/pactel1998-provenance.json'),
                 *((path, f'documentation/reference/{path.name}') for path in HOLDOUT_SOURCES.values()))
    result = build_case(MODEL_NAME, MODEL, FMU, MANIFEST, identity, resources=resources)
    for model, manifest, _, _ in MESH_CASES:
        build_case(f'OpenPWR.{model}', MODEL, FMU.with_name(f'{model}.fmu'), MANIFEST.with_name(manifest), identity, resources=resources)
    return result


def load_data():
    with DATA.open(newline='', encoding='utf-8') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ['time', 'pressureMPa']:
            raise ValueError('The PACTEL reference must contain only time and measured pressure.')
        rows = [{name: float(value) for name, value in row.items()} for row in reader]
    if [row['time'] for row in rows] != list(range(5, 496)):
        raise ValueError('The PACTEL reference must preserve the declared 5-495 s reading grid.')
    if any(not math.isfinite(value) for row in rows for value in row.values()):
        raise ValueError('Nonfinite measured reference.')
    return rows


def interpolate(points, time, key):
    """Interpolate a time-ordered reference/observation, without extrapolation."""
    if not points or not math.isfinite(time) or not points[0]['time'] <= time <= points[-1]['time']:
        raise ValueError('Reference extrapolation is not allowed.')
    index = bisect_left([point['time'] for point in points], time)
    if points[index]['time'] == time:
        return points[index][key]
    before, after = points[index - 1], points[index]
    weight = (time - before['time']) / (after['time'] - before['time'])
    return before[key] + weight * (after[key] - before[key])


def table_value(table, time):
    """Published forcing is linear between knots and held after its last knot."""
    if not math.isfinite(time) or time < table[0][0]:
        raise ValueError('Forcing time precedes its published table.')
    if time >= table[-1][0]:
        return table[-1][1]
    for before, after in zip(table, table[1:]):
        if before[0] <= time <= after[0]:
            return before[1] + (after[1] - before[1]) * (time - before[0]) / (after[0] - before[0])
    raise ValueError('Invalid forcing table.')


def make_forcing(metadata):
    boundary = metadata['publishedBoundaryModel']
    flow, power = boundary['surgeMassFlowKgS'], boundary['heaterPowerW']
    for table in (flow, power):
        if not table or table[0][0] != 0 or any(len(point) != 2 or
                any(not math.isfinite(value) for value in point) for point in table):
            raise ValueError('Boundary tables must be finite and start at zero.')
        if any(a[0] >= b[0] for a, b in zip(table, table[1:])) or table[-1][0] > DURATION:
            raise ValueError('Boundary timestamps must be ordered and within the experiment.')
    temperature = boundary['inletTemperatureK']
    if not math.isfinite(temperature):
        raise ValueError('Nonfinite inlet temperature.')

    def forcing(time):
        return {'surgeFlowKgS': table_value(flow, time), 'surgeTemperatureK': temperature,
                'heaterPowerMW': table_value(power, time) / 1e6}

    events = sorted({point[0] for table in (flow, power) for point in table} |
                    {event['time'] for event in metadata['experiment']['operatorEvents']})
    return forcing, events


def mass_flux(held, observation):
    return held['surgeFlowKgS']


def energy_flux(held, observation):
    # Boundary energy is evaluated from independent inputs and endpoint state
    # enthalpies. A negative flow removes actual liquid, not nominal inlet water.
    flow = held['surgeFlowKgS']
    enthalpy = observation['surgeInletEnthalpyJkg' if flow >= 0 else 'surgeOutflowEnthalpyJkg']
    return flow * enthalpy / 1e6 + held['heaterPowerMW'] - observation['wallHeatLossMW']


def simulate(metadata, step, *, model=MODEL_NAME, fmu=None):
    forcing, events = make_forcing(metadata)
    return run_case(FMU if fmu is None else fmu, model, OUTPUTS, INPUTS, forcing, DURATION, step,
                    event_times=events, boundary_integrals=(('massKg', mass_flux), ('energyMJ', energy_flux)),
                    solver_tolerance=SOLVER_RELATIVE_TOLERANCE)


def pressure_envelope(rows, time, vertical_allowance, time_allowance):
    if not math.isfinite(vertical_allowance) or vertical_allowance < 0 or not math.isfinite(time_allowance) or time_allowance < 0:
        raise ValueError('Pressure and timing allowances must be finite and nonnegative.')
    low_time = max(rows[0]['time'], time - time_allowance)
    high_time = min(rows[-1]['time'], time + time_allowance)
    # A peak can lie between the window endpoints. Include every interior knot,
    # then the extrema are exact for the piecewise-linear measured reference.
    values = [interpolate(rows, low_time, 'pressureMPa'), interpolate(rows, high_time, 'pressureMPa')]
    values.extend(row['pressureMPa'] for row in rows if low_time < row['time'] < high_time)
    return min(values) - vertical_allowance, max(values) + vertical_allowance


def pressure_channel(rows, primary, refined, metadata):
    vertical = metadata['measurementUncertainty']['pressureMaximumAbsoluteErrorMPa'] + metadata['extraction']['figureReadingAllowanceMPa']
    timing = metadata['extraction']['figureTimeReadingAllowanceS']
    points = []
    for row in rows:
        time = row['time']
        lower, upper = pressure_envelope(rows, time, vertical, timing)
        points.append({'time': time, 'measured': row['pressureMPa'],
                       'simulated': interpolate(primary['points'], time, 'pressureMPa'),
                       'refined': interpolate(refined['points'], time, 'pressureMPa'),
                       'lowerAllowance': lower, 'upperAllowance': upper})
    errors = [point['simulated'] - point['measured'] for point in points]
    exceedances = [max(point['lowerAllowance'] - point['simulated'], point['simulated'] - point['upperAllowance'], 0) for point in points]
    covered = sum(value == 0 for value in exceedances)
    measured_peak = max(rows, key=lambda point: point['pressureMPa'])
    predicted_peak = max(primary['points'], key=lambda point: point['pressureMPa'])
    metrics = {'samples': len(points), 'rmse': math.sqrt(sum(error * error for error in errors) / len(errors)),
               'maximumAbsoluteError': max(map(abs, errors)), 'meanError': sum(errors) / len(errors),
               'initialBias': errors[0], 'initialBiasTimeS': rows[0]['time'], 'finalError': errors[-1],
               'changeRmse': math.sqrt(sum((error - errors[0]) ** 2 for error in errors) / len(errors)),
               'maximumStepRefinementDifference': max(abs(point['simulated'] - point['refined']) for point in points),
               'conditionalEnvelopeCoveredPositions': covered,
               'conditionalEnvelopeCoverageFraction': covered / len(points),
               'maximumEnvelopeExceedance': max(exceedances),
               'measuredPeakPressureMPa': measured_peak['pressureMPa'],
               'simulatedPeakPressureMPa': predicted_peak['pressureMPa'],
               'peakPressureErrorMPa': predicted_peak['pressureMPa'] - measured_peak['pressureMPa'],
               'measuredPeakTimeS': measured_peak['time'], 'simulatedPeakTimeS': predicted_peak['time'],
               'peakTimeDifferenceS': predicted_peak['time'] - measured_peak['time']}
    return {'key': 'pressureMPa', 'name': 'Pressurizer pressure', 'unit': 'MPa', 'metrics': metrics, 'points': points,
            'description': 'Independent event comparison informed by the report during model development; not a blind holdout. Positions are correlated digitized readings, not raw independent samples.'}


def balance_evidence(run):
    first, last = run['points'][0], run['points'][-1]
    mass_error = last['totalMassKg'] - first['totalMassKg'] - run['integrals']['massKg']
    energy_error = last['thermalEnergyMJ'] - first['thermalEnergyMJ'] - run['integrals']['energyMJ']
    native_mass_error = last['totalMassKg'] - first['totalMassKg'] - (last['integratedBoundaryMassKg'] - first['integratedBoundaryMassKg'])
    native_energy_error = last['thermalEnergyMJ'] - first['thermalEnergyMJ'] - (last['integratedBoundaryEnergyMJ'] - first['integratedBoundaryEnergyMJ'])
    mass_scale = max(abs(first['totalMassKg']), abs(last['totalMassKg']), abs(run['integrals']['massKg']), 1e-12)
    energy_scale = max(abs(first['thermalEnergyMJ']), abs(last['thermalEnergyMJ']), abs(run['integrals']['energyMJ']), 1e-12)
    return {'stepSeconds': run['stepSeconds'], 'steps': run['steps'],
            'massIntegralErrorKg': mass_error, 'energyIntegralErrorMJ': energy_error,
            'relativeMassIntegralError': mass_error / mass_scale, 'relativeEnergyIntegralError': energy_error / energy_scale,
            'relativeErrorMassScaleKg': mass_scale, 'relativeErrorEnergyScaleMJ': energy_scale,
            'relativeErrorBasis': 'Signed error divided by the maximum magnitude of the initial inventory, final inventory and integrated boundary transfer. Absolute thresholds alone determine numerical acceptance.',
            'nativeMassIntegralErrorKg': native_mass_error, 'nativeEnergyIntegralErrorMJ': native_energy_error,
            'solverRelativeTolerance': run['solverRelativeTolerance'],
            'requestedSolverRelativeTolerance': run['requestedSolverRelativeTolerance'],
            'solverToleranceBasis': run['solverToleranceBasis'],
            'maximumRetainedMassResidualKgS': max(abs(point['massResidualKgS']) for point in run['points']),
            'maximumRetainedEnergyResidualMW': max(abs(point['energyResidualMW']) for point in run['points']),
            'checks': [
                {'name': 'Independent physical mass balance', 'error': abs(mass_error), 'tolerance': MASS_TOLERANCE_KG, 'unit': 'kg', 'pass': abs(mass_error) <= MASS_TOLERANCE_KG},
                {'name': 'Independent fluid-plus-wall energy balance', 'error': abs(energy_error), 'tolerance': ENERGY_TOLERANCE_MJ, 'unit': 'MJ', 'pass': abs(energy_error) <= ENERGY_TOLERANCE_MJ},
                {'name': 'Native integrated mass versus physical inventory', 'error': abs(native_mass_error), 'tolerance': MASS_TOLERANCE_KG, 'unit': 'kg', 'pass': abs(native_mass_error) <= MASS_TOLERANCE_KG},
                {'name': 'Native integrated energy versus physical inventory', 'error': abs(native_energy_error), 'tolerance': ENERGY_TOLERANCE_MJ, 'unit': 'MJ', 'pass': abs(native_energy_error) <= ENERGY_TOLERANCE_MJ}]}


def base_report(metadata, manifest, current_identity):
    return {'schema': 'openpwr-measured-validation-v1', **current_identity,
            'generatedAt': datetime.now(timezone.utc).isoformat(), 'caseId': metadata['caseId'], 'title': metadata['title'],
            'source': metadata['source'], 'sourceURL': metadata['source']['url'],
            'dataURL': 'https://github.com/ajayasai/OpenPWR/blob/main/validation/pactel1998/measured.csv',
            'metadata': metadata, 'buildManifest': manifest, 'assumptions': metadata['limitations'],
            'comparisonWindowS': metadata['experiment']['referenceWindowS'], 'simulationWindowS': [0, DURATION],
            'validationPassed': False}


def make_report(rows, metadata, manifest, current_identity, primary, refined):
    for run in (primary, refined):
        if [point['time'] for point in run['points']] != list(range(501)):
            raise ValueError('Native trace does not contain the complete 0-500 s observation grid.')
        if any(not math.isfinite(value) for point in run['points'] for value in point.values()):
            raise ValueError('Native trace contains a nonfinite value.')
        if any(not math.isfinite(run['integrals'][name]) for name in ('massKg', 'energyMJ')):
            raise ValueError('Native boundary quadrature contains a nonfinite value.')
        if run['runtime']['model'] != MODEL_NAME or run['runtime']['fmuSha256'] != manifest['fmuSha256']:
            raise ValueError('The tested native model differs from the bound manifest.')
    channel = pressure_channel(rows, primary, refined, metadata)
    balances = [balance_evidence(run) for run in (primary, refined)]
    numerical_pass = all(check['pass'] for balance in balances for check in balance['checks'])
    numerical_checks = [
        {'name': f"{balance['stepSeconds']:g} s: {check['name']}",
         'value': check['error'], 'absoluteTolerance': check['tolerance'], 'pass': check['pass'], 'unit': check['unit']}
        for balance in balances for check in balance['checks']]
    forcing, events = make_forcing(metadata)
    covered = channel['metrics']['conditionalEnvelopeCoveredPositions']
    report = base_report(metadata, manifest, current_identity)
    report.update({'executed': True, 'status': 'inconclusive', 'runtime': primary['runtime'], 'channels': [channel],
        'numericalPassed': numerical_pass, 'numericalChecks': numerical_checks,
        'conclusion': f'The independent PACTEL component comparison executed. Its descriptive pressure envelope covers {covered} of {len(rows)} correlated digitized positions. This is not a blind holdout, a statistical confidence result, or a plant-validation pass. All raw discrepancies and numerical balance checks are retained.',
        'inputs': [{'name': name, 'points': [{'time': time, 'value': forcing(time)[name]} for time in range(501)]} for name in INPUTS],
        'numericalEvidence': {'pass': numerical_pass, 'balances': balances, 'stepsComparedS': list(STEPS),
            'solverToleranceBasis': primary['solverToleranceBasis'],
            'solverRelativeTolerance': primary['solverRelativeTolerance'],
            'requestedSolverRelativeTolerance': primary['requestedSolverRelativeTolerance'],
            'massIntegralErrorKg': balances[0]['massIntegralErrorKg'], 'energyIntegralErrorMJ': balances[0]['energyIntegralErrorMJ'],
            'refinedMassIntegralErrorKg': balances[1]['massIntegralErrorKg'], 'refinedEnergyIntegralErrorMJ': balances[1]['energyIntegralErrorMJ'],
            'exactEventTimesS': events, 'wallMesh': {'axialSegments': 48, 'radialCells': 8},
            'spatialConvergenceAssessed': False,
            'boundaryMethod': 'For each communication interval, integrate the held imposed mass flow and held heater power; use endpoint inlet enthalpy for positive flow, actual liquid enthalpy for negative flow, and endpoint external wall heat loss. Stored thermalEnergyMJ includes fluid and wall.',
            'scope': 'Independent conservation and communication-step diagnostics. Spatial convergence and a complete input/model uncertainty budget are not established.'},
        'conditionalAssessment': {'pressureEnvelopeMPa': metadata['measurementUncertainty']['pressureMaximumAbsoluteErrorMPa'] + metadata['extraction']['figureReadingAllowanceMPa'],
            'graphicalTimingAllowanceS': metadata['extraction']['figureTimeReadingAllowanceS'],
            'allPositionsWithinEnvelope': covered == len(rows), 'coverageIsStatisticalConfidence': False,
            'eventTimeAlignmentApplied': False, 'parameterFittingApplied': False,
            'endpointPolicy': 'Timing windows are clipped to the available 5-495 s measured trace; no extrapolation.'},
        'trace': primary['points'], 'refinedTrace': refined['points']})
    return report


def add_spatial_evidence(report, metadata, nominal, current_identity):
    """Compare meshes at identical communication steps without fitting to data."""
    records = []
    runs = []
    for model, manifest_name, axial, radial in MESH_CASES:
        fmu = FMU.with_name(f'{model}.fmu')
        manifest = json.loads(MANIFEST.with_name(manifest_name).read_text(encoding='utf-8'))
        if manifest.get('model') != f'OpenPWR.{model}' or manifest.get('fmuSha256') != sha(fmu):
            raise ValueError(f'{model} executable differs from its manifest.')
        for key, value in current_identity.items():
            if key.endswith('Sha256') and manifest.get(key) != value:
                raise ValueError(f'Stale {model} {key}; rebuild first.')
        run = simulate(metadata, STEPS[1], model=f'OpenPWR.{model}', fmu=fmu)
        if [point['time'] for point in run['points']] != list(range(501)):
            raise ValueError(f'{model} did not preserve the full observation grid.')
        if any(not math.isfinite(value) for point in run['points'] for value in point.values()):
            raise ValueError(f'{model} contains a nonfinite observation.')
        if any(not math.isfinite(run['integrals'][key]) for key in ('massKg', 'energyMJ')):
            raise ValueError(f'{model} contains nonfinite boundary quadrature.')
        if run['runtime']['model'] != f'OpenPWR.{model}' or run['runtime']['fmuSha256'] != manifest['fmuSha256'] or sha(fmu) != manifest['fmuSha256']:
            raise ValueError(f'{model} executed runtime differs from its bound executable.')
        balance = balance_evidence(run)
        record = {'model': f'OpenPWR.{model}', 'wallMesh': {'axialSegments': axial, 'radialCells': radial},
            'buildManifest': manifest, 'runtime': run['runtime'], 'balance': balance,
            'trace': run['points']}
        records.append(record)
        report['numericalChecks'].extend({'name': f'{model}: {check["name"]}', 'value': check['error'],
            'absoluteTolerance': check['tolerance'], 'pass': check['pass'], 'unit': check['unit']} for check in balance['checks'])
        runs.append(run)
    for record, run, next_run in zip(records, runs, runs[1:] + [nominal]):
        differences = [a['pressureMPa'] - b['pressureMPa'] for a, b in zip(next_run['points'], run['points'])]
        record.update({'nextMeshModel': next_run['runtime']['model'],
            'maximumPressureChangeToNextMeshMPa': max(map(abs, differences)),
            'rmsPressureChangeToNextMeshMPa': math.sqrt(sum(d * d for d in differences) / len(differences))})
    report['spatialComparisons'] = records
    report['numericalPassed'] = all(check['pass'] for check in report['numericalChecks'])
    report['numericalEvidence'].update({'pass': report['numericalPassed'], 'spatialConvergenceAssessed': True,
        'spatialStepSeconds': STEPS[1], 'spatialComparisons': [{key: value for key, value in record.items()
            if key not in ('trace', 'buildManifest', 'runtime', 'balance')} for record in records],
        'candidateSelection': 'The 48×8 mesh selected before v0.7 measured scoring is retained in this post-unblinding development comparison. Its original selection is historical; no fresh blind selection or candidate freeze is claimed. Residual spatial error remains unresolved; no asymptotic or grid-convergence-index claim.',
        'scope': 'Independent conservation, communication-step and wall-mesh differences. Mesh differences are numerical diagnostics, not uncertainty bounds or measured-accuracy acceptance criteria.'})


def compare():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    current_identity = identity()
    for key, value in current_identity.items():
        if key.endswith('Sha256') and manifest.get(key) != value:
            raise ValueError(f'Stale PACTEL {key}; rebuild first.')
    if manifest.get('model') != MODEL_NAME or manifest.get('fmuSha256') != sha(FMU):
        raise ValueError('PACTEL native artifact does not match its build manifest.')
    metadata = json.loads(PROVENANCE.read_text(encoding='utf-8'))
    rows = load_data()
    try:
        primary = simulate(metadata, STEPS[0])
        refined = simulate(metadata, STEPS[1])
        after = identity()
        if any(after[key] != value for key, value in current_identity.items() if key.endswith('Sha256')) or sha(FMU) != manifest['fmuSha256']:
            raise RuntimeError('Native source/artifact changed during comparison; rerun from stable files.')
        report = make_report(rows, metadata, manifest, current_identity, primary, refined)
        add_spatial_evidence(report, metadata, refined, current_identity)
        baseline = historical_evidence()
        attach_baseline(report['channels'][0], baseline['channels'][0])
        report['releasedBaseline'] = baseline_identity(baseline)
        report['comparisonRole'] = 'development-comparison'
        # Keep the legacy JSON key for clients; its role is explicitly changed.
        report['holdoutComparison'] = run_development(manifest, fmu_path=FMU)
        report['numericalPassed'] = report['numericalPassed'] and report['holdoutComparison']['numericalPassed']
        report['numericalEvidence']['pass'] = report['numericalPassed']
        if any(identity()[key] != value for key, value in current_identity.items() if key.endswith('Sha256')):
            raise RuntimeError('Source changed during mesh or reserved-event comparison.')
    except Exception as error:
        report = base_report(metadata, manifest, current_identity)
        report.update({'executed': False, 'status': 'failed', 'channels': [], 'numericalPassed': False, 'numericalChecks': [],
                       'runtime': {'model': MODEL_NAME, 'fmuSha256': manifest['fmuSha256']},
                       'error': str(error), 'conclusion': 'Native comparison did not complete; no measured-validation result is asserted.'})
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
        raise
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
    metrics = report['channels'][0]['metrics']
    print(f"PACTEL pressure RMSE {metrics['rmse']:.6g} MPa; maximum error {metrics['maximumAbsoluteError']:.6g} MPa; descriptive coverage {metrics['conditionalEnvelopeCoveredPositions']}/{metrics['samples']}.")
    print(f"Numerical balances {'PASS' if report['numericalEvidence']['pass'] else 'FAIL'}; physical validation remains INCONCLUSIVE. Evidence: {OUTPUT}")
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='Build the dedicated native case before comparison.')
    args = parser.parse_args()
    if args.build:
        build()
    result = compare()
    if not result['numericalEvidence']['pass']:
        raise SystemExit(1)
