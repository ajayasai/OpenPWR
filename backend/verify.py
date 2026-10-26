"""Run reproducible native-FMU equation and subsystem verification.

These are analytical/numerical checks and generic response tests. They are not
measured plant-transient benchmarks or whole-plant validation.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time

try:
    from .fmi_host import FMIPlant
except ImportError:
    from fmi_host import FMIPlant


ROOT = Path(__file__).resolve().parent.parent


def read_verified_manifest(fmu_path, source_path=ROOT / "models" / "OpenPWR" / "package.mo", *,
        expected_model="OpenPWR.PrimaryLoop", manifest_name="manifest.json"):
    """Bind evidence to both the compiled bytes and the current model source."""
    fmu_path = Path(fmu_path).resolve()
    manifest_path = fmu_path.parent / manifest_name
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        source_hash = hashlib.sha256(Path(source_path).read_bytes()).hexdigest()
        fmu_hash = hashlib.sha256(fmu_path.read_bytes()).hexdigest()
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Native verification requires the FMU, its adjacent {manifest_name}, and model source. Rebuild the engineering model.") from error
    if not isinstance(manifest, dict) or manifest.get("model") != expected_model or manifest.get("fmiVersion") != "2.0":
        raise RuntimeError(f"The build manifest does not identify the expected FMI 2 {expected_model} model. Rebuild the engineering model.")
    if manifest.get("sourceSha256") != source_hash:
        raise RuntimeError("The compiled FMU belongs to different Modelica source. Rebuild before running native verification.")
    if manifest.get("fmuSha256") != fmu_hash:
        raise RuntimeError("The compiled FMU does not match its build manifest. Rebuild before running native verification.")
    return manifest


def git_value(*args):
    try:
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def run_for(plant, seconds, sample_step=0.1):
    count = round(seconds / sample_step)
    trace = [plant.state()]
    for _ in range(count):
        state = plant.step(sample_step)
        trace.append(state)
        if state["halted"]:
            break
    return trace


def verify(fmu_path, output_path):
    build_manifest = read_verified_manifest(fmu_path)
    started = time.perf_counter()
    plant = FMIPlant(fmu_path)
    checks = []
    traces = {}

    def add(name, passed, evidence, kind="numerical verification"):
        checks.append({"name": name, "pass": bool(passed), "kind": kind, "evidence": evidence})
        print(("PASS " if passed else "FAIL ") + name, flush=True)

    def reset():
        state = plant.reset()
        if state["halted"]:
            raise RuntimeError("The FMU is invalid at initialization.")
        return state["outputs"]

    try:
        initial = reset()
        nominal = run_for(plant, 60, 1)
        end = nominal[-1]["outputs"]
        drift = {name: abs(end[name] - initial[name]) for name in
            ["hotLegTemperatureC", "coldLegTemperatureC", "fuelTemperatureC", "primaryPressureMPa"]}
        add("Native hot equilibrium, 60 seconds", not nominal[-1]["halted"]
            and all(drift[name] < 0.01 for name in drift if name != "primaryPressureMPa")
            and drift["primaryPressureMPa"] < 0.0001,
            {"maximumDrift": drift, "acceptance": "Temperatures <0.01 C; pressure <0.0001 MPa; no domain halt.",
             "reference": "Constructed model equilibrium; not measured plant data."})
        traces["nominal"] = nominal

        reset()
        plant.control({"pumpCommand": 0.9})
        pump = run_for(plant, 7)
        expected = 0.9 + 0.1 * math.exp(-7 / 7)
        actual = pump[-1]["outputs"]["pumpSpeed"]
        add("Pump-speed state agrees with exact first-order lag", not pump[-1]["halted"] and abs(actual - expected) < 5e-5,
            {"actual": actual, "reference": expected, "absoluteError": abs(actual - expected), "tolerance": 5e-5,
             "equation": "speed(t)=command+(initial-command)*exp(-t/7 s), command=0.9, t=7 s"}, "analytical reference")
        traces["pump"] = pump[::10]

        initial = reset()
        plant.control({"heaterPowerMW": 1})
        heater = run_for(plant, 20)
        pressure_rise = heater[-1]["outputs"]["primaryPressureMPa"] - initial["primaryPressureMPa"]
        add("Pressurizer heater increases primary pressure", not heater[-1]["halted"] and pressure_rise > 1e-5,
            {"pressureChangeMPa": pressure_rise, "input": "1 MW heater for 20 s", "acceptance": "Positive pressure change >1e-5 MPa and no domain halt.",
             "reference": "Qualitative thermodynamic response; no plant-specific pressure-rise target."}, "generic subsystem response")
        traces["heater"] = heater[::10]

        initial = reset()
        plant.control({"sprayFlowKgS": 10})
        spray = run_for(plant, 20)
        pressure_drop = initial["primaryPressureMPa"] - spray[-1]["outputs"]["primaryPressureMPa"]
        add("Internal cold-leg spray reduces pressurizer pressure", not spray[-1]["halted"] and pressure_drop > 1e-4,
            {"pressureDropMPa": pressure_drop, "input": "10 kg/s internal spray for 20 s", "acceptance": "Pressure drop >1e-4 MPa and no domain halt.",
             "reference": "Qualitative equilibrium-pressurizer response; no plant-specific spray transient."}, "generic subsystem response")
        traces["spray"] = spray[::10]

        # A closed primary inventory must conserve actual IF97-derived mass
        # through all three mechanisms. This checks state-property consistency,
        # independently of the model's algebraically constructed residual.
        closed_cases = {"pump": pump, "heater": heater, "spray": spray}
        closed_mass_errors = {name: max(abs(point["outputs"]["totalMassKg"] - trace[0]["outputs"]["totalMassKg"])
            for point in trace if point["time"] <= 5.0) for name, trace in closed_cases.items()}
        closed_valid = all(len([point for point in trace if point["time"] <= 5.0]) == 51
            and not any(point["halted"] for point in trace if point["time"] <= 5.0)
            for trace in closed_cases.values())
        add("Closed primary mass is conserved during pump, heater, and spray changes",
            closed_valid and all(error < 1e-4 for error in closed_mass_errors.values()),
            {"maximumMassDriftKg": closed_mass_errors, "durationSeconds": 5,
             "toleranceKg": 1e-4, "sampleIntervalSeconds": 0.1,
             "reference": "Zero external charging and letdown: total physical water inventory must remain constant. Spray transfers mass internally.",
             "scope": "IF97 state/property consistency across pump, heater, and spray transients; independent of reported algebraic residuals."},
            "analytical conservation reference")

        initial = reset()
        plant.control({"chargingFlowKgS": 2, "letdownFlowKgS": 0.5, "heaterPowerMW": 0.5})
        inventory = run_for(plant, 30)
        end = inventory[-1]["outputs"]
        duration = inventory[-1]["time"]
        expected_mass = 1.5 * duration
        actual_mass = end["totalMassKg"] - initial["totalMassKg"]
        # Independent host-side trapezoidal integration of declared boundary
        # fluxes, compared with physical inventories computed from IF97 states.
        integrated_energy = sum((b["time"] - a["time"]) * 0.5 *
            (a["outputs"]["boundaryPowerMW"] + b["outputs"]["boundaryPowerMW"])
            for a, b in zip(inventory, inventory[1:]))
        actual_energy = end["thermalEnergyMJ"] - initial["thermalEnergyMJ"]
        mass_error = abs(actual_mass - expected_mass)
        energy_error = abs(actual_energy - integrated_energy)
        integral_error = abs(actual_energy - end["integratedBoundaryEnergyMJ"])
        add("Total inventory follows external charging minus letdown", not inventory[-1]["halted"] and mass_error < 0.05,
            {"actualMassChangeKg": actual_mass, "referenceMassChangeKg": expected_mass,
             "absoluteErrorKg": mass_error, "toleranceKg": 0.05, "reference": "Exact integral of constant external mass flux: (2-0.5) kg/s × 30 s."}, "analytical reference")
        add("Stored energy agrees with independently integrated boundary power", not inventory[-1]["halted"] and energy_error < 0.5 and integral_error < 0.1,
            {"storedEnergyChangeMJ": actual_energy, "hostTrapezoidMJ": integrated_energy,
             "hostErrorMJ": energy_error, "modelIntegralErrorMJ": integral_error,
             "tolerance": "Host 0.1 s trapezoid error <0.5 MJ; model integral error <0.1 MJ.",
             "scope": "Fuel + primary water + pressurizer inventories; declared thermal boundary only."})
        traces["inventory"] = inventory[::10]

        def maneuver(p):
            p.control({"heaterPowerMW": 0.5, "pumpCommand": 0.95})
            run_for(p, 5)
            p.control({"reactorPowerMW": 2900, "chargingFlowKgS": 1})
            return run_for(p, 10)[-1]

        reset()
        coarse = maneuver(plant)
        fine_plant = FMIPlant(fmu_path, step_size=0.025)
        try:
            fine = maneuver(fine_plant)
        finally:
            fine_plant.close()
        tolerances = {"hotLegTemperatureC": 0.02, "coldLegTemperatureC": 0.02,
            "fuelTemperatureC": 0.02, "primaryPressureMPa": 0.002,
            "totalMassKg": 0.1, "thermalEnergyMJ": 0.2}
        differences = {name: abs(coarse["outputs"][name] - fine["outputs"][name]) for name in tolerances}
        add("Native communication-step refinement", not coarse["halted"] and not fine["halted"]
            and all(differences[name] < tolerance for name, tolerance in tolerances.items()),
            {"stepsSeconds": [0.05, 0.025], "absoluteDifferences": differences, "absoluteTolerances": tolerances,
             "scope": "FMI communication and input timing consistency; native adaptive solver remains the same."})

        reset()
        replay = maneuver(plant)
        replay_error = max(abs(coarse["outputs"][name] - replay["outputs"][name]) for name in tolerances)
        add("Reset and deterministic command replay", not replay["halted"] and replay_error < 1e-8,
            {"maximumSelectedOutputDifference": replay_error, "tolerance": 1e-8,
             "scope": "Same FMU and command history; this is not native FMU-state serialization."})

        report = {"schemaVersion": 1, "version": json.loads((ROOT / "package.json").read_text())["version"],
            "generatedAt": datetime.now(timezone.utc).isoformat(), "gitRevision": git_value("rev-parse", "HEAD"),
            "gitDirty": bool(git_value("status", "--porcelain")), "runtime": plant.health(),
            "buildManifest": build_manifest,
            "scope": "Original OpenModelica hot-primary-loop and equilibrium-pressurizer subsystem. Analytical checks, numerical conservation, and generic response tests; no measured whole-plant validation.",
            "checks": checks, "passed": sum(item["pass"] for item in checks), "total": len(checks),
            "durationSeconds": time.perf_counter() - started, "traces": traces}
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(f"{report['passed']}/{report['total']} native checks passed. Evidence: {output_path}", flush=True)
        return 0 if report["passed"] == report["total"] else 1
    finally:
        plant.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fmu", type=Path, default=ROOT / "artifacts" / "modelica" / "PrimaryLoop.fmu")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "modelica-verification.json")
    args = parser.parse_args()
    raise SystemExit(verify(args.fmu, args.output))


if __name__ == "__main__":
    main()
