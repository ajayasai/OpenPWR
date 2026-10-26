"""Test input discontinuities independently of any plant equations."""
# SPDX-License-Identifier: Apache-2.0
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_fmi import run_case


class HeldInputQuadrature(unittest.TestCase):
    def test_different_compiled_tolerance_is_rejected_before_solver_start(self):
        description = SimpleNamespace(modelName='Storage', defaultExperiment=SimpleNamespace(tolerance=1e-7))
        with patch('fmpy.read_model_description', return_value=description), patch('fmpy.extract') as extract:
            with self.assertRaisesRegex(ValueError, 'DefaultExperiment tolerance'):
                run_case(Path('unused.fmu'), 'Storage', (), (), lambda time: {}, 1, .1, solver_tolerance=1e-9)
            extract.assert_not_called()

    def test_event_boundary_uses_new_held_flow_despite_stale_algebraic_outputs(self):
        # FMI setReal changes the pending input, but cached derived outputs do
        # not change until doStep. This is permitted by the native interface.
        class Storage:
            def __init__(self, **kwargs):
                self.mass, self.pending, self.cached = 100.0, 0.0, 0.0
                self.intervals = []
            def instantiate(self): pass
            def setupExperiment(self, **kwargs): pass
            def enterInitializationMode(self): pass
            def exitInitializationMode(self): self.cached = self.pending
            def setReal(self, refs, values): self.pending = values[0]
            def setInteger(self, refs, values): pass
            def setBoolean(self, refs, values): pass
            def getReal(self, refs): return [self.mass, self.cached]
            def getBoolean(self, refs): return [True]
            def doStep(self, currentCommunicationPoint, communicationStepSize):
                self.intervals.append((currentCommunicationPoint, communicationStepSize, self.pending))
                self.mass += self.pending * communicationStepSize
                self.cached = self.pending
                return 0
            def terminate(self): pass
            def freeInstance(self): pass
        description = SimpleNamespace(modelName='Storage', guid='test', generationTool='test', fmiVersion='2.0',
            defaultExperiment=SimpleNamespace(tolerance='1e-9'),
            coSimulation=SimpleNamespace(modelIdentifier='storage'), modelVariables=[
                SimpleNamespace(name=name, valueReference=i, type='Boolean' if name == 'valid' else 'Real')
                for i, name in enumerate(('mass', 'flow', 'inlet', 'valid'))])
        with TemporaryDirectory() as directory:
            fmu = Path(directory) / 'fixture.fmu'
            fmu.write_bytes(b'Unit-test fixture; no compiled model')
            extracted = Path(directory) / 'extracted'; extracted.mkdir()
            storage = Storage()
            with patch('fmpy.read_model_description', return_value=description), \
                 patch('fmpy.extract', return_value=str(extracted)), \
                 patch('fmpy.fmi2.FMU2Slave', return_value=storage):
                result = run_case(fmu, 'Storage', ('mass', 'flow'), ('inlet',),
                    lambda time: {'inlet': 2.0 if time < .35 else -3.0},
                    duration=1, step=.2, sample_interval=.5, event_times=(.35,),
                    boundary_integrals=(('massKg', lambda inputs, state: inputs['inlet']),))
            expected_change = .35 * 2 - .65 * 3
            self.assertAlmostEqual(result['points'][-1]['mass'] - 100, expected_change)
            self.assertAlmostEqual(result['integrals']['massKg'], expected_change)
            self.assertEqual([point['time'] for point in result['points']], [0, .5, 1])
            self.assertTrue(any(abs(start-.35) < 1e-12 and abs(delta-.15) < 1e-12 and value == -3
                                for start, delta, value in storage.intervals))
            for start, delta, _ in storage.intervals:
                self.assertFalse(start < .35 < start + delta - 1e-10)


if __name__ == '__main__': unittest.main()
