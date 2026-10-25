"""Timestamped native experiments, exact command replay, and output comparison.

Every script is fully validated before the existing native session is reset.
Execution is synchronous and bounded by ordinary /api/step requests; pausing
means no steps are requested. No wall-clock scheduler changes simulation time.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import time

try:
    from .fmi_host import FMIPlant, REAL_OUTPUTS, CONTROL_LIMITS, ServiceError, finite_number, validate_controls
except ImportError:
    from fmi_host import FMIPlant, REAL_OUTPUTS, CONTROL_LIMITS, ServiceError, finite_number, validate_controls


ROOT = Path(__file__).resolve().parent.parent
MAX_DURATION = 36000
MAX_COMMANDS = 10000
MAX_REPLAY_BYTES = 4 * 1024 * 1024
SCENARIOS = (
    {"id": "heater", "label": "Pressurizer heater pulse", "duration": 45.0,
     "description": "Observe pressure and inventory during a 1 MW heater pulse from 5 to 25 s; other inputs stay at model defaults.",
     "commands": [{"time": 5.0, "controls": {"heaterPowerMW": 1.0}}, {"time": 25.0, "controls": {"heaterPowerMW": 0.0}}]},
    {"id": "spray", "label": "Cold-leg spray pulse", "duration": 45.0,
     "description": "Transfer 10 kg/s internally from the cold leg into the pressurizer from 5 to 25 s.",
     "commands": [{"time": 5.0, "controls": {"sprayFlowKgS": 10.0}}, {"time": 25.0, "controls": {"sprayFlowKgS": 0.0}}]},
    {"id": "pump", "label": "Pump reduction and recovery", "duration": 45.0,
     "description": "Reduce pump command to 90% at 5 s, then restore it at 20 s; compare rotor lag with hydraulic response.",
     "commands": [{"time": 5.0, "controls": {"pumpCommand": 0.9}}, {"time": 20.0, "controls": {"pumpCommand": 1.0}}]},
    {"id": "inventory", "label": "Charging and letdown balance", "duration": 50.0,
     "description": "Apply 2 kg/s charging, 0.5 kg/s letdown and 0.5 MW heater input from 5 to 35 s; the prescribed net mass addition is 45 kg.",
     "commands": [{"time": 5.0, "controls": {"chargingFlowKgS": 2.0, "letdownFlowKgS": 0.5, "heaterPowerMW": 0.5}},
                  {"time": 35.0, "controls": {"chargingFlowKgS": 0.0, "letdownFlowKgS": 0.0, "heaterPowerMW": 0.0}}]},
)


def scenarios():
    return {"schema": "openpwr-fmi-scenarios-v1", "scenarios": copy.deepcopy(list(SCENARIOS))}


def ticks(value, step_size, label="time"):
    if not finite_number(value) or not 0 <= value <= MAX_DURATION:
        raise ServiceError(400, "invalid_experiment", f"{label} must be a finite number between 0 and {MAX_DURATION} seconds.")
    result = round(value / step_size)
    if abs(result * step_size - value) > 1e-8:
        raise ServiceError(400, "invalid_experiment", f"{label} must align with the {step_size:g} s communication step.")
    return result


def validated_schedule(commands, duration, step_size):
    end_tick = ticks(duration, step_size, "duration")
    if not isinstance(commands, list) or len(commands) > MAX_COMMANDS:
        raise ServiceError(400, "invalid_experiment", f"commands must be an array of at most {MAX_COMMANDS} entries.")
    validated = []
    previous = -1
    for index, command in enumerate(commands):
        if not isinstance(command, dict) or set(command) != {"time", "controls"}:
            raise ServiceError(400, "invalid_experiment", f"Command {index + 1} must contain only time and controls.")
        tick = ticks(command["time"], step_size, f"Command {index + 1} time")
        if tick < previous or tick > end_tick:
            raise ServiceError(400, "invalid_experiment", "Command timestamps must be ordered and no later than the experiment end.")
        validated.append({"tick": tick, "time": tick * step_size, "controls": validate_controls(command["controls"])})
        previous = tick
    return end_tick, validated


def validated_reference(value, end_tick, step_size):
    if not isinstance(value, dict) or set(value) != {"time", "outputs", "halted"}:
        raise ServiceError(400, "invalid_replay", "finalState must contain time, outputs, and halted.")
    if ticks(value["time"], step_size, "finalState time") != end_tick or type(value["halted"]) is not bool:
        raise ServiceError(400, "invalid_replay", "Final observation time/status is inconsistent with the command log.")
    outputs = value["outputs"]
    if not isinstance(outputs, dict) or set(outputs) != {*REAL_OUTPUTS, "valid"}:
        raise ServiceError(400, "invalid_replay", "Final observations must contain the complete declared output set.")
    for name in REAL_OUTPUTS:
        item = outputs[name]
        if not finite_number(item):
            raise ServiceError(400, "invalid_replay", "Final observations must be finite numbers.")
    if type(outputs["valid"]) is not bool:
        raise ServiceError(400, "invalid_replay", "The final valid observation must be Boolean.")
    return copy.deepcopy(value)


def validate_replay(log, plant):
    if not isinstance(log, dict):
        raise ServiceError(400, "invalid_replay", "Supply a command-log JSON object.")
    schema = log.get("schema")
    keys = {"schema", "fmuSha256", "stepSize", "initialControls", "time", "commands", "truncated"}
    if schema == "openpwr-fmi-command-log-v2":
        keys.add("finalState")
    elif schema != "openpwr-fmi-command-log-v1":
        raise ServiceError(400, "invalid_replay", "Unsupported command-log schema.")
    if set(log) != keys:
        raise ServiceError(400, "invalid_replay", "The command log has missing or unknown fields.")
    if log["truncated"] is not False:
        raise ServiceError(400, "truncated_replay", "A truncated command log cannot reproduce the original experiment.")
    if log["fmuSha256"] != plant.sha256:
        raise ServiceError(409, "fmu_mismatch", "This command log was recorded with a different FMU. Load the matching native build to replay it.")
    if isinstance(log["stepSize"], bool) or log["stepSize"] != plant.step_size:
        raise ServiceError(409, "step_mismatch", "The command log communication step differs from the running native model.")
    initial = validate_controls(log["initialControls"])
    if set(initial) != set(CONTROL_LIMITS) or initial != plant.defaults:
        raise ServiceError(409, "initial_condition_mismatch", "The command log does not use the native model's declared initial controls.")
    end_tick, commands = validated_schedule(log["commands"], log["time"], plant.step_size)
    reference = validated_reference(log["finalState"], end_tick, plant.step_size) if schema.endswith("v2") else None
    return {"id": "replay", "label": "Imported command replay", "endTick": end_tick,
        "commands": commands, "reference": reference, "sourceSchema": schema}


def compare_observations(reference, actual):
    if reference is None:
        return None
    checks = []
    for name in REAL_OUTPUTS:
        expected, observed = reference["outputs"][name], actual["outputs"][name]
        error = abs(observed - expected)
        tolerance = 1e-8 + 1e-10 * abs(expected)
        checks.append({"name": name, "reference": expected, "actual": observed,
            "error": error, "tolerance": tolerance, "pass": error <= tolerance})
    checks += [{"name": "time", "reference": reference["time"], "actual": actual["time"],
        "error": abs(actual["time"] - reference["time"]), "tolerance": 1e-8,
        "pass": abs(actual["time"] - reference["time"]) <= 1e-8}]
    for name, expected, observed in [("valid", reference["outputs"]["valid"], actual["outputs"]["valid"]),
            ("halted", reference["halted"], actual["halted"])]:
        checks.append({"name": name, "reference": expected, "actual": observed, "pass": expected == observed})
    return {"pass": all(check["pass"] for check in checks),
        "maximumAbsoluteDifference": max(check["error"] for check in checks if "error" in check),
        "checks": checks, "scope": "Same-FMU replay of recorded final observations; not external physical validation."}


class ExperimentSession:
    def __init__(self, plant):
        self.plant = plant
        self.lock = plant.lock
        self.plan = None
        self.index = 0
        self.status = "manual"
        self.comparison = None

    def health(self):
        result = self.plant.health()
        result.update({"experiments": True, "history": True, "commandReplay": True})
        return result

    def state(self):
        with self.lock:
            result = self.plant.state()
            result["experiment"] = None if self.plan is None else {"id": self.plan["id"], "label": self.plan["label"],
                "status": self.status, "duration": self.plan["endTick"] * self.plant.step_size,
                "appliedEvents": self.index, "eventCount": len(self.plan["commands"]),
                "nextEventTime": self.plan["commands"][self.index]["time"] if self.index < len(self.plan["commands"]) else None,
                "comparison": copy.deepcopy(self.comparison)}
            return result

    def _arm(self, plan):
        self.plan = None
        self.status = "manual"
        self.plant.reset()
        self.plan, self.index, self.status, self.comparison = plan, 0, "ready", None
        try:
            self._events()
            self._finish_if_needed()
        except ServiceError:
            if self.plant.halted:
                self.status = "halted"
            raise
        return self.state()

    def start(self, identifier):
        with self.lock:
            scenario = next((copy.deepcopy(item) for item in SCENARIOS if item["id"] == identifier), None)
            if scenario is None:
                raise ServiceError(400, "unknown_scenario", "Choose heater, spray, pump, or inventory.")
            end_tick, commands = validated_schedule(scenario["commands"], scenario["duration"], self.plant.step_size)
            return self._arm({"id": scenario["id"], "label": scenario["label"], "endTick": end_tick,
                "commands": commands, "reference": None})

    def replay(self, log):
        with self.lock:
            plan = validate_replay(log, self.plant)  # Entire validation precedes reset.
            return self._arm(plan)

    def stop(self):
        with self.lock:
            if self.plan is not None and self.status in {"ready", "running", "complete"}:
                self.status = "stopped"
            return self.state()

    def reset(self):
        with self.lock:
            self.plan, self.status, self.comparison = None, "manual", None
            self.plant.reset()
            return self.state()

    def control(self, values):
        with self.lock:
            if self.plan is not None and self.status in {"ready", "running"}:
                raise ServiceError(409, "experiment_active", "Stop the scripted experiment before changing manual controls.")
            self.plant.control(values)
            if self.plan is not None and self.status == "complete":
                self.status = "stopped"
            return self.state()

    def _events(self):
        while self.index < len(self.plan["commands"]) and self.plan["commands"][self.index]["tick"] == self.plant.steps:
            command = self.plan["commands"][self.index]
            self.plant.control(command["controls"])
            self.index += 1
            if self.plant.halted:
                break

    def _finish_if_needed(self):
        if self.plant.halted:
            self.status = "halted"
        elif self.plant.steps >= self.plan["endTick"]:
            self.status = "complete"
        if self.status in {"complete", "halted"}:
            self.comparison = compare_observations(self.plan["reference"], self.plant.state())

    def step(self, seconds):
        with self.lock:
            if self.plan is None or self.status == "stopped":
                self.plant.step(seconds)
                return self.state()
            count = ticks(seconds, self.plant.step_size, "step seconds")
            if not 0.1 <= seconds <= 10:
                raise ServiceError(400, "invalid_step", "seconds must be between 0.1 and 10.")
            if self.status == "complete":
                return self.state()
            if self.plant.halted:
                raise ServiceError(409, "solver_halted", self.plant.halt_reason)
            target = min(self.plant.steps + count, self.plan["endTick"])
            self.status = "running"
            try:
                while self.plant.steps < target and not self.plant.halted:
                    boundary = min(target, self.plan["commands"][self.index]["tick"] if self.index < len(self.plan["commands"]) else target)
                    if boundary > self.plant.steps:
                        self.plant._advance_steps(boundary - self.plant.steps)
                    if not self.plant.halted:
                        self._events()
                self._finish_if_needed()
            except ServiceError:
                if self.plant.halted:
                    self.status = "halted"
                    self.comparison = compare_observations(self.plan["reference"], self.plant.state())
                raise
            return self.state()

    def export_csv(self): return self.plant.export_csv()
    def export_commands(self): return self.plant.export_commands()

    def history_points(self, max_points=600):
        with self.lock:
            result = self.plant.history_points(max_points)
            result["current"] = self.state()
            return result

    def report(self):
        with self.lock:
            state = self.state()
            try:
                runtime = self.health()
            except ServiceError as error:
                runtime = {"ok": False, "available": False, "backend": "fmi2", "fmuSha256": self.plant.sha256,
                    "error": error.error, "message": error.message}
            return {"schema": "openpwr-fmi-experiment-report-v1", "generatedAt": datetime.now(timezone.utc).isoformat(),
                "runtime": runtime, "experiment": state["experiment"], "finalState": state,
                "commandLog": self.export_commands(), "scope": "Generic native subsystem experiment; no measured plant validation."}

    def close(self): self.plant.close()


def read_log(path):
    path = Path(path)
    if path.stat().st_size > MAX_REPLAY_BYTES:
        raise ServiceError(413, "replay_too_large", "Replay files must be at most 4 MiB.")
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON field")
            result[key] = value
        return result
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
    except (ValueError, UnicodeError) as error:
        raise ServiceError(400, "invalid_json", "Replay files must contain valid finite JSON without duplicate fields.") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fmu", type=Path, default=ROOT / "artifacts" / "modelica" / "PrimaryLoop.fmu")
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--scenario", choices=[item["id"] for item in SCENARIOS])
    choice.add_argument("--replay", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "native-experiment")
    args = parser.parse_args()
    try:
        session = ExperimentSession(FMIPlant(args.fmu))
    except ServiceError as error:
        print(json.dumps({"status": "unavailable", "error": error.error, "message": error.message}))
        return 2
    started = time.perf_counter()
    try:
        failure = None
        try:
            if args.scenario:
                state = session.start(args.scenario)
            else:
                state = session.replay(read_log(args.replay))
            while state["experiment"]["status"] in {"ready", "running"}:
                state = session.step(10)
        except (ServiceError, OSError) as error:
            failure = {"error": getattr(error, "error", "file_error"), "message": str(error)}
        report = session.report()
        if failure:
            report["failure"] = failure
        report["wallSeconds"] = time.perf_counter() - started
        args.output.parent.mkdir(parents=True, exist_ok=True)
        Path(str(args.output) + ".csv").write_text(session.export_csv(), encoding="utf-8")
        Path(str(args.output) + ".commands.json").write_text(json.dumps(session.export_commands(), indent=2, allow_nan=False) + "\n", encoding="utf-8")
        Path(str(args.output) + ".report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        experiment = report["experiment"] or {"status": "failed", "comparison": None}
        comparison = experiment["comparison"]
        success = failure is None and experiment["status"] == "complete" and (comparison is None or comparison["pass"])
        print(json.dumps({"status": "failed" if failure else experiment["status"], "time": report["finalState"]["time"],
            "comparisonPassed": comparison["pass"] if comparison else None, "outputPrefix": str(args.output)}))
        return 0 if success else 2
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
