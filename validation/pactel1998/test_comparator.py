"""Exercise comparison math and provenance independently of native plant physics."""
# SPDX-License-Identifier: Apache-2.0
import copy
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('pactel_comparator', HERE / 'compare.py')
compare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compare)


def run_fixture(step=.1):
    # Deliberately simple test-only inventory histories, not an alternate backend.
    return {'points': [{'time': time, 'pressureMPa': 6 + time / 1000,
                        'totalMassKg': 10 + time / 10, 'thermalEnergyMJ': 100 + time / 5,
                        'integratedBoundaryMassKg': time / 10, 'integratedBoundaryEnergyMJ': time / 5,
                        'massResidualKgS': 0, 'energyResidualMW': 0} for time in range(501)],
            'integrals': {'massKg': 50, 'energyMJ': 100}, 'stepSeconds': step, 'steps': round(500 / step),
            'solverRelativeTolerance': 1e-9, 'requestedSolverRelativeTolerance': 1e-9,
            'solverToleranceBasis': 'Fixture matching compiled and requested tolerance.',
            'runtime': {'model': compare.MODEL_NAME, 'fmuSha256': 'fixture-hash'}}


class PactelComparisonMath(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.metadata = json.loads((HERE / 'provenance.json').read_text(encoding='utf-8'))

    def test_published_ramps_events_and_constant_temperature_are_retained(self):
        forcing, events = compare.make_forcing(self.metadata)
        self.assertEqual(forcing(99.5), {'surgeFlowKgS': 0, 'surgeTemperatureK': 547, 'heaterPowerMW': .002})
        self.assertAlmostEqual(forcing(119.5)['surgeFlowKgS'], .1833)
        self.assertAlmostEqual(forcing(220.5)['surgeFlowKgS'], (.3666 - .215) / 2)
        self.assertEqual(forcing(300)['surgeFlowKgS'], -.215)
        self.assertEqual(forcing(500)['surgeFlowKgS'], 0)
        self.assertTrue({99, 100, 119, 120, 220, 221, 406, 407, 500}.issubset(events))
        with self.assertRaises(ValueError): forcing(-1)
        invalid = copy.deepcopy(self.metadata)
        invalid['publishedBoundaryModel']['surgeMassFlowKgS'][2][0] = 119
        with self.assertRaises(ValueError): compare.make_forcing(invalid)

    def test_boundary_energy_uses_actual_outlet_liquid_and_held_inputs(self):
        observation = {'surgeInletEnthalpyJkg': 2e6, 'surgeOutflowEnthalpyJkg': 1e6,
                       'wallHeatLossMW': .001, 'boundaryPowerMW': 1e9, 'boundaryMassFlowKgS': 1e9}
        held = {'surgeFlowKgS': 2, 'heaterPowerMW': .004}
        self.assertAlmostEqual(compare.energy_flux(held, observation), 4.003)
        self.assertEqual(compare.mass_flux(held, observation), 2)
        held['surgeFlowKgS'] = -2
        self.assertAlmostEqual(compare.energy_flux(held, observation), -1.997)
        self.assertEqual(compare.mass_flux(held, observation), -2)

    def test_timing_envelope_captures_interior_peak_and_clips_endpoints(self):
        triangular = [{'time': 0, 'pressureMPa': 0}, {'time': 1, 'pressureMPa': 10}, {'time': 2, 'pressureMPa': 0}]
        self.assertEqual(compare.pressure_envelope(triangular, 1, .1, 2), (-.1, 10.1))
        self.assertEqual(compare.pressure_envelope(triangular, 0, .1, .5), (-.1, 5.1))
        with self.assertRaises(ValueError): compare.interpolate(triangular, -1, 'pressureMPa')
        with self.assertRaises(ValueError): compare.pressure_envelope(triangular, 1, -.1, 2)

    def test_constant_pressure_bias_is_reported_without_offset_fitting(self):
        primary, refined = run_fixture(), run_fixture(.05)
        measured = [{'time': time, 'pressureMPa': 5 + time / 1000} for time in range(5, 496)]
        channel = compare.pressure_channel(measured, primary, refined, self.metadata)
        self.assertAlmostEqual(channel['metrics']['rmse'], 1)
        self.assertAlmostEqual(channel['metrics']['initialBias'], 1)
        self.assertAlmostEqual(channel['metrics']['changeRmse'], 0)
        self.assertEqual(channel['metrics']['conditionalEnvelopeCoveredPositions'], 0)
        self.assertAlmostEqual(channel['points'][0]['simulated'], 6.005)

    def test_full_trace_checks_physical_inventories_even_when_residuals_are_zero(self):
        primary, refined = run_fixture(), run_fixture(.05)
        rows = compare.load_data()
        manifest = {'fmuSha256': 'fixture-hash'}
        report = compare.make_report(rows, self.metadata, manifest, {}, primary, refined)
        self.assertTrue(report['numericalPassed'])
        self.assertEqual(len(report['numericalChecks']), 8)
        self.assertEqual(report['numericalEvidence']['solverRelativeTolerance'], 1e-9)
        self.assertEqual(report['numericalEvidence']['requestedSolverRelativeTolerance'], 1e-9)
        self.assertEqual(report['numericalEvidence']['solverToleranceBasis'], primary['solverToleranceBasis'])
        self.assertFalse(report['validationPassed'])
        self.assertEqual(report['status'], 'inconclusive')
        primary['points'][-1]['thermalEnergyMJ'] += .01
        report = compare.make_report(rows, self.metadata, manifest, {}, primary, refined)
        self.assertTrue(report['executed'])
        self.assertFalse(report['numericalPassed'])
        self.assertTrue(any(not check['pass'] and check['unit'] == 'MJ' for check in report['numericalChecks']))
        primary['points'].pop()
        with self.assertRaisesRegex(ValueError, 'complete'): compare.make_report(rows, self.metadata, manifest, {}, primary, refined)


class PactelProvenance(unittest.TestCase):
    def test_shared_runner_and_comparison_script_are_bound_in_build_identity(self):
        current = compare.identity()
        self.assertEqual(current['sharedRunnerSha256'], compare.sha(compare.SHARED_RUNNER))
        self.assertEqual(current['comparisonScriptSha256'], compare.sha(HERE / 'compare.py'))
        with TemporaryDirectory() as directory:
            manifest_path = Path(directory) / 'manifest.json'
            for key in ('sourceSha256', 'benchmarkModelSha256', 'inputDataSha256',
                        'referenceMetadataSha256', 'comparisonScriptSha256', 'sharedRunnerSha256'):
                manifest = {**current, 'model': compare.MODEL_NAME, 'fmuSha256': 'fixture-hash'}
                manifest.pop(key)
                manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                with patch.object(compare, 'MANIFEST', manifest_path), patch.object(compare, 'simulate') as simulate:
                    with self.assertRaisesRegex(ValueError, key): compare.compare()
                    simulate.assert_not_called()

    def test_native_failure_is_recorded_without_a_fabricated_comparison(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            fmu = folder / 'fixture.fmu'; fmu.write_bytes(b'Protocol fixture only')
            current = compare.identity()
            manifest = {**current, 'model': compare.MODEL_NAME, 'fmuSha256': compare.sha(fmu)}
            manifest_path = folder / 'manifest.json'; manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            output = folder / 'report.json'
            with patch.object(compare, 'FMU', fmu), patch.object(compare, 'MANIFEST', manifest_path), \
                    patch.object(compare, 'OUTPUT', output), patch.object(compare, 'simulate', side_effect=RuntimeError('Native domain exit')):
                with self.assertRaisesRegex(RuntimeError, 'domain exit'): compare.compare()
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertFalse(report['executed'])
            self.assertFalse(report['numericalPassed'])
            self.assertFalse(report['validationPassed'])
            self.assertEqual(report['channels'], [])
            self.assertEqual(report['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
