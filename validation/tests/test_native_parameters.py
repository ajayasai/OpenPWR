"""FMI parameter provenance must describe the initialized executable state."""
# SPDX-License-Identifier: Apache-2.0
from contextlib import contextmanager
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_fmi import run_case


def description(causality='parameter'):
    return SimpleNamespace(modelName='Parameters', guid='test', generationTool='test', fmiVersion='2.0',
        defaultExperiment=SimpleNamespace(tolerance='1e-9'), coSimulation=SimpleNamespace(modelIdentifier='parameters'),
        modelVariables=[SimpleNamespace(name='value', valueReference=0, type='Real', causality='output'),
            *[SimpleNamespace(name=name, valueReference=ref, type=kind, causality=causality)
              for name, ref, kind in [('realSetting', 1, 'Real'), ('integerSetting', 2, 'Integer'), ('booleanSetting', 3, 'Boolean')]]])


class ParameterUnit:
    def __init__(self, overwrite=None, short_readback=False):
        self.values = {0: 42.0, 1: 1.0, 2: 1, 3: False}
        self.overwrite, self.short_readback = overwrite, short_readback
        self.events, self.steps = [], 0
        self.terminated = self.freed = False
    def instantiate(self): self.events.append('instantiate')
    def setupExperiment(self, **kwargs): pass
    def enterInitializationMode(self): self.events.append('enter')
    def exitInitializationMode(self):
        self.events.append('exit')
        if self.overwrite:
            self.values.update(self.overwrite)
    def _set(self, kind, refs, values):
        self.events.append((kind, tuple(refs), tuple(values)))
        self.values.update(zip(refs, values))
    def setReal(self, refs, values): self._set('setReal', refs, values)
    def setInteger(self, refs, values): self._set('setInteger', refs, values)
    def setBoolean(self, refs, values): self._set('setBoolean', refs, values)
    def _get(self, kind, refs):
        self.events.append((kind, tuple(refs)))
        if self.short_readback and refs == [1]:
            return []
        return [self.values[ref] for ref in refs]
    def getReal(self, refs): return self._get('getReal', refs)
    def getInteger(self, refs): return self._get('getInteger', refs)
    def getBoolean(self, refs): return self._get('getBoolean', refs)
    def doStep(self, **kwargs): self.steps += 1; return 0
    def terminate(self): self.terminated = True
    def freeInstance(self): self.freed = True


@contextmanager
def native_fixture(unit, metadata=None):
    with TemporaryDirectory() as directory:
        fmu = Path(directory) / 'parameters.fmu'
        fmu.write_bytes(b'Synthetic parameter fixture, not an FMU')
        extracted = Path(directory) / 'extracted'
        extracted.mkdir()
        with patch('fmpy.read_model_description', return_value=metadata or description()), \
             patch('fmpy.extract', return_value=str(extracted)), \
             patch('fmpy.fmi2.FMU2Slave', return_value=unit):
            yield fmu, extracted


def execute(fmu, parameters, forcing=lambda time: {}):
    return run_case(fmu, 'Parameters', ('value',), (), forcing, 1, .25, parameters=parameters)


class InitializedParameterProvenance(unittest.TestCase):
    def test_nonparameters_are_rejected_before_extraction_or_instantiation(self):
        for causality in ('calculatedParameter', 'input', 'output', 'local', 'independent', None):
            with self.subTest(causality=causality), \
                 patch('fmpy.read_model_description', return_value=description(causality)), \
                 patch('fmpy.extract') as extract, patch('fmpy.fmi2.FMU2Slave') as slave:
                with self.assertRaisesRegex(ValueError, 'not a writable FMI parameter'):
                    execute(Path('unused.fmu'), {'realSetting': 7.25})
                extract.assert_not_called()
                slave.assert_not_called()

    def test_mixed_parameter_types_are_read_back_after_initialization_before_t0(self):
        requested = {'realSetting': 7.25, 'integerSetting': 2.0, 'booleanSetting': True}
        unit = ParameterUnit()
        with native_fixture(unit) as (fmu, extracted):
            result = execute(fmu, requested)
            self.assertFalse(extracted.exists())
        self.assertEqual(result['parameters'], requested)
        self.assertEqual(result['points'][0], {'time': 0, 'value': 42.0})
        self.assertEqual(unit.steps, 4)
        end_initialization = unit.events.index('exit')
        initial_observation = unit.events.index(('getReal', (0,)))
        for readback in [('getReal', (1,)), ('getInteger', (2,)), ('getBoolean', (3,))]:
            self.assertGreater(unit.events.index(readback), end_initialization)
            self.assertLess(unit.events.index(readback), initial_observation)
        integer_set = next(event for event in unit.events if isinstance(event, tuple) and event[0] == 'setInteger')
        self.assertIs(type(integer_set[2][0]), int)
        self.assertTrue(unit.terminated and unit.freed)

    def test_silently_overwritten_parameters_abort_before_observation_and_release_instance(self):
        for name, ref, requested, overwritten in [('realSetting', 1, 333.15, 313.15),
                ('integerSetting', 2, 4, 2), ('booleanSetting', 3, True, False),
                ('realSetting', 1, 1.0, float('nan'))]:
            with self.subTest(name=name, overwritten=overwritten):
                unit = ParameterUnit({ref: overwritten})
                with native_fixture(unit) as (fmu, extracted):
                    with self.assertRaisesRegex(RuntimeError, f'Initialized benchmark parameter {name} differs'):
                        execute(fmu, {name: requested})
                    self.assertFalse(extracted.exists())
                self.assertEqual(unit.steps, 0)
                self.assertNotIn(('getReal', (0,)), unit.events)
                self.assertTrue(unit.terminated and unit.freed)

    def test_incomplete_readback_cannot_be_reported_as_success(self):
        unit = ParameterUnit(short_readback=True)
        with native_fixture(unit) as (fmu, extracted):
            with self.assertRaisesRegex(RuntimeError, 'Incomplete initialized Real parameter readback'):
                execute(fmu, {'realSetting': 1})
            self.assertFalse(extracted.exists())
        self.assertEqual(unit.steps, 0)
        self.assertTrue(unit.terminated and unit.freed)

    def test_parameter_metadata_is_snapshotted_before_forcing_callbacks(self):
        requested = {'realSetting': 7.25}
        unit = ParameterUnit()
        def forcing(time):
            requested['realSetting'] = 99
            return {}
        with native_fixture(unit) as (fmu, _):
            result = execute(fmu, requested, forcing)
        self.assertEqual(requested['realSetting'], 99)
        self.assertEqual(result['parameters'], {'realSetting': 7.25})
        self.assertEqual(unit.values[1], 7.25)


if __name__ == '__main__':
    unittest.main()
