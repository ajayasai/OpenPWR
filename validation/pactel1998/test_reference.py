"""Protect the independent measured/assumed boundary and physical-unit contract."""
# SPDX-License-Identifier: Apache-2.0
import csv
import json
import math
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


class PactelReferenceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.metadata = json.loads((HERE / 'provenance.json').read_text(encoding='utf-8'))
        with (HERE / 'measured.csv').open(newline='', encoding='utf-8') as stream:
            cls.rows = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(stream)]

    def test_complete_finite_pressure_grid_without_invented_endpoints(self):
        self.assertEqual([row['time'] for row in self.rows], list(range(5, 496)))
        self.assertTrue(all(set(row) == {'time', 'pressureMPa'} for row in self.rows))
        self.assertTrue(all(math.isfinite(value) for row in self.rows for value in row.values()))
        self.assertIsNone(self.metadata['experiment']['originalAcquisitionPeriodS'])
        self.assertEqual(self.metadata['extraction']['resamplingIntervalS'], 1)

    def test_measured_curve_is_distinct_from_the_trace_peak(self):
        peak = max(self.rows, key=lambda row: row['pressureMPa'])
        self.assertTrue(7.50 < peak['pressureMPa'] < 7.65)
        self.assertTrue(216 <= peak['time'] <= 222)
        self.assertTrue(5.80 < self.rows[0]['pressureMPa'] < 5.95)
        self.assertTrue(5.30 < self.rows[-1]['pressureMPa'] < 5.45)

    def test_measurement_never_enters_the_boundary_contract(self):
        contract = self.metadata['calibrationAndHoldout']
        self.assertEqual(contract['heldOutResponseChannels'], ['pressureMPa'])
        self.assertFalse(set(contract['forcingChannels']) & set(contract['heldOutResponseChannels']))
        self.assertIn('not raw instrument histories', self.metadata['publishedBoundaryModel']['classification'])
        self.assertEqual(self.metadata['measuredInitialConditions']['pressureMPa'], 5.9)

    def test_geometry_and_published_flow_signs_are_preserved(self):
        initial = self.metadata['measuredInitialConditions']
        boundary = self.metadata['publishedBoundaryModel']
        self.assertAlmostEqual(math.pi * (initial['vesselInnerDiameterM'] / 2) ** 2 * initial['vesselHeightM'], .1348854, delta=1e-6)
        self.assertEqual(initial['liquidLevelM'], 3.3)
        self.assertEqual(boundary['surgeMassFlowKgS'], [[0, 0], [119, 0], [120, .3666], [220, .3666], [221, -.215], [406, -.215], [407, 0]])
        self.assertEqual(boundary['heaterPowerW'], [[0, 4000], [99, 4000], [100, 0]])
        self.assertEqual(boundary['inletTemperatureK'], 547.0)

    def test_uncertainty_belongs_to_this_experiment(self):
        uncertainty = self.metadata['measurementUncertainty']
        self.assertEqual(uncertainty['pressureMaximumAbsoluteErrorMPa'], .094)
        self.assertIsNone(uncertainty['flowMaximumAbsoluteErrorKgS'])
        self.assertIn('ATWS-21', uncertainty['flowNote'])
        self.assertAlmostEqual(self.metadata['extraction']['figureReadingAllowanceMPa'], 2 * 4 / 560)

    def test_reference_bytes_are_checkout_portable(self):
        self.assertNotIn(b'\r', (HERE / 'measured.csv').read_bytes())
        self.assertEqual(len(self.metadata['source']['sha256']), 64)


if __name__ == '__main__':
    unittest.main()
