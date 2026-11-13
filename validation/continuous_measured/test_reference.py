"""Contract tests for measured provenance, scope and independently scored evidence."""
# SPDX-License-Identifier: Apache-2.0
import copy
import importlib.util
import math
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('continuous_measured_compare', HERE / 'compare.py')
case = importlib.util.module_from_spec(spec)
spec.loader.exec_module(case)


def fixture_run(step, scale=1):
    """Synthetic conservation fixture, explicitly not a simulated plant result."""
    rows = case.load_data()
    primitives = dict.fromkeys(case.FLUX_PRIMITIVES, 0.0)
    primitives.update(pumpHeatInputMW=6, feedwaterEnthalpyJkg=1e6, steamEnthalpyJkg=2e6)
    points, quadrature, mass, energy = [], [], 0.0, 0.0
    def point(time):
        result = {'time': time, **dict.fromkeys(case.DIAGNOSTICS, 0.0), **primitives}
        result.update({key: case.at(rows, time, key) for key in case.CHANNELS})
        result.update(fuelTemperatureC=600, primarySubcoolingK=25, primaryFlowKgS=9000,
                      pressurizerTemperatureC=345, pressurizerLevelPercent=50,
                      secondaryTemperatureC=285, secondaryLevelPercent=50)
        result.update(totalMassKg=1e5+mass, thermalEnergyMJ=1e6+energy,
                      integratedBoundaryMassKg=mass, integratedBoundaryEnergyMJ=energy)
        return result
    points.append(point(0))
    for i in range(round(15/step)):
        start = {'time': i*step, **primitives}
        end = {'time': (i+1)*step, **primitives}
        held = {**{key: case.at(rows, start['time'], key) for key in case.INPUTS}, **case.FIXED_CONTROLS}
        quadrature.append({'held': held, 'start': start, 'end': end})
        dt = end['time']-start['time']
        mass += .5*dt*(case.boundary_mass(held, start)+case.boundary_mass(held, end))
        energy += .5*dt*(case.boundary_energy(held, start)+case.boundary_energy(held, end))
        if math.isclose(end['time'], round(end['time']), abs_tol=1e-10):
            points.append(point(end['time']))
    return {'points': points, 'boundaryQuadrature': quadrature,
        'integrals': {'massKg': mass, 'energyMJ': energy}, 'steps': len(quadrature),
        'massIntegralErrorKg': points[-1]['totalMassKg']-points[0]['totalMassKg']-mass,
        'energyIntegralErrorMJ': points[-1]['thermalEnergyMJ']-points[0]['thermalEnergyMJ']-energy,
        'nativeMassIntegralErrorKg': 0, 'nativeEnergyIntegralErrorMJ': 0,
        'completed': True, 'status': 'completed', 'geometryScale': scale, 'stepSeconds': step,
        'solverRelativeTolerance': 1e-11,
        'requestedSolverRelativeTolerance': 1e-11,
        'parameters': {**case.sourced_parameters(), 'geometryScale': scale},
        'runtime': {'model': 'KrskoContinuousThermal', 'fmuSha256': 'fixture-not-an-fmu'}}


def fixture_report():
    p, rows = case.protocol(), case.load_data()
    primary, refined = fixture_run(.05), fixture_run(.025)
    sensitivity = [fixture_run(.05, value) for value in (.5, 2)]
    channels = []
    for key, (name, unit) in case.CHANNELS.items():
        metrics, points = case.metrics(rows, primary, refined, sensitivity, key)
        channels.append({'key': key, 'name': name, 'unit': unit, 'metrics': metrics, 'points': points})
    checks = case.numerical_checks(primary, refined, sensitivity, channels)
    return {'schema': 'openpwr-continuous-measured-v1', 'executed': True, 'status': 'inconclusive',
        'validationPassed': False, 'physicalValidationPassed': False, 'protocol': p,
        'protocolSha256': case.PROTOCOL_SHA256, 'inputDataSha256': case.DATA_SHA256,
        'comparisonWindowS': [0, 15], 'fixedControlAssumptions': case.FIXED_CONTROLS.copy(),
        'appliedSourceParameters': case.sourced_parameters(),
        'buildManifest': {'fmuSha256': 'fixture-not-an-fmu'}, 'primaryRun': primary,
        'refinedRun': refined, 'sensitivity': sensitivity, 'channels': channels,
        'numericalChecks': checks, 'numericalPassed': all(check['pass'] for check in checks),
        'sensitivityCoverageComplete': True, 'trace': copy.deepcopy(primary['points'])}


def failure_fixture(terminal):
    report = fixture_report()
    previous = report['sensitivity'][0]
    report['sensitivity'][0] = {key: previous[key] for key in
        ('geometryScale', 'stepSeconds', 'parameters', 'runtime',
         'solverRelativeTolerance', 'requestedSolverRelativeTolerance')}
    report['sensitivity'][0].update(completed=False, status='failed-domain', failureKind='NativeDomainExit',
        domainStop=f"Native reference domain exit at {terminal['time']:g} s.",
        terminalObservation=terminal, domainViolations=case.domain_violations(terminal))
    channels = []
    for key, (name, unit) in case.CHANNELS.items():
        metrics, points = case.metrics(case.load_data(), report['primaryRun'], report['refinedRun'], report['sensitivity'], key)
        channels.append({'key': key, 'name': name, 'unit': unit, 'metrics': metrics, 'points': points})
    report['channels'] = channels
    report['numericalChecks'] = case.numerical_checks(report['primaryRun'], report['refinedRun'], report['sensitivity'], channels)
    report['sensitivityCoverageComplete'] = False
    return report


class ReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = fixture_report()

    def test_exact_measured_reference_and_prospective_protocol(self):
        self.assertEqual(case.sha(case.PROTOCOL), case.PROTOCOL_SHA256)
        self.assertEqual(case.sha(case.DATA), case.DATA_SHA256)
        self.assertEqual([row['time'] for row in case.load_data()], list(range(-49, 50, 2)))
        self.assertEqual(case.protocol()['metricSampleTimesSeconds'], list(range(1, 16, 2)))
        self.assertFalse(set(case.INPUTS) & set(case.CHANNELS))
        self.assertIsNone(case.protocol()['physicalAcceptanceBand'])

    def test_no_extrapolation(self):
        for time in (-50, 50):
            with self.assertRaises(ValueError):
                case.at(case.load_data(), time, 'reactorPowerMW')

    def test_complete_numerical_fixture_is_accepted(self):
        self.assertTrue(case.verify_report(copy.deepcopy(self.fixture)))

    def test_numerical_checks_cannot_promote_physical_claim(self):
        for key in ('validationPassed', 'physicalValidationPassed'):
            report = copy.deepcopy(self.fixture)
            report[key] = True
            with self.assertRaises(ValueError):
                case.verify_report(report)

    def test_forged_metric_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['channels'][0]['metrics']['rmse'] = 1
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_truncated_native_trace_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['refinedRun']['points'].pop()
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_forged_independent_integral_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['primaryRun']['integrals']['energyMJ'] += .01
        report['primaryRun']['energyIntegralErrorMJ'] -= .01
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_modified_measured_forcing_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['primaryRun']['boundaryQuadrature'][2]['held']['reactorPowerMW'] += .001
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_quadrature_state_reset_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['primaryRun']['boundaryQuadrature'][2]['start']['steamEnthalpyJkg'] += 1
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_omitted_sensitivity_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['sensitivity'].pop()
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_foreign_fmu_trace_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['refinedRun']['runtime']['fmuSha256'] = 'different-fmu'
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_changed_acceptance_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['numericalChecks'][0]['absoluteTolerance'] = 1e6
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_valid_initial_state_cannot_masquerade_as_domain_failure(self):
        report = failure_fixture(copy.deepcopy(self.fixture['sensitivity'][0]['points'][0]))
        report['sensitivity'][0]['domainViolations'] = ['pressurizerLevelPercent']
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_observed_state_exit_retains_failure_and_incomplete_coverage(self):
        terminal = copy.deepcopy(self.fixture['sensitivity'][0]['points'][-1])
        terminal['pressurizerLevelPercent'] = 2.9
        report = failure_fixture(terminal)
        self.assertTrue(case.verify_report(report))
        self.assertEqual(report['sensitivity'][0]['domainViolations'], ['pressurizerLevelPercent'])
        self.assertFalse(report['sensitivityCoverageComplete'])
        self.assertTrue(all(channel['metrics']['maximumGeometrySensitivitySpread'] is None for channel in report['channels']))

    def test_failed_sensitivity_must_have_matching_executable(self):
        terminal = copy.deepcopy(self.fixture['sensitivity'][0]['points'][-1])
        terminal['pressurizerLevelPercent'] = 2.9
        report = failure_fixture(terminal)
        report['sensitivity'][0]['runtime']['fmuSha256'] = 'other-executable'
        with self.assertRaises(ValueError):
            case.verify_report(report)

    def test_completed_trace_outside_production_domain_is_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['primaryRun']['points'][4]['secondaryLevelPercent'] = 98
        with self.assertRaises(ValueError):
            case.verify_report(report)


if __name__ == '__main__':
    unittest.main()
