"""Measured boundary replay of ContinuousPlant's shared production thermal kernel."""
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

MODEL = ROOT / 'models/KrskoContinuousThermal.mo'
COLD = ROOT / 'models/ColdStartPlant.mo'
CONTINUOUS = ROOT / 'models/ContinuousPlant.mo'
DATA = ROOT / 'validation/krsko2005/measured.csv'
PROVENANCE = DATA.with_name('provenance.json')
SOURCE_LEDGER = DATA.with_name('reference-plant.json')
PARAMETERS = HERE / 'parameters.json'
PROTOCOL = HERE / 'protocol.json'
COVERAGE = HERE / 'source-coverage.json'
FMU = ROOT / 'artifacts/modelica/KrskoContinuousThermal.fmu'
MANIFEST = FMU.with_name('continuous-measured-manifest.json')
OUTPUT = ROOT / 'artifacts/continuous-measured-validation.json'
PROTOCOL_SHA256 = '256a36d82cee86fc4d9c3c03e29c7b074489f1ff219c2ff6847e735908817309'
DATA_SHA256 = 'f2160bb33271b1b80774df8edee13d805a2b7abe24a6a7a4de356035001b0407'
INPUTS = ('reactorPowerMW', 'steamFlowKgS', 'feedwaterFlowKgS')
FIXED_CONTROLS = dict.fromkeys(('heaterPowerMW', 'chargingFlowKgS', 'letdownFlowKgS'), 0.0)
NATIVE_INPUTS = (*INPUTS, *FIXED_CONTROLS)
CHANNELS = {
    'primaryPressureMPa': ('Primary pressure', 'MPa'),
    'hotLegTemperatureC': ('Mean hot-leg temperature', '°C'),
    'coldLegTemperatureC': ('Mean cold-leg temperature', '°C'),
    'steamPressureMPa': ('Mean secondary pressure', 'MPa'),
}
DIAGNOSTICS = (
    'thermalEnergyMJ', 'totalMassKg', 'boundaryMassFlowKgS', 'boundaryPowerMW',
    'energyResidualMW', 'massResidualKgS', 'integratedBoundaryEnergyMJ', 'integratedBoundaryMassKg',
    'pumpHeatInputMW', 'actualHeaterPowerMW', 'actualChargingFlowKgS', 'actualLetdownFlowKgS',
    'shutdownCoolingMW', 'steamEnthalpyJkg', 'chargingEnthalpyJkg', 'coldLegEnthalpyJkg',
    'feedwaterEnthalpyJkg', 'pressurizerVentPowerW', 'secondaryVentPowerW',
    'pressurizerSteamVentKgS', 'pressurizerGasVentKgS', 'secondarySteamVentKgS',
    'secondaryGasVentKgS', 'pressurizerGasMassKg', 'secondaryGasMassKg',
    'pressurizerTemperatureC', 'pressurizerLevelPercent', 'primarySubcoolingK',
    'fuelTemperatureC', 'heatToSteamMW', 'primaryFlowKgS',
    'secondaryTemperatureC', 'secondaryLevelPercent',
)
FLUX_PRIMITIVES = (
    'pumpHeatInputMW', 'shutdownCoolingMW', 'feedwaterEnthalpyJkg', 'steamEnthalpyJkg',
    'chargingEnthalpyJkg', 'coldLegEnthalpyJkg', 'pressurizerVentPowerW', 'secondaryVentPowerW',
    'pressurizerSteamVentKgS', 'pressurizerGasVentKgS', 'secondarySteamVentKgS', 'secondaryGasVentKgS',
)


def protocol():
    if sha(PROTOCOL) != PROTOCOL_SHA256:
        raise ValueError('Prospective measured-case protocol changed; do not silently amend acceptance after scoring.')
    return json.loads(PROTOCOL.read_text(encoding='utf-8'))


def identity():
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    files = {
        'sourceSha256': ROOT / 'models/OpenPWR/package.mo',
        'coldSourceSha256': COLD, 'continuousSourceSha256': CONTINUOUS,
        'benchmarkModelSha256': MODEL, 'inputDataSha256': DATA,
        'referenceMetadataSha256': PROVENANCE, 'sourceLedgerSha256': SOURCE_LEDGER,
        'parameterSourcesSha256': PARAMETERS, 'protocolSha256': PROTOCOL,
        'sourceCoverageSha256': COVERAGE, 'comparisonScriptSha256': Path(__file__),
        'sharedRunnerSha256': ROOT / 'validation/native_fmi.py',
        'packagingScriptSha256': ROOT / 'scripts/modelica/package_fmu.py',
    }
    return {'version': json.loads((ROOT / 'package.json').read_text())['version'],
            'gitRevision': revision, 'gitDirty': dirty,
            **{key: sha(path) for key, path in files.items()}}


def build():
    protocol()
    resources = [(path, 'documentation/reference/' + prefix + path.name) for prefix, paths in (
        ('krsko2005-', (DATA, PROVENANCE, SOURCE_LEDGER)),
        ('continuous-measured-', (PARAMETERS, PROTOCOL, COVERAGE)),
    ) for path in paths]
    result = build_case('KrskoContinuousThermal', MODEL, FMU, MANIFEST, identity,
                        resources, extra_sources=(COLD, CONTINUOUS))
    print('Built KrskoContinuousThermal', result['fmuSha256'], flush=True)


def load_data():
    if sha(DATA) != DATA_SHA256:
        raise ValueError('Original measured data changed; do not silently replace reference values.')
    with DATA.open(newline='', encoding='utf-8') as stream:
        rows = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(stream)]
    if len(rows) != 50 or [row['time'] for row in rows] != list(range(-49, 50, 2)):
        raise ValueError('Reference must preserve all 50 original acquisition times.')
    if any(not math.isfinite(value) for row in rows for value in row.values()):
        raise ValueError('Reference data must be finite.')
    return rows


def at(rows, time, key):
    if not rows or not rows[0]['time'] <= time <= rows[-1]['time']:
        raise ValueError('Extrapolation is not allowed.')
    for a, b in zip(rows, rows[1:]):
        if a['time'] <= time <= b['time']:
            return a[key] + (time-a['time'])/(b['time']-a['time'])*(b[key]-a[key])
    raise ValueError('Missing reference interval.')


def sourced_parameters():
    return {item['parameter']: item['value'] for item in
            json.loads(PARAMETERS.read_text(encoding='utf-8'))['parameters']}


def boundary_mass(held, point):
    return (held['feedwaterFlowKgS'] - held['steamFlowKgS']
            + held['chargingFlowKgS'] - held['letdownFlowKgS']
            - sum(point[key] for key in ('pressurizerSteamVentKgS', 'pressurizerGasVentKgS',
                                         'secondarySteamVentKgS', 'secondaryGasVentKgS')))


def boundary_energy(held, point):
    return (held['reactorPowerMW'] + point['pumpHeatInputMW'] + held['heaterPowerMW']
        - point['shutdownCoolingMW']
        + (held['feedwaterFlowKgS']*point['feedwaterEnthalpyJkg']
           - held['steamFlowKgS']*point['steamEnthalpyJkg']
           + held['chargingFlowKgS']*point['chargingEnthalpyJkg']
           - held['letdownFlowKgS']*point['coldLegEnthalpyJkg']
           - point['pressurizerVentPowerW'] - point['secondaryVentPowerW'])/1e6)


def domain_violations(point):
    """Reconstruct production state limits independently of the native valid flag.

    Exact bounds from ColdStartPlant.valid and WaterGasVessel.valid with the
    wrapper's declared maximum temperatures. Primary pressure's tighter interval
    also implies the pressurizer vessel pressure interval. Fixed/measured input
    domains are checked separately; these are state-domain observations only.
    """
    predicates = (
        ('primaryPressureMPa', .1 <= point['primaryPressureMPa'] < 17.5),
        ('hotLegTemperatureC', 280 <= point['hotLegTemperatureC']+273.15 < 620),
        ('coldLegTemperatureC', 280 <= point['coldLegTemperatureC']+273.15 < 610),
        ('fuelTemperatureC', 280 <= point['fuelTemperatureC']+273.15 < 1400),
        ('primarySubcoolingK', point['primarySubcoolingK'] > 3),
        ('primaryFlowKgS', -.1 <= point['primaryFlowKgS'] <= 16000),
        ('pressurizerTemperatureC', 280 <= point['pressurizerTemperatureC']+273.15 < 623.15),
        ('pressurizerLevelPercent', 3 < point['pressurizerLevelPercent'] < 97),
        ('pressurizerGasMassKg', point['pressurizerGasMassKg'] >= -1e-8),
        ('steamPressureMPa', .002 < point['steamPressureMPa'] < 18),
        ('secondaryTemperatureC', 280 <= point['secondaryTemperatureC']+273.15 < 623.15),
        ('secondaryLevelPercent', 3 < point['secondaryLevelPercent'] < 97),
        ('secondaryGasMassKg', point['secondaryGasMassKg'] >= -1e-8),
    )
    return [name for name, passed in predicates if not passed]


def simulate(rows, step, geometry_scale=1):
    p = protocol()
    # Retain the primitive endpoint observations used in independent quadrature.
    # Publication can reconstruct the integral rather than trust its stored total.
    quadrature, endpoints = [], []
    def audited_energy(held, point):
        endpoints.append({'time': point['time'], **{key: point[key] for key in FLUX_PRIMITIVES}})
        if len(endpoints) == 2:
            quadrature.append({'held': dict(held), 'start': endpoints[0], 'end': endpoints[1]})
            endpoints.clear()
        return boundary_energy(held, point)
    run = run_case(FMU, p['model'], (*CHANNELS, *DIAGNOSTICS), NATIVE_INPUTS,
        lambda time: {**{name: at(rows, time, name) for name in INPUTS}, **FIXED_CONTROLS},
        p['windowSeconds'][1], step,
        parameters={**sourced_parameters(), 'geometryScale': geometry_scale},
        event_times=p['metricSampleTimesSeconds'], solver_tolerance=p['solverRelativeTolerance'],
        boundary_integrals=(('massKg', boundary_mass), ('energyMJ', audited_energy)))
    first, last = run['points'][0], run['points'][-1]
    return {**run, 'completed': True, 'status': 'completed', 'geometryScale': geometry_scale,
        'boundaryQuadrature': quadrature,
        'massIntegralErrorKg': last['totalMassKg']-first['totalMassKg']-run['integrals']['massKg'],
        'energyIntegralErrorMJ': last['thermalEnergyMJ']-first['thermalEnergyMJ']-run['integrals']['energyMJ'],
        'nativeMassIntegralErrorKg': last['totalMassKg']-first['totalMassKg']
            -(last['integratedBoundaryMassKg']-first['integratedBoundaryMassKg']),
        'nativeEnergyIntegralErrorMJ': last['thermalEnergyMJ']-first['thermalEnergyMJ']
            -(last['integratedBoundaryEnergyMJ']-first['integratedBoundaryEnergyMJ'])}


def sensitivity_run(rows, step, scale):
    try:
        return simulate(rows, step, scale)
    except NativeDomainExit as error:
        violations = domain_violations(error.observation)
        if not violations:
            raise RuntimeError('Native invalid flag lacks an independently observable state-domain violation.') from error
        return {'completed': False, 'status': 'failed-domain', 'geometryScale': scale,
                'stepSeconds': step, 'domainStop': str(error),
                'failureKind': 'NativeDomainExit', 'domainViolations': violations,
                'runtime': {'model': 'KrskoContinuousThermal', 'fmuSha256': sha(FMU)},
                'parameters': {**sourced_parameters(), 'geometryScale': scale},
                'solverRelativeTolerance': protocol()['solverRelativeTolerance'],
                'requestedSolverRelativeTolerance': protocol()['solverRelativeTolerance'],
                'terminalObservation': error.observation}


def checked_manifest(current):
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for key, value in current.items():
        if key.endswith('Sha256') and manifest.get(key) != value:
            raise ValueError(f'Stale shared-kernel comparison {key}; rebuild first.')
    if manifest.get('model') != 'KrskoContinuousThermal' or manifest.get('fmuSha256') != sha(FMU):
        raise ValueError('Measured-case FMU does not match its build manifest.')
    return manifest


def rms(values):
    return math.sqrt(sum(value*value for value in values)/len(values))


def metrics(rows, primary, refined, sensitivity, key):
    times = [0, *protocol()['metricSampleTimesSeconds']]
    initial_measured, initial_simulated = at(rows, 0, key), primary['points'][0][key]
    points = [{'time': time, 'measured': at(rows, time, key),
               'simulated': at(primary['points'], time, key),
               'refined': at(refined['points'], time, key)} for time in times]
    errors = [point['simulated']-point['measured'] for point in points[1:]]
    result = {'samples': len(errors), 'rmse': rms(errors),
        'maximumAbsoluteError': max(map(abs, errors)), 'meanError': sum(errors)/len(errors),
        'initialBias': initial_simulated-initial_measured, 'finalError': errors[-1],
        'changeRmse': rms([(point['simulated']-initial_simulated)-(point['measured']-initial_measured)
                           for point in points[1:]]),
        'maximumStepRefinementDifference': max(abs(point['simulated']-point['refined']) for point in points),
        'maximumGeometrySensitivitySpread': max(abs(at(sensitivity[0]['points'], time, key)
            - at(sensitivity[1]['points'], time, key)) for time in times)
            if all(run['completed'] for run in sensitivity) else None,
        'maximumReferenceTimingAllowance': max(abs(at(rows, time+offset, key)-at(rows, time, key))
            for time in times[1:] for offset in (-1, 1))}
    return result, points


def numerical_checks(primary, refined, sensitivity, channels):
    limits = protocol()['numericalLimits']
    checks = []
    runs = [('nominal', primary), ('refined', refined)]
    runs.extend((f'geometry {run["geometryScale"]}', run) for run in sensitivity if run['completed'])
    for name, run in runs:
        for key in ('massIntegralErrorKg', 'energyIntegralErrorMJ'):
            checks.append({'name': name+' '+key, 'value': run[key],
                           'absoluteTolerance': limits[key], 'pass': abs(run[key]) <= limits[key]})
    for channel in channels:
        limit = limits['pressureRefinementMPa' if channel['unit'] == 'MPa' else 'temperatureRefinementK']
        value = channel['metrics']['maximumStepRefinementDifference']
        checks.append({'name': channel['name']+' communication refinement', 'value': value,
                       'absoluteTolerance': limit, 'pass': value <= limit})
    return checks


def quadrature_integrals(run, rows):
    """Check held forcing, continuity and primitive endpoint evidence; reintegrate."""
    quadrature = run['boundaryQuadrature']
    mass, energy, previous = 0.0, 0.0, None
    if not quadrature or quadrature[0]['start']['time'] != 0 or quadrature[-1]['end']['time'] != 15:
        raise ValueError('Independent quadrature must cover the full comparison window.')
    for item in quadrature:
        held, start, end = item['held'], item['start'], item['end']
        if set(held) != set(NATIVE_INPUTS) or any(not math.isfinite(value) for value in held.values()):
            raise ValueError('Independent quadrature has invalid held inputs.')
        if any(set(point) != {'time', *FLUX_PRIMITIVES} or any(not math.isfinite(value) for value in point.values()) for point in (start, end)):
            raise ValueError('Independent quadrature has missing/nonfinite primitive states.')
        if previous is not None and previous != start:
            raise ValueError('Independent quadrature has a state or time discontinuity.')
        delta = end['time']-start['time']
        if not 0 < delta <= run['stepSeconds']+1e-9:
            raise ValueError('Independent quadrature step changed.')
        expected = {**{name: at(rows, start['time'], name) for name in INPUTS}, **FIXED_CONTROLS}
        if any(not math.isclose(held[name], value, rel_tol=1e-12, abs_tol=1e-9) for name, value in expected.items()):
            raise ValueError('Independent quadrature does not use original measured forcing.')
        if not (0 <= held['reactorPowerMW'] <= 3300 and held['feedwaterFlowKgS'] >= -1e-8
                and held['steamFlowKgS'] >= -1e-8 and 0 <= held['heaterPowerMW'] <= 3
                and 0 <= held['chargingFlowKgS'] <= 10 and 0 <= held['letdownFlowKgS'] <= 20):
            raise ValueError('Replay forcing exceeds the production input domain.')
        mass += .5*delta*(boundary_mass(held, start)+boundary_mass(held, end))
        energy += .5*delta*(boundary_energy(held, start)+boundary_energy(held, end))
        previous = end
    if len(quadrature) != run['steps']:
        raise ValueError('Independent quadrature step count changed.')
    # Retained plotted observations must be the same native states used in flux integration.
    by_time = {item['end']['time']: item['end'] for item in quadrature}
    by_time[0] = quadrature[0]['start']
    for point in run['points']:
        if {key: point[key] for key in ('time', *FLUX_PRIMITIVES)} != by_time.get(point['time']):
            raise ValueError('Plotted trace differs from the quadrature native states.')
    return {'massKg': mass, 'energyMJ': energy}


def verify_report(report):
    """Recompute acceptance from retained traces/reference, rejecting forged pass flags.

    This is a numerical-evidence gate, not a physical validation oracle. Source
    and executable identity is checked separately by comparison/publication.
    """
    p = protocol()
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    require(report.get('schema') == 'openpwr-continuous-measured-v1', 'Wrong report schema.')
    require(report.get('executed') is True and report.get('status') == 'inconclusive', 'Invalid measured status.')
    require(report.get('validationPassed') is False and report.get('physicalValidationPassed') is False,
            'Numerical evidence cannot become a physical validation pass.')
    require(report.get('protocolSha256') == PROTOCOL_SHA256 and report.get('protocol') == p, 'Protocol mismatch.')
    require(report.get('inputDataSha256') == DATA_SHA256, 'Measured data identity mismatch.')
    require(report.get('comparisonWindowS') == p['windowSeconds'], 'Comparison window changed.')
    require(report.get('fixedControlAssumptions') == FIXED_CONTROLS, 'Control assumptions changed.')
    require(report.get('appliedSourceParameters') == sourced_parameters(), 'Parameter ledger mismatch.')
    require(.2 <= sourced_parameters()['initialPressurePa']/1e6 <= 15.5, 'Fixed pressure target exceeds input domain.')
    rows = load_data()
    primary, refined, sensitivity = report['primaryRun'], report['refinedRun'], report['sensitivity']
    require([run.get('geometryScale') for run in sensitivity] == [.5, 2], 'Sensitivity cases omitted or replaced.')
    for run, step, scale in [(primary, .05, 1), (refined, .025, 1),
                             *[(run, .05, run['geometryScale']) for run in sensitivity]]:
        require(run.get('stepSeconds') == step and run.get('geometryScale') == scale, 'Run configuration changed.')
        require(run.get('parameters') == {**sourced_parameters(), 'geometryScale': scale}, 'Applied run parameters changed.')
        require(run.get('solverRelativeTolerance') == p['solverRelativeTolerance'], 'Solver tolerance changed.')
        require(run.get('requestedSolverRelativeTolerance') == p['solverRelativeTolerance'], 'Requested solver tolerance changed.')
        require(run.get('runtime', {}).get('model') == 'KrskoContinuousThermal'
                and run.get('runtime', {}).get('fmuSha256') == report['buildManifest']['fmuSha256'], 'Mixed executable traces.')
        if run.get('completed') is False:
            require(run in sensitivity and run.get('status') == 'failed-domain'
                    and run.get('failureKind') == 'NativeDomainExit' and bool(run.get('domainStop')),
                    'Mandatory run failed or unclassified failure.')
            observation = run.get('terminalObservation', {})
            require(set(observation) == {'time', *CHANNELS, *DIAGNOSTICS}
                    and 0 <= observation.get('time', -1) <= 15 and all(math.isfinite(value) for value in observation.values()),
                    'Failed-domain case needs a finite terminal observation.')
            violations = domain_violations(observation)
            require(bool(violations) and run.get('domainViolations') == violations,
                    'Failed-domain case lacks independently observed state-domain violations.')
            require('points' not in run and 'integrals' not in run, 'Failed sensitivity cannot supply a complete trace.')
            continue
        require(run.get('completed') is True and run.get('status') == 'completed', 'Incomplete run cannot pass.')
        points = run['points']
        require([point['time'] for point in points] == list(range(16)), 'Native trace is incomplete.')
        require(all(set(point) == {'time', *CHANNELS, *DIAGNOSTICS} for point in points), 'Trace diagnostics missing.')
        require(all(math.isfinite(value) for point in points for value in point.values()), 'Nonfinite trace.')
        require(all(not domain_violations(point) for point in points), 'Completed native trace leaves the production state domain.')
        recomputed_integrals = quadrature_integrals(run, rows)
        # The runner integrates its requested delta before snapping endpoints
        # to exact sample times. Reconstructing delta from those timestamps can
        # differ at floating-point roundoff; this allowance is many orders below
        # the prospective inventory limits and cannot hide an inventory error.
        require(all(math.isclose(run['integrals'][key], value, rel_tol=1e-12, abs_tol=1e-8)
                    for key, value in recomputed_integrals.items()),
                'Independent integrals differ from primitive endpoint quadrature.')
        for key, inventory, integral in [('massIntegralErrorKg', 'totalMassKg', 'massKg'),
                                       ('energyIntegralErrorMJ', 'thermalEnergyMJ', 'energyMJ')]:
            expected = points[-1][inventory]-points[0][inventory]-run['integrals'][integral]
            require(math.isclose(run[key], expected, rel_tol=1e-10, abs_tol=1e-10), 'Inventory error was not computed from trace.')
    expected_channels = []
    for key, (name, unit) in CHANNELS.items():
        result, points = metrics(rows, primary, refined, sensitivity, key)
        expected_channels.append({'key': key, 'name': name, 'unit': unit, 'metrics': result, 'points': points})
    require(report.get('channels') == expected_channels, 'Measurement metrics do not match raw data and native traces.')
    expected_checks = numerical_checks(primary, refined, sensitivity, expected_channels)
    require(report.get('numericalChecks') == expected_checks, 'Numerical checks were changed or fabricated.')
    require(report.get('numericalPassed') is all(check['pass'] for check in expected_checks), 'Numerical pass flag mismatch.')
    require(report.get('sensitivityCoverageComplete') is all(run['completed'] for run in sensitivity), 'Sensitivity coverage misrepresented.')
    require(report.get('trace') == primary['points'], 'Published trace differs from scored native trace.')
    return True


def compare():
    p, current = protocol(), identity()
    manifest = checked_manifest(current)
    rows = load_data()
    provenance = json.loads(PROVENANCE.read_text(encoding='utf-8'))
    primary = simulate(rows, p['communicationStepsSeconds'][0])
    refined = simulate(rows, p['communicationStepsSeconds'][1])
    sensitivity = [sensitivity_run(rows, p['communicationStepsSeconds'][0], scale) for scale in (.5, 2)]
    after = identity()
    if any(after[key] != value for key, value in current.items() if key.endswith('Sha256')) or sha(FMU) != manifest['fmuSha256']:
        raise RuntimeError('Comparison inputs or executable changed during execution; rebuild.')
    channels = []
    for key, (name, unit) in CHANNELS.items():
        result, points = metrics(rows, primary, refined, sensitivity, key)
        channels.append({'key': key, 'name': name, 'unit': unit, 'metrics': result, 'points': points})
    checks = numerical_checks(primary, refined, sensitivity, channels)
    report = {'schema': 'openpwr-continuous-measured-v1', **current,
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'executed': True,
        'status': 'inconclusive', 'validationPassed': False, 'physicalValidationPassed': False,
        'caseId': p['caseId'], 'title': 'Continuous-startup thermal kernel: measured Krško transient',
        'conclusion': 'The shared production thermal kernel was compared with measured operating-plant data. Missing event-era inputs and model limitations prevent physical acceptance; all discrepancies remain visible.',
        'scope': 'Hot-initialized boundary replay of ContinuousPlant.thermal (ColdStartPlant), not a run of the continuous cold-start trajectory. Measured core heat and secondary flows exclude kinetics and turbine/generator/controller validation.',
        'protocol': p, 'source': provenance['source'], 'sourceURL': provenance['source']['url'],
        'dataURL': 'https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/measured.csv',
        'metadata': provenance, 'parameterSources': json.loads(PARAMETERS.read_text(encoding='utf-8')),
        'sourceLedger': json.loads(SOURCE_LEDGER.read_text(encoding='utf-8')),
        'sourceCoverage': json.loads(COVERAGE.read_text(encoding='utf-8')),
        'assumptions': [*provenance['limitations'],
            'This wrapper executes the same ColdStartPlant class used by ContinuousPlant, with hot initial states. It does not execute the whole continuous-startup plant FMU.',
            'The production thermal kernel has no spray port; documented but unquantified spray action is omitted. This is a limitation, not a measured zero-spray input.',
            'The primary volume is split equally into hot and cold nodes; no event-era spatial allocation is identified.',
            'Pressurizer and steam-generator cover-gas masses initialize at zero using saturation temperatures; the event does not measure cover gas.',
            'This event has already been used for model development; it is not a blind independent holdout event.'],
        'productionKernel': {'class': 'ColdStartPlant', 'composition': 'ContinuousPlant.thermal',
            'sameClass': True, 'sameWholePlantExecutable': False,
            'excludedSubsystems': p['excludedClaims'],
            'initialization': 'Published hot initial conditions, zero cover gas, disclosed generic geometry and initial-only balance calibrations. Default interactive cold-start conditions remain a separate verification case.'},
        'appliedSourceParameters': sourced_parameters(), 'fixedControlAssumptions': FIXED_CONTROLS,
        'comparisonWindowS': p['windowSeconds'], 'runtime': primary['runtime'], 'buildManifest': manifest,
        'inputs': [{'name': name, 'points': [{'time': time, 'value': at(rows, time, name)} for time in range(16)]} for name in INPUTS],
        'channels': channels, 'numericalChecks': checks,
        'numericalPassed': all(check['pass'] for check in checks),
        'sensitivityCoverageComplete': all(run['completed'] for run in sensitivity),
        'numericalEvidence': {'stepsComparedS': p['communicationStepsSeconds'],
            'metricSampleTimesS': p['metricSampleTimesSeconds'], 'initialPoint': p['initialPointPolicy'],
            'geometrySensitivityScales': p['geometrySensitivityScales'],
            'sensitivityPolicy': p['domainStopPolicy'],
            'boundaryQuadrature': 'Externally held inputs at both endpoints, primitive enthalpies and vent fluxes; independent of the kernel total-rate and integrated-boundary outputs.',
            'physicalAcceptanceBand': None},
        'primaryRun': primary, 'refinedRun': refined, 'sensitivity': sensitivity, 'trace': primary['points']}
    verify_report(report)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    for channel in channels:
        print(f"{channel['name']}: RMSE {channel['metrics']['rmse']:.6g} {channel['unit']}")
    print(f"Numerical checks {sum(check['pass'] for check in checks)}/{len(checks)}; physical validation INCONCLUSIVE.")
    print('Evidence:', OUTPUT)
    if not report['numericalPassed']:
        raise RuntimeError('Numerical acceptance failed; retain evidence but block publication as executed evidence.')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    if args.build:
        build()
    compare()
