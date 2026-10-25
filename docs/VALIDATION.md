# Verification and validation status

OpenPWR includes numerical verification and comparisons against published point-kinetics and water-property benchmarks. It has **not** been validated against a specific plant's measured transient data, qualified operator simulator, or an independently validated whole-plant code. Passing component benchmarks does not establish physical accuracy of cold startup or the whole plant.

## Reproduce the checks

Use Node.js 22 or newer, from the repository root:

```sh
npm test
npm run verify
```

`tests/engine.test.js` contains implementation-level regression checks. `tests/validation.test.js` supplies a separately implemented numerical reference and system behavior checks. `tests/startup.test.js` exercises cold initialization, action continuity, grid connection, startup refinement, trips, replay, and saved-state migration. `tests/benchmarks.test.js` checks published component references and the property cache; [BENCHMARKS.md](BENCHMARKS.md) gives precise provenance, conditions, and limits. The tests use the same production functions and engine as the interface. No network service, downloaded nuclear data, proprietary solver, or runtime package dependency is needed.

`npm run verify` generates separate system-verification and published-benchmark JSON reports. The startup report includes one-minute trace data and applied action timestamps. Builds reject unsuccessful reports and reports from a different source commit or package version.

## Evidence and acceptance criteria

| Check | Independent evidence or acceptance criterion | What it establishes |
| --- | --- | --- |
| Saturation pressure | NISTIR 5078 Table 1 at 100, 200, 280, and 300 °C; relative pressure error below 0.05%, inverse temperature error below 0.03 °C. | Implementation of the saturation-pressure correlation agrees with these external tabulations. |
| Production enthalpy | NIST liquid, vapor, and vaporization enthalpies at 200 and 300 °C; errors below 0.05%. The published benchmark report additionally compares liquid/vapor values across 20–350 °C. | Actual IF97-derived production property functions at the stated saturated-water points; not whole-cycle accuracy. |
| Published kinetics and IF97 tables | CATS negative-step/zigzag cases, official IF97 verification values, and NIST anchors; exact inputs/tolerances in BENCHMARKS.md. | Equation verification and component reference agreement. Fine-step kinetics results do not establish the same tolerance at the 50 ms interactive step. |
| Six-group kinetics | A separate 7×7 constant-reactivity matrix exponential, evaluated with Taylor scaling and squaring; five reactivities, 5 s horizon, 1 ms production step, relative state error below 0.15%. | Numerical agreement for the specified linear initial-value problems. It does not test spatial core behavior. |
| Kinetics refinement | Halve the step from 40 to 20 ms for a 100 pcm, 10 s problem; error against the matrix exponential must decrease by at least 30%. | Convergence of the chosen time integration for this case. |
| Initial equilibria | Full and half power for 300 s: thermal/electric drift below 1%, hot-leg drift below 0.5 °C, level drift below one percentage point, no trip. | The constructed steady states remain steady. Nominal power is a calibration target, not external validation. |
| Load response | A 70% demand command leaves measured power initially unchanged, then produces a material reduction and settles within 2 MWe of the 700 MWe net target by 600 s without tripping. | Causal, plausible control interaction under this generic scenario. The tolerance is a software acceptance criterion, not a real-plant ramp specification. |
| Coupled refinement | Compare a 120 s, 80% demand transient at 50 and 25 ms caller steps; selected thermal, electrical, pressure, and level outputs differ by less than 1%. | Step-size consistency for this coupled transient, not agreement with measured plant behavior. |
| Energy diagnostic | During a 120 s load transient, the reported modeled-thermal-volume residual stays below 0.001 MW. | Regression protection for the implemented discrete energy accounting. This is not an independent validation of its closure assumptions. |
| Reactor trip | Fuel temperature is continuous at trip; neutron power falls and residual decay heat remains. | The trip cannot directly overwrite temperatures or erase decay inventory. |
| Fault and trip latching | A primary-pump fault produces a reactor trip; active fault inhibits reset; clearing fault does not itself clear the trip. | Correct simulator protection state transitions. |
| Replay | Save during a transient, pass through JSON, import into a second engine, and continue both with identical inputs. | Identical continuation of numerical state. |
| Cold-to-power sequence | Begin at 25 °C, follow measured permissives, heat the same inventories, accelerate the rotor, connect, and load the plant. Check continuity at every action and compare stored-energy gain with integrated boundary inputs. | End-to-end operation and bookkeeping within the generic cold-start model; no measured startup trace is used. |
| Cold-step refinement | Repeat the early heatup at 50 and 25 ms; selected state differences below 0.5%. | Numerical consistency for that scenario, not an overall startup accuracy estimate. |
| Legacy migration | Import a real v0.1.0 transient fixture generated by the released source, preserve thermal/nuclear states, then continue. | Compatibility of state migration; changed property equations mean continuation across releases need not be bit-identical. |
| Invalid input | Invalid state objects, unknown controls/faults/fields, nonfinite values, oversized arrays and strings, physically impossible finite inventories, malformed events, and unflagged primary-boiling states are rejected without changing the valid existing state. | Integrity of the public engine API and saved-state boundary. |

See the current automated run for pass/fail results. This document defines the checks rather than embedding a result count that can become stale.

## Interpretation of the energy diagnostic

The energy residual is a **numerical bookkeeping diagnostic for the modeled thermal control volumes**, not a percentage measure of model realism. An exactly conservative discretization can still use an inaccurate physical closure. The steam-generator closure, turbine conversion, and condenser assumptions must therefore be evaluated separately. Electrical efficiency alone is not a validation result.

## External validation still needed

Before using the model for quantitative engineering decisions, the project needs independently specified reference cases, parameter provenance, calibration/validation separation, uncertainty analysis, and expert review. A credible next validation campaign would include:

1. Measured or published load-change and reactor-trip traces with clearly stated initial conditions and controller behavior.
2. Steam-generator inventory and pressure response, pump coastdown, and condenser backpressure comparisons.
3. Sensitivity to thermal capacities, transfer coefficients, rod-control gains, decay heat, and poison parameters.
4. Independent property-domain checks beyond the sampled IF97/NIST points, plus pressure-dependent primary/feedwater closures and a complete cycle state model.
5. Independent review of protection logic and numerical-domain handling. Generic trip settings are not technical specifications for an actual plant.

Features outside the documented model domain require additional equations and evidence, not just additional buttons or wider slider limits.

The cold-start heat source, pressure support, primary thermal capacity, turbine inertia/losses, and controllers remain generic assumptions. A successful cold-to-grid run is not a published plant benchmark. The [full-scope roadmap](ROADMAP.md) identifies the component and whole-plant data still needed.

## References

- [NISTIR 5078](https://www.nist.gov/srd/nistir-5078), A. H. Harvey, *Thermodynamic Properties of Water*, with [Table 1: saturation versus temperature](https://www.nist.gov/document/nistir5078-tab1pdf). Temperatures, pressures, and specific enthalpies are externally tabulated reference values.
- [IAPWS SR1-86(1992)](https://iapws.org/technical-guidance/release/Supp-sat), saturation-property formulation. Use of one correlation does not make the whole simulator an IAPWS-compliant property package.
- [Argonne reactor power models](https://publications.anl.gov/anlpubs/2021/05/166771.pdf), §6.1, for the point-kinetics initial-value problem and matrix representation. The reference numerical solver in the test is independently implemented here.

No organization cited above endorses OpenPWR.
