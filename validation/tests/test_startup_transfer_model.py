# SPDX-License-Identifier: Apache-2.0
import math
import unittest

from validation.startup_transfer.model import fit_parameters, forecast


class DampedTrendTests(unittest.TestCase):
    channel = "primaryPressure"

    def setUp(self):
        self.parameters = {"channels": {self.channel: {"memoryS": 30, "initialRatePerS": 0.01}}}

    def test_single_observation_uses_native_initial_rate(self):
        estimate = forecast(self.channel, [(93, 2.0)], 123, self.parameters)
        self.assertAlmostEqual(estimate, 2.0 + 0.3 * (1 - math.exp(-1)))

    def test_repeated_forecasts_hold_the_same_origin(self):
        history = [(0, 1), (300, 4)]
        early = forecast(self.channel, history, 330, self.parameters)
        late = forecast(self.channel, history, 600, self.parameters)
        self.assertAlmostEqual(early, 4 + 0.3 * (1 - math.exp(-1)))
        self.assertAlmostEqual(late, 4 + 0.3 * (1 - math.exp(-10)))
        self.assertEqual(history, [(0, 1), (300, 4)])

    def test_latest_two_observations_replace_the_prior(self):
        self.assertEqual(forecast(self.channel, [(0, 1), (75, 3), (90, 3)], 3600, self.parameters), 3)
        self.assertLess(forecast(self.channel, [(30, 2), (40, 1)], 70, self.parameters), 1)

    def test_zero_memory_exactly_reproduces_persistence(self):
        self.parameters["channels"][self.channel]["memoryS"] = 0
        self.assertEqual(forecast(self.channel, [(30, 2), (40, 1)], 70, self.parameters), 1)

    def test_invalid_or_future_observations_are_rejected(self):
        for history in ([], [(70, 1)], [(80, 1)], [(30, 1), (30, 2)], [(40, 3), (30, 1)],
                        [(0, float("inf"))], [(float("nan"), 5)]):
            with self.subTest(history=history), self.assertRaises(ValueError):
                forecast(self.channel, history, 70, self.parameters)
        with self.assertRaises(ValueError):
            forecast(self.channel, [(30, 1)], float("nan"), self.parameters)

    def test_fit_rejects_reserved_labels(self):
        sample = {"channels": [{"key": self.channel, "points": [{"split": "withheldEarly"}]}]}
        with self.assertRaisesRegex(ValueError, "Only initializer"):
            fit_parameters(sample, {})


if __name__ == "__main__":
    unittest.main()
