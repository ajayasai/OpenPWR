"""Coupled-plant contract and isolation regressions; no fake physics is shipped."""
# SPDX-License-Identifier: Apache-2.0
import copy
import csv
import io
import os
import math
from pathlib import Path
from tempfile import TemporaryDirectory, mkdtemp
from types import SimpleNamespace
import unittest

from backend.fmi_host import FMIPlant, ServiceError
from backend.profiles import PROFILES
from backend.experiments import ExperimentSession, scenario_catalog
from backend.verify_plant import matrix_exponential_action


def description(profile="plant"):
    contract = PROFILES[profile]
    inputs = [SimpleNamespace(name=name, valueReference=index, type="Real", causality="input", start=value)
        for index, (name, value) in enumerate(contract["defaults"].items())]
    outputs = [SimpleNamespace(name=name, valueReference=index + 100, type="Real", causality="output", start=None)
        for index, name in enumerate(contract["real_outputs"])]
    return SimpleNamespace(fmiVersion="2.0", modelName=contract["model"], guid="contract-test-double",
        generationTool="unit-test-double", modelVariables=inputs + outputs +
        [SimpleNamespace(name="valid", valueReference=500, type="Boolean", causality="output", start=None)],
        coSimulation=SimpleNamespace(modelIdentifier=contract["model"].split(".")[-1]))


class ContractSlave:
    def __init__(self, **_):
        self.values = {index + 100: float(index) for index in range(len(PROFILES["plant"]["real_outputs"]))}
    def instantiate(self): pass
    def setupExperiment(self, **_): pass
    def enterInitializationMode(self): pass
    def exitInitializationMode(self): pass
    def terminate(self): pass
    def freeInstance(self): pass
    def setReal(self, refs, values): self.values.update(zip(refs, values))
    def getReal(self, refs): return [self.values[ref] for ref in refs]
    def getBoolean(self, refs): return [True for _ in refs]
    def doStep(self, **_): pass


class PlantProfileTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.path = Path(self.directory.name) / "CoupledPlant.fmu"
        self.path.write_bytes(b"protocol fixture only")
        self.plant = FMIPlant(self.path, profile="plant", description=description(),
            slave_factory=ContractSlave, extractor=lambda _: mkdtemp())
        self.session = ExperimentSession(self.plant)

    def tearDown(self):
        self.plant.close()
        self.directory.cleanup()

    def test_wrong_model_is_rejected_before_native_instantiation(self):
        for selected, declared in [("primary", "plant"), ("plant", "primary")]:
            with self.subTest(selected=selected):
                with self.assertRaises(ServiceError) as caught:
                    FMIPlant(self.path, profile=selected, description=description(declared),
                        slave_factory=lambda **_: self.fail("Wrong model must not instantiate"),
                        extractor=lambda _: self.fail("Wrong model must not extract"))
                self.assertEqual(caught.exception.status, 503)
                self.assertIn("profile requires", str(caught.exception))

    def test_controls_and_observations_are_isolated_to_selected_profile(self):
        health = self.session.health()
        self.assertEqual(health["profile"], "plant")
        self.assertEqual(health["model"], "OpenPWR.CoupledPlant")
        self.assertNotIn("reactorPowerMW", health["controlLimits"])
        self.assertIn("reactorPowerMW", health["realOutputs"])
        self.assertEqual(set(health["controlLimits"]), set(PROFILES["plant"]["defaults"]))
        baseline = self.plant.state()
        for controls in [{"reactorPowerMW": 3000}, {"tripCommand": 0.5}, {"tripCommand": True},
                {"auxAutoEnable": .5}, {"auxPumpAAvailable": True}, {"auxValveBOpen": .2},
                {"loadDemandMW": 900, "reactivityCommandPcm": 301}]:
            with self.assertRaises(ServiceError): self.plant.control(controls)
            self.assertEqual(self.plant.state(), baseline)
        self.plant.control({"loadDemandMW": 900, "tripCommand": 1})
        row = list(csv.DictReader(io.StringIO(self.plant.export_csv())))[-1]
        self.assertEqual(float(row["loadDemandMW"]), 900)
        self.assertIn("secondaryMassKg", row)
        self.assertIn("plantBoundaryPowerMW", row)
        self.assertEqual(set(self.plant.history_points()["points"][0]["outputs"]), set(self.plant.outputs))

    def test_auxiliary_controls_are_recorded_and_missing_train_observations_are_rejected(self):
        self.plant.control({"auxAutoEnable": 0, "auxPumpACommand": .6, "auxPumpBAvailable": 0})
        row = list(csv.DictReader(io.StringIO(self.plant.export_csv())))[-1]
        self.assertEqual(float(row['auxPumpACommand']), .6)
        self.assertEqual(float(row['auxPumpBAvailable']), 0)
        self.assertIn('auxTankMassKg', row)
        self.assertIn('auxTrainAFlowKgS', row)
        bad = description()
        bad.modelVariables = [v for v in bad.modelVariables if v.name != 'auxTrainBFlowKgS']
        with self.assertRaises(ServiceError):
            FMIPlant(self.path, profile='plant', description=bad,
                slave_factory=lambda **_: self.fail('Incomplete plant must not instantiate'),
                extractor=lambda _: self.fail('Incomplete plant must not extract'))

    def test_replay_checks_plant_only_observations_and_validates_before_reset(self):
        self.plant.control({"loadDemandMW": 900})
        self.plant.step(0.1)
        log = self.plant.export_commands()
        changed = copy.deepcopy(log)
        changed["finalState"]["outputs"]["netPowerMW"] += 1
        self.session.replay(changed)
        final = self.session.step(0.1)
        self.assertFalse(final["experiment"]["comparison"]["pass"])
        self.assertEqual([item["name"] for item in final["experiment"]["comparison"]["checks"] if not item["pass"]], ["netPowerMW"])
        before, native = self.plant.state(), self.plant.slave
        invalid = copy.deepcopy(log)
        invalid["finalState"]["outputs"].pop("netPowerMW")
        with self.assertRaises(ServiceError): self.session.replay(invalid)
        self.assertEqual(self.plant.state(), before)
        self.assertIs(self.plant.slave, native)

    def test_scenario_catalogue_and_all_commands_match_model_contract(self):
        catalog = self.session.scenarios()
        self.assertEqual(catalog["model"], "OpenPWR.CoupledPlant")
        self.assertEqual(catalog["profile"], "plant")
        self.assertIn("reactor-trip", [item["id"] for item in catalog["scenarios"]])
        for item in scenario_catalog("plant"):
            self.session.start(item["id"])
            self.assertEqual(self.session.state()["experiment"]["status"], "ready")
        before = self.session.state()
        with self.assertRaises(ServiceError): self.session.start("inventory")
        self.assertEqual(before, self.session.state())


class IndependentExponentialTest(unittest.TestCase):
    def test_independent_exponential_matches_known_decay_and_rotation(self):
        decay = matrix_exponential_action([[-3.0, 0.0], [0.0, -.2]], 10.0, [2.0, 3.0])
        self.assertAlmostEqual(decay[0], 2 * math.exp(-30), delta=1e-13)
        self.assertAlmostEqual(decay[1], 3 * math.exp(-2), delta=1e-13)
        rotation = matrix_exponential_action([[0.0, -1.0], [1.0, 0.0]], 20.0, [1.0, 0.0])
        self.assertAlmostEqual(rotation[0], math.cos(20), delta=1e-13)
        self.assertAlmostEqual(rotation[1], math.sin(20), delta=1e-13)


@unittest.skipUnless(os.environ.get("OPENPWR_PLANT_FMU"), "Set OPENPWR_PLANT_FMU for the compiled coupled plant")
class NativeCoupledSmokeTest(unittest.TestCase):
    def test_real_coupled_model_advances_and_trip_retains_decay_heat(self):
        plant = FMIPlant(os.environ["OPENPWR_PLANT_FMU"], profile="plant")
        try:
            initial = plant.state()
            self.assertFalse(initial["halted"])
            self.assertGreater(initial["outputs"]["netPowerMW"], 900)
            plant.step(0.5)
            plant.control({"tripCommand": 1})
            after = plant.step(0.5)
            self.assertFalse(after["halted"])
            self.assertEqual(after["outputs"]["reactorTripped"], 1)
            self.assertLess(after["outputs"]["fissionPowerMW"], initial["outputs"]["fissionPowerMW"] * 0.3)
            self.assertGreater(after["outputs"]["decayHeatMW"], 0)
        finally:
            plant.close()
