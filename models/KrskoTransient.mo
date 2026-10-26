within OpenPWR;
model KrskoTransient "Boundary-driven measured-transient applicability study; not a plant replica"
  parameter Boolean useDynamicPressurizer = true "Structural FMU choice; see KrskoEquilibrium for controlled ablation";
  parameter Real pressurizerPhaseRelaxationTimeS = 0.1 "Unfitted phase-separation closure, not a measured plant time constant";
  // SPDX-License-Identifier: Apache-2.0
  // Measured initial values: NRC NUREG/IA-0221 Table 2, t=0 column.
  // Unidentified geometry/capacities remain explicit generic assumptions.
  parameter Real initialCoreHeatMW = 1833.2836 "1994 MW core rating * 91.94 percent";
  parameter Real referenceScale = initialCoreHeatMW / 3000;
  parameter Real geometryScale = 1 "Sensitivity multiplier; never fitted to response data";
  parameter Real pumpHeatMW = 6 "NUREG/IA-0221 section 2: 1994 MW core plus 6 MW pump heat";
  parameter Real initialPressurePa = 15.48e6;
  parameter Real initialHotTemperatureK = 594.175;
  parameter Real initialColdTemperatureK = 559.445;
  parameter Real primaryNominalFlowKgS = initialCoreHeatMW*1e6/
    (PrimaryWater.specificEnthalpy_pT(initialPressurePa,initialHotTemperatureK)-PrimaryWater.specificEnthalpy_pT(initialPressurePa,initialColdTemperatureK))
    "Initial heat-rate calibration; overriding with a documented flow can create an explicit initial imbalance";
  parameter Real hotVolumeM3 = 150*referenceScale "Unidentified hot-side allocation, not measured plant geometry";
  parameter Real coldVolumeM3 = 150*referenceScale "Unidentified cold-side allocation, not measured plant geometry";
  parameter Real pressurizerVolumeM3 = 50*referenceScale "Unidentified vessel volume";
  parameter Real initialPressurizerLiquidFraction = .5295 "Reported instrument level used as a volume-fraction approximation";
  parameter Real fuelCapacityJK = 60e6*referenceScale "Unidentified aggregate fuel heat capacity";
  parameter Real secondaryVolumeM3 = 400*referenceScale "Unidentified aggregate secondary volume";
  parameter Real initialSecondaryLiquidFraction = .5 "Unidentified liquid-volume fraction, not instrument level";
  parameter Real initialSteamPressurePa = 6.41e6;
  parameter Real initialSteamFlowKgS = 994.1;
  parameter Real initialFeedwaterFlowKgS = 1004.6;
  parameter Real initialSteamTemperatureK = Water.saturationTemperature(initialSteamPressurePa);
  parameter Real feedwaterEnthalpyJkg =
    (initialSteamFlowKgS * Water.dewEnthalpy(Water.setSat_p(initialSteamPressurePa))
     - (initialCoreHeatMW + pumpHeatMW) * 1e6) / initialFeedwaterFlowKgS
    "Initial energy-rate calibration only; measured inlet enthalpy is unavailable";
  input Real reactorPowerMW(start=1833.2836) "Measured pre-trip neutron power proxy; pump heat is a separate boundary";
  input Real steamFlowKgS(start=994.1) "Sum of measured steamline flows, includes steam dump";
  input Real feedwaterFlowKgS(start=1004.6) "Sum of measured feedwater flows";
  input Real heaterPowerMW(start=0) "Unmeasured in this event; zero unless an identified history is supplied";
  input Real sprayFlowKgS(start=0) "Unmeasured in this event; zero unless an identified history is supplied";
  input Real chargingFlowKgS(start=0) "Mass flow; published L/s needs independently specified instrument density";
  input Real letdownFlowKgS(start=0) "Mass flow; published L/s needs independently specified instrument density";
  parameter Real chargingTemperatureK = 323.15 "Unidentified charging enthalpy; generic assumption";
  PrimaryLoop primary(
    useDynamicPressurizer=useDynamicPressurizer,
    pressurizerPhaseRelaxationTimeS=pressurizerPhaseRelaxationTimeS,
    initialPressurePa=initialPressurePa,
    initialHotTemperatureK=initialHotTemperatureK,
    initialColdTemperatureK=initialColdTemperatureK,
    initialFuelTemperatureK=873.15,
    nominalThermalPowerW=initialCoreHeatMW*1e6,
    nominalPumpHeatW=pumpHeatMW*1e6,
    nominalFlowKgS=primaryNominalFlowKgS,
    chargingTemperatureK=chargingTemperatureK,
    nominalSteamTemperatureK=initialSteamTemperatureK,
    hotVolumeM3=hotVolumeM3*geometryScale,
    coldVolumeM3=coldVolumeM3*geometryScale,
    pressurizerVolumeM3=pressurizerVolumeM3*geometryScale,
    initialLiquidVolumeM3=pressurizerVolumeM3*geometryScale*initialPressurizerLiquidFraction,
    fuelCapacityJK=fuelCapacityJK*geometryScale);
  SteamGenerator secondary(
    initialPressurePa=initialSteamPressurePa,
    volumeM3=secondaryVolumeM3*geometryScale,
    initialLiquidVolumeM3=secondaryVolumeM3*geometryScale*initialSecondaryLiquidFraction);
  output Real primaryPressureMPa = primary.primaryPressureMPa;
  output Real hotLegTemperatureC = primary.hotLegTemperatureC;
  output Real coldLegTemperatureC = primary.coldLegTemperatureC;
  output Real steamPressureMPa = secondary.pressureMPa;
  output Real primaryFlowKgS = primary.primaryFlowKgS;
  output Real heatToSteamMW = primary.heatToSteamMW;
  output Real pressurizerLevelPercent = primary.pressurizerLevelPercent;
  output Real pressurizerLiquidTemperatureC = primary.pressurizerLiquidTemperatureC;
  output Real pressurizerVaporTemperatureC = primary.pressurizerVaporTemperatureC;
  output Real pumpHeatInputMW = primary.pumpHeatMW;
  output Real steamEnthalpyJkg = secondary.steamEnthalpyJkg;
  output Real chargingEnthalpyJkg = primary.chargingEnthalpyJkg;
  output Real coldLegEnthalpyJkg = primary.coldLegEnthalpyJkg;
  output Real thermalEnergyMJ = primary.thermalEnergyMJ + secondary.energyMJ;
  output Real totalMassKg = primary.totalMassKg + secondary.massKg;
  output Real boundaryMassFlowKgS = feedwaterFlowKgS - steamFlowKgS + primary.boundaryMassFlowKgS;
  output Real boundaryPowerMW = primary.boundaryPowerMW + primary.heatToSteamMW +
    (feedwaterFlowKgS*feedwaterEnthalpyJkg - steamFlowKgS*secondary.steamEnthalpyJkg)/1e6;
  output Real energyResidualMW = primary.energyResidualMW + secondary.energyResidualMW;
  output Real massResidualKgS = primary.massResidualKgS + secondary.massResidualKgS;
  output Boolean valid = primary.valid and secondary.valid;
equation
  primary.reactorPowerMW = reactorPowerMW;
  primary.pumpCommand = 1;
  primary.steamTemperatureC = secondary.temperatureC;
  primary.heaterPowerMW = heaterPowerMW;
  primary.sprayFlowKgS = sprayFlowKgS;
  primary.chargingFlowKgS = chargingFlowKgS;
  primary.letdownFlowKgS = letdownFlowKgS;
  secondary.heatInputMW = primary.heatToSteamMW;
  secondary.feedwaterFlowKgS = feedwaterFlowKgS;
  secondary.feedwaterEnthalpyJkg = feedwaterEnthalpyJkg;
  secondary.steamFlowKgS = steamFlowKgS;
  annotation(experiment(StartTime=0, StopTime=15, Interval=0.05, Tolerance=1e-11));
end KrskoTransient;

model KrskoEquilibrium "Identical Krško boundaries and geometry with equilibrium pressurizer"
  extends KrskoTransient(useDynamicPressurizer=false);
end KrskoEquilibrium;
