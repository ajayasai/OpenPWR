"""Guard the measured reference's physical units, independence and time domain."""
# SPDX-License-Identifier: Apache-2.0
import json
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import compare
from compare import CHANNELS, DATA, INPUTS, PROVENANCE, at, load_data


class MeasuredReferenceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = load_data()
        cls.provenance = json.loads(PROVENANCE.read_text(encoding='utf-8'))

    def test_pressure_units_match_independent_initial_table(self):
        # A mistaken reading of the plot's MPa label would be 10 times larger.
        self.assertAlmostEqual(at(self.rows, 0, 'primaryPressureMPa'), 15.48, delta=.02)
        self.assertAlmostEqual(at(self.rows, 0, 'steamPressureMPa'), 6.41, delta=.02)

    def test_temperature_units_match_independent_initial_table(self):
        self.assertAlmostEqual(at(self.rows, 0, 'hotLegTemperatureC'), 594.175-273.15, delta=.3)
        self.assertAlmostEqual(at(self.rows, 0, 'coldLegTemperatureC'), 559.445-273.15, delta=.3)

    def test_no_held_out_response_is_a_forcing(self):
        contract = self.provenance['calibrationAndHoldout']
        self.assertEqual(set(contract['forcingChannels']), set(INPUTS))
        self.assertEqual(set(contract['heldOutResponseChannels']), set(CHANNELS))
        self.assertFalse(set(INPUTS) & set(CHANNELS))
        self.assertEqual(self.provenance['experiment']['comparisonWindowS'], [0, 15])

    def test_reference_bytes_are_checkout_portable(self):
        self.assertNotIn(b'\r', DATA.read_bytes())

    def test_build_identity_binds_comparison_script_and_rejects_stale_manifest(self):
        current = compare.identity()
        expected = hashlib.sha256(Path(__file__).with_name('compare.py').read_bytes()).hexdigest()
        self.assertEqual(current['comparisonScriptSha256'], expected)
        with TemporaryDirectory() as directory:
            manifest = Path(directory) / 'manifest.json'
            for stale in (None, '0' * 64):
                invalid = dict(current)
                if stale is None:
                    del invalid['comparisonScriptSha256']
                else:
                    invalid['comparisonScriptSha256'] = stale
                manifest.write_text(json.dumps(invalid), encoding='utf-8')
                with patch.object(compare, 'MANIFEST', manifest), patch.object(compare, 'simulate') as simulate:
                    with self.assertRaisesRegex(ValueError, 'comparisonScriptSha256'):
                        compare.compare()
                    simulate.assert_not_called()

    def test_reference_extrapolation_is_rejected(self):
        for time in (-50, 50):
            with self.assertRaises(ValueError):
                at(self.rows, time, 'primaryPressureMPa')

    def test_two_loop_aggregation_and_power_conversion(self):
        for row in self.rows:
            self.assertAlmostEqual(row['reactorPowerMW'], row['nuclearPowerPercent']*19.94, places=5)
            self.assertAlmostEqual(row['steamFlowKgS'], row['steam1FlowKgS']+row['steam2FlowKgS'], places=5)
            self.assertAlmostEqual(row['feedwaterFlowKgS'], row['feedwater1FlowKgS']+row['feedwater2FlowKgS'], places=5)
            self.assertAlmostEqual(row['steamPressureMPa'], (row['steam1PressureMPa']+row['steam2PressureMPa'])/2, places=5)


if __name__ == '__main__':
    unittest.main()
