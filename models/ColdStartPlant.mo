within ;
model ColdStartPlant "Continuous cold-to-hot-standby thermal-hydraulic laboratory"
  // SPDX-License-Identifier: Apache-2.0
  // Original reduced-order model. See docs/NATIVE_COLD_STARTUP.md for the
  // ideal-mixture approximation and deliberately limited operating envelope.
  package Water = Modelica.Media.Water.StandardWater;
  package Liquid = Modelica.Media.Water.StandardWaterOnePhase;

  function liquidProperties
    input Real p;
    input Real T;
    output Real rho;
    output Real h;
    output Real u;
    output Real cp;
    output Real alpha;
    output Real kappa;
  protected
    Modelica.Media.Common.IF97BaseTwoPhase properties;
  algorithm
    properties := Modelica.Media.Water.IF97_Utilities.waterBaseProp_pT(p,T,1);
    rho := properties.rho;
    h := properties.h;
    u := h-p/rho;
    cp := properties.cp;
    alpha := rho*properties.vt;
    kappa := -rho*properties.vp;
  end liquidProperties;

  function vaporProperties "IF97 region-2 properties and derivatives along saturation"
    input Real T;
    output Real p;
    output Real rho;
    output Real h;
    output Real u;
    output Real rhoT;
    output Real uT;
    output Real pT;
  protected
    Modelica.Media.Common.IF97BaseTwoPhase properties;
    Real alpha;
    Real kappa;
  algorithm
    p := Water.saturationPressure(T);
    pT := 1/Water.saturationTemperature_derp(p);
    properties := Modelica.Media.Water.IF97_Utilities.waterBaseProp_pT(p,T,2);
    rho := properties.rho;
    h := properties.h;
    u := h-p/rho;
    alpha := rho*properties.vt;
    kappa := -rho*properties.vp;
    rhoT := rho*(kappa*pT-alpha);
    uT := properties.cp-p*alpha/rho+(p*kappa-T*alpha)/rho*pT;
  end vaporProperties;

  function vesselRates
    input Real massCoefficients[3];
    input Real energyCoefficients[3];
    input Real pressureCoefficients[3];
    input Real massInput;
    input Real energyInput;
    input Real gasPressureRate;
    output Real rates[3];
  protected
    Real A[3,3];
    Real b[3];
  algorithm
    A[1,:] := massCoefficients/1000;
    A[2,:] := energyCoefficients/1e6;
    A[3,:] := pressureCoefficients/1e6;
    A[:,1] := A[:,1]*1e6;
    b := {massInput/1000,energyInput/1e6,gasPressureRate/1e6};
    rates := Modelica.Math.Matrices.solve(A,b);
    rates[1] := rates[1]*1e6;
  end vesselRates;

  function coupledRates
    input Real mh[5];
    input Real mc[5];
    input Real uh[5];
    input Real uc[5];
    input Real mp[5];
    input Real up[5];
    input Real pp[5];
    input Real gasPressureRate;
    input Real gasEnergyRate;
    input Real hHot;
    input Real hCold;
    input Real hLiquid;
    input Real hCharging;
    input Real circulation;
    input Real fuelHeat;
    input Real coldHeat;
    input Real charging;
    input Real letdown;
    input Real heater;
    input Real steamVent;
    input Real ventPower;
    output Real pRate;
    output Real hotRate;
    output Real coldRate;
    output Real pressTemperatureRate;
    output Real volumeRate;
  protected
    Real A[5,5];
    Real b[5];
    Real hs;
    Real hc;
    Real hcir;
    Real surge;
    Real flowToCold;
    Real cs;
    Real rates[5];
  algorithm
    cs := charging-letdown;
    hcir := if circulation >= 0 then hCold else hHot;
    for branch in 1:4 loop
      hs := if branch <= 2 then hHot else hLiquid;
      hc := if mod(branch,2) == 1 then hHot else hCold;
      A[1,:] := uh-mh*hs-mc*(hs-hc);
      A[2,:] := uc-mc*hc;
      A[3,:] := mh+mc+mp;
      A[4,:] := up+(mh+mc)*hs;
      A[5,:] := pp;
      b := {fuelHeat+circulation*(hcir-hc)+cs*(hc-hs),
        circulation*(hc-hcir)+charging*(hCharging-hc)+letdown*(hc-hCold)+coldHeat,
        cs-steamVent,heater+cs*hs-ventPower-gasEnergyRate,gasPressureRate};
      A[:,1] := A[:,1]*1e6;
      for row in 1:5 loop
        A[row,:] := A[row,:]/(if row == 3 then 1000 else 1e6);
        b[row] := b[row]/(if row == 3 then 1000 else 1e6);
      end for;
      rates := Modelica.Math.Matrices.solve(A,b);
      rates[1] := rates[1]*1e6;
      pRate := rates[1];
      hotRate := rates[2];
      coldRate := rates[3];
      pressTemperatureRate := rates[4];
      volumeRate := rates[5];
      surge := cs-(mh+mc)*rates;
      flowToCold := circulation+mc*rates-cs;
      if (if branch <= 2 then surge >= -1e-10 else surge <= 1e-10)
        and (if mod(branch,2) == 1 then flowToCold >= -1e-10 else flowToCold <= 1e-10) then
        return;
      end if;
    end for;
    assert(false,"No consistent upstream-flow branch in cold-start balances");
  end coupledRates;

  model WaterGasVessel "Equilibrium water with an ideal nitrogen cover gas"
    parameter Real volumeM3 = 50;
    parameter Real initialLiquidVolumeM3 = 25;
    parameter Real initialTemperatureK = 313.15;
    parameter Real initialPressurePa = 300000;
    parameter Real gasConstant = 296.8 "Generic ideal nitrogen, J/(kg.K)";
    parameter Real gasCv = 743.2;
    parameter Real ventCoefficient = 0.5 "kg/s at 0.2 MPa differential";
    parameter Boolean externallyDriven = false annotation(Evaluate=true);
    input Real liquidFlowKgS;
    input Real liquidEnthalpyJkg;
    input Real heatInputW;
    input Real ventFraction;
    input Real imposedRates[3];
    output Real pressurePa(start=initialPressurePa,fixed=true,nominal=1e6,stateSelect=StateSelect.always);
    output Real temperatureK(start=initialTemperatureK,fixed=true,nominal=500,stateSelect=StateSelect.always);
    output Real liquidVolumeM3(start=initialLiquidVolumeM3,fixed=true,nominal=25,stateSelect=StateSelect.always);
    output Real gasMassKg(start=(initialPressurePa-Water.saturationPressure(initialTemperatureK))*(volumeM3-initialLiquidVolumeM3)/(gasConstant*initialTemperatureK),fixed=true,nominal=10,stateSelect=StateSelect.always);
    output Real liquidMassKg;
    output Real vaporMassKg;
    output Real waterMassKg;
    output Real energyJ;
    output Real liquidEnthalpy;
    output Real vaporEnthalpy;
    output Real steamVentKgS;
    output Real gasVentKgS;
    output Real ventPowerW;
    output Real massRateKgS;
    output Real energyRateW;
    output Real massCoefficients[3];
    output Real energyCoefficients[3];
    output Real pressureCoefficients[3];
    output Real gasEnergyRateW;
    output Real gasPressureRatePaS;
    output Boolean valid;
  protected
    Real vaporPressurePa;
    Real vaporVolumeM3;
    Real gasDensity;
    Real rhoL;
    Real rhoV;
    Real uL;
    Real uV;
    Real cpL;
    Real alphaL;
    Real kappaL;
    Real rhoV_T;
    Real uV_T;
    Real satPressure_T;
    Real totalVent;
    Real gasFraction;
    Real rates[3];
  equation
    (vaporPressurePa,rhoV,vaporEnthalpy,uV,rhoV_T,uV_T,satPressure_T) = vaporProperties(temperatureK);
    vaporVolumeM3 = volumeM3-liquidVolumeM3;
    pressureCoefficients = {1,-(satPressure_T+gasMassKg*gasConstant/vaporVolumeM3),
      -gasMassKg*gasConstant*temperatureK/vaporVolumeM3^2};
    gasPressureRatePaS = -gasConstant*temperatureK/vaporVolumeM3*gasVentKgS;
    gasEnergyRateW = -gasCv*temperatureK*gasVentKgS;
    // This is explicitly a LIQUID inventory. Selecting IF97 region 1 prevents
    // roundoff around p=psat(T) after gas removal from selecting vapor properties.
    // The accepted temperature domain stays below the region-1 upper boundary.
    (rhoL,liquidEnthalpy,uL,cpL,alphaL,kappaL) = liquidProperties(pressurePa,temperatureK);
    gasDensity = gasMassKg/vaporVolumeM3;
    gasFraction = gasDensity/(gasDensity+rhoV);
    totalVent = ventFraction*ventCoefficient*sqrt(noEvent(max(0,pressurePa-101325))/200000);
    gasVentKgS = totalVent*gasFraction;
    steamVentKgS = totalVent*(1-gasFraction);
    der(gasMassKg) = -gasVentKgS;
    ventPowerW = steamVentKgS*vaporEnthalpy+gasVentKgS*(gasCv+gasConstant)*temperatureK;
    liquidMassKg = liquidVolumeM3*rhoL;
    vaporMassKg = vaporVolumeM3*rhoV;
    waterMassKg = liquidMassKg+vaporMassKg;
    energyJ = liquidMassKg*uL+vaporMassKg*uV+gasMassKg*gasCv*temperatureK;
    massCoefficients = {liquidVolumeM3*rhoL*kappaL,-liquidVolumeM3*rhoL*alphaL+vaporVolumeM3*rhoV_T,rhoL-rhoV};
    energyCoefficients = {liquidVolumeM3*(rhoL*kappaL*uL+pressurePa*kappaL-temperatureK*alphaL),
      liquidVolumeM3*(rhoL*cpL-rhoL*alphaL*uL-pressurePa*alphaL)+vaporVolumeM3*(rhoV_T*uV+rhoV*uV_T)+gasMassKg*gasCv,
      rhoL*uL-rhoV*uV};
    if externallyDriven then
      rates = imposedRates;
    else
      rates = vesselRates(massCoefficients,energyCoefficients,pressureCoefficients,
        liquidFlowKgS-steamVentKgS,heatInputW+liquidFlowKgS*liquidEnthalpyJkg-ventPowerW-gasEnergyRateW,gasPressureRatePaS);
    end if;
    der(pressurePa) = rates[1];
    der(temperatureK) = rates[2];
    der(liquidVolumeM3) = rates[3];
    massRateKgS = massCoefficients*rates;
    energyRateW = energyCoefficients*rates+gasEnergyRateW;
    valid = temperatureK >= 280 and temperatureK < 623.15 and pressurePa > 2000 and pressurePa < 18e6
      and liquidVolumeM3 > 0.03*volumeM3 and liquidVolumeM3 < 0.97*volumeM3 and gasMassKg >= -1e-8;
  end WaterGasVessel;

  parameter Real initialTemperatureK = 313.15;
  parameter Real primaryVolumeM3 = 300;
  parameter Real fuelCapacityJK = 60e6;
  parameter Real nominalFlowKgS = 15000;
  parameter Real pumpHeatAtFullSpeedMW = 12;
  parameter Real shutdownCoolingConductanceWK = 500000;
  parameter Real shutdownCoolingSinkTemperatureK = 303.15;

  input Real pumpCommand(min=0,max=1,start=0);
  input Real startupHeatMW(min=0,max=90,start=0) "Prescribed fuel heat; no criticality or neutron startup model";
  input Real heaterPowerMW(min=0,max=3,start=0);
  input Real shutdownCoolingFraction(min=0,max=1,start=1);
  input Real chargingFlowKgS(min=0,max=10,start=0);
  input Real letdownFlowKgS(min=0,max=20,start=0);
  input Real ventFraction(min=0,max=1,start=0);
  input Real pressureControlEnable(min=0,max=1,start=0);
  input Real pressureTargetMPa(min=0.2,max=15.5,start=0.3);
  input Real inventoryControlEnable(min=0,max=1,start=1);

  output Real hotLegTemperatureC;
  output Real coldLegTemperatureC;
  output Real fuelTemperatureC;
  output Real primaryPressureMPa;
  output Real pressurizerTemperatureC;
  output Real pressurizerLevelPercent;
  output Real primaryFlowKgS(start=0,fixed=true,nominal=15000);
  output Real pumpSpeed(start=0,fixed=true);
  output Real pumpHeatMW;
  output Real reactorPowerMW = startupHeatMW;
  output Real heatToSteamMW;
  output Real shutdownCoolingMW;
  output Real secondaryTemperatureC;
  output Real secondaryPressureMPa;
  output Real secondaryLevelPercent;
  output Real secondaryMassKg;
  output Real pressurizerGasMassKg = pressurizer.gasMassKg;
  output Real pressurizerVaporMassKg = pressurizer.vaporMassKg;
  output Real ventSteamFlowKgS = pressurizer.steamVentKgS;
  output Real ventGasFlowKgS = pressurizer.gasVentKgS;
  output Real actualHeaterPowerMW;
  output Real actualLetdownFlowKgS;
  output Real actualChargingFlowKgS;
  output Real primarySubcoolingK;
  output Real totalPlantStoredEnergyMJ;
  output Real totalPlantMassKg;
  output Real plantBoundaryPowerMW;
  output Real plantBoundaryMassFlowKgS;
  output Real integratedPlantBoundaryEnergyMJ(start=0,fixed=true);
  output Real integratedPlantBoundaryMassKg(start=0,fixed=true);
  output Real plantEnergyResidualMW;
  output Real plantMassResidualKgS;
  output Real hotStandbyReady;
  output Boolean valid;
  output Real secondaryGasMassKg = secondary.gasMassKg;
  output Real secondarySteamVentKgS = secondary.steamVentKgS;
  output Real secondaryGasVentKgS = secondary.gasVentKgS;
  output Real surgeFlowKgS;
  output Real primaryMassKg;
  output Real coldLegEnthalpyJkg = hC;
  output Real chargingEnthalpyJkg = chargingEnthalpy;
  output Real pressurizerSteamEnthalpyJkg = pressurizer.vaporEnthalpy;
  output Real secondarySteamEnthalpyJkg = secondary.vaporEnthalpy;
  output Real secondaryVaporMassKg = secondary.vaporMassKg;

  WaterGasVessel pressurizer(externallyDriven=true,initialTemperatureK=initialTemperatureK);
  WaterGasVessel secondary(volumeM3=300,initialLiquidVolumeM3=150,initialPressurePa=150000,
    initialTemperatureK=initialTemperatureK,ventCoefficient=2);
protected
  Real hotTemperatureK(start=initialTemperatureK,fixed=true,nominal=500,stateSelect=StateSelect.always);
  Real coldTemperatureK(start=initialTemperatureK,fixed=true,nominal=500,stateSelect=StateSelect.always);
  Real fuelTemperatureK(start=initialTemperatureK,fixed=true,nominal=500,stateSelect=StateSelect.always);
  Real pressurePa;
  Real rhoH;
  Real rhoC;
  Real hH;
  Real hC;
  Real uH;
  Real uC;
  Real cpH;
  Real cpC;
  Real alphaH;
  Real alphaC;
  Real kappaH;
  Real kappaC;
  Real hotMass;
  Real coldMass;
  Real hotMassRate;
  Real coldMassRate;
  Real hotEnergyRate;
  Real coldEnergyRate;
  Real fuelHeatW;
  Real circulationPowerW;
  Real flowToCold;
  Real surgeEnthalpy;
  Real chargingEnthalpy;
  Real pressureVent;
  Real primaryEnergyRateW;
  Real secondaryVentFraction;
  Real primaryRates[5];
  Real mh[5];
  Real mc[5];
  Real uh[5];
  Real uc[5];
equation
  pressurePa = pressurizer.pressurePa;
  (rhoH,hH,uH,cpH,alphaH,kappaH) = liquidProperties(pressurePa,hotTemperatureK);
  (rhoC,hC,uC,cpC,alphaC,kappaC) = liquidProperties(pressurePa,coldTemperatureK);
  hotMass = primaryVolumeM3/2*rhoH;
  coldMass = primaryVolumeM3/2*rhoC;
  hotMassRate = mh*primaryRates;
  coldMassRate = mc*primaryRates;
  hotEnergyRate = uh*primaryRates;
  coldEnergyRate = uc*primaryRates;
  der(pumpSpeed) = (pumpCommand-pumpSpeed)/7;
  der(primaryFlowKgS) = (nominalFlowKgS*pumpSpeed-primaryFlowKgS)/4;
  pumpHeatMW = pumpHeatAtFullSpeedMW*pumpSpeed^3;
  fuelHeatW = 10e6*(fuelTemperatureK-hotTemperatureK);
  fuelCapacityJK*der(fuelTemperatureK) = startupHeatMW*1e6-fuelHeatW;
  heatToSteamMW = (0.05+0.95*pumpSpeed)*20*(coldTemperatureK-secondary.temperatureK);
  shutdownCoolingMW = shutdownCoolingFraction*shutdownCoolingConductanceWK*noEvent(max(0,coldTemperatureK-shutdownCoolingSinkTemperatureK))/1e6;
  actualHeaterPowerMW = if pressureControlEnable > 0.5 then noEvent(max(0,min(3,3*(pressureTargetMPa-primaryPressureMPa)))) else heaterPowerMW;
  pressureVent = if pressureControlEnable > 0.5 then noEvent(max(0,min(1,2*(primaryPressureMPa-pressureTargetMPa)))) else 0;
  actualLetdownFlowKgS = letdownFlowKgS+(if inventoryControlEnable > 0.5 then noEvent(max(0,min(20,2*(pressurizerLevelPercent-50)))) else 0);
  actualChargingFlowKgS = chargingFlowKgS+(if inventoryControlEnable > 0.5 then noEvent(max(0,min(10,2*(50-pressurizerLevelPercent)))) else 0);
  chargingEnthalpy = Liquid.specificEnthalpy_pT(pressurePa,initialTemperatureK);
  flowToCold = primaryFlowKgS+coldMassRate-actualChargingFlowKgS+actualLetdownFlowKgS;
  surgeFlowKgS = actualChargingFlowKgS-actualLetdownFlowKgS-hotMassRate-coldMassRate;
  surgeEnthalpy = noEvent(if surgeFlowKgS >= 0 then hH else pressurizer.liquidEnthalpy);
  circulationPowerW = noEvent(if primaryFlowKgS >= 0 then primaryFlowKgS*hC else primaryFlowKgS*hH);
  mh = {hotMass*kappaH,-hotMass*alphaH,0,0,0};
  mc = {coldMass*kappaC,0,-coldMass*alphaC,0,0};
  uh = {primaryVolumeM3/2*(rhoH*kappaH*uH+pressurePa*kappaH-hotTemperatureK*alphaH),
    primaryVolumeM3/2*(rhoH*cpH-rhoH*alphaH*uH-pressurePa*alphaH),0,0,0};
  uc = {primaryVolumeM3/2*(rhoC*kappaC*uC+pressurePa*kappaC-coldTemperatureK*alphaC),0,
    primaryVolumeM3/2*(rhoC*cpC-rhoC*alphaC*uC-pressurePa*alphaC),0,0};
  (primaryRates[1],primaryRates[2],primaryRates[3],primaryRates[4],primaryRates[5]) = coupledRates(mh,mc,uh,uc,
    {pressurizer.massCoefficients[1],0,0,pressurizer.massCoefficients[2],pressurizer.massCoefficients[3]},
    {pressurizer.energyCoefficients[1],0,0,pressurizer.energyCoefficients[2],pressurizer.energyCoefficients[3]},
    {pressurizer.pressureCoefficients[1],0,0,pressurizer.pressureCoefficients[2],pressurizer.pressureCoefficients[3]},
    pressurizer.gasPressureRatePaS,pressurizer.gasEnergyRateW,hH,hC,pressurizer.liquidEnthalpy,chargingEnthalpy,
    primaryFlowKgS,fuelHeatW,(-heatToSteamMW+pumpHeatMW-shutdownCoolingMW)*1e6,
    actualChargingFlowKgS,actualLetdownFlowKgS,actualHeaterPowerMW*1e6,pressurizer.steamVentKgS,pressurizer.ventPowerW);
  der(hotTemperatureK) = primaryRates[2];
  der(coldTemperatureK) = primaryRates[3];
  pressurizer.imposedRates = {primaryRates[1],primaryRates[4],primaryRates[5]};
  secondary.imposedRates = zeros(3);
  pressurizer.liquidFlowKgS = surgeFlowKgS;
  pressurizer.liquidEnthalpyJkg = surgeEnthalpy;
  pressurizer.heatInputW = actualHeaterPowerMW*1e6;
  pressurizer.ventFraction = noEvent(max(ventFraction,pressureVent));
  secondary.liquidFlowKgS = 0;
  secondary.liquidEnthalpyJkg = 0;
  secondary.heatInputW = heatToSteamMW*1e6;
  // Generic modulating purge: 1 K opening band and 0.05 kg gas-inventory taper.
  // Continuous flow avoids an ideal instantaneous valve event in FMI co-simulation.
  secondaryVentFraction = noEvent(max(0,min(1,(secondary.temperatureK-383.15)/1))
    *max(0,min(1,(secondary.gasMassKg-0.05)/0.05)));
  secondary.ventFraction = secondaryVentFraction;
  hotLegTemperatureC = hotTemperatureK-273.15;
  coldLegTemperatureC = coldTemperatureK-273.15;
  fuelTemperatureC = fuelTemperatureK-273.15;
  primaryPressureMPa = pressurePa/1e6;
  pressurizerTemperatureC = pressurizer.temperatureK-273.15;
  pressurizerLevelPercent = 100*pressurizer.liquidVolumeM3/pressurizer.volumeM3;
  secondaryTemperatureC = secondary.temperatureK-273.15;
  secondaryPressureMPa = secondary.pressurePa/1e6;
  secondaryLevelPercent = 100*secondary.liquidVolumeM3/secondary.volumeM3;
  secondaryMassKg = secondary.waterMassKg;
  primarySubcoolingK = Water.saturationTemperature(pressurePa)-noEvent(max(hotTemperatureK,coldTemperatureK));
  primaryMassKg = hotMass+coldMass+pressurizer.waterMassKg;
  totalPlantStoredEnergyMJ = (fuelCapacityJK*(fuelTemperatureK-273.15)+hotMass*uH+coldMass*uC+pressurizer.energyJ+secondary.energyJ)/1e6;
  totalPlantMassKg = primaryMassKg+pressurizer.gasMassKg+secondary.waterMassKg+secondary.gasMassKg;
  plantBoundaryPowerMW = startupHeatMW+pumpHeatMW+actualHeaterPowerMW-shutdownCoolingMW
    +(actualChargingFlowKgS*chargingEnthalpy-actualLetdownFlowKgS*hC-pressurizer.ventPowerW-secondary.ventPowerW)/1e6;
  plantBoundaryMassFlowKgS = actualChargingFlowKgS-actualLetdownFlowKgS-pressurizer.steamVentKgS-pressurizer.gasVentKgS-secondary.steamVentKgS-secondary.gasVentKgS;
  der(integratedPlantBoundaryEnergyMJ) = plantBoundaryPowerMW;
  der(integratedPlantBoundaryMassKg) = plantBoundaryMassFlowKgS;
  primaryEnergyRateW = startupHeatMW*1e6-fuelHeatW+hotEnergyRate+coldEnergyRate+pressurizer.energyRateW;
  plantEnergyResidualMW = (primaryEnergyRateW+secondary.energyRateW)/1e6-plantBoundaryPowerMW;
  plantMassResidualKgS = hotMassRate+coldMassRate+pressurizer.massRateKgS-pressurizer.gasVentKgS+secondary.massRateKgS-secondary.gasVentKgS-plantBoundaryMassFlowKgS;
  hotStandbyReady = if coldLegTemperatureC >= 275 and coldLegTemperatureC <= 305 and hotLegTemperatureC <= 310
    and primaryPressureMPa >= 14.5 and primaryPressureMPa <= 16.5 and primarySubcoolingK > 20
    and pumpSpeed > 0.9 and pressurizerGasMassKg < 0.1 and secondaryGasMassKg < 0.1 then 1 else 0;
  valid = pressurizer.valid and secondary.valid and primaryPressureMPa >= 0.1 and primaryPressureMPa < 17.5
    and hotTemperatureK >= 280 and hotTemperatureK < 600 and coldTemperatureK >= 280 and coldTemperatureK < 590
    and fuelTemperatureK >= 280 and fuelTemperatureK < 650 and primarySubcoolingK > 3
    and primaryFlowKgS >= -0.1 and primaryFlowKgS <= 16000
    and pumpCommand >= 0 and pumpCommand <= 1 and startupHeatMW >= 0 and startupHeatMW <= 90
    and heaterPowerMW >= 0 and heaterPowerMW <= 3 and shutdownCoolingFraction >= 0 and shutdownCoolingFraction <= 1
    and chargingFlowKgS >= 0 and chargingFlowKgS <= 10 and letdownFlowKgS >= 0 and letdownFlowKgS <= 20
    and ventFraction >= 0 and ventFraction <= 1 and pressureTargetMPa >= 0.2 and pressureTargetMPa <= 15.5
    and (pressureControlEnable == 0 or pressureControlEnable == 1)
    and (inventoryControlEnable == 0 or inventoryControlEnable == 1);
  annotation(experiment(StartTime=0,StopTime=21600,Tolerance=1e-8,Interval=0.5));
end ColdStartPlant;
