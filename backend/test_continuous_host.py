"""Continuous-profile protocol checks; test doubles are not model evidence."""
# SPDX-License-Identifier: Apache-2.0
import copy
import csv
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory, mkdtemp
import threading
from types import SimpleNamespace
import unittest

from backend.fmi_host import FMIPlant
from backend.profiles import PROFILES
from backend.server import LocalServer
from backend.test_backend import FakeSlave, HttpFixture


class ContinuousSlave(FakeSlave):
    """An input accumulator detects misplaced events without simulating physics."""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.values.update({100+i: 0.0 for i in range(len(PROFILES['continuous']['real_outputs']))})
        self.demand_ref = list(PROFILES['continuous']['defaults']).index('reactorDemandPercent')

    def doStep(self, **kwargs):
        super().doStep(**kwargs)
        self.values[100] += self.values[self.demand_ref] * kwargs['communicationStepSize']


def continuous_description():
    profile = PROFILES['continuous']
    variables = [SimpleNamespace(name=name, valueReference=i, type='Real', causality='input', start=value)
                 for i, (name, value) in enumerate(profile['defaults'].items())]
    variables += [SimpleNamespace(name=name, valueReference=100+i, type='Real', causality='output', start=None)
                  for i, name in enumerate(profile['real_outputs'])]
    variables += [SimpleNamespace(name='valid', valueReference=500, type='Boolean', causality='output', start=None)]
    return SimpleNamespace(fmiVersion='2.0', modelName='ContinuousPlant', guid='continuous-protocol-double',
        generationTool='unit-test-double', modelVariables=variables,
        coSimulation=SimpleNamespace(modelIdentifier='ContinuousPlant'))


class ContinuousHttpFixture:
    request = HttpFixture.request

    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'continuous.html').write_text('<h1>Continuous native plant</h1>', encoding='utf-8')
        self.plant = self.make_plant()
        self.server = LocalServer(('127.0.0.1', 0), plant=self.plant, root=self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def make_plant(self):
        path = self.root / 'fixture.fmu'
        path.write_bytes(b'continuous-protocol-test-double')
        return FMIPlant(path, profile='continuous', description=continuous_description(),
            slave_factory=ContinuousSlave, extractor=lambda _: mkdtemp())

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.plant.close()
        self.temp.cleanup()

    def api(self, method, path, body=None, expected=200):
        status, data, _ = self.request(method, path, body)
        self.assertEqual(status, expected, data.decode())
        return json.loads(data)


class ContinuousHttpTest(ContinuousHttpFixture, unittest.TestCase):
    def test_profile_metadata_and_separate_scenario_catalog(self):
        health = self.api('GET', '/api/health')
        self.assertEqual((health['model'], health['profile']), ('ContinuousPlant', 'continuous'))
        self.assertEqual((health['stepSize'], health['maxStepSeconds']), (.5, 120))
        self.assertNotIn('startupHeatMW', health['controlLimits'])
        self.assertEqual(health['controlLimits']['rodDemandPcm'], [-6000, 8000])
        for key in ('neutronPowerFraction', 'rotorEnergyMJ', 'syncPermissive', 'gridConnected',
                    'breakerClosingDwellS', 'fullPowerReady'):
            self.assertIn(key, health['realOutputs'])
        catalog = self.api('GET', '/api/scenarios')
        self.assertEqual(catalog['profile'], 'continuous')
        self.assertEqual({s['id'] for s in catalog['scenarios']},
                         {'continuous-startup', 'continuous-source', 'continuous-trip'})
        self.assertEqual(self.request('GET', '/continuous.html')[0], 200)

    def test_invalid_controls_and_step_requests_are_atomic_over_http(self):
        before = self.api('GET', '/api/state')
        invalid = [{'startupHeatMW': 1}, {'reactorDemandPercent': 101}, {'rodDemandPcm': 8001},
                   {'rodDemandPcm': -6001}, {'speedDemandRpm': 3001}, {'excitationCommandPu': 1.2},
                   {'gridBreakerCommand': .5}, {'automaticSyncEnable': True},
                   {'sourceEnable': 0, 'loadDemandMW': 1001}]
        for controls in invalid:
            with self.subTest(controls=controls):
                self.api('POST', '/api/control', controls, expected=400)
                self.assertEqual(self.api('GET', '/api/state'), before)
        for seconds in (.25, .75, 121, True):
            self.api('POST', '/api/step', {'seconds': seconds}, expected=400)
            self.assertEqual(self.api('GET', '/api/state'), before)
        changed = self.api('POST', '/api/control', {'reactorDemandPercent': .5, 'automaticReactorEnable': 1})
        self.assertEqual(changed['controls']['reactorDemandPercent'], .5)
        self.assertEqual(self.api('POST', '/api/step', {'seconds': .5})['time'], .5)

    def test_half_second_events_history_csv_and_replay_preserve_timing(self):
        log = self.api('GET', '/api/commands')
        log.pop('finalState')
        log.update(schema='openpwr-fmi-command-log-v1', time=3.0, commands=[
            {'time': .5, 'controls': {'reactorDemandPercent': 2}},
            {'time': 1.5, 'controls': {'reactorDemandPercent': 0, 'gridBreakerCommand': 1}}])
        self.api('POST', '/api/replay', log)
        state = self.api('POST', '/api/step', {'seconds': 120})
        self.assertEqual(state['time'], 3)
        self.assertEqual(state['experiment']['status'], 'complete')
        self.assertEqual(state['outputs']['hotLegTemperatureC'], 2)
        self.assertEqual(len(self.plant.slave.steps), 6)
        # A breaker request never becomes a native breaker observation in the host.
        self.assertEqual(state['controls']['gridBreakerCommand'], 1)
        self.assertEqual(state['outputs']['gridConnected'], 0)
        history = self.api('GET', '/api/history?maxPoints=100')
        self.assertEqual(history['samplePeriod'], 1)
        self.assertEqual([p['time'] for p in history['points']], [0, .5, 1, 1.5, 2, 3])
        status, body, _ = self.request('GET', '/api/export')
        self.assertEqual(status, 200)
        rows = list(csv.DictReader(io.StringIO(body.decode())))
        self.assertEqual(float(rows[-1]['time']), 3)
        for key in ('neutronPowerFraction', 'gridConnected', 'syncPermissive', 'gridBreakerCommand'):
            self.assertIn(key, rows[-1])
        exported = self.api('GET', '/api/commands')
        self.api('POST', '/api/replay', exported)
        replayed = self.api('POST', '/api/step', {'seconds': 120})
        self.assertTrue(replayed['experiment']['comparison']['pass'])
        self.assertEqual(replayed['outputs'], state['outputs'])

    def test_wrong_replay_identity_or_grid_cannot_reset_running_session(self):
        self.api('POST', '/api/step', {'seconds': 1})
        before = self.api('GET', '/api/state')
        log = self.api('GET', '/api/commands')
        for field, value, status in [('fmuSha256', 'b'*64, 409), ('stepSize', 5, 409),
                                    ('model', 'ColdStartPlant', 400),
                                    ('commands', [{'time': .25, 'controls': {'sourceEnable': 0}}], 400)]:
            candidate = copy.deepcopy(log)
            candidate[field] = value
            self.api('POST', '/api/replay', candidate, expected=status)
            self.assertEqual(self.api('GET', '/api/state'), before)


@unittest.skipUnless(os.environ.get('OPENPWR_CONTINUOUS_FMU'),
                     'Set OPENPWR_CONTINUOUS_FMU to run isolated native HTTP and replay smoke checks')
class NativeContinuousHttpTest(ContinuousHttpFixture, unittest.TestCase):
    def make_plant(self):
        return FMIPlant(os.environ['OPENPWR_CONTINUOUS_FMU'], profile='continuous')

    def test_real_source_experiment_controls_export_and_replay(self):
        initial = self.api('GET', '/api/state')
        self.assertTrue(initial['outputs']['valid'])
        self.api('POST', '/api/control', {'gridBreakerCommand': .5}, expected=400)
        self.assertEqual(self.api('GET', '/api/state'), initial)
        self.api('POST', '/api/experiment', {'scenario': 'continuous-source'})
        completed = self.api('POST', '/api/step', {'seconds': 120})
        self.assertEqual(completed['experiment']['status'], 'complete')
        self.assertTrue(completed['outputs']['valid'])
        self.assertEqual(completed['outputs']['externalSourceFractionPerSecond'], 0)
        self.assertEqual(completed['outputs']['gridConnected'], 0)
        self.assertFalse(completed['halted'])
        log = self.api('GET', '/api/commands')
        self.api('POST', '/api/replay', log)
        replayed = self.api('POST', '/api/step', {'seconds': 120})
        self.assertTrue(replayed['experiment']['comparison']['pass'])
        self.assertEqual(replayed['time'], 120)


if __name__ == '__main__':
    unittest.main()
