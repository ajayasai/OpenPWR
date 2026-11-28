"""Source-side checks for the clock-only native forecast and its numerical evidence."""
# SPDX-License-Identifier: Apache-2.0
import json
import unittest

from validation.open_loop_startup import run_native as native


class OpenLoopNativeTest(unittest.TestCase):
    def test_clock_only_schedule_and_final_hold(self):
        case = json.loads(native.SCENARIO.read_text(encoding="utf-8"))
        times, controls = native.schedule(case["controls"], case["durationSeconds"])
        self.assertEqual(times[0], 0)
        self.assertEqual(controls(times[-1]), controls(case["durationSeconds"]))
        self.assertEqual(controls(times[-1])["loadDemandMW"], 1000)
        self.assertEqual(controls(0)["pressureControlEnable"], 0)
        self.assertTrue(all(set(controls(time)) == set(native.CONTINUOUS_DEFAULT_CONTROLS) for time in times))
        self.assertNotEqual(controls(times[1] - 1), controls(times[1]))
        for bad in ("primaryPressureMPa", "hotLegTemperatureC", "coldLegTemperatureC", "measuredSeries"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                native.schedule([{"hour": 0, "set": {bad: 3}}], 3600)

    def test_interior_error_is_retained_and_reported_in_physical_units(self):
        limits = json.loads(native.LIMITS.read_text(encoding="utf-8"))["fullTrajectory"]
        base = {"hotLegTemperatureC": 40, "coldLegTemperatureC": 40, "primaryPressureMPa": .3,
                "netPowerMW": 0, "turbineRpm": 0, "neutronPowerFraction": 0}
        coarse = [dict(base, time=t) for t in (0, 300, 600)]
        fine = [dict(point) for point in coarse]
        fine[1]["coldLegTemperatureC"] += 3
        result = native.refinement(coarse, fine, limits)
        self.assertFalse(result["pass"])
        self.assertEqual(result["comparedSamplesPerChannel"], 3)
        self.assertEqual(result["channels"]["coldLegTemperatureC"]["elapsedS"], 300)
        self.assertEqual(result["channels"]["coldLegTemperatureC"]["meanAbsDifference"], 1)
        self.assertEqual(result["channels"]["averageCoolantTemperatureC"]["maxAbsDifference"], 1.5)
        with self.assertRaises(ValueError):
            native.refinement(coarse, fine[:-1], limits)

    def test_inventory_check_captures_intermediate_drift_and_handles_offsets(self):
        points = [{"stored": 42, "boundary": 9}, {"stored": 40, "boundary": 5}, {"stored": 44, "boundary": 11}]
        self.assertEqual(native.inventory_error(points, "stored", "boundary"), 2)


if __name__ == "__main__":
    unittest.main()
