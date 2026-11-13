# Prospective pressure-development comparison

This package preserves the released v0.10 measured comparison and fixes the
criteria for a paired production-pressure investigation **before candidate
scoring**. Krško has already been inspected during model development. Better
agreement on this event would be a development result, not independent plant
validation, full-startup validation or full-scope qualification.

The initial protocol fixes the metrics and guards. The separately frozen
`candidate-config.json` selects the finite-phase formulation and Doel model
wall analogue before its first execution. `reference.py` contains reference
integrity, error scoring and paired acceptance logic; it does not fit a model.

## Immutable release evidence

[`../baselines/continuous-measured-v0.10.json`](../baselines/continuous-measured-v0.10.json)
is an exact byte copy of the public
[v0.10.0 release](https://github.com/ajayasai/OpenPWR/releases/tag/v0.10.0)
asset, including its historical metadata and conclusion:

- Commit: `780d7af4c8dfb7e9fb51aeaa99244f3e32ce414d`
- Report size: 2,421,428 bytes
- Report SHA-256: `f2b32994e9205f13c3f841684ba1ad0f628d77ab60b310edf7dbebb5ca030d5a`
- Native FMU SHA-256: `448788ee854c6550e56234502949e8e71833f1d857525aa844e9bd2b1c19e058`

The digest matches the published release asset metadata. The baseline must not
be restamped as a new run or changed when implementation details evolve.
[`protocol-initial.json`](protocol-initial.json) has SHA-256
`1e1e4c21730c12b68b69a7628130e7365c6ff17851860612ef33c3b5347ac408`.
The existing v0.10 protocol and original measured CSV remain unchanged.

## What the released discrepancy shows

The reference is the measured 10 April 2005 governor-closure event in
[NUREG/IA-0221](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf).
The same eight acquired observations at 1, 3, …, 15 s are scored. The window
ends before operator reopening and trip. Measured heat input and aggregate
steam/feedwater flows remain imposed boundaries; the four pressure and
temperature responses remain predictions.

| Released held-out response | RMSE | Maximum absolute error |
| --- | ---: | ---: |
| Primary pressure | 0.357371 MPa | 0.521902 MPa |
| Mean hot-leg temperature | 0.913612 K | 1.486076 K |
| Mean cold-leg temperature | 1.244698 K | 2.256379 K |
| Mean secondary pressure | 0.178408 MPa | 0.362752 MPa |

At 11 s, measured primary pressure is 16.087244 MPa, versus 15.565342 MPa
predicted by the released production kernel. Relative to t=0, those rises are
approximately 0.610934 and 0.085342 MPa. At the same time the model's liquid
volume fraction reaches 60.77%, compared with a measured indicated level of
58.49%. The indicated-level-to-volume transfer function is unknown, so this
comparison is diagnostic, not a validated volume error. The large pressure
shortfall despite substantial modeled warming and displacement points toward
pressure compliance and phase response as issues to investigate; it does not
identify a unique missing coefficient.

The separately released adiabatic two-temperature model is also informative:
at 5 s its pressure is 15.6898 MPa versus 15.6964 MPa measured, but by 15 s it
predicts 17.1402 MPa versus 15.9396 MPa measured. Its overall pressure RMSE is
0.6941 MPa, worse than the equilibrium result. Additional phase states alone
therefore do not establish better plant prediction. Thermal contact,
condensation, spray, unidentified inventories and transport remain distinct
potential explanations; a parameter chosen from these observed discrepancies
would be a development choice rather than an independently measured property.

Published charging and letdown are in L/s. Their difference cannot establish a
mass imbalance without the two meter reference conditions; a volumetric sign
need not equal the mass-flow sign. Spray action is described qualitatively,
but a numeric measured spray schedule is not available. Neither control may
be reconstructed from held-out pressure and then presented as an independent
forcing measurement.

## Paired numerical and development guards

The first paired cases preserve initial conditions, generic geometry, fuel
capacity and measured boundary histories. A current-code equilibrium ablation
must reproduce the immutable release within the frozen numerical tolerances.
Both it and the candidate must complete at 0.05 and 0.025 s communication steps,
using compiled relative tolerance `1e-11`, with independent mass and energy
closure within 0.05 kg and 0.1 MJ. All new stored energy must be included in
the ledger. Required primary and refined runs cannot be truncated or
extrapolated into a pass.

The candidate's primary-pressure RMSE, change-from-initial RMSE and maximum
absolute error must improve versus **both** the release and current-code
equilibrium ablation beyond the predeclared communication-refinement
allowance. RMSE and maximum absolute error in the other three channels must
not worsen beyond their corresponding allowance. Every signed difference is
reported even when a guard passes. A failed refinement check cannot enlarge
the allowance to hide a regression.

These guards prevent a pressure-only score from hiding larger thermal errors.
They are relative development criteria, not measurement-uncertainty bounds or
physical acceptance bands. A failed candidate remains publishable as an
explicit experimental result, but cannot be promoted as passing or as an
unqualified improvement to production accuracy. Existing cold-start,
continuous-startup, property and conservation regressions remain required.

Acquired-sample pressure peaks, peak times and final changes are reported
separately. These do not invent sub-sample time precision or estimate a
continuous measured peak. Indicated pressurizer level is an additional
diagnostic with its unresolved sensor mapping stated explicitly.

## Retained failed attempt and numerical changes

The first four-case experiment completed all 76 numerical checks. Its finite
phase and wall candidate increased primary-pressure RMSE to 0.679390 MPa,
hot-leg RMSE to 1.399278 K and cold-leg RMSE to 1.390429 K; secondary-pressure
RMSE was 0.177715 MPa. Only 4 of 18 paired development guards passed. These
results are preserved rather than replacing the original candidate with a
better-scoring assumption after observing it.

`original-attempt-summary.json` retains exact acquired-sample curves and
metrics. The complete report, four FMUs and manifests, exact source/reference
bytes, archival README and source audit are also retained in
[`../baselines/krsko-pressure-initial-v011.zip`](../baselines/krsko-pressure-initial-v011.zip)
(9,625,284 bytes; SHA-256
`fe622629b2343e351467fc31b8054b0e628cd3493a38ea4e49f886168be99b42`).
This archive is a historical dirty development attempt, not a clean current
release or a qualification result. Its source hashes and executable bytes
were checked against the archived report. The full-archive retention decision
explicitly supersedes the earlier no-shipping plan recorded in the immutable
summary.

Independent cold-heating checks subsequently exposed numerical Jacobian
problems. The complete pre-scoring decision record is preserved:

- `regularization-amendment.json` records a proposed 1e-4 K C1 phase-transfer
  regularization. That constitutive proposal was rejected before any updated
  or conditional-spray measured scoring.
- `coordinate-amendment.json` records exact affine translations of five fluid
  states about their initial values. Physical equations and physical initial
  states remain unchanged; numerical perturbation/error coordinates change.
- `final-numerics-amendment.json` restores the original `max(0, superheat)`
  transfer law, retains the offset coordinates, and records a fourth-root
  continuation for inadmissible nonlinear trial states. Accepted wall states
  must still satisfy the original nonnegative film-correlation argument.

Every original zero-spray case is rerun and compared against the archived
acquired nominal and refined curves, producing 16 additional reproduction
checks with unchanged limits. The eight unmeasured component experiments
independently exercise closed equilibrium, compression, venting, wall-mesh
refinement, coupled cold heating and conservative internal spray. Their
results do not constitute measured component qualification.

## Separately declared conditional spray experiment

`conditional-spray-config.json` freezes a separate, openly response-informed
development hypothesis before its executions. The native pressure controller
uses a 15.51 MPa reference from NUREG/IA-0227, the existing generic gain of
2 fraction/MPa, a declared 20.67 kg/s flow cap and ideal contact efficiency 1.
NUREG/IA-0020 reports 20.67 kg/s as a **calculated operating flow** at
732.32 kg/m³, corresponding to about 101.5 m³/h; its separate nominal design
value is 102 m³/h. Treating the calculated flow as a controller cap is an
assumption, not a measured Krško spray capacity. The initial wording and its
source-only correction remain in `conditional-spray-config-initial.json` and
`conditional-spray-amendment.json`; numerical selections did not change.

Cold-leg mass and enthalpy flow into the pressurizer and remain within the
plant inventory. The controller is evaluated natively from simulated
pressure; no measured spray history is inferred from the response. The
preselected nominal case is retained alongside gain 1, gain 4, contact
efficiency 0.5 and wall-mesh refinement. All ten runs, all four response
channels and every case's paired guards are disclosed. A favorable sensitivity
cannot replace the nominal result. The conditional report has 88 numerical
checks; the original report retains its own 76 checks and failed guards.

Even a passing conditional improvement does not establish actual plant
control behavior, independent validation or promotion of the finite-phase
model to the production default. The equilibrium model remains the default.

The completed experiment passes all 76 original numerical checks, 88
conditional numerical checks, 67 component checks and 16 original-attempt
reproduction checks. It **does not establish an accuracy improvement over the
released model**. The nominal conditional pressure RMSE is 0.425981 MPa,
compared with 0.357371 MPa in the release and 0.679391 MPa in the original
finite-phase candidate. Hot/cold RMSE is 1.284295/1.372618 K, also worse than
the released 0.913612/1.244698 K. All five conditional cases pass only 4 of
18 development guards; no sensitivity is substituted for the preselected
nominal case.

| Conditional assumption | Primary pressure RMSE (MPa) |
| --- | ---: |
| Nominal gain 2, contact efficiency 1 | 0.425981 |
| Gain 1 | 0.467004 |
| Gain 4 | 0.403160 |
| Contact efficiency 0.5 | 0.541097 |
| Refined wall mesh | 0.425973 |

Spray reduces the error of the failed finite-phase candidate in this test,
but it does not surpass the existing equilibrium model. These adverse
results are retained as evidence about the limitations of the proposed
closure and unknown plant controls; they do not justify a more favorable
production-accuracy claim.

## Reproduction and integrity tests

```sh
python -m unittest discover -s validation/krsko_pressure -p 'test*.py'
python validation/krsko_pressure/component_checks.py
python validation/krsko_pressure/compare.py --build
```

Tests reproduce all original error metrics exactly from the immutable native
traces and measured CSV, reject missing adverse channels, prevent an unchanged
model being called improved, and distinguish a synthetic paired-guard pass
from physical or independent validation. They also reject omitted or
substituted sensitivities, changed controller parameters, forged displayed
curves, inventory errors and accepted-domain violations. No synthetic test
fixture is a plant simulation result. Native commands require OpenModelica
with Modelica 4.0.0 and the project's engineering Python dependencies; the
normal CI/npm workflow supplies this environment. The comparison hashes all
sources, frozen records and binaries and refuses mixed or stale evidence.
