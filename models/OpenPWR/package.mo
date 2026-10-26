within ;
package OpenPWR "OpenPWR native engineering workbench"
  // SPDX-License-Identifier: Apache-2.0
  // Original subsystem model. Modelica Standard Library water properties retain
  // their own BSD-3-Clause license. No ThermoSysPro or proprietary code is used.
  package Water = Modelica.Media.Water.StandardWater;
  package PrimaryWater = Modelica.Media.Water.StandardWaterOnePhase
    "Direct IF97 p,T properties for the subcooled primary volumes";

  function balanceRates "Solve the four coupled inventory balances with upstream surge enthalpy"
    input Real mh[4];
    input Real mc[4];
    input Real uh[4];
    input Real uc[4];
    input Real mp[4];
    input Real up[4];
    input Real hHot;
    input Real hCold;
    input Real hLiquid;
    input Real hCharging;
    input Real circulation;
    input Real fuelHeat;
    input Real steamHeat;
    input Real pumpHeat;
    input Real spray;
    input Real charging;
    input Real letdown;
    input Real heater;
    input Real loss;
    output Real pressureRate;
    output Real liquidVolumeRate;
    output Real hotTemperatureRate;
    output Real coldTemperatureRate;
  protected
    Real A[4,4];
    Real b[4];
    Real hs;
    Real cs;
    Real surge;
    Real rates[4];
  algorithm
    cs := -spray + charging - letdown;
    // The valid envelope retains forward primary circulation. Surge can reverse.
    // Solve the two possible linear systems and retain the consistent upstream
    // enthalpy. At zero surge the transported energy is zero in either branch.
    for branch in 1:2 loop
      hs := if branch == 1 then hHot else hLiquid;
      A[1,:] := uh - mh * hs - mc * (hs - hHot);
      A[2,:] := uc - mc * hHot;
      A[3,:] := mp + mh + mc;
      A[4,:] := up + (mh + mc) * hs;
      b := {fuelHeat + circulation * (hCold - hHot) + cs * (hHot - hs),
        circulation * (hHot - hCold) - cs * hHot - steamHeat + pumpHeat - spray * hCold + charging * hCharging - letdown * hCold,
        charging - letdown, cs * hs + spray * hCold + heater - loss};
      // Scale pressure into MPa/s and the balance rows into MW / tonne/s before
      // the standard-library linear solve; restore Pa/s afterwards.
      A[:,1] := A[:,1] * 1e6;
      for row in 1:4 loop
        if row == 3 then
          A[row,:] := A[row,:] / 1000;
          b[row] := b[row] / 1000;
        else
          A[row,:] := A[row,:] / 1e6;
          b[row] := b[row] / 1e6;
        end if;
      end for;
      rates := Modelica.Math.Matrices.solve(A, b);
      rates[1] := rates[1] * 1e6;
      pressureRate := rates[1];
      liquidVolumeRate := rates[2];
      hotTemperatureRate := rates[3];
      coldTemperatureRate := rates[4];
      surge := cs - (mh + mc) * rates;
      if branch == 1 and surge >= 0 then
        return;
      end if;
    end for;
  end balanceRates;

  model DynamicPressurizer "Separate liquid/vapor energy inventories with optional wall condensation"
    // Original implementation of control-volume balances. Phase-work terms are
    // retained explicitly; the wall and phase-transfer closures are assumptions,
    // not gains fitted to the Krško transient. See docs/PRESSURIZER_MODEL.md.
    parameter Real volumeM3 = 50;
    parameter Real initialPressurePa = 15.5e6;
    parameter Real initialLiquidVolumeM3 = 25;
    package LiquidWater = Modelica.Media.Water.WaterIF97_R1pT;
    package SteamWater = Modelica.Media.Water.WaterIF97_R2pT;
    parameter Real initialLiquidTemperatureK = Water.saturationTemperature(initialPressurePa);
    parameter Real initialVaporTemperatureK = Water.saturationTemperature(initialPressurePa);
    parameter Boolean initializePressure = true;
    parameter Real phaseRelaxationTimeS = 0.1 "Unfitted finite-rate relaxation of entrained phase mass";
    parameter Real interfacialConductanceWK = 0 "Zero: insulated bulk interface, applicable to piston-like insurge assumption";
    parameter Real ambientHeatLossW = 0 "Additional imposed external loss from liquid";
    parameter Boolean includeWall = false;
    parameter Integer wallSegments = 12 "Fixed axial wall cells; no wall mass moves with the interface";
    parameter Integer wallRadialCells = 4 "Finite-volume radial conduction; equal radial widths";
    parameter Real vesselHeightM = 10;
    parameter Real innerRadiusM = sqrt(volumeM3/(Modelica.Constants.pi*vesselHeightM));
    parameter Real wallThicknessM = 0.0143;
    parameter Real wallDensityKgM3 = 7850 "Generic steel assumption, not identified TRACE material 6";
    parameter Real wallHeatCapacityJKgK = 500 "Generic steel assumption";
    parameter Real wallConductivityWMK = 16 "Generic steel assumption";
    parameter Boolean useTemperatureDependentSteel = false "NISTIR7401 AISI304 correlations; uncalibrated material choice";
    parameter Boolean resolveWallFaces = true "Include cylindrical half-cell resistance at inner/outer surfaces";
    parameter Real initialWallTemperatureK = Water.saturationTemperature(initialPressurePa);
    parameter Real ambientTemperatureK = 298.15;
    parameter Real externalHeatTransferWm2K = 0;
    parameter Real liquidWallHeatTransferWm2K = 500 "Unfitted liquid convection assumption; explicit sensitivity parameter";
    parameter Real vaporWallHeatTransferWm2K = 10 "Unfitted vapor sensible-convection assumption when wall is above saturation";
    input Real surgeFlowKgS(start=0) "Positive liquid injection; negative outflow uses the liquid inventory enthalpy";
    input Real surgeEnthalpyJkg(start=1.4e6) "Inlet enthalpy used only for positive surge";
    input Real sprayFlowKgS(start=0) "Liquid injection into the bulk pool; droplet/steam interaction is not resolved";
    input Real sprayEnthalpyJkg(start=1.3e6);
    input Real heaterPowerMW(start=0);
    output Real pressurePa(start=initialPressurePa, fixed=initializePressure, nominal=1e6, stateSelect=StateSelect.always);
    output Real pressureMPa = pressurePa/1e6;
    output Real liquidVolumeM3(start=initialLiquidVolumeM3, fixed=true, nominal=1, stateSelect=StateSelect.always);
    output Real liquidTemperatureK(start=initialLiquidTemperatureK, fixed=true, nominal=500, stateSelect=StateSelect.always);
    output Real vaporTemperatureK(start=initialVaporTemperatureK, fixed=true, nominal=500, stateSelect=StateSelect.always);
    output Real liquidEnthalpyJkg = LiquidWater.specificEnthalpy(liquidState);
    output Real vaporEnthalpyJkg = SteamWater.specificEnthalpy(vaporState);
    output Real saturationTemperatureK = Water.saturationTemperature(pressurePa);
    output Real liquidDensityKgM3 = LiquidWater.density(liquidState);
    output Real vaporDensityKgM3 = SteamWater.density(vaporState);
    output Real liquidLevelM = liquidVolumeM3/crossSectionM2;
    output Real levelPercent = 100*liquidVolumeM3/volumeM3;
    output Real liquidMassKg = liquidVolumeM3*liquidDensityKgM3;
    output Real vaporMassKg = (volumeM3-liquidVolumeM3)*vaporDensityKgM3;
    output Real totalMassKg = liquidMassKg+vaporMassKg;
    output Real fluidEnergyMJ = (liquidMassKg*liquidEnthalpyJkg+vaporMassKg*vaporEnthalpyJkg-pressurePa*volumeM3)/1e6;
    output Real wallEnergyMJ = if includeWall then sum(wallCellMassKg[j]*solidEnthalpy(wallTemperatureK[i,j],useTemperatureDependentSteel,wallHeatCapacityJKgK) for i in 1:wallSegments,j in 1:wallRadialCells)/1e6 else 0;
    output Real thermalEnergyMJ = fluidEnergyMJ+wallEnergyMJ;
    output Real boundaryMassFlowKgS = surgeFlowKgS+sprayFlowKgS;
    output Real boundaryPowerMW = (surgePowerW+sprayFlowKgS*sprayEnthalpyJkg-ambientHeatLossW-sum(wallAmbientPowerW))/1e6+heaterPowerMW;
    output Real integratedBoundaryMassKg(start=0,fixed=true);
    output Real integratedBoundaryEnergyMJ(start=0,fixed=true);
    output Real massRateKgS;
    output Real fluidEnergyRateW;
    output Real energyResidualMW;
    output Real massResidualKgS;
    output Real wallCondensationKgS = sum(wallCondensation);
    output Real bulkEvaporationKgS;
    output Real bulkCondensationKgS;
    output Real wallHeatLossMW = sum(wallAmbientPowerW)/1e6;
    output Real wallTemperatureK[wallSegments,wallRadialCells](each start=initialWallTemperatureK,each fixed=true,each nominal=500);
    output Real innerWallTemperatureK[wallSegments](each start=initialWallTemperatureK,each nominal=500,each min=273.15,each max=1073.15);
    output Real outerWallTemperatureK[wallSegments](each start=initialWallTemperatureK,each nominal=500,each min=273.15,each max=1073.15);
    output Boolean valid;
    function solidHeatCapacity
      input Real temperatureK;
      input Boolean temperatureDependent;
      input Real constantHeatCapacity;
      output Real cp;
    algorithm
      cp := if temperatureDependent then 6.683+0.04906*temperatureK+80.74*log(temperatureK) else constantHeatCapacity;
    end solidHeatCapacity;
    function solidEnthalpy "Exact integral of NIST 304 cp relative to 273.15 K"
      input Real temperatureK;
      input Boolean temperatureDependent;
      input Real constantHeatCapacity;
      output Real h;
    algorithm
      h := if temperatureDependent then 6.683*(temperatureK-273.15)+0.04906/2*(temperatureK^2-273.15^2)
        +80.74*(temperatureK*log(temperatureK)-temperatureK-273.15*log(273.15)+273.15)
        else constantHeatCapacity*(temperatureK-273.15);
    end solidEnthalpy;
    function conductivityIntegral "Kirchhoff potential whose derivative is NIST304 k(T)"
      input Real temperatureK;
      input Boolean temperatureDependent;
      input Real constantConductivity;
      output Real potential;
    algorithm
      potential := if temperatureDependent then 9.705*temperatureK+0.0176/2*temperatureK^2-1.60e-6/3*temperatureK^3 else constantConductivity*temperatureK;
    end conductivityIntegral;
  protected
    parameter Real crossSectionM2 = volumeM3/vesselHeightM;
    parameter Real cellHeightM = vesselHeightM/wallSegments;
    parameter Real wallRadiusM[wallRadialCells+1] = {innerRadiusM+wallThicknessM*(j-1)/wallRadialCells for j in 1:wallRadialCells+1};
    parameter Real wallCenterRadiusM[wallRadialCells] = {(wallRadiusM[j]+wallRadiusM[j+1])/2 for j in 1:wallRadialCells};
    parameter Real wallCellMassKg[wallRadialCells] = {Modelica.Constants.pi*(wallRadiusM[j+1]^2-wallRadiusM[j]^2)*cellHeightM*wallDensityKgM3 for j in 1:wallRadialCells};
    Real wallCellCapacityJK[wallSegments,wallRadialCells];
    Real wallConductivityPotential[wallSegments,wallRadialCells];
    LiquidWater.ThermodynamicState liquidState;
    SteamWater.ThermodynamicState vaporState;
    Water.ThermodynamicState filmState[wallSegments];
    Water.SaturationProperties sat;
    Real liquidSatH;
    Real vaporSatH;
    Real latentHeat;
    Real massLiquid[4];
    Real massVapor[4];
    Real energyLiquid[4];
    Real energyVapor[4];
    Real A[4,4];
    Real rhs[4];
    Real pressureRate;
    Real volumeRate;
    Real liquidTemperatureRate;
    Real vaporTemperatureRate;
    Real rhoLp;
    Real rhoLT;
    Real rhoVp;
    Real rhoVT;
    Real liquidInternalEnergy;
    Real vaporInternalEnergy;
    Real cpLiquid;
    Real cpVapor;
    Real alphaLiquid;
    Real alphaVapor;
    Real kappaLiquid;
    Real kappaVapor;
    Real surgePowerW;
    Real phaseEnergyW;
    Real interfacialHeatW;
    Real wallLiquidPowerW[wallSegments];
    Real wallVaporPowerW[wallSegments];
    Real wallAmbientPowerW[wallSegments];
    Real wallAxialPowerW[wallSegments,wallRadialCells];
    Real wallRadialPowerW[wallSegments,wallRadialCells+1] "Positive radially outward";
    Real wallCondensation[wallSegments];
    Real wallFilmPowerW[wallSegments];
    Real wettedFraction[wallSegments];
    Real filmDeltaT[wallSegments];
    Real filmCoefficient[wallSegments];
    Real vaporHeightM;
  equation
    // Direct p,T Gibbs functions avoid the approximate IF97 p,h backward map.
    // Fixed phase branches are continued at most 2 K past saturation only for
    // the declared finite phase-transfer relaxation; they never switch regions.
    liquidState = LiquidWater.setState_pT(pressurePa,liquidTemperatureK);
    vaporState = SteamWater.setState_pT(pressurePa,vaporTemperatureK);
    sat = Water.setSat_p(pressurePa);
    liquidSatH = Water.bubbleEnthalpy(sat);
    vaporSatH = Water.dewEnthalpy(sat);
    latentHeat = vaporSatH-liquidSatH;
    liquidInternalEnergy = LiquidWater.specificInternalEnergy(liquidState);
    vaporInternalEnergy = SteamWater.specificInternalEnergy(vaporState);
    cpLiquid = LiquidWater.specificHeatCapacityCp(liquidState);
    cpVapor = SteamWater.specificHeatCapacityCp(vaporState);
    alphaLiquid = LiquidWater.isobaricExpansionCoefficient(liquidState);
    alphaVapor = SteamWater.isobaricExpansionCoefficient(vaporState);
    kappaLiquid = LiquidWater.isothermalCompressibility(liquidState);
    kappaVapor = SteamWater.isothermalCompressibility(vaporState);
    rhoLp = liquidDensityKgM3*kappaLiquid;
    rhoLT = -liquidDensityKgM3*alphaLiquid;
    rhoVp = vaporDensityKgM3*kappaVapor;
    rhoVT = -vaporDensityKgM3*alphaVapor;
    // State order is p, V_l, T_l, T_v. Internal interface work is -p*dV_l
    // for liquid and +p*dV_l for vapor, and cancels for the rigid vessel.
    massLiquid = {liquidVolumeM3*rhoLp,liquidDensityKgM3,liquidVolumeM3*rhoLT,0};
    massVapor = {(volumeM3-liquidVolumeM3)*rhoVp,-vaporDensityKgM3,0,(volumeM3-liquidVolumeM3)*rhoVT};
    energyLiquid = {liquidVolumeM3*(rhoLp*liquidInternalEnergy+pressurePa*kappaLiquid-liquidTemperatureK*alphaLiquid),liquidDensityKgM3*liquidInternalEnergy,
      liquidVolumeM3*(liquidDensityKgM3*cpLiquid+rhoLT*liquidInternalEnergy-pressurePa*alphaLiquid),0};
    energyVapor = {(volumeM3-liquidVolumeM3)*(rhoVp*vaporInternalEnergy+pressurePa*kappaVapor-vaporTemperatureK*alphaVapor),-vaporDensityKgM3*vaporInternalEnergy,
      0,(volumeM3-liquidVolumeM3)*(vaporDensityKgM3*cpVapor+rhoVT*vaporInternalEnergy-pressurePa*alphaVapor)};
    bulkEvaporationKgS = noEvent(max(0,liquidMassKg*(liquidEnthalpyJkg-liquidSatH)/(latentHeat*phaseRelaxationTimeS)));
    bulkCondensationKgS = noEvent(max(0,vaporMassKg*(vaporSatH-vaporEnthalpyJkg)/(latentHeat*phaseRelaxationTimeS)));
    phaseEnergyW = bulkEvaporationKgS*vaporSatH-bulkCondensationKgS*liquidSatH;
    interfacialHeatW = interfacialConductanceWK*(vaporTemperatureK-liquidTemperatureK);
    surgePowerW = noEvent(surgeFlowKgS*(if surgeFlowKgS>=0 then surgeEnthalpyJkg else liquidEnthalpyJkg));
    vaporHeightM = max(0.01,vesselHeightM-liquidLevelM);
    for i in 1:wallSegments loop
      wettedFraction[i] = noEvent(min(1,max(0,(liquidLevelM-(i-1)*cellHeightM)/cellHeightM)));
      filmDeltaT[i] = noEvent(max(0,saturationTemperatureK-innerWallTemperatureK[i]));
      // Bound property evaluation during nonlinear trial iterates. This is inactive
      // for accepted wall temperatures inside the declared validity envelope.
      filmState[i] = PrimaryWater.setState_pT(pressurePa,noEvent(max(273.15,min(saturationTemperatureK-0.01,(saturationTemperatureK+innerWallTemperatureK[i])/2))));
      // Nusselt gravity-film correlation, 0.943 coefficient; no multiplier is
      // tuned to either plant or PACTEL pressure. Finite 0.1 K regularization
      // affects only the zero-heat-flux limit. Cylindrical curvature is neglected.
      filmCoefficient[i] = 0.943*(Modelica.Constants.g_n*PrimaryWater.density(filmState[i])*
        (PrimaryWater.density(filmState[i])-Water.dewDensity(sat))*PrimaryWater.thermalConductivity(filmState[i])^3*latentHeat/
        (PrimaryWater.dynamicViscosity(filmState[i])*vaporHeightM*max(0.1,filmDeltaT[i])))^0.25;
      wallFilmPowerW[i] = if includeWall then filmCoefficient[i]*2*Modelica.Constants.pi*innerRadiusM*cellHeightM*(1-wettedFraction[i])*filmDeltaT[i] else 0;
      wallCondensation[i] = wallFilmPowerW[i]/max(1e5,vaporEnthalpyJkg-liquidSatH);
      wallLiquidPowerW[i] = if includeWall then liquidWallHeatTransferWm2K*2*Modelica.Constants.pi*innerRadiusM*cellHeightM*wettedFraction[i]*(liquidTemperatureK-innerWallTemperatureK[i]) else 0;
      wallVaporPowerW[i] = if includeWall then vaporWallHeatTransferWm2K*2*Modelica.Constants.pi*innerRadiusM*cellHeightM*(1-wettedFraction[i])*noEvent(min(0,vaporTemperatureK-innerWallTemperatureK[i])) else 0;
      wallAmbientPowerW[i] = if includeWall then externalHeatTransferWm2K*2*Modelica.Constants.pi*(innerRadiusM+wallThicknessM)*cellHeightM*(outerWallTemperatureK[i]-ambientTemperatureK) else 0;
      wallRadialPowerW[i,1] = wallLiquidPowerW[i]+wallVaporPowerW[i]+wallFilmPowerW[i];
      wallRadialPowerW[i,wallRadialCells+1] = wallAmbientPowerW[i];
      if includeWall and resolveWallFaces then
        wallRadialPowerW[i,1] = 2*Modelica.Constants.pi*cellHeightM*
          (conductivityIntegral(innerWallTemperatureK[i],useTemperatureDependentSteel,wallConductivityWMK)-wallConductivityPotential[i,1])/log(wallCenterRadiusM[1]/innerRadiusM);
        wallRadialPowerW[i,wallRadialCells+1] = 2*Modelica.Constants.pi*cellHeightM*
          (wallConductivityPotential[i,wallRadialCells]-conductivityIntegral(outerWallTemperatureK[i],useTemperatureDependentSteel,wallConductivityWMK))/log((innerRadiusM+wallThicknessM)/wallCenterRadiusM[wallRadialCells]);
      else
        innerWallTemperatureK[i] = wallTemperatureK[i,1];
        outerWallTemperatureK[i] = wallTemperatureK[i,wallRadialCells];
      end if;
      for j in 1:wallRadialCells-1 loop
        wallRadialPowerW[i,j+1] = if includeWall then 2*Modelica.Constants.pi*cellHeightM*
          (wallConductivityPotential[i,j]-wallConductivityPotential[i,j+1])/log(wallCenterRadiusM[j+1]/wallCenterRadiusM[j]) else 0;
      end for;
      for j in 1:wallRadialCells loop
        wallCellCapacityJK[i,j] = wallCellMassKg[j]*solidHeatCapacity(wallTemperatureK[i,j],useTemperatureDependentSteel,wallHeatCapacityJKgK);
        wallConductivityPotential[i,j] = conductivityIntegral(wallTemperatureK[i,j],useTemperatureDependentSteel,wallConductivityWMK);
        wallAxialPowerW[i,j] = if includeWall then Modelica.Constants.pi*(wallRadiusM[j+1]^2-wallRadiusM[j]^2)/cellHeightM*((if i>1 then wallConductivityPotential[i-1,j]-wallConductivityPotential[i,j] else 0)+(if i<wallSegments then wallConductivityPotential[i+1,j]-wallConductivityPotential[i,j] else 0)) else 0;
        wallCellCapacityJK[i,j]*der(wallTemperatureK[i,j]) = wallRadialPowerW[i,j]-wallRadialPowerW[i,j+1]+wallAxialPowerW[i,j];
      end for;
    end for;
    A[1,:] = massLiquid .* {1e6,1,1,1};
    A[2,:] = massVapor .* {1e6,1,1,1};
    A[3,:] = (energyLiquid+{0,pressurePa,0,0}) .* {1e6,1,1,1}/1e6;
    A[4,:] = (energyVapor-{0,pressurePa,0,0}) .* {1e6,1,1,1}/1e6;
    rhs = {surgeFlowKgS+sprayFlowKgS-bulkEvaporationKgS+bulkCondensationKgS+wallCondensationKgS,
      bulkEvaporationKgS-bulkCondensationKgS-wallCondensationKgS,
      (surgePowerW+sprayFlowKgS*sprayEnthalpyJkg+heaterPowerMW*1e6-ambientHeatLossW+interfacialHeatW-sum(wallLiquidPowerW)-phaseEnergyW+wallCondensationKgS*liquidSatH)/1e6,
      (phaseEnergyW-interfacialHeatW-sum(wallVaporPowerW)-wallCondensationKgS*vaporEnthalpyJkg)/1e6};
    for row in 1:4 loop
      A[row,1]*pressureRate/1e6+A[row,2]*volumeRate+A[row,3]*liquidTemperatureRate+A[row,4]*vaporTemperatureRate = rhs[row];
    end for;
    der(pressurePa) = pressureRate;
    der(liquidVolumeM3) = volumeRate;
    der(liquidTemperatureK) = liquidTemperatureRate;
    der(vaporTemperatureK) = vaporTemperatureRate;
    massRateKgS = (massLiquid[1]+massVapor[1])*pressureRate+(massLiquid[2]+massVapor[2])*volumeRate
      +massLiquid[3]*liquidTemperatureRate+massVapor[4]*vaporTemperatureRate;
    fluidEnergyRateW = (energyLiquid[1]+energyVapor[1])*pressureRate+(energyLiquid[2]+energyVapor[2])*volumeRate
      +energyLiquid[3]*liquidTemperatureRate+energyVapor[4]*vaporTemperatureRate;
    massResidualKgS = massRateKgS-boundaryMassFlowKgS;
    energyResidualMW = (fluidEnergyRateW+(if includeWall then sum(wallCellCapacityJK[i,j]*der(wallTemperatureK[i,j]) for i in 1:wallSegments,j in 1:wallRadialCells) else 0))/1e6-boundaryPowerMW;
    der(integratedBoundaryMassKg) = boundaryMassFlowKgS;
    der(integratedBoundaryEnergyMJ) = boundaryPowerMW;
    valid = pressurePa>1e6 and pressurePa<19e6 and liquidVolumeM3>0.01*volumeM3 and liquidVolumeM3<0.99*volumeM3
      and (pressurePa<16.5291643e6 or (vaporTemperatureK>=623.15 and pressurePa<Modelica.Media.Water.IF97_Utilities.BaseIF97.Regions.boundary23ofT(vaporTemperatureK)))
      and liquidTemperatureK>373.15 and liquidTemperatureK<623.15 and liquidTemperatureK<saturationTemperatureK+2
      and vaporTemperatureK>saturationTemperatureK-2 and vaporTemperatureK<800
      and sprayFlowKgS>=0 and phaseRelaxationTimeS>0 and min(wallCellCapacityJK)>0
      and (not includeWall or not useTemperatureDependentSteel or (min(wallTemperatureK)>=273.15 and max(wallTemperatureK)<=1073.15 and min(innerWallTemperatureK)>=273.15 and max(innerWallTemperatureK)<=1073.15 and min(outerWallTemperatureK)>=273.15 and max(outerWallTemperatureK)<=1073.15));
  end DynamicPressurizer;

  model PrimaryLoop "Two primary volumes with selectable equilibrium or dynamic pressurizer"
    parameter Boolean useDynamicPressurizer = false "Structural choice; compile a distinct FMU for the two-temperature formulation";
    parameter Real pressurizerPhaseRelaxationTimeS = 0.1;
    parameter Real pressurizerInterfacialConductanceWK = 0 "Unidentified plant interface transfer; adiabatic bulk interface assumption";
    parameter Real initialPressurePa = 15.5e6;
    parameter Real initialHotTemperatureK = 598.15;
    parameter Real initialColdTemperatureK = 563.15;
    parameter Real initialFuelTemperatureK = 873.15;
    parameter Real hotVolumeM3 = 150;
    parameter Real coldVolumeM3 = 150;
    parameter Real pressurizerVolumeM3 = 50;
    parameter Real initialLiquidVolumeM3 = 25;
    parameter Real fuelCapacityJK = 60e6;
    parameter Real nominalThermalPowerW = 3000e6;
    parameter Real nominalPumpHeatW = 0 "External pump heat deposited in cold coolant; zero preserves the generic case";
    parameter Real nominalSteamTemperatureK = 549.15;
    parameter Real pumpHeadPa = 0.6e6;
    parameter Real pumpTimeConstantS = 7;
    parameter Real flowTimeConstantS = 4;
    parameter Real elevationM = 10;
    parameter Real chargingTemperatureK = 323.15;
    parameter Real ambientHeatLossW = 0 "Adiabatic pressurizer reference case";
    parameter Real hotEnthalpy0 = PrimaryWater.specificEnthalpy_pT(initialPressurePa, initialHotTemperatureK);
    parameter Real coldEnthalpy0 = PrimaryWater.specificEnthalpy_pT(initialPressurePa, initialColdTemperatureK);
    parameter Real nominalFlowKgS = nominalThermalPowerW / (hotEnthalpy0 - coldEnthalpy0);
    parameter Real nominalBuoyancyPa = Modelica.Constants.g_n * elevationM *
      (PrimaryWater.density_pT(initialPressurePa, initialColdTemperatureK) - PrimaryWater.density_pT(initialPressurePa, initialHotTemperatureK));
    parameter Real hydraulicResistance = (pumpHeadPa + nominalBuoyancyPa) / nominalFlowKgS^2;
    parameter Real hydraulicInertia = 2 * hydraulicResistance * nominalFlowKgS * flowTimeConstantS;
    parameter Real fuelConductanceWK = nominalThermalPowerW / (initialFuelTemperatureK - initialHotTemperatureK);
    parameter Real steamGeneratorConductanceWK = (nominalThermalPowerW + nominalPumpHeatW) / (initialColdTemperatureK - nominalSteamTemperatureK);

    input Real reactorPowerMW(min=0, max=3300, start=3000) "Prescribed fuel heat input, not neutron kinetics";
    input Real pumpCommand(min=0, max=1, start=1);
    input Real steamTemperatureC(min=240, max=300, start=276) "Prescribed secondary thermal boundary";
    input Real heaterPowerMW(min=0, max=3, start=0);
    input Real sprayFlowKgS(min=0, max=30, start=0) "Internal transfer from cold leg to pressurizer";
    input Real chargingFlowKgS(min=0, max=10, start=0) "External water at chargingTemperatureK";
    input Real letdownFlowKgS(min=0, max=10, start=0) "External discharge from cold leg";

    output Real hotLegTemperatureC;
    output Real coldLegTemperatureC;
    output Real fuelTemperatureC;
    output Real primaryPressureMPa;
    output Real pressurizerLevelPercent;
    output Real primaryFlowKgS(start=nominalFlowKgS, fixed=true, stateSelect=StateSelect.always);
    output Real pumpSpeed(start=1, fixed=true, stateSelect=StateSelect.always);
    output Real heatToSteamMW;
    output Real thermalEnergyMJ;
    output Real pressurizerMassKg;
    output Real pressurizerEnergyMJ;
    output Real energyResidualMW;
    output Real massResidualKgS;
    output Boolean valid;
    output Real primaryMassKg;
    output Real totalMassKg;
    output Real surgeFlowKgS "Positive from hot leg into pressurizer";
    output Real pressurizerTemperatureC;
    output Real liquidMassKg;
    output Real vaporMassKg;
    output Real storedEnergyRateMW;
    output Real boundaryPowerMW;
    output Real boundaryMassFlowKgS;
    output Real integratedBoundaryEnergyMJ(start=0, fixed=true);
    output Real integratedBoundaryMassKg(start=0, fixed=true);
    output Real primarySubcoolingK;
    output Real nominalPrimaryFlowKgS = nominalFlowKgS;
    output Real pumpHeatMW = nominalPumpHeatW * pumpSpeed^3 / 1e6 "Assumed speed-cubed dissipation; boundary work, not core power";
    output Real pressurizerLiquidTemperatureC;
    output Real pressurizerVaporTemperatureC;
    output Real coldLegEnthalpyJkg = hCold;
    output Real chargingEnthalpyJkg = chargingEnthalpy;

    DynamicPressurizer dynamicPressurizer(
      volumeM3=pressurizerVolumeM3,
      initialPressurePa=initialPressurePa,
      initialLiquidVolumeM3=initialLiquidVolumeM3,
      initializePressure=false,
      phaseRelaxationTimeS=pressurizerPhaseRelaxationTimeS,
      interfacialConductanceWK=pressurizerInterfacialConductanceWK,
      ambientHeatLossW=ambientHeatLossW) if useDynamicPressurizer;

  protected
    Real pressurePa(start=initialPressurePa, fixed=true, nominal=1e6, stateSelect=StateSelect.always);
    Real liquidVolumeM3(start=initialLiquidVolumeM3, fixed=not useDynamicPressurizer, nominal=25, stateSelect=StateSelect.prefer);
    Real hotTemperatureK(start=initialHotTemperatureK, fixed=true, nominal=500, stateSelect=StateSelect.always);
    Real coldTemperatureK(start=initialColdTemperatureK, fixed=true, nominal=500, stateSelect=StateSelect.always);
    Real fuelTemperatureK(start=initialFuelTemperatureK, fixed=true, nominal=873, stateSelect=StateSelect.always);
    PrimaryWater.ThermodynamicState hotState;
    PrimaryWater.ThermodynamicState coldState;
    Water.SaturationProperties saturation;
    Real rhoHot;
    Real rhoCold;
    Real hHot;
    Real hCold;
    Real uHot;
    Real uCold;
    Real cpHot;
    Real cpCold;
    Real alphaHot;
    Real alphaCold;
    Real kappaHot;
    Real kappaCold;
    Real rhoLiquid;
    Real rhoVapor;
    Real hLiquid;
    Real hVapor;
    Real rhoLiquidDerivative;
    Real rhoVaporDerivative;
    Real hLiquidDerivative;
    Real hVaporDerivative;
    Real hotMass;
    Real coldMass;
    Real hotMassRate;
    Real coldMassRate;
    Real hotEnergyJ;
    Real coldEnergyJ;
    Real pressurizerEnergyJ;
    Real hotEnergyRateW;
    Real coldEnergyRateW;
    Real pressurizerEnergyRateW;
    Real pressurizerMassRate;
    Real massPressureDerivative;
    Real massVolumeDerivative;
    Real energyPressureDerivative;
    Real energyVolumeDerivative;
    Real flowToColdKgS;
    Real coldToHotPowerW;
    Real hotToColdPowerW;
    Real surgePowerW;
    Real heatToCoolantW;
    Real heatToSteamW;
    Real chargingEnthalpy;
    Real buoyancyPa;
    Real pressureRate;
    Real liquidVolumeRate;
    Real hotTemperatureRate;
    Real coldTemperatureRate;
    Real hotMassCoefficients[4];
    Real coldMassCoefficients[4];
    Real hotEnergyCoefficients[4];
    Real coldEnergyCoefficients[4];
    Boolean pressurizerValid;

  equation
    hotState = PrimaryWater.setState_pT(pressurePa, hotTemperatureK);
    coldState = PrimaryWater.setState_pT(pressurePa, coldTemperatureK);
    saturation = Water.setSat_p(pressurePa);
    rhoHot = PrimaryWater.density(hotState);
    rhoCold = PrimaryWater.density(coldState);
    hHot = PrimaryWater.specificEnthalpy(hotState);
    hCold = PrimaryWater.specificEnthalpy(coldState);
    uHot = PrimaryWater.specificInternalEnergy(hotState);
    uCold = PrimaryWater.specificInternalEnergy(coldState);
    cpHot = PrimaryWater.specificHeatCapacityCp(hotState);
    cpCold = PrimaryWater.specificHeatCapacityCp(coldState);
    alphaHot = PrimaryWater.isobaricExpansionCoefficient(hotState);
    alphaCold = PrimaryWater.isobaricExpansionCoefficient(coldState);
    kappaHot = PrimaryWater.isothermalCompressibility(hotState);
    kappaCold = PrimaryWater.isothermalCompressibility(coldState);
    if useDynamicPressurizer then
      rhoLiquid = dynamicPressurizer.liquidDensityKgM3;
      rhoVapor = dynamicPressurizer.vaporDensityKgM3;
      hLiquid = dynamicPressurizer.liquidEnthalpyJkg;
      hVapor = dynamicPressurizer.vaporEnthalpyJkg;
    else
      rhoLiquid = Water.bubbleDensity(saturation);
      rhoVapor = Water.dewDensity(saturation);
      hLiquid = Water.bubbleEnthalpy(saturation);
      hVapor = Water.dewEnthalpy(saturation);
    end if;
    rhoLiquidDerivative = Water.dBubbleDensity_dPressure(saturation);
    rhoVaporDerivative = Water.dDewDensity_dPressure(saturation);
    hLiquidDerivative = Water.dBubbleEnthalpy_dPressure(saturation);
    hVaporDerivative = Water.dDewEnthalpy_dPressure(saturation);

    // Exact fixed-volume mass and internal-energy differentials for single-phase
    // water: rho_p=rho*kappa, rho_T=-rho*alpha,
    // u_p=(p*kappa-T*alpha)/rho, u_T=cp-p*alpha/rho.
    hotMass = hotVolumeM3 * rhoHot;
    coldMass = coldVolumeM3 * rhoCold;
    hotMassRate = hotMass * (kappaHot * der(pressurePa) - alphaHot * der(hotTemperatureK));
    coldMassRate = coldMass * (kappaCold * der(pressurePa) - alphaCold * der(coldTemperatureK));
    hotEnergyJ = hotMass * uHot;
    coldEnergyJ = coldMass * uCold;
    hotEnergyRateW = hotVolumeM3 * ((rhoHot * kappaHot * uHot + pressurePa * kappaHot - hotTemperatureK * alphaHot) * der(pressurePa)
      + (rhoHot * cpHot - rhoHot * alphaHot * uHot - pressurePa * alphaHot) * der(hotTemperatureK));
    coldEnergyRateW = coldVolumeM3 * ((rhoCold * kappaCold * uCold + pressurePa * kappaCold - coldTemperatureK * alphaCold) * der(pressurePa)
      + (rhoCold * cpCold - rhoCold * alphaCold * uCold - pressurePa * alphaCold) * der(coldTemperatureK));

    // Fixed total pressurizer volume, with distinct saturated phase inventories.
    liquidMassKg = liquidVolumeM3 * rhoLiquid;
    vaporMassKg = (pressurizerVolumeM3 - liquidVolumeM3) * rhoVapor;
    pressurizerMassKg = liquidMassKg + vaporMassKg;
    pressurizerEnergyJ = liquidMassKg * hLiquid + vaporMassKg * hVapor - pressurePa * pressurizerVolumeM3;
    massPressureDerivative = liquidVolumeM3 * rhoLiquidDerivative + (pressurizerVolumeM3 - liquidVolumeM3) * rhoVaporDerivative;
    massVolumeDerivative = rhoLiquid - rhoVapor;
    energyPressureDerivative = liquidVolumeM3 * (rhoLiquidDerivative * hLiquid + rhoLiquid * hLiquidDerivative)
      + (pressurizerVolumeM3 - liquidVolumeM3) * (rhoVaporDerivative * hVapor + rhoVapor * hVaporDerivative) - pressurizerVolumeM3;
    energyVolumeDerivative = rhoLiquid * hLiquid - rhoVapor * hVapor;
    if useDynamicPressurizer then
      pressurizerMassRate = dynamicPressurizer.massRateKgS;
      pressurizerEnergyRateW = dynamicPressurizer.fluidEnergyRateW;
    else
      pressurizerMassRate = massPressureDerivative * der(pressurePa) + massVolumeDerivative * der(liquidVolumeM3);
      pressurizerEnergyRateW = energyPressureDerivative * der(pressurePa) + energyVolumeDerivative * der(liquidVolumeM3);
    end if;

    // A closed circulation path; expansion/compression and external inventory
    // inputs determine surge. Spray is an internal cold-leg transfer.
    flowToColdKgS = primaryFlowKgS + coldMassRate + sprayFlowKgS - chargingFlowKgS + letdownFlowKgS;
    surgeFlowKgS = -hotMassRate - coldMassRate - sprayFlowKgS + chargingFlowKgS - letdownFlowKgS;
    coldToHotPowerW = noEvent(if primaryFlowKgS >= 0 then primaryFlowKgS * hCold else primaryFlowKgS * hHot);
    hotToColdPowerW = noEvent(if flowToColdKgS >= 0 then flowToColdKgS * hHot else flowToColdKgS * hCold);
    surgePowerW = noEvent(if surgeFlowKgS >= 0 then surgeFlowKgS * hHot else surgeFlowKgS * hLiquid);
    chargingEnthalpy = PrimaryWater.specificEnthalpy_pT(pressurePa, chargingTemperatureK);

    heatToCoolantW = fuelConductanceWK * (fuelTemperatureK - hotTemperatureK);
    heatToSteamW = steamGeneratorConductanceWK * (coldTemperatureK - steamTemperatureC - 273.15);
    fuelCapacityJK * der(fuelTemperatureK) = reactorPowerMW * 1e6 - heatToCoolantW;
    hotMassCoefficients = {hotMass*kappaHot, 0, -hotMass*alphaHot, 0};
    coldMassCoefficients = {coldMass*kappaCold, 0, 0, -coldMass*alphaCold};
    hotEnergyCoefficients = {hotVolumeM3*(rhoHot*kappaHot*uHot + pressurePa*kappaHot - hotTemperatureK*alphaHot),
      0, hotVolumeM3*(rhoHot*cpHot - rhoHot*alphaHot*uHot - pressurePa*alphaHot), 0};
    coldEnergyCoefficients = {coldVolumeM3*(rhoCold*kappaCold*uCold + pressurePa*kappaCold - coldTemperatureK*alphaCold),
      0, 0, coldVolumeM3*(rhoCold*cpCold - rhoCold*alphaCold*uCold - pressurePa*alphaCold)};
    if useDynamicPressurizer then
      pressurePa = dynamicPressurizer.pressurePa;
      liquidVolumeM3 = dynamicPressurizer.liquidVolumeM3;
      dynamicPressurizer.surgeFlowKgS = surgeFlowKgS;
      dynamicPressurizer.surgeEnthalpyJkg = hHot;
      dynamicPressurizer.sprayFlowKgS = sprayFlowKgS;
      dynamicPressurizer.sprayEnthalpyJkg = hCold;
      dynamicPressurizer.heaterPowerMW = heaterPowerMW;
      hotEnergyRateW/1e6 = (heatToCoolantW+coldToHotPowerW-hotToColdPowerW-surgePowerW)/1e6;
      coldEnergyRateW/1e6 = (hotToColdPowerW-coldToHotPowerW-heatToSteamW+pumpHeatMW*1e6-sprayFlowKgS*hCold+chargingFlowKgS*chargingEnthalpy-letdownFlowKgS*hCold)/1e6;
    else
      (pressureRate, liquidVolumeRate, hotTemperatureRate, coldTemperatureRate) = balanceRates(hotMassCoefficients, coldMassCoefficients, hotEnergyCoefficients, coldEnergyCoefficients,
        {massPressureDerivative, massVolumeDerivative, 0, 0}, {energyPressureDerivative, energyVolumeDerivative, 0, 0},
        hHot, hCold, hLiquid, chargingEnthalpy, primaryFlowKgS, heatToCoolantW, heatToSteamW, pumpHeatMW*1e6,
        sprayFlowKgS, chargingFlowKgS, letdownFlowKgS, heaterPowerMW*1e6, ambientHeatLossW);
    end if;
    der(pressurePa) = pressureRate;
    der(liquidVolumeM3) = liquidVolumeRate;
    der(hotTemperatureK) = hotTemperatureRate;
    der(coldTemperatureK) = coldTemperatureRate;

    // Generic momentum balance, including natural-circulation buoyancy. Pump
    // electrical consumption and distributed pressure-loss work are not solved.
    // Configured pump heat is an explicit external thermal boundary contribution.
    der(pumpSpeed) = (pumpCommand - pumpSpeed) / pumpTimeConstantS;
    buoyancyPa = Modelica.Constants.g_n * elevationM * (rhoCold - rhoHot);
    hydraulicInertia * der(primaryFlowKgS) = pumpHeadPa * pumpSpeed^2 + buoyancyPa
      - hydraulicResistance * primaryFlowKgS * abs(primaryFlowKgS);

    hotLegTemperatureC = hotTemperatureK - 273.15;
    coldLegTemperatureC = coldTemperatureK - 273.15;
    fuelTemperatureC = fuelTemperatureK - 273.15;
    primaryPressureMPa = pressurePa / 1e6;
    pressurizerLevelPercent = 100 * liquidVolumeM3 / pressurizerVolumeM3;
    pressurizerTemperatureC = Water.saturationTemperature(pressurePa) - 273.15;
    if useDynamicPressurizer then
      pressurizerLiquidTemperatureC = dynamicPressurizer.liquidTemperatureK-273.15;
      pressurizerVaporTemperatureC = dynamicPressurizer.vaporTemperatureK-273.15;
      pressurizerValid = dynamicPressurizer.valid;
    else
      pressurizerLiquidTemperatureC = pressurizerTemperatureC;
      pressurizerVaporTemperatureC = pressurizerTemperatureC;
      pressurizerValid = true;
    end if;
    primarySubcoolingK = Water.saturationTemperature(pressurePa) - max(hotTemperatureK, coldTemperatureK);
    heatToSteamMW = heatToSteamW / 1e6;
    primaryMassKg = hotMass + coldMass;
    totalMassKg = primaryMassKg + pressurizerMassKg;
    pressurizerEnergyMJ = pressurizerEnergyJ / 1e6;
    thermalEnergyMJ = (fuelCapacityJK * (fuelTemperatureK - 273.15) + hotEnergyJ + coldEnergyJ + pressurizerEnergyJ) / 1e6;
    storedEnergyRateMW = (fuelCapacityJK * der(fuelTemperatureK) + hotEnergyRateW + coldEnergyRateW + pressurizerEnergyRateW) / 1e6;
    boundaryPowerMW = reactorPowerMW + pumpHeatMW + heaterPowerMW - heatToSteamMW
      + (chargingFlowKgS * chargingEnthalpy - letdownFlowKgS * hCold - ambientHeatLossW) / 1e6;
    boundaryMassFlowKgS = chargingFlowKgS - letdownFlowKgS;
    energyResidualMW = storedEnergyRateMW - boundaryPowerMW;
    massResidualKgS = hotMassRate + coldMassRate + pressurizerMassRate - boundaryMassFlowKgS;
    der(integratedBoundaryEnergyMJ) = boundaryPowerMW;
    der(integratedBoundaryMassKg) = boundaryMassFlowKgS;
    valid = pressurePa > 8e6 and pressurePa < 19e6 and primarySubcoolingK > 3
      and liquidVolumeM3 > 0.05*pressurizerVolumeM3 and liquidVolumeM3 < 0.95*pressurizerVolumeM3
      and hotTemperatureK > 473.15 and hotTemperatureK < 613.15
      and coldTemperatureK > 473.15 and coldTemperatureK < 603.15
      and fuelTemperatureK > 473.15 and fuelTemperatureK < 1173.15
      and primaryFlowKgS > 0 and primaryFlowKgS < 2 * nominalFlowKgS and flowToColdKgS > 0
      and reactorPowerMW >= 0 and reactorPowerMW <= 3300
      and pumpCommand >= 0 and pumpCommand <= 1
      and steamTemperatureC >= 240 and steamTemperatureC <= 300
      and heaterPowerMW >= 0 and heaterPowerMW <= 3
      and sprayFlowKgS >= 0 and sprayFlowKgS <= 30
      and chargingFlowKgS >= 0 and chargingFlowKgS <= 10
      and letdownFlowKgS >= 0 and letdownFlowKgS <= 10
      and pressurizerValid;
    annotation(experiment(StartTime=0, StopTime=300, Tolerance=1e-7, Interval=0.1),
      Documentation(info="<html><p>Generic hot-primary-system experiment. Prescribed reactor heat and secondary temperature; no neutron kinetics, turbine, secondary inventory, or real plant protection. IF97 primary properties and saturated liquid/vapor pressurizer balances are coupled through mass and energy conservation. See docs/MODELICA_MODEL.md.</p></html>"));
  end PrimaryLoop;

  model SteamGenerator "Fixed-volume saturated secondary inventory with explicit mass and energy balances"
    parameter Real initialPressurePa = Water.saturationPressure(549.15);
    parameter Real volumeM3 = 400;
    parameter Real initialLiquidVolumeM3 = 200;
    input Real heatInputMW(start=3000);
    input Real feedwaterFlowKgS(start=1150);
    input Real feedwaterEnthalpyJkg(start=112000);
    input Real steamFlowKgS(start=1150);
    output Real pressurePa(start=initialPressurePa, fixed=true, nominal=1e6, stateSelect=StateSelect.always);
    output Real liquidVolumeM3(start=initialLiquidVolumeM3, fixed=true, nominal=200, stateSelect=StateSelect.always);
    output Real pressureMPa = pressurePa / 1e6;
    output Real temperatureC = Water.saturationTemperature(pressurePa) - 273.15;
    output Real levelPercent = 100 * liquidVolumeM3 / volumeM3;
    output Real massKg;
    output Real energyMJ;
    output Real steamEnthalpyJkg;
    output Real energyResidualMW;
    output Real massResidualKgS;
    output Boolean valid;
  protected
    Water.SaturationProperties sat;
    Real rl;
    Real rv;
    Real hl;
    Real hv;
    Real mp;
    Real mv;
    Real up;
    Real uv;
    Real massRate;
    Real energyRate;
    Real determinant;
  equation
    sat = Water.setSat_p(pressurePa);
    rl = Water.bubbleDensity(sat);
    rv = Water.dewDensity(sat);
    hl = Water.bubbleEnthalpy(sat);
    hv = Water.dewEnthalpy(sat);
    massKg = liquidVolumeM3 * rl + (volumeM3 - liquidVolumeM3) * rv;
    energyMJ = (liquidVolumeM3 * rl * hl + (volumeM3 - liquidVolumeM3) * rv * hv - pressurePa * volumeM3) / 1e6;
    steamEnthalpyJkg = hv;
    mp = liquidVolumeM3 * Water.dBubbleDensity_dPressure(sat) + (volumeM3 - liquidVolumeM3) * Water.dDewDensity_dPressure(sat);
    mv = rl - rv;
    up = liquidVolumeM3 * (Water.dBubbleDensity_dPressure(sat) * hl + rl * Water.dBubbleEnthalpy_dPressure(sat))
      + (volumeM3 - liquidVolumeM3) * (Water.dDewDensity_dPressure(sat) * hv + rv * Water.dDewEnthalpy_dPressure(sat)) - volumeM3;
    uv = rl * hl - rv * hv;
    massRate = feedwaterFlowKgS - steamFlowKgS;
    energyRate = heatInputMW * 1e6 + feedwaterFlowKgS * feedwaterEnthalpyJkg - steamFlowKgS * hv;
    determinant = mp * uv - mv * up;
    der(pressurePa) = (massRate * uv - energyRate * mv) / determinant;
    der(liquidVolumeM3) = (mp * energyRate - up * massRate) / determinant;
    massResidualKgS = mp * der(pressurePa) + mv * der(liquidVolumeM3) - massRate;
    energyResidualMW = (up * der(pressurePa) + uv * der(liquidVolumeM3) - energyRate) / 1e6;
    valid = pressurePa > 1e6 and pressurePa < 12e6 and liquidVolumeM3 > 0.05 * volumeM3
      and liquidVolumeM3 < 0.95 * volumeM3 and feedwaterFlowKgS >= 0 and steamFlowKgS >= 0;
  end SteamGenerator;

  model ReactorKinetics "Six-group point kinetics with separately labeled illustrative decay-heat inventories"
    parameter Real beta[6] = {0.000215,0.001424,0.001274,0.002568,0.000748,0.000273};
    parameter Real lambda[6] = {0.0124,0.0305,0.111,0.301,1.14,3.01};
    parameter Real generationTimeS = 1e-4;
    parameter Real nominalThermalPowerMW = 3000;
    parameter Real decayFraction[6] = {0.012,0.014,0.016,0.012,0.008,0.004};
    parameter Real decayTimeS[6] = {1,5,25,150,1000,10000};
    input Real reactivityPcm(start=0);
    output Real neutronPowerFraction(start=1, fixed=true, nominal=1, stateSelect=StateSelect.always);
    output Real precursors[6](each start=1, each fixed=true, each nominal=1);
    output Real decayInventory[6](start=decayFraction, each fixed=true);
    output Real fissionPowerMW = nominalThermalPowerMW * (1 - sum(decayFraction)) * neutronPowerFraction;
    output Real decayHeatMW = nominalThermalPowerMW * sum(decayInventory);
    output Real reactorPowerMW = fissionPowerMW + decayHeatMW;
  equation
    der(neutronPowerFraction) = ((reactivityPcm * 1e-5 - sum(beta)) * neutronPowerFraction + sum(beta .* precursors)) / generationTimeS;
    for i in 1:6 loop
      der(precursors[i]) = lambda[i] * (neutronPowerFraction - precursors[i]);
      der(decayInventory[i]) = (decayFraction[i] * neutronPowerFraction - decayInventory[i]) / decayTimeS[i];
    end for;
  end ReactorKinetics;

  model KineticsReference "Isolated native kinetics kernel for independent exponential benchmarks"
    extends ReactorKinetics;
    output Real precursor1 = precursors[1];
    output Real precursor2 = precursors[2];
    output Real precursor3 = precursors[3];
    output Real precursor4 = precursors[4];
    output Real precursor5 = precursors[5];
    output Real precursor6 = precursors[6];
    output Boolean valid = neutronPowerFraction >= 0 and neutronPowerFraction < 100
      and reactivityPcm > -10000 and reactivityPcm < 500;
    annotation(experiment(StartTime=0, StopTime=20, Tolerance=1e-9, Interval=0.05));
  end KineticsReference;

  model AuxiliaryFeedwater "Finite open tank and two generic motor-driven auxiliary-feedwater trains"
    // Original generic engineering model; dimensions/setpoints are assumptions,
    // not a named plant's safety-system design or operating procedure.
    function forwardRoot "C1 forward-only square root; regularized near check-valve opening"
      input Real x;
      input Real delta = .01;
      output Real y;
    algorithm
      y := smooth(1,noEvent(if x <= 0 then 0 else if x < delta then
        sqrt(delta)*(x/delta)^2*(2.5-1.5*x/delta) else sqrt(max(delta,x))));
    end forwardRoot;
    parameter Real initialTankMassKg = 100000;
    parameter Real tankCapacityKg = 100000;
    parameter Real reserveMassKg = 1000 "Unusable suction heel; no mass-state clipping at cutoff";
    parameter Real tankPressurePa = 101325;
    parameter Real initialTankTemperatureK = 298.15;
    parameter Real nominalTrainFlowKgS = 60;
    parameter Real referenceDeliveryPressurePa = 6e6;
    parameter Real pumpShutoffPressurePa = 10e6 "Full-speed pump pressure rise; quadratic generic curve";
    parameter Real pumpTimeConstantS = 2;
    parameter Real hydraulicEfficiency = .75;
    parameter Real motorEfficiency = .95;
    parameter Real idleMotorLossMW = .005;
    parameter Real autoLowLevelPercent = 40;
    parameter Real isolationHighLevelPercent = 85;
    parameter Real nominalMainFeedwaterKgS = 1100;
    input Real deliveryPressurePa(start=6e6);
    input Real secondaryLevelPercent(start=50);
    input Real mainFeedwaterFlowKgS(start=1100);
    input Real steamFlowKgS(start=1100);
    input Real automaticEnable(start=1);
    input Real pumpACommand(start=0);
    input Real pumpBCommand(start=0);
    input Real pumpAAvailable(start=1);
    input Real pumpBAvailable(start=1);
    input Real valveAOpen(start=1);
    input Real valveBOpen(start=1);
    output Real tankMassKg(start=initialTankMassKg,fixed=true,nominal=100000);
    output Real tankLevelPercent = 100*tankMassKg/tankCapacityKg;
    output Real tankTemperatureC = initialTankTemperatureK-273.15
      "Uniform adiabatic withdrawal at constant atmospheric pressure leaves liquid temperature unchanged";
    output Real tankEnergyMJ = tankMassKg*tankInternalEnergyJkg/1e6;
    output Real tankEnergyRateMW = -flowKgS*tankInternalEnergyJkg/1e6;
    output Real pumpASpeed(start=0,fixed=true);
    output Real pumpBSpeed(start=0,fixed=true);
    output Real trainAFlowKgS;
    output Real trainBFlowKgS;
    output Real flowKgS = trainAFlowKgS+trainBFlowKgS;
    output Real feedwaterEnthalpyJkg = tankEnthalpyJkg+pumpWorkJkg;
    output Real pumpFluidPowerMW = flowKgS*pumpWorkJkg/1e6;
    output Real motorLossMW = pumpFluidPowerMW*(1/motorEfficiency-1)
      + idleMotorLossMW*(pumpASpeed^3+pumpBSpeed^3);
    output Real pumpPowerMW = pumpFluidPowerMW+motorLossMW;
    output Real tankDisplacementPowerMW = tankPressurePa*der(tankMassKg)/tankDensityKgM3/1e6
      "Signed outward liquid-surface work; negative while atmosphere does work on draining liquid";
    output Real autoActuated = if automaticDemand then 1 else 0;
    output Real tankDepleted = if suctionLost then 1 else 0;
    output Real energyResidualMW = tankEnergyRateMW + flowKgS*feedwaterEnthalpyJkg/1e6
      - (pumpPowerMW-motorLossMW-tankDisplacementPowerMW);
    output Real massResidualKgS = der(tankMassKg)+flowKgS;
    output Boolean valid = tankMassKg >= 0 and tankMassKg <= tankCapacityKg*1.001
      and initialTankTemperatureK >= 278.15 and initialTankTemperatureK <= 353.15
      and deliveryPressurePa >= tankPressurePa and deliveryPressurePa < 12e6
      and reserveMassKg > 0 and reserveMassKg < initialTankMassKg and initialTankMassKg <= tankCapacityKg
      and hydraulicEfficiency > 0 and hydraulicEfficiency <= 1 and motorEfficiency > 0 and motorEfficiency <= 1
      and pumpASpeed >= -1e-6 and pumpASpeed <= 1.000001 and pumpBSpeed >= -1e-6 and pumpBSpeed <= 1.000001
      and automaticEnable >= 0 and automaticEnable <= 1 and pumpAAvailable >= 0 and pumpAAvailable <= 1
      and pumpBAvailable >= 0 and pumpBAvailable <= 1 and valveAOpen >= 0 and valveAOpen <= 1
      and valveBOpen >= 0 and valveBOpen <= 1 and pumpACommand >= 0 and pumpACommand <= 1
      and pumpBCommand >= 0 and pumpBCommand <= 1;
  protected
    parameter PrimaryWater.ThermodynamicState tankState = PrimaryWater.setState_pT(tankPressurePa,initialTankTemperatureK);
    parameter Real tankDensityKgM3 = PrimaryWater.density(tankState);
    parameter Real tankEnthalpyJkg = PrimaryWater.specificEnthalpy(tankState);
    parameter Real tankInternalEnergyJkg = PrimaryWater.specificInternalEnergy(tankState);
    discrete Boolean automaticDemand(start=false,fixed=true);
    discrete Boolean suctionLost(start=false,fixed=true);
    Real pressureRisePa;
    Real pumpWorkJkg;
    Real pumpATarget;
    Real pumpBTarget;
    Boolean deliveryPermitted;
  equation
    when automaticEnable > .5 and (secondaryLevelPercent < autoLowLevelPercent
      or (mainFeedwaterFlowKgS < .1*nominalMainFeedwaterKgS and steamFlowKgS > .1*nominalMainFeedwaterKgS)) then
      automaticDemand = true;
    end when;
    when tankMassKg <= reserveMassKg then
      suctionLost = true;
    end when;
    pumpATarget = if pumpAAvailable > .5 and not suctionLost then max(pumpACommand,
      if automaticEnable > .5 and automaticDemand then 1 else 0) else 0;
    pumpBTarget = if pumpBAvailable > .5 and not suctionLost then max(pumpBCommand,
      if automaticEnable > .5 and automaticDemand then 1 else 0) else 0;
    der(pumpASpeed) = (pumpATarget-pumpASpeed)/pumpTimeConstantS;
    der(pumpBSpeed) = (pumpBTarget-pumpBSpeed)/pumpTimeConstantS;
    pressureRisePa = max(0,deliveryPressurePa-tankPressurePa);
    pumpWorkJkg = pressureRisePa/(tankDensityKgM3*hydraulicEfficiency);
    deliveryPermitted = not suctionLost and secondaryLevelPercent < isolationHighLevelPercent;
    trainAFlowKgS = if deliveryPermitted and valveAOpen > .5 then nominalTrainFlowKgS*
      forwardRoot((pumpShutoffPressurePa*pumpASpeed^2-pressureRisePa)/
      (pumpShutoffPressurePa-referenceDeliveryPressurePa+tankPressurePa)) else 0;
    trainBFlowKgS = if deliveryPermitted and valveBOpen > .5 then nominalTrainFlowKgS*
      forwardRoot((pumpShutoffPressurePa*pumpBSpeed^2-pressureRisePa)/
      (pumpShutoffPressurePa-referenceDeliveryPressurePa+tankPressurePa)) else 0;
    der(tankMassKg) = -flowKgS;
  end AuxiliaryFeedwater;

  model CoupledPlant "Hot coupled kinetics, primary, steam generator and Rankine-cycle laboratory"
    parameter Real nominalThermalPowerMW = 3000;
    parameter Real nominalNetPowerMW = 1000;
    parameter Real nominalSteamTemperatureK = 549.15;
    parameter Real initialCondenserTemperatureK = 298.15;
    parameter Real coolingWaterTemperatureK = 288.15;
    parameter Real initialCondenserMassKg = 500000;
    parameter Real auxInitialTankMassKg = 100000;
    parameter Real nominalAuxiliaryPowerMW = 50;
    parameter Real generatorEfficiency = 0.985;
    parameter Real feedPumpEfficiency = 0.8;
    parameter Real nominalShaftFrictionMW = 2;
    parameter Real nominalRotorEnergyMJ = 4200;
    parameter Real nominalSecondaryPressurePa = Water.saturationPressure(nominalSteamTemperatureK);
    parameter Real nominalCondenserPressurePa = Water.saturationPressure(initialCondenserTemperatureK);
    parameter Real nominalSteamEnthalpyJkg = Water.dewEnthalpy(Water.setSat_p(nominalSecondaryPressurePa));
    parameter Real nominalCondensateEnthalpyJkg = Water.bubbleEnthalpy(Water.setSat_p(nominalCondenserPressurePa));
    parameter Real nominalCondensateDensity = Water.bubbleDensity(Water.setSat_p(nominalCondenserPressurePa));
    parameter Real nominalPumpWorkJkg = (nominalSecondaryPressurePa - nominalCondenserPressurePa) / (nominalCondensateDensity * feedPumpEfficiency);
    parameter Real nominalSteamFlowKgS = nominalThermalPowerMW * 1e6 / (nominalSteamEnthalpyJkg - nominalCondensateEnthalpyJkg - nominalPumpWorkJkg);
    parameter Real nominalFeedPumpPowerMW = nominalSteamFlowKgS * nominalPumpWorkJkg / 1e6;
    parameter Real nominalIsentropicDropJkg = nominalSteamEnthalpyJkg - Water.isentropicEnthalpy(nominalCondenserPressurePa,
      Water.setState_ph(nominalSecondaryPressurePa, nominalSteamEnthalpyJkg, 2));
    parameter Real turbineEfficiency = ((nominalNetPowerMW + nominalAuxiliaryPowerMW) / generatorEfficiency + nominalShaftFrictionMW)
      * 1e6 / (nominalSteamFlowKgS * nominalIsentropicDropJkg)
      "Effective efficiency calibrated to the assumed nominal point, not a turbine map";
    parameter Real nominalCoolingPowerMW = nominalThermalPowerMW + nominalFeedPumpPowerMW
      - (nominalNetPowerMW + nominalAuxiliaryPowerMW) / generatorEfficiency - nominalShaftFrictionMW;
    parameter Real condenserConductanceWK = nominalCoolingPowerMW * 1e6 / (initialCondenserTemperatureK - coolingWaterTemperatureK);

    input Real reactorDemandPercent(min=50,max=105,start=100);
    input Real loadDemandMW(min=0,max=1000,start=1000);
    input Real reactivityCommandPcm(min=-300,max=300,start=0);
    input Real turbineValveFraction(min=0,max=1.2,start=1);
    input Real feedwaterFraction(min=0,max=1.2,start=1);
    input Real coolingFraction(min=0,max=1.2,start=1);
    input Real pumpCommand(min=0,max=1,start=1);
    input Real tripCommand(min=0,max=1,start=0);
    input Real turbineTripCommand(min=0,max=1,start=0);
    input Real gridBreakerCommand(min=0,max=1,start=1);
    input Real heaterPowerMW(min=0,max=3,start=0);
    input Real sprayFlowKgS(min=0,max=30,start=0);
    input Real chargingFlowKgS(min=0,max=10,start=0);
    input Real letdownFlowKgS(min=0,max=10,start=0);

    input Real auxAutoEnable(min=0,max=1,start=1);
    input Real auxPumpACommand(min=0,max=1,start=0);
    input Real auxPumpBCommand(min=0,max=1,start=0);
    input Real auxPumpAAvailable(min=0,max=1,start=1);
    input Real auxPumpBAvailable(min=0,max=1,start=1);
    input Real auxValveAOpen(min=0,max=1,start=1);
    input Real auxValveBOpen(min=0,max=1,start=1);

    PrimaryLoop primary(nominalThermalPowerW=nominalThermalPowerMW*1e6, nominalSteamTemperatureK=nominalSteamTemperatureK);
    SteamGenerator secondary(initialPressurePa=nominalSecondaryPressurePa);
    ReactorKinetics core(nominalThermalPowerMW=nominalThermalPowerMW);
    AuxiliaryFeedwater auxiliary(initialTankMassKg=auxInitialTankMassKg,
      referenceDeliveryPressurePa=nominalSecondaryPressurePa,nominalMainFeedwaterKgS=nominalSteamFlowKgS);
    output Real hotLegTemperatureC = primary.hotLegTemperatureC;
    output Real coldLegTemperatureC = primary.coldLegTemperatureC;
    output Real fuelTemperatureC = primary.fuelTemperatureC;
    output Real primaryPressureMPa = primary.primaryPressureMPa;
    output Real pressurizerLevelPercent = primary.pressurizerLevelPercent;
    output Real primaryFlowKgS = primary.primaryFlowKgS;
    output Real pumpSpeed = primary.pumpSpeed;
    output Real heatToSteamMW = primary.heatToSteamMW;
    output Real thermalEnergyMJ = primary.thermalEnergyMJ;
    output Real pressurizerMassKg = primary.pressurizerMassKg;
    output Real pressurizerEnergyMJ = primary.pressurizerEnergyMJ;
    output Real energyResidualMW = primary.energyResidualMW;
    output Real massResidualKgS = primary.massResidualKgS;
    output Real totalMassKg = primary.totalMassKg;
    output Real boundaryMassFlowKgS = primary.boundaryMassFlowKgS;
    output Real boundaryPowerMW = primary.boundaryPowerMW;
    output Real integratedBoundaryMassKg = primary.integratedBoundaryMassKg;
    output Real integratedBoundaryEnergyMJ = primary.integratedBoundaryEnergyMJ;
    output Real surgeFlowKgS = primary.surgeFlowKgS;
    output Real primarySubcoolingK = primary.primarySubcoolingK;
    output Real liquidMassKg = primary.liquidMassKg;
    output Real vaporMassKg = primary.vaporMassKg;
    output Real reactorPowerMW = core.reactorPowerMW;
    output Real fissionPowerMW = core.fissionPowerMW;
    output Real decayHeatMW = core.decayHeatMW;
    output Real reactivityPcm;
    output Real secondaryPressureMPa = secondary.pressureMPa;
    output Real secondaryTemperatureC = secondary.temperatureC;
    output Real secondaryLevelPercent = secondary.levelPercent;
    output Real secondaryMassKg = secondary.massKg;
    output Real turbineFlowKgS;
    output Real bypassFlowKgS;
    output Real feedwaterFlowKgS(start=nominalSteamFlowKgS,fixed=true);
    output Real mainFeedwaterFlowKgS = feedwaterFlowKgS;
    output Real totalFeedwaterFlowKgS = feedwaterFlowKgS+auxFeedwaterFlowKgS;
    output Real auxFeedwaterFlowKgS = auxiliary.flowKgS;
    output Real auxTrainAFlowKgS = auxiliary.trainAFlowKgS;
    output Real auxTrainBFlowKgS = auxiliary.trainBFlowKgS;
    output Real auxPumpASpeed = auxiliary.pumpASpeed;
    output Real auxPumpBSpeed = auxiliary.pumpBSpeed;
    output Real auxTankMassKg = auxiliary.tankMassKg;
    output Real auxTankLevelPercent = auxiliary.tankLevelPercent;
    output Real auxTankTemperatureC = auxiliary.tankTemperatureC;
    output Real auxTankEnergyMJ = auxiliary.tankEnergyMJ;
    output Real auxPumpPowerMW = auxiliary.pumpPowerMW;
    output Real auxPumpFluidPowerMW = auxiliary.pumpFluidPowerMW;
    output Real auxMotorLossMW = auxiliary.motorLossMW;
    output Real auxTankDisplacementPowerMW = auxiliary.tankDisplacementPowerMW;
    output Real auxFeedwaterEnthalpyJkg = auxiliary.feedwaterEnthalpyJkg;
    output Real auxAutoActuated = auxiliary.autoActuated;
    output Real auxTankDepleted = auxiliary.tankDepleted;
    output Real turbineRpm;
    output Real grossPowerMW;
    output Real netPowerMW;
    output Real condenserPressureKPa;
    output Real condenserTemperatureC;
    output Real coolingPowerMW;
    output Real feedwaterTemperatureC;
    output Real reactorTripped = if reactorTrip then 1 else 0;
    output Real turbineTripped = if turbineTrip then 1 else 0;
    output Real gridConnected = if connected then 1 else 0;
    output Real totalPlantStoredEnergyMJ;
    output Real totalPlantMassKg;
    output Real plantBoundaryPowerMW;
    output Real plantBoundaryMassFlowKgS;
    output Real integratedPlantBoundaryEnergyMJ(start=0,fixed=true);
    output Real integratedPlantBoundaryMassKg(start=0,fixed=true);
    output Real plantEnergyResidualMW;
    output Real plantMassResidualKgS;
    output Boolean valid;
    output Real feedPumpPowerMW;
    output Real generatorLossMW;
    output Real shaftFrictionMW;
    output Real condenserMassKg(start=initialCondenserMassKg,fixed=true,nominal=500000);
    output Real condenserEnergyMJ;
    output Real condenserDisplacementPowerMW "Moving liquid-surface pressure work into the unmodeled steam space";
    output Real rotorEnergyMJ(start=nominalRotorEnergyMJ,fixed=true,nominal=4200);
    output Real turbineMechanicalPowerMW;
    output Real neutronPowerFraction = core.neutronPowerFraction;

  protected
    discrete Boolean reactorTrip(start=false,fixed=true);
    discrete Boolean turbineTrip(start=false,fixed=true);
    Boolean connected;
    Real rodReactivityPcm(start=0,fixed=true);
    Real turbineValve(start=1,fixed=true);
    Real bypassValve(start=0,fixed=true);
    Real turbineValveTarget;
    Real bypassValveTarget;
    Real feedwaterTarget;
    Real condenserPressurePa(start=nominalCondenserPressurePa,fixed=true,nominal=10000,stateSelect=StateSelect.always);
    Water.SaturationProperties condenserSat;
    Water.ThermodynamicState steamState;
    Real condenserDensity;
    Real condenserEnthalpy;
    Real condenserInternalEnergy;
    Real condenserInternalEnergyDerivative;
    Real condenserEnergyRateW;
    Real condenserMassRate;
    Real feedwaterEnthalpy;
    Real mixedFeedwaterEnthalpy;
    Real pumpWorkJkg;
    Real specificTurbineWorkJkg;
    Real exhaustEnthalpy;
    Real shaftElectricalPowerMW;
    Real secondaryEnergyRateMW;
    Real thermalFeedbackPcm;
  equation
    primary.reactorPowerMW = reactorPowerMW;
    primary.steamTemperatureC = secondaryTemperatureC;
    primary.pumpCommand = pumpCommand;
    primary.heaterPowerMW = heaterPowerMW;
    primary.sprayFlowKgS = sprayFlowKgS;
    primary.chargingFlowKgS = chargingFlowKgS;
    primary.letdownFlowKgS = letdownFlowKgS;
    thermalFeedbackPcm = -2 * (fuelTemperatureC - 600) - 20 * ((hotLegTemperatureC + coldLegTemperatureC) / 2 - 307.5);
    der(rodReactivityPcm) = if reactorTrip then 0 else noEvent(max(-5,min(5,40*(reactorDemandPercent/100-core.neutronPowerFraction))));
    reactivityPcm = (if reactorTrip then -6000 else rodReactivityPcm + reactivityCommandPcm) + thermalFeedbackPcm;
    core.reactivityPcm = reactivityPcm;

    when tripCommand > 0.5 or turbineTripCommand > 0.5 or core.neutronPowerFraction > 1.1
      or primaryPressureMPa > 17.2 or primaryPressureMPa < 12.5 or primaryFlowKgS < 0.6 * primary.nominalFlowKgS
      or secondaryLevelPercent < 20 or secondaryLevelPercent > 90 or condenserPressureKPa > 20 or turbineRpm > 3300 then
      reactorTrip = true;
    end when;
    when reactorTrip or turbineTripCommand > 0.5 or turbineRpm > 3300 then
      turbineTrip = true;
    end when;
    connected = gridBreakerCommand > 0.5 and not turbineTrip and turbineRpm >= 2950 and turbineRpm <= 3050;
    turbineValveTarget = if turbineTrip then 0 else noEvent(max(0,min(1.2,turbineValveFraction *
      ((loadDemandMW + nominalAuxiliaryPowerMW) / (nominalNetPowerMW + nominalAuxiliaryPowerMW) + 3 * (secondary.pressurePa / nominalSecondaryPressurePa - 1)))));
    der(turbineValve) = (turbineValveTarget - turbineValve) / 0.5;
    bypassValveTarget = noEvent(max(0,min(1.2,(if turbineTrip then 1 else 0) + 20 * (secondary.pressurePa / nominalSecondaryPressurePa - 1))));
    der(bypassValve) = (bypassValveTarget - bypassValve) / 0.5;
    turbineFlowKgS = nominalSteamFlowKgS * turbineValve * secondary.pressurePa / nominalSecondaryPressurePa
      * sqrt(nominalSteamTemperatureK / (secondaryTemperatureC + 273.15));
    bypassFlowKgS = nominalSteamFlowKgS * bypassValve * secondary.pressurePa / nominalSecondaryPressurePa
      * sqrt(nominalSteamTemperatureK / (secondaryTemperatureC + 273.15));
    feedwaterTarget = noEvent(max(0,min(1.5*nominalSteamFlowKgS,feedwaterFraction *
      (turbineFlowKgS + bypassFlowKgS + 30*(50-secondaryLevelPercent)))));
    der(feedwaterFlowKgS) = (feedwaterTarget - feedwaterFlowKgS) / 2;
    secondary.heatInputMW = heatToSteamMW;
    auxiliary.deliveryPressurePa = secondary.pressurePa;
    auxiliary.secondaryLevelPercent = secondaryLevelPercent;
    auxiliary.mainFeedwaterFlowKgS = feedwaterFlowKgS;
    auxiliary.steamFlowKgS = turbineFlowKgS+bypassFlowKgS;
    auxiliary.automaticEnable = auxAutoEnable;
    auxiliary.pumpACommand = auxPumpACommand;
    auxiliary.pumpBCommand = auxPumpBCommand;
    auxiliary.pumpAAvailable = auxPumpAAvailable;
    auxiliary.pumpBAvailable = auxPumpBAvailable;
    auxiliary.valveAOpen = auxValveAOpen;
    auxiliary.valveBOpen = auxValveBOpen;
    mixedFeedwaterEnthalpy = if noEvent(totalFeedwaterFlowKgS > 1e-6) then
      (feedwaterFlowKgS*feedwaterEnthalpy+auxFeedwaterFlowKgS*auxFeedwaterEnthalpyJkg)/totalFeedwaterFlowKgS
      else feedwaterEnthalpy;
    secondary.feedwaterFlowKgS = totalFeedwaterFlowKgS;
    secondary.feedwaterEnthalpyJkg = mixedFeedwaterEnthalpy;
    secondary.steamFlowKgS = turbineFlowKgS + bypassFlowKgS;

    condenserSat = Water.setSat_p(condenserPressurePa);
    condenserDensity = Water.bubbleDensity(condenserSat);
    condenserEnthalpy = Water.bubbleEnthalpy(condenserSat);
    condenserInternalEnergy = condenserEnthalpy - condenserPressurePa / condenserDensity;
    condenserInternalEnergyDerivative = Water.dBubbleEnthalpy_dPressure(condenserSat) - 1/condenserDensity
      + condenserPressurePa * Water.dBubbleDensity_dPressure(condenserSat) / condenserDensity^2;
    pumpWorkJkg = (secondary.pressurePa - condenserPressurePa) / (condenserDensity * feedPumpEfficiency);
    feedwaterEnthalpy = condenserEnthalpy + pumpWorkJkg;
    feedwaterTemperatureC = Water.temperature(Water.setState_ph(secondary.pressurePa,mixedFeedwaterEnthalpy,1)) - 273.15;
    feedPumpPowerMW = feedwaterFlowKgS * pumpWorkJkg / 1e6;
    steamState = Water.setState_ph(secondary.pressurePa,secondary.steamEnthalpyJkg,2);
    specificTurbineWorkJkg = turbineEfficiency * (secondary.steamEnthalpyJkg - Water.isentropicEnthalpy(condenserPressurePa,steamState));
    turbineMechanicalPowerMW = turbineFlowKgS * specificTurbineWorkJkg / 1e6;
    exhaustEnthalpy = secondary.steamEnthalpyJkg - specificTurbineWorkJkg;
    turbineRpm = 3000 * sqrt(noEvent(max(0,rotorEnergyMJ)) / nominalRotorEnergyMJ);
    shaftFrictionMW = nominalShaftFrictionMW * (turbineRpm/3000)^3;
    shaftElectricalPowerMW = if connected then noEvent(max(0,turbineMechanicalPowerMW-shaftFrictionMW+(rotorEnergyMJ-nominalRotorEnergyMJ))) else 0;
    der(rotorEnergyMJ) = turbineMechanicalPowerMW - shaftFrictionMW - shaftElectricalPowerMW;
    grossPowerMW = generatorEfficiency * shaftElectricalPowerMW;
    generatorLossMW = shaftElectricalPowerMW - grossPowerMW;
    netPowerMW = grossPowerMW - (nominalAuxiliaryPowerMW - nominalFeedPumpPowerMW) - feedPumpPowerMW - auxPumpPowerMW;
    condenserTemperatureC = Water.saturationTemperature(condenserPressurePa) - 273.15;
    condenserPressureKPa = condenserPressurePa / 1000;
    coolingPowerMW = coolingFraction * condenserConductanceWK * (condenserTemperatureC + 273.15 - coolingWaterTemperatureK) / 1e6;
    condenserMassRate = turbineFlowKgS + bypassFlowKgS - feedwaterFlowKgS;
    condenserEnergyRateW = turbineFlowKgS * exhaustEnthalpy + bypassFlowKgS * secondary.steamEnthalpyJkg
      - feedwaterFlowKgS * condenserEnthalpy - coolingPowerMW * 1e6 - condenserDisplacementPowerMW * 1e6;
    der(condenserMassKg) = condenserMassRate;
    der(condenserPressurePa) = (turbineFlowKgS * exhaustEnthalpy + bypassFlowKgS * secondary.steamEnthalpyJkg
      - feedwaterFlowKgS * condenserEnthalpy - coolingPowerMW * 1e6 - condenserEnthalpy * condenserMassRate)
      / (condenserMassKg * (Water.dBubbleEnthalpy_dPressure(condenserSat) - 1/condenserDensity));
    condenserDisplacementPowerMW = condenserPressurePa * (der(condenserMassKg)/condenserDensity
      - condenserMassKg * Water.dBubbleDensity_dPressure(condenserSat) * der(condenserPressurePa)/condenserDensity^2) / 1e6;
    condenserEnergyMJ = condenserMassKg * condenserInternalEnergy / 1e6;

    totalPlantStoredEnergyMJ = primary.thermalEnergyMJ + secondary.energyMJ + condenserEnergyMJ + rotorEnergyMJ + auxTankEnergyMJ;
    totalPlantMassKg = primary.totalMassKg + secondary.massKg + condenserMassKg + auxTankMassKg;
    plantBoundaryPowerMW = primary.boundaryPowerMW + heatToSteamMW + feedPumpPowerMW
      + auxPumpPowerMW-auxMotorLossMW-auxTankDisplacementPowerMW
      - coolingPowerMW - grossPowerMW - generatorLossMW - shaftFrictionMW - condenserDisplacementPowerMW;
    plantBoundaryMassFlowKgS = primary.boundaryMassFlowKgS;
    der(integratedPlantBoundaryEnergyMJ) = plantBoundaryPowerMW;
    der(integratedPlantBoundaryMassKg) = plantBoundaryMassFlowKgS;
    secondaryEnergyRateMW = heatToSteamMW + (feedwaterFlowKgS * feedwaterEnthalpy+auxFeedwaterFlowKgS*auxFeedwaterEnthalpyJkg
      - (turbineFlowKgS+bypassFlowKgS) * secondary.steamEnthalpyJkg) / 1e6;
    plantEnergyResidualMW = primary.storedEnergyRateMW + secondaryEnergyRateMW + secondary.energyResidualMW
      + (condenserInternalEnergy * der(condenserMassKg) + condenserMassKg * condenserInternalEnergyDerivative * der(condenserPressurePa))/1e6
      + der(rotorEnergyMJ) + auxiliary.tankEnergyRateMW - plantBoundaryPowerMW;
    plantMassResidualKgS = primary.massResidualKgS + secondary.massResidualKgS + condenserMassRate
      + totalFeedwaterFlowKgS - turbineFlowKgS - bypassFlowKgS + der(auxiliary.tankMassKg);
    valid = primary.valid and secondary.valid and auxiliary.valid and reactorPowerMW >= 0 and reactorPowerMW <= 3300
      and core.neutronPowerFraction >= 0 and core.neutronPowerFraction < 1.2
      and secondaryTemperatureC >= 240 and secondaryTemperatureC <= 300
      and condenserPressurePa > 800 and condenserPressurePa < 30000
      and condenserMassKg > 50000 and condenserMassKg < 1000000 and rotorEnergyMJ >= 0 and turbineRpm < 3600
      and turbineEfficiency > 0 and turbineEfficiency <= 1 and abs(rodReactivityPcm) < 3000
      and reactorDemandPercent >= 50 and reactorDemandPercent <= 105 and loadDemandMW >= 0 and loadDemandMW <= 1000
      and reactivityCommandPcm >= -300 and reactivityCommandPcm <= 300
      and turbineValveFraction >= 0 and turbineValveFraction <= 1.2 and feedwaterFraction >= 0 and feedwaterFraction <= 1.2
      and coolingFraction >= 0 and coolingFraction <= 1.2 and tripCommand >= 0 and tripCommand <= 1
      and turbineTripCommand >= 0 and turbineTripCommand <= 1 and gridBreakerCommand >= 0 and gridBreakerCommand <= 1;
    annotation(experiment(StartTime=0,StopTime=300,Tolerance=1e-7,Interval=0.05));
  end CoupledPlant;

  model PropertyReferenceChecks "Native IF97 observations for published tables and differential checks"
    input Real probePressurePa(start=15.5e6) "Property probe independent of PrimaryLoop validity envelope";
    input Real probeTemperatureK(start=598.15);
    input Real probeWallTemperatureK(start=550);
    output Real wallSteelCpJKgK = DynamicPressurizer.solidHeatCapacity(probeWallTemperatureK,true,500);
    output Real wallSteelEnthalpyJKg = DynamicPressurizer.solidEnthalpy(probeWallTemperatureK,true,500);
    output Real wallSteelConductivityPotentialWM = DynamicPressurizer.conductivityIntegral(probeWallTemperatureK,true,15);
    output Real wallConstantCpJKgK = DynamicPressurizer.solidHeatCapacity(probeWallTemperatureK,false,500);
    output Real wallConstantEnthalpyJKg = DynamicPressurizer.solidEnthalpy(probeWallTemperatureK,false,500);
    output Real wallConstantConductivityPotentialWM = DynamicPressurizer.conductivityIntegral(probeWallTemperatureK,false,15);
    PrimaryWater.ThermodynamicState probeState = PrimaryWater.setState_pT(probePressurePa, probeTemperatureK);
    output Real probeDensityKgM3 = PrimaryWater.density(probeState);
    output Real probeSpecificVolumeM3Kg = 1 / probeDensityKgM3;
    output Real probeEnthalpyKJkg = PrimaryWater.specificEnthalpy(probeState) / 1000;
    output Real probeInternalEnergyKJkg = PrimaryWater.specificInternalEnergy(probeState) / 1000;
    output Real probeCpKJkgK = PrimaryWater.specificHeatCapacityCp(probeState) / 1000;
    output Real probeExpansionPerK = PrimaryWater.isobaricExpansionCoefficient(probeState);
    output Real probeCompressibilityPerPa = PrimaryWater.isothermalCompressibility(probeState);
    output Real pressure20MPa = Water.saturationPressure(293.15) / 1e6;
    output Real liquidEnthalpy20KJkg = Water.bubbleEnthalpy(Water.setSat_T(293.15)) / 1000;
    output Real vaporEnthalpy20KJkg = Water.dewEnthalpy(Water.setSat_T(293.15)) / 1000;
    output Real pressure100MPa = Water.saturationPressure(373.15) / 1e6;
    output Real liquidEnthalpy100KJkg = Water.bubbleEnthalpy(Water.setSat_T(373.15)) / 1000;
    output Real vaporEnthalpy100KJkg = Water.dewEnthalpy(Water.setSat_T(373.15)) / 1000;
    output Real pressure200MPa = Water.saturationPressure(473.15) / 1e6;
    output Real liquidEnthalpy200KJkg = Water.bubbleEnthalpy(Water.setSat_T(473.15)) / 1000;
    output Real vaporEnthalpy200KJkg = Water.dewEnthalpy(Water.setSat_T(473.15)) / 1000;
    output Real pressure300MPa = Water.saturationPressure(573.15) / 1e6;
    output Real liquidEnthalpy300KJkg = Water.bubbleEnthalpy(Water.setSat_T(573.15)) / 1000;
    output Real vaporEnthalpy300KJkg = Water.dewEnthalpy(Water.setSat_T(573.15)) / 1000;
    annotation(experiment(StartTime=0, StopTime=1, Interval=1));
  end PropertyReferenceChecks;

  annotation(uses(Modelica(version="4.0.0")), version="0.6.0",
    Documentation(info="<html><p>Original OpenPWR engineering workbench models, Apache-2.0. Requires Modelica Standard Library 4.0.0 under its own BSD-3-Clause license.</p></html>"));
end OpenPWR;
