# Native cold-to-hot-standby laboratory

Version 0.8 adds `ColdStartPlant`, a separate native OpenModelica/FMI 2 model. It starts at 40 °C with stopped pumps, a 0.3 MPa primary circuit and a 0.15 MPa secondary inventory. Its temperatures, pressure, inventories, gas removal and heat flows evolve continuously from conservation equations. The interface never interpolates a startup animation into engineering readings and never swaps to the hot `CoupledPlant` FMU.

This is **thermal-hydraulic cold-to-hot standby**, not a full reactor startup. Fuel heating is an explicitly imposed 0–90 MW thermal boundary. There is no source-range neutron instrumentation, criticality search, boron/rod procedure, decay-heat history, turbine synchronization or transition to full electrical power in this model. The other native hot-plant profile retains its own scope. No measured plant startup has been reproduced, and numerical verification does not qualify an operating procedure or simulator.

## Components and assumptions

| Component | Implemented behavior | Deliberate approximation |
| --- | --- | --- |
| Primary circuit | Two 150 m³ subcooled-water inventories with pressure-dependent properties and upstream enthalpy transport | One aggregate loop; no resolved momentum equation or natural circulation |
| Fuel thermal inventory | 60 MJ/K heat capacity and 10 MW/K conductance to hot coolant | Prescribed fuel heat, not neutron kinetics |
| Primary pumps | Seven-second speed lag, four-second circulation lag, 15,000 kg/s nominal circulation, 12 MW speed-cubed heat | Aggregate generic pump; electrical bus/shaft/individual loops are absent |
| Pressurizer | 50 m³ vessel, initially half liquid, equilibrium steam and a finite nitrogen cushion; heaters, mixture vent and inventory control | Uniform temperature, no wall capacity or liquid stratification; generic initial nitrogen is not an assertion about a particular plant |
| Secondary inventory | 300 m³ vessel, initially half liquid, connected by a bidirectional thermal conductance to the primary cold leg | Closed steam-generator inventory; no turbine, condenser, feedwater replenishment or realistic SG geometry |
| Shutdown cooling | Adjustable 0–0.5 MW/K heat exchanger to a 30 °C sink | Unlimited external sink; no finite cooling-water/electrical system |
| Charging/letdown | User commands plus optional proportional liquid-level control; 40 °C charging water | External reservoirs and their preparation are not modeled |

The secondary cover-gas vent opens when its temperature exceeds 110 °C and its gas inventory exceeds 0.05 kg. The pressure/level controllers are explicit generic feedback laws, not plant logic. The native observations include commanded and actual heater/inventory behavior, separate steam and gas venting, stored energy and mass, and the complete boundary ledger.

## Thermodynamics and balances

Water properties use the Modelica Standard Library 4.0.0 implementation of [IAPWS-IF97](https://iapws.org/technical-guidance/release/IF97-Rev). Liquid inventories explicitly select region 1 and saturated vapor selects region 2. This avoids accidentally selecting vapor properties for the liquid inventory when numerical pressure drift is very close to saturation after gas removal. Vessel temperature is restricted below 623.15 K; the model does not extend region 1 above its published range. The primary legs retain more restrictive temperature limits and a minimum 3 K subcooling margin.

Each pressurizer/secondary vessel uses

```text
Vg = V - Vl
p = psat(T) + mg R T / Vg
Mw = rho_l(p,T) Vl + rho_v(psat(T),T) Vg
U = Ml u_l(p,T) + Mv u_v(psat(T),T) + mg cv T
```

The gas is ideal nitrogen with generic constant `R=296.8`, `cv=743.2`, and `cp=1040 J/(kg K)`. Gas and water share one temperature. Water vapor is saturated at its partial pressure; compressed liquid is evaluated at total pressure. This is an ideal-mixture approximation: gas solubility, nonideal gas effects and the Poynting correction to phase equilibrium are absent. The constants are declared assumptions, not fitted plant data or a validated nitrogen property package.

The pressure equation is integrated through its exact differential together with water-mass, mixture-energy and gas-mass balances. An independently transcribed IF97 saturation-pressure equation checks accumulated pressure-equation drift. Neither pressure nor inventory is reset when the hot-standby indicator becomes true. Liquid outflow uses upstream enthalpy in both surge directions; venting removes steam and nitrogen in the instantaneous mass proportion of the vapor space. Gas vent energy uses `cp*T`, consistently with stored gas energy `cv*T`.

The fixed-volume primary balances retain water compressibility and thermal expansion. Internal circulation, fuel-to-water transfer and primary-to-secondary heat cancel from the combined ledger. The external ledger contains prescribed fuel heat, pump dissipation, pressurizer heater work, shutdown-cooling loss, charging and letdown enthalpy, and steam/nitrogen vent enthalpy. Total reported mass includes both water and nitrogen.

## Generic demonstration schedule

The demonstration is a repeatable model experiment, not instructions for starting a real plant:

| Simulation time | Held model inputs |
| --- | --- |
| 0 s | Pump command 1; imposed fuel heat 15 MW; shutdown cooling off; automatic inventory control on; pressure controller target 15.5 MPa |
| 3,600 s | Primary mixture vent fully open |
| 7,200 s | Primary mixture vent closed |
| 18,000 s | End the cold-to-hot-standby demonstration |
| 18,000–21,600 s, separate cooldown experiment | In the same FMU instance, fuel heat 0 MW, pump command 0.5, shutdown cooling fraction 0.3; pressure and inventory control remain enabled |

Hot standby is a declared model condition: cold-leg temperature 275–305 °C, hot leg no greater than 310 °C, primary pressure 14.5–16.5 MPa, subcooling greater than 20 K, pump speed above 0.9, and each cover-gas inventory below 0.1 kg. The indicator does not enable a different model or prescribe any real-plant action.

## Verification and reproducibility

Build and run the current source with:

```sh
npm run engineering:cold:build
npm run engineering:cold:verify
npm run engineering:cold:start
```

`artifacts/cold-verification.json` contains complete retained native traces, solver and communication-step settings, model/FMU/source hashes, individual numerical limits and actual results. The verification suite exercises closed cold equilibrium, exact pump speed and integrated pump work, a nondefault 50 °C initialization, pumps-off charging and reverse surge, full startup, communication-step refinement, and cooldown in the same native instance.

Energy and mass are checked three ways: instantaneous balance residuals, differences of actual stored inventories against native integrated boundaries, and independent trapezoidal integration of reconstructed boundary fluxes. The independent flux calculation uses the held inputs and endpoint physical states, including primitive IF97 enthalpies. It does not reuse stale native control or boundary outputs across input changes. Five-second communication steps are compared with 2.5-second startup steps and a 0.5-second pump test. CVODE uses the compiled `1e-8` relative tolerance in all these cases. Faster interface settings advance solver time; they do not shorten physical heatup time.

The model returns `valid=false` outside its declared domain, and the host stops advancing. It does not clip temperature, pressure or mass into an acceptable range. A small negative gas-inventory allowance of `1e-8 kg` is solely a declared integration-roundoff bound; it is included in verification. Continuing the prototype's unmodified heat input for six hours reached the cold-leg temperature boundary at 19,825 s. That development run was stopped and was not counted as successful startup evidence. The demonstration therefore ends at five hours and tests a separate continuous cooldown. A prior prototype failed during gas removal because automatic property selection could misidentify the liquid phase; explicit IF97 phase-region selection corrected that defect before release evidence was generated.

The available evidence is numerical verification of this reduced model. Independent measured cold-startup data, realistic pressurizer/steam-generator geometry, startup instrumentation and a complete coupled operating envelope remain future work.
