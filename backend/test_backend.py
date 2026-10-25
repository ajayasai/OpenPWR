"""Protocol and lifecycle regression tests; no compiler required.

Set OPENPWR_FMU to add an actual native-model smoke test. The fake slave below
tests host boundaries only and is never exposed as an application backend.
"""
# SPDX-License-Identifier: Apache-2.0
import csv
import http.client
import io
import json
import math
import os
from pathlib import Path
from tempfile import TemporaryDirectory, mkdtemp
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend.fmi_host import CONTROL_LIMITS, DEFAULT_CONTROLS, REAL_OUTPUTS, FMIPlant, ServiceError
from backend.server import LocalServer
from backend import server as server_module


def description():
    variables = [SimpleNamespace(name=name, valueReference=i, type="Real", causality="input", start=value)
        for i, (name, value) in enumerate(DEFAULT_CONTROLS.items())]
    variables += [SimpleNamespace(name=name, valueReference=i + 100, type="Real", causality="output", start=None)
        for i, name in enumerate(REAL_OUTPUTS)]
    variables += [SimpleNamespace(name="valid", valueReference=500, type="Boolean", causality="output", start=None)]
    return SimpleNamespace(fmiVersion="2.0", modelName="OpenPWR.PrimaryLoop", guid="test-guid",
        generationTool="unit-test-double", modelVariables=variables,
        coSimulation=SimpleNamespace(modelIdentifier="PrimaryLoop"))


class FakeSlave:
    def __init__(self, **_):
        self.values = {i + 100: float(i) for i in range(len(REAL_OUTPUTS))}
        self.valid, self.fail, self.steps, self.freed = True, False, [], False

    def instantiate(self): pass
    def setupExperiment(self, **_): pass
    def enterInitializationMode(self): pass
    def exitInitializationMode(self): pass
    def terminate(self): pass
    def freeInstance(self): self.freed = True
    def setReal(self, refs, values): self.values.update(zip(refs, values))
    def getReal(self, refs): return [self.values[r] for r in refs]
    def getBoolean(self, _): return [self.valid]
    def doStep(self, **kwargs):
        if self.fail:
            raise RuntimeError("native fault")
        self.steps.append(kwargs)


class HostFixture:
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.fmu = Path(self.temp.name) / "test.fmu"
        self.fmu.write_bytes(b"not-a-real-FMU-test-double")
        self.plant = FMIPlant(self.fmu, description=description(), slave_factory=FakeSlave, extractor=lambda _: mkdtemp())

    def tearDown(self):
        self.plant.close()
        self.temp.cleanup()


class HostTest(HostFixture, unittest.TestCase):
    def test_server_bind_failure_releases_native_model(self):
        with patch("sys.argv", ["server.py", "--fmu", str(self.fmu)]), \
                patch.object(server_module, "FMIPlant", return_value=self.plant), \
                patch.object(server_module, "LocalServer", side_effect=OSError("address in use")):
            with self.assertRaises(OSError): server_module.main()
        self.assertIsNone(self.plant.slave)
        self.assertIsNone(self.plant.directory)

    def test_invalid_commands_are_atomic(self):
        original = self.plant.state()
        for values in [{}, {"unknown": 1}, {"pumpCommand": True}, {"pumpCommand": -1},
                {"pumpCommand": math.nan}, {"pumpCommand": 0.5, "heaterPowerMW": 999}]:
            with self.assertRaises(ServiceError):
                self.plant.control(values)
            self.assertEqual(original, self.plant.state())

    def test_exact_communication_steps_and_no_hidden_wall_clock(self):
        self.plant.step(0.25)
        self.assertEqual(len(self.plant.slave.steps), 5)
        self.assertAlmostEqual(self.plant.state()["time"], 0.25)
        self.assertTrue(all(item["communicationStepSize"] == 0.05 for item in self.plant.slave.steps))
        self.assertAlmostEqual(self.plant.slave.steps[-1]["currentCommunicationPoint"], 0.2)
        before = self.plant.state()
        for seconds in [0, 0.11, 10.1, math.inf, True]:
            with self.assertRaises(ServiceError): self.plant.step(seconds)
        self.assertEqual(before, self.plant.state())

    def test_invalid_model_stops_at_first_communication_boundary(self):
        self.plant.slave.valid = False
        state = self.plant.step(1)
        self.assertTrue(state["halted"])
        self.assertEqual(len(self.plant.slave.steps), 1)
        with self.assertRaises(ServiceError): self.plant.step(0.1)
        with self.assertRaises(ServiceError): self.plant.control({"pumpCommand": 0.5})

    def test_native_failure_and_nonfinite_output_never_advance_again(self):
        self.plant.slave.fail = True
        with self.assertRaises(ServiceError): self.plant.step(1)
        self.assertTrue(self.plant.state()["halted"])
        self.plant.reset()
        self.plant.slave.values[100] = math.nan
        with self.assertRaises(ServiceError): self.plant.step(1)
        self.assertTrue(self.plant.state()["halted"])
        json.dumps(self.plant.state(), allow_nan=False)

    def test_rejected_native_observation_preserves_last_confirmed_timestamp(self):
        self.plant.step(0.25)
        before = self.plant.state()
        self.plant.slave.values[100] = math.nan
        with self.assertRaises(ServiceError): self.plant.step(0.1)
        after = self.plant.state()
        self.assertEqual(after["time"], before["time"])
        self.assertEqual(after["outputs"], before["outputs"])
        self.assertTrue(after["halted"])
        rows = list(csv.DictReader(io.StringIO(self.plant.export_csv())))
        self.assertEqual(float(rows[-1]["time"]), before["time"])
        self.assertEqual(float(rows[-1]["hotLegTemperatureC"]), before["outputs"]["hotLegTemperatureC"])

    def test_reset_replaces_native_instance_and_export_has_current_paused_controls(self):
        old = self.plant.slave
        self.plant.step(0.25)
        self.plant.control({"heaterPowerMW": 2})
        rows = list(csv.DictReader(io.StringIO(self.plant.export_csv())))
        self.assertEqual(float(rows[-1]["time"]), 0.25)
        self.assertEqual(float(rows[-1]["heaterPowerMW"]), 2)
        self.assertEqual(self.plant.export_commands()["commands"][0]["time"], 0.25)
        self.plant.reset()
        self.assertTrue(old.freed)
        self.assertEqual(self.plant.state()["time"], 0)
        self.assertEqual(self.plant.state()["controls"], DEFAULT_CONTROLS)
        self.assertEqual(self.plant.export_commands()["commands"], [])

    def test_metadata_failure_is_explicit_without_fallback(self):
        bad = description()
        bad.fmiVersion = "3.0"
        with self.assertRaises(ServiceError) as caught:
            FMIPlant(self.fmu, description=bad, slave_factory=FakeSlave, extractor=lambda _: mkdtemp())
        self.assertEqual(caught.exception.status, 503)


class HttpTest(HostFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.root = Path(self.temp.name)
        (self.root / "engineering.html").write_text("<h1>Engineering</h1>", encoding="utf-8")
        (self.root / "secret.txt").write_text("not public", encoding="utf-8")
        self.server = LocalServer(("127.0.0.1", 0), plant=self.plant, root=self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        super().tearDown()

    def request(self, method, path, body=None, headers=None):
        client = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        defaults = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.server.server_port}"}
        defaults.update(headers or {})
        client.request(method, path, json.dumps(body) if body is not None else None, defaults)
        response = client.getresponse()
        status, data, response_headers = response.status, response.read(), dict(response.headers)
        client.close()
        return status, data, response_headers

    def test_http_control_and_export(self):
        status, body, _ = self.request("POST", "/api/control", {"pumpCommand": 0.5})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["controls"]["pumpCommand"], 0.5)
        self.assertEqual(self.request("POST", "/api/step", {"seconds": 0.25})[0], 200)
        status, body, headers = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertIn("text/csv", headers["Content-Type"])
        self.assertIn(b"primaryPressureMPa", body)

    def test_cross_site_requests_cannot_change_or_probe_backend(self):
        before = self.plant.state()
        self.assertEqual(self.request("POST", "/api/control", {"pumpCommand": 0}, {"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.request("POST", "/api/control", {"pumpCommand": 0}, {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("GET", "/api/state", headers={"Host": "example.com"})[0], 403)
        self.assertEqual(before, self.plant.state())

    def test_static_allowlist_and_headers(self):
        status, body, headers = self.request("GET", "/engineering.html")
        self.assertEqual(status, 200)
        self.assertIn(b"Engineering", body)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        for path in ["/secret.txt", "/backend/server.py", "/docs/../secret.txt", "/docs/%2e%2e/secret.txt"]:
            self.assertEqual(self.request("GET", path)[0], 404, path)

    def test_unavailable_native_engine_is_503(self):
        self.server.plant = None
        status, body, _ = self.request("GET", "/api/health")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "backend_unavailable")


@unittest.skipUnless(os.environ.get("OPENPWR_FMU"), "Set OPENPWR_FMU to run the compiled native model")
class NativeSmokeTest(unittest.TestCase):
    def test_real_model_controls_step_and_reset(self):
        plant = FMIPlant(os.environ["OPENPWR_FMU"])
        try:
            start = plant.state()
            self.assertTrue(start["outputs"]["valid"])
            self.assertEqual(plant.health()["backend"], "fmi2")
            after = plant.step(1)
            self.assertEqual(after["time"], 1)
            plant.control({"pumpCommand": 0.8})
            after = plant.step(1)
            self.assertLess(after["outputs"]["pumpSpeed"], start["outputs"]["pumpSpeed"])
            plant.reset()
            self.assertEqual(plant.state()["outputs"], start["outputs"])
        finally:
            plant.close()


if __name__ == "__main__":
    unittest.main()
