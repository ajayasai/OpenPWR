"""Run a free-running cold-to-rated prediction without access to observations."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from bisect import bisect_right
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.profiles import CONTINUOUS_DEFAULT_CONTROLS
from backend.verify import git_value, read_verified_manifest
from validation.native_fmi import run_case, sha

SCENARIO = Path(__file__).with_name("native-scenario.json")
LIMITS = ROOT / "validation/continuous/protocol.json"
FMU = ROOT / "artifacts/modelica/ContinuousPlant.fmu"
DEFAULT_REPORT = ROOT / "artifacts/open-loop-startup-native.json"
SOURCES = {
    "coldSourceSha256": "models/ColdStartPlant.mo",
    "continuousSourceSha256": "models/ContinuousPlant.mo",
    "pressureSourceSha256": "models/FinitePhasePressurizer.mo",
    "sharedRunnerSha256": "validation/native_fmi.py",
    "profileScriptSha256": "backend/profiles.py",
    "protocolSha256": "validation/continuous/protocol.json",
}
CHANNELS = (
    "hotLegTemperatureC", "coldLegTemperatureC", "primaryPressureMPa",
    "reactorPowerMW", "netPowerMW", "gridConnected", "neutronPowerFraction",
)
DIAGNOSTICS = (
    "reactivityPcm", "turbineRpm", "breakerClosingTimeS",
    "fullPowerReady", "externalSourceFractionPerSecond", "reactorTripped", "turbineTripped",
    "primarySubcoolingK", "totalPlantStoredEnergyMJ", "totalPlantMassKg",
    "integratedPlantBoundaryEnergyMJ", "integratedPlantBoundaryMassKg",
    "plantEnergyResidualMW", "plantMassResidualKgS",
)


def schedule(events, duration):
    """Compile only actuator inputs. The returned forcing takes elapsed time alone."""
    times, controls = [], []
    values = dict(CONTINUOUS_DEFAULT_CONTROLS)
    for event in events:
        seconds = event["hour"] * 3600
        changes = event["set"]
        if (not math.isfinite(seconds) or not 0 <= seconds < duration
                or (times and seconds <= times[-1]) or not changes
                or not changes.keys() <= values.keys()
                or not all(math.isfinite(value) for value in changes.values())):
            raise ValueError("Invalid time or unknown/nonfinite actuator command.")
        times.append(seconds)
        values.update(changes)
        controls.append(dict(values))
    if not times or times[0] != 0:
        raise ValueError("Startup commands must begin at time zero.")

    def forcing(seconds):
        if not math.isfinite(seconds) or seconds < 0 or seconds > duration:
            raise ValueError("Forecast clock outside its declared duration.")
        return controls[bisect_right(times, seconds) - 1]

    return times, forcing


def trajectory_row(point):
    return {
        "elapsedS": point["time"], **{name: point[name] for name in CHANNELS},
        "averageCoolantTemperatureC": (point["hotLegTemperatureC"] + point["coldLegTemperatureC"]) / 2,
    }


def inventory_error(points, stored, boundary):
    start = points[0]
    return max(abs((p[stored] - start[stored]) - (p[boundary] - start[boundary])) for p in points)


def diagnostics(run, scenario, limits):
    points = run["points"]
    first, end = points[0], points[-1]
    interval = scenario["reportIntervalSeconds"]
    if (len(points) != 1 + scenario["durationSeconds"] // interval
            or any(p["time"] != i * interval for i, p in enumerate(points))):
        raise ValueError("Incomplete native trajectory.")
    connected = next((p for p in points if p["gridConnected"] == 1), None)
    ready = [p["fullPowerReady"] == 1 and p["externalSourceFractionPerSecond"] == 0 for p in points]
    last_unready = max((i for i, is_ready in enumerate(ready) if not is_ready), default=-1)
    dwell_start = points[last_unready + 1]["time"] if last_unready < len(points) - 1 else None
    dwell = end["time"] - dwell_start if dwell_start is not None else 0
    first_ready = next((p["time"] for p, is_ready in zip(points, ready) if is_ready), None)
    min_subcooling = min(p["primarySubcoolingK"] for p in points)
    energy = inventory_error(points, "totalPlantStoredEnergyMJ", "integratedPlantBoundaryEnergyMJ")
    mass = inventory_error(points, "totalPlantMassKg", "integratedPlantBoundaryMassKg")
    energy_residual = max(abs(p["plantEnergyResidualMW"]) for p in points)
    mass_residual = max(abs(p["plantMassResidualKgS"]) for p in points)
    cold = limits["requiredInitialPrimaryTemperatureC"]
    cold_tol = limits["requiredInitialPrimaryTemperatureToleranceK"]
    checks = {
        "coldOfflineSubcritical": (abs(first["hotLegTemperatureC"] - cold) <= cold_tol
                                    and abs(first["coldLegTemperatureC"] - cold) <= cold_tol
                                    and first["gridConnected"] == first["turbineRpm"] == 0
                                    and first["reactivityPcm"] < 0),
        "ratedWithinStartupWindow": (dwell_start is not None
            and dwell_start + limits["requiredFinalDwellSeconds"] <= scenario["startupWindowSeconds"]),
        "ratedThroughEnd": dwell >= limits["requiredFinalDwellSeconds"],
        "noTrips": all(p["reactorTripped"] == p["turbineTripped"] == 0 for p in points),
        "primarySubcooling": min_subcooling > limits["minimumPrimarySubcoolingK"],
        "energyInventory": energy <= limits["nativeEnergyInventoryAbsoluteToleranceMJ"],
        "massInventory": mass <= limits["nativeMassInventoryAbsoluteToleranceKg"],
        "energyResidual": energy_residual <= limits["instantaneousEnergyResidualAbsoluteToleranceMW"],
        "massResidual": mass_residual <= limits["instantaneousMassResidualAbsoluteToleranceKgS"],
    }
    return {
        "checks": checks, "steps": run["steps"], "stepSeconds": run["stepSeconds"],
        "solverRelativeTolerance": run["solverRelativeTolerance"], "inputUpdates": run["inputUpdates"],
        "nativeValidAtEveryCommunicationPoint": True, "singleFmuInstancesPerRun": 1,
        "retainedSamples": len(points), "firstNativeGridConnectionS": connected["breakerClosingTimeS"] if connected else None,
        "firstRetainedRatedPowerS": first_ready, "terminalRatedDwellStartS": dwell_start,
        "terminalRatedDwellSeconds": dwell, "dwellObservationIntervalS": interval,
        "minimumPrimarySubcoolingK": min_subcooling, "maxStoredEnergyBalanceErrorMJ": energy,
        "maxStoredMassBalanceErrorKg": mass, "maxEnergyResidualMW": energy_residual,
        "maxMassResidualKgS": mass_residual, "initial": trajectory_row(first), "final": trajectory_row(end),
    }


def refinement(coarse, fine, limits):
    if len(coarse) != len(fine) or any(a["time"] != b["time"] for a, b in zip(coarse, fine)):
        raise ValueError("Communication refinement requires identical output times.")
    tolerances = {
        "hotLegTemperatureC": limits["maximumThermalRefinementDifferenceK"],
        "coldLegTemperatureC": limits["maximumThermalRefinementDifferenceK"],
        "averageCoolantTemperatureC": limits["maximumThermalRefinementDifferenceK"],
        "primaryPressureMPa": limits["maximumPressureRefinementDifferenceMPa"],
        "netPowerMW": limits["maximumNetPowerRefinementDifferenceMW"],
        "turbineRpm": limits["maximumTurbineRefinementDifferenceRpm"],
        "neutronPowerFraction": limits["maximumNeutronFractionRefinementDifference"],
    }
    results = {}
    for name, tolerance in tolerances.items():
        def value(point):
            if name == "averageCoolantTemperatureC":
                return (point["hotLegTemperatureC"] + point["coldLegTemperatureC"]) / 2
            return point[name]
        differences = [(abs(value(a) - value(b)), a["time"]) for a, b in zip(coarse, fine)]
        difference, at = max(differences)
        results[name] = {"maxAbsDifference": difference, "elapsedS": at,
                         "meanAbsDifference": math.fsum(error for error, _ in differences) / len(differences),
                         "limit": tolerance, "pass": difference <= tolerance}
    return {"comparedSamplesPerChannel": len(coarse), "channels": results,
            "pass": all(item["pass"] for item in results.values())}


def predict(fmu):
    scenario = json.loads(SCENARIO.read_text(encoding="utf-8"))
    limits = json.loads(LIMITS.read_text(encoding="utf-8"))["fullTrajectory"]
    manifest = read_verified_manifest(fmu, expected_model="ContinuousPlant", manifest_name="continuous-manifest.json")
    for key, relative in SOURCES.items():
        if manifest.get(key) != sha(ROOT / relative):
            raise ValueError(f"Build manifest does not match {relative}. Rebuild ContinuousPlant.")
    files = [*SOURCES.values(), "models/OpenPWR/package.mo", SCENARIO.relative_to(ROOT).as_posix(),
             Path(__file__).resolve().relative_to(ROOT).as_posix(), "backend/verify.py"]
    fingerprint = {relative: sha(ROOT / relative) for relative in files}
    run_revision = git_value("rev-parse", "HEAD")
    status = git_value("status", "--porcelain")
    run_dirty = bool(status) if status is not None else None
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    duration = scenario["durationSeconds"]
    coarse_step, fine_step = scenario["communicationStepsSeconds"]
    if coarse_step != 2 * fine_step or scenario["reportIntervalSeconds"] % coarse_step != 0:
        raise ValueError("Use halved communication steps and a common reporting grid.")
    times, forcing = schedule(scenario["controls"], duration)
    runs = []
    for step in (coarse_step, fine_step):
        print(f"Running {duration / 3600:g} h in one ContinuousPlant instance, step {step:g} s.", flush=True)
        runs.append(run_case(fmu, "ContinuousPlant", CHANNELS + DIAGNOSTICS, tuple(CONTINUOUS_DEFAULT_CONTROLS),
                             forcing, duration, step, sample_interval=scenario["reportIntervalSeconds"], event_times=times))
    coarse, fine = runs
    native = [diagnostics(run, scenario, limits) for run in runs]
    comparison = refinement(coarse["points"], fine["points"], limits)
    if (any(sha(ROOT / path) != digest for path, digest in fingerprint.items())
            or fine["runtime"]["fmuSha256"] != manifest["fmuSha256"]
            or coarse["runtime"] != fine["runtime"]):
        raise RuntimeError("Forecast source or FMU changed during integration.")
    return {
        "schemaVersion": 1, "scenarioId": scenario["id"], "basis": scenario["basis"],
        "durationSeconds": duration, "startupWindowSeconds": scenario["startupWindowSeconds"],
        "reportIntervalSeconds": scenario["reportIntervalSeconds"], "forecastCommunicationStepSeconds": fine_step,
        "observationsUsed": 0, "stateResetsAfterInitialization": 0,
        "actuatorForcing": "Frozen elapsed-time demands; built-in controls act on simulated state.",
        "nativeRuntime": fine["runtime"], "modelBuildRevision": manifest["gitRevision"],
        "modelBuildDirty": manifest["dirty"], "modelBuildPackageVersion": manifest["version"],
        "packageVersion": version, "runRevision": run_revision, "runDirty": run_dirty,
        "sourceSha256": fingerprint,
        "nativeRuns": native, "refinement": comparison,
        "numericalVerificationPassed": comparison["pass"] and all(all(run["checks"].values()) for run in native),
        "trajectory": [trajectory_row(p) for p in fine["points"]],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fmu", type=Path, default=FMU)
    parser.add_argument("--output", type=Path, default=DEFAULT_REPORT)
    options = parser.parse_args()
    report = predict(options.fmu)
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(report['trajectory'])} native predictions to {options.output}.")
    return 0 if report["numericalVerificationPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
