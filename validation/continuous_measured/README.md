# Measured comparison of the continuous model's thermal kernel

This case runs **the same `ColdStartPlant` class composed by
`ContinuousPlant.thermal`** against the measured early Krško governor-closure
transient. The reference wrapper supplies hot initial states and external heat
and secondary-flow boundaries. It does not substitute a different pressure
model, reset a cold trajectory into a hot one, or run the whole continuous-plant
FMU. The interactive cold-start initialization remains a separate regression
case.

**Physical validation remains inconclusive.** This comparison does not validate
neutron kinetics, criticality approach, turbine runup, synchronization, plant
controls, or the complete cold-to-full-power startup. The
[source coverage audit](source-coverage.json) records measured startup examples
and why they do not supply an independently forced full-startup validation case.

## Reproduction

From the repository's configured Linux/WSL engineering environment:

```sh
npm run engineering:continuous:measured -- --build
```

The direct equivalent is:

```sh
python validation/continuous_measured/compare.py --build
python -m unittest discover -s validation/continuous_measured -p test_reference.py
```

This builds `artifacts/modelica/KrskoContinuousThermal.fmu`, binds it to its
`continuous-measured-manifest.json`, and writes
`artifacts/continuous-measured-validation.json`. The executable includes the
original wrapper and production model source plus reference metadata. The
runner rejects stale source, data, protocol, metadata, runner or FMU hashes.

## Measured data and independent predictions

The immutable data and extraction provenance are reused directly from
[`../krsko2005`](../krsko2005). The primary source is
[NUREG/IA-0221, *Reactor Trip Analysis at Krško Nuclear Power Plant*](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf).
Measured magenta instrument curves are used; blue RELAP5 calculations are
excluded. This event has already been inspected during OpenPWR development and
is **not a blind holdout event**.

The 0–15 s interval stops before operator reopening and reactor trip. Measured
pre-trip neutron power times the 1,994 MW core rating supplies a heat-input
proxy. Measured aggregate steam and feedwater flows are the other imposed
boundaries. Primary pressure, mean hot-leg and cold-leg temperatures, and mean
secondary pressure are held out as predictions. Eight acquired observations at
1, 3, …, 15 s are scored. Interpolated t=0 is displayed only to show initialization
bias.

[`parameters.json`](parameters.json) distinguishes published initial values,
nominal pump heat, generic volumes and capacities, and initial-only energy-rate
constructions. No post-initialization response fits a parameter. The shared
kernel divides the generic primary volume into equal hot and cold halves.
Indicated pressurizer level is an unverified volume-fraction approximation;
secondary inventory is assumed. Both vessels initially have zero cover gas at
the saturation temperature corresponding to the reported pressure.

The Table 2 steam/feedwater values determine the initial feedwater-enthalpy
construction. The time-series curves disagree with those tabulated flows; the
actual replay uses the curves unchanged, including their own initial mass
imbalance. Charging and letdown measurements remain in L/s because their
conversion conditions and inlet enthalpy are unavailable. Heater, charging and
letdown inputs are explicitly zero. The production kernel has no spray port;
the report's qualitative spray action therefore remains an omitted control,
not a measured zero-flow observation.

## Prospective numerical checks

[`protocol.json`](protocol.json) was frozen before the first shared-kernel run.
Its SHA-256 is
`256a36d82cee86fc4d9c3c03e29c7b074489f1ff219c2ff6847e735908817309`.
The nominal/refined communication steps are 0.05/0.025 s with a compiled CVODE
relative tolerance of `1e-11`. Independent mass/energy quadrature must close
within 0.05 kg/0.1 MJ. Maximum refinement differences must remain within
0.01 MPa or 0.05 K. These are numerical limits, **not measured prediction-error
acceptance bands**.

Every communication step retains the externally held inputs and primitive
native endpoint enthalpies, pump heat, heat rejection and vent fluxes. The
publication audit reconstructs these integrals, checks the original measured
forcing and state continuity, and independently recomputes errors from stored
inventories. It also recomputes metrics from the original CSV and native traces;
stored pass flags alone cannot establish a passing report. A tiny float
roundoff allowance in reconstructing a step from snapped endpoint timestamps
does not alter the prospective conservation limits.

The first completed comparison passes all 12 numerical checks. Its measured
errors remain much larger than the graphical reading allowances:

| Held-out response | RMSE | Maximum absolute error | Maximum step-refinement difference |
| --- | ---: | ---: | ---: |
| Primary pressure | 0.35737 MPa | 0.52190 MPa | 0.000198 MPa |
| Mean hot-leg temperature | 0.91361 K | 1.48608 K | 0.003989 K |
| Mean cold-leg temperature | 1.24470 K | 2.25638 K | 0.010136 K |
| Mean secondary pressure | 0.17841 MPa | 0.36275 MPa | 0.001784 MPa |

Both geometry sensitivities complete, with maximum pairwise spreads of
0.21444 MPa primary pressure, 4.98525 K hot-leg temperature, 6.63447 K cold-leg
temperature and 0.68280 MPa secondary pressure. The nominal independent
inventory errors are approximately 0.000067 kg and 0.000399 MJ. Small numerical
errors and large sensitivity to unidentified geometry do not establish plant
accuracy. Exact revision-bound values remain in the generated JSON report.

Generic geometry/capacity multipliers 0.5 and 2 are sensitivity experiments,
not fitted alternatives. Any domain exit retains its finite terminal
observation, executable and parameter identity, and `failed-domain` status.
The audit independently reconstructs the production state limits from the
saved temperatures, pressures, levels, gas inventories, flow and subcooling.
A failure requires a named, observed limit violation; a valid initial state
cannot be relabeled as a failed sensitivity. Completed trace observations must
remain inside the same production domain. Incomplete sensitivities cannot be
reported as complete or used to calculate a full-window spread. Nominal and
refined runs must complete. Measurement error, timing allowance and sensitivity
are reported separately; they are not combined into an invented instrument
uncertainty or physical pass band.

The source report does not identify all applicable plant geometry, actuator
histories, instrument responses or uncertainties. The reduced model also omits
distributed transport, wall heat storage and realistic steam-generator level
instrument behavior. The report preserves discrepancies and sets both
`validationPassed` and `physicalValidationPassed` to `false`.
