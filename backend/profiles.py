"""Declared FMI contracts; model selection never substitutes another engine."""
# SPDX-License-Identifier: Apache-2.0

CONTROL_LIMITS = {
    "reactorPowerMW": (0.0, 3300.0), "pumpCommand": (0.0, 1.0),
    "steamTemperatureC": (240.0, 300.0), "heaterPowerMW": (0.0, 3.0),
    "sprayFlowKgS": (0.0, 30.0), "chargingFlowKgS": (0.0, 10.0),
    "letdownFlowKgS": (0.0, 10.0),
}
DEFAULT_CONTROLS = {
    "reactorPowerMW": 3000.0, "pumpCommand": 1.0, "steamTemperatureC": 276.0,
    "heaterPowerMW": 0.0, "sprayFlowKgS": 0.0, "chargingFlowKgS": 0.0, "letdownFlowKgS": 0.0,
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
PLANT_CONTROL_LIMITS = {
    "reactorDemandPercent": (50.0, 105.0), "loadDemandMW": (0.0, 1000.0),
    "reactivityCommandPcm": (-300.0, 300.0), "turbineValveFraction": (0.0, 1.2),
    "feedwaterFraction": (0.0, 1.2), "coolingFraction": (0.0, 1.2),
    "pumpCommand": (0.0, 1.0), "tripCommand": (0.0, 1.0),
    "turbineTripCommand": (0.0, 1.0), "gridBreakerCommand": (0.0, 1.0),
    **{name: CONTROL_LIMITS[name] for name in ("heaterPowerMW", "sprayFlowKgS", "chargingFlowKgS", "letdownFlowKgS")},
}
PLANT_DEFAULT_CONTROLS = {
    "reactorDemandPercent": 100.0, "loadDemandMW": 1000.0, "reactivityCommandPcm": 0.0,
    "turbineValveFraction": 1.0, "feedwaterFraction": 1.0, "coolingFraction": 1.0,
    "pumpCommand": 1.0, "tripCommand": 0.0, "turbineTripCommand": 0.0, "gridBreakerCommand": 1.0,
    "heaterPowerMW": 0.0, "sprayFlowKgS": 0.0, "chargingFlowKgS": 0.0, "letdownFlowKgS": 0.0,
}
PLANT_REAL_OUTPUTS = REAL_OUTPUTS + (
    "reactorPowerMW", "fissionPowerMW", "decayHeatMW", "reactivityPcm",
    "secondaryPressureMPa", "secondaryTemperatureC", "secondaryLevelPercent", "secondaryMassKg",
    "turbineFlowKgS", "bypassFlowKgS", "feedwaterFlowKgS", "turbineRpm", "grossPowerMW", "netPowerMW",
    "condenserPressureKPa", "condenserTemperatureC", "coolingPowerMW", "feedwaterTemperatureC",
    "reactorTripped", "turbineTripped", "gridConnected", "totalPlantStoredEnergyMJ", "totalPlantMassKg",
    "plantBoundaryPowerMW", "plantBoundaryMassFlowKgS", "integratedPlantBoundaryEnergyMJ",
    "integratedPlantBoundaryMassKg", "plantEnergyResidualMW", "plantMassResidualKgS",
    "feedPumpPowerMW", "generatorLossMW", "shaftFrictionMW", "condenserMassKg",
    "condenserEnergyMJ", "rotorEnergyMJ", "turbineMechanicalPowerMW", "neutronPowerFraction",
)
PROFILES = {
    "primary": {"model": "OpenPWR.PrimaryLoop", "file": "PrimaryLoop.fmu", "manifest": "manifest.json",
        "port": 8001, "page": "engineering.html", "limits": CONTROL_LIMITS, "defaults": DEFAULT_CONTROLS,
        "real_outputs": REAL_OUTPUTS, "boolean_outputs": ("valid",), "discrete_controls": ()},
    "plant": {"model": "OpenPWR.CoupledPlant", "file": "CoupledPlant.fmu", "manifest": "plant-manifest.json",
        "port": 8002, "page": "plant.html", "limits": PLANT_CONTROL_LIMITS, "defaults": PLANT_DEFAULT_CONTROLS,
        "real_outputs": PLANT_REAL_OUTPUTS, "boolean_outputs": ("valid",),
        "discrete_controls": ("tripCommand", "turbineTripCommand", "gridBreakerCommand")},
}
