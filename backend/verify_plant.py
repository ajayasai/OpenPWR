"""Numerical verification of the coupled native plant and reusable kinetics.

Reports test equations, inventories, causality and repeatability. They do not
compare a named plant or measurements; measured-data assessment is separate.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import time

try:
    from .fmi_host import FMIPlant
    from .experiments import ExperimentSession
    from .verify import ROOT, git_value, read_verified_manifest, run_for
except ImportError:
    from fmi_host import FMIPlant
    from experiments import ExperimentSession
    from verify import ROOT, git_value, read_verified_manifest, run_for


def matrix_exponential_action(matrix, seconds, initial):
    """Independent scaling/squaring Taylor exponential, not the CVODE solver."""
    size = len(matrix)
    norm = max(sum(abs(value * seconds) for value in row) for row in matrix)
    scaling = max(0, math.ceil(math.log2(norm))) if norm else 0
    a = [[value * seconds / 2 ** scaling for value in row] for row in matrix]
    identity = [[float(i == j) for j in range(size)] for i in range(size)]
    result, term = [row[:] for row in identity], identity
    def multiply(x, y):
        return [[sum(x[i][k] * y[k][j] for k in range(size)) for j in range(size)] for i in range(size)]
    for order in range(1, 80):
        term = [[value / order for value in row] for row in multiply(term, a)]
        result = [[result[i][j] + term[i][j] for j in range(size)] for i in range(size)]
        if max(abs(value) for row in term for value in row) < 2e-17:
            break
    else:
        raise ArithmeticError("Matrix exponential failed to converge")
    for _ in range(scaling):
        result = multiply(result, result)
    return [sum(row[j] * initial[j] for j in range(size)) for row in result]


def kinetics_reference(fmu_path):
    from fmpy import extract, read_model_description
    from fmpy.fmi2 import FMU2Slave
    manifest = read_verified_manifest(fmu_path, expected_model="OpenPWR.KineticsReference", manifest_name="kinetics-manifest.json")
    description = read_model_description(str(fmu_path), validate=True)
    if description.modelName != "OpenPWR.KineticsReference":
        raise RuntimeError("The kinetics reference FMU has the wrong model identity")
    variables = {variable.name: variable.valueReference for variable in description.modelVariables}
    names = ["neutronPowerFraction", *(f"precursor{i}" for i in range(1, 7))]
    beta = [.000215, .001424, .001274, .002568, .000748, .000273]
    decay = [.0124, .0305, .111, .301, 1.14, 3.01]
    generation = 1e-4
    observations = []
    directory = extract(str(fmu_path))
    try:
        for reactivity in (-50.0, 20.0):
            matrix = [[0.0] * 7 for _ in range(7)]
            matrix[0] = [(reactivity * 1e-5 - sum(beta)) / generation, *(b / generation for b in beta)]
            for index, rate in enumerate(decay, 1):
                matrix[index][0], matrix[index][index] = rate, -rate
            slave = FMU2Slave(guid=description.guid, unzipDirectory=directory,
                modelIdentifier=description.coSimulation.modelIdentifier, instanceName="kinetics_reference")
            try:
                slave.instantiate()
                slave.setupExperiment(startTime=0)
                slave.enterInitializationMode()
                slave.setReal([variables["reactivityPcm"]], [0.0])
                slave.exitInitializationMode()
                slave.setReal([variables["reactivityPcm"]], [reactivity])
                for tick in range(1, 101):
                    slave.doStep(currentCommunicationPoint=(tick - 1) * .05, communicationStepSize=.05)
                    if tick in (1, 2, 20, 100):
                        expected = matrix_exponential_action(matrix, tick * .05, [1.0] * 7)
                        actual = slave.getReal([variables[name] for name in names])
                        if len(actual) != len(names) or not all(math.isfinite(value) for value in actual):
                            raise RuntimeError("The isolated kinetics FMU returned incomplete or nonfinite observations")
                        valid = bool(slave.getBoolean([variables["valid"]])[0])
                        observations.append({"reactivityPcm": reactivity, "time": tick * .05,
                            "reference": dict(zip(names, expected)), "actual": dict(zip(names, actual)),
                            "maximumAbsoluteError": max(abs(a - e) for a, e in zip(actual, expected)), "valid": valid})
            finally:
                try: slave.terminate()
                finally: slave.freeInstance()
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    return manifest, {"observations": observations, "maximumAbsoluteError": max(item["maximumAbsoluteError"] for item in observations),
        "tolerance": 2e-6, "generationTimeSeconds": generation, "delayedFractions": beta, "decayConstantsPerSecond": decay,
        "method": "Independent 7x7 constant-coefficient matrix exponential by Taylor scaling/squaring; normalized precursor initial values all one.",
        "scope": "Numerical solution of the declared generic point-kinetics equations; not measured reactor data."}


def verify(fmu_path, kinetics_path, output_path):
    manifest = read_verified_manifest(fmu_path, expected_model="OpenPWR.CoupledPlant", manifest_name="plant-manifest.json")
    start_wall = time.perf_counter()
    plant = FMIPlant(fmu_path, profile="plant")
    checks, traces, additional_manifests = [], {}, {}
    def add(name, passed, evidence, kind="numerical verification"):
        checks.append({"name": name, "pass": bool(passed), "kind": kind, "evidence": evidence})
        print(("PASS " if passed else "FAIL ") + name, flush=True)
    def reset():
        state = plant.reset()
        if state["halted"]: raise RuntimeError("Coupled model is invalid at its initial condition")
        return state["outputs"]
    try:
        initial = reset()
        nominal = run_for(plant, 30, 1)
        tolerances = {"reactorPowerMW": 3.0, "netPowerMW": 1.0, "primaryPressureMPa": .001,
            "secondaryPressureMPa": .005, "hotLegTemperatureC": .02, "coldLegTemperatureC": .02}
        drift = {name: abs(nominal[-1]["outputs"][name] - initial[name]) for name in tolerances}
        add("Coupled hot equilibrium, 30 seconds", not nominal[-1]["halted"] and all(drift[k] < v for k, v in tolerances.items()),
            {"absoluteDrift": drift, "absoluteTolerances": tolerances, "reference": "Constructed generic equilibrium, not measured operating data."})
        traces["nominal"] = nominal

        kinetics_manifest, kinetics = kinetics_reference(kinetics_path)
        additional_manifests["kinetics"] = kinetics_manifest
        add("Native six-group kinetics agrees with independent matrix exponential", kinetics["maximumAbsoluteError"] < kinetics["tolerance"]
            and all(item["valid"] for item in kinetics["observations"]), kinetics, "analytical equation reference")

        initial = reset()
        controlled = plant.control({"reactivityCommandPcm": -50})
        unchanged = abs(controlled["outputs"]["fissionPowerMW"] - initial["fissionPowerMW"])
        reactivity = run_for(plant, .5, .1)
        add("Reactivity changes neutron dynamics without overwriting power", not reactivity[-1]["halted"] and unchanged < 1e-6
            and reactivity[-1]["outputs"]["fissionPowerMW"] < initial["fissionPowerMW"] - 1,
            {"instantaneousPowerChangeMW": unchanged, "initialFissionMW": initial["fissionPowerMW"],
             "finalFissionMW": reactivity[-1]["outputs"]["fissionPowerMW"], "reactivityInputPcm": -50,
             "acceptance": "State power continuous at input update; decreases by more than1 MW after0.5 s, without halt."}, "causality and generic response")
        traces["reactivity"] = reactivity

        initial = reset()
        plant.control({"tripCommand": 1})
        trip = run_for(plant, 2, .1)
        plant.control({"tripCommand": 0})
        cleared_command = plant.step(.1)
        end = cleared_command["outputs"]
        add("Reactor trip latches and retains decay heat", not cleared_command["halted"] and end["reactorTripped"] == 1
            and end["fissionPowerMW"] < .3 * initial["fissionPowerMW"] and end["decayHeatMW"] > 0
            and abs(end["reactorPowerMW"] - end["fissionPowerMW"] - end["decayHeatMW"]) < 1e-6,
            {"initialFissionMW": initial["fissionPowerMW"], "finalFissionMW": end["fissionPowerMW"],
             "decayHeatMW": end["decayHeatMW"], "tripAfterCommandReleased": end["reactorTripped"],
             "acceptance": "Fission below30% at2.1 s, decay heat positive, trip remains latched and total heat equals fission plus decay."}, "generic protection response")
        traces["reactorTrip"] = trip + [cleared_command]

        initial = reset()
        plant.control({"turbineTripCommand": 1})
        turbine = run_for(plant, 2, .1)
        end = turbine[-1]["outputs"]
        def rotor_flux(point):
            values = point["outputs"]
            return values["turbineMechanicalPowerMW"] - values["shaftFrictionMW"] - values["grossPowerMW"] - values["generatorLossMW"]
        rotor_integral = sum((b["time"] - a["time"]) * .5 * (rotor_flux(a) + rotor_flux(b)) for a, b in zip(turbine, turbine[1:]))
        raw_rotor_error = abs(end["rotorEnergyMJ"] - initial["rotorEnergyMJ"] - rotor_integral)
        observed_integral = sum((b["time"] - a["time"]) * .5 * (rotor_flux(a) + rotor_flux(b)) for a, b in zip(turbine[1:], turbine[2:]))
        observed_rotor_error = abs(end["rotorEnergyMJ"] - turbine[1]["outputs"]["rotorEnergyMJ"] - observed_integral)
        # FMI observations immediately after setReal are left-continuous for
        # this discrete when event. The commanded breaker opening at t=0 has
        # zero electrical torque on its right side. Retain the uncorrected
        # trace/error, and report this event-aware reference separately.
        right_limit_integral = rotor_integral + .5 * (turbine[1]["time"] - turbine[0]["time"]) * (
            turbine[0]["outputs"]["grossPowerMW"] + turbine[0]["outputs"]["generatorLossMW"])
        event_aware_error = abs(end["rotorEnergyMJ"] - initial["rotorEnergyMJ"] - right_limit_integral)
        add("Turbine trip opens generator and routes steam to bypass", not turbine[-1]["halted"] and end["turbineTripped"] == 1
            and end["gridConnected"] == 0 and abs(end["grossPowerMW"]) < 1e-6 and end["bypassFlowKgS"] > 0
            and turbine[1]["outputs"]["gridConnected"] == 0
            and 0 < end["turbineRpm"] < 3600 and abs(end["turbineRpm"] - initial["turbineRpm"]) > .1
            and observed_rotor_error < 2 and event_aware_error < 2,
            {"gridConnected": end["gridConnected"], "grossPowerMW": end["grossPowerMW"], "bypassFlowKgS": end["bypassFlowKgS"],
             "initialRpm": initial["turbineRpm"], "finalRpm": end["turbineRpm"],
             "observedRotorIntegralErrorMJ": observed_rotor_error, "observedIntervalSeconds": [.1, 2],
             "eventAwareRotorIntegralErrorMJ": event_aware_error, "eventAwareIntervalSeconds": [0, 2],
             "uncorrectedJumpTrapezoidErrorMJ": raw_rotor_error,
             "eventReference": "At t=0 the command opens the breaker. FMI reports its discrete change at the first positive step. Full-interval quadrature uses zero electrical torque at the right limit; raw observations are preserved.",
             "acceptance": "Trip latched, breaker open by0.1s, no gross electricity, positive bypass and changing rotor below3600rpm. Observed0.1..2s and event-aware0..2s rotor-work integral errors both below2MJ; the uncorrected jump trapezoid is not an accepted reference.",
             "rotorBehavior": "Breaker opening removes electrical torque before the0.5s admission valve closes; initial acceleration can precede friction coastdown.",
             "quadratureTolerance": "2MJ permits the leading0.1s trapezoid error for the roughly1GW admission flow decaying on its0.5s valve timescale."}, "generic protection response and rotor conservation")
        traces["turbineTrip"] = turbine

        reset()
        plant.control({"gridBreakerCommand": 0})
        disconnected = plant.step(.25)
        plant.control({"gridBreakerCommand": 1})
        attempted = plant.step(.1)
        end = attempted["outputs"]
        add("Generator closing permissive rejects an unsynchronized shaft", not disconnected["halted"] and not attempted["halted"]
            and disconnected["outputs"]["turbineRpm"] > 3050 and end["turbineRpm"] > 3050
            and end["gridConnected"] == 0 and end["reactorTripped"] == 0 and end["turbineTripped"] == 0,
            {"speedBeforeClosingRequestRpm": disconnected["outputs"]["turbineRpm"], "speedAfterRequestRpm": end["turbineRpm"],
             "closingCommand": attempted["controls"]["gridBreakerCommand"], "actualGridConnected": end["gridConnected"],
             "acceptance": "A closing command at shaft speed above3050rpm stays disconnected without needing a trip.",
             "scope": "Generic speed permissive only; no phase-angle, voltage or full synchronizer model."}, "generic electrical permissive")
        traces["gridPermissive"] = [disconnected, attempted]

        initial = reset()
        plant.control({"feedwaterFraction": .8})
        feedwater = run_for(plant, 5, .1)
        end = feedwater[-1]["outputs"]
        add("Feedwater reduction changes secondary inventory", not feedwater[-1]["halted"]
            and end["secondaryMassKg"] < initial["secondaryMassKg"] - 1,
            {"initialSecondaryMassKg": initial["secondaryMassKg"], "finalSecondaryMassKg": end["secondaryMassKg"],
             "feedwaterFlowKgS": end["feedwaterFlowKgS"], "acceptance": "80% feedwater command decreases secondary mass by more than1 kg in5 s, without halt."}, "generic secondary response")
        secondary_change = end["secondaryMassKg"] - initial["secondaryMassKg"]
        def secondary_flux(point):
            values = point["outputs"]
            return values["feedwaterFlowKgS"] - values["turbineFlowKgS"] - values["bypassFlowKgS"]
        secondary_integral = sum((b["time"] - a["time"]) * .5 * (secondary_flux(a) + secondary_flux(b))
            for a, b in zip(feedwater, feedwater[1:]))
        add("Secondary inventory follows independently integrated feed and steam flow", not feedwater[-1]["halted"]
            and abs(secondary_change - secondary_integral) < .1,
            {"actualMassChangeKg": secondary_change, "hostIntegratedMassChangeKg": secondary_integral,
             "absoluteErrorKg": abs(secondary_change - secondary_integral), "toleranceKg": .1,
             "reference": "0.1 s host trapezoid of feedwater minus turbine and bypass steam flows."}, "numerical conservation reference")
        traces["feedwater"] = feedwater[::5]

        initial = reset()
        plant.control({"coolingFraction": .8})
        cooling = run_for(plant, 5, .1)
        end = cooling[-1]["outputs"]
        add("Reduced condenser cooling raises temperature and pressure", not cooling[-1]["halted"]
            and end["condenserTemperatureC"] > initial["condenserTemperatureC"]
            and end["condenserPressureKPa"] > initial["condenserPressureKPa"],
            {"initialCondenserC": initial["condenserTemperatureC"], "finalCondenserC": end["condenserTemperatureC"],
             "initialPressureKPa": initial["condenserPressureKPa"], "finalPressureKPa": end["condenserPressureKPa"],
             "acceptance": "Both temperature and saturation backpressure rise under80% cooling for5 s, without halt."}, "generic condenser response")
        traces["cooling"] = cooling[::5]

        initial = reset()
        plant.control({"chargingFlowKgS": 2, "letdownFlowKgS": .5, "heaterPowerMW": .5,
            "feedwaterFraction": .95, "coolingFraction": .95})
        inventory = run_for(plant, 10, .1)
        end = inventory[-1]["outputs"]
        actual_mass = end["totalPlantMassKg"] - initial["totalPlantMassKg"]
        expected_mass = 1.5 * inventory[-1]["time"]
        add("Coupled water inventories conserve external mass", not inventory[-1]["halted"] and abs(actual_mass - expected_mass) < .001,
            {"actualMassChangeKg": actual_mass, "referenceMassChangeKg": expected_mass, "absoluteErrorKg": abs(actual_mass - expected_mass),
             "toleranceKg": .001, "scope": "Primary, pressurizer, secondary and condenser water; internal feedwater and steam transfers cancel."}, "analytical conservation reference")
        energy = end["totalPlantStoredEnergyMJ"] - initial["totalPlantStoredEnergyMJ"]
        integrated = sum((b["time"] - a["time"]) * .5 * (a["outputs"]["plantBoundaryPowerMW"] + b["outputs"]["plantBoundaryPowerMW"])
            for a, b in zip(inventory, inventory[1:]))
        integral_error = abs(energy - end["integratedPlantBoundaryEnergyMJ"])
        add("Coupled stored energy follows independently integrated boundaries", not inventory[-1]["halted"] and abs(energy - integrated) < .5 and integral_error < .1,
            {"storedEnergyChangeMJ": energy, "independentTrapezoidMJ": integrated, "hostErrorMJ": abs(energy - integrated),
             "nativeIntegralErrorMJ": integral_error, "tolerances": "0.1 s host quadrature <0.5 MJ; native integrated flux <0.1 MJ.",
             "scope": "Declared thermal inventories plus rotor energy; see model documentation for auxiliary-load exclusions."}, "numerical conservation reference")
        traces["inventory"] = inventory[::5]

        def maneuver(model):
            model.control({"reactivityCommandPcm": -10, "loadDemandMW": 950})
            run_for(model, 1, .1)
            model.control({"reactivityCommandPcm": 0, "feedwaterFraction": .98})
            return run_for(model, 2, .1)[-1]
        reset()
        coarse = maneuver(plant)
        fine_plant = FMIPlant(fmu_path, profile="plant", step_size=.025)
        try: fine = maneuver(fine_plant)
        finally: fine_plant.close()
        limits = {"reactorPowerMW": .2, "netPowerMW": .2, "secondaryPressureMPa": .002,
            "primaryPressureMPa": .002, "totalPlantMassKg": .01, "totalPlantStoredEnergyMJ": .2}
        differences = {name: abs(coarse["outputs"][name] - fine["outputs"][name]) for name in limits}
        add("Coupled native communication-step refinement", not coarse["halted"] and not fine["halted"]
            and all(differences[name] < limit for name, limit in limits.items()),
            {"stepsSeconds": [.05, .025], "absoluteDifferences": differences, "absoluteTolerances": limits,
             "scope": "Communication/input timing refinement; CVODE remains the adaptive internal integrator."})

        session = ExperimentSession(plant)
        log = session.export_commands()
        session.replay(log)
        result = session.step(10)
        comparison = result["experiment"]["comparison"]
        add("Coupled command replay compares every declared output", not result["halted"] and comparison["pass"],
            {"outputChecks": len(comparison["checks"]), "maximumAbsoluteDifference": comparison["maximumAbsoluteDifference"],
             "scope": "Same-FMU final-observation reproducibility; no external physical accuracy claim."})
    except Exception as error:
        add("Verification completed without native/runtime failure", False, {"error": type(error).__name__, "message": str(error)})
    finally:
        try:
            runtime = plant.health()
        except Exception as error:
            runtime = {"available": False, "model": "OpenPWR.CoupledPlant", "fmuSha256": plant.sha256,
                "error": str(error)}
        report = {"schemaVersion": 1, "version": json.loads((ROOT / "package.json").read_text())["version"],
            "generatedAt": datetime.now(timezone.utc).isoformat(), "gitRevision": git_value("rev-parse", "HEAD"),
            "gitDirty": bool(git_value("status", "--porcelain")), "runtime": runtime, "buildManifest": manifest,
            "kineticsManifest": additional_manifests.get("kinetics"),
            "scope": "Reduced-order coupled native hot plant. Numerical/analytical verification and generic response checks; no measured plant-transient validation.",
            "checks": checks, "passed": sum(check["pass"] for check in checks), "total": len(checks),
            "durationSeconds": time.perf_counter() - start_wall, "traces": traces}
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        plant.close()
    print(f"{report['passed']}/{report['total']} coupled-native checks passed. Evidence: {path}", flush=True)
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fmu", type=Path, default=ROOT / "artifacts/modelica/CoupledPlant.fmu")
    parser.add_argument("--kinetics-fmu", type=Path, default=ROOT / "artifacts/modelica/KineticsReference.fmu")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/plant-verification.json")
    args = parser.parse_args()
    raise SystemExit(verify(args.fmu, args.kinetics_fmu, args.output))
