within;
model KrskoContinuousThermal "Measured-boundary replay of the continuous-startup production thermal kernel"
  // SPDX-License-Identifier: Apache-2.0
  // ContinuousPlant composes this exact ColdStartPlant class. This wrapper
  // changes initial conditions and plant parameters, not its balance equations.
  // Measured heat and steam/feed boundaries exclude kinetics, turbine, grid,
  // condenser and controller prediction. This is not full-startup qualification.
  package Water = Modelica.Media.Water.StandardWater;
  package PrimaryWater = Modelica.Media.Water.WaterIF97_pT;

  // NUREG/IA-0221 Table 2, measured t=0 column; see the case source ledger.
  parameter Real initialCoreHeatMW = 1833.2836 "1994 MW core rating times 91.94 percent";
  parameter Real referenceScale = initialCoreHeatMW/3000;
  parameter Real geometryScale = 1 "Unfitted sensitivity multiplier for volumes and fuel capacity";
  parameter Real pumpHeatMW = 6 "Nominal total pump heat from report section 2; no measured history";
  parameter Real initialPressurePa = 15.48e6;
  parameter Real initialHotTemperatureK = 594.175;
  parameter Real initialColdTemperatureK = 559.445;
  parameter Real initialSteamPressurePa = 6.41e6;
  parameter Real initialSteamFlowKgS = 994.1;
  parameter Real initialFeedwaterFlowKgS = 1004.6;

  // Preserve the existing Krško comparison's disclosed, unidentified geometry.
  // Neither indicated level is an independently established physical volume.
  parameter Real primaryVolumeM3 = 300*referenceScale "Production kernel allocates equal hot and cold volumes";
  parameter Real pressurizerVolumeM3 = 50*referenceScale;
  parameter Real initialPressurizerLiquidFraction = .5295 "Unresolved instrument-level to volume approximation";
  parameter Real secondaryVolumeM3 = 400*referenceScale;
  parameter Real initialSecondaryLiquidFraction = .5 "Generic liquid-volume assumption, not indicated SG level";
  parameter Real fuelCapacityJK = 60e6*referenceScale;
  parameter Real initialFuelTemperatureK = 873.15 "Unmeasured generic fuel temperature, retained from prior case";
  parameter Real chargingTemperatureK = 323.15 "Unmeasured; inactive with zero charging boundary";

  // Only published initial conditions enter these balance calibrations. No
  // transient pressure or temperature response is used to determine a value.
  parameter Real primaryNominalFlowKgS = initialCoreHeatMW*1e6/
    (PrimaryWater.specificEnthalpy_pT(initialPressurePa,initialHotTemperatureK)
      -PrimaryWater.specificEnthalpy_pT(initialPressurePa,initialColdTemperatureK));
  parameter Real fuelConductanceWK = initialCoreHeatMW*1e6/(initialFuelTemperatureK-initialHotTemperatureK);
  parameter Real initialSteamTemperatureK = Water.saturationTemperature(initialSteamPressurePa);
  parameter Real steamGeneratorConductanceMWK = (initialCoreHeatMW+pumpHeatMW)/
    (initialColdTemperatureK-initialSteamTemperatureK);
  parameter Real feedwaterEnthalpyJkg =
    (initialSteamFlowKgS*Water.dewEnthalpy(Water.setSat_p(initialSteamPressurePa))
      -(initialCoreHeatMW+pumpHeatMW)*1e6)/initialFeedwaterFlowKgS;

  input Real reactorPowerMW(start=1833.2836) "Measured pre-trip neutron-power proxy for core heat";
  input Real steamFlowKgS(start=994.1) "Measured aggregate steamline flow, including steam dump";
  input Real feedwaterFlowKgS(start=1004.6) "Measured aggregate feedwater flow";
  input Real heaterPowerMW(start=0) "Unmeasured; explicitly zero in the reference replay";
  input Real chargingFlowKgS(start=0) "Unresolved L/s reference density; explicitly zero in the replay";
  input Real letdownFlowKgS(start=0) "Unresolved L/s reference density; explicitly zero in the replay";

  ColdStartPlant thermal(
    initialHotTemperatureK=initialHotTemperatureK,
    initialColdTemperatureK=initialColdTemperatureK,
    initialFuelTemperatureK=initialFuelTemperatureK,
    initialPumpSpeed=1,initialPrimaryFlowKgS=primaryNominalFlowKgS,
    initialPrimaryPressurePa=initialPressurePa,
    initialPressurizerTemperatureK=Water.saturationTemperature(initialPressurePa),
    pressurizerVolumeM3=pressurizerVolumeM3*geometryScale,
    initialPressurizerLiquidVolumeM3=pressurizerVolumeM3*geometryScale*initialPressurizerLiquidFraction,
    initialSecondaryPressurePa=initialSteamPressurePa,
    initialSecondaryTemperatureK=initialSteamTemperatureK,
    secondaryVolumeM3=secondaryVolumeM3*geometryScale,
    initialSecondaryLiquidVolumeM3=secondaryVolumeM3*geometryScale*initialSecondaryLiquidFraction,
    primaryVolumeM3=primaryVolumeM3*geometryScale,
    fuelCapacityJK=fuelCapacityJK*geometryScale,fuelConductanceWK=fuelConductanceWK,
    nominalFlowKgS=primaryNominalFlowKgS,pumpHeatAtFullSpeedMW=pumpHeatMW,
    steamGeneratorConductanceMWK=steamGeneratorConductanceMWK,
    chargingTemperatureK=chargingTemperatureK,
    maximumFuelHeatMW=3300,maximumFuelTemperatureK=1400,
    maximumHotTemperatureK=620,maximumColdTemperatureK=610);

  output Real primaryPressureMPa = thermal.primaryPressureMPa;
  output Real hotLegTemperatureC = thermal.hotLegTemperatureC;
  output Real coldLegTemperatureC = thermal.coldLegTemperatureC;
  output Real steamPressureMPa = thermal.secondaryPressureMPa;
  output Real secondaryTemperatureC = thermal.secondaryTemperatureC;
  output Real secondaryLevelPercent = thermal.secondaryLevelPercent;
  output Real fuelTemperatureC = thermal.fuelTemperatureC;
  output Real primaryFlowKgS = thermal.primaryFlowKgS;
  output Real heatToSteamMW = thermal.heatToSteamMW;
  output Real pressurizerTemperatureC = thermal.pressurizerTemperatureC;
  output Real pressurizerLevelPercent = thermal.pressurizerLevelPercent;
  output Real primarySubcoolingK = thermal.primarySubcoolingK;
  output Real thermalEnergyMJ = thermal.totalPlantStoredEnergyMJ;
  output Real totalMassKg = thermal.totalPlantMassKg;
  output Real boundaryPowerMW = thermal.plantBoundaryPowerMW;
  output Real boundaryMassFlowKgS = thermal.plantBoundaryMassFlowKgS;
  output Real energyResidualMW = thermal.plantEnergyResidualMW;
  output Real massResidualKgS = thermal.plantMassResidualKgS;
  output Real integratedBoundaryEnergyMJ = thermal.integratedPlantBoundaryEnergyMJ;
  output Real integratedBoundaryMassKg = thermal.integratedPlantBoundaryMassKg;
  // Primitive flux observations also permit boundary quadrature independent
  // of the kernel's reported total boundary rates and integrated ledgers.
  output Real pumpHeatInputMW = thermal.pumpHeatMW;
  output Real actualHeaterPowerMW = thermal.actualHeaterPowerMW;
  output Real actualChargingFlowKgS = thermal.actualChargingFlowKgS;
  output Real actualLetdownFlowKgS = thermal.actualLetdownFlowKgS;
  output Real shutdownCoolingMW = thermal.shutdownCoolingMW;
  output Real steamEnthalpyJkg = thermal.secondarySteamEnthalpyJkg;
  output Real chargingEnthalpyJkg = thermal.chargingEnthalpyJkg;
  output Real coldLegEnthalpyJkg = thermal.coldLegEnthalpyJkg;
  output Real pressurizerVentPowerW = thermal.pressurizerVentPowerW;
  output Real secondaryVentPowerW = thermal.secondary.ventPowerW;
  output Real pressurizerSteamVentKgS = thermal.ventSteamFlowKgS;
  output Real pressurizerGasVentKgS = thermal.ventGasFlowKgS;
  output Real secondarySteamVentKgS = thermal.secondarySteamVentKgS;
  output Real secondaryGasVentKgS = thermal.secondaryGasVentKgS;
  output Real pressurizerGasMassKg = thermal.pressurizerGasMassKg;
  output Real secondaryGasMassKg = thermal.secondaryGasMassKg;
  output Boolean valid = thermal.valid;
equation
  thermal.pumpCommand = 1;
  thermal.startupHeatMW = reactorPowerMW;
  thermal.heaterPowerMW = heaterPowerMW;
  thermal.shutdownCoolingFraction = 0;
  thermal.chargingFlowKgS = chargingFlowKgS;
  thermal.letdownFlowKgS = letdownFlowKgS;
  thermal.ventFraction = 0;
  thermal.pressureControlEnable = 0;
  thermal.pressureTargetMPa = initialPressurePa/1e6;
  thermal.inventoryControlEnable = 0;
  thermal.secondaryFeedwaterFlowKgS = feedwaterFlowKgS;
  thermal.secondaryFeedwaterEnthalpyJkg = feedwaterEnthalpyJkg;
  thermal.secondarySteamFlowKgS = steamFlowKgS;
  annotation(experiment(StartTime=0,StopTime=15,Interval=0.05,Tolerance=1e-11));
end KrskoContinuousThermal;
