within ;
package OpenPWR "OpenPWR native engineering workbench"
  // SPDX-License-Identifier: Apache-2.0
  // Original subsystem model. Modelica Standard Library water properties retain
  // their own BSD-3-Clause license. No ThermoSysPro or proprietary code is used.
  package Water = Modelica.Media.Water.StandardWater;

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
    parameter Real hotEnthalpy0 = Water.specificEnthalpy_pT(initialPressurePa, initialHotTemperatureK);
    parameter Real coldEnthalpy0 = Water.specificEnthalpy_pT(initialPressurePa, initialColdTemperatureK);
    parameter Real nominalFlowKgS = nominalThermalPowerW / (hotEnthalpy0 - coldEnthalpy0);
    parameter Real nominalBuoyancyPa = Modelica.Constants.g_n * elevationM *
      (Water.density_pT(initialPressurePa, initialColdTemperatureK) - Water.density_pT(initialPressurePa, initialHotTemperatureK));
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
    Water.ThermodynamicState hotState;
    Water.ThermodynamicState coldState;
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
    hotState = Water.setState_pT(pressurePa, hotTemperatureK);
    coldState = Water.setState_pT(pressurePa, coldTemperatureK);
    saturation = Water.setSat_p(pressurePa);
    rhoHot = Water.density(hotState);
    rhoCold = Water.density(coldState);
    hHot = Water.specificEnthalpy(hotState);
    hCold = Water.specificEnthalpy(coldState);
    uHot = Water.specificInternalEnergy(hotState);
    uCold = Water.specificInternalEnergy(coldState);
    cpHot = Water.specificHeatCapacityCp(hotState);
    cpCold = Water.specificHeatCapacityCp(coldState);
    alphaHot = Water.isobaricExpansionCoefficient(hotState);
    alphaCold = Water.isobaricExpansionCoefficient(coldState);
    kappaHot = Water.isothermalCompressibility(hotState);
    kappaCold = Water.isothermalCompressibility(coldState);
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
    chargingEnthalpy = Water.specificEnthalpy_pT(pressurePa, chargingTemperatureK);

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

  model PropertyReferenceChecks "Static IF97 observations for external table comparisons"
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

  annotation(uses(Modelica(version="4.0.0")), version="0.3.0",
    Documentation(info="<html><p>Original OpenPWR engineering workbench models, Apache-2.0. Requires Modelica Standard Library 4.0.0 under its own BSD-3-Clause license.</p></html>"));
end OpenPWR;
