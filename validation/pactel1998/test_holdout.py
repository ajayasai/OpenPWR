"""Protect response separation, source identity, and the declared holdout window."""
# SPDX-License-Identifier: Apache-2.0
import copy
import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import holdout_compare as holdout
import holdout_extract as extract


class SyntheticFigure:
    """Red measurement and a different black prediction, with calibrated axes."""
    size = (970, 690)

    def __init__(self, *, gap=False, branch=False):
        self.gap, self.branch = gap, branch

    def convert(self, mode):
        if mode != 'RGB':
            raise ValueError(mode)
        return self

    def getpixel(self, xy):
        x, y = xy
        if (x in (97, 930) and 55 <= y <= 615) or (y in (55, 615) and 97 <= x <= 930):
            return (0, 0, 0)
        if y == 300 and 98 <= x <= 507 and not (self.gap and 197 <= x <= 207):
            return (255, 0, 0)
        if self.branch and x == 250 and y == 320:
            return (255, 0, 0)
        if x == 600 and y in (310, 330):  # Excluded later response must remain unread.
            return (255, 0, 0)
        if y == 200:
            return (0, 0, 0)
        return (255, 255, 255)


def fixture_run(step=.1):
    return {'points': [{'time': time, 'pressureMPa': 6 + time / 1000,
        'totalMassKg': 10 + time / 10, 'thermalEnergyMJ': 100 + time / 5,
        'integratedBoundaryMassKg': time / 10, 'integratedBoundaryEnergyMJ': time / 5,
        'massResidualKgS': 0, 'energyResidualMW': 0} for time in range(296)],
        'integrals': {'massKg': 29.5, 'energyMJ': 59}, 'stepSeconds': step,
        'steps': round(295 / step), 'solverRelativeTolerance': 1e-9,
        'requestedSolverRelativeTolerance': 1e-9,
        'solverToleranceBasis': 'Synthetic accounting fixture only.',
        'runtime': {'model': holdout.MODEL_NAME, 'fmuSha256': 'fixture'}}


class HeldOutReference(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.protocol = json.loads(holdout.PROTOCOL.read_text(encoding='utf-8'))
        cls.metadata = json.loads(holdout.METADATA.read_text(encoding='utf-8'))
        cls.shared = holdout._main_comparator()

    def test_reference_bytes_window_and_uncertainty_are_bound(self):
        rows = holdout.load_data()
        self.assertEqual([row['time'] for row in rows], list(range(5, 296)))
        self.assertNotIn(b'\r', holdout.DATA.read_bytes())
        self.assertEqual(self.protocol['sourceSha256'], self.metadata['source']['sha256'])
        self.assertEqual(self.protocol['selectedAtUTC'], self.metadata['experiment']['selectedAtUTC'])
        self.assertEqual(self.protocol['simulationWindowS'], [0, 295])
        self.assertEqual(self.protocol['comparisonWindowS'], [5, 295])
        self.assertLess(self.protocol['simulationWindowS'][1], 297)
        self.assertIsNone(self.metadata['publishedBoundaryModel']['outsurgeMassFlowKgS'])
        self.assertIsNone(self.metadata['experiment']['originalAcquisitionPeriodS'])
        self.assertAlmostEqual(self.metadata['measurementUncertainty']['conditionalPressureEnvelopeMPa'], .094 + 2 * 4 / 560)

    def test_inputs_remain_distinct_from_measured_response(self):
        contract = self.metadata['calibrationAndHoldout']
        self.assertFalse(set(contract['forcingChannels']) & set(contract['heldOutResponseChannels']))
        self.assertEqual(contract['heldOutResponseChannels'], ['pressureMPa'])
        self.assertEqual(self.protocol['modelParameters']['initialLevelM'], 3.5)
        self.assertFalse(self.protocol['developmentSeparation']['responseSharedWithModelDeveloperBeforeFreeze'])
        self.assertEqual(self.protocol['scoring']['offsetCorrection'].split(';')[0], 'None')
        self.assertIn('not historically blind', self.metadata['experiment']['qualification'])

    def test_forcing_keeps_declared_ramps_and_rejects_unidentified_drain(self):
        forcing, events = holdout.make_forcing(self.protocol, self.shared)
        self.assertEqual(events, [0, 99, 100, 118, 119, 295])
        self.assertAlmostEqual(forcing(99.5)['heaterPowerMW'], .002)
        self.assertAlmostEqual(forcing(118.5)['surgeFlowKgS'], .1085)
        self.assertEqual(forcing(295), {'surgeFlowKgS': .217, 'surgeTemperatureK': 547, 'heaterPowerMW': 0})
        for time in (-1, 295.01, 297, math.nan):
            with self.assertRaises(ValueError):
                forcing(time)

    def test_extraction_selects_red_path_and_never_reads_later_response(self):
        rows, diagnostics = extract.pressure_points(SyntheticFigure())
        self.assertEqual(len(rows), 291)
        self.assertTrue(all(row['pressureMPa'] == 7.25 for row in rows))
        self.assertAlmostEqual(diagnostics['figureTimeReadingAllowanceS'], 1200 / 833)
        for invalid in (SyntheticFigure(gap=True), SyntheticFigure(branch=True)):
            with self.assertRaises(ValueError):
                extract.pressure_points(invalid)

    def test_synthetic_pressure_bias_is_never_removed(self):
        rows = [{'time': time, 'pressureMPa': 5 + time / 1000} for time in range(5, 296)]
        channel = holdout.pressure_channel(rows, fixture_run(), fixture_run(.05), self.metadata, self.shared)
        self.assertAlmostEqual(channel['metrics']['rmse'], 1)
        self.assertAlmostEqual(channel['metrics']['initialBias'], 1)
        self.assertAlmostEqual(channel['metrics']['finalError'], 1)
        self.assertEqual(channel['metrics']['conditionalEnvelopeCoveredPositions'], 0)
        self.assertNotIn('peakError', channel['metrics'])

    def test_native_grid_finiteness_and_executable_identity_fail_closed(self):
        good = fixture_run()
        holdout.check_runs([good], {'fmuSha256': 'fixture'})
        bad_runs = [copy.deepcopy(good) for _ in range(4)]
        bad_runs[0]['points'].pop()
        bad_runs[1]['points'][0]['pressureMPa'] = math.nan
        bad_runs[2]['integrals']['energyMJ'] = math.inf
        bad_runs[3]['runtime']['model'] = 'Different.Model'
        for bad in bad_runs:
            with self.assertRaises(ValueError):
                holdout.check_runs([bad], {'fmuSha256': 'fixture'})


class HeldOutFreeze(unittest.TestCase):
    def test_missing_freeze_prevents_model_execution(self):
        with TemporaryDirectory() as directory, patch.object(holdout, 'run_case') as run:
            with patch.object(holdout, 'FREEZE', Path(directory) / 'missing.json'):
                with self.assertRaisesRegex(ValueError, 'Freeze'):
                    holdout.run_holdout({})
            run.assert_not_called()

    def test_freeze_cannot_be_reset_or_silently_survive_source_changes(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'freeze.json'
            with patch.object(holdout, 'FREEZE', path), patch.object(holdout, 'source_identity', return_value={'sourceSha256': 'before'}):
                frozen = holdout.freeze_candidate()
                self.assertFalse(frozen['responseUsedForModelSelection'])
                self.assertNotIn(b'\r', path.read_bytes())
                self.assertEqual(holdout.checked_freeze(), frozen)
                with self.assertRaises(FileExistsError):
                    holdout.freeze_candidate()
            with patch.object(holdout, 'FREEZE', path), patch.object(holdout, 'source_identity', return_value={'sourceSha256': 'after'}):
                with self.assertRaisesRegex(ValueError, 'changed after'):
                    holdout.checked_freeze()

    def test_unbound_source_or_freeze_prevents_model_execution(self):
        identity = {key: 'fixture-' + key for key in holdout.source_identity()}
        with TemporaryDirectory() as directory:
            fmu, freeze = Path(directory) / 'test.fmu', Path(directory) / 'freeze.json'
            fmu.write_bytes(b'Fixture only'); freeze.write_text('{}', encoding='utf-8')
            manifest = {**identity, 'model': holdout.MODEL_NAME, 'fmuSha256': holdout.sha(fmu),
                'holdoutFreezeSha256': holdout.sha(freeze), 'comparisonScriptSha256': identity['case10ComparatorSha256']}
            checked_keys = ('sourceSha256', 'benchmarkModelSha256', 'sharedRunnerSha256',
                'holdoutDataSha256', 'holdoutMetadataSha256', 'holdoutComparatorSha256',
                'holdoutProtocolSha256', 'holdoutExtractorSha256', 'holdoutFreezeSha256', 'comparisonScriptSha256')
            with patch.object(holdout, 'FREEZE', freeze), patch.object(holdout, 'checked_freeze', return_value={}), \
                    patch.object(holdout, 'source_identity', return_value=identity), patch.object(holdout, 'run_case') as run:
                for key in checked_keys:
                    unbound = {k: v for k, v in manifest.items() if k != key}
                    with self.assertRaises(ValueError):
                        holdout.run_holdout(unbound, fmu_path=fmu)
                run.assert_not_called()

    def test_nested_report_preserves_protocol_and_separates_numerical_acceptance(self):
        identity = {key: 'fixture-' + key for key in holdout.source_identity()}
        with TemporaryDirectory() as directory:
            fmu, freeze = Path(directory) / 'test.fmu', Path(directory) / 'freeze.json'
            fmu.write_bytes(b'Fixture only'); freeze.write_text('{}', encoding='utf-8')
            manifest = {**identity, 'model': holdout.MODEL_NAME, 'fmuSha256': holdout.sha(fmu),
                'holdoutFreezeSha256': holdout.sha(freeze), 'version': 'fixture',
                'comparisonScriptSha256': identity['case10ComparatorSha256']}
            runs = [fixture_run(step) for step in (.1, .05)]
            for run in runs:
                run['runtime']['fmuSha256'] = manifest['fmuSha256']
            rows = [{'time': time, 'pressureMPa': 5 + time / 1000} for time in range(5, 296)]
            with patch.object(holdout, 'FREEZE', freeze), patch.object(holdout, 'checked_freeze', return_value={}), \
                    patch.object(holdout, 'source_identity', return_value=identity), patch.object(holdout, 'load_data', return_value=rows), \
                    patch.object(holdout, 'run_case', side_effect=runs) as native_run:
                report = holdout.run_holdout(manifest, fmu_path=fmu)
            self.assertTrue(report['numericalPassed'])
            self.assertFalse(report['validationPassed'])
            self.assertEqual(report['status'], 'inconclusive')
            self.assertEqual(len(report['numericalChecks']), 8)
            self.assertEqual(report['channels'][0]['metrics']['conditionalEnvelopeCoveredPositions'], 0)
            self.assertEqual(native_run.call_count, 2)
            for call, step in zip(native_run.call_args_list, (.1, .05)):
                self.assertEqual(call.args[5:7], (295, step))
                self.assertEqual(call.kwargs['parameters']['initialLevelM'], 3.5)
                self.assertEqual(call.kwargs['event_times'], [0, 99, 100, 118, 119, 295])
                self.assertEqual(call.kwargs['solver_tolerance'], 1e-9)


if __name__ == '__main__':
    unittest.main()
