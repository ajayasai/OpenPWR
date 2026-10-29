"""Cold-profile protocol checks; test doubles never stand in for model evidence."""
# SPDX-License-Identifier: Apache-2.0
import copy
from pathlib import Path
from tempfile import TemporaryDirectory, mkdtemp
from types import SimpleNamespace
import unittest

from backend.experiments import ExperimentSession, scenarios
from backend.fmi_host import FMIPlant, ServiceError
from backend.profiles import PROFILES
from backend.test_backend import FakeSlave


class ColdSlave(FakeSlave):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.values.update({100 + i: 0.0 for i in range(len(PROFILES['cold']['real_outputs']))})

    def doStep(self, **kwargs):
        super().doStep(**kwargs)
        # Accumulate the second input (prescribed heat) to expose event timing.
        self.values[100] += self.values[1] * kwargs['communicationStepSize']


def cold_description():
    profile = PROFILES['cold']
    variables = [SimpleNamespace(name=name, valueReference=i, type='Real', causality='input', start=value)
                 for i, (name, value) in enumerate(profile['defaults'].items())]
    variables += [SimpleNamespace(name=name, valueReference=100+i, type='Real', causality='output', start=None)
                  for i, name in enumerate(profile['real_outputs'])]
    variables += [SimpleNamespace(name='valid', valueReference=500, type='Boolean', causality='output', start=None)]
    return SimpleNamespace(fmiVersion='2.0', modelName='ColdStartPlant', guid='cold-test-double',
        generationTool='unit-test-double', modelVariables=variables,
        coSimulation=SimpleNamespace(modelIdentifier='ColdStartPlant'))


class ColdHostTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.fmu = Path(self.temp.name) / 'fixture.fmu'
        self.fmu.write_bytes(b'protocol-test-double')
        self.plant = FMIPlant(self.fmu, profile='cold', description=cold_description(),
            slave_factory=ColdSlave, extractor=lambda _: mkdtemp())
        self.session = ExperimentSession(self.plant)

    def tearDown(self):
        self.plant.close()
        self.temp.cleanup()

    def test_profile_step_limits_and_history_are_consistent(self):
        health = self.plant.health()
        self.assertEqual((health['stepSize'], health['maxStepSeconds']), (5, 120))
        before = self.plant.state()
        for seconds in (0.5, 4, 7, 125, True):
            with self.assertRaises(ServiceError): self.session.step(seconds)
            self.assertEqual(self.plant.state(), before)
        self.session.step(120)
        history = self.session.history_points(100)
        self.assertEqual(history['samplePeriod'], 5)
        self.assertEqual([p['time'] for p in history['points']], list(range(0, 121, 5)))
        self.assertEqual(len(self.plant.slave.steps), 24)
        self.assertTrue(all(p['communicationStepSize'] == 5 for p in self.plant.slave.steps))

    def test_long_requests_land_on_events_and_replay_preserves_result(self):
        log = self.plant.export_commands()
        log.pop('finalState')
        log.update(schema='openpwr-fmi-command-log-v1', time=35, commands=[{'time': 5, 'controls': {'startupHeatMW': 2}},
                                     {'time': 15, 'controls': {'startupHeatMW': 0}}])
        self.session.replay(log)
        state = self.session.step(120)
        self.assertEqual(state['time'], 35)
        self.assertEqual(state['experiment']['status'], 'complete')
        self.assertEqual(state['experiment']['appliedEvents'], 2)
        self.assertEqual(state['outputs']['hotLegTemperatureC'], 20)
        exported = self.session.export_commands()
        self.session.replay(exported)
        replayed = self.session.step(120)
        self.assertTrue(replayed['experiment']['comparison']['pass'])
        self.assertEqual(replayed['outputs'], state['outputs'])
        self.session.stop()
        self.session.control({'startupHeatMW': 1})
        self.assertEqual(self.session.step(5)['time'], 40)

    def test_wrong_profile_and_invalid_schedule_cannot_reset_cold_session(self):
        self.session.step(10)
        before = self.session.state()
        log = self.session.export_commands()
        for field, value in [('fmuSha256', 'b' * 64), ('stepSize', .05),
                             ('commands', [{'time': 7, 'controls': {'startupHeatMW': 1}}])]:
            candidate = copy.deepcopy(log)
            candidate[field] = value
            with self.assertRaises(ServiceError): self.session.replay(candidate)
            self.assertEqual(self.session.state(), before)
        with self.assertRaises(ServiceError): self.session.control({'pressureControlEnable': .5})
        self.assertEqual(self.session.state(), before)

    def test_cold_catalog_is_separate_and_returned_by_value(self):
        catalog = scenarios('cold')
        self.assertEqual(catalog['model'], 'ColdStartPlant')
        self.assertTrue(all(s['id'].startswith('cold-') for s in catalog['scenarios']))
        self.assertNotIn('reactor-trip', {s['id'] for s in catalog['scenarios']})
        catalog['scenarios'][0]['commands'].clear()
        self.assertTrue(scenarios('cold')['scenarios'][0]['commands'])

    def test_ui_startup_schedule_matches_the_verified_forcing(self):
        from backend.verify_cold import startup_inputs
        startup = next(s for s in scenarios('cold')['scenarios'] if s['id'] == 'cold-startup')
        for time in (0, 3595, 3600, 7195, 7200, 18000):
            inputs = dict(PROFILES['cold']['defaults'])
            for event in startup['commands']:
                if event['time'] <= time: inputs.update(event['controls'])
            self.assertEqual(inputs, startup_inputs(time))


if __name__ == '__main__':
    unittest.main()
