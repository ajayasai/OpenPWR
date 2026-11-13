"""Separately frozen, assumption-dependent native spray development experiment."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / 'conditional-spray-config.json'
CONFIG_SHA256 = '649e2e0b2bcff358d5a60fdec1c1d0ebdf75ddeb65d96112f5bc9c7e1df255a7'
INITIAL_SHA256 = '6108ca2516d529e840995d2f89c5c9d19e2f574805b4296e43312aadd0734511'
AMENDMENT_SHA256 = '3e0401fa0219c88182b00cd771467d9487972e04fcdbde4f30f2b9361da0c320'
SUMMARY_SHA256 = '7e6f25a45a369bfa4765a471d9cfc3a2f21921adccce8e1c8f4c9d52575819d2'
SCOPE = ('Conditional development comparison with native generic spray feedback, not a measured Krško actuator-history replay. '
         'The assumed pressure reference, gain, flow cap and contact efficiency do not validate actual plant controls or full startup.')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def configuration():
    paths = [(CONFIG, CONFIG_SHA256), (HERE / 'conditional-spray-config-initial.json', INITIAL_SHA256),
             (HERE / 'conditional-spray-amendment.json', AMENDMENT_SHA256)]
    if any(sha(path) != expected for path, expected in paths):
        raise ValueError('Frozen conditional spray configuration or source-correction history changed.')
    return json.loads(CONFIG.read_text(encoding='utf-8'))


def original_attempt():
    path = HERE / 'original-attempt-summary.json'
    if sha(path) != SUMMARY_SHA256:
        raise ValueError('Original failed pressure attempt summary changed.')
    summary = json.loads(path.read_text(encoding='utf-8'))
    config = configuration()
    if summary['historicalReportSha256'] != config['originalScoredAttempt']['reportSha256']:
        raise ValueError('Original failed pressure attempt identity changed.')
    return summary


def case_plans():
    return [{**case, 'finitePhase': True, 'wall': True, 'conditionalSpray': True}
            for case in configuration()['cases']]


def build_cases():
    cases = case_plans()
    return [cases[0], cases[-1]]


def parameters(case, initial):
    if not case.get('conditionalSpray'):
        return dict(initial)
    controller = configuration()['controller']
    return {**initial, 'sprayReferencePressureMPa': controller['referencePressureMPa'],
        'sprayGainFractionPerMPa': case['gainFractionPerMPa'],
        'sprayMaximumFlowKgS': controller['maximumSprayFlowKgS'],
        'sprayContactEfficiency': case['contactEfficiency']}


def original_reproduction_checks(core, cases):
    initial = {case['id']: case for case in original_attempt()['cases']}
    limits = core.reference.protocol()['numericalLimits']
    checks = []
    for case in cases:
        if not case['nominal']['completed'] or not case['refined']['completed']:
            continue
        old_channels = {channel['key']: channel for channel in initial[case['id']]['channels']}
        for channel in case['channels']:
            old = old_channels[channel['key']]
            difference = max(abs(point[field]-old_point[field]) for point, old_point in zip(channel['points'], old['points'])
                             for field in ('simulated', 'refined'))
            limit = limits['equilibriumBaselineDifferenceMPa' if channel['unit'] == 'MPa' else 'equilibriumBaselineDifferenceK']
            checks.append({'name': case['id']+' '+channel['name']+' original-attempt reproduction',
                           'value': difference, 'absoluteTolerance': limit, 'pass': difference <= limit})
    return checks


def mesh_checks(core, cases):
    left, right = cases[0], cases[-1]
    limits = core.configuration()['wallMesh']
    checks = []
    for key, (name, unit) in core.CHANNELS.items():
        for step in ('nominal', 'refined'):
            if left[step]['completed'] and right[step]['completed']:
                difference = max(abs(point[key]-core.reference.at(right[step]['points'], point['time'], key)) for point in left[step]['points'])
                limit = limits['maximumPressureDifferenceMPa' if unit == 'MPa' else 'maximumTemperatureDifferenceK']
                checks.append({'name': name+' '+step+' conditional spray wall mesh refinement',
                               'value': difference, 'absoluteTolerance': limit, 'pass': difference <= limit})
    return checks


def displayed_channels(core, cases, originals):
    old = core.reference.baseline()
    original = {case['id']: case for case in originals}
    by_id = {case['id']: case for case in cases}
    channels = []
    for nominal in cases[0]['channels']:
        key = nominal['key']
        previous = next(channel for channel in old['channels'] if channel['key'] == key)
        points = []
        for point in nominal['points']:
            extra = {'baseline': core.reference.at(old['primaryRun']['points'], point['time'], key)}
            other_cases = [('equilibrium', original['equilibrium']), ('originalNoSpray', original['candidate']),
                ('gainLow', by_id['spray-gain-low']), ('gainHigh', by_id['spray-gain-high']),
                ('contactHalf', by_id['spray-contact-half']), ('refinedWall', by_id['spray-refined-wall'])]
            for name, other in other_cases:
                extra[name] = core.reference.at(other['nominal']['points'], point['time'], key) if other['nominal']['completed'] else None
            points.append({**point, **extra})
        channels.append({**nominal, 'points': points, 'metrics': {**nominal['metrics'],
            'releasedBaselineRmse': previous['metrics']['rmse'],
            'rmseChangeFromBaseline': nominal['metrics']['rmse']-previous['metrics']['rmse']}})
    return channels


def verify_case(core, case, planned):
    def require(condition, message):
        if not condition:
            raise ValueError('Conditional spray: '+message)
    require(all(case.get(key) == planned[key] for key in
        ('id', 'model', 'finitePhase', 'wall', 'conditionalSpray', 'gainFractionPerMPa', 'contactEfficiency')),
        'case or sensitivity selection changed.')
    rows = core.reference.reference_rows()
    for label, step in (('nominal', .05), ('refined', .025)):
        run = case[label]
        require(run.get('caseId') == case['id'] and run.get('stepSeconds') == step
                and run.get('parameters') == parameters(planned, core.applied_parameters()), 'run parameters changed.')
        require(run.get('solverRelativeTolerance') == 1e-11 and run.get('requestedSolverRelativeTolerance') == 1e-11, 'solver tolerance changed.')
        require(run.get('runtime', {}).get('model') == case['model']
                and run['runtime'].get('fmuSha256') == case['buildManifest']['fmuSha256'], 'mixed native executables.')
        if run.get('completed') is False:
            point = run.get('terminalObservation', {})
            require(run.get('status') == 'failed-domain' and run.get('failureKind') == 'NativeDomainExit', 'unclassified native failure.')
            require(set(point) == {'time', *core.CHANNELS, *core.DIAGNOSTICS}
                    and all(math.isfinite(value) for value in point.values()) and 0 <= point['time'] <= 15, 'missing terminal state.')
            violations = core.domain_violations(point, case)
            require(bool(violations) and run.get('domainViolations') == violations, 'invalid state-domain failure proof.')
            require('points' not in run and 'integrals' not in run, 'failed run cannot provide a complete trace.')
            continue
        require(run.get('completed') is True and run.get('status') == 'completed', 'incomplete native run.')
        require([point['time'] for point in run['points']] == list(range(16)), 'truncated trace.')
        require(all(set(point) == {'time', *core.CHANNELS, *core.DIAGNOSTICS}
                    and all(math.isfinite(value) for value in point.values()) for point in run['points']), 'invalid diagnostics.')
        integrals = core.quadrature_integrals(run, rows)
        require(all(math.isclose(run['integrals'][key], value, abs_tol=1e-8, rel_tol=1e-12) for key, value in integrals.items()), 'independent quadrature changed.')
        first, last = run['points'][0], run['points'][-1]
        for field, inventory, integral in [('massIntegralErrorKg', 'totalMassKg', 'massKg'), ('energyIntegralErrorMJ', 'thermalEnergyMJ', 'energyMJ')]:
            expected = last[inventory]-first[inventory]-run['integrals'][integral]
            require(math.isclose(run[field], expected, abs_tol=1e-9, rel_tol=1e-11), 'independent inventory error changed.')
        for field, inventory, integral in [('nativeMassIntegralErrorKg', 'totalMassKg', 'integratedBoundaryMassKg'),
                                          ('nativeEnergyIntegralErrorMJ', 'thermalEnergyMJ', 'integratedBoundaryEnergyMJ')]:
            expected = last[inventory]-first[inventory]-(last[integral]-first[integral])
            require(math.isclose(run[field], expected, abs_tol=1e-9, rel_tol=1e-11), 'native inventory error changed.')
    complete = case['nominal']['completed'] and case['refined']['completed']
    expected_channels = core.channels_for(case['nominal'], case['refined']) if complete else []
    require(case['channels'] == expected_channels, 'channel metrics differ from native traces.')
    checks = core.case_numerical_checks(case)
    require(case['numericalChecks'] == checks and case['numericalPassed'] is all(check['pass'] for check in checks), 'numerical case result changed.')


def verify_report(core, report, originals):
    def require(condition, message):
        if not condition:
            raise ValueError('Conditional spray: '+message)
    config = configuration()
    require(report.get('configurationSha256') == CONFIG_SHA256 and report.get('configuration') == config, 'frozen configuration changed.')
    require(report.get('executed') is True and report.get('scope') == SCOPE, 'execution or assumption scope changed.')
    require(all(report.get(key) is False for key in ('physicalValidationPassed', 'independentValidationPassed',
        'actualPlantControlValidated', 'defaultPromotionRecommended')), 'conditional development is overclaimed.')
    cases = report['cases']
    require([case['id'] for case in cases] == [case['id'] for case in case_plans()], 'nominal or sensitivity cases changed.')
    for case, planned in zip(cases, case_plans()):
        verify_case(core, case, planned)
    mesh = mesh_checks(core, cases)
    checks = [check for case in cases for check in case['numericalChecks']]+mesh
    numerical = len(mesh) == 8 and all(case['nominal']['completed'] and case['refined']['completed'] for case in cases) and all(check['pass'] for check in checks)
    require(report['wallMeshChecks'] == mesh and report['numericalChecks'] == checks and report['numericalPassed'] is numerical, 'numerical result changed.')
    equilibrium = next(case for case in originals if case['id'] == 'equilibrium')
    guards = [{'id': case['id'], 'pairedGuards': core.reference.paired_improvement(case['channels'], equilibrium['channels'])} for case in cases] if numerical else []
    nominal_guards = guards[0]['pairedGuards'] if guards else None
    improvement = bool(numerical and nominal_guards['caseImprovementPassed'])
    require(report.get('sensitivityGuards') == guards and report.get('pairedGuards') == nominal_guards, 'paired development guards changed or best sensitivity substituted.')
    require(report.get('caseImprovementPassed') is improvement, 'conditional improvement flag changed.')
    expected_status = 'conditional-development-improvement' if improvement else 'conditional-development-no-improvement' if numerical else 'numerical-failure'
    require(report['status'] == expected_status, 'conditional status overclaims results.')
    require(report['channels'] == displayed_channels(core, cases, originals), 'displayed sensitivity curves changed.')
    require(report['trace'] == cases[0]['nominal'].get('points', [])
            and report['runtime'] == cases[0]['nominal']['runtime']
            and report['buildManifest'] == cases[0]['buildManifest'], 'nominal selection or displayed identity changed.')
    return True


def run(core, originals, current_identity):
    config, rows = configuration(), core.reference.reference_rows()
    cases = []
    for planned in case_plans():
        print('Running conditional', planned['id'], flush=True)
        manifest = core.check_manifest(planned, current_identity)
        nominal, refined = core.simulate(planned, rows, .05), core.simulate(planned, rows, .025)
        case = {**planned, 'buildManifest': manifest, 'nominal': nominal, 'refined': refined,
            'channels': core.channels_for(nominal, refined) if nominal['completed'] and refined['completed'] else []}
        case['numericalChecks'] = core.case_numerical_checks(case)
        case['numericalPassed'] = all(check['pass'] for check in case['numericalChecks'])
        cases.append(case)
    mesh = mesh_checks(core, cases)
    checks = [check for case in cases for check in case['numericalChecks']]+mesh
    numerical = len(mesh) == 8 and all(case['nominal']['completed'] and case['refined']['completed'] for case in cases) and all(check['pass'] for check in checks)
    equilibrium = next(case for case in originals if case['id'] == 'equilibrium')
    guards = [{'id': case['id'], 'pairedGuards': core.reference.paired_improvement(case['channels'], equilibrium['channels'])} for case in cases] if numerical else []
    nominal_guards = guards[0]['pairedGuards'] if guards else None
    improvement = bool(numerical and nominal_guards['caseImprovementPassed'])
    report = {'configuration': config, 'configurationSha256': CONFIG_SHA256, 'executed': True,
        'title': 'Conditional native spray: measured Krško development comparison',
        'scope': SCOPE, 'status': 'conditional-development-improvement' if improvement else 'conditional-development-no-improvement' if numerical else 'numerical-failure',
        'physicalValidationPassed': False, 'independentValidationPassed': False,
        'actualPlantControlValidated': False, 'defaultPromotionRecommended': False,
        'caseImprovementPassed': improvement,
        'conclusion': ('The preselected nominal spray assumption passes the relative development guards. Its pressure response is improved conditionally; the actual plant spray history and controls remain unvalidated.' if improvement
            else 'The preselected nominal spray assumption does not establish a guarded development improvement. All sensitivities and adverse changes remain visible; no best-fitting case is substituted.'),
        'assumptions': [config['selectionContext'], config['claimBoundary'],
            config['controller']['referenceBasis'], config['controller']['gainBasis'],
            config['controller']['capacityBasis'], config['controller']['contactBasis'],
            config['controller']['actuatorDynamics']],
        'cases': cases, 'channels': displayed_channels(core, cases, originals),
        'numericalChecks': checks, 'numericalPassed': numerical, 'wallMeshChecks': mesh,
        'pairedGuards': nominal_guards, 'sensitivityGuards': guards,
        'runtime': cases[0]['nominal']['runtime'], 'buildManifest': cases[0]['buildManifest'],
        'trace': cases[0]['nominal'].get('points', [])}
    verify_report(core, report, originals)
    return report
