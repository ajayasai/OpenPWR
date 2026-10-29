"""Independent reference helpers and cold verification source-integrity checks."""
# SPDX-License-Identifier: Apache-2.0
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.verify_cold import saturation_pressure_pa, pump_energy_mj, startup_inputs, verify


class ColdReferenceTests(unittest.TestCase):
    def test_independent_saturation_equation_matches_published_if97_table_35(self):
        # IAPWS-IF97 region 4, Table 35: p_s(T) verification values in MPa.
        for temperature,pressure in [(300,.00353658941),(500,2.63889776),(600,12.3443146)]:
            with self.subTest(temperature=temperature):
                self.assertAlmostEqual(saturation_pressure_pa(temperature)/1e6,pressure,delta=5e-8)

    def test_exact_pump_work_agrees_with_independent_midpoint_quadrature(self):
        seconds=60;dt=.001
        reference=sum(12*(1-math.exp(-((i+.5)*dt)/7))**3*dt for i in range(round(seconds/dt)))
        self.assertAlmostEqual(pump_energy_mj(seconds),reference,delta=1e-5)
        self.assertEqual(pump_energy_mj(0),0)

    def test_startup_event_times_have_explicit_left_and_right_limits(self):
        self.assertEqual(startup_inputs(math.nextafter(3600,0))['ventFraction'],0)
        self.assertEqual(startup_inputs(3600)['ventFraction'],1)
        self.assertEqual(startup_inputs(math.nextafter(7200,0))['ventFraction'],1)
        self.assertEqual(startup_inputs(7200)['ventFraction'],0)
        self.assertEqual(startup_inputs(18000)['startupHeatMW'],15)

    def test_changed_cold_source_is_rejected_before_native_execution(self):
        manifest={'coldSourceSha256':'deliberately-wrong'}
        with tempfile.TemporaryDirectory() as directory:
            with patch('backend.verify_cold.read_verified_manifest',return_value=manifest), \
                 patch('backend.verify_cold.execute',side_effect=AssertionError('must reject before native execution')):
                with self.assertRaisesRegex(RuntimeError,'coldSourceSha256'):
                    verify(Path(directory)/'ColdStartPlant.fmu',Path(directory)/'report.json')


if __name__=='__main__':
    unittest.main()
