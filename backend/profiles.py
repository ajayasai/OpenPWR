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
    "auxAutoEnable": (0.0, 1.0), "auxPumpACommand": (0.0, 1.0), "auxPumpBCommand": (0.0, 1.0),
    "auxPumpAAvailable": (0.0, 1.0), "auxPumpBAvailable": (0.0, 1.0),
    "auxValveAOpen": (0.0, 1.0), "auxValveBOpen": (0.0, 1.0),
    **{name: CONTROL_LIMITS[name] for name in ("heaterPowerMW", "sprayFlowKgS", "chargingFlowKgS", "letdownFlowKgS")},
}
PLANT_DEFAULT_CONTROLS = {
    "reactorDemandPercent": 100.0, "loadDemandMW": 1000.0, "reactivityCommandPcm": 0.0,
    "turbineValveFraction": 1.0, "feedwaterFraction": 1.0, "coolingFraction": 1.0,
    "pumpCommand": 1.0, "tripCommand": 0.0, "turbineTripCommand": 0.0, "gridBreakerCommand": 1.0,
    "heaterPowerMW": 0.0, "sprayFlowKgS": 0.0, "chargingFlowKgS": 0.0, "letdownFlowKgS": 0.0,
    "auxAutoEnable": 1.0, "auxPumpACommand": 0.0, "auxPumpBCommand": 0.0,
    "auxPumpAAvailable": 1.0, "auxPumpBAvailable": 1.0, "auxValveAOpen": 1.0, "auxValveBOpen": 1.0,
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
    "mainFeedwaterFlowKgS", "totalFeedwaterFlowKgS", "auxFeedwaterFlowKgS",
    "auxTrainAFlowKgS", "auxTrainBFlowKgS", "auxPumpASpeed", "auxPumpBSpeed",
    "auxTankMassKg", "auxTankLevelPercent", "auxTankTemperatureC", "auxTankEnergyMJ",
    "auxPumpPowerMW", "auxTankDisplacementPowerMW", "auxAutoActuated", "auxTankDepleted",
    "auxPumpFluidPowerMW", "auxMotorLossMW", "auxFeedwaterEnthalpyJkg", "condenserDisplacementPowerMW",
)
COLD_CONTROL_LIMITS = {
    "pumpCommand": (0.0, 1.0), "startupHeatMW": (0.0, 90.0), "heaterPowerMW": (0.0, 3.0),
    "shutdownCoolingFraction": (0.0, 1.0), "chargingFlowKgS": (0.0, 10.0),
    "letdownFlowKgS": (0.0, 20.0), "ventFraction": (0.0, 1.0),
    "pressureControlEnable": (0.0, 1.0), "pressureTargetMPa": (0.2, 15.5),
    "inventoryControlEnable": (0.0, 1.0),
}
COLD_DEFAULT_CONTROLS = {
    "pumpCommand": 0.0, "startupHeatMW": 0.0, "heaterPowerMW": 0.0,
    "shutdownCoolingFraction": 1.0, "chargingFlowKgS": 0.0, "letdownFlowKgS": 0.0,
    "ventFraction": 0.0, "pressureControlEnable": 0.0, "pressureTargetMPa": 0.3,
    "inventoryControlEnable": 1.0,
}
COLD_REAL_OUTPUTS = (
    "hotLegTemperatureC", "coldLegTemperatureC", "fuelTemperatureC", "primaryPressureMPa",
    "pressurizerTemperatureC", "pressurizerLevelPercent", "primaryFlowKgS", "pumpSpeed", "pumpHeatMW",
    "reactorPowerMW", "heatToSteamMW", "shutdownCoolingMW", "secondaryTemperatureC",
    "secondaryPressureMPa", "secondaryLevelPercent", "secondaryMassKg", "pressurizerGasMassKg",
    "pressurizerVaporMassKg", "ventSteamFlowKgS", "ventGasFlowKgS", "actualHeaterPowerMW",
    "actualLetdownFlowKgS", "actualChargingFlowKgS", "primarySubcoolingK", "totalPlantStoredEnergyMJ",
    "totalPlantMassKg", "plantBoundaryPowerMW", "plantBoundaryMassFlowKgS", "integratedPlantBoundaryEnergyMJ",
    "integratedPlantBoundaryMassKg", "plantEnergyResidualMW", "plantMassResidualKgS", "hotStandbyReady",
    "secondaryGasMassKg", "secondarySteamVentKgS", "secondaryGasVentKgS", "surgeFlowKgS", "primaryMassKg",
    "coldLegEnthalpyJkg", "chargingEnthalpyJkg", "pressurizerSteamEnthalpyJkg",
    "secondarySteamEnthalpyJkg", "secondaryVaporMassKg",
)
CONTINUOUS_CONTROL_LIMITS = {
    **{name: limits for name, limits in COLD_CONTROL_LIMITS.items() if name != 'startupHeatMW'},
    'reactorDemandPercent': (0.0, 100.0), 'automaticReactorEnable': (0.0, 1.0),
    'rodDemandPcm': (-6000.0, 8000.0), 'reactivityBiasPcm': (-300.0, 300.0),
    'sourceEnable': (0.0, 1.0), 'tripCommand': (0.0, 1.0),
    'turbineEnable': (0.0, 1.0), 'turbineTripCommand': (0.0, 1.0),
    'speedDemandRpm': (0.0, 3000.0), 'loadDemandMW': (0.0, 1000.0),
    'gridBreakerCommand': (0.0, 1.0), 'automaticSyncEnable': (0.0, 1.0),
    'excitationCommandPu': (0.0, 1.1), 'feedwaterFraction': (0.0, 1.2),
    'coolingFraction': (0.0, 1.2),
}
CONTINUOUS_DEFAULT_CONTROLS = {
    **{name: value for name, value in COLD_DEFAULT_CONTROLS.items() if name != 'startupHeatMW'},
    'reactorDemandPercent': 0.0, 'automaticReactorEnable': 0.0,
    'rodDemandPcm': -2000.0, 'reactivityBiasPcm': 0.0, 'sourceEnable': 1.0,
    'tripCommand': 0.0, 'turbineEnable': 0.0, 'turbineTripCommand': 0.0,
    'speedDemandRpm': 0.0, 'loadDemandMW': 0.0, 'gridBreakerCommand': 0.0,
    'automaticSyncEnable': 0.0, 'excitationCommandPu': 0.0,
    'feedwaterFraction': 1.0, 'coolingFraction': 1.0,
}

CONTINUOUS_REAL_OUTPUTS = COLD_REAL_OUTPUTS + (
    'neutronPowerFraction', 'precursor1', 'precursor2',
    'precursor3', 'precursor4', 'precursor5',
    'precursor6', 'externalSourceFractionPerSecond', 'fissionPowerMW',
    'decayHeatMW', 'rodReactivityPcm', 'reactivityPcm',
    'thermalFeedbackPcm', 'turbineFlowKgS', 'bypassFlowKgS',
    'feedwaterFlowKgS', 'turbineRpm', 'rotorEnergyMJ',
    'turbineMechanicalPowerMW', 'shaftElectricalPowerMW', 'shaftFrictionMW',
    'grossPowerMW', 'netPowerMW', 'generatorLossMW',
    'auxiliaryPowerMW', 'loadReferenceMW', 'frequencyDifferenceHz',
    'phaseDifferenceDeg', 'generatorVoltagePu', 'syncPermissive',
    'synchronizationDwellS', 'gridConnected', 'reactorTripped',
    'turbineTripped', 'breakerClosingTimeS', 'breakerClosingPhaseDeg',
    'breakerClosingFrequencyHz', 'breakerClosingVoltagePu', 'breakerClosingDwellS',
    'condenserPressureKPa', 'condenserTemperatureC', 'condenserMassKg',
    'condenserEnergyMJ', 'condenserDisplacementPowerMW', 'coolingPowerMW',
    'feedPumpPowerMW', 'feedwaterEnthalpyJkg', 'condenserLiquidEnthalpyJkg',
    'turbineExhaustEnthalpyJkg', 'fullPowerReady', 'stopValveFraction', 'governorValveFraction',
)

PROFILES = {
    "primary": {"model": "OpenPWR.PrimaryLoop", "file": "PrimaryLoop.fmu", "manifest": "manifest.json",
        "port": 8001, "page": "engineering.html", "limits": CONTROL_LIMITS, "defaults": DEFAULT_CONTROLS,
        "real_outputs": REAL_OUTPUTS, "boolean_outputs": ("valid",), "discrete_controls": ()},
    "plant": {"model": "OpenPWR.CoupledPlant", "file": "CoupledPlant.fmu", "manifest": "plant-manifest.json",
        "port": 8002, "page": "plant.html", "limits": PLANT_CONTROL_LIMITS, "defaults": PLANT_DEFAULT_CONTROLS,
        "real_outputs": PLANT_REAL_OUTPUTS, "boolean_outputs": ("valid",),
        "discrete_controls": ("tripCommand", "turbineTripCommand", "gridBreakerCommand", "auxAutoEnable",
                              "auxPumpAAvailable", "auxPumpBAvailable", "auxValveAOpen", "auxValveBOpen")},
    "cold": {"model": "ColdStartPlant", "file": "ColdStartPlant.fmu", "manifest": "cold-manifest.json",
        "port": 8003, "page": "startup.html", "limits": COLD_CONTROL_LIMITS, "defaults": COLD_DEFAULT_CONTROLS,
        "real_outputs": COLD_REAL_OUTPUTS, "boolean_outputs": ("valid",),
        "discrete_controls": ("pressureControlEnable", "inventoryControlEnable"),
        "step_size": 5.0, "supported_steps": (0.25, 0.5, 2.5, 5.0), "max_step_seconds": 120},
    "continuous": {"model": "ContinuousPlant", "file": "ContinuousPlant.fmu", "manifest": "continuous-manifest.json",
        "port": 8004, "page": "continuous.html", "limits": CONTINUOUS_CONTROL_LIMITS, "defaults": CONTINUOUS_DEFAULT_CONTROLS,
        "real_outputs": CONTINUOUS_REAL_OUTPUTS, "boolean_outputs": ("valid",),
        "discrete_controls": ("pressureControlEnable", "inventoryControlEnable", "automaticReactorEnable",
                              "sourceEnable", "tripCommand", "turbineEnable", "turbineTripCommand",
                              "gridBreakerCommand", "automaticSyncEnable"),
        "step_size": 0.5, "supported_steps": (0.05, 0.1, 0.25, 0.5), "max_step_seconds": 120},
}
