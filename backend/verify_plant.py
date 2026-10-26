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


def component_boundary_power(values):
    """Reconstruct the declared external power from individual observations."""
    return (values["boundaryPowerMW"] + values["heatToSteamMW"] + values["feedPumpPowerMW"]
        + values["auxPumpPowerMW"] - values["auxMotorLossMW"] - values["auxTankDisplacementPowerMW"]
        - values["coolingPowerMW"] - values["grossPowerMW"] - values["generatorLossMW"]
        - values["shaftFrictionMW"] - values["condenserDisplacementPowerMW"])


def coupled_initialization_reference(fmu_path, *, parameters, controls, seconds, step=.025):
    """Run a separate native initialization with explicit test-only parameters.

    Public sessions retain the nominal initial condition. These probes vary
    inventory parameters through FMI initialization without changing equations.
    """
    from fmpy import extract, read_model_description
    from fmpy.fmi2 import FMU2Slave
    description = read_model_description(str(fmu_path), validate=True)
    if description.modelName != "OpenPWR.CoupledPlant":
        raise RuntimeError("Initialization probe needs the coupled plant FMU")
    variables = {variable.name: variable for variable in description.modelVariables}
    names = [name for name, variable in variables.items() if variable.causality == "output" and variable.type == "Real"]
    inputs = {name: float(variable.start) for name, variable in variables.items() if variable.causality == "input" and variable.type == "Real"}
    inputs.update(controls)
    directory = extract(str(fmu_path))
    slave = None
    try:
        slave = FMU2Slave(guid=description.guid, unzipDirectory=directory,
            modelIdentifier=description.coSimulation.modelIdentifier, instanceName="auxiliary_initialization_reference")
        slave.instantiate(); slave.setupExperiment(startTime=0)
        slave.enterInitializationMode()
        slave.setReal([variables[name].valueReference for name in parameters], list(parameters.values()))
        slave.setReal([variables[name].valueReference for name in inputs], list(inputs.values()))
        slave.exitInitializationMode()
        def point(time):
            values = slave.getReal([variables[name].valueReference for name in names])
            if not all(math.isfinite(value) for value in values):
                raise RuntimeError("Nonfinite native initialization-probe observation")
            valid = bool(slave.getBoolean([variables["valid"].valueReference])[0])
            return {"time": time, "outputs": dict(zip(names, values)), "halted": not valid}
        trace = [point(0)]
        for tick in range(1, round(seconds / step) + 1):
            status = slave.doStep(currentCommunicationPoint=(tick - 1) * step, communicationStepSize=step)
            if status not in (None, 0, 1):
                raise RuntimeError(f"Initialization-probe FMI step status {status}")
            trace.append(point(tick * step))
            if trace[-1]["halted"]:
                break
        return trace
    finally:
        if slave is not None:
            try: slave.terminate()
            finally: slave.freeInstance()
        shutil.rmtree(directory, ignore_errors=True)


def low_aux_inventory_reference(fmu_path, seconds=12, step=.025):
    """Reach the suction heel with 1500 kg instead of the nominal 100000 kg."""
    return coupled_initialization_reference(fmu_path,
        parameters={"auxInitialTankMassKg": 1500.0},
        controls={"auxAutoEnable": 0, "auxPumpACommand": 1, "auxPumpBCommand": 1},
        seconds=seconds, step=step)


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
            return values["totalFeedwaterFlowKgS"] - values["turbineFlowKgS"] - values["bypassFlowKgS"]
        secondary_integral = sum((b["time"] - a["time"]) * .5 * (secondary_flux(a) + secondary_flux(b))
            for a, b in zip(feedwater, feedwater[1:]))
        add("Secondary inventory follows independently integrated feed and steam flow", not feedwater[-1]["halted"]
            and abs(secondary_change - secondary_integral) < .1,
            {"actualMassChangeKg": secondary_change, "hostIntegratedMassChangeKg": secondary_integral,
             "absoluteErrorKg": abs(secondary_change - secondary_integral), "toleranceKg": .1,
             "reference": "0.1 s host trapezoid of total main-plus-auxiliary feedwater minus turbine and bypass steam flows."}, "numerical conservation reference")
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
             "toleranceKg": .001, "scope": "Primary, pressurizer, secondary, condenser and auxiliary-tank water; internal main/auxiliary feedwater and steam transfers cancel."}, "analytical conservation reference")
        energy = end["totalPlantStoredEnergyMJ"] - initial["totalPlantStoredEnergyMJ"]
        integrated = sum((b["time"] - a["time"]) * .5 * (component_boundary_power(a["outputs"]) + component_boundary_power(b["outputs"]))
            for a, b in zip(inventory, inventory[1:]))
        integral_error = abs(energy - end["integratedPlantBoundaryEnergyMJ"])
        add("Coupled stored energy follows independently integrated boundaries", not inventory[-1]["halted"] and abs(energy - integrated) < .5 and integral_error < .1,
            {"storedEnergyChangeMJ": energy, "independentTrapezoidMJ": integrated, "hostErrorMJ": abs(energy - integrated),
             "nativeIntegralErrorMJ": integral_error, "tolerances": "0.1 s host quadrature <0.5 MJ; native integrated flux <0.1 MJ.",
             "scope": "Declared thermal inventories plus rotor energy; see model documentation for auxiliary-load exclusions."}, "numerical conservation reference")
        traces["inventory"] = inventory[::5]

        nominal_end = nominal[-1]["outputs"]
        add("Auxiliary feedwater remains in standby at nominal conditions", nominal_end["auxAutoActuated"] == 0
            and abs(nominal_end["auxFeedwaterFlowKgS"]) < 1e-8 and abs(nominal_end["auxPumpPowerMW"]) < 1e-8
            and abs(nominal_end["auxTankMassKg"] - nominal[0]["outputs"]["auxTankMassKg"]) < 1e-6,
            {"flowKgS": nominal_end["auxFeedwaterFlowKgS"], "powerMW": nominal_end["auxPumpPowerMW"],
             "tankMassKg": nominal_end["auxTankMassKg"], "automaticLatch": nominal_end["auxAutoActuated"],
             "acceptance": "No auxiliary flow, electrical draw or tank-mass change at the constructed nominal point."})

        initial = reset()
        plant.control({"auxAutoEnable": 0, "auxPumpACommand": 1, "auxPumpBCommand": 1})
        auxiliary = run_for(plant, 10, .1)
        end = auxiliary[-1]["outputs"]
        speed_error = max(abs(point["outputs"][name] - (1 - math.exp(-point["time"] / 2)))
            for point in auxiliary for name in ("auxPumpASpeed", "auxPumpBSpeed"))
        add("Auxiliary pump acceleration follows independent first-order reference", not auxiliary[-1]["halted"]
            and speed_error < 2e-5 and end["auxFeedwaterFlowKgS"] > 50
            and auxiliary[1]["outputs"]["auxFeedwaterFlowKgS"] == 0,
            {"maximumSpeedFractionError": speed_error, "tolerance": 2e-5, "timeConstantS": 2,
             "reference": "n(t)=1-exp(-t/2) for each initially stopped pump commanded to full speed.",
             "earlyFlowKgS": auxiliary[1]["outputs"]["auxFeedwaterFlowKgS"], "finalFlowKgS": end["auxFeedwaterFlowKgS"],
             "scope": "Pump-head check valve blocks delivery until developed head exceeds steam-generator pressure."}, "analytical dynamics reference")
        actual_auxiliary_transfer = initial["auxTankMassKg"] - end["auxTankMassKg"]
        host_auxiliary_transfer = sum((b["time"] - a["time"]) * .5 * (a["outputs"]["auxFeedwaterFlowKgS"] + b["outputs"]["auxFeedwaterFlowKgS"])
            for a, b in zip(auxiliary, auxiliary[1:]))
        whole_mass_error = abs(end["totalPlantMassKg"] - initial["totalPlantMassKg"])
        add("Auxiliary delivery transfers finite tank water without creating plant mass", not auxiliary[-1]["halted"]
            and actual_auxiliary_transfer > 100 and whole_mass_error < .005
            and abs(actual_auxiliary_transfer - host_auxiliary_transfer) < .25,
            {"tankMassLossKg": actual_auxiliary_transfer, "integratedDeliveryKg": host_auxiliary_transfer,
             "deliveryQuadratureErrorKg": abs(actual_auxiliary_transfer - host_auxiliary_transfer),
             "wholePlantMassErrorKg": whole_mass_error, "tolerances": "Whole-plant mass 0.005 kg; 100 ms flow quadrature 0.25 kg, including regularized check-valve opening.",
             "scope": "Tank, secondary and condenser are internal water inventories; no external makeup is imposed."}, "numerical conservation reference")
        energy_change = end["totalPlantStoredEnergyMJ"] - initial["totalPlantStoredEnergyMJ"]
        energy_quadrature = sum((b["time"] - a["time"]) * .5 * (component_boundary_power(a["outputs"]) + component_boundary_power(b["outputs"]))
            for a, b in zip(auxiliary, auxiliary[1:]))
        native_energy_error = abs(energy_change - (end["integratedPlantBoundaryEnergyMJ"] - initial["integratedPlantBoundaryEnergyMJ"]))
        add("Auxiliary tank and pump energy close the whole-plant balance", not auxiliary[-1]["halted"]
            and abs(energy_change - energy_quadrature) < .1 and native_energy_error < .1,
            {"storedEnergyChangeMJ": energy_change, "independentComponentPowerIntegralMJ": energy_quadrature,
             "hostErrorMJ": abs(energy_change - energy_quadrature), "nativeIntegralErrorMJ": native_energy_error,
             "toleranceMJ": .1, "pumpElectricalMW": end["auxPumpPowerMW"], "motorLossMW": end["auxMotorLossMW"],
             "tankDisplacementWorkMW": end["auxTankDisplacementPowerMW"],
             "scope": "Includes finite tank internal energy, atmospheric surface work, pump work and ambient motor losses."}, "numerical conservation reference")
        fixed_auxiliary_load = initial["grossPowerMW"] - initial["netPowerMW"] - initial["feedPumpPowerMW"]
        electrical_error = abs(end["grossPowerMW"] - end["netPowerMW"] - fixed_auxiliary_load - end["feedPumpPowerMW"] - end["auxPumpPowerMW"])
        add("Auxiliary motor consumption reduces exported electricity", not auxiliary[-1]["halted"]
            and end["auxPumpPowerMW"] > end["auxPumpFluidPowerMW"] > 0 and electrical_error < 1e-8,
            {"electricalDrawMW": end["auxPumpPowerMW"], "fluidWorkMW": end["auxPumpFluidPowerMW"],
             "motorLossMW": end["auxMotorLossMW"], "electricalAccountingErrorMW": electrical_error,
             "toleranceMW": 1e-8, "scope": "Electrical consumption includes hydraulic work, motor inefficiency and speed-dependent idle losses."})
        traces["auxiliaryManual"] = auxiliary[::5]

        fine_auxiliary_plant = FMIPlant(fmu_path, profile="plant", step_size=.025)
        try:
            fine_auxiliary_plant.control({"auxAutoEnable": 0, "auxPumpACommand": 1, "auxPumpBCommand": 1})
            fine_auxiliary = run_for(fine_auxiliary_plant, 10, .1)[-1]
        finally:
            fine_auxiliary_plant.close()
        auxiliary_limits = {"auxTankMassKg": .05, "auxFeedwaterFlowKgS": .05,
            "auxPumpASpeed": 2e-5, "secondaryPressureMPa": .002, "totalPlantStoredEnergyMJ": .2}
        auxiliary_differences = {name: abs(end[name] - fine_auxiliary["outputs"][name]) for name in auxiliary_limits}
        add("Auxiliary delivery converges under communication-step refinement", not auxiliary[-1]["halted"]
            and not fine_auxiliary["halted"]
            and all(auxiliary_differences[name] < limit for name, limit in auxiliary_limits.items()),
            {"stepsSeconds": [.05, .025], "absoluteDifferences": auxiliary_differences,
             "absoluteTolerances": auxiliary_limits,
             "scope": "Ten-second manual two-train maneuver; communication refinement with the same adaptive native CVODE solver."})

        reset()
        plant.control({"auxAutoEnable": 0, "auxPumpACommand": 1, "auxPumpBCommand": 1,
                       "auxPumpBAvailable": 0, "auxValveAOpen": 0})
        isolated = run_for(plant, 5, .1)
        blocked = isolated[-1]["outputs"]
        plant.control({"auxValveAOpen": 1})
        available = run_for(plant, 2, .1)
        delivered = available[-1]["outputs"]
        add("Auxiliary train isolation and independent unavailability block delivery", not isolated[-1]["halted"] and not available[-1]["halted"]
            and abs(blocked["auxFeedwaterFlowKgS"]) < 1e-8 and blocked["auxPumpASpeed"] > .9
            and blocked["auxPumpPowerMW"] > 0 and abs(blocked["auxPumpBSpeed"]) < 1e-8
            and delivered["auxTrainAFlowKgS"] > 10 and abs(delivered["auxTrainBFlowKgS"]) < 1e-8,
            {"isolated": {name: blocked[name] for name in ("auxPumpASpeed", "auxPumpBSpeed", "auxFeedwaterFlowKgS", "auxPumpPowerMW")},
             "afterOpeningTrainA": {name: delivered[name] for name in ("auxTrainAFlowKgS", "auxTrainBFlowKgS")},
             "acceptance": "Isolated running train has zero delivery but nonzero idle electrical draw; unavailable train cannot start. Opening only A restores only A flow."})
        traces["auxiliaryIsolation"] = isolated[::5] + available[::5]

        reset()
        plant.control({"feedwaterFraction": 0})
        automatic = run_for(plant, 10, .1)
        end = automatic[-1]["outputs"]
        actuation_times = [point["time"] for point in automatic if point["outputs"]["auxAutoActuated"] > .5]
        add("Main-feedwater loss automatically starts available auxiliary trains", not automatic[-1]["halted"]
            and actuation_times and end["auxTrainAFlowKgS"] > 10 and end["auxTrainBFlowKgS"] > 10
            and automatic[-1]["controls"]["auxPumpACommand"] == 0 and automatic[-1]["controls"]["auxPumpBCommand"] == 0,
            {"firstObservedActuationSeconds": actuation_times[0] if actuation_times else None,
             "endTimeSeconds": automatic[-1]["time"], "mainFlowKgS": end["mainFeedwaterFlowKgS"],
             "trainAFlowKgS": end["auxTrainAFlowKgS"], "trainBFlowKgS": end["auxTrainBFlowKgS"],
             "scope": "Generic automatic initiation and hydraulic response, not proof of adequate emergency heat removal."}, "generic automatic response")
        traces["auxiliaryAutomatic"] = automatic

        low_level = coupled_initialization_reference(fmu_path,
            parameters={"secondary.initialLiquidVolumeM3": 156.0}, controls={}, seconds=5)
        low_level_disabled = coupled_initialization_reference(fmu_path,
            parameters={"secondary.initialLiquidVolumeM3": 156.0}, controls={"auxAutoEnable": 0}, seconds=.25)
        low_first, low_last = low_level[0]["outputs"], low_level[-1]["outputs"]
        disabled_first, disabled_last = low_level_disabled[0]["outputs"], low_level_disabled[-1]["outputs"]
        add("Automatic low-level initiation is evaluated at native initialization", not any(point["halted"] for point in low_level + low_level_disabled)
            and abs(low_first["secondaryLevelPercent"] - 39) < 1e-8 and low_first["auxAutoActuated"] == 1
            and abs(low_first["mainFeedwaterFlowKgS"] - nominal[0]["outputs"]["mainFeedwaterFlowKgS"]) < 1e-6
            and low_last["auxAutoActuated"] == 1 and low_last["auxTrainAFlowKgS"] > 10 and low_last["auxTrainBFlowKgS"] > 10
            and disabled_first["auxAutoActuated"] == 0 and disabled_last["auxAutoActuated"] == 0
            and abs(disabled_last["auxFeedwaterFlowKgS"]) < 1e-8,
            {"testOnlyParameter": "secondary.initialLiquidVolumeM3=156 (39% of the aggregate steam-generator volume)",
             "initialAutoEnabled": {name: low_first[name] for name in ("secondaryLevelPercent", "mainFeedwaterFlowKgS", "auxAutoActuated")},
             "fiveSecondAutoEnabled": {name: low_last[name] for name in ("auxTrainAFlowKgS", "auxTrainBFlowKgS", "auxAutoActuated")},
             "initialAutoDisabledLatch": disabled_first["auxAutoActuated"],
             "autoDisabledFinalFlowKgS": disabled_last["auxFeedwaterFlowKgS"],
             "acceptance": "An already-low initial level latches demand before the first step when enabled, despite normal main feedwater. Disabled automation stays inactive; manual commands remain at their declared zero starts."},
            "native initialization regression")
        traces["auxiliaryInitiallyLowLevel"] = low_level[::20]

        depletion = low_aux_inventory_reference(fmu_path)
        first, last = depletion[0]["outputs"], depletion[-1]["outputs"]
        stopped = [point for point in depletion if point["outputs"]["auxTankDepleted"] > .5]
        heel_overshoot = 1000 - last["auxTankMassKg"]
        heel_overshoot_limit = .025 * max(point["outputs"]["auxFeedwaterFlowKgS"] for point in depletion) + .01
        add("Auxiliary source exhaustion stops flow without resetting tank mass", not depletion[-1]["halted"]
            and abs(first["auxTankMassKg"] - 1500) < 1e-6 and stopped and last["auxTankDepleted"] == 1
            and -.01 <= heel_overshoot < heel_overshoot_limit and abs(last["auxFeedwaterFlowKgS"]) < 1e-8
            and abs(last["totalPlantMassKg"] - first["totalPlantMassKg"]) < .005,
            {"initialTankMassKg": first["auxTankMassKg"], "finalTankMassKg": last["auxTankMassKg"],
             "firstObservedDepletionSeconds": stopped[0]["time"] if stopped else None,
             "finalFlowKgS": last["auxFeedwaterFlowKgS"],
             "heelOvershootKg": heel_overshoot, "heelOvershootToleranceKg": heel_overshoot_limit,
             "wholePlantMassErrorKg": abs(last["totalPlantMassKg"] - first["totalPlantMassKg"]),
             "testOnlyParameter": "auxInitialTankMassKg=1500; nominal tank remains 100000 kg, suction heel 1000 kg.",
             "acceptance": "Usable water runs out, both deliveries stop, heel overshoot is less than one 25 ms observed maximum-flow step plus 0.01 kg, and closed whole-plant water stays within 0.005 kg.",
             "eventTiming": "Native FMI event detection occurs on communication boundaries; an overshot heel is preserved, never clipped or reset."}, "finite-inventory conservation")
        traces["auxiliaryDepletion"] = depletion[::10]

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
