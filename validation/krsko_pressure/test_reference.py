"""Integrity and prospective guard tests; synthetic candidates are not plant runs."""
# SPDX-License-Identifier: Apache-2.0
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('krsko_pressure_reference', Path(__file__).with_name('reference.py'))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


class ProspectiveReferenceTests(unittest.TestCase):
    def test_exact_released_baseline_preserved(self):
        data = reference.baseline()
        self.assertEqual(data['gitRevision'], '780d7af4c8dfb7e9fb51aeaa99244f3e32ce414d')
        self.assertFalse(data['physicalValidationPassed'])
        self.assertFalse(data['gitDirty'])

    def test_scoring_reproduces_published_errors(self):
        data = reference.baseline()
        channels = reference.score_trace(data['primaryRun']['points'], data['refinedRun']['points'])
        for actual, old in zip(channels, data['channels']):
            for key, value in actual['metrics'].items():
                self.assertEqual(value, old['metrics'][key])
        self.assertEqual(channels[0]['pressureDiagnostics']['measuredPeakTimeSeconds'], 11)
        self.assertEqual(channels[0]['pressureDiagnostics']['simulatedPeakTimeSeconds'], 13)

    def test_unchanged_pressure_cannot_be_claimed_improvement(self):
        channels = reference.baseline()['channels']
        result = reference.paired_improvement(channels, channels)
        self.assertFalse(result['caseImprovementPassed'])
        self.assertFalse(result['physicalValidationPassed'])
        self.assertEqual(len(result['checks']), 18)

    def test_better_pressure_cannot_hide_temperature_regression(self):
        old = reference.baseline()['channels']
        candidate = copy.deepcopy(old)
        for metric in ('rmse', 'changeRmse', 'maximumAbsoluteError'):
            candidate[0]['metrics'][metric] *= .5
        candidate[1]['metrics']['rmse'] += .1
        result = reference.paired_improvement(candidate, old)
        self.assertFalse(result['caseImprovementPassed'])
        self.assertTrue(any(not check['pass'] and check['channel'] == 'hotLegTemperatureC' for check in result['checks']))

    def test_both_release_and_same_boundary_ablation_are_required(self):
        old = reference.baseline()['channels']
        candidate, ablation = copy.deepcopy(old), copy.deepcopy(old)
        for metric in ('rmse', 'changeRmse', 'maximumAbsoluteError'):
            candidate[0]['metrics'][metric] *= .5
            ablation[0]['metrics'][metric] *= .4
        result = reference.paired_improvement(candidate, ablation)
        self.assertFalse(result['caseImprovementPassed'])
        self.assertTrue(any(not check['pass'] and check['reference'] == 'same-boundary-equilibrium-ablation'
                            for check in result['checks']))

    def test_synthetic_guard_pass_is_still_not_independent_validation(self):
        old = reference.baseline()['channels']
        candidate = copy.deepcopy(old)
        for metric in ('rmse', 'changeRmse', 'maximumAbsoluteError'):
            candidate[0]['metrics'][metric] *= .5
        result = reference.paired_improvement(candidate, old)
        self.assertTrue(result['caseImprovementPassed'])
        self.assertFalse(result['physicalValidationPassed'])
        self.assertFalse(result['independentValidationPassed'])

    def test_omitted_adverse_channel_rejected(self):
        old = reference.baseline()['channels']
        with self.assertRaises(ValueError):
            reference.paired_improvement(old[:-1], old)

    def test_failed_refinement_cannot_hide_other_channel_degradation(self):
        old = reference.baseline()['channels']
        candidate = copy.deepcopy(old)
        candidate[1]['metrics']['maximumStepRefinementDifference'] = 100
        with self.assertRaises(ValueError):
            reference.paired_improvement(candidate, old)

    def test_no_reference_extrapolation(self):
        with self.assertRaises(ValueError):
            reference.at(reference.reference_rows(), 50, 'primaryPressureMPa')


if __name__ == '__main__':
    unittest.main()
