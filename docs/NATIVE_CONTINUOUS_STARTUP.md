# Continuous native cold-to-power model

`ContinuousPlant` extends the native engineering laboratory to one continuous
trajectory: cold water and a subcritical neutron population, fission heatup,
source removal, shaft acceleration, electrical synchronization, and a nominal
1,000 MWe endpoint. It uses one FMI instance and retains the same physical
inventories throughout. The control experiment is a generic software exercise,
not a named plant's operating procedure.

This is a reduced-order model, not a qualified full-scope training simulator.
The new evidence verifies equations, conservation, numerical convergence and
published point-kinetics answers. It does **not** establish agreement with a
measured full-plant cold-start transient. `physicalValidationPassed` therefore
remains `false` in every verification report.

## Native equations

The neutron population `n` is normalized to nominal fission power. Each delayed
precursor `z_i` is normalized to its equilibrium population at that same power:

```text
dn/dt   = ((rho - sum(beta_i)) n + sum(beta_i z_i)) / Lambda + S
dz_i/dt = lambda_i (n - z_i)
```

Here `rho` is dimensionless reactivity; a control value in pcm is multiplied by
`1e-5`. The source `S` has units of normalized neutron population per second.
For fixed negative reactivity, the stationary source-driven solution is
`n = z_i = -S Lambda / rho`. At zero source and zero reactivity, any constant
positive `n = z_i` is a critical equilibrium. These are different test cases.
The distinction follows the source-multiplication and criticality discussion in
[DOE-HDBK-1019/2-93](https://www.energy.gov/documents/doe-hdbk-1019-93vol2).

Native rods have finite speed; fuel and coolant temperature feedback contribute
to reactivity. The power request changes a reactivity controller. It never sets
`n`, fuel temperature or reactor heat directly. The external source is removed
during the declared full-startup experiment, before the final power plateau.
The generic controller gain is 40 pcm per natural-log power-ratio error, with a
bounded reactivity target and finite rod movement. This is an engineering
design choice, not a parameter fitted to a measured startup transient.

Fission heat is `3000 * (1 - 0.066) * n` MW. Six phenomenological decay groups
satisfy `dD_i/dt = (f_i n - D_i) / tau_i`, and decay heat is `3000 sum(D_i)` MW.
Thus equilibrium `n = 1` corresponds to 3,000 MW **including** decay heat; fission
heat alone is 2,802 MW. The transient decay approximation is not a qualified
isotopic inventory calculation.

The existing water/gas primary and secondary vessels remain in the same model.
They use IF97 liquid/vapor properties and an ideal nitrogen cover gas. Native
steam and feedwater ports connect the secondary inventory to a finite condenser
and a turbine. Pressure remains an integrated thermodynamic state; it is not
replaced by a prescribed hot-pressure value at criticality or synchronization.

With normalized shaft speed `w = rpm / 3000`, rotor energy is
`E_rotor = 4200 w^2` MJ. The differential shaft-speed equation applies finite
steam, friction and electrical torques, so a shaft initially at rest can begin
moving without an artificial energy floor. Shaft work initially vanishes at
zero speed; unconverted steam enthalpy stays in the exhaust energy balance.

The electrical angle is continuous and unwrapped internally. Its derivative is
`2 pi (f_generator - f_grid)`. Frequency, terminal voltage and wrapped angle are
tested before the breaker closes. The generic thresholds are 0.002 Hz, 0.01 pu
and 0.5 degrees, maintained for five seconds. These are model design choices,
not plant settings derived from measurements. Speed and excitation coordination
are consistent with the [US Bureau of Reclamation's description of a generator
synchronizer](https://www.usbr.gov/uc/special/20230100-UCToday.html). The breaker
changes electrical torque; it does not reset speed, angle or thermal state.

The turbine has a separate emergency steam stop valve in series with its
two-second governor valve. The stop valve is initially armed/open; the governor
still controls whether steam is admitted. A latched turbine trip closes the
stop valve with a finite 0.2-second first-order response. Neither valve resets
the shaft state. An isolated native test compares stop-valve motion with the
independent exponential solution using a prospectively fixed `2e-6` absolute
fraction tolerance.

## Conservation boundary

The thermal/mechanical control volume contains primary and secondary fluid,
cover gas, fuel thermal storage, condenser water and rotor kinetic energy.
Fission plus released decay heat enters as the nuclear thermal source. Unreleased
decay inventory and nuclear binding energy are outside this control volume.

Steam/feedwater transfers cancel internally. External energy terms include
primary pump heating, feed-pump work, pressurizer heaters, charge/letdown
enthalpy, gas/steam vent enthalpy, shutdown and condenser cooling, condenser
displacement work, shaft friction, exported generator power and generator loss.
The auxiliary electric demand is reported in net plant power; only the portion
entering the modeled thermal/mechanical inventories belongs in this boundary.

The verifier checks physical inventory changes against native integrated fluxes
and independently summed/trapezoid-integrated boundary fluxes. It reconstructs
controlled flows and electrical work using the **held inputs at both endpoints**
of each communication step, avoiding stale FMI algebraic outputs at a control
jump. Thermodynamic enthalpies and condenser displacement work remain shared
closure primitives; this is an independent accounting/quadrature check, not an
independent second thermohydraulic code.

## Prospective verification

The initial acceptance protocol was frozen before candidate scoring and is
preserved in `validation/continuous/protocol-initial.json`. Its first amendment,
also before scoring, changed only the communication grids from 5/2.5 seconds to
0.5/0.25 seconds to resolve the added kinetics and synchronization dynamics.
The limits stayed unchanged. Both protocol versions and the reference answers
are content-hashed and bound to the FMU build/report.

| Check | Independent reference and acceptance |
| --- | --- |
| Source equilibrium, negative/positive steps, critical equilibrium, source removal | Augmented 8-by-8 matrix exponential including the affine source; all seven states compared; relative error at most `2e-5`, or `2e-6` for equilibria |
| Published kinetics | Twelve values from CATS Tables 2a/b with Thermal Reactor I parameters; relative error at most 0.1% |
| Synchronization | Separate physically initialized wrong-speed, wrong-phase and wrong-voltage cases; an admissible lossless rotor accepts only after native dwell; no state overwrite |
| Emergency stop valve | Native closure after a trip compared with the independent 0.2-second exponential; absolute fraction error at most `2e-6` |
| Whole-plant conservation | Native inventory residual at most 10 MJ / 0.5 kg; independent boundary quadrature at most 1,000 MJ / 10 kg |
| Instantaneous conservation | Residual at most `1e-6` MW / `1e-6` kg/s |
| Pressure equation | Independent IF97 region-4 vapor-pressure formula plus gas law; closure within 50 Pa |
| Rotor energy | Independent speed-to-kinetic-energy identity within `1e-5` MJ |
| Full default cold trajectory | Initial thermal inventories 40 C, zero shaft speed, subcritical and off grid; one FMU instance without reset |
| Full-power dwell | Final 600 seconds at 975–1,025 MWe and normalized neutron population 0.98–1.02, grid connected, external source off |
| Communication refinement | 0.5 vs 0.25 seconds: temperature within 0.1 K, pressure 0.02 MPa, power 10 MW, shaft speed 5 rpm, neutron population 0.005 |
| Trip | Continue the same cold-to-full-power instance into a native trip, with source-free fission reduction, retained decay heat, breaker opening and conservation |

The published values come from [Ganapol, *A Precision Benchmark Suite for Nuclear
Reactor Point Kinetics Equations via CATS* (2024)](https://arxiv.org/pdf/2406.11822),
Tables 2a/b on printed page 17, with the Thermal Reactor I parameters in Table
A.II on printed page 56. They are pre-existing numerical reference answers,
not outputs generated by this project and not measured plant data. Tests
initialize the production model at low neutron power with rods held at the
specified reactivity and thermal feedback disabled. Linear homogeneity permits
comparison of `n(t)/n(0)` with the unit-initial-power reference without heating
the coupled plant outside its cold envelope.

The independent pressure relation is [IAPWS IF97 region 4, equation
30](https://iapws.org/technical-guidance/release/IF97-Rev). It checks drift in the
chosen water/gas equation, not the accuracy of the ideal gas mixture or vessel
geometry against a particular pressurizer experiment.

Run the prospective verification after building the native artifact:

```sh
python backend/verify_continuous.py \
  --fmu artifacts/modelica/ContinuousPlant.fmu \
  --output artifacts/continuous-verification.json
```

The report includes every scenario's parameter changes, control schedule,
retained trace, communication step, solver tolerance and FMU identity. Full
startup/refinement cases use `{}` initialization parameters, so the ordinary
40 C default must work. A runtime/domain failure fails verification; partial
traces cannot become a full-trajectory pass. Numerical limits cannot silently
change to accommodate failed results.

The first complete cold-to-power candidate passed the startup checks but failed
the same-instance trip: at 27,004 seconds, shaft speed reached about 3,603 rpm
and exceeded the declared model domain. A two-second governor left residual
steam admission after electrical load rejection. That failed candidate was
retained in development evidence. The correction added the separate finite
stop valve described above; it did not widen the operating domain, relax a
verification limit, change the prescribed experiment or reset the rotor. The
new stop-valve analytic criterion was declared before scoring the corrected
candidate.

The next trip diagnostic kept shaft speed within its domain but exposed a
second missing control: pressure-only steam dumping continued cooling the
primary after the trip. Thermal contraction reduced pressurizer liquid volume
below its 3% domain boundary at about 27,023.5 seconds. Mass and energy remained
conservative; the inventory excursion was a modeled control failure. The
post-trip steam-dump control therefore also limits admission as mean primary
temperature approaches a generic 300 C standby target. This limits a valve
request, retains the finite actuator and inventory equations, and does not
impose or reset temperature, pressure or liquid volume. The 300 C target is a
declared controller design assumption, not a measured plant setting.

## Remaining scope

The turbine efficiency is a declared nominal calibration, not a measured
turbine map. At the declared 6 MPa nominal secondary pressure, nominal steam
flow is `3000e6 / (h_steam - h_condensate - w_feedpump)` kg/s. Effective turbine
efficiency is chosen as

```text
eta_t = [((1000 + 50) / 0.985 + 2) * 1e6]
        / [nominal_steam_flow * nominal_isentropic_enthalpy_drop]
```

The 1,000 MWe net target, 50 MW nominal auxiliaries, generator efficiency 0.985
and 2 MW nominal shaft friction are declared design assumptions. Recovering
approximately 1,000 MWe near the nominal thermal condition is therefore a
consistency check, not independent validation of turbine performance.

The generator uses angle-dependent synchronizing torque, speed damping,
continuous shaft/phase states and a finite excitation response. It has no DQ
current model, AVR/PSS, magnetic-field energy storage or network fault
transients. Its synchronizing coefficient and damping are generic model
parameters, not qualified machine data.

The point model does not resolve spatial core behavior, actual rod
bank worth, boron mixing, xenon/samarium inventories, detailed steam-line waves,
electrical network faults or plant-specific control/protection logic. Auxiliary
and other hot-plant systems from separate profiles are not automatically part
of this continuous model. Published measured-transient work elsewhere in this
repository does not by itself validate this new cold-to-power configuration.
Further qualification requires independent measured cases with documented
instrument uncertainties, boundary conditions and acceptance criteria.

## Measured coverage in v0.10

`KrskoContinuousThermal` now instantiates the same `ColdStartPlant` class as this model. Published initial conditions and disclosed generic parameters configure a 15 s measured-boundary reference replay. The default 40 C startup remains unchanged. This directly tests shared thermal equations; imposed reactor power and secondary flows exclude native kinetics, cycle controls and electrical response from the comparison. See [measured coverage and source audit](STARTUP_MEASURED_EVIDENCE.md) and the [reference case](https://github.com/ajayasai/OpenPWR/tree/main/validation/continuous_measured).
