within;
package PressureComponentChecks "Reproducible numerical checks; not measured component qualification"
  // SPDX-License-Identifier: Apache-2.0
  model VesselCase
    package Water = Modelica.Media.Water.StandardWater;
    FinitePhasePressurizer vessel;
    output Real pressureMPa=vessel.pressurePa/1e6;
    output Real liquidTemperatureK=vessel.liquidTemperatureK;
    output Real vaporTemperatureK=vessel.vaporTemperatureK;
    output Real steamPartialPressurePa=vessel.steamPartialPressurePa;
    output Real liquidVolumeM3=vessel.liquidVolumeM3;
    output Real gasMassKg=vessel.gasMassKg;
    output Real vaporMassKg=vessel.vaporMassKg;
    output Real totalMassKg=vessel.waterMassKg+vessel.gasMassKg;
    output Real totalEnergyMJ=vessel.energyJ/1e6;
    output Real wallEnergyMJ=vessel.wallEnergyJ/1e6;
    output Real wallMinimumTemperatureK=min(vessel.wallTemperatureK);
    output Real wallMaximumTemperatureK=max(vessel.wallTemperatureK);
    output Real minimumFilmNusseltArgument=vessel.minimumFilmNusseltArgument;
    output Real liquidFlowKgS=vessel.liquidFlowKgS;
    output Real liquidEnthalpyJkg=vessel.liquidEnthalpyJkg;
    output Real heatInputMW=vessel.heatInputW/1e6;
    output Real steamFlowKgS=vessel.steamFlowKgS;
    output Real steamVentKgS=vessel.steamVentKgS;
    output Real gasVentKgS=vessel.gasVentKgS;
    output Real vaporEnthalpyJkg=vessel.vaporEnthalpy;
    output Real wallAmbientPowerMW=vessel.wallAmbientPowerW/1e6;
    output Real actualSprayFlowKgS=vessel.sprayFlowKgS;
    output Real sprayCondensationKgS=vessel.sprayCondensationKgS;
    output Real sprayHeatTransferMW=vessel.sprayHeatTransferW/1e6;
    output Real boundaryPowerMW=(liquidFlowKgS*liquidEnthalpyJkg-vessel.ventPowerW-steamFlowKgS*vaporEnthalpyJkg)/1e6+heatInputMW-wallAmbientPowerMW;
    output Real boundaryMassFlowKgS=liquidFlowKgS-steamVentKgS-gasVentKgS-steamFlowKgS;
    output Real integratedBoundaryEnergyMJ(start=0,fixed=true);
    output Real integratedBoundaryMassKg(start=0,fixed=true);
    output Real energyResidualMW=vessel.energyRateW/1e6-boundaryPowerMW;
    output Real massResidualKgS=vessel.massRateKgS-gasVentKgS-boundaryMassFlowKgS;
    output Boolean valid=vessel.valid;
  equation
    der(integratedBoundaryEnergyMJ)=boundaryPowerMW;
    der(integratedBoundaryMassKg)=boundaryMassFlowKgS;
    vessel.imposedRates=zeros(4);
    vessel.steamFlowKgS=0;
  end VesselCase;

  model ColdNitrogenEquilibrium
    extends VesselCase;
  equation
    vessel.liquidFlowKgS=0;
    vessel.liquidEnthalpyJkg=0;
    vessel.heatInputW=0;
    vessel.ventFraction=0;
  end ColdNitrogenEquilibrium;

  model AdiabaticCompression
    extends VesselCase(vessel(includeWall=false,initialPressurePa=15.5e6,
      initialLiquidTemperatureK=Water.saturationTemperature(15.5e6),
      initialVaporTemperatureK=Water.saturationTemperature(15.5e6)));
  equation
    vessel.liquidFlowKgS=if time<5 then 0 else 5;
    vessel.liquidEnthalpyJkg=Water.specificEnthalpy_pT(15.5e6,590);
    vessel.heatInputW=0;
    vessel.ventFraction=0;
  end AdiabaticCompression;

  model VentHeadspace
    extends VesselCase(vessel(includeWall=false));
  equation
    vessel.liquidFlowKgS=0;
    vessel.liquidEnthalpyJkg=0;
    vessel.heatInputW=0;
    vessel.ventFraction=if time<5 then 0 else .1;
  end VentHeadspace;

  model WallCondensation
    extends VesselCase(vessel(initialPressurePa=6e6,
      initialLiquidTemperatureK=Water.saturationTemperature(6e6),
      initialVaporTemperatureK=Water.saturationTemperature(6e6),
      initialWallTemperatureK=Water.saturationTemperature(6e6)-5,
      wallThicknessM=.1152,wallConductivityWMK=46.05,wallVolumetricHeatCapacityJm3K=3.8775e6));
  equation
    vessel.liquidFlowKgS=0;
    vessel.liquidEnthalpyJkg=0;
    vessel.heatInputW=0;
    vessel.ventFraction=0;
  end WallCondensation;

  model WallCondensationRefined
    extends WallCondensation(vessel(wallSegments=24,wallRadialCells=16));
  end WallCondensationRefined;

  model CoupledCase
    ColdStartPlant plant(useFinitePhasePressurizer=true);
    output Real pressureMPa=plant.primaryPressureMPa;
    output Real liquidTemperatureK=plant.pressurizerTemperatureC+273.15;
    output Real vaporTemperatureK=plant.pressurizerVaporTemperatureC+273.15;
    output Real steamPartialPressurePa=plant.pressurizerSteamPartialPressurePa;
    output Real liquidVolumeM3=plant.pressurizerLevelPercent*plant.pressurizerVolumeM3/100;
    output Real gasMassKg=plant.pressurizerGasMassKg;
    output Real vaporMassKg=plant.pressurizerVaporMassKg;
    output Real totalMassKg=plant.totalPlantMassKg;
    output Real totalEnergyMJ=plant.totalPlantStoredEnergyMJ;
    output Real wallEnergyMJ=plant.pressurizerWallEnergyMJ;
    output Real wallMinimumTemperatureK=plant.pressurizerWallMinimumTemperatureK;
    output Real wallMaximumTemperatureK=plant.pressurizerWallMaximumTemperatureK;
    output Real minimumFilmNusseltArgument=plant.pressurizerMinimumFilmNusseltArgument;
    output Real boundaryPowerMW=plant.plantBoundaryPowerMW;
    output Real boundaryMassFlowKgS=plant.plantBoundaryMassFlowKgS;
    output Real integratedBoundaryEnergyMJ=plant.integratedPlantBoundaryEnergyMJ;
    output Real integratedBoundaryMassKg=plant.integratedPlantBoundaryMassKg;
    output Real energyResidualMW=plant.plantEnergyResidualMW;
    output Real massResidualKgS=plant.plantMassResidualKgS;
    output Real heatInputMW=plant.reactorPowerMW;
    output Real pumpHeatMW=plant.pumpHeatMW;
    output Real heaterPowerMW=plant.actualHeaterPowerMW;
    output Real shutdownCoolingMW=plant.shutdownCoolingMW;
    output Real chargingFlowKgS=plant.actualChargingFlowKgS;
    output Real letdownFlowKgS=plant.actualLetdownFlowKgS;
    output Real chargingEnthalpyJkg=plant.chargingEnthalpyJkg;
    output Real coldLegEnthalpyJkg=plant.coldLegEnthalpyJkg;
    output Real steamVentKgS=plant.ventSteamFlowKgS;
    output Real gasVentKgS=plant.ventGasFlowKgS;
    output Real vaporEnthalpyJkg=plant.pressurizerSteamEnthalpyJkg;
    output Real secondarySteamVentKgS=plant.secondarySteamVentKgS;
    output Real secondaryGasVentKgS=plant.secondaryGasVentKgS;
    output Real secondaryVaporEnthalpyJkg=plant.secondarySteamEnthalpyJkg;
    output Real secondaryTemperatureK=plant.secondaryTemperatureC+273.15;
    output Real wallAmbientPowerMW=plant.pressurizerWallAmbientPowerMW;
    output Real actualSprayFlowKgS=plant.actualSprayFlowKgS;
    output Real sprayCondensationKgS=plant.sprayCondensationKgS;
    output Real sprayHeatTransferMW=plant.sprayHeatTransferMW;
    output Real hotTemperatureK=plant.hotLegTemperatureC+273.15;
    output Real coldTemperatureK=plant.coldLegTemperatureC+273.15;
    output Real fuelTemperatureK=plant.fuelTemperatureC+273.15;
    output Real primaryFlowKgS=plant.primaryFlowKgS;
    output Real primarySubcoolingK=plant.primarySubcoolingK;
    output Real secondaryPressureMPa=plant.secondaryPressureMPa;
    output Real secondaryLevelPercent=plant.secondaryLevelPercent;
    output Real secondaryGasMassKg=plant.secondaryGasMassKg;
    output Boolean valid=plant.valid;
  equation
    plant.chargingFlowKgS=0;
    plant.letdownFlowKgS=0;
    plant.shutdownCoolingFraction=0;
    plant.pressureControlEnable=0;
    plant.pressureTargetMPa=.3;
    plant.inventoryControlEnable=0;
    plant.secondaryFeedwaterFlowKgS=0;
    plant.secondaryFeedwaterEnthalpyJkg=0;
    plant.secondarySteamFlowKgS=0;
  end CoupledCase;

  model CoupledColdEquilibrium
    extends CoupledCase;
  equation
    plant.pumpCommand=0;
    plant.startupHeatMW=0;
    plant.heaterPowerMW=0;
    plant.ventFraction=0;
  end CoupledColdEquilibrium;

  model CoupledColdHeating
    extends CoupledCase;
  equation
    plant.pumpCommand=1;
    plant.startupHeatMW=5;
    plant.heaterPowerMW=.5;
    plant.ventFraction=if time<300 then 0 else .02;
  end CoupledColdHeating;

  model CoupledRecirculationSpray
    extends CoupledCase(plant(initialPrimaryPressurePa=15.5e6,
      initialPressurizerTemperatureK=Modelica.Media.Water.StandardWater.saturationTemperature(15.5e6),
      pressurizerIncludeWall=false,sprayFlowKgS=if time<5 then 0 else .5));
  equation
    plant.pumpCommand=0;
    plant.startupHeatMW=0;
    plant.heaterPowerMW=0;
    plant.ventFraction=0;
  end CoupledRecirculationSpray;
end PressureComponentChecks;
