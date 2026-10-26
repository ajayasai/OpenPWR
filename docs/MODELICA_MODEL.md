# Native primary-system engineering model

`models/OpenPWR/package.mo` defines `OpenPWR.PrimaryLoop`, an original Apache-2.0 Modelica model. OpenModelica compiles it into a native FMI 2.0 co-simulation unit. It uses Modelica Standard Library 4.0.0 IAPWS-IF97 properties: `StandardWaterOnePhase` for primary-liquid pressure/temperature calls and `StandardWater` for pressurizer saturation properties. That library retains its own BSD-3-Clause license. No ThermoSysPro, TRANSFORM, proprietary solver, or closed plant dataset is included.

This workbench is a hot-primary-system experiment, not a replacement full-plant model. Reactor heat and steam-side temperature are prescribed boundary inputs. It does not contain neutron kinetics, decay heat, secondary inventory, turbine/generator dynamics, reactor protection, cold startup, emergency cooling, containment, or fuel damage. The separate browser simulator retains its existing models for those features it already supports.

## Inventory and thermal equations

Two fixed 150 m³ primary water volumes represent the hot and cold parts of the loop. A 60 MJ/K fuel node supplies heat to the hot volume; an effective steam-generator conductance removes heat from the cold volume to the prescribed steam-temperature boundary. Initial conditions are 325 °C hot leg, 290 °C cold leg, 600 °C fuel, and 15.5 MPa common pressure. Nominal heat input is 3,000 MW. Conductances and nominal circulation are calibrated to this assumed equilibrium, not measured plant data.

For each primary volume, IF97 supplies density `rho`, enthalpy `h`, internal energy `u`, heat capacity `cp`, expansion coefficient `alpha`, and isothermal compressibility `kappa` at its own temperature and the common pressure. Its stored mass and energy are:

```text
M = V rho(p,T)
U = V rho(p,T) u(p,T)
rho_p = rho kappa; rho_T = -rho alpha
u_p = (p kappa - T alpha) / rho
u_T = cp - p alpha / rho
```

The model applies these thermodynamic differentials directly in its mass and energy equations. Primary temperature and pressure changes therefore alter water inventory. Saturation is not imposed on the primary volumes; the supported primary state remains subcooled liquid.

The primary-liquid property calls use the library's direct `p,T` formulation. This avoids converting the known temperature into enthalpy and then invoking backward `p,h` property routines for `cp`, `alpha`, and `kappa`. It also evaluates the inventory derivatives using the same independent variables as the stored inventory. The balance equations, calibrated equilibrium, controls, and saturated pressurizer formulation are unchanged from v0.3.

Let `F` denote circulation from cold to hot, `G` circulation from hot to cold, `S` surge from the hot leg to the pressurizer, `Wsp` internal spray from the cold leg, and `Wc`/`Wl` external charging/letdown. The mass equations are:

```text
dMhot/dt = F - G - S
dMcold/dt = G - F - Wsp + Wc - Wl
dMprz/dt = S + Wsp
d(Mhot + Mcold + Mprz)/dt = Wc - Wl
```

Every internal transfer carries its upstream enthalpy, including reverse surge. Charging enters the cold volume at 50 °C using IF97 enthalpy at loop pressure. Letdown leaves at cold-leg enthalpy. Spray transfers cold-leg mass and energy into the pressurizer, so it does not add total system mass.

## Pressurizer

The pressurizer has a fixed 50 m³ total volume and initially 25 m³ liquid volume. Pressure and liquid volume evolve from simultaneous mass and internal-energy conservation. Its distinct liquid/vapor inventories share saturation pressure and temperature:

```text
Ml = Vl rho_l(p)
Mv = (Vprz - Vl) rho_v(p)
Mprz = Ml + Mv
Uprz = Ml h_l(p) + Mv h_v(p) - p Vprz
dMprz/dt = S + Wsp
dUprz/dt = S h_upstream + Wsp h_cold + Qheater - Qloss
```

IF97 supplies saturated densities, enthalpies, and their pressure derivatives. The two balance equations determine `dp/dt` and `dVl/dt` together with the primary-volume balances. The reference vessel is adiabatic (`Qloss = 0`); heaters, spray, and surge change its state through the energy and mass equations. There is no imposed pressure-target relaxation.

The four coupled inventory equations are solved as a scaled 4×4 linear system using `Modelica.Math.Matrices.solve`. Upstream surge enthalpy is selected by checking the surge direction of the candidate solution. This explicit derivative calculation avoids requiring the compiler to symbolically differentiate IF97 functions; it retains the same balances. The native FMU integrates the resulting states with CVODE.

The phases are assumed to reach thermal and mechanical equilibrium immediately. This omits explicit evaporation/condensation rates, separate phase temperatures, wall heat capacity, relief valves, and resolved surge-line hydraulics. The predicted liquid volume is an equilibrium inventory indicator; it is not a detailed shrink/swell or instrument-response model.

## Circulation

Pump speed follows a first-order seven-second actuator/coastdown state. Loop circulation follows a separate momentum equation:

```text
domega/dt = (pumpCommand - omega) / 7 s
I dF/dt = pumpHead omega² + g H (rho_cold - rho_hot) - R F |F|
```

The assumed nominal pump head is 0.6 MPa and the elevation scale is 10 m. Resistance is calibrated to nominal IF97 enthalpy rise and buoyancy; inertia gives a four-second linearized momentum time scale at nominal flow. Natural circulation is a consequence of the modeled density difference, not a fixed percentage floor. These are generic surrogate parameters rather than manufacturer pump curves or a discretized piping network.

One common thermodynamic pressure is used across the primary volumes; the relatively small hydraulic pressure differences are represented only in the momentum equation. Pump electrical consumption, viscous heating, and hydraulic kinetic energy are excluded from the thermal accounting boundary. Thus its energy diagnostic is explicitly a **thermal inventory balance**, not a complete electromechanical balance.

## Inputs and observations

All FMI controls have explicit units in their names: reactor heat (MW), pump fraction, steam-boundary temperature (°C), pressurizer heater power (MW), and spray/charging/letdown mass flows (kg/s). The local service enforces the same published input bounds before applying a command.

The FMU exposes simulated temperatures, pressure, pressurizer level, flow, pump speed, phase masses, surge flow, and primary subcooling. `thermalEnergyMJ` includes fuel plus both primary volumes and the pressurizer. `totalMassKg` includes both primary volumes and the pressurizer.

`boundaryPowerMW` accounts for prescribed reactor heat, heater power, steam-generator heat removal, charging/letdown enthalpy, and configured vessel heat loss. `boundaryMassFlowKgS` is charging minus letdown. Their integrated outputs permit comparison with independently calculated inventory changes. `energyResidualMW` and `massResidualKgS` are instantaneous equation residuals; small residuals alone do not establish physical accuracy.

## Domain and evidence

`valid` becomes false outside the declared hot-liquid envelope: 8–19 MPa, at least 3 K primary subcooling, pressurizer liquid volume between 5% and 95%, primary temperatures 200–340 °C (hot) and 200–330 °C (cold), fuel 200–900 °C, positive circulation below twice nominal, or controls outside their bounds. The host must pause on this signal or a native solver failure. Boundary crossing is not an accident prediction.

Required verification includes nominal drift, the exact seven-second pump-speed response, finite-time inventory changes against integrated mass/energy boundaries, heater/spray pressure response, and communication-step refinement. Direction-of-response tests are consistency checks, not measured plant validation. The release's engineering evidence identifies the cases actually run and their tolerances.

`OpenPWR.PropertyReferenceChecks` separately exposes native MSL saturation pressure and liquid/vapor enthalpy at 20, 100, 200, and 300 °C. Run `python models/reference-checks.py --build` in the engineering Python environment to compile that probe. Without `--build`, the command verifies the existing probe only after checking its FMU and source hashes. The report separates published comparisons from numerical consistency checks:

- 12 comparisons with printed NISTIR 5078 Table 1 saturation values. The 0.05% relative tolerance includes IF97 versus IAPWS-95 differences and table rounding.
- 12 comparisons with [IAPWS R7-97(2012), Table 5, page 9](https://iapws.org/technical-guidance/release/IF97-Rev.download): specific volume, enthalpy, internal energy, and isobaric heat capacity at `(3 MPa, 300 K)`, `(80 MPa, 300 K)`, and `(3 MPa, 500 K)`. Literal published values are checked with `1e-8` relative tolerance for rounding of the nine significant digits. These are property-library test states, not extensions to the primary subsystem's operating envelope.
- 40 thermodynamic derivative consistency checks: central differences of native density/enthalpy/internal-energy observations against the model's analytic identities at eight liquid/vapor states. Pressure perturbations are ±100 Pa and temperature perturbations ±0.002 K; relative tolerance is `2e-6`. These numerical checks are labeled separately from published comparisons.
- 18 wall-material consistency checks compare the compiled enthalpy/conductivity primitives with derivatives and independent quadrature of the selected [NIST steel correlations](PRESSURIZER_MODEL.md). They verify implementation, not measured properties of the PACTEL vessel.

Results are written to `artifacts/modelica/property-verification.json`; they are separate from both the browser engine's checks and coupled subsystem tests. Neither property comparisons nor derivative checks constitute measured plant-transient validation.

Interactive throughput depends on the host, solver, state, and communication interval; the browser engine's 1,000× option does not transfer to this native model. `models/performance-checks.py` measures five fixed FMI workloads (equilibrium, pump reduction, heater, spray, and external inventory flow), with three repeats by default. It records separate initialization time, integration wall/CPU time, one-second trajectories, and independent mass/energy flux integrals. The timed integration includes all public output reads and the validity signal at every 0.05-second communication step. FMU extraction and initialization are excluded from the reported simulation throughput. Compare the same command on saved baseline and candidate FMUs; do not substitute build time or browser animation rate for native solver speed.

```sh
python models/performance-checks.py --fmu artifacts/modelica-v0.3-baseline/PrimaryLoop.fmu --output artifacts/modelica-v0.3-baseline/performance.json
python models/performance-checks.py --fmu artifacts/modelica/PrimaryLoop.fmu --output artifacts/modelica/performance.json
python models/performance-checks.py --compare artifacts/modelica-v0.3-baseline/performance.json artifacts/modelica/performance.json --output artifacts/modelica-performance.json
```

An initial pre-release development measurement on Linux/WSL, with three repeats per workload, found an aggregate median wall-time ratio of approximately 1.03× for the direct formulation. Individual ratios ranged from 1.00× to 1.07×, which is a modest difference and can overlap host timing variation. These development timings are not a release performance guarantee; the final release's `modelica-performance.json`, generated against its exact FMU/source hashes, is authoritative for that build. The demonstrated improvement is conservation: the seven-second pump case's closed-system mass discrepancy dropped from 0.04425 kg to below `1e-10` kg. Heater/spray/inventory cases also reduced mass discrepancies from about 0.002–0.009 kg to below `1e-8` kg, with smaller independent energy-integral discrepancies in every transient. Five trajectory comparisons passed the report's stated regression thresholds.

References: [MSL StandardWater](https://build.openmodelica.org/Documentation/Modelica.Media.Water.StandardWater.html), [MSL StandardWaterOnePhase](https://build.openmodelica.org/Documentation/Modelica.Media.Water.StandardWaterOnePhase.html), [MSL two-phase property interface and derivative functions](https://build.openmodelica.org/Documentation/Modelica.Media.Interfaces.PartialTwoPhaseMedium.html), and [OpenModelica FMI documentation](https://openmodelica.org/doc/OpenModelicaUsersGuide/v1.25.7/fmitlm.html).
