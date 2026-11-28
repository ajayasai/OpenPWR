# SPDX-License-Identifier: Apache-2.0
import unittest

from validation.open_loop_startup.compare import CHANNELS, ohi, summarize, westinghouse


class TestOpenLoopScoring(unittest.TestCase):
    def test_scores_use_same_station_origin_on_every_later_date(self):
        def pair(pressure, temp):
            return dict(zip(CHANNELS, (pressure, temp)))
        rows = [{"native": pair(4, 102), "station": pair(3, 100)},
                {"native": pair(2, 98), "station": pair(3, 100)}]
        scores = summarize(rows, pair(1, 100))
        self.assertEqual(scores[CHANNELS[0]]["originPersistence"]["rmse"], 2)
        self.assertEqual(scores[CHANNELS[0]]["native"]["bias"], 0)
        self.assertTrue(scores[CHANNELS[0]]["beatsOriginPersistence"])
        self.assertFalse(scores[CHANNELS[1]]["beatsOriginPersistence"])

    def test_missing_or_shifted_observation_cannot_enter_the_score(self):
        with self.assertRaisesRegex(ValueError, "all 14"):
            ohi({}, {"records": []})
        shifted = {"timestamp": "2012-06-26T14:00:00+09:00", "elapsedHours": 0}
        with self.assertRaisesRegex(ValueError, "clock"):
            ohi({}, {"records": [shifted] * 14})
        with self.assertRaisesRegex(ValueError, "hours 0 through 60"):
            westinghouse({}, {"records": [{"elapsedS": 3600 * h} for h in range(1, 61)]})
