"""Local FMI 2 co-simulation host for the independently compiled primary model.

The host never computes substitute plant readings. FMPy and the FMU are loaded
only when engineering mode is requested; the static browser edition stays free
of Python dependencies.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import csv
import hashlib
import io
import math
from collections import deque
from pathlib import Path
import shutil
import threading
import uuid


STEP_SIZE = 0.05
CONTROL_LIMITS = {
    "reactorPowerMW": (0.0, 3300.0),
    "pumpCommand": (0.0, 1.0),
    "steamTemperatureC": (240.0, 300.0),
    "heaterPowerMW": (0.0, 3.0),
    "sprayFlowKgS": (0.0, 30.0),
    "chargingFlowKgS": (0.0, 10.0),
    "letdownFlowKgS": (0.0, 10.0),
}
DEFAULT_CONTROLS = {
    "reactorPowerMW": 3000.0, "pumpCommand": 1.0,
    "steamTemperatureC": 276.0, "heaterPowerMW": 0.0,
    "sprayFlowKgS": 0.0, "chargingFlowKgS": 0.0, "letdownFlowKgS": 0.0,
}
REAL_OUTPUTS = (
    "hotLegTemperatureC", "coldLegTemperatureC", "fuelTemperatureC",
    "primaryPressureMPa", "pressurizerLevelPercent", "primaryFlowKgS",
    "pumpSpeed", "heatToSteamMW", "thermalEnergyMJ", "pressurizerMassKg",
    "pressurizerEnergyMJ", "energyResidualMW", "massResidualKgS",
    "totalMassKg", "boundaryMassFlowKgS", "boundaryPowerMW",
    "integratedBoundaryMassKg", "integratedBoundaryEnergyMJ", "surgeFlowKgS",
    "primarySubcoolingK", "liquidMassKg", "vaporMassKg",
)


class ServiceError(Exception):
    def __init__(self, status: int, error: str, message: str):
        super().__init__(message)
        self.status, self.error, self.message = status, error, message


def validate_controls(values):
    if not isinstance(values, dict) or not values:
        raise ServiceError(400, "invalid_controls", "Supply a nonempty JSON object of control values.")
    unknown = set(values) - set(CONTROL_LIMITS)
    if unknown:
        raise ServiceError(400, "unknown_control", f"Unknown controls: {', '.join(sorted(unknown))}.")
    result = {}
    for name, value in values.items():
        low, high = CONTROL_LIMITS[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ServiceError(400, "invalid_control", f"{name} must be a finite number between {low:g} and {high:g}.")
        result[name] = float(value)
    return result


class FMIPlant:
    """One serialized session; all public operations are protected by a lock."""

    def __init__(self, fmu_path: str | Path, *, description=None, slave_factory=None, extractor=None, step_size=STEP_SIZE):
        self.path = Path(fmu_path).resolve()
        if step_size not in (0.025, 0.05):
            raise ValueError("Supported communication steps are 0.025 and 0.05 seconds.")
        self.step_size = step_size
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
            self.variables = {v.name: v for v in description.modelVariables}
            for name in CONTROL_LIMITS:
                variable = self.variables.get(name)
                if variable is None or variable.causality != "input" or variable.type != "Real":
                    raise ValueError(f"FMU input {name} must be a Real input.")
            for name in REAL_OUTPUTS:
                variable = self.variables.get(name)
                if variable is None or variable.type != "Real" or variable.causality != "output":
                    raise ValueError(f"FMU output {name} must be a Real output.")
            valid = self.variables.get("valid")
            if valid is None or valid.type != "Boolean" or valid.causality != "output":
                raise ValueError("FMU output valid must be a Boolean output.")
            self.defaults = validate_controls({name: float(self.variables[name].start)
                if self.variables[name].start is not None else DEFAULT_CONTROLS[name] for name in CONTROL_LIMITS})
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
        values = self.slave.getReal(self._references(REAL_OUTPUTS))
        if len(values) != len(REAL_OUTPUTS) or any(not math.isfinite(value) for value in values):
            self.halted, self.halt_reason = True, "The native solver produced a non-finite observation. Reset the experiment."
            raise ServiceError(409, "solver_halted", self.halt_reason)
        outputs = dict(zip(REAL_OUTPUTS, map(float, values)))
        outputs["valid"] = bool(self.slave.getBoolean(self._references(["valid"]))[0])
        self.outputs = outputs
        if not outputs["valid"]:
            self.halted, self.halt_reason = True, "The primary-loop model reached its declared validity boundary. Reset the experiment."

    def _snapshot(self):
        return {"backend": "fmi2", "model": self.description.modelName,
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
                "stateSerialization": False, "commandReplay": True}

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
        updates = validate_controls(values)
        with self.lock:
            if self.halted:
                raise ServiceError(409, "solver_halted", self.halt_reason)
            try:
                self.slave.setReal(self._references(updates), list(updates.values()))
                self.controls.update(updates)
                self._read()
                self.commands.append({"time": self.steps * self.step_size, "controls": updates})
                self.command_count += 1
            except ServiceError:
                raise
            except Exception as error:
                self.halted, self.halt_reason = True, "Native solver rejected a control update. Reset the experiment."
                raise ServiceError(409, "solver_halted", self.halt_reason) from error
            return self._snapshot()

    def step(self, seconds):
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0.1 <= seconds <= 10:
            raise ServiceError(400, "invalid_step", "seconds must be between 0.1 and 10.")
        count = round(seconds / self.step_size)
        if abs(count * self.step_size - seconds) > 1e-8:
            raise ServiceError(400, "invalid_step", f"seconds must be a multiple of {self.step_size}.")
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
                if self.steps % round(1 / self.step_size) == 0 or self.halted:
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
            writer = csv.DictWriter(stream, fieldnames=["time", *CONTROL_LIMITS, *REAL_OUTPUTS, "valid", "halted"])
            writer.writeheader()
            writer.writerows(rows)
            return stream.getvalue()

    def export_commands(self):
        with self.lock:
            return {"schema": "openpwr-fmi-command-log-v1", "fmuSha256": self.sha256,
                "stepSize": self.step_size, "initialControls": dict(self.defaults),
                "time": self.steps * self.step_size, "commands": list(self.commands),
                "truncated": self.command_count > self.commands.maxlen}
