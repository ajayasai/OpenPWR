# Verification and validation status

OpenPWR includes numerical verification and reference-property checks. It has **not** been validated against a specific plant's measured transient data, qualified operator simulator, or an independently validated whole-plant code. Passing these tests does not establish physical accuracy outside their stated scope.

## Reproduce the checks

Use Node.js 22 or newer, from the repository root:

```sh
npm test
```

`tests/engine.test.js` contains implementation-level regression checks. `tests/validation.test.js` supplies a separately implemented numerical reference and system behavior checks. Both run against the same engine module used by the interface. The tests need no network service, downloaded nuclear data, proprietary solver, or runtime package dependency.

## Evidence and acceptance criteria

| Check | Independent evidence or acceptance criterion | What it establishes |
| --- | --- | --- |
| Saturation pressure | NISTIR 5078 Table 1 at 100, 200, 280, and 300 °C; relative pressure error below 0.05%, inverse temperature error below 0.03 °C. | Implementation of the saturation-pressure correlation agrees with these external tabulations. |
| Approximate enthalpy | NIST liquid, vapor, and vaporization enthalpies at 200 and 300 °C; errors below 3%. These are held-out points, not liquid-fit endpoints. | A limited check on the simplified property closure, not a global accuracy bound or IF97 compliance. |
| Six-group kinetics | A separate 7×7 constant-reactivity matrix exponential, evaluated with Taylor scaling and squaring; five reactivities, 5 s horizon, 1 ms production step, relative state error below 0.15%. | Numerical agreement for the specified linear initial-value problems. It does not test spatial core behavior. |
| Kinetics refinement | Halve the step from 40 to 20 ms for a 100 pcm, 10 s problem; error against the matrix exponential must decrease by at least 30%. | Convergence of the chosen time integration for this case. |
| Initial equilibria | Full and half power for 300 s: thermal/electric drift below 1%, hot-leg drift below 0.5 °C, level drift below one percentage point, no trip. | The constructed steady states remain steady. Nominal power is a calibration target, not external validation. |
| Load response | A 70% demand command leaves measured power initially unchanged, then produces a material reduction and settles within 2 MWe of the 700 MWe net target by 600 s without tripping. | Causal, plausible control interaction under this generic scenario. The tolerance is a software acceptance criterion, not a real-plant ramp specification. |
| Coupled refinement | Compare a 120 s, 80% demand transient at 50 and 25 ms caller steps; selected thermal, electrical, pressure, and level outputs differ by less than 1%. | Step-size consistency for this coupled transient, not agreement with measured plant behavior. |
| Energy diagnostic | During a 120 s load transient, the reported modeled-thermal-volume residual stays below 0.001 MW. | Regression protection for the implemented discrete energy accounting. This is not an independent validation of its closure assumptions. |
| Reactor trip | Fuel temperature is continuous at trip; neutron power falls and residual decay heat remains. | The trip cannot directly overwrite temperatures or erase decay inventory. |
| Fault and trip latching | A primary-pump fault produces a reactor trip; active fault inhibits reset; clearing fault does not itself clear the trip. | Correct simulator protection state transitions. |
| Replay | Save during a transient, pass through JSON, import into a second engine, and continue both with identical inputs. | Identical continuation of numerical state. |
| Invalid input | Invalid state objects, unknown controls/faults/fields, nonfinite values, oversized arrays and strings, physically impossible finite inventories, malformed events, and unflagged primary-boiling states are rejected without changing the valid existing state. | Integrity of the public engine API and saved-state boundary. |

See the current automated run for pass/fail results. This document defines the checks rather than embedding a result count that can become stale.

## Interpretation of the energy diagnostic

The energy residual is a **numerical bookkeeping diagnostic for the modeled thermal control volumes**, not a percentage measure of model realism. An exactly conservative discretization can still use an inaccurate physical closure. The steam-generator closure, turbine conversion, and condenser assumptions must therefore be evaluated separately. Electrical efficiency alone is not a validation result.

## External validation still needed

Before using the model for quantitative engineering decisions, the project needs independently specified reference cases, parameter provenance, calibration/validation separation, uncertainty analysis, and expert review. A credible next validation campaign would include:

1. Measured or published load-change and reactor-trip traces with clearly stated initial conditions and controller behavior.
2. Steam-generator inventory and pressure response, pump coastdown, and condenser backpressure comparisons.
3. Sensitivity to thermal capacities, transfer coefficients, rod-control gains, decay heat, and poison parameters.
4. A complete property-domain error survey and comparison with an open implementation of IAPWS-IF97 or IAPWS-95.
5. Independent review of protection logic and numerical-domain handling. Generic trip settings are not technical specifications for an actual plant.

Features outside the documented model domain require additional equations and evidence, not just additional buttons or wider slider limits.

## References

- [NISTIR 5078](https://www.nist.gov/srd/nistir-5078), A. H. Harvey, *Thermodynamic Properties of Water*, with [Table 1: saturation versus temperature](https://www.nist.gov/document/nistir5078-tab1pdf). Temperatures, pressures, and specific enthalpies are externally tabulated reference values.
- [IAPWS SR1-86(1992)](https://iapws.org/technical-guidance/release/Supp-sat), saturation-property formulation. Use of one correlation does not make the whole simulator an IAPWS-compliant property package.
- [Argonne reactor power models](https://publications.anl.gov/anlpubs/2021/05/166771.pdf), §6.1, for the point-kinetics initial-value problem and matrix representation. The reference numerical solver in the test is independently implemented here.

No organization cited above endorses OpenPWR.
