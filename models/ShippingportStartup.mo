within ;
model ShippingportStartup "Effective thermal boundary experiment in the native whole plant"
  // SPDX-License-Identifier: Apache-2.0
  // The archive gives a warm initial inventory and no continuous heat-rate
  // measurement. Use the existing energy/mass balances for the complete run.
  // The first readings are proxies for initial state at the log origin.
  extends ContinuousPlant(
    initialTemperatureK=273.15+(190-32)*5/9,
    referenceBoundaryHeatMW=effectiveHeatMW,
    thermal(initialPrimaryPressurePa=101325+400*6894.757293168,
      initialPumpSpeed=0.5, initialPrimaryFlowKgS=7500,
      pumpHeatAtFullSpeedMW=0));
  input Real effectiveHeatMW(min=0,max=100,start=0)
    "Net effective heat supplied to the fuel/coolant inventory, including unresolved equipment heat";
  output Real averageCoolantTemperature=(hotLegTemperatureC+coldLegTemperatureC)/2;
  annotation(experiment(StartTime=0,StopTime=104400,Interval=60,Tolerance=1e-9));
end ShippingportStartup;
