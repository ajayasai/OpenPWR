within OpenPWR;
model KrskoTransient "Boundary-driven measured-transient applicability study; not a plant replica"
  // SPDX-License-Identifier: Apache-2.0
  // Measured initial values: NRC NUREG/IA-0221 Table 2, t=0 column.
  // All unmeasured volumes/capacities below are declared generic assumptions.
  parameter Real initialCoreHeatMW = 1833.2836 "1994 MW core rating * 91.94 percent";
  parameter Real referenceScale = initialCoreHeatMW / 3000;
  parameter Real geometryScale = 1 "Sensitivity multiplier; never fitted to response data";
  parameter Real initialSteamPressurePa = 6.41e6;
  parameter Real initialSteamFlowKgS = 994.1;
  parameter Real initialFeedwaterFlowKgS = 1004.6;
  parameter Real initialSteamTemperatureK = Water.saturationTemperature(initialSteamPressurePa);
  parameter Real feedwaterEnthalpyJkg =
    (initialSteamFlowKgS * Water.dewEnthalpy(Water.setSat_p(initialSteamPressurePa))
     - initialCoreHeatMW * 1e6) / initialFeedwaterFlowKgS
    "Initial energy-rate calibration only; measured inlet enthalpy is unavailable";
  input Real reactorPowerMW(start=1833.2836) "Measured pre-trip neutron power proxy; pump heat omitted";
  input Real steamFlowKgS(start=994.1) "Sum of measured steamline flows, includes steam dump";
  input Real feedwaterFlowKgS(start=1004.6) "Sum of measured feedwater flows";
  PrimaryLoop primary(
    initialPressurePa=15.48e6,
    initialHotTemperatureK=594.175,
    initialColdTemperatureK=559.445,
    initialFuelTemperatureK=873.15,
    nominalThermalPowerW=initialCoreHeatMW*1e6,
    nominalSteamTemperatureK=initialSteamTemperatureK,
    hotVolumeM3=150*referenceScale*geometryScale,
    coldVolumeM3=150*referenceScale*geometryScale,
    pressurizerVolumeM3=50*referenceScale*geometryScale,
    initialLiquidVolumeM3=50*referenceScale*geometryScale*.5295,
    fuelCapacityJK=60e6*referenceScale*geometryScale);
  SteamGenerator secondary(
    initialPressurePa=initialSteamPressurePa,
    volumeM3=400*referenceScale*geometryScale,
    initialLiquidVolumeM3=200*referenceScale*geometryScale);
  output Real primaryPressureMPa = primary.primaryPressureMPa;
  output Real hotLegTemperatureC = primary.hotLegTemperatureC;
  output Real coldLegTemperatureC = primary.coldLegTemperatureC;
  output Real steamPressureMPa = secondary.pressureMPa;
  output Real primaryFlowKgS = primary.primaryFlowKgS;
  output Real heatToSteamMW = primary.heatToSteamMW;
  output Real thermalEnergyMJ = primary.thermalEnergyMJ + secondary.energyMJ;
  output Real totalMassKg = primary.totalMassKg + secondary.massKg;
  output Real boundaryMassFlowKgS = feedwaterFlowKgS - steamFlowKgS;
  output Real boundaryPowerMW = reactorPowerMW +
    (feedwaterFlowKgS*feedwaterEnthalpyJkg - steamFlowKgS*secondary.steamEnthalpyJkg)/1e6;
  output Real energyResidualMW = primary.energyResidualMW + secondary.energyResidualMW;
  output Real massResidualKgS = primary.massResidualKgS + secondary.massResidualKgS;
  output Boolean valid = primary.valid and secondary.valid;
equation
  primary.reactorPowerMW = reactorPowerMW;
  primary.pumpCommand = 1;
  primary.steamTemperatureC = secondary.temperatureC;
  primary.heaterPowerMW = 0;
  primary.sprayFlowKgS = 0;
  primary.chargingFlowKgS = 0;
  primary.letdownFlowKgS = 0;
  secondary.heatInputMW = primary.heatToSteamMW;
  secondary.feedwaterFlowKgS = feedwaterFlowKgS;
  secondary.feedwaterEnthalpyJkg = feedwaterEnthalpyJkg;
  secondary.steamFlowKgS = steamFlowKgS;
  annotation(experiment(StartTime=0, StopTime=15, Interval=0.05, Tolerance=1e-7));
end KrskoTransient;
