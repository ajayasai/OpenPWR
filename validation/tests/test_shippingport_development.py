"""Checks for the same-event assessment, independent of native fitting or an FMU build."""
# SPDX-License-Identifier: Apache-2.0
import copy
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

path = Path(__file__).resolve().parents[1] / "shippingport_development" / "assess.py"
spec = importlib.util.spec_from_file_location("shippingport_assessment", path)
case = importlib.util.module_from_spec(spec)
spec.loader.exec_module(case)


class ShippingportAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.protocol = json.loads(case.PROTOCOL_FILE.read_bytes())

    def test_candidate_archive_and_trace_are_pinned(self):
        raw = case.NATIVE_FILE.read_bytes()
        reference = case.frozen_model(raw)
        with self.assertRaisesRegex(ValueError, "trace fingerprint"):
            case.frozen_model(raw + b" ")
        archived = case.frozen_runner_sources()
        for name, source in archived.items():
            self.assertEqual(case.sha256(source).hexdigest(), reference["sourceHashes"][name])
        case.validate_source_lineage(reference, reference, fresh=False)

    def test_fresh_case_requires_all_original_physics_and_development_inputs(self):
        reference = case.frozen_model(case.NATIVE_FILE.read_bytes())
        fresh = copy.deepcopy(reference)
        hashes = fresh["sourceHashes"]
        hashes[case.HISTORICAL_BASE] = hashes.pop(case.ORIGINAL_BASE)
        for name in case.ARCHIVED_RUNNERS:
            hashes[name] = case.sha256(case.checkout_source(name)).hexdigest()
        case.validate_source_lineage(fresh, reference, fresh=True)
        hashes[case.HISTORICAL_BASE] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed a frozen input"):
            case.validate_source_lineage(fresh, reference, fresh=True)
        del hashes[case.HISTORICAL_BASE]
        with self.assertRaisesRegex(ValueError, "missing a candidate input"):
            case.validate_source_lineage(fresh, reference, fresh=True)

    def test_embedded_base_and_specialization_must_match_original_compilation_sources(self):
        reference = case.frozen_model(case.NATIVE_FILE.read_bytes())
        sources = {"sources/ContinuousPlant.mo": case.checkout_source(case.HISTORICAL_BASE),
                   "sources/ShippingportStartup.mo": case.checkout_source("models/ShippingportStartup.mo")}
        with TemporaryDirectory() as temp:
            fmu = Path(temp) / "model.fmu"
            for changed in (None, *sources):
                with ZipFile(fmu, "w") as out:
                    for name, data in sources.items():
                        out.writestr(name, data + b" " if name == changed else data)
                if changed is None:
                    case.verify_embedded_sources(fmu, reference["sourceHashes"])
                else:
                    with self.assertRaisesRegex(ValueError, "frozen historical Modelica source"):
                        case.verify_embedded_sources(fmu, reference["sourceHashes"])

    def test_development_view_excludes_both_windows_source_flags_and_proxy_channels(self):
        data = case.development_data()
        channels = {c["key"]: c["points"] for c in data["channels"]}
        self.assertEqual({k: len(v) for k, v in channels.items()}, {"primaryPressure": 43, "averageCoolantTemperature": 7})
        for rows in channels.values():
            self.assertEqual(rows[0]["split"], "initialization")
            self.assertEqual(sum(p["split"] == "initialization" for p in rows), 1)
            self.assertTrue(all(row["at"] != "1958-06-24T19:20" for row in rows))
            for block in self.protocol["withheldBlocks"]:
                self.assertFalse(any(block["start"] <= p["at"] <= block["end"] for p in rows))

    def test_persistence_uses_strictly_prior_development_observation(self):
        observations = case.observations(self.protocol)
        primary = next(c for c in observations if c["key"] == "primaryPressure")
        synthetic = [2.9] * (case.DURATION // case.STEP + 1)
        generic = case.generic_traces(self.protocol)["primaryPressure"]
        report = case.compare_channel(primary, synthetic, generic)
        early = [p for p in report["points"] if p["split"] == "withheldEarly"]
        before = max((p for p in primary["points"] if p["at"] < early[0]["at"]), key=lambda p: p["at"])
        self.assertEqual(len(early), 4)
        self.assertTrue(all(p["persistence"] == before["value"] for p in early))
        changed = copy.deepcopy(primary)
        for p in changed["points"]:
            if p["split"] in case.RESERVED or p["split"] == "excluded":
                p["value"] += 123
        amended = case.compare_channel(changed, synthetic, generic)
        self.assertEqual([p["persistence"] for p in amended["points"]], [p["persistence"] for p in report["points"]])
        self.assertIsNone(report["points"][0]["persistence"])
        self.assertEqual(report["scores"]["allEligible"]["candidate"]["n"], 52)

    def test_common_support_does_not_extrapolate_the_short_generic_run(self):
        channels = case.observations(self.protocol)
        generic = case.generic_traces(self.protocol)
        for c in channels:
            synthetic = [1.0] * (case.DURATION // case.STEP + 1)
            r = case.compare_channel(c, synthetic, generic[c["key"]])
            totals = r["scores"]["withheld"]
            early_n, late_n = (4, 6) if c["key"] == "primaryPressure" else (1, 8)
            self.assertEqual(totals["candidate"]["n"], early_n + late_n)
            self.assertEqual(r["coverage"]["withheldOutsideGenericWindow"], late_n)
            self.assertEqual({v["n"] for v in totals["commonGeneric"].values()}, {early_n})
            self.assertTrue(all(p["generic"] is None for p in r["points"] if p["elapsedS"] > 27000))
            self.assertTrue(all(v["rmse"] is None for v in r["scores"]["withheldLate"]["commonGeneric"].values()))

    def test_score_direction_and_empty_support(self):
        observed = [{"elapsedS": 20, "observed": 10, "predicted": 8},
                    {"elapsedS": 30, "observed": 20, "predicted": 23}]
        stats = case.scored(observed, "predicted")
        self.assertEqual(stats["bias"], 0.5)
        self.assertAlmostEqual(stats["rmse"], (6.5) ** 0.5)
        self.assertEqual(stats["mae"], 2.5)
        empty = case.scored([], "predicted")
        self.assertIsNone(empty["rmse"])
        self.assertIsNone(case.improved(empty, empty))
        self.assertFalse(case.improved(stats, stats))

    def test_native_trace_requires_every_finite_sample_through_the_station_endpoint(self):
        rows = [[t, 10, 2] for t in range(0, case.DURATION + 1, case.STEP)]
        base = {"model": {"fixture": "synthetic"}, "columns": ["elapsedS", "averageCoolantTemperature", "primaryPressure"],
                "rows": rows}
        self.assertEqual(len(case.native_traces(base)["primaryPressure"]), 1741)
        for changed in (rows[1:], rows[:-1], rows[:100] + [[6000, float("nan"), 2]] + rows[101:],
                        [rows[1]] + rows[1:]):
            with self.assertRaises(ValueError):
                case.native_traces({**base, "rows": changed})
        rerun = copy.deepcopy(base)
        rerun["rows"][200][2] += 0.002
        with self.assertRaises(ValueError):
            case.compare_repeat(base, rerun)


if __name__ == "__main__":
    unittest.main()
