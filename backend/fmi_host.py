"""Local FMI 2 co-simulation host with explicit primary and coupled-plant profiles.

The host never computes substitute plant readings. FMPy and the FMU are loaded
only when engineering mode is requested; the static browser edition stays free
of Python dependencies.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import csv
import copy
import hashlib
import io
import math
from collections import deque
from pathlib import Path
import shutil
import threading
import uuid


STEP_SIZE = 0.05
try:
    from .profiles import CONTROL_LIMITS, DEFAULT_CONTROLS, REAL_OUTPUTS, PROFILES
except ImportError:
    from profiles import CONTROL_LIMITS, DEFAULT_CONTROLS, REAL_OUTPUTS, PROFILES


class ServiceError(Exception):
    def __init__(self, status: int, error: str, message: str):
        super().__init__(message)
        self.status, self.error, self.message = status, error, message


def finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def validate_controls(values, limits=CONTROL_LIMITS, discrete_controls=()):
    if not isinstance(values, dict) or not values:
        raise ServiceError(400, "invalid_controls", "Supply a nonempty JSON object of control values.")
    unknown = set(values) - set(limits)
    if unknown:
        raise ServiceError(400, "unknown_control", f"Unknown controls: {', '.join(sorted(unknown))}.")
    result = {}
    for name, value in values.items():
        low, high = limits[name]
        if not finite_number(value) or not low <= value <= high:
            raise ServiceError(400, "invalid_control", f"{name} must be a finite number between {low:g} and {high:g}.")
        if name in discrete_controls and value not in (0, 1):
            raise ServiceError(400, "invalid_control", f"{name} must be exactly 0 or 1.")
        result[name] = float(value)
    return result


class FMIPlant:
    """One serialized session; all public operations are protected by a lock."""

    def __init__(self, fmu_path: str | Path, *, description=None, slave_factory=None, extractor=None, step_size=None, profile="primary"):
        if profile not in PROFILES:
            raise ValueError("Choose a declared native model profile.")
        self.profile = profile
        self.contract = PROFILES[profile]
        self.control_limits = self.contract["limits"]
        self.real_outputs = self.contract["real_outputs"]
        self.boolean_outputs = self.contract["boolean_outputs"]
        self.discrete_controls = self.contract["discrete_controls"]
        self.path = Path(fmu_path).resolve()
        step_size = self.contract.get("step_size", STEP_SIZE) if step_size is None else step_size
        supported_steps = self.contract.get("supported_steps", (0.025, 0.05))
        if step_size not in supported_steps:
            raise ValueError(f"Supported communication steps for {profile} are {supported_steps} seconds.")
        self.step_size = step_size
        self.max_step_seconds = self.contract.get("max_step_seconds", 10)
        self.lock = threading.RLock()
        self.slave = None
        self.directory = None
        self.halted = False
        self.halt_reason = None
        if not self.path.is_file():
            raise ServiceError(503, "backend_unavailable", "Compiled FMU not found. Build the OpenModelica model before starting engineering mode.")
        try:
            if description is None or slave_factory is None or extractor is None:
                from fmpy import extract, read_model_description
                from fmpy.fmi2 import FMU2Slave
                description = description or read_model_description(str(self.path), validate=True)
                slave_factory = slave_factory or FMU2Slave
                extractor = extractor or extract
            self.description = description
            if str(description.fmiVersion) != "2.0" or description.coSimulation is None:
                raise ValueError("The model must be an FMI 2.0 co-simulation FMU.")
            if description.modelName != self.contract["model"]:
                raise ValueError(f"Selected {self.profile} profile requires {self.contract['model']}, not {description.modelName}.")
            self.variables = {v.name: v for v in description.modelVariables}
            for name in self.control_limits:
                variable = self.variables.get(name)
                if variable is None or variable.causality != "input" or variable.type != "Real":
                    raise ValueError(f"FMU input {name} must be a Real input.")
            for name in self.real_outputs:
                variable = self.variables.get(name)
                if variable is None or variable.type != "Real" or variable.causality != "output":
                    raise ValueError(f"FMU output {name} must be a Real output.")
            for name in self.boolean_outputs:
                variable = self.variables.get(name)
                if variable is None or variable.type != "Boolean" or variable.causality != "output":
                    raise ValueError(f"FMU output {name} must be a Boolean output.")
            self.defaults = self.validate_controls({name: float(self.variables[name].start)
                if self.variables[name].start is not None else self.contract["defaults"][name] for name in self.control_limits})
            self.sha256 = hashlib.sha256(self.path.read_bytes()).hexdigest()
            self.directory = extractor(str(self.path))
            self.slave_factory = slave_factory
            self.reset()
        except ServiceError:
            self.close()
            raise
        except Exception as error:
            self.close()
            raise ServiceError(503, "backend_unavailable", f"Could not load the native FMU: {error}") from error

    def validate_controls(self, values):
        return validate_controls(values, self.control_limits, self.discrete_controls)

    def _references(self, names):
        return [self.variables[name].valueReference for name in names]

    def _dispose_slave(self):
        if self.slave is not None:
            try:
                self.slave.terminate()
            except Exception:
                pass
            try:
                self.slave.freeInstance()
            except Exception:
                pass
            finally:
                self.slave = None

    def close(self):
        with self.lock:
            try:
                self._dispose_slave()
            finally:
                if self.directory is not None:
                    shutil.rmtree(self.directory, ignore_errors=True)
                    self.directory = None

    def _read(self):
        values = self.slave.getReal(self._references(self.real_outputs))
        if len(values) != len(self.real_outputs) or any(not math.isfinite(value) for value in values):
            self.halted, self.halt_reason = True, "The native solver produced a non-finite observation. Reset the experiment."
            raise ServiceError(409, "solver_halted", self.halt_reason)
        outputs = dict(zip(self.real_outputs, map(float, values)))
        outputs.update(zip(self.boolean_outputs, map(bool, self.slave.getBoolean(self._references(self.boolean_outputs)))))
        self.outputs = outputs
        if not outputs["valid"]:
            self.halted, self.halt_reason = True, "The native model reached its declared validity boundary. Reset the experiment."

    def _snapshot(self):
        return {"backend": "fmi2", "model": self.description.modelName, "profile": self.profile,
            "time": self.steps * self.step_size, "controls": dict(self.controls), "outputs": dict(self.outputs),
            "halted": self.halted, "haltReason": self.halt_reason}

    def state(self):
        with self.lock:
            return self._snapshot()

    def health(self):
        with self.lock:
            if self.slave is None:
                raise ServiceError(503, "backend_unavailable", self.halt_reason or "The native model is not initialized.")
            return {"ok": True, "available": True, "backend": "fmi2", "model": self.description.modelName,
                "fmiVersion": "2.0", "fmuSha256": self.sha256,
                "compiler": getattr(self.description, "generationTool", None), "stepSize": self.step_size,
                "maxStepSeconds": self.max_step_seconds,
                "stateSerialization": False, "commandReplay": True, "profile": self.profile,
                "controlLimits": dict(self.control_limits), "defaultControls": dict(self.defaults),
                "realOutputs": list(self.real_outputs), "booleanOutputs": list(self.boolean_outputs),
                "discreteControls": list(self.discrete_controls)}

    def reset(self):
        with self.lock:
            self._dispose_slave()
            self.halted, self.halt_reason = False, None
            self.steps, self.controls = 0, dict(self.defaults)
            self.outputs = {}
            self.history = deque(maxlen=36001)
            self.commands = deque(maxlen=10000)
            self.command_count = 0
            try:
                self.slave = self.slave_factory(guid=self.description.guid, unzipDirectory=self.directory,
                    modelIdentifier=self.description.coSimulation.modelIdentifier, instanceName="openpwr_" + uuid.uuid4().hex)
                self.slave.instantiate()
                self.slave.setupExperiment(startTime=0.0)
                self.slave.enterInitializationMode()
                self.slave.setReal(self._references(self.controls), list(self.controls.values()))
                self.slave.exitInitializationMode()
                self._read()
                self._record()
            except Exception as error:
                self.halted, self.halt_reason = True, "Native model initialization failed."
                self._dispose_slave()
                if isinstance(error, ServiceError):
                    raise
                raise ServiceError(503, "initialization_failed", f"Native model initialization failed: {error}") from error
            return self._snapshot()

    def control(self, values):
        updates = self.validate_controls(values)
        with self.lock:
            if self.halted:
                raise ServiceError(409, "solver_halted", self.halt_reason)
            try:
                self.slave.setReal(self._references(updates), list(updates.values()))
                self.controls.update(updates)
                self._read()
                self.commands.append({"time": self.steps * self.step_size, "controls": updates})
                self.command_count += 1
                self._record()
            except ServiceError:
                raise
            except Exception as error:
                self.halted, self.halt_reason = True, "Native solver rejected a control update. Reset the experiment."
                raise ServiceError(409, "solver_halted", self.halt_reason) from error
            return self._snapshot()

    def step(self, seconds):
        if not finite_number(seconds) or not max(0.1, self.step_size) <= seconds <= self.max_step_seconds:
            raise ServiceError(400, "invalid_step", f"seconds must be between {max(0.1, self.step_size):g} and {self.max_step_seconds:g}.")
        count = round(seconds / self.step_size)
        if abs(count * self.step_size - seconds) > 1e-8:
            raise ServiceError(400, "invalid_step", f"seconds must be a multiple of {self.step_size}.")
        return self._advance_steps(count)

    def _advance_steps(self, count):
        """Bounded internal primitive used to land exactly on scripted events."""
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= round(self.max_step_seconds / self.step_size):
            raise ServiceError(400, "invalid_step", "Invalid native step count.")
        with self.lock:
            if self.halted:
                raise ServiceError(409, "solver_halted", self.halt_reason)
            for _ in range(count):
                try:
                    self.slave.doStep(currentCommunicationPoint=self.steps * self.step_size,
                        communicationStepSize=self.step_size)
                    self._read()
                    # A rejected observation leaves the last confirmed time and
                    # cached readings together. The native instance is halted;
                    # it may have advanced internally and must be reset.
                    self.steps += 1
                except Exception as error:
                    self.halted = True
                    self.halt_reason = "Native integration failed; no further steps will run. Reset the experiment."
                    if isinstance(error, ServiceError):
                        self.halt_reason = error.message
                    raise ServiceError(409, "solver_halted", self.halt_reason) from error
                if self.steps % max(1, round(1 / self.step_size)) == 0 or self.halted:
                    self._record()
                if self.halted:
                    break
            return self._snapshot()

    def _row(self):
        return {"time": self.steps * self.step_size, **self.controls, **self.outputs, "halted": self.halted}

    def _record(self):
        row = self._row()
        if self.history and self.history[-1]["time"] == row["time"]:
            self.history[-1] = row
        else:
            self.history.append(row)

    def export_csv(self):
        with self.lock:
            rows = list(self.history)
            current = self._row()
            if rows and rows[-1]["time"] == current["time"]:
                rows[-1] = current
            else:
                rows.append(current)
            stream = io.StringIO(newline="")
            writer = csv.DictWriter(stream, fieldnames=["time", *self.control_limits, *self.real_outputs, *self.boolean_outputs, "halted"])
            writer.writeheader()
            writer.writerows(rows)
            return stream.getvalue()

    def export_commands(self):
        with self.lock:
            return {"schema": "openpwr-fmi-command-log-v2", "fmuSha256": self.sha256,
                "stepSize": self.step_size, "initialControls": dict(self.defaults),
                "time": self.steps * self.step_size, "commands": copy.deepcopy(list(self.commands)),
                "truncated": self.command_count > self.commands.maxlen,
                "finalState": {"time": self.steps * self.step_size, "outputs": dict(self.outputs), "halted": self.halted}}

    def history_points(self, max_points=600):
        if isinstance(max_points, bool) or not isinstance(max_points, int) or not 2 <= max_points <= 2000:
            raise ServiceError(400, "invalid_history_limit", "maxPoints must be an integer between 2 and 2000.")
        with self.lock:
            rows = list(self.history)
            current = self._row()
            if rows and rows[-1]["time"] == current["time"]:
                rows[-1] = current
            elif self.outputs:
                rows.append(current)
            retained = len(rows)
            if retained > max_points:
                indices = sorted({round(i * (retained - 1) / (max_points - 1)) for i in range(max_points)})
                rows = [rows[i] for i in indices]
            points = [{"time": row["time"], "controls": {name: row[name] for name in self.control_limits},
                "outputs": {name: row[name] for name in (*self.real_outputs, *self.boolean_outputs)}, "halted": row["halted"]} for row in rows]
            return {"schema": "openpwr-fmi-history-v1", "fmuSha256": self.sha256, "samplePeriod": max(1, self.step_size),
                "storageIncludesCommandBoundaries": True,
                "includesCommandBoundaries": retained <= len(points),
                "retainedSamples": retained, "returnedSamples": len(points), "downsampled": retained > len(points),
                "truncated": bool(points and points[0]["time"] > 0), "points": points, "current": self._snapshot()}
