"""Experiment protocol regressions; fakes exercise scheduling, never physics."""
# SPDX-License-Identifier: Apache-2.0
import copy
from collections import deque
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from backend.experiments import ExperimentSession, MAX_COMMANDS, read_log, scenarios
from backend import experiments
from backend.fmi_host import FMIPlant, ServiceError
from backend.test_backend import FakeSlave, HostFixture, HttpFixture


class IntegratingSlave(FakeSlave):
    """Simple input accumulator detects a command applied on the wrong tick."""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.control_calls = []

    def setReal(self, refs, values):
        super().setReal(refs, values)
        self.control_calls.append((len(self.steps), dict(zip(refs, values))))

    def doStep(self, **kwargs):
        super().doStep(**kwargs)
        self.values[100] += self.values[3] * kwargs["communicationStepSize"]


class ExperimentTest(HostFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.plant.slave_factory = IntegratingSlave
        self.plant.reset()
        self.session = ExperimentSession(self.plant)

    def log(self, duration=0.5, commands=None):
        result = self.plant.export_commands()
        result["schema"] = "openpwr-fmi-command-log-v1"
        result.pop("finalState")
        result["time"] = duration
        result["commands"] = commands or []
        return result

    def test_full_replay_validation_precedes_any_mutation(self):
        self.session.control({"heaterPowerMW": 1})
        self.session.step(0.25)
        baseline, slave = self.session.state(), self.plant.slave
        variants = []
        for field, value in [("truncated", True), ("fmuSha256", "other"), ("stepSize", 0.025),
                ("schema", "unsupported"), ("time", 0.11), ("time", 36000.05), ("time", 10 ** 400),
                ("initialControls", {**self.plant.defaults, "pumpCommand": 0.9})]:
            value_log = self.log()
            value_log[field] = value
            variants.append(value_log)
        invalid_commands = [
            [{"time": 0, "controls": {"heaterPowerMW": 2}}, {"time": 0.2, "controls": {"pumpCommand": 2}}],
            [{"time": 0.2, "controls": {"heaterPowerMW": 2}}, {"time": 0.1, "controls": {"heaterPowerMW": 0}}],
            [{"time": 0.55, "controls": {"heaterPowerMW": 2}}],
            [{"time": 0.025, "controls": {"heaterPowerMW": 2}}],
            [{"time": 0, "controls": {"heaterPowerMW": 10 ** 400}}],
            [{"time": 0, "controls": {"heaterPowerMW": 2}, "extra": True}],
            [{"time": 0, "controls": {"heaterPowerMW": 2}}] * (MAX_COMMANDS + 1),
        ]
        variants += [self.log(commands=commands) for commands in invalid_commands]
        invalid_final = self.plant.export_commands()
        invalid_final["finalState"]["outputs"]["pumpSpeed"] = float("nan")
        variants.append(invalid_final)
        for candidate in variants:
            with self.subTest(candidate=str(candidate)[:120]):
                with self.assertRaises(ServiceError): self.session.replay(candidate)
                self.assertEqual(self.session.state(), baseline)
                self.assertIs(self.plant.slave, slave)
                self.assertFalse(slave.freed)

    def test_fractional_and_same_timestamp_events_land_exactly(self):
        commands = [{"time": 0, "controls": {"heaterPowerMW": 1}},
            {"time": 0.15, "controls": {"heaterPowerMW": 2}},
            {"time": 0.15, "controls": {"heaterPowerMW": 3}},
            {"time": 0.2, "controls": {"heaterPowerMW": 0}},
            {"time": 0.35, "controls": {"heaterPowerMW": 1}}]
        state = self.session.replay(self.log(0.35, commands))
        self.assertEqual(state["experiment"]["status"], "ready")
        self.assertEqual(state["experiment"]["appliedEvents"], 1)
        state = self.session.step(10)
        self.assertAlmostEqual(state["time"], 0.35)
        self.assertEqual(state["experiment"]["status"], "complete")
        self.assertEqual(state["experiment"]["appliedEvents"], 5)
        self.assertAlmostEqual(state["outputs"]["hotLegTemperatureC"], 0.3)
        self.assertEqual([tick for tick, _ in self.plant.slave.control_calls[1:]], [0, 3, 3, 4, 7])
        self.assertEqual(len(self.plant.slave.steps), 7)
        self.assertEqual(self.session.step(10), state)
        self.assertIsNone(state["experiment"]["comparison"])

    def test_exported_replay_compares_all_final_outputs_and_detects_drift(self):
        self.session.step(0.15)
        self.session.control({"heaterPowerMW": 2})
        self.session.step(0.2)
        self.session.control({"heaterPowerMW": 1})
        log = self.session.export_commands()
        self.session.replay(log)
        state = self.session.step(10)
        self.assertTrue(state["experiment"]["comparison"]["pass"])
        self.assertEqual(state["experiment"]["comparison"]["maximumAbsoluteDifference"], 0)
        changed = copy.deepcopy(log)
        changed["finalState"]["outputs"]["hotLegTemperatureC"] += 0.01
        self.session.replay(changed)
        state = self.session.step(10)
        self.assertFalse(state["experiment"]["comparison"]["pass"])
        self.assertAlmostEqual(state["experiment"]["comparison"]["maximumAbsoluteDifference"], 0.01)

    def test_domain_boundary_halts_before_future_commands(self):
        self.session.replay(self.log(1, [{"time": 0.1, "controls": {"heaterPowerMW": 2}}]))
        self.plant.slave.valid = False
        state = self.session.step(1)
        self.assertEqual(state["experiment"]["status"], "halted")
        self.assertEqual(state["experiment"]["appliedEvents"], 0)
        self.assertEqual(state["time"], 0.05)
        with self.assertRaises(ServiceError): self.session.step(0.1)
        self.assertEqual(len(self.plant.slave.steps), 1)

    def test_native_fault_preserves_last_confirmed_state_and_marks_experiment_halted(self):
        self.session.replay(self.log())
        before = self.session.state()
        self.plant.slave.values[100] = float("nan")
        with self.assertRaises(ServiceError): self.session.step(0.1)
        after = self.session.state()
        self.assertEqual(after["time"], before["time"])
        self.assertEqual(after["outputs"], before["outputs"])
        self.assertEqual(after["experiment"]["status"], "halted")

    def test_stop_reset_and_manual_control_rules(self):
        self.assertIsNone(self.session.state()["experiment"])
        self.session.start("heater")
        with self.assertRaises(ServiceError): self.session.control({"heaterPowerMW": 2})
        self.session.step(0.25)
        stopped = self.session.stop()
        self.assertEqual(stopped["time"], 0.25)
        self.assertEqual(stopped["experiment"]["status"], "stopped")
        self.session.control({"heaterPowerMW": 2})
        self.assertAlmostEqual(self.session.step(0.1)["time"], 0.35)
        self.assertIsNone(self.session.reset()["experiment"])
        self.session.replay(self.log(0))
        self.assertEqual(self.session.state()["experiment"]["status"], "complete")
        self.assertEqual(self.session.stop()["experiment"]["status"], "stopped")

    def test_history_restores_boundaries_and_current_and_isolated_copies(self):
        self.session.step(0.15)
        self.session.control({"heaterPowerMW": 2})
        self.session.step(2.1)
        full = self.session.history_points()
        self.assertTrue(full["includesCommandBoundaries"])
        self.assertEqual([round(point["time"], 8) for point in full["points"]], [0, 0.15, 1, 2, 2.25])
        sampled = self.session.history_points(3)
        self.assertTrue(sampled["downsampled"])
        self.assertFalse(sampled["includesCommandBoundaries"])
        self.assertTrue(sampled["storageIncludesCommandBoundaries"])
        self.assertEqual(sampled["returnedSamples"], 3)
        self.assertEqual([sampled["points"][0]["time"], sampled["points"][-1]["time"]], [0, 2.25])
        self.assertEqual(sampled["current"], self.session.state())
        full["points"][0]["outputs"]["pumpSpeed"] = -999
        exported = self.session.export_commands()
        exported["commands"][0]["controls"]["heaterPowerMW"] = 3
        self.assertEqual(self.session.export_commands()["commands"][0]["controls"]["heaterPowerMW"], 2)
        self.assertNotEqual(self.session.history_points()["points"][0]["outputs"]["pumpSpeed"], -999)
        self.plant.history = deque(self.plant.history, maxlen=2)
        self.assertTrue(self.session.history_points()["truncated"])
        for limit in [1, 2001, True, 2.5]:
            with self.assertRaises(ServiceError): self.session.history_points(limit)

    def test_initialization_failure_has_truthful_state_history_and_report(self):
        self.plant.slave_factory = lambda **_: (_ for _ in ()).throw(RuntimeError("test initialization fault"))
        with self.assertRaises(ServiceError): self.session.start("heater")
        self.assertTrue(self.session.state()["halted"])
        self.assertIsNone(self.session.state()["experiment"])
        self.assertFalse(self.session.report()["runtime"]["available"])
        self.assertEqual(self.session.history_points()["points"], [])

    def test_cli_writes_machine_failure_report(self):
        prefix = Path(self.temp.name) / "failure"
        with patch.object(experiments, "FMIPlant", return_value=self.plant), \
                patch.object(ExperimentSession, "step", side_effect=ServiceError(409, "solver_halted", "test fault")), \
                patch("sys.argv", ["experiments.py", "--scenario", "heater", "--output", str(prefix)]):
            self.assertEqual(experiments.main(), 2)
        report = json.loads(Path(str(prefix) + ".report.json").read_text())
        self.assertEqual(report["failure"]["error"], "solver_halted")
        self.assertTrue(Path(str(prefix) + ".commands.json").is_file())

    def test_import_file_rejects_ambiguous_json(self):
        path = Path(self.temp.name) / "bad.json"
        for value in ['{"time":0,"time":1}', '{"time":NaN}', '{"time":Infinity}']:
            path.write_text(value, encoding="utf-8")
            with self.assertRaises(ServiceError): read_log(path)


class ExperimentHttpTest(HttpFixture, unittest.TestCase):
    def test_scenario_prepare_history_and_download_contracts(self):
        status, body, _ = self.request("GET", "/api/scenarios")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), scenarios())
        status, body, _ = self.request("POST", "/api/experiment", {"scenario": "heater"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["experiment"]["status"], "ready")
        self.assertEqual(self.request("POST", "/api/control", {"heaterPowerMW": 1})[0], 409)
        self.assertEqual(self.request("POST", "/api/step", {"seconds": 0.25})[0], 200)
        status, body, _ = self.request("GET", "/api/history?maxPoints=2")
        history = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(history["current"]["experiment"]["status"], "running")
        self.assertEqual(history["points"][-1]["time"], 0.25)
        self.assertEqual(self.request("POST", "/api/experiment/stop", {})[0], 200)
        for endpoint in ["commands", "report"]:
            status, body, headers = self.request("GET", "/api/" + endpoint)
            self.assertEqual(status, 200)
            self.assertIn("attachment;", headers["Content-Disposition"])
            self.assertTrue(json.loads(body)["schema"])
        for query in ["maxPoints=1", "maxPoints=2&maxPoints=3", "other=5", "maxPoints=bad"]:
            self.assertEqual(self.request("GET", "/api/history?" + query)[0], 400)

    def test_large_replay_body_is_validated_atomically_and_limit_is_route_specific(self):
        log = self.plant.export_commands()
        log["commands"] = [{"time": 0, "controls": {"heaterPowerMW": 0}}] * 250
        self.assertGreater(len(json.dumps(log)), 8192)
        self.assertEqual(self.request("POST", "/api/replay", log)[0], 200)
        before = self.plant.state()
        log["commands"][-1]["controls"] = {"heaterPowerMW": 999}
        self.assertEqual(self.request("POST", "/api/replay", log)[0], 400)
        self.assertEqual(before, self.plant.state())
        self.assertEqual(self.request("POST", "/api/control", {}, {"Content-Length": "9000"})[0], 413)
        self.assertEqual(self.request("POST", "/api/replay", {}, {"Origin": "https://example.com"})[0], 403)


@unittest.skipUnless(os.environ.get("OPENPWR_FMU"), "Set OPENPWR_FMU to test real native replay")
class NativeExperimentTest(unittest.TestCase):
    def test_fractional_commands_replay_with_changed_request_chunking(self):
        session = ExperimentSession(FMIPlant(os.environ["OPENPWR_FMU"]))
        try:
            session.step(0.15)
            session.control({"heaterPowerMW": 1})
            session.step(0.25)
            session.control({"pumpCommand": 0.95})
            session.step(0.1)
            log = session.export_commands()
            session.replay(log)
            state = session.step(10)
            self.assertEqual(state["experiment"]["status"], "complete")
            self.assertTrue(state["experiment"]["comparison"]["pass"])
        finally:
            session.close()


if __name__ == "__main__":
    unittest.main()
