# SPDX-License-Identifier: Apache-2.0
import unittest
from unittest.mock import patch
from validation.startup_transfer import compare as scoring


class TransferScoresTest(unittest.TestCase):
    def test_blocked_readings_and_flagged_values_never_enter_history(self):
        def point(t, y, split):
            return {"elapsedS": t, "value": y, "split": split}
        samples = [point(0, 20, "initialization"), point(1, 90, "excluded"),
                   point(2, 23, "development"), point(3, 50, "withheldEarly"),
                   point(4, 85, "withheldEarly"), point(5, 26, "development"),
                   point(6, 30, "withheldLate")]
        with patch.object(scoring, "forecast", side_effect=lambda key, hist, t, params: sum(y for _, y in hist)):
            blocks = scoring.shippingport_points("primaryPressure", samples, {})
        self.assertEqual([p["forecast"] for p in blocks["withheldEarly"]], [43, 43])
        self.assertEqual([p["originS"] for p in blocks["withheldEarly"]], [2, 2])
        self.assertEqual(blocks["withheldLate"][0]["forecast"], 69)
        self.assertEqual(blocks["withheldLate"][0]["persistence"], 26)

    def test_four_hour_forecasts_cannot_use_intervening_readings(self):
        samples = [(3600*h, 2*h) for h in range(1, 24)]
        def last_pair(key, history, t, params):
            self.assertEqual(t - history[-1][0], 14400)
            return history[-1][1]
        with patch.object(scoring, "forecast", side_effect=last_pair):
            rows = scoring.external_points("averageCoolantTemperature", samples, 4, {})
        self.assertEqual((len(rows), rows[0]["originS"], rows[-1]["targetS"]), (19, 3600, 23*3600))
        metrics = scoring.compare("averageCoolantTemperature", rows)
        self.assertEqual(metrics["candidate"], metrics["persistence"])
        self.assertEqual(metrics["deleteOneRmseAdvantageRange"], [0, 0])
        self.assertEqual(metrics["ties"], 19)
        self.assertFalse(metrics["improved"])


if __name__ == "__main__":
    unittest.main()
