within OpenPWR;
model PactelPressurizer "PACTEL ATWS-10 conditional pressurizer comparison, NRC NUREG/IA-0231"
  // SPDX-License-Identifier: Apache-2.0
  // Published TRACE boundary conditions are replay assumptions, not a complete
  // measured input history. Geometry is the report's ideal cylinder, 134.885 L;
  // the VTT facility inventory table's 133.5 L is not silently substituted.
  parameter Real vesselHeightM = 8.8;
  parameter Real innerRadiusM = .06985;
  parameter Real initialPressurePa = 5.9e6;
  parameter Real initialLevelM = 3.3;
  parameter Real initialLiquidTemperatureK = 547.64;
  parameter Real initialVaporTemperatureK = 547.64;
  parameter Real initialWallTemperatureK = 547.0;
  parameter Real wallThicknessM = .0143;
  parameter Real wallDensityKgM3 = 7920 "NISTIR 7401 AISI 304 density at 296.15 K; thermal expansion omitted";
  parameter Real wallHeatCapacityJKgK = 500 "AISI304 manufacturer nominal at room temperature; assumed constant";
  parameter Real wallConductivityWMK = 15 "AISI304 manufacturer nominal at room temperature; assumed constant";
  parameter Boolean useTemperatureDependentSteel = true "NISTIR 7401 section 3.1.1, independent of PACTEL response";
  parameter Boolean resolveWallFaces = true;
  parameter Boolean useRegimeCondensation = true "Development-selected local gravity-film closure, not fitted to measured pressure";
  parameter Real filmReynoldsFloor = 1;
  parameter Real filmTransitionLower = 20;
  parameter Real filmTransitionUpper = 40;
  parameter Real externalHeatTransferWm2K = 3.44;
  parameter Real ambientTemperatureK = 298.0;
  parameter Real phaseRelaxationTimeS = .1 "Unfitted phase separation closure";
  parameter Real liquidWallHeatTransferWm2K = 500 "Unidentified convection coefficient; no pressure-curve calibration";
  parameter Integer wallSegments = 48;
  parameter Integer wallRadialCells = 8;
  parameter Boolean includeWall = true "Structural choice; false gives the explicit adiabatic ablation";
  input Real surgeFlowKgS(start=0);
  input Real surgeTemperatureK(start=547.0) "Published TRACE FILL temperature, not measured inlet history";
  input Real heaterPowerMW(start=.004);
  DynamicPressurizer vessel(
    volumeM3=Modelica.Constants.pi*innerRadiusM^2*vesselHeightM,
    vesselHeightM=vesselHeightM,
    innerRadiusM=innerRadiusM,
    initialPressurePa=initialPressurePa,
    initialLiquidVolumeM3=Modelica.Constants.pi*innerRadiusM^2*initialLevelM,
    initialLiquidTemperatureK=initialLiquidTemperatureK,
    initialVaporTemperatureK=initialVaporTemperatureK,
    phaseRelaxationTimeS=phaseRelaxationTimeS,
    includeWall=includeWall,
    wallSegments=wallSegments,
    wallRadialCells=wallRadialCells,
    wallThicknessM=wallThicknessM,
    wallDensityKgM3=wallDensityKgM3,
    wallHeatCapacityJKgK=wallHeatCapacityJKgK,
    wallConductivityWMK=wallConductivityWMK,
    useTemperatureDependentSteel=useTemperatureDependentSteel,
    resolveWallFaces=resolveWallFaces,
    useRegimeCondensation=useRegimeCondensation,
    filmReynoldsFloor=filmReynoldsFloor,
    filmTransitionLower=filmTransitionLower,
    filmTransitionUpper=filmTransitionUpper,
    initialWallTemperatureK=initialWallTemperatureK,
    ambientTemperatureK=ambientTemperatureK,
    externalHeatTransferWm2K=externalHeatTransferWm2K,
    liquidWallHeatTransferWm2K=liquidWallHeatTransferWm2K);
  output Real pressureMPa = vessel.pressureMPa;
  output Real liquidLevelM = vessel.liquidLevelM;
  output Real liquidTemperatureK = vessel.liquidTemperatureK;
  output Real vaporTemperatureK = vessel.vaporTemperatureK;
  output Real totalMassKg = vessel.totalMassKg;
  output Real thermalEnergyMJ = vessel.thermalEnergyMJ;
  output Real boundaryMassFlowKgS = vessel.boundaryMassFlowKgS;
  output Real boundaryPowerMW = vessel.boundaryPowerMW;
  output Real surgeInletEnthalpyJkg = PrimaryWater.specificEnthalpy_pT(vessel.pressurePa,min(surgeTemperatureK,Water.saturationTemperature(vessel.pressurePa)-.01))
    "Subcooled inlet enthalpy; invalid if supplied temperature reaches saturation";
  output Real surgeOutflowEnthalpyJkg = vessel.liquidEnthalpyJkg;
  output Real wallHeatLossMW = vessel.wallHeatLossMW;
  output Real wallCondensationKgS = vessel.wallCondensationKgS;
  output Real maximumFilmReynolds = vessel.maximumFilmReynolds;
  output Real bulkEvaporationKgS = vessel.bulkEvaporationKgS;
  output Real bulkCondensationKgS = vessel.bulkCondensationKgS;
  output Real massResidualKgS = vessel.massResidualKgS;
  output Real energyResidualMW = vessel.energyResidualMW;
  output Real integratedBoundaryMassKg = vessel.integratedBoundaryMassKg;
  output Real integratedBoundaryEnergyMJ = vessel.integratedBoundaryEnergyMJ;
  output Boolean valid = vessel.valid and (surgeFlowKgS<=0 or surgeTemperatureK<Water.saturationTemperature(vessel.pressurePa));
equation
  vessel.surgeFlowKgS = surgeFlowKgS;
  vessel.surgeEnthalpyJkg = surgeInletEnthalpyJkg;
  vessel.sprayFlowKgS = 0;
  vessel.sprayEnthalpyJkg = surgeInletEnthalpyJkg;
  vessel.heaterPowerMW = heaterPowerMW;
  annotation(experiment(StartTime=0,StopTime=500,Interval=.1,Tolerance=1e-9));
end PactelPressurizer;

model PactelCoarse "Same fixed PACTEL model with 12 axial/four radial wall cells"
  extends PactelPressurizer(wallSegments=12,wallRadialCells=4);
end PactelCoarse;

model PactelRadialRefined "Same fixed PACTEL model with 12 axial/eight radial wall cells"
  extends PactelPressurizer(wallSegments=12,wallRadialCells=8);
end PactelRadialRefined;

model PactelSpatialRefined "Same fixed PACTEL model with 24 axial/eight radial wall cells"
  extends PactelPressurizer(wallSegments=24,wallRadialCells=8);
end PactelSpatialRefined;

model PactelAdiabatic "Same ATWS-10 boundary replay with the wall omitted"
  extends PactelPressurizer(includeWall=false);
end PactelAdiabatic;
