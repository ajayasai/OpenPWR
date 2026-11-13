within;
partial model KrskoPressureDevelopmentBase "Matched-boundary production pressure development experiment"
  // SPDX-License-Identifier: Apache-2.0
  // A published Doel input-model wall supplies a declared analogue, not Krško
  // construction. Existing assumed Krško volume fixes the equivalent radius.
  // See validation/krsko_pressure/candidate-config.json, frozen before scoring.
  parameter Boolean finitePhaseMode = false annotation(Evaluate=true);
  parameter Boolean wallMode = false annotation(Evaluate=true);
  parameter Integer wallSegments = 12;
  parameter Integer wallRadialCells = 8;
  parameter Boolean automaticSprayEnabled = false annotation(Evaluate=true);
  parameter Real sprayReferencePressureMPa = 15.51;
  parameter Real sprayGainFractionPerMPa = 2;
  parameter Real sprayMaximumFlowKgS = 20.67;
  parameter Real sprayContactEfficiency = 1;
  parameter Real pressurizerPhaseRelaxationTimeS = .1;
  parameter Real pressurizerInterfacialConductanceWK = 0;
  parameter Real pressurizerVesselHeightM = 11.864;
  parameter Real pressurizerWallThicknessM = .1152;
  parameter Real pressurizerWallVolumetricHeatCapacityJm3K = 3.8775e6;
  parameter Real pressurizerWallConductivityWMK = 46.05;
  extends KrskoContinuousThermal(thermal(
    useFinitePhasePressurizer=finitePhaseMode,
    pressurizerIncludeWall=wallMode,
    pressurizerWallSegments=wallSegments,
    pressurizerWallRadialCells=wallRadialCells,
    pressurizerPhaseRelaxationTimeS=pressurizerPhaseRelaxationTimeS,
    pressurizerInterfacialConductanceWK=pressurizerInterfacialConductanceWK,
    pressurizerVesselHeightM=pressurizerVesselHeightM,
    pressurizerWallThicknessM=pressurizerWallThicknessM,
    pressurizerWallVolumetricHeatCapacityJm3K=pressurizerWallVolumetricHeatCapacityJm3K,
    pressurizerWallConductivityWMK=pressurizerWallConductivityWMK,
    pressurizerInitialWallTemperatureK=Water.saturationTemperature(initialPressurePa),
    sprayFlowKgS=if automaticSprayEnabled then sprayMaximumFlowKgS*
      noEvent(min(1,max(0,sprayGainFractionPerMPa*(primaryPressureMPa-sprayReferencePressureMPa)))) else 0,
    sprayContactEfficiency=sprayContactEfficiency));
  output Real pressurizerLiquidTemperatureC = thermal.pressurizerLiquidTemperatureC;
  output Real pressurizerVaporTemperatureC = thermal.pressurizerVaporTemperatureC;
  output Real pressurizerSteamPartialPressureMPa = thermal.pressurizerSteamPartialPressurePa/1e6;
  output Real pressurizerSaturationTemperatureC = thermal.pressurizerSaturationTemperatureC;
  output Real pressurizerWallEnergyMJ = thermal.pressurizerWallEnergyMJ;
  output Real pressurizerWallAmbientPowerW = thermal.pressurizerWallAmbientPowerMW*1e6;
  output Real pressurizerWallMinimumTemperatureK = thermal.pressurizerWallMinimumTemperatureK;
  output Real pressurizerWallMaximumTemperatureK = thermal.pressurizerWallMaximumTemperatureK;
  output Real pressurizerMinimumFilmNusseltArgument = thermal.pressurizerMinimumFilmNusseltArgument;
  output Real pressureModelFinitePhase = if finitePhaseMode then 1 else 0;
  output Real pressureModelIncludesWall = if wallMode then 1 else 0;
  output Real sprayControlEnabled = if automaticSprayEnabled then 1 else 0;
  output Real actualSprayFlowKgS = thermal.actualSprayFlowKgS;
  output Real sprayCondensationKgS = thermal.sprayCondensationKgS;
  output Real sprayHeatTransferMW = thermal.sprayHeatTransferMW;
  annotation(experiment(StartTime=0,StopTime=15,Interval=0.05,Tolerance=1e-11));
end KrskoPressureDevelopmentBase;

model KrskoPressureEquilibrium "Production equilibrium ablation with identical forcing"
  extends KrskoPressureDevelopmentBase(final finitePhaseMode=false,final wallMode=false,
    final wallSegments=12,final wallRadialCells=8,final automaticSprayEnabled=false);
end KrskoPressureEquilibrium;

model KrskoPressureCandidate "Finite phase inventories and declared analogue wall"
  extends KrskoPressureDevelopmentBase(final finitePhaseMode=true,final wallMode=true,
    final wallSegments=12,final wallRadialCells=8,final automaticSprayEnabled=false);
end KrskoPressureCandidate;

model KrskoPressureNoWall "Controlled wall-storage and condensation ablation"
  extends KrskoPressureDevelopmentBase(final finitePhaseMode=true,final wallMode=false,
    final wallSegments=12,final wallRadialCells=8,final automaticSprayEnabled=false);
end KrskoPressureNoWall;

model KrskoPressureRefinedWall "Same finite-phase physics with refined graded wall mesh"
  extends KrskoPressureDevelopmentBase(final finitePhaseMode=true,final wallMode=true,
    final wallSegments=24,final wallRadialCells=16,final automaticSprayEnabled=false);
end KrskoPressureRefinedWall;

model KrskoPressureSpray "Conditional generic spray control; not a measured actuator replay"
  extends KrskoPressureDevelopmentBase(final finitePhaseMode=true,final wallMode=true,
    final wallSegments=12,final wallRadialCells=8,final automaticSprayEnabled=true);
end KrskoPressureSpray;

model KrskoPressureSprayRefinedWall "Conditional spray case with refined graded wall mesh"
  extends KrskoPressureDevelopmentBase(final finitePhaseMode=true,final wallMode=true,
    final wallSegments=24,final wallRadialCells=16,final automaticSprayEnabled=true);
end KrskoPressureSprayRefinedWall;
