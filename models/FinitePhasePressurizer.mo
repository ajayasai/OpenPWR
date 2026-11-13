within;
model FinitePhasePressurizer "Conservative liquid/steam/nitrogen inventories with finite phase transfer and wall storage"
  // SPDX-License-Identifier: Apache-2.0
  // Original control-volume model. Separate liquid and headspace temperatures
  // retain compression work. Steam and ideal nitrogen share the headspace T;
  // nitrogen dissolution, diffusion resistance and Poynting corrections are not resolved.
  package Water = Modelica.Media.Water.StandardWater;
  parameter Real volumeM3 = 50;
  parameter Real initialLiquidVolumeM3 = 25;
  parameter Real initialPressurePa = 300000;
  parameter Real initialLiquidTemperatureK = 313.15;
  parameter Real initialVaporTemperatureK = initialLiquidTemperatureK;
  parameter Real gasConstant = 296.8;
  parameter Real gasCv = 743.2;
  parameter Real ventCoefficient = .5;
  parameter Real phaseRelaxationTimeS = .1 "Unfitted finite bulk-phase relaxation; not an interface mixing time";
  parameter Real sprayContactEfficiency = 1 "Ideal droplet thermal contact; not a measured actuator performance";
  parameter Real interfacialConductanceWK = 0 "Insulated bulk interface assumption; insurge stratification remains unresolved";
  parameter Boolean externallyDriven = false annotation(Evaluate=true);
  parameter Boolean includeWall = true annotation(Evaluate=true);
  parameter Integer wallSegments = 12;
  parameter Integer wallRadialCells = 8;
  parameter Real vesselHeightM = 10 "Generic geometry; not measured plant dimensions";
  parameter Real wallThicknessM = .15 "Generic thick steel wall; explicit sensitivity parameter";
  parameter Real wallDensityKgM3 = 7850;
  parameter Real wallHeatCapacityJKgK = 500;
  parameter Real wallVolumetricHeatCapacityJm3K = wallDensityKgM3*wallHeatCapacityJKgK;
  parameter Real wallConductivityWMK = 16;
  parameter Real liquidWallHeatTransferWm2K = 500 "Unidentified sensible liquid convection";
  parameter Real vaporWallHeatTransferWm2K = 10 "Unidentified sensible vapor convection";
  parameter Real externalHeatTransferWm2K = 0;
  parameter Real ambientTemperatureK = 298.15;
  parameter Real initialWallTemperatureK = initialVaporTemperatureK;

  input Real liquidFlowKgS;
  input Real liquidEnthalpyJkg "Upstream enthalpy for either flow direction";
  input Real heatInputW;
  input Real ventFraction(min=0,max=1);
  input Real steamFlowKgS(start=0);
  input Real sprayFlowKgS(min=0,max=30,start=0) = 0;
  input Real sprayEnthalpyJkg(start=0) = 0;
  input Real imposedRates[4] "p, liquid volume, liquid temperature, headspace temperature";
  // Offset coordinates preserve the equations while avoiding numerical Jacobian
  // perturbations proportional to large absolute p/T/inventory states at cold equilibrium.
  output Real pressurePa = initialPressurePa+pressureOffsetPa;
  output Real liquidVolumeM3 = initialLiquidVolumeM3+liquidVolumeOffsetM3;
  output Real liquidTemperatureK = initialLiquidTemperatureK+liquidTemperatureOffsetK;
  output Real vaporTemperatureK = initialVaporTemperatureK+vaporTemperatureOffsetK;
  output Real gasMassKg = initialGasMassKg+gasMassOffsetKg;
  output Real steamPartialPressurePa;
  output Real saturationTemperatureK;
  output Real liquidMassKg;
  output Real vaporMassKg;
  output Real waterMassKg = liquidMassKg+vaporMassKg;
  output Real liquidEnthalpy;
  output Real vaporEnthalpy;
  output Real fluidEnergyJ;
  output Real wallEnergyJ;
  output Real energyJ = fluidEnergyJ+wallEnergyJ;
  output Real steamVentKgS;
  output Real gasVentKgS;
  output Real ventPowerW;
  output Real liquidMassCoefficients[4];
  output Real vaporMassCoefficients[4];
  output Real liquidEnergyCoefficients[4];
  output Real headspaceEnergyCoefficients[4];
  output Real vaporMassGasRateKgS;
  output Real headspaceEnergyGasRateW;
  output Real phaseMassFlowKgS;
  output Real phaseEnergyW;
  output Real interfacialHeatW;
  output Real liquidWallPowerW;
  output Real headspaceWallPowerW;
  output Real wallAmbientPowerW;
  output Real wallCondensationKgS;
  output Real bulkEvaporationKgS;
  output Real bulkCondensationKgS;
  output Real sprayCondensationKgS;
  output Real sprayHeatTransferW;
  output Real minimumFilmNusseltArgument = min(filmNusseltArgument);
  output Real massRateKgS;
  output Real energyRateW;
  output Boolean valid;
  output Real wallTemperatureK[wallSegments,wallRadialCells](each start=initialWallTemperatureK,each fixed=true,each nominal=500);

  function phaseProperties
    input Real p;
    input Real T;
    input Integer region;
    output Real rho;
    output Real h;
    output Real u;
    output Real cp;
    output Real alpha;
    output Real kappa;
  protected
    Modelica.Media.Common.IF97BaseTwoPhase properties;
  algorithm
    properties := Modelica.Media.Water.IF97_Utilities.waterBaseProp_pT(p,T,region);
    rho := properties.rho;
    h := properties.h;
    u := h-p/rho;
    cp := properties.cp;
    alpha := rho*properties.vt;
    kappa := -rho*properties.vp;
  end phaseProperties;

  function solveRates
    input Real ml[4];
    input Real mv[4];
    input Real ul[4];
    input Real uv[4];
    input Real p;
    input Real rhs[4];
    output Real rates[4];
  protected
    Real A[4,4];
    Real b[4];
  algorithm
    A[1,:] := ml/1000;
    A[2,:] := mv/1000;
    A[3,:] := (ul+{0,p,0,0})/1e6;
    A[4,:] := (uv-{0,p,0,0})/1e6;
    A[:,1] := A[:,1]*1e6;
    b := {rhs[1]/1000,rhs[2]/1000,rhs[3]/1e6,rhs[4]/1e6};
    rates := Modelica.Math.Matrices.solve(A,b);
    rates[1] := rates[1]*1e6;
  end solveRates;

protected
  parameter Real initialGasMassKg = (initialPressurePa-Water.saturationPressure(initialVaporTemperatureK))
    *(volumeM3-initialLiquidVolumeM3)/(gasConstant*initialVaporTemperatureK);
  Real pressureOffsetPa(start=0,fixed=true,nominal=1,stateSelect=StateSelect.always);
  Real liquidVolumeOffsetM3(start=0,fixed=true,nominal=1,stateSelect=StateSelect.always);
  Real liquidTemperatureOffsetK(start=0,fixed=true,nominal=1,stateSelect=StateSelect.always);
  Real vaporTemperatureOffsetK(start=0,fixed=true,nominal=1,stateSelect=StateSelect.always);
  Real gasMassOffsetKg(start=0,fixed=true,nominal=1,stateSelect=StateSelect.always);
  parameter Real crossSectionM2 = volumeM3/vesselHeightM;
  parameter Real innerRadiusM = sqrt(crossSectionM2/Modelica.Constants.pi);
  parameter Real cellHeightM = vesselHeightM/wallSegments;
  // Fixed geometric grading resolves the short-time inner-wall penetration
  // without allocating equally thin cells throughout a thick pressure vessel.
  parameter Real wallRadiusM[wallRadialCells+1] = {innerRadiusM+wallThicknessM*(101^((j-1.0)/wallRadialCells)-1)/100 for j in 1:wallRadialCells+1};
  parameter Real wallCenterRadiusM[wallRadialCells] = {(wallRadiusM[j]+wallRadiusM[j+1])/2 for j in 1:wallRadialCells};
  parameter Real wallCellVolumeM3[wallRadialCells] = {Modelica.Constants.pi*(wallRadiusM[j+1]^2-wallRadiusM[j]^2)*cellHeightM for j in 1:wallRadialCells};
  Real vaporVolumeM3;
  Real steamPropertyPressurePa;
  Real nitrogenPressurePa;
  Real nitrogenPressureTemperatureDerivative;
  Real nitrogenPressureVolumeDerivative;
  Real nitrogenPressureMassDerivative;
  Real rhoL;
  Real rhoV;
  Real uL;
  Real uV;
  Real cpL;
  Real cpV;
  Real alphaL;
  Real alphaV;
  Real kappaL;
  Real kappaV;
  Real vaporEnergyPressureDerivative;
  Real vaporEnergyTemperatureDerivative;
  Real vaporMassGasDerivative;
  Real headspaceEnergyGasDerivative;
  Real gasMassRateKgS;
  Real liquidSatH;
  Real vaporSatH;
  Real latentHeat;
  Real totalVent;
  Real gasFraction;
  Real rates[4];
  Real wallLiquidPowerW[wallSegments];
  Real wallVaporPowerW[wallSegments];
  Real wallFilmPowerW[wallSegments];
  Real wallExternalPowerW[wallSegments];
  Real wallRadialPowerW[wallSegments,wallRadialCells+1];
  Real wallAxialPowerW[wallSegments,wallRadialCells];
  Real innerWallTemperatureK[wallSegments](each start=initialWallTemperatureK,each nominal=500);
  Real outerWallTemperatureK[wallSegments](each start=initialWallTemperatureK,each nominal=500);
  Real wettedFraction[wallSegments];
  Real filmDeltaT[wallSegments];
  Real filmCoefficient[wallSegments];
  Real filmNusseltArgument[wallSegments];
  Real vaporHeightM;
  Water.ThermodynamicState filmState[wallSegments];
equation
  vaporVolumeM3 = volumeM3-liquidVolumeM3;
  nitrogenPressurePa = gasMassKg*gasConstant*vaporTemperatureK/vaporVolumeM3;
  steamPartialPressurePa = pressurePa-nitrogenPressurePa;
  // Property-only guard for nonlinear trial states. The accepted domain below
  // still requires positive physical steam pressure; no inventory is clipped.
  steamPropertyPressurePa = noEvent(max(611.657,min(19e6,steamPartialPressurePa)));
  saturationTemperatureK = Water.saturationTemperature(steamPropertyPressurePa);
  (rhoL,liquidEnthalpy,uL,cpL,alphaL,kappaL) = phaseProperties(pressurePa,liquidTemperatureK,1);
  (rhoV,vaporEnthalpy,uV,cpV,alphaV,kappaV) = phaseProperties(steamPropertyPressurePa,vaporTemperatureK,2);
  liquidSatH = Water.bubbleEnthalpy(Water.setSat_p(steamPropertyPressurePa));
  vaporSatH = Water.dewEnthalpy(Water.setSat_p(steamPropertyPressurePa));
  latentHeat = vaporSatH-liquidSatH;
  liquidMassKg = liquidVolumeM3*rhoL;
  vaporMassKg = vaporVolumeM3*rhoV;
  fluidEnergyJ = liquidMassKg*uL+vaporMassKg*uV+gasMassKg*gasCv*vaporTemperatureK;
  nitrogenPressureTemperatureDerivative = gasMassKg*gasConstant/vaporVolumeM3;
  nitrogenPressureVolumeDerivative = gasMassKg*gasConstant*vaporTemperatureK/vaporVolumeM3^2;
  nitrogenPressureMassDerivative = gasConstant*vaporTemperatureK/vaporVolumeM3;
  liquidMassCoefficients = {liquidMassKg*kappaL,rhoL,-liquidMassKg*alphaL,0};
  vaporMassCoefficients = {vaporMassKg*kappaV,-rhoV-vaporMassKg*kappaV*nitrogenPressureVolumeDerivative,
    0,-vaporMassKg*(alphaV+kappaV*nitrogenPressureTemperatureDerivative)};
  vaporMassGasDerivative = -vaporMassKg*kappaV*nitrogenPressureMassDerivative;
  liquidEnergyCoefficients = {liquidVolumeM3*(rhoL*kappaL*uL+pressurePa*kappaL-liquidTemperatureK*alphaL),
    rhoL*uL,liquidVolumeM3*(rhoL*cpL-rhoL*alphaL*uL-pressurePa*alphaL),0};
  vaporEnergyPressureDerivative = rhoV*kappaV*uV+steamPropertyPressurePa*kappaV-vaporTemperatureK*alphaV;
  vaporEnergyTemperatureDerivative = rhoV*cpV-rhoV*alphaV*uV-steamPropertyPressurePa*alphaV;
  headspaceEnergyCoefficients = {vaporVolumeM3*vaporEnergyPressureDerivative,
    -rhoV*uV-vaporVolumeM3*vaporEnergyPressureDerivative*nitrogenPressureVolumeDerivative,0,
    vaporVolumeM3*(vaporEnergyTemperatureDerivative-vaporEnergyPressureDerivative*nitrogenPressureTemperatureDerivative)+gasMassKg*gasCv};
  headspaceEnergyGasDerivative = -vaporVolumeM3*vaporEnergyPressureDerivative*nitrogenPressureMassDerivative+gasCv*vaporTemperatureK;
  gasFraction = (gasMassKg/vaporVolumeM3)/(gasMassKg/vaporVolumeM3+rhoV);
  totalVent = ventFraction*ventCoefficient*sqrt(noEvent(max(0,pressurePa-101325))/200000);
  gasVentKgS = totalVent*gasFraction;
  steamVentKgS = totalVent*(1-gasFraction);
  gasMassRateKgS = -gasVentKgS;
  der(gasMassOffsetKg) = gasMassRateKgS;
  vaporMassGasRateKgS = vaporMassGasDerivative*gasMassRateKgS;
  headspaceEnergyGasRateW = headspaceEnergyGasDerivative*gasMassRateKgS;
  ventPowerW = steamVentKgS*vaporEnthalpy+gasVentKgS*(gasCv+gasConstant)*vaporTemperatureK;
  // Thermal superheat keeps an initially saturated steam/nitrogen mixture at
  // rest: comparing liquid enthalpy at total p with saturation h at partial p
  // would spuriously evaporate even when both temperatures are equal.
  bulkEvaporationKgS = liquidMassKg*cpL*noEvent(max(0,liquidTemperatureK-saturationTemperatureK))/(latentHeat*phaseRelaxationTimeS);
  bulkCondensationKgS = vaporMassKg*cpV*noEvent(max(0,saturationTemperatureK-vaporTemperatureK))/(latentHeat*phaseRelaxationTimeS);
  sprayHeatTransferW = sprayContactEfficiency*sprayFlowKgS*noEvent(max(0,liquidSatH-sprayEnthalpyJkg));
  sprayCondensationKgS = sprayHeatTransferW/noEvent(max(1e5,vaporEnthalpy-liquidSatH));
  interfacialHeatW = interfacialConductanceWK*(vaporTemperatureK-liquidTemperatureK);
  phaseMassFlowKgS = bulkEvaporationKgS-bulkCondensationKgS-wallCondensationKgS-sprayCondensationKgS;
  // Spray-contact condensation transfers the donor vapor enthalpy into the
  // droplets/pool. Its latent heat warms the incoming subcooled spray; there is
  // no unaccounted external cooling term.
  phaseEnergyW = bulkEvaporationKgS*vaporSatH-(bulkCondensationKgS+wallCondensationKgS)*liquidSatH-sprayCondensationKgS*vaporEnthalpy;
  vaporHeightM = noEvent(max(.01,vesselHeightM-liquidVolumeM3/crossSectionM2));
  for i in 1:wallSegments loop
    wettedFraction[i] = noEvent(min(1,max(0,(liquidVolumeM3/crossSectionM2-(i-1)*cellHeightM)/cellHeightM)));
    filmDeltaT[i] = noEvent(max(0,saturationTemperatureK-innerWallTemperatureK[i]));
    filmState[i] = Water.setState_pT(steamPropertyPressurePa,noEvent(max(273.15,min(saturationTemperatureK-.01,(saturationTemperatureK+innerWallTemperatureK[i])/2))));
    // Nusselt's gravity-film mean coefficient; no coefficient is fitted to a
    // plant pressure response. Noncondensable-gas diffusion resistance is absent.
    filmNusseltArgument[i] = Modelica.Constants.g_n*Water.density(filmState[i])
      *(Water.density(filmState[i])-Water.dewDensity(Water.setSat_p(steamPropertyPressurePa)))
      *Water.thermalConductivity(filmState[i])^3*latentHeat
      /(Water.dynamicViscosity(filmState[i])*vaporHeightM*noEvent(max(.1,filmDeltaT[i])));
    // Continue only an inadmissible nonlinear trial radicand. Accepted states
    // must retain a nonnegative argument in valid below; physical fluxes are
    // unchanged wherever the gravity-film correlation is defined.
    filmCoefficient[i] = .943*noEvent(max(0,filmNusseltArgument[i]))^.25;
    wallFilmPowerW[i] = if includeWall then filmCoefficient[i]*2*Modelica.Constants.pi*innerRadiusM*cellHeightM*(1-wettedFraction[i])*filmDeltaT[i] else 0;
    wallLiquidPowerW[i] = if includeWall then liquidWallHeatTransferWm2K*2*Modelica.Constants.pi*innerRadiusM*cellHeightM*wettedFraction[i]*(liquidTemperatureK-innerWallTemperatureK[i]) else 0;
    wallVaporPowerW[i] = if includeWall then vaporWallHeatTransferWm2K*2*Modelica.Constants.pi*innerRadiusM*cellHeightM*(1-wettedFraction[i])*(vaporTemperatureK-innerWallTemperatureK[i]) else 0;
    wallExternalPowerW[i] = if includeWall then externalHeatTransferWm2K*2*Modelica.Constants.pi*(innerRadiusM+wallThicknessM)*cellHeightM*(outerWallTemperatureK[i]-ambientTemperatureK) else 0;
    wallRadialPowerW[i,1] = wallLiquidPowerW[i]+wallVaporPowerW[i]+wallFilmPowerW[i];
    wallRadialPowerW[i,wallRadialCells+1] = wallExternalPowerW[i];
    if includeWall then
      wallRadialPowerW[i,1] = 2*Modelica.Constants.pi*cellHeightM*wallConductivityWMK*(innerWallTemperatureK[i]-wallTemperatureK[i,1])/log(wallCenterRadiusM[1]/innerRadiusM);
      wallRadialPowerW[i,wallRadialCells+1] = 2*Modelica.Constants.pi*cellHeightM*wallConductivityWMK*(wallTemperatureK[i,wallRadialCells]-outerWallTemperatureK[i])/log((innerRadiusM+wallThicknessM)/wallCenterRadiusM[wallRadialCells]);
    else
      innerWallTemperatureK[i] = wallTemperatureK[i,1];
      outerWallTemperatureK[i] = wallTemperatureK[i,wallRadialCells];
    end if;
    for j in 1:wallRadialCells-1 loop
      wallRadialPowerW[i,j+1] = if includeWall then 2*Modelica.Constants.pi*cellHeightM*wallConductivityWMK*(wallTemperatureK[i,j]-wallTemperatureK[i,j+1])/log(wallCenterRadiusM[j+1]/wallCenterRadiusM[j]) else 0;
    end for;
    for j in 1:wallRadialCells loop
      wallAxialPowerW[i,j] = if includeWall then Modelica.Constants.pi*(wallRadiusM[j+1]^2-wallRadiusM[j]^2)/cellHeightM*wallConductivityWMK
        *((if i>1 then wallTemperatureK[i-1,j]-wallTemperatureK[i,j] else 0)+(if i<wallSegments then wallTemperatureK[i+1,j]-wallTemperatureK[i,j] else 0)) else 0;
      wallCellVolumeM3[j]*wallVolumetricHeatCapacityJm3K*der(wallTemperatureK[i,j]) = wallRadialPowerW[i,j]-wallRadialPowerW[i,j+1]+wallAxialPowerW[i,j];
    end for;
  end for;
  wallCondensationKgS = sum(wallFilmPowerW)/noEvent(max(1e5,vaporEnthalpy-liquidSatH));
  liquidWallPowerW = sum(wallLiquidPowerW);
  headspaceWallPowerW = sum(wallVaporPowerW)+sum(wallFilmPowerW);
  wallAmbientPowerW = sum(wallExternalPowerW);
  wallEnergyJ = if includeWall then sum(wallCellVolumeM3[j]*wallVolumetricHeatCapacityJm3K*(wallTemperatureK[i,j]-273.15) for i in 1:wallSegments,j in 1:wallRadialCells) else 0;
  if externallyDriven then
    rates = imposedRates;
  else
    rates = solveRates(liquidMassCoefficients,vaporMassCoefficients,liquidEnergyCoefficients,headspaceEnergyCoefficients,pressurePa,
      {liquidFlowKgS+sprayFlowKgS-phaseMassFlowKgS,phaseMassFlowKgS-steamVentKgS-steamFlowKgS-vaporMassGasRateKgS,
       liquidFlowKgS*liquidEnthalpyJkg+sprayFlowKgS*sprayEnthalpyJkg+heatInputW+interfacialHeatW-phaseEnergyW-liquidWallPowerW,
       phaseEnergyW-interfacialHeatW-ventPowerW-steamFlowKgS*vaporEnthalpy-headspaceWallPowerW-headspaceEnergyGasRateW});
  end if;
  der(pressureOffsetPa) = rates[1];
  der(liquidVolumeOffsetM3) = rates[2];
  der(liquidTemperatureOffsetK) = rates[3];
  der(vaporTemperatureOffsetK) = rates[4];
  massRateKgS = (liquidMassCoefficients+vaporMassCoefficients)*rates+vaporMassGasRateKgS;
  energyRateW = (liquidEnergyCoefficients+headspaceEnergyCoefficients)*rates+headspaceEnergyGasRateW
    +liquidWallPowerW+headspaceWallPowerW-wallAmbientPowerW;
  valid = pressurePa>2000 and pressurePa<18e6 and steamPartialPressurePa>611.657 and steamPartialPressurePa<19e6
    and liquidVolumeM3>.03*volumeM3 and liquidVolumeM3<.97*volumeM3 and gasMassKg>=-1e-8
    and liquidTemperatureK>=280 and liquidTemperatureK<623.15 and liquidTemperatureK<saturationTemperatureK+2
    and vaporTemperatureK>=280 and vaporTemperatureK<800 and vaporTemperatureK>saturationTemperatureK-2
    and (steamPartialPressurePa<16.5291643e6 or (vaporTemperatureK>=623.15 and steamPartialPressurePa<Modelica.Media.Water.IF97_Utilities.BaseIF97.Regions.boundary23ofT(vaporTemperatureK)))
    and phaseRelaxationTimeS>0 and (not includeWall or minimumFilmNusseltArgument>=0)
    and ventFraction>=0 and ventFraction<=1
    and sprayFlowKgS>=0 and sprayFlowKgS<=30 and sprayContactEfficiency>=0 and sprayContactEfficiency<=1
    and wallThicknessM>0 and wallVolumetricHeatCapacityJm3K>0 and wallConductivityWMK>0
    and (not includeWall or (min(wallTemperatureK)>=273.15 and max(wallTemperatureK)<=1073.15));
end FinitePhasePressurizer;
