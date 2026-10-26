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
        circulation * (hHot - hCold) - cs * hHot - steamHeat - spray * hCold + charging * hCharging - letdown * hCold,
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

  model PrimaryLoop "Two primary volumes coupled to an equilibrium pressurizer"
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
    parameter Real steamGeneratorConductanceWK = nominalThermalPowerW / (initialColdTemperatureK - nominalSteamTemperatureK);

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
    output Real primaryFlowKgS(start=nominalFlowKgS, fixed=true);
    output Real pumpSpeed(start=1, fixed=true);
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

  protected
    Real pressurePa(start=initialPressurePa, fixed=true, nominal=1e6, stateSelect=StateSelect.always);
    Real liquidVolumeM3(start=initialLiquidVolumeM3, fixed=true, nominal=25, stateSelect=StateSelect.always);
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
    rhoLiquid = Water.bubbleDensity(saturation);
    rhoVapor = Water.dewDensity(saturation);
    hLiquid = Water.bubbleEnthalpy(saturation);
    hVapor = Water.dewEnthalpy(saturation);
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
    pressurizerMassRate = massPressureDerivative * der(pressurePa) + massVolumeDerivative * der(liquidVolumeM3);
    pressurizerEnergyRateW = energyPressureDerivative * der(pressurePa) + energyVolumeDerivative * der(liquidVolumeM3);

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
    (pressureRate, liquidVolumeRate, hotTemperatureRate, coldTemperatureRate) = balanceRates(hotMassCoefficients, coldMassCoefficients, hotEnergyCoefficients, coldEnergyCoefficients,
      {massPressureDerivative, massVolumeDerivative, 0, 0}, {energyPressureDerivative, energyVolumeDerivative, 0, 0},
      hHot, hCold, hLiquid, chargingEnthalpy, primaryFlowKgS, heatToCoolantW, heatToSteamW,
      sprayFlowKgS, chargingFlowKgS, letdownFlowKgS, heaterPowerMW*1e6, ambientHeatLossW);
    der(pressurePa) = pressureRate;
    der(liquidVolumeM3) = liquidVolumeRate;
    der(hotTemperatureK) = hotTemperatureRate;
    der(coldTemperatureK) = coldTemperatureRate;

    // Generic momentum balance, including natural-circulation buoyancy. Pump
    // electrical consumption, pump heating, and distributed pressure loss are
    // outside this thermal subsystem's energy boundary.
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
    primarySubcoolingK = Water.saturationTemperature(pressurePa) - max(hotTemperatureK, coldTemperatureK);
    heatToSteamMW = heatToSteamW / 1e6;
    primaryMassKg = hotMass + coldMass;
    totalMassKg = primaryMassKg + pressurizerMassKg;
    pressurizerEnergyMJ = pressurizerEnergyJ / 1e6;
    thermalEnergyMJ = (fuelCapacityJK * (fuelTemperatureK - 273.15) + hotEnergyJ + coldEnergyJ + pressurizerEnergyJ) / 1e6;
    storedEnergyRateMW = (fuelCapacityJK * der(fuelTemperatureK) + hotEnergyRateW + coldEnergyRateW + pressurizerEnergyRateW) / 1e6;
    boundaryPowerMW = reactorPowerMW + heaterPowerMW - heatToSteamMW
      + (chargingFlowKgS * chargingEnthalpy - letdownFlowKgS * hCold - ambientHeatLossW) / 1e6;
    boundaryMassFlowKgS = chargingFlowKgS - letdownFlowKgS;
    energyResidualMW = storedEnergyRateMW - boundaryPowerMW;
    massResidualKgS = hotMassRate + coldMassRate + pressurizerMassRate - boundaryMassFlowKgS;
    der(integratedBoundaryEnergyMJ) = boundaryPowerMW;
    der(integratedBoundaryMassKg) = boundaryMassFlowKgS;
    valid = pressurePa > 8e6 and pressurePa < 19e6 and primarySubcoolingK > 3
      and liquidVolumeM3 > 2.5 and liquidVolumeM3 < pressurizerVolumeM3 - 2.5
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
      and letdownFlowKgS >= 0 and letdownFlowKgS <= 10;
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

  model CoupledPlant "Hot coupled kinetics, primary, steam generator and Rankine-cycle laboratory"
    parameter Real nominalThermalPowerMW = 3000;
    parameter Real nominalNetPowerMW = 1000;
    parameter Real nominalSteamTemperatureK = 549.15;
    parameter Real initialCondenserTemperatureK = 298.15;
    parameter Real coolingWaterTemperatureK = 288.15;
    parameter Real initialCondenserMassKg = 500000;
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

    PrimaryLoop primary(nominalThermalPowerW=nominalThermalPowerMW*1e6, nominalSteamTemperatureK=nominalSteamTemperatureK);
    SteamGenerator secondary(initialPressurePa=nominalSecondaryPressurePa);
    ReactorKinetics core(nominalThermalPowerMW=nominalThermalPowerMW);
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
    secondary.feedwaterFlowKgS = feedwaterFlowKgS;
    secondary.feedwaterEnthalpyJkg = feedwaterEnthalpy;
    secondary.steamFlowKgS = turbineFlowKgS + bypassFlowKgS;

    condenserSat = Water.setSat_p(condenserPressurePa);
    condenserDensity = Water.bubbleDensity(condenserSat);
    condenserEnthalpy = Water.bubbleEnthalpy(condenserSat);
    condenserInternalEnergy = condenserEnthalpy - condenserPressurePa / condenserDensity;
    condenserInternalEnergyDerivative = Water.dBubbleEnthalpy_dPressure(condenserSat) - 1/condenserDensity
      + condenserPressurePa * Water.dBubbleDensity_dPressure(condenserSat) / condenserDensity^2;
    pumpWorkJkg = (secondary.pressurePa - condenserPressurePa) / (condenserDensity * feedPumpEfficiency);
    feedwaterEnthalpy = condenserEnthalpy + pumpWorkJkg;
    feedwaterTemperatureC = Water.temperature(Water.setState_ph(secondary.pressurePa,feedwaterEnthalpy,1)) - 273.15;
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
    netPowerMW = grossPowerMW - (nominalAuxiliaryPowerMW - nominalFeedPumpPowerMW) - feedPumpPowerMW;
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

    totalPlantStoredEnergyMJ = primary.thermalEnergyMJ + secondary.energyMJ + condenserEnergyMJ + rotorEnergyMJ;
    totalPlantMassKg = primary.totalMassKg + secondary.massKg + condenserMassKg;
    plantBoundaryPowerMW = primary.boundaryPowerMW + heatToSteamMW + feedPumpPowerMW
      - coolingPowerMW - grossPowerMW - generatorLossMW - shaftFrictionMW - condenserDisplacementPowerMW;
    plantBoundaryMassFlowKgS = primary.boundaryMassFlowKgS;
    der(integratedPlantBoundaryEnergyMJ) = plantBoundaryPowerMW;
    der(integratedPlantBoundaryMassKg) = plantBoundaryMassFlowKgS;
    secondaryEnergyRateMW = heatToSteamMW + (feedwaterFlowKgS * feedwaterEnthalpy
      - (turbineFlowKgS+bypassFlowKgS) * secondary.steamEnthalpyJkg) / 1e6;
    plantEnergyResidualMW = primary.storedEnergyRateMW + secondaryEnergyRateMW + secondary.energyResidualMW
      + (condenserInternalEnergy * der(condenserMassKg) + condenserMassKg * condenserInternalEnergyDerivative * der(condenserPressurePa))/1e6
      + der(rotorEnergyMJ) - plantBoundaryPowerMW;
    plantMassResidualKgS = primary.massResidualKgS + secondary.massResidualKgS + condenserMassRate
      + feedwaterFlowKgS - turbineFlowKgS - bypassFlowKgS;
    valid = primary.valid and secondary.valid and reactorPowerMW >= 0 and reactorPowerMW <= 3300
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

  annotation(uses(Modelica(version="4.0.0")), version="0.5.0",
    Documentation(info="<html><p>Original OpenPWR engineering workbench models, Apache-2.0. Requires Modelica Standard Library 4.0.0 under its own BSD-3-Clause license.</p></html>"));
end OpenPWR;
