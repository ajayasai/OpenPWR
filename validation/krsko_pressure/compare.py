"""Paired measured development comparison of the production pressure component."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / 'validation'))
import reference
import conditional_spray as spray
import component_checks as component
from native_fmi import NativeDomainExit, build_case, run_case, sha

spec = importlib.util.spec_from_file_location('pressure_thermal_reference', ROOT / 'validation/continuous_measured/compare.py')
thermal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(thermal)
CONFIG = HERE / 'candidate-config.json'
CONFIG_SHA256 = '8797b3b5c10f0ae16b6b1522dadf61afd8858294c3b509f32c4df44b7c57b000'
BOUNDARIES = HERE / 'initial-boundaries.json'
AUDIT = HERE / 'source-audit.json'
MODEL = ROOT / 'models/KrskoPressureDevelopment.mo'
OUTPUT = ROOT / 'artifacts/krsko-pressure-development.json'
REGULARIZATION = HERE / 'regularization-amendment.json'
REGULARIZATION_SHA256 = 'f7426e4f3d0fdd5eec848773869f1ebe409b4686b6f1f03b982f12c98489c60c'
ARCHIVE = ROOT / 'validation/baselines/krsko-pressure-initial-v011.zip'
ARCHIVE_SHA256 = 'fe622629b2343e351467fc31b8054b0e628cd3493a38ea4e49f886168be99b42'
COORDINATE_AMENDMENT = HERE / 'coordinate-amendment.json'
COORDINATE_AMENDMENT_SHA256 = '9372410b2e249c9be342f269dfd65f1d3b76b0adddef3ae614fd132f9f7a34fb'
FINAL_NUMERICS = HERE / 'final-numerics-amendment.json'
FINAL_NUMERICS_SHA256 = '641f62040be06a68587b63a6926274aabcc139c57aab686470ba1ae278d11541'
INPUTS, FIXED_CONTROLS, NATIVE_INPUTS = thermal.INPUTS, thermal.FIXED_CONTROLS, thermal.NATIVE_INPUTS
CHANNELS = thermal.CHANNELS
EXTRA_DIAGNOSTICS = ('pressurizerLiquidTemperatureC', 'pressurizerVaporTemperatureC',
    'pressurizerSteamPartialPressureMPa', 'pressurizerSaturationTemperatureC',
    'pressurizerWallEnergyMJ', 'pressurizerWallAmbientPowerW',
    'pressurizerWallMinimumTemperatureK', 'pressurizerWallMaximumTemperatureK',
    'pressureModelFinitePhase', 'pressureModelIncludesWall', 'sprayControlEnabled',
    'actualSprayFlowKgS', 'sprayCondensationKgS', 'sprayHeatTransferMW',
    'pressurizerMinimumFilmNusseltArgument')
DIAGNOSTICS = (*thermal.DIAGNOSTICS, *EXTRA_DIAGNOSTICS)
FLUX_PRIMITIVES = (*thermal.FLUX_PRIMITIVES, 'pressurizerWallAmbientPowerW')


def configuration():
    if sha(CONFIG) != CONFIG_SHA256:
        raise ValueError('Pre-scoring pressure candidate configuration changed.')
    result = json.loads(CONFIG.read_text(encoding='utf-8'))
    if result['initialProtocolSha256'] != reference.PROTOCOL_SHA256:
        raise ValueError('Candidate configuration does not reference the original prospective protocol.')
    return result


def identity():
    files = {
        'sourceSha256': ROOT / 'models/OpenPWR/package.mo',
        'pressureSourceSha256': ROOT / 'models/FinitePhasePressurizer.mo',
        'coldSourceSha256': ROOT / 'models/ColdStartPlant.mo',
        'continuousSourceSha256': ROOT / 'models/ContinuousPlant.mo',
        'thermalBenchmarkModelSha256': ROOT / 'models/KrskoContinuousThermal.mo',
        'benchmarkModelSha256': MODEL,
        'inputDataSha256': ROOT / reference.protocol()['reference']['data'],
        'referenceMetadataSha256': ROOT / reference.protocol()['reference']['provenance'],
        'sourceLedgerSha256': ROOT / reference.protocol()['reference']['sourceLedger'],
        'parameterSourcesSha256': CONFIG,
        'initialBoundariesSha256': BOUNDARIES,
        'sourceAuditSha256': AUDIT,
        'protocolSha256': reference.PROTOCOL,
        'baselineSha256': ROOT / reference.protocol()['baseline']['path'],
        'comparisonScriptSha256': Path(__file__),
        'referenceScriptSha256': HERE / 'reference.py',
        'thermalComparisonScriptSha256': ROOT / 'validation/continuous_measured/compare.py',
        'sharedRunnerSha256': ROOT / 'validation/native_fmi.py',
        'packagingScriptSha256': ROOT / 'scripts/modelica/package_fmu.py',
        'componentModelSha256': ROOT / 'models/PressureComponentChecks.mo',
        'componentScriptSha256': HERE / 'component_checks.py',
        'conditionalSprayConfigSha256': spray.CONFIG,
        'conditionalSprayInitialConfigSha256': HERE / 'conditional-spray-config-initial.json',
        'conditionalSprayAmendmentSha256': HERE / 'conditional-spray-amendment.json',
        'conditionalSprayScriptSha256': HERE / 'conditional_spray.py',
        'originalAttemptSummarySha256': HERE / 'original-attempt-summary.json',
        'originalAttemptArchiveSha256': ARCHIVE,
        'regularizationAmendmentSha256': REGULARIZATION,
        'coordinateAmendmentSha256': COORDINATE_AMENDMENT,
        'finalNumericsAmendmentSha256': FINAL_NUMERICS,
    }
    return {'version': json.loads((ROOT / 'package.json').read_text())['version'],
        'gitRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'gitDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
        **{key: sha(path) for key, path in files.items()}}


def paths(case):
    tag = {'KrskoPressureSpray': 'spray', 'KrskoPressureSprayRefinedWall': 'spray-refined-wall'}.get(case['model'], case['id'])
    return (ROOT / 'artifacts/modelica' / (case['model']+'.fmu'),
            ROOT / 'artifacts/modelica' / ('krsko-pressure-'+tag+'-manifest.json'))


def applied_parameters():
    ledger = json.loads(BOUNDARIES.read_text(encoding='utf-8'))
    for path_key, hash_key in [('previousParameterLedger', 'previousParameterLedgerSha256'),
                               ('measurementProvenance', 'measurementProvenanceSha256'),
                               ('sourceLedger', 'sourceLedgerSha256')]:
        if sha(ROOT / ledger[path_key]) != ledger[hash_key]:
            raise ValueError('Initial boundary source changed: '+path_key)
    if ledger['initialParameters'] != thermal.sourced_parameters() or ledger['unquantifiedControls'] != FIXED_CONTROLS:
        raise ValueError('Paired boundary or initial assumptions differ from the frozen release experiment.')
    return {**ledger['initialParameters'], **configuration()['commonParameters'], 'geometryScale': 1}


def build():
    config = configuration()
    reference.baseline()
    applied_parameters()
    extra_sources = tuple(ROOT / path for path in ('models/FinitePhasePressurizer.mo',
        'models/ColdStartPlant.mo', 'models/ContinuousPlant.mo', 'models/KrskoContinuousThermal.mo'))
    resource_paths = [CONFIG, BOUNDARIES, AUDIT, reference.PROTOCOL, spray.CONFIG,
        HERE / 'conditional-spray-config-initial.json', HERE / 'conditional-spray-amendment.json',
        HERE / 'original-attempt-summary.json', REGULARIZATION, COORDINATE_AMENDMENT, FINAL_NUMERICS,
        ROOT / reference.protocol()['baseline']['path'],
        ROOT / reference.protocol()['reference']['data'],
        ROOT / reference.protocol()['reference']['provenance']]
    resources = [(path, 'documentation/reference/krsko-pressure-'+path.name) for path in resource_paths]
    def build_one(case):
        fmu, manifest = paths(case)
        built = build_case(case['model'], MODEL, fmu, manifest, identity, resources, extra_sources=extra_sources)
        print('Built', case['model'], built['fmuSha256'], flush=True)
    # Each compiler uses its own fresh temporary directory and distinct output
    # files. Source hashes are checked independently before and after each build.
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(build_one, [*config['cases'], *spray.build_cases()]))


def saturation_temperature_k(pressure_mpa):
    """Independent IF97 region-4 inverse (Eq. 31), MPa input, K output."""
    n = (1167.0521452767, -724213.16703206, -17.073846940092, 12020.82470247,
         -3232555.0322333, 14.91510861353, -4823.2657361591, 405113.40542057,
         -.23855557567849, 650.17534844798)
    beta = pressure_mpa**.25
    e, f, g = beta*beta+n[2]*beta+n[5], n[0]*beta*beta+n[3]*beta+n[6], n[1]*beta*beta+n[4]*beta+n[7]
    d = 2*g/(-f-math.sqrt(f*f-4*e*g))
    return (n[9]+d-math.sqrt((n[9]+d)**2-4*(n[8]+n[9]*d)))/2


def domain_violations(point, case):
    failures = thermal.domain_violations(point)
    if point['pressureModelFinitePhase'] != int(case['finitePhase']):
        failures.append('pressureModelFinitePhase')
    if point['pressureModelIncludesWall'] != int(case['wall']):
        failures.append('pressureModelIncludesWall')
    controlled = case.get('conditionalSpray', False)
    if point['sprayControlEnabled'] != int(controlled):
        failures.append('sprayControlEnabled')
    controller = spray.configuration()['controller']
    expected_flow = (controller['maximumSprayFlowKgS']*min(1, max(0,
        case['gainFractionPerMPa']*(point['primaryPressureMPa']-controller['referencePressureMPa']))) if controlled else 0)
    if not math.isclose(point['actualSprayFlowKgS'], expected_flow, rel_tol=1e-11, abs_tol=1e-8):
        failures.append('actualSprayFlowKgS')
    if point['sprayCondensationKgS'] < -1e-8 or point['sprayHeatTransferMW'] < -1e-8:
        failures.append('sprayContactTransfer')
    if not case['finitePhase']:
        return failures
    ps = point['pressurizerSteamPartialPressureMPa']
    tl = point['pressurizerLiquidTemperatureC']+273.15
    tv = point['pressurizerVaporTemperatureC']+273.15
    if not .000611657 < ps < 19:
        failures.append('pressurizerSteamPartialPressureMPa')
        return failures
    ts = saturation_temperature_k(ps)
    if not tl < ts+2:
        failures.append('pressurizerLiquidSuperheat')
    if not 280 <= tv < 800 or not tv > ts-2:
        failures.append('pressurizerVaporTemperatureC')
    # MSL 4.0.0 IF97_Utilities.data.n / Regions.boundary23ofT, MPa.
    b23_mpa = 348.05185628969+tv*(-1.1671859879975+tv*.0010192970039326)
    if not (ps < 16.5291643 or (tv >= 623.15 and ps < b23_mpa)):
        failures.append('pressurizerVaporRegion2')
    if case['wall']:
        if point['pressurizerMinimumFilmNusseltArgument'] < 0:
            failures.append('pressurizerMinimumFilmNusseltArgument')
        if point['pressurizerWallMinimumTemperatureK'] < 273.15:
            failures.append('pressurizerWallMinimumTemperatureK')
        if point['pressurizerWallMaximumTemperatureK'] > 1073.15:
            failures.append('pressurizerWallMaximumTemperatureK')
    return failures


def boundary_mass(held, point):
    return thermal.boundary_mass(held, point)


def boundary_energy(held, point):
    return thermal.boundary_energy(held, point)-point['pressurizerWallAmbientPowerW']/1e6


def simulate(case, rows, step):
    fmu, _ = paths(case)
    p = reference.protocol()
    quadrature, endpoints = [], []
    def audited_energy(held, point):
        endpoints.append({'time': point['time'], **{key: point[key] for key in FLUX_PRIMITIVES}})
        if len(endpoints) == 2:
            quadrature.append({'held': dict(held), 'start': endpoints[0], 'end': endpoints[1]})
            endpoints.clear()
        return boundary_energy(held, point)
    metadata = {'caseId': case['id'], 'stepSeconds': step,
        'parameters': spray.parameters(case, applied_parameters()),
        'runtime': {'model': case['model'], 'fmuSha256': sha(fmu)},
        'solverRelativeTolerance': p['solverRelativeTolerance'],
        'requestedSolverRelativeTolerance': p['solverRelativeTolerance']}
    try:
        run = run_case(fmu, case['model'], (*CHANNELS, *DIAGNOSTICS), NATIVE_INPUTS,
            lambda time: {**{name: reference.at(rows, time, name) for name in INPUTS}, **FIXED_CONTROLS},
            15, step, parameters=spray.parameters(case, applied_parameters()),
            event_times=p['reference']['metricSampleTimesSeconds'], solver_tolerance=p['solverRelativeTolerance'],
            boundary_integrals=(('massKg', boundary_mass), ('energyMJ', audited_energy)))
    except NativeDomainExit as error:
        violations = domain_violations(error.observation, case)
        if not violations:
            raise RuntimeError('Native invalid flag lacks an independently observed domain violation.') from error
        return {**metadata, 'completed': False, 'status': 'failed-domain',
            'failureKind': 'NativeDomainExit', 'domainStop': str(error),
            'terminalObservation': error.observation, 'domainViolations': violations}
    first, last = run['points'][0], run['points'][-1]
    return {**run, 'caseId': case['id'], 'completed': True, 'status': 'completed',
        'boundaryQuadrature': quadrature,
        'massIntegralErrorKg': last['totalMassKg']-first['totalMassKg']-run['integrals']['massKg'],
        'energyIntegralErrorMJ': last['thermalEnergyMJ']-first['thermalEnergyMJ']-run['integrals']['energyMJ'],
        'nativeMassIntegralErrorKg': last['totalMassKg']-first['totalMassKg']
            -(last['integratedBoundaryMassKg']-first['integratedBoundaryMassKg']),
        'nativeEnergyIntegralErrorMJ': last['thermalEnergyMJ']-first['thermalEnergyMJ']
            -(last['integratedBoundaryEnergyMJ']-first['integratedBoundaryEnergyMJ'])}


def check_manifest(case, current):
    fmu, path = paths(case)
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('model') != case['model'] or manifest.get('fmuSha256') != sha(fmu):
        raise ValueError('Pressure-case executable identity mismatch: '+case['id'])
    for key, value in current.items():
        if key.endswith('Sha256') and manifest.get(key) != value:
            raise ValueError('Stale pressure-case '+key+'; rebuild '+case['id'])
    return manifest


def channels_for(nominal, refined):
    scored = reference.score_trace(nominal['points'], refined['points'])
    return [{**channel, 'name': CHANNELS[channel['key']][0],
             'label': CHANNELS[channel['key']][0], 'unit': CHANNELS[channel['key']][1]} for channel in scored]


def case_numerical_checks(case):
    limits = reference.protocol()['numericalLimits']
    checks = []
    for label in ('nominal', 'refined'):
        run = case[label]
        checks.append({'name': case['id']+' '+label+' completed', 'value': 0 if run['completed'] else 1,
                       'absoluteTolerance': 0, 'pass': run['completed']})
        if not run['completed']:
            continue
        first = run['points'][0]
        for key in ('massIntegralErrorKg', 'energyIntegralErrorMJ'):
            checks.append({'name': case['id']+' '+label+' '+key, 'value': run[key],
                           'absoluteTolerance': limits[key], 'pass': abs(run[key]) <= limits[key]})
        for inventory, integral, limit in [('totalMassKg', 'integratedBoundaryMassKg', limits['massIntegralErrorKg']),
                                            ('thermalEnergyMJ', 'integratedBoundaryEnergyMJ', limits['energyIntegralErrorMJ'])]:
            value = max(abs(point[inventory]-first[inventory]-(point[integral]-first[integral])) for point in run['points'])
            checks.append({'name': case['id']+' '+label+' native '+inventory+' ledger', 'value': value,
                           'absoluteTolerance': limit, 'pass': value <= limit})
        violations = sum(len(domain_violations(point, case)) for point in run['points'])
        checks.append({'name': case['id']+' '+label+' observed state domain', 'value': violations,
                       'absoluteTolerance': 0, 'pass': violations == 0})
    for channel in case.get('channels', []):
        limit = limits['pressureRefinementMPa' if channel['unit'] == 'MPa' else 'temperatureRefinementK']
        value = channel['metrics']['maximumStepRefinementDifference']
        checks.append({'name': case['id']+' '+channel['name']+' communication refinement',
                       'value': value, 'absoluteTolerance': limit, 'pass': value <= limit})
    return checks


def cross_case_checks(cases):
    p, config, old = reference.protocol(), configuration(), reference.baseline()
    by_id = {case['id']: case for case in cases}
    reproduction, mesh = [], []
    for key, (name, unit) in CHANNELS.items():
        eq = by_id['equilibrium']['nominal']
        if eq['completed']:
            value = max(abs(point[key]-reference.at(old['primaryRun']['points'], point['time'], key)) for point in eq['points'])
            limit = p['numericalLimits']['equilibriumBaselineDifferenceMPa' if unit == 'MPa' else 'equilibriumBaselineDifferenceK']
            reproduction.append({'name': name+' equilibrium baseline reproduction', 'value': value,
                                 'absoluteTolerance': limit, 'pass': value <= limit})
        for step in ('nominal', 'refined'):
            left, right = by_id['candidate'][step], by_id['refined-wall'][step]
            if left['completed'] and right['completed']:
                value = max(abs(point[key]-reference.at(right['points'], point['time'], key)) for point in left['points'])
                limit = config['wallMesh']['maximumPressureDifferenceMPa' if unit == 'MPa' else 'maximumTemperatureDifferenceK']
                mesh.append({'name': name+' '+step+' wall mesh refinement', 'value': value,
                             'absoluteTolerance': limit, 'pass': value <= limit})
    return reproduction, mesh


def quadrature_integrals(run, rows):
    segments = run['boundaryQuadrature']
    if not segments or segments[0]['start']['time'] != 0 or segments[-1]['end']['time'] != 15:
        raise ValueError('Pressure quadrature must cover the complete interval.')
    previous, mass, energy, endpoints = None, 0.0, 0.0, {}
    for item in segments:
        held, start, end = item['held'], item['start'], item['end']
        if set(held) != set(NATIVE_INPUTS) or any(not math.isfinite(value) for value in held.values()):
            raise ValueError('Invalid held pressure-case inputs.')
        if any(set(point) != {'time', *FLUX_PRIMITIVES} or any(not math.isfinite(value) for value in point.values()) for point in (start, end)):
            raise ValueError('Missing or nonfinite pressure quadrature primitives.')
        if previous is not None and previous != start:
            raise ValueError('Pressure quadrature state or time discontinuity.')
        dt = end['time']-start['time']
        if not 0 < dt <= run['stepSeconds']+1e-9:
            raise ValueError('Pressure quadrature communication step changed.')
        expected = {**{key: reference.at(rows, start['time'], key) for key in INPUTS}, **FIXED_CONTROLS}
        if any(not math.isclose(held[key], value, abs_tol=1e-9, rel_tol=1e-12) for key, value in expected.items()):
            raise ValueError('Pressure quadrature forcing differs from original measurements.')
        mass += .5*dt*(boundary_mass(held, start)+boundary_mass(held, end))
        energy += .5*dt*(boundary_energy(held, start)+boundary_energy(held, end))
        previous = end
        endpoints[start['time']], endpoints[end['time']] = start, end
    if len(segments) != run['steps']:
        raise ValueError('Pressure quadrature step count changed.')
    for point in run['points']:
        if {key: point[key] for key in ('time', *FLUX_PRIMITIVES)} != endpoints.get(point['time']):
            raise ValueError('Pressure plot and quadrature use different native observations.')
    return {'massKg': mass, 'energyMJ': energy}


def displayed_channels(cases):
    by_id, old = {case['id']: case for case in cases}, reference.baseline()
    channels = []
    for candidate in by_id['candidate']['channels']:
        key = candidate['key']
        previous = next(channel for channel in old['channels'] if channel['key'] == key)
        points = []
        for point in candidate['points']:
            additions = {'baseline': reference.at(old['primaryRun']['points'], point['time'], key)}
            for case_id, field in [('equilibrium', 'equilibrium'), ('no-wall', 'noWall'), ('refined-wall', 'refinedWall')]:
                other = by_id[case_id]['nominal']
                additions[field] = reference.at(other['points'], point['time'], key) if other['completed'] else None
            points.append({**point, **additions})
        channels.append({**candidate, 'points': points, 'metrics': {**candidate['metrics'],
            'releasedBaselineRmse': previous['metrics']['rmse'],
            'rmseChangeFromBaseline': candidate['metrics']['rmse']-previous['metrics']['rmse']}})
    return channels


def verify_original_report(report):
    """Audit the four original case records; no physical acceptance."""
    config, p, rows = configuration(), reference.protocol(), reference.reference_rows()
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    require(report.get('schema') == 'openpwr-krsko-pressure-development-v1' and report.get('executed') is True, 'Wrong pressure report identity.')
    require(report.get('protocolSha256') == reference.PROTOCOL_SHA256 and report.get('protocol') == p, 'Pressure protocol changed.')
    require(report.get('parameterSourcesSha256') == CONFIG_SHA256 and report.get('candidateConfiguration') == config, 'Pressure configuration changed.')
    require(report.get('physicalValidationPassed') is False and report.get('independentValidationPassed') is False, 'Pressure development cannot become independent validation.')
    require(report.get('defaultPromotionRecommended') is False and report.get('productionDefault') == 'equilibrium', 'Experimental report cannot change the production default.')
    require(report.get('baselineSha256') == p['baseline']['sha256'], 'Released pressure baseline changed.')
    require(report.get('inputDataSha256') == p['reference']['dataSha256'], 'Measured pressure reference changed.')
    require(report.get('comparisonWindowS') == [0, 15] and report.get('fixedControlAssumptions') == FIXED_CONTROLS,
            'Pressure comparison window or boundary assumptions changed.')
    require(report.get('releasedBaseline') == p['baseline'], 'Displayed released baseline changed.')
    require(report.get('appliedSourceParameters') == applied_parameters(), 'Pressure parameters changed.')
    cases = report['cases']
    require([case['id'] for case in cases] == [case['id'] for case in config['cases']], 'Pressure cases omitted or changed.')
    for case, planned in zip(cases, config['cases']):
        require(all(case.get(key) == planned[key] for key in ('id', 'model', 'finitePhase', 'wall')), 'Pressure case configuration changed.')
        for label, step in (('nominal', .05), ('refined', .025)):
            run = case[label]
            require(run.get('stepSeconds') == step and run.get('parameters') == applied_parameters(), 'Pressure run parameters changed.')
            require(run.get('solverRelativeTolerance') == 1e-11 and run.get('requestedSolverRelativeTolerance') == 1e-11, 'Pressure solver tolerance changed.')
            require(run.get('runtime', {}).get('model') == case['model']
                    and run['runtime'].get('fmuSha256') == case['buildManifest']['fmuSha256'], 'Mixed pressure executables.')
            if run.get('completed') is False:
                point = run.get('terminalObservation', {})
                require(run.get('status') == 'failed-domain' and run.get('failureKind') == 'NativeDomainExit', 'Unclassified native pressure failure.')
                require(set(point) == {'time', *CHANNELS, *DIAGNOSTICS} and all(math.isfinite(value) for value in point.values())
                        and 0 <= point['time'] <= 15, 'Missing pressure domain-exit observation.')
                violations = domain_violations(point, case)
                require(bool(violations) and run.get('domainViolations') == violations, 'Invalid pressure domain-failure proof.')
                require('points' not in run and 'integrals' not in run, 'A failed pressure run cannot supply a complete trace.')
                continue
            require(run.get('completed') is True and run.get('status') == 'completed', 'Incomplete pressure run.')
            require([point['time'] for point in run['points']] == list(range(16)), 'Truncated pressure trace.')
            require(all(set(point) == {'time', *CHANNELS, *DIAGNOSTICS} and all(math.isfinite(value) for value in point.values()) for point in run['points']), 'Missing or nonfinite pressure diagnostics.')
            reconstructed = quadrature_integrals(run, rows)
            require(all(math.isclose(run['integrals'][key], value, abs_tol=1e-8, rel_tol=1e-12) for key, value in reconstructed.items()), 'Pressure independent integrals were changed.')
            first, last = run['points'][0], run['points'][-1]
            for field, inventory, integral in [('massIntegralErrorKg', 'totalMassKg', 'massKg'), ('energyIntegralErrorMJ', 'thermalEnergyMJ', 'energyMJ')]:
                expected = last[inventory]-first[inventory]-run['integrals'][integral]
                require(math.isclose(run[field], expected, abs_tol=1e-9, rel_tol=1e-11), 'Pressure inventory error was changed.')
            for field, inventory, integral in [('nativeMassIntegralErrorKg', 'totalMassKg', 'integratedBoundaryMassKg'),
                                               ('nativeEnergyIntegralErrorMJ', 'thermalEnergyMJ', 'integratedBoundaryEnergyMJ')]:
                expected = last[inventory]-first[inventory]-(last[integral]-first[integral])
                require(math.isclose(run[field], expected, abs_tol=1e-9, rel_tol=1e-11), 'Native pressure inventory error was changed.')
        complete = case['nominal']['completed'] and case['refined']['completed']
        expected_channels = channels_for(case['nominal'], case['refined']) if complete else []
        require(case['channels'] == expected_channels, 'Pressure channel metrics do not match native traces.')
        checks = case_numerical_checks(case)
        require(case['numericalChecks'] == checks and case['numericalPassed'] is all(check['pass'] for check in checks), 'Pressure numerical case checks changed.')
    reproduction, mesh = cross_case_checks(cases)
    require(report['baselineReproductionChecks'] == reproduction and report['wallMeshChecks'] == mesh, 'Pressure paired numerical checks changed.')
    checks = [check for case in cases for check in case['numericalChecks']]+reproduction+mesh
    numerical = (all(case['nominal']['completed'] and case['refined']['completed'] for case in cases)
                 and len(reproduction) == 4 and len(mesh) == 8 and all(check['pass'] for check in checks))
    require(report['numericalChecks'] == checks and report['numericalPassed'] is numerical, 'Pressure numerical result changed.')
    by_id = {case['id']: case for case in cases}
    require(report.get('channels') == displayed_channels(cases), 'Displayed pressure channels or ablations were changed.')
    require(report.get('trace') == by_id['candidate']['nominal'].get('points', []), 'Displayed pressure trace differs from scored native trace.')
    require(report.get('runtime') == by_id['candidate']['nominal']['runtime']
            and report.get('buildManifest') == by_id['candidate']['buildManifest'], 'Displayed pressure executable identity changed.')
    expected_inputs = [{'name': name, 'points': [{'time': time, 'value': reference.at(rows, time, name)} for time in range(16)]} for name in INPUTS]
    require(report.get('inputs') == expected_inputs, 'Displayed pressure forcing differs from original measurements.')
    guards = reference.paired_improvement(by_id['candidate']['channels'], by_id['equilibrium']['channels']) if numerical else None
    require(report.get('pairedGuards') == guards, 'Paired pressure development guards changed.')
    improvement = bool(numerical and guards['caseImprovementPassed'])
    require(report.get('caseImprovementPassed') is improvement, 'Pressure improvement claim changed.')
    expected_status = 'development-improvement' if improvement else 'development-no-improvement' if numerical else 'numerical-failure'
    require(report['status'] == expected_status, 'Pressure status overclaims the evidence.')
    return True


def core_api():
    """Explicit shared helper namespace, also safe for importlib-based audits."""
    return SimpleNamespace(**globals())


def regularization_amendment():
    if sha(REGULARIZATION) != REGULARIZATION_SHA256 or sha(ARCHIVE) != ARCHIVE_SHA256:
        raise ValueError('Frozen numerical amendment or original executable archive changed.')
    amendment = json.loads(REGULARIZATION.read_text(encoding='utf-8'))
    if amendment['historicalSnapshot']['sha256'] != ARCHIVE_SHA256 or ARCHIVE.stat().st_size != amendment['historicalSnapshot']['bytes']:
        raise ValueError('Historical pressure archive metadata changed.')
    return amendment


def coordinate_amendment():
    if sha(COORDINATE_AMENDMENT) != COORDINATE_AMENDMENT_SHA256:
        raise ValueError('Frozen exact-coordinate numerical amendment changed.')
    return json.loads(COORDINATE_AMENDMENT.read_text(encoding='utf-8'))


def final_numerics_amendment():
    if sha(FINAL_NUMERICS) != FINAL_NUMERICS_SHA256:
        raise ValueError('Frozen final numerical selection changed.')
    return json.loads(FINAL_NUMERICS.read_text(encoding='utf-8'))


def verify_component(report):
    """Recompute the unmeasured component checks from complete native traces."""
    data = report.get('componentVerification', {})
    path = component.OUTPUT
    if (not path.is_file() or report.get('componentVerificationSha256') != sha(path)
            or data != json.loads(path.read_text(encoding='utf-8'))):
        raise ValueError('Component verification artifact is missing or changed.')
    if (data.get('schema') != 'openpwr-pressure-component-verification-v1'
            or data.get('executed') is not True or data.get('physicalValidationPassed') is not False
            or data.get('solver') != 'DASSL' or data.get('solverRelativeTolerance') != component.SOLVER_TOLERANCE
            or data.get('modelicaLibrary') != '4.0.0' or data.get('numericalLimits') != component.LIMITS):
        raise ValueError('Component experiment or claim changed.')
    for key, path in component.SOURCES.items():
        if data.get(key) != sha(ROOT / path) or data.get(key) != report.get(key):
            raise ValueError('Component check does not use current shared sources: '+key)
    definitions = [{'id': case_id, 'model': 'PressureComponentChecks.'+model, 'kind': kind,
        'durationSeconds': duration, 'sampleIntervalSeconds': component.SAMPLE_INTERVAL}
        for case_id, model, kind, duration in component.CASES]
    if data.get('scenarioDefinitions') != definitions or len(data.get('scenarios', [])) != len(definitions):
        raise ValueError('Component experiment omitted or changed.')
    for scenario, expected in zip(data['scenarios'], definitions):
        if any(scenario.get(key) != value for key, value in expected.items()) or scenario.get('complete') is not True:
            raise ValueError('Incomplete component experiment.')
        runtime = scenario.get('runtime', {})
        if (runtime.get('solver') != 'DASSL' or runtime.get('solverRelativeTolerance') != component.SOLVER_TOLERANCE
                or runtime.get('modelicaLibrary') != '4.0.0'
                or any(not isinstance(runtime.get(key), str) or len(runtime[key]) != 64
                    or any(c not in '0123456789abcdef' for c in runtime[key])
                    for key in ('executableSha256', 'traceCsvSha256'))):
            raise ValueError('Component runtime provenance changed.')
        component.verify_trace(scenario['trace'], expected['kind'], expected['durationSeconds'])
    checks = component.numerical_checks(data['scenarios'])
    if data.get('numericalChecks') != checks or data.get('numericalPassed') is not all(check['pass'] for check in checks):
        raise ValueError('Component numerical results differ from retained observations.')
    return True


def verify_report(report):
    """Audit original cases, immutable history, components and conditional spray."""
    verify_original_report(report)
    expected_amendment = regularization_amendment()
    if (report.get('regularizationAmendmentSha256') != REGULARIZATION_SHA256
            or report.get('originalAttemptArchiveSha256') != ARCHIVE_SHA256
            or report.get('regularizationAmendment') != expected_amendment
            or report.get('coordinateAmendmentSha256') != COORDINATE_AMENDMENT_SHA256
            or report.get('coordinateAmendment') != coordinate_amendment()
            or report.get('finalNumericsAmendmentSha256') != FINAL_NUMERICS_SHA256
            or report.get('finalNumericsAmendment') != final_numerics_amendment()
            or report.get('originalAttemptSummarySha256') != spray.SUMMARY_SHA256
            or report.get('originalDevelopmentAttempt') != spray.original_attempt()):
        raise ValueError('Original failed attempt or numerical amendment changed.')
    reproduction = spray.original_reproduction_checks(core_api(), report['cases'])
    if (report.get('originalAttemptReproductionChecks') != reproduction
            or report.get('originalAttemptReproduced') is not (len(reproduction) == 16 and all(check['pass'] for check in reproduction))):
        raise ValueError('Original-attempt reproduction result changed.')
    verify_component(report)
    spray.verify_report(core_api(), report['conditionalSpray'], report['cases'])
    return True


def compare():
    config, p, current = configuration(), reference.protocol(), identity()
    manifests = {case['id']: check_manifest(case, current) for case in config['cases']}
    rows, cases = reference.reference_rows(), []
    for planned in config['cases']:
        print('Running', planned['id'], flush=True)
        nominal, refined = simulate(planned, rows, .05), simulate(planned, rows, .025)
        case = {**planned, 'buildManifest': manifests[planned['id']], 'nominal': nominal, 'refined': refined,
                'channels': channels_for(nominal, refined) if nominal['completed'] and refined['completed'] else []}
        case['numericalChecks'] = case_numerical_checks(case)
        case['numericalPassed'] = all(check['pass'] for check in case['numericalChecks'])
        cases.append(case)
    reproduction, mesh = cross_case_checks(cases)
    checks = [check for case in cases for check in case['numericalChecks']]+reproduction+mesh
    numerical = (all(case['nominal']['completed'] and case['refined']['completed'] for case in cases)
                 and len(reproduction) == 4 and len(mesh) == 8 and all(check['pass'] for check in checks))
    by_id, old = {case['id']: case for case in cases}, reference.baseline()
    guards = reference.paired_improvement(by_id['candidate']['channels'], by_id['equilibrium']['channels']) if numerical else None
    improvement = bool(numerical and guards['caseImprovementPassed'])
    status = 'development-improvement' if improvement else 'development-no-improvement' if numerical else 'numerical-failure'
    channels = displayed_channels(cases)
    report = {'schema': 'openpwr-krsko-pressure-development-v1', **current,
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'executed': True,
        'caseId': p['caseId'], 'title': 'Production pressure model: measured Krško development comparison',
        'status': status, 'physicalValidationPassed': False, 'validationPassed': False,
        'independentValidationPassed': False, 'caseImprovementPassed': improvement,
        'defaultPromotionRecommended': False, 'productionDefault': 'equilibrium',
        'conclusion': ('The candidate passes the prospective pressure-improvement and other-channel guards on this previously observed event; independent plant validation remains unestablished.' if improvement
            else 'The candidate does not establish a guarded production-accuracy improvement. Discrepancies and adverse changes are retained; the production equilibrium default remains unchanged.'),
        'scope': 'Development comparison of the shared production thermal kernel with measured core-heat and steam/feedwater boundaries. It excludes kinetics, turbine synchronization, plant controls and complete cold-start validation.',
        'source': old['source'], 'sourceURL': old['sourceURL'], 'dataURL': old['dataURL'],
        'protocol': p, 'candidateConfiguration': config, 'initialBoundaries': json.loads(BOUNDARIES.read_text(encoding='utf-8')),
        'sourceAudit': json.loads(AUDIT.read_text(encoding='utf-8')), 'appliedSourceParameters': applied_parameters(),
        'fixedControlAssumptions': FIXED_CONTROLS, 'comparisonWindowS': [0, 15],
        'runtime': by_id['candidate']['nominal']['runtime'], 'buildManifest': manifests['candidate'],
        'releasedBaseline': p['baseline'], 'channels': channels, 'cases': cases,
        'numericalChecks': checks, 'numericalPassed': numerical,
        'baselineReproductionChecks': reproduction, 'wallMeshChecks': mesh, 'pairedGuards': guards,
        'inputs': [{'name': name, 'points': [{'time': time, 'value': reference.at(rows, time, name)} for time in range(16)]} for name in INPUTS],
        'assumptions': [*(text.replace('The primary model omits wall heat storage and transport delays.',
            'Primary-loop piping/fuel structures and transport delays remain unresolved; the finite-phase pressurizer adds the declared vessel-wall inventory.')
            for text in old['assumptions']), config['sourceAnalogue']['qualification'],
            config['sourceAnalogue']['geometryTransformation'], config['initialization']['wallTemperature'],
            'The finite-phase formulation, wall assumptions and graded meshes were selected before candidate scoring. This previously observed event remains development evidence, not a new blind holdout.',
            'The no-wall case isolates wall storage and condensation; the refined-wall case changes only numerical mesh resolution. All four response channels and every signed guarded metric change remain visible.'],
        'trace': by_id['candidate']['nominal'].get('points', [])}
    report['regularizationAmendment'] = regularization_amendment()
    report['coordinateAmendment'] = coordinate_amendment()
    report['finalNumericsAmendment'] = final_numerics_amendment()
    report['originalDevelopmentAttempt'] = spray.original_attempt()
    report['originalAttemptReproductionChecks'] = spray.original_reproduction_checks(core_api(), cases)
    report['originalAttemptReproduced'] = (len(report['originalAttemptReproductionChecks']) == 16
        and all(check['pass'] for check in report['originalAttemptReproductionChecks']))
    report['conditionalSpray'] = spray.run(core_api(), cases, current)
    report['componentVerification'] = json.loads(component.OUTPUT.read_text(encoding='utf-8'))
    report['componentVerificationSha256'] = sha(component.OUTPUT)
    after = identity()
    if any(after[key] != value for key, value in current.items() if key.endswith('Sha256')):
        raise RuntimeError('Pressure comparison sources changed during execution.')
    for case in [*cases, *report['conditionalSpray']['cases']]:
        if sha(paths(case)[0]) != case['buildManifest']['fmuSha256']:
            raise RuntimeError('Pressure executable changed during execution.')
    verify_report(report)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    print('Numerical:', sum(check['pass'] for check in checks), '/', len(checks), 'paired improvement:', improvement)
    for channel in channels:
        print(channel['name'], 'RMSE', channel['metrics']['rmse'], channel['unit'], 'baseline', channel['metrics']['releasedBaselineRmse'])
    print('Evidence:', OUTPUT)
    print('Conditional numerical:', report['conditionalSpray']['numericalPassed'],
        'paired improvement:', report['conditionalSpray']['caseImprovementPassed'])
    if not (numerical and report['conditionalSpray']['numericalPassed']
            and report['componentVerification']['numericalPassed'] and report['originalAttemptReproduced']):
        raise RuntimeError('Pressure numerical verification failed; failed evidence retained but candidate release is blocked.')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    if args.build:
        build()
    compare()
