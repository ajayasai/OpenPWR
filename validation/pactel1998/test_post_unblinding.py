"""Keep disclosed measurements and the original frozen result distinguishable."""
# SPDX-License-Identifier: Apache-2.0
import copy
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import post_unblinding_compare as development
import holdout_compare as original
from test_holdout import fixture_run


class PostUnblindingEvidence(unittest.TestCase):
    def test_exact_published_v07_result_is_preserved(self):
        baseline = development.historical_evidence()
        self.assertEqual(baseline['gitRevision'], development.BASELINE_REVISION)
        self.assertAlmostEqual(baseline['channels'][0]['metrics']['rmse'], .18711985819585572)
        self.assertAlmostEqual(baseline['holdoutComparison']['channels'][0]['metrics']['rmse'], .20196350926413703)
        self.assertFalse(baseline['holdoutComparison']['candidateFreeze']['responseUsedForModelSelection'])
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'baseline.json'
            path.write_bytes(development.BASELINE.read_bytes() + b' ')
            with patch.object(development, 'BASELINE', path):
                with self.assertRaisesRegex(ValueError, 'immutable'):
                    development.historical_evidence()

    def test_original_freeze_and_scoring_source_cannot_be_replaced(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'freeze.json'
            path.write_text('{}', encoding='utf-8')
            with patch.object(original, 'FREEZE', path):
                with self.assertRaisesRegex(ValueError, 'original scored'):
                    development.historical_evidence()

    def test_baseline_comparison_has_no_alignment_or_bias_removal(self):
        old = {'points': [{'time': 5, 'measured': 5, 'simulated': 6}, {'time': 6, 'measured': 7, 'simulated': 8}]}
        current = {'points': [{'time': 5, 'measured': 5, 'simulated': 7}, {'time': 6, 'measured': 7, 'simulated': 9}], 'metrics': {}}
        development.attach_baseline(current, old)
        self.assertEqual(current['metrics']['v07BaselineRmse'], 1)
        self.assertEqual(current['metrics']['rmseChangeFromV07'], 1)
        self.assertEqual(current['metrics']['rmseReductionFractionFromV07'], -1)
        self.assertEqual([point['baseline'] for point in current['points']], [6, 8])
        for field in ('time', 'measured'):
            bad = copy.deepcopy(current); bad['points'][0][field] += .001
            with self.assertRaisesRegex(ValueError, 'identical measured'):
                development.attach_baseline(bad, old)

    def test_development_report_does_not_claim_a_new_holdout(self):
        identity = original.source_identity()
        with TemporaryDirectory() as directory:
            fmu = Path(directory) / 'test.fmu'; fmu.write_bytes(b'Fixture only')
            manifest = {**identity, 'model': original.MODEL_NAME, 'fmuSha256': development.sha(fmu),
                'comparisonScriptSha256': identity['case10ComparatorSha256'],
                'developmentComparatorSha256': development.sha(Path(development.__file__)),
                'v07BaselineSha256': development.sha(development.BASELINE),
                'holdoutFreezeSha256': development.sha(original.FREEZE), 'version': 'fixture'}
            runs = [fixture_run(step) for step in (.1, .05)]
            for run in runs:
                run['runtime']['fmuSha256'] = manifest['fmuSha256']
            with patch.object(development, 'run_case', side_effect=runs) as native, patch.object(original, 'checked_freeze') as freeze:
                report = development.run_development(manifest, fmu_path=fmu)
            self.assertTrue(report['numericalPassed'])
            self.assertEqual(native.call_count, 2)
            freeze.assert_not_called()
            self.assertEqual(report['comparisonRole'], 'post-unblinding-development')
            self.assertFalse(report['heldOutFromCurrentDevelopment'])
            self.assertFalse(report['validationPassed'])
            self.assertNotIn('candidateFreeze', report)
            self.assertNotIn('noResponseFitting', report['numericalEvidence'])
            self.assertEqual(report['historicalCandidateFreeze'], development.historical_evidence()['holdoutComparison']['candidateFreeze'])
            self.assertEqual(report['releasedBaseline']['reportSha256'], development.BASELINE_SHA256)
            self.assertEqual(len(report['channels'][0]['points']), 291)
            with patch.object(development, 'run_case') as native:
                for key in ('developmentComparatorSha256', 'v07BaselineSha256', 'holdoutFreezeSha256', 'sourceSha256'):
                    bad = {k: v for k, v in manifest.items() if k != key}
                    with self.assertRaises(ValueError):
                        development.run_development(bad, fmu_path=fmu)
                native.assert_not_called()


if __name__ == '__main__':
    unittest.main()
