within ;
model ContinuousPlant "One continuous cold-to-power native engineering experiment"
  // SPDX-License-Identifier: Apache-2.0
  // Generic reduced-order plant: these controls are not a named plant procedure.
  package Water = Modelica.Media.Water.StandardWater;

  parameter Real beta[6] = {0.000215,0.001424,0.001274,0.002568,0.000748,0.000273};
  parameter Real lambda[6] = {0.0124,0.0305,0.111,0.301,1.14,3.01};
  parameter Real generationTimeSeconds = 1e-4;
  parameter Real initialNeutronFraction = 1e-8;
  parameter Real sourceStrengthFractionPerSecond = 2e-6;
  parameter Real nominalThermalPowerMW = 3000;
  parameter Real decayFraction[6] = {0.012,0.014,0.016,0.012,0.008,0.004};
  parameter Real decayTimeSeconds[6] = {1,5,25,150,1000,10000};
  parameter Real initialRodReactivityPcm = -2000;
  parameter Real thermalFeedbackScale = 1;
  parameter Real powerControllerGainPcm = 40 "Generic log-power controller gain; no measured-response fit";
  parameter Boolean directReactivityMode = false "Isolated verification mode; bypasses rod and feedback controllers";
  parameter Real initialTemperatureK = 313.15;
  parameter Boolean useFinitePhasePressurizer = false
    "Experimental shared pressure closure; equilibrium remains the verified numerical default" annotation(Evaluate=true);
  parameter Real initialTurbineRpm = 0;
  parameter Real initialPhaseDifferenceDeg = 0;
  parameter Real initialGeneratorVoltagePu = 0;
  parameter Real nominalRotorEnergyMJ = 4200;
  parameter Real nominalShaftFrictionMW = 2;
  parameter Real stopValveClosureSeconds = 0.2 "Generic emergency isolation time constant; not measured plant actuator data";
  parameter Real gridFrequencyHz = 50;
  parameter Real synchronizingCapacityMW = 3000 "Generic classical angle-torque coefficient, not a machine rating study";
  parameter Real electricalDampingMW = 120000 "Generic synchronizing damping in MW per unit speed error";
  parameter Real synchronizationDwellSeconds = 5;
  parameter Real synchronizationPhaseLimitDeg = 0.5;
  parameter Real synchronizationFrequencyLimitHz = 0.002;
  parameter Real synchronizationVoltageLimitPu = 0.01;
  parameter Real nominalSecondaryPressurePa = 6e6;
  parameter Real postTripMeanTemperatureC = 300 "Generic no-load heat-removal target; not a named plant procedure";
  parameter Real tripSteamDumpGainPerK = 0.1 "Generic temperature limiter gain; not fitted to measured transients";
  parameter Real initialCondenserTemperatureK = 298.15;
  parameter Real coolingWaterTemperatureK = 288.15;
  parameter Real initialCondenserMassKg = 500000;
  parameter Real generatorEfficiency = 0.985;
  parameter Real feedPumpEfficiency = 0.8;
  parameter Real nominalAuxiliaryPowerMW = 50;
  parameter Real nominalNetPowerMW = 1000;
  parameter Real nominalSteamEnthalpyJkg = Water.dewEnthalpy(Water.setSat_p(nominalSecondaryPressurePa));
  parameter Real nominalCondenserPressurePa = Water.saturationPressure(initialCondenserTemperatureK);
  parameter Real nominalCondensateEnthalpyJkg = Water.bubbleEnthalpy(Water.setSat_p(nominalCondenserPressurePa));
  parameter Real nominalCondensateDensity = Water.bubbleDensity(Water.setSat_p(nominalCondenserPressurePa));
  parameter Real nominalPumpWorkJkg = (nominalSecondaryPressurePa-nominalCondenserPressurePa)/(nominalCondensateDensity*feedPumpEfficiency);
  parameter Real nominalSteamFlowKgS = nominalThermalPowerMW*1e6/(nominalSteamEnthalpyJkg-nominalCondensateEnthalpyJkg-nominalPumpWorkJkg);
  parameter Real nominalFeedPumpPowerMW = nominalSteamFlowKgS*nominalPumpWorkJkg/1e6;
  parameter Real nominalIsentropicDropJkg = nominalSteamEnthalpyJkg-Water.isentropicEnthalpy(nominalCondenserPressurePa,Water.setState_ph(nominalSecondaryPressurePa,nominalSteamEnthalpyJkg,2));
  parameter Real turbineEfficiency = ((nominalNetPowerMW+nominalAuxiliaryPowerMW)/generatorEfficiency+nominalShaftFrictionMW)*1e6/(nominalSteamFlowKgS*nominalIsentropicDropJkg)
    "Effective nominal calibration, not an independently validated turbine map";
  parameter Real condenserConductanceWK = 200e6;

  input Real pumpCommand(min=0,max=1,start=0);
  input Real reactorDemandPercent(min=0,max=100,start=0);
  input Real automaticReactorEnable(min=0,max=1,start=0);
  input Real rodDemandPcm(min=-6000,max=8000,start=-2000);
  input Real reactivityBiasPcm(min=-300,max=300,start=0);
  input Real sourceEnable(min=0,max=1,start=1);
  input Real tripCommand(min=0,max=1,start=0);
  input Real turbineEnable(min=0,max=1,start=0);
  input Real turbineTripCommand(min=0,max=1,start=0);
  input Real speedDemandRpm(min=0,max=3000,start=0);
  input Real loadDemandMW(min=0,max=1000,start=0);
  input Real gridBreakerCommand(min=0,max=1,start=0);
  input Real automaticSyncEnable(min=0,max=1,start=0);
  input Real excitationCommandPu(min=0,max=1.1,start=0);
  input Real feedwaterFraction(min=0,max=1.2,start=1);
  input Real coolingFraction(min=0,max=1.2,start=1);
  input Real pressureControlEnable(min=0,max=1,start=0);
  input Real pressureTargetMPa(min=0.2,max=15.5,start=0.3);
  input Real heaterPowerMW(min=0,max=3,start=0);
  input Real sprayFlowKgS(min=0,max=30,start=0) "Internal cold-leg recirculation to the pressurizer";
  input Real ventFraction(min=0,max=1,start=0);
  input Real shutdownCoolingFraction(min=0,max=1,start=1);
  input Real inventoryControlEnable(min=0,max=1,start=1);
  input Real chargingFlowKgS(min=0,max=10,start=0);
  input Real letdownFlowKgS(min=0,max=20,start=0);

  ColdStartPlant thermal(initialTemperatureK=initialTemperatureK,useFinitePhasePressurizer=useFinitePhasePressurizer,
    sprayFlowKgS=sprayFlowKgS,maximumFuelHeatMW=3300,
    maximumFuelTemperatureK=1400,maximumHotTemperatureK=620,maximumColdTemperatureK=610,
    steamGeneratorConductanceMWK=150);
  output Real neutronPowerFraction(start=initialNeutronFraction,fixed=true,nominal=1e-8,stateSelect=StateSelect.always);
  output Real precursors[6](each start=initialNeutronFraction,each fixed=true,each nominal=1e-8);
  output Real precursor1=precursors[1];
  output Real precursor2=precursors[2];
  output Real precursor3=precursors[3];
  output Real precursor4=precursors[4];
  output Real precursor5=precursors[5];
  output Real precursor6=precursors[6];
  output Real decayInventory[6](each start=0,each fixed=true,each nominal=0.01);
  output Real externalSourceFractionPerSecond=sourceEnable*sourceStrengthFractionPerSecond;
  output Real fissionPowerMW=nominalThermalPowerMW*(1-sum(decayFraction))*neutronPowerFraction;
  output Real decayHeatMW=nominalThermalPowerMW*sum(decayInventory);
  output Real reactorPowerMW=fissionPowerMW+decayHeatMW;
  output Real rodReactivityPcm(start=initialRodReactivityPcm,fixed=true,nominal=1000);
  output Real reactivityPcm;
  output Real thermalFeedbackPcm;
  output Real hotLegTemperatureC=thermal.hotLegTemperatureC;
  output Real coldLegTemperatureC=thermal.coldLegTemperatureC;
  output Real fuelTemperatureC=thermal.fuelTemperatureC;
  output Real primaryPressureMPa=thermal.primaryPressureMPa;
  output Real pressurizerTemperatureC=thermal.pressurizerTemperatureC;
  output Real pressurizerLiquidTemperatureC=thermal.pressurizerLiquidTemperatureC;
  output Real pressurizerVaporTemperatureC=thermal.pressurizerVaporTemperatureC;
  output Real pressurizerSteamPartialPressurePa=thermal.pressurizerSteamPartialPressurePa;
  output Real pressurizerSaturationTemperatureC=thermal.pressurizerSaturationTemperatureC;
  output Real pressurizerVentPowerW=thermal.pressurizerVentPowerW;
  output Real pressurizerWallEnergyMJ=thermal.pressurizerWallEnergyMJ;
  output Real pressurizerWallAmbientPowerMW=thermal.pressurizerWallAmbientPowerMW;
  output Real pressurizerWallMinimumTemperatureK=thermal.pressurizerWallMinimumTemperatureK;
  output Real pressurizerWallMaximumTemperatureK=thermal.pressurizerWallMaximumTemperatureK;
  output Real pressurizerLevelPercent=thermal.pressurizerLevelPercent;
  output Real primaryFlowKgS=thermal.primaryFlowKgS;
  output Real pumpSpeed=thermal.pumpSpeed;
  output Real pumpHeatMW=thermal.pumpHeatMW;
  output Real heatToSteamMW=thermal.heatToSteamMW;
  output Real shutdownCoolingMW=thermal.shutdownCoolingMW;
  output Real secondaryTemperatureC=thermal.secondaryTemperatureC;
  output Real secondaryPressureMPa=thermal.secondaryPressureMPa;
  output Real secondaryLevelPercent=thermal.secondaryLevelPercent;
  output Real secondaryMassKg=thermal.secondaryMassKg;
  output Real pressurizerGasMassKg=thermal.pressurizerGasMassKg;
  output Real pressurizerVaporMassKg=thermal.pressurizerVaporMassKg;
  output Real ventSteamFlowKgS=thermal.ventSteamFlowKgS;
  output Real ventGasFlowKgS=thermal.ventGasFlowKgS;
  output Real actualHeaterPowerMW=thermal.actualHeaterPowerMW;
  output Real actualSprayFlowKgS=thermal.actualSprayFlowKgS;
  output Real sprayCondensationKgS=thermal.sprayCondensationKgS;
  output Real sprayHeatTransferMW=thermal.sprayHeatTransferMW;
  output Real actualLetdownFlowKgS=thermal.actualLetdownFlowKgS;
  output Real actualChargingFlowKgS=thermal.actualChargingFlowKgS;
  output Real primarySubcoolingK=thermal.primarySubcoolingK;
  output Real hotStandbyReady=thermal.hotStandbyReady;
  output Real secondaryGasMassKg=thermal.secondaryGasMassKg;
  output Real secondarySteamVentKgS=thermal.secondarySteamVentKgS;
  output Real secondaryGasVentKgS=thermal.secondaryGasVentKgS;
  output Real surgeFlowKgS=thermal.surgeFlowKgS;
  output Real primaryMassKg=thermal.primaryMassKg;
  output Real coldLegEnthalpyJkg=thermal.coldLegEnthalpyJkg;
  output Real chargingEnthalpyJkg=thermal.chargingEnthalpyJkg;
  output Real pressurizerSteamEnthalpyJkg=thermal.pressurizerSteamEnthalpyJkg;
  output Real secondarySteamEnthalpyJkg=thermal.secondarySteamEnthalpyJkg;
  output Real secondaryVaporMassKg=thermal.secondaryVaporMassKg;

  output Real turbineFlowKgS;
  output Real stopValveFraction(start=1,fixed=true) "Emergency isolation initially armed open; the governor blocks cold admission";
  output Real governorValveFraction=valve;
  output Real bypassFlowKgS;
  output Real feedwaterFlowKgS(start=0,fixed=true,nominal=1000);
  output Real turbineRpm=3000*shaftSpeed;
  output Real rotorEnergyMJ=nominalRotorEnergyMJ*shaftSpeed^2;
  output Real turbineMechanicalPowerMW;
  output Real shaftElectricalPowerMW;
  output Real shaftFrictionMW;
  output Real grossPowerMW;
  output Real netPowerMW;
  output Real generatorLossMW;
  output Real auxiliaryPowerMW;
  output Real loadReferenceMW(start=0,fixed=true,nominal=1000);
  output Real frequencyDifferenceHz=gridFrequencyHz*(shaftSpeed-1);
  output Real phaseDifferenceDeg=Modelica.Math.atan2(sin(electricalAngle),cos(electricalAngle))*180/Modelica.Constants.pi;
  output Real generatorVoltagePu=excitation*shaftSpeed;
  output Real syncPermissive=if synchronizationConditions and time-synchronizationSince>=synchronizationDwellSeconds then 1 else 0;
  output Real synchronizationDwellS=if synchronizationConditions then time-synchronizationSince else 0;
  output Real gridConnected=if connected then 1 else 0;
  output Real reactorTripped=if reactorTrip then 1 else 0;
  output Real turbineTripped=if turbineTrip then 1 else 0;
  output Real breakerClosingTimeS=closingTime;
  output Real breakerClosingPhaseDeg=closingPhase;
  output Real breakerClosingFrequencyHz=closingFrequency;
  output Real breakerClosingVoltagePu=closingVoltage;
  output Real breakerClosingDwellS=closingDwell;
  output Real condenserPressureKPa=condenserPressurePa/1000;
  output Real condenserTemperatureC=Water.saturationTemperature(condenserPressurePa)-273.15;
  output Real condenserMassKg(start=initialCondenserMassKg,fixed=true,nominal=500000);
  output Real condenserEnergyMJ;
  output Real condenserDisplacementPowerMW;
  output Real coolingPowerMW;
  output Real feedPumpPowerMW;
  output Real feedwaterEnthalpyJkg;
  output Real condenserLiquidEnthalpyJkg;
  output Real turbineExhaustEnthalpyJkg;
  output Real totalPlantStoredEnergyMJ;
  output Real totalPlantMassKg;
  output Real plantBoundaryPowerMW;
  output Real plantBoundaryMassFlowKgS;
  output Real integratedPlantBoundaryEnergyMJ(start=0,fixed=true,nominal=1e6);
  output Real integratedPlantBoundaryMassKg(start=0,fixed=true,nominal=1000);
  output Real plantEnergyResidualMW;
  output Real plantMassResidualKgS;
  output Real fullPowerReady=if connected and netPowerMW>=975 and netPowerMW<=1025 and neutronPowerFraction>=0.98 and neutronPowerFraction<=1.02 then 1 else 0;
  output Boolean valid;
protected
  Real rodTarget;
  Real targetReactivityPcm;
  discrete Boolean reactorTrip(start=false,fixed=true);
  discrete Boolean turbineTrip(start=false,fixed=true);
  discrete Boolean connected(start=false,fixed=true);
  discrete Real synchronizationSince(start=0,fixed=true);
  discrete Real closingTime(start=-1,fixed=true);
  discrete Real closingPhase(start=0,fixed=true);
  discrete Real closingFrequency(start=0,fixed=true);
  discrete Real closingVoltage(start=0,fixed=true);
  discrete Real closingDwell(start=0,fixed=true);
  Boolean synchronizationConditions;
  Real shaftSpeed(start=initialTurbineRpm/3000,fixed=true,nominal=1);
  Real electricalAngle(start=initialPhaseDifferenceDeg*Modelica.Constants.pi/180,fixed=true,nominal=1000);
  Real excitation(start=initialGeneratorVoltagePu/max(1e-4,initialTurbineRpm/3000),fixed=true);
  Real speedTarget;
  Real valve(start=0,fixed=true);
  Real bypassValve(start=0,fixed=true);
  Real valveTarget;
  Real bypassTarget;
  Real steamScaling;
  Boolean steamReady;
  Real requestedTurbinePowerMW;
  Real availableTurbinePowerMW;
  Real turbineTorqueMW;
  Real electricalTorqueMW;
  Real frictionTorqueMW;
  Real condensateDensity;
  Real condensateInternalEnergy;
  Real condenserPressurePa(start=nominalCondenserPressurePa,fixed=true,nominal=10000,stateSelect=StateSelect.always);
  Water.SaturationProperties condenserSat;
  Real condenserEnergyRateW;
  Real condenserMassRate;
  Real pumpWorkJkg;
  Real steamSpecificWorkJkg;
  Real feedwaterTarget;
  Real cyclePortPowerMW;
  Real cyclePortMassFlowKgS;
equation
  der(neutronPowerFraction)=((reactivityPcm*1e-5-sum(beta))*neutronPowerFraction+sum(beta .* precursors))/generationTimeSeconds+externalSourceFractionPerSecond;
  for i in 1:6 loop
    der(precursors[i])=lambda[i]*(neutronPowerFraction-precursors[i]);
    der(decayInventory[i])=(decayFraction[i]*neutronPowerFraction-decayInventory[i])/decayTimeSeconds[i];
  end for;
  thermalFeedbackPcm=thermalFeedbackScale*(-2*(fuelTemperatureC-(initialTemperatureK-273.15))-4*((hotLegTemperatureC+coldLegTemperatureC)/2-(initialTemperatureK-273.15)));
  targetReactivityPcm=if reactorDemandPercent<=0 then -2000 else noEvent(max(-100,min(80,powerControllerGainPcm*log(max(1e-10,reactorDemandPercent/100)/max(1e-14,neutronPowerFraction)))));
  rodTarget=noEvent(max(-6000,min(8000,if automaticReactorEnable>.5 then targetReactivityPcm-thermalFeedbackPcm else rodDemandPcm)));
  der(rodReactivityPcm)=if reactorTrip or directReactivityMode then 0 else noEvent(max(-5,min(5,(rodTarget-rodReactivityPcm)/2)));
  reactivityPcm=if reactorTrip then -6000 else if directReactivityMode then reactivityBiasPcm else rodReactivityPcm+reactivityBiasPcm+thermalFeedbackPcm;
  when tripCommand>.5 or neutronPowerFraction>1.1 or primaryPressureMPa>17.2 or hotLegTemperatureC>340
    or (reactorPowerMW>300 and (primaryPressureMPa<12.5 or primaryFlowKgS<9000)) then
    reactorTrip=true;
  end when;
  when turbineTripCommand>.5 or reactorTrip or turbineRpm>3300 then turbineTrip=true; end when;
  thermal.startupHeatMW=reactorPowerMW;
  thermal.pumpCommand=pumpCommand;
  thermal.heaterPowerMW=heaterPowerMW;
  thermal.shutdownCoolingFraction=shutdownCoolingFraction;
  thermal.chargingFlowKgS=chargingFlowKgS;
  thermal.letdownFlowKgS=letdownFlowKgS;
  thermal.ventFraction=ventFraction;
  thermal.pressureControlEnable=pressureControlEnable;
  thermal.pressureTargetMPa=pressureTargetMPa;
  thermal.inventoryControlEnable=inventoryControlEnable;
  thermal.secondaryFeedwaterFlowKgS=feedwaterFlowKgS;
  thermal.secondaryFeedwaterEnthalpyJkg=feedwaterEnthalpyJkg;
  thermal.secondarySteamFlowKgS=turbineFlowKgS+bypassFlowKgS;

  der(excitation)=(excitationCommandPu-excitation)/2;
  der(electricalAngle)=2*Modelica.Constants.pi*gridFrequencyHz*(shaftSpeed-1);
  synchronizationConditions=not turbineTrip and abs(frequencyDifferenceHz)<=synchronizationFrequencyLimitHz
    and abs(phaseDifferenceDeg)<=synchronizationPhaseLimitDeg and abs(generatorVoltagePu-1)<=synchronizationVoltageLimitPu;
  when synchronizationConditions then synchronizationSince=time; end when;
  when gridBreakerCommand<.5 or turbineTrip then
    connected=false;
  elsewhen gridBreakerCommand>.5 and syncPermissive>.5 then
    connected=true;
  end when;
  when connected then
    closingTime=time;
    closingPhase=phaseDifferenceDeg;
    closingFrequency=frequencyDifferenceHz;
    closingVoltage=generatorVoltagePu;
    closingDwell=synchronizationDwellS;
  end when;
  speedTarget=speedDemandRpm/3000+(if automaticSyncEnable>.5 and not connected and shaftSpeed>.99 then
    noEvent(max(-.0005,min(.0005,-.000002*phaseDifferenceDeg))) else 0);
  der(loadReferenceMW)=noEvent(max(-5,min(5,(loadDemandMW-loadReferenceMW)/30)));
  requestedTurbinePowerMW=if connected then (loadReferenceMW+auxiliaryPowerMW)/generatorEfficiency+nominalShaftFrictionMW
    else noEvent(max(0,min(100,nominalShaftFrictionMW*max(0,speedTarget)^2+500*(speedTarget-shaftSpeed))));
  steamReady=secondaryTemperatureC>200 and secondaryGasMassKg<.1;
  steamScaling=(secondaryPressureMPa*1e6/nominalSecondaryPressurePa)*sqrt(Water.saturationTemperature(nominalSecondaryPressurePa)/(secondaryTemperatureC+273.15));
  valveTarget=if turbineEnable>.5 and not turbineTrip and steamReady then
    noEvent(max(0,min(1.2,requestedTurbinePowerMW*1e6/(nominalSteamFlowKgS*max(10000,steamSpecificWorkJkg)*max(.01,steamScaling))))) else 0;
  der(valve)=(valveTarget-valve)/2;
  // The independently actuated stop valve closes on the latched trip. Its
  // finite residual steam admission still contributes exhaust and shaft work.
  // Initially it is armed open; the governor remains shut until enable and
  // steam readiness. Thus adding emergency isolation preserves normal startup.
  der(stopValveFraction)=((if turbineTrip then 0 else 1)-stopValveFraction)/stopValveClosureSeconds;
  // After the reactor trip, continued fixed-pressure steam dumping would
  // overcool and contract the primary inventory. Retain pressure regulation,
  // but limit steam discharge as the no-load mean-temperature target is reached.
  // This changes a physical valve demand, never a temperature or inventory state.
  bypassTarget=if steamReady then noEvent(min(max(0,min(1.4,10*(secondaryPressureMPa-nominalSecondaryPressurePa/1e6))),
    if reactorTrip then max(0,min(1.4,tripSteamDumpGainPerK*((hotLegTemperatureC+coldLegTemperatureC)/2-postTripMeanTemperatureC))) else 1.4)) else 0;
  der(bypassValve)=(bypassTarget-bypassValve)/2;
  turbineFlowKgS=nominalSteamFlowKgS*valve*stopValveFraction*steamScaling;
  bypassFlowKgS=nominalSteamFlowKgS*bypassValve*steamScaling;
  feedwaterTarget=noEvent(max(0,min(1.6*nominalSteamFlowKgS,feedwaterFraction*(turbineFlowKgS+bypassFlowKgS+20*(50-secondaryLevelPercent)))));
  der(feedwaterFlowKgS)=(feedwaterTarget-feedwaterFlowKgS)/2;
  condenserSat=Water.setSat_p(condenserPressurePa);
  condensateDensity=Water.bubbleDensity(condenserSat);
  condenserLiquidEnthalpyJkg=Water.bubbleEnthalpy(condenserSat);
  condensateInternalEnergy=condenserLiquidEnthalpyJkg-condenserPressurePa/condensateDensity;
  pumpWorkJkg=noEvent(max(0,thermal.secondary.pressurePa-condenserPressurePa))/(condensateDensity*feedPumpEfficiency);
  feedwaterEnthalpyJkg=condenserLiquidEnthalpyJkg+pumpWorkJkg;
  feedPumpPowerMW=feedwaterFlowKgS*pumpWorkJkg/1e6;
  steamSpecificWorkJkg=turbineEfficiency*noEvent(max(0,secondarySteamEnthalpyJkg-Water.isentropicEnthalpy(condenserPressurePa,
    Water.setState_ph(Water.saturationPressure(secondaryTemperatureC+273.15),secondarySteamEnthalpyJkg,2))));
  availableTurbinePowerMW=turbineFlowKgS*steamSpecificWorkJkg/1e6;
  // Finite starting torque: shaft work falls to zero at rest; unused steam
  // enthalpy leaves with the exhaust, rather than creating rotor energy.
  turbineTorqueMW=availableTurbinePowerMW/noEvent(max(1,shaftSpeed));
  turbineMechanicalPowerMW=turbineTorqueMW*shaftSpeed;
  turbineExhaustEnthalpyJkg=secondarySteamEnthalpyJkg-steamSpecificWorkJkg*shaftSpeed/noEvent(max(1,shaftSpeed));
  frictionTorqueMW=nominalShaftFrictionMW*shaftSpeed^2;
  shaftFrictionMW=frictionTorqueMW*shaftSpeed;
  electricalTorqueMW=if connected then synchronizingCapacityMW*generatorVoltagePu*sin(electricalAngle)+electricalDampingMW*(shaftSpeed-1) else 0;
  shaftElectricalPowerMW=electricalTorqueMW*shaftSpeed;
  der(shaftSpeed)=(turbineTorqueMW-frictionTorqueMW-electricalTorqueMW)/(2*nominalRotorEnergyMJ);
  grossPowerMW=if noEvent(shaftElectricalPowerMW>=0) then generatorEfficiency*shaftElectricalPowerMW else shaftElectricalPowerMW/generatorEfficiency;
  generatorLossMW=shaftElectricalPowerMW-grossPowerMW;
  auxiliaryPowerMW=2+(nominalAuxiliaryPowerMW-nominalFeedPumpPowerMW-12-2)*pumpSpeed+feedPumpPowerMW+pumpHeatMW+actualHeaterPowerMW;
  netPowerMW=grossPowerMW-auxiliaryPowerMW;
  coolingPowerMW=coolingFraction*condenserConductanceWK*(condenserTemperatureC+273.15-coolingWaterTemperatureK)/1e6;
  condenserMassRate=turbineFlowKgS+bypassFlowKgS-feedwaterFlowKgS;
  der(condenserMassKg)=condenserMassRate;
  der(condenserPressurePa)=(turbineFlowKgS*turbineExhaustEnthalpyJkg+bypassFlowKgS*secondarySteamEnthalpyJkg
    -feedwaterFlowKgS*condenserLiquidEnthalpyJkg-coolingPowerMW*1e6-condenserLiquidEnthalpyJkg*condenserMassRate)
    /(condenserMassKg*(Water.dBubbleEnthalpy_dPressure(condenserSat)-1/condensateDensity));
  condenserDisplacementPowerMW=condenserPressurePa*(der(condenserMassKg)/condensateDensity
    -condenserMassKg*Water.dBubbleDensity_dPressure(condenserSat)*der(condenserPressurePa)/condensateDensity^2)/1e6;
  condenserEnergyRateW=turbineFlowKgS*turbineExhaustEnthalpyJkg+bypassFlowKgS*secondarySteamEnthalpyJkg
    -feedwaterFlowKgS*condenserLiquidEnthalpyJkg-coolingPowerMW*1e6-condenserDisplacementPowerMW*1e6;
  condenserEnergyMJ=condenserMassKg*condensateInternalEnergy/1e6;
  cyclePortPowerMW=(feedwaterFlowKgS*feedwaterEnthalpyJkg-(turbineFlowKgS+bypassFlowKgS)*secondarySteamEnthalpyJkg)/1e6;
  cyclePortMassFlowKgS=feedwaterFlowKgS-turbineFlowKgS-bypassFlowKgS;
  totalPlantStoredEnergyMJ=thermal.totalPlantStoredEnergyMJ+condenserEnergyMJ+rotorEnergyMJ;
  totalPlantMassKg=thermal.totalPlantMassKg+condenserMassKg;
  plantBoundaryPowerMW=thermal.plantBoundaryPowerMW-cyclePortPowerMW+feedPumpPowerMW-coolingPowerMW
    -condenserDisplacementPowerMW-shaftFrictionMW-grossPowerMW-generatorLossMW;
  plantBoundaryMassFlowKgS=thermal.plantBoundaryMassFlowKgS-cyclePortMassFlowKgS;
  der(integratedPlantBoundaryEnergyMJ)=plantBoundaryPowerMW;
  der(integratedPlantBoundaryMassKg)=plantBoundaryMassFlowKgS;
  plantEnergyResidualMW=thermal.plantEnergyResidualMW+thermal.plantBoundaryPowerMW+condenserEnergyRateW/1e6
    +2*nominalRotorEnergyMJ*shaftSpeed*der(shaftSpeed)-plantBoundaryPowerMW;
  plantMassResidualKgS=thermal.plantMassResidualKgS+thermal.plantBoundaryMassFlowKgS+condenserMassRate-plantBoundaryMassFlowKgS;
  valid=thermal.valid and neutronPowerFraction>=0 and neutronPowerFraction<1.2 and min(precursors)>=0
    and min(decayInventory)>=0 and generationTimeSeconds>0 and min(beta)>0 and min(lambda)>0
    and sum(beta)<.02 and sourceStrengthFractionPerSecond>=0 and condenserMassKg>50000 and condenserMassKg<1000000
    and condenserPressurePa>700 and condenserPressurePa<20000 and shaftSpeed>=0 and shaftSpeed<1.2
    and excitation>=0 and excitation<1.3 and turbineEfficiency>0 and turbineEfficiency<=1
    and stopValveClosureSeconds>0 and noEvent(stopValveFraction>=-1e-8 and stopValveFraction<=1+1e-8)
    and pumpCommand>=0 and pumpCommand<=1 and reactorDemandPercent>=0 and reactorDemandPercent<=100
    and rodDemandPcm>=-6000 and rodDemandPcm<=8000 and reactivityBiasPcm>=-300 and reactivityBiasPcm<=300
    and loadDemandMW>=0 and loadDemandMW<=1000 and speedDemandRpm>=0 and speedDemandRpm<=3000
    and excitationCommandPu>=0 and excitationCommandPu<=1.1 and feedwaterFraction>=0 and feedwaterFraction<=1.2
    and coolingFraction>=0 and coolingFraction<=1.2
    and (sourceEnable==0 or sourceEnable==1) and (automaticReactorEnable==0 or automaticReactorEnable==1)
    and (tripCommand==0 or tripCommand==1) and (turbineEnable==0 or turbineEnable==1)
    and (turbineTripCommand==0 or turbineTripCommand==1) and (gridBreakerCommand==0 or gridBreakerCommand==1)
    and (automaticSyncEnable==0 or automaticSyncEnable==1);
  annotation(experiment(StartTime=0,StopTime=27000,Tolerance=1e-9,Interval=0.5));
end ContinuousPlant;
