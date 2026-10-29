# Native coupled plant model

`OpenPWR.CoupledPlant` is a new native hot-operation model compiled by OpenModelica and integrated with CVODE through FMI 2.0. It connects reactor kinetics to the existing primary loop and equilibrium pressurizer, a dynamic steam generator, a turbine/generator, a condenser, a feedwater pump and generic controls/protection. The independent `OpenPWR.PrimaryLoop` workbench remains available. Both are distinct from the browser's JavaScript plant engine.

The assumed nominal point is 3,000 MW thermal and 1,000 MW net electrical, with 325/290 °C primary hot/cold legs, 15.5 MPa primary pressure, 276 °C saturated steam and a 25 °C condenser cooled by 15 °C water. These are generic calibration assumptions, not a plant-specific design or measured validation result. Original model code is Apache-2.0; water properties come from the BSD-licensed Modelica Standard Library 4.0.0.

## Reactor and control response

Six-group point kinetics determines normalized neutron population `n`. Normalized precursors `z_i` equal one at the initial equilibrium:

```text
dn/dt = [(rho - sum(beta_i)) n + sum(beta_i z_i)] / Lambda
dz_i/dt = lambda_i (n - z_i)
Lambda = 0.0001 s
beta = [0.000215, 0.001424, 0.001274, 0.002568, 0.000748, 0.000273]
lambda = [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01] /s
```

The equations follow the normalized point-kinetics formulation in [ANL/NSE-21/6, section 6.1.1](https://publications.anl.gov/anlpubs/2021/05/166771.pdf). The six-group values are generic U-235 parameters; no spatial core, burnup, rod geometry, boron distribution or xenon field is implied. `OpenPWR.KineticsReference` exposes the same kernel without thermal feedback or a controller for independent numerical comparisons.

Six decay-heat inventories satisfy `dD_i/dt = (f_i n - D_i)/tau_i`, initialized to equilibrium. Fractions are `[0.012,0.014,0.016,0.012,0.008,0.004]`; time constants are `[1,5,25,150,1000,10000]` seconds. Thermal input is `3000 * (0.934 n + sum(D_i))` MW. This history-dependent approximation is illustrative and is **not ANS-5.1 or a depletion-derived decay-heat library**.

Fuel and mean-coolant temperature feedback contribute −2 and −20 pcm/K, respectively, relative to the nominal temperatures. A rate-limited integral rod surrogate integrates 40 times the neutron-demand error, limited to ±5 pcm/s. External reactivity adds to this state. Reactor demand and electrical demand are independent commands; a coordinated load maneuver should change both. No controller assigns temperatures or neutron population directly.

Latched generic reactor trips occur on a manual request, turbine-trip request, neutron fraction above 1.10, primary pressure outside 12.5–17.2 MPa, primary flow below 60% nominal, secondary liquid-volume fraction outside 20–90%, condenser pressure above 20 kPa, or shaft speed above 3,300 rpm. A reactor trip inserts −6,000 pcm and trips the turbine. Clearing an input does not clear either latch; reset creates the declared initial state. These thresholds are assumptions, not real plant operating limits or qualified protection logic.

## Steam generator

The primary heat-transfer term enters `OpenPWR.SteamGenerator` unchanged. The generic secondary volume is 400 m³, initially half liquid and half vapor by volume. Pressure `p` and liquid volume `V_l` are dynamic states. IF97 supplies both saturated phase densities and enthalpies:

```text
M = V_l rho_l(p) + (V - V_l) rho_v(p)
U = V_l rho_l(p) h_l(p) + (V - V_l) rho_v(p) h_v(p) - p V
dM/dt = feedwater - steam
dU/dt = Q_primary + feedwater h_feed - steam h_v
```

The two mass/energy equations are solved for `dp/dt` and `dV_l/dt` using analytic saturation derivatives from MSL. The secondary saturation temperature drives the primary model's heat-transfer boundary, completing two-way thermal feedback. There is no imposed steam-pressure target relaxation. Phase equilibrium is instantaneous: boiling fronts, void transport, tube-wall storage, moisture carryover and instrument shrink/swell are not represented. The displayed level is a liquid-volume fraction, not a calibrated instrument level.

## Turbine, electrical output and feedwater

Admission flow follows a generic choked-flow surrogate proportional to valve opening and upstream absolute pressure divided by the square root of absolute temperature. The valve has a 0.5 s actuator lag. Its target combines electrical demand and a pressure-trim term. A separate pressure-sensitive bypass opens after turbine trip and routes steam directly to the condenser; both flows remove the same upstream steam enthalpy from the steam generator.

MSL's [isentropic enthalpy calculation](https://build.openmodelica.org/Documentation/Modelica.Media.Water.WaterIF97_base.html) supplies the ideal expansion from saturated admission steam to condenser pressure. An effective constant turbine efficiency is calibrated to the nominal 1,000 MWe point, with 98.5% generator efficiency, 2 MW nominal shaft friction, and 50 MW nominal auxiliaries. This is an aggregate wet-steam expansion model, not a manufacturer turbine map, moisture-separator model or reheated cycle. The effective efficiency must remain between zero and one.

Rotor kinetic energy starts at 4,200 MJ and evolves from turbine work minus generator shaft extraction and speed-dependent friction. Speed follows `3000 sqrt(E_rotor/4200)` rpm. A connection request is permitted only at 2,950–3,050 rpm with no turbine-trip latch; this is a speed permissive, not a complete synchronizer. With the breaker closed, a one-second idealized grid-speed correction adjusts shaft extraction around available turbine power. With it open, electrical extraction is zero and rotor energy evolves; overspeed can trigger protection. Steam admitted during the 0.5 s valve closure can initially accelerate the shaft after a trip before friction drives coastdown. Grid angle, voltage, excitation, frequency response and electrical network dynamics are absent.

The feedwater pump raises condensate enthalpy by `(p_SG-p_cond)/(rho_cond * 0.8)`. Its actual input power is included in the energy balance and auxiliary electrical load. A two-second feedwater actuator tracks total steam outflow plus 30 kg/s per percentage-point liquid-level error, multiplied by the feedwater availability command and capped at 150% nominal flow. No regenerative feed heaters or deaerator are present: the initial feedwater is pumped condenser condensate.

## Condenser and accounting boundary

The condenser has a dynamic liquid mass, initially 500,000 kg, and a saturated-liquid pressure/temperature state. Its total liquid internal energy is `M [h_l(p) - p/rho_l(p)]`. Exhaust steam and bypass steam enter with their actual post-expansion/upstream enthalpies; condensate exits to the feed pump. Heat rejection is `coolingFraction * UA * (T_cond-T_cooling)`, with `UA` calibrated to the initial equilibrium. The liquid volume `M/rho_l(p)` can change; pressure work `p dV/dt` at its moving surface is explicitly removed from this liquid-store energy boundary as `condenserDisplacementPowerMW`. This is a liquid-store approximation, not a rigid single-phase volume. Saturated-liquid properties make pressure a temperature-dependent vacuum indicator; steam-space inventory, noncondensable gases, air ejectors and separate condensation kinetics are not modeled.

The [auxiliary-feedwater system](AUXILIARY_FEEDWATER.md) adds a finite atmospheric tank and two motor-driven trains. Main and auxiliary water enter the steam generator at their mass-weighted enthalpy. `feedwaterFlowKgS` remains main flow; `totalFeedwaterFlowKgS` includes the auxiliary supply. The condenser supplies only main feedwater.

`totalPlantStoredEnergyMJ` includes fuel and primary/pressurizer thermal inventories, secondary internal energy, condenser and auxiliary-tank liquid internal energy, and rotor kinetic energy. It excludes nuclear binding-energy inventories, primary pump kinetic energy, structural heat outside the stated nodes and the electrical grid. Its external power boundary is:

```text
core heat + pressurizer heat + charging enthalpy - letdown enthalpy
+ feed-pump input - condenser heat rejection
+ auxiliary pump electrical input - auxiliary motor loss - auxiliary tank surface pressure work
- gross electrical output - generator loss - shaft friction - condenser surface pressure work
```

Primary pump heating and consumption remain outside the inherited primary thermal model. Other auxiliary loads are included in net electrical output but dissipate outside this accounting boundary. `totalPlantMassKg` sums primary/pressurizer, secondary, condenser and auxiliary-tank mass. Steam, bypass and all feedwater transfers are internal; charging minus letdown is the only external mass boundary. Net export includes the auxiliary-feedwater pump electrical demand. Independent quadrature reconstructs the boundary from component observations and imposed controls; near-zero instantaneous equation residuals alone do not validate the model.

The legacy `thermalEnergyMJ`, `totalMassKg`, `boundaryPowerMW` and related outputs retain their **primary-subsystem-only** meaning. Use the `totalPlant*`, `plantBoundary*` and `integratedPlantBoundary*` outputs for coupled-cycle accounting.

## Operating envelope and evidence

This model starts at hot full-power equilibrium. It does **not** implement native cold startup, cooldown to ambient, shutdown cooling, spatial/multiloop core hydraulics, feed heaters, reheater, containment, emergency cooling, relief systems, fuel damage, severe accidents, detailed electrical auxiliaries or plant-specific instruments. The browser edition's generic cold-start experiment remains a separate model.

The complete validity condition is in `package.mo`. It requires the inherited primary hot-liquid envelope, secondary pressure 1–12 MPa and 5–95% liquid volume, secondary temperature 240–300 °C, condenser pressure 0.8–30 kPa and mass 50,000–1,000,000 kg, nonnegative rotor energy with speed below 3,600 rpm, bounded kinetics/rod state, and all declared control bounds. The host stops on `valid=false` or native solver failure. A domain stop is an explicit model limitation, not an extrapolated plant or accident prediction.

Numerical verification should include hot equilibrium, mass/energy inventory changes against integrated external fluxes, isolated kinetics comparisons, trip/decay response, feedwater inventory response, step refinement and deterministic replay. Measured-transient comparisons require their own plant configuration and external-boundary record; generic response checks are not substitutes. Any separate Krško replay case must state which measurements drive it and which outputs remain independent comparison quantities.

## Relationship to the native cold-start profile

The v0.8 `ColdStartPlant` is a separate thermal-hydraulic experiment with its own continuous state, initialized with cold water. It includes pump heat, shutdown cooling, charging/letdown and a gas/vapor pressurizer. It does not initialize or transfer states into `CoupledPlant`, and its prescribed startup heat does not represent a criticality approach. The coupled hot plant retains its declared hot operating envelope. See [NATIVE_COLD_STARTUP.md](NATIVE_COLD_STARTUP.md).
