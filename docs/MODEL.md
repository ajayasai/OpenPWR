# Engineering model

OpenPWR models a **generic 3,000 MW thermal / 1,000 MW net electrical PWR** at the system level. The model is original JavaScript, uses explicit equations and parameters, and runs identically in the browser and Node.js. It is intended for exploration, numerical experiments, and software development. It is not a digital twin of a named plant or a qualified safety-analysis or operator-training system.

The implemented systems are aggregated: one reactor thermal node, one average primary-coolant node, one equivalent steam generator, one turbine/generator, and one condenser/heat sink. A drawing of multiple pipes is not a spatial discretization of the plant.

## Units and reference state

Internally, time is seconds; power is MW = MJ/s; stored energy is MJ; mass is kg; temperatures are °C; primary/secondary pressures are MPa; condenser display pressure is kPa. Reactivity is reported in pcm, where 1 pcm = 10⁻⁵ Δk/k. `neutronPower` is normalized to nominal fission power. The snapshot field `efficiency` is an instantaneous net-electrical/reactor-thermal power ratio in percent, not steady-state cycle efficiency. It can be negative when the plant imports auxiliary electricity after a trip and is set to zero below 1 MW thermal to avoid a meaningless singular ratio.

| Nominal quantity | Value | Provenance |
| --- | --- | --- |
| Thermal power / net electricity | 3,000 MW / 1,000 MW | Chosen generic design point |
| Primary pressure / average coolant | 15.5 MPa / 307.5 °C | Generic calibration assumptions |
| Mean fuel temperature | 600 °C | Lumped-node calibration, not peak pellet temperature |
| Secondary pressure | 6 MPa | Chosen reference point; saturation temperature calculated |
| Primary mass flow / heat capacity | 15,584.416 kg/s / 0.0055 MJ/(kg K) | Generic constants |
| Fuel / primary thermal capacity | 60 / 1,100 MJ/K | Generic effective capacities |
| Steam-generator liquid inventory | 150,000 kg | 50% of a generic 300,000 kg level scale |
| Steam-generator metal capacity | 400 MJ/K | Generic effective capacity |
| Regenerative feedwater temperature | 220 °C | Fixed algebraic boundary assumption |
| Condenser / cooling-water temperature | 40 / 20 °C | Generic reference conditions |
| Condenser thermal capacity | 12,000 MJ/K | Generic effective capacity |
| Turbine conversion / auxiliary demand | 35% / 50 MW at nominal pumps | Calibrated to the nominal electrical output |

`PARAMETERS` in [`src/engine.js`](../src/engine.js) is the authoritative parameter set. These values have not been inferred from a particular plant's design documents or validated transient measurements. Initial states assume equilibrium precursor, poison, and decay-heat inventories at the selected power. They do not reproduce a cold start or a short irradiation history. A half-thermal-power equilibrium produces 475 MWe because auxiliary loads remain present. The API accepts `initialPower` as a thermal fraction from `2/7` through `1`; the lower limit corresponds to 250 MWe net with nominal auxiliaries. Initial cooling-water command follows the initial thermal fraction to maintain a 40 °C condenser. Subsequent load increases may require increased cooling-water command; an output-limit alarm indicates insufficient conversion capacity at rated thermal power.

## Reactor dynamics

### Six delayed-neutron groups

The conventional point-kinetics equations are

\[
\dot n=\frac{\rho-\beta}{\Lambda}n+\sum_i\lambda_i C_i,
\qquad
\dot C_i=\frac{\beta_i}{\Lambda}n-\lambda_i C_i.
\]

The implementation stores `zᵢ = λᵢ Λ Cᵢ / βᵢ`, so each normalized precursor equals `n` at equilibrium. A backward-Euler step solves all seven variables implicitly by eliminating the six precursor unknowns. The solver guards the positivity domain. This is a temporal, spatially uniform model: it cannot calculate flux shapes, local power peaking, rod shadowing, neutron spectra, or changing effective delayed-neutron data with burnup.

| Group | βᵢ | λᵢ (s⁻¹) |
| --- | ---: | ---: |
| 1 | 0.000215 | 0.0124 |
| 2 | 0.001424 | 0.0305 |
| 3 | 0.001274 | 0.111 |
| 4 | 0.002568 | 0.301 |
| 5 | 0.000748 | 1.14 |
| 6 | 0.000273 | 3.01 |

These commonly used thermal-fission U-235 group data sum to 0.006502. The prompt generation time, Λ = 10⁻⁴ s, is a generic assumption. The coefficients are not a transport calculation of a mixed-isotope commercial core. The equation structure is described in [Argonne's reactor-power-model documentation, §6.1](https://publications.anl.gov/anlpubs/2021/05/166771.pdf); background on delayed groups appears in the [DOE reactor-theory handbook](https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1019-93_VOL1.pdf).

### Reactivity and control

Net reactivity combines a rod-bank surrogate with linear fuel-temperature, moderator-temperature, and xenon feedback. Reference coefficients are −2 pcm/K, −12 pcm/K, and −80 pcm per unit normalized xenon deviation. They are chosen coefficients for this model, not universal PWR values. A bounded automatic rod controller responds to coolant-temperature and neutron-power errors. Manual mode applies a reactivity offset around the transferred rod state; the slider is not a physical rod position.

The electrical demand command is a fraction of **1,000 MWe net**. The feedforward schedule requests shaft power equal to `1000 × demand + auxiliaryLoad`. Dividing by current condenser-dependent conversion efficiency and 3,000 MW gives the reactor thermal target, capped at rated thermal power. The turbine-valve target similarly divides requested shaft power by the current steam pressure/enthalpy-based capacity. The rod controller and valve lag then move actual actuators; the command never directly assigns measured electrical or neutron power. Actual output can miss a requested load when thermal limits, cooling, or other constraints prevent it. A 50%-thermal initial state therefore starts with a 47.5%-net electrical demand.

### Decay heat and poisons

Six first-order heat inventories follow `dᵢ' = (fᵢ n − dᵢ)/τᵢ`. Fractions sum to 0.066; time constants are 1, 5, 25, 150, 1,000, and 10,000 s. Total thermal generation is `3000 × (0.934 n + Σdᵢ)` MW. This is an illustrative history-dependent approximation, **not an implementation of ANS-5.1**, a burnup/depletion calculation, or a fuel-specific decay library.

Normalized iodine follows fission production and radioactive decay. Xenon follows direct production, iodine decay, radioactive decay, and flux-dependent burnout. The model uses 6.57 h and 9.14 h half-lives and a generic full-power xenon removal coefficient. It describes slow whole-core poisoning, not spatial xenon oscillations. The distinction between decay, production, and burnout is covered by [DOE, reactor theory, volume 2](https://www.osti.gov/biblio/10144945).

## Heat and fluid systems

### Primary loop

The two thermal balances are

\[
C_f\dot T_f=Q_{thermal}-Q_{f\to p},\qquad
C_p\dot T_p=Q_{f\to p}-Q_{p\to sg}.
\]

Heat transfers use conductance times temperature difference. Both conductances scale with circulation to the 0.8 power. Pump speed has a 7 s lag; circulation is `0.08 + 0.92 × pumpSpeed`. The 8% floor is an assumed residual-circulation surrogate, not a buoyancy-driven natural-circulation calculation. Hot- and cold-leg temperatures are derived from the average coolant and `ΔT = Q/(ṁ cₚ)`; they are not separately integrated volumes.

Primary pressure responds to average-coolant temperature change with a simple compliance term and relaxes to its reference pressure over 45 s. This stands in for pressure regulation. There is no separate two-phase pressurizer volume, surge-line model, primary inventory/boration balance, leak model, or pressure-wave calculation.

### Steam generator and properties

The steam generator updates liquid inventory and energy using

\[
\dot M=\dot m_{feed}-\dot m_{steam},\qquad
\dot E=Q_{p\to sg}+\dot m_{feed}h_{feed}-\dot m_{steam}h_{vapor}.
\]

Stored energy is `E = Cmetal T + M h_liquid(T)`. Each step updates mass and energy, then solves the quadratic inverse for temperature. Steam pressure follows the saturation-temperature relation. This is a **lumped saturated-inventory approximation**: vapor holdup, void distribution, slip, moving boiling boundaries, shrink/swell, and steam-dryer behavior are omitted. Displayed level is the inventory fraction on the chosen full-mass scale.

Saturation pressure uses the published IAPWS Wagner correlation; its inverse is found by monotone bisection. The independent numerical checks use [NIST saturated-water tables](https://www.nist.gov/document/nistir5078-tab1pdf). Enthalpy is deliberately simpler:

\[
h_l(T)=0.00406625556T+1.25444444\times10^{-6}T^2
\quad\text{MJ/kg},
\]

with liquid coefficients fitted at 100 and 280 °C. Vaporization enthalpy uses a Watson exponent of 0.38, normalized to 2.2564 MJ/kg at 100 °C, and vapor enthalpy is their sum. Held-out checks at 200 and 300 °C bound errors at those points only. This is **not IAPWS-IF97** and does not establish a general accuracy envelope for compressed water, superheated steam, or near-critical states. The [IAPWS saturation release](https://iapws.org/technical-guidance/release/Supp-sat) supplies the pressure correlation, not the entire property model used here.

Automatic feedwater tracks steam outflow plus an inventory correction, with a 4 s actuator lag and a maximum flow. Turbine steam flow scales with valve opening and the square root of steam pressure. An idealized steam bypass opens on high secondary pressure and supplies a residual steam path after trip. It is not a plant-specific auxiliary-feedwater or emergency-cooling train.

### Turbine, electricity, and heat sink

Gross electrical power is turbine steam flow times the available cycle enthalpy difference times a calibrated conversion efficiency. Efficiency decreases with condenser temperature. Auxiliary load is `30 + 20 × pumpSpeed³` MW; the net meter therefore shows grid import after generator disconnection. A fixed infinite grid holds connected rotor speed at 3,000 rpm; a tripped rotor coasts down with a 45 s lag. Generator electromagnetic transients, shaft torsion, moisture separation/reheat, synchronizing procedures, and grid-frequency dynamics are absent.

The feed-heating train is an algebraic closure returning condensate to a fixed feed enthalpy. The condenser integrates rejected heat minus a conductance-based cooling-water heat sink. There is no cooling-tower weather model or separate condensate inventory. This reduced cycle is useful for interaction studies around its reference operating regime; it is not a full Rankine-cycle performance or equipment-sizing model.

## Protection, limits, and numerical behavior

Trips are latched. Initiating equipment faults and generic thresholds can insert a large negative rod worth, close the turbine path, and preserve decay heat. Clearing an equipment fault does not reset the reactor trip. Thresholds and reset conditions are software-model assumptions, not actual plant operating limits. `src/engine.js` is the authoritative definition.

The engine limits internal steps to 50 ms and integrates thermal/mass balances explicitly, with implicit kinetics and exact first-order relaxations. Reducing the caller step refines the coupled solution. Exiting a supported physical envelope creates a visible model-boundary event and halts advancement. The primary hot-leg diagnostic is checked against saturation temperature at the current primary pressure. In particular, primary boiling or exhausted steam-generator inventory is not followed into two-phase primary flow, dryout, or fuel-damage predictions.

The recorded energy residual compares stored energy change in **fuel + primary coolant + steam-generator liquid/metal** with nuclear heat and feed/steam enthalpy crossing that boundary. It excludes the condenser, generator, auxiliary equipment, and mechanical stores. A small residual confirms discrete bookkeeping for those nodes, not physical validity of the plant model.

Numerical verification, reference-property checks, and the missing validation evidence are described in [VALIDATION.md](VALIDATION.md). Scenario results and plots should always be interpreted together with these model assumptions.

## Deliberate exclusions

This release does not model cold startup/shutdown procedures, spatial neutronics, fuel depletion/refueling, boron chemistry, detailed instrumentation failure, LOCA, critical heat flux/DNBR, two-phase primary flow, ECCS, containment, radionuclide release, material damage, or severe accidents. It cannot predict whether a real plant is safe. Detailed reactor transport and CFD would require separate modeling tools and validation; this browser engine is not a substitute for them.

For an accessible description of the physical PWR energy path and major equipment, see the [NRC PWR overview](https://www.nrc.gov/reactors/power/pwrs). Those physical concepts motivate the topology, but the NRC document does not validate OpenPWR's parameters or transient results.
