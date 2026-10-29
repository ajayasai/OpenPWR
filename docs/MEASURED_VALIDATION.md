# Measured comparisons: plant transient and independent component experiment

**Plant validation is inconclusive.** OpenPWR now executes a native thermal/inventory replay against published operating-plant measurements. The discrepancies are retained in the evidence report. A completed calculation is not a validation pass, and this case does not establish full-scope simulator accuracy.

## Primary source and reproducible reference

The reference is [NUREG/IA-0221, *Reactor Trip Analysis at Krško Nuclear Power Plant*](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf), by Andrej Prošek and Borut Mavko, published by the U.S. NRC in January 2010 (ADAMS ML100680300). It describes the **10 April 2005** governor-valve closure at the two-loop Krško PWR. The report has a conflicting April 5 sentence; [NEK's 2005 annual report](https://www.nek.si/upload/publications/nek_annual_report_2005.pdf) independently confirms April 10. The report identifies a 1,994 MW core thermal rating and 6 MW pump heat after the uprate; this is a distinct plant from OpenPWR's generic 1,000 MWe plant.

The [checked-in CSV](https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/measured.csv) contains 50 acquisition times, at 2 s intervals from −49 to 49 s, for 15 measured instrument channels and derived loop aggregates. The [extractor](https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/extract.py) reads the magenta measured vector paths in Figures 22–26, 29–34 and 37–40, panel (a). It rejects the blue curves labeled `cal`, which are RELAP5 calculations. It checks the source PDF's SHA-256, page and instrument identities, curve count and acquisition grid. The additional channels are charging flow, letdown flow and indicated pressurizer level; all original channel values are unchanged.

The [provenance record](https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/provenance.json) gives page/figure mappings, transformations, source hash and qualifications. The PDF, artwork and report prose are not distributed with OpenPWR. Numeric facts and original extraction/comparison code are distributed without asserting a new license over the source publication.

### Units and reading uncertainty

The source pressure axes are labeled MPa but their ticks are bar-valued: 144–162 for primary pressure and 64–80 for secondary pressure. The extractor applies a factor of 0.1. Table 2 independently confirms 15.48 MPa primary and 6.42/6.40 MPa secondary initial pressures. Temperature curves are converted from kelvin to Celsius.

Six decimal places preserve the reproducible vector transform; they do not imply measurement precision. The extractor records a half-PDF-point vertical allowance: approximately 0.006 MPa primary pressure, 0.005 MPa secondary pressure, 0.04 K cold-leg temperature and 0.13 K hot-leg temperature. A ±1 s acquisition-time allowance is also reported. Neither allowance quantifies instrument calibration, sensor delay, or the complete measurement uncertainty.

The published pre-event flow curves also disagree with Table 2: aggregate steam flow is around 1,003 kg/s and feedwater around 996 kg/s in the curves, while the table gives roughly the reverse. Instrument identifiers and captions are followed; the curves are not swapped, offset, or fitted to improve agreement.

## Experiment and separation of inputs from predictions

The comparison covers **0–15 s**, ending before the reported operator reopening at about 16 s and inferred SI/reactor trip at about 17 s. The source cautions that post-trip neutron power is not total decay heat and that the immediate post-trip steam/feedwater indications are unreliable. Those intervals are excluded.

The native [KrskoTransient model](https://github.com/ajayasai/OpenPWR/blob/main/models/KrskoTransient.mo) couples the primary loop, a [pressurizer with separate phase temperatures](PRESSURIZER_MODEL.md), and the equilibrium steam-generator component. Three measured channels are imposed as boundaries: pre-trip neutron-power percent multiplied by 1,994 MW, aggregate steam flow, and aggregate feedwater flow. Four response channels are held out: primary pressure, mean hot-leg temperature, mean cold-leg temperature, and mean secondary pressure. The documented nominal 6 MW pump heat is a separate constant input, rather than an adjustment to measured core power.

The [parameter ledger](https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/reference-plant.json) distinguishes applicable numeric values, historical/current figures with unresolved applicability, and missing information. Charging/letdown remain raw L/s because meter reference density and incoming enthalpy are unknown. Heater and spray numeric histories are unavailable. These four controls remain explicit zero assumptions; pressure is not used to invent them. Indicated pressurizer level is not established as a physical liquid-volume fraction; using it as one remains a declared approximation.

Table 2 initial conditions determine initial states, nominal heat-transfer conductances, and a constant feedwater enthalpy from an initial secondary energy balance. No post-initialization response is used to fit geometry, heat capacity, control gain, or time constant. The initial mass-flow imbalance remains present. The unknown volumes and heat capacities are the declared generic OpenPWR values, scaled by initial core thermal power divided by 3,000 MW. The additional 0.5× and 2× geometry/capacity runs show sensitivity; neither is selected as a fitted plant representation.

Errors are evaluated at the eight acquired samples at 1, 3, …, 15 s. The t=0 point is interpolated and shown only to expose initialization bias. The machine-readable report includes absolute and change-from-initial RMSE, maximum error, signed bias, communication-step refinement, acquisition-time allowance, and geometry sensitivity. It also integrates the external mass/energy boundaries independently of the model's algebraic residuals.

## Preserved released baseline

The immutable [v0.5 report](https://github.com/ajayasai/OpenPWR/blob/main/validation/baselines/krsko-v0.5.json) preserves these results. Its old descriptive date is retained as historical evidence, and corrected in current metadata. RMSE and maximum errors use the eight acquired samples; the refinement column is the largest difference between 0.05 s and 0.025 s communication steps at the plotted times.

| Held-out response | RMSE | Maximum absolute error | Maximum step-refinement difference |
| --- | ---: | ---: | ---: |
| Primary pressure | 0.35744 MPa | 0.52200 MPa | 0.000197 MPa |
| Mean hot-leg temperature | 0.91368 °C | 1.48639 °C | 0.00401 °C |
| Mean cold-leg temperature | 1.24096 °C | 2.25018 °C | 0.01009 °C |
| Mean secondary pressure | 0.17843 MPa | 0.36287 MPa | 0.001747 MPa |

The measurement discrepancies substantially exceed the figure-reading allowances. The much smaller communication-step differences do not explain them. Changing assumed volumes and heat capacities from 0.5× to 2× changes the predicted curves by as much as 0.214 MPa primary pressure, 4.98 °C hot-leg temperature, 6.63 °C cold-leg temperature, and 0.682 MPa secondary pressure. These sensitivities reinforce the need for identified plant parameters. **This generic configuration does not demonstrate plant agreement.** The evidence remains available even though it does not support a validation pass.

## Limitations that govern the conclusion

The v0.6 local comparison passes 16 numerical checks, but **the new adiabatic two-temperature pressurizer worsens the Krško pressure agreement**. Primary-pressure RMSE rises from 0.357 MPa in the released baseline to 0.694 MPa; hot/cold-leg RMSE changes from 0.914/1.241°C to 1.409/1.391°C. Secondary-pressure RMSE is nearly unchanged, 0.178 MPa. The same-boundary equilibrium ablation retains about 0.36 MPa primary-pressure RMSE, so adding documented pump heat alone does not explain the new discrepancy. These results do not establish that the new formulation is a better plant predictor. Missing wall exchange, controls, geometry and spatial thermal storage remain unresolved; the interactive plant has not adopted the experimental formulation.

The 0.5× geometry/capacity sensitivity reaches its declared property domain at 10.65 s. Its terminal observation is retained, and no full-window geometry spread is reported. The remaining complete sensitivity runs meet the same numerical balance tolerances. Published JSON retains exact metrics, source hashes and the controlled ablation.

The report does not supply the complete plant input deck, geometry, thermal-storage data, or instrument uncertainty needed to qualify this reduced model. Generic pressure-volume response, omitted plant wall heat storage and transport delays, and homogeneous secondary mixing can materially change predictions. The new model includes nominal pump heat, but unmeasured pressurizer controls and unidentified geometry still limit primary-pressure interpretation. The generic interactive native plant retains the equilibrium pressurizer; the separate-temperature component remains experimental in the reference cases.

Because core power and secondary flow are measured inputs, agreement would not validate neutron kinetics, turbine/generator response, feedwater control, trip logic, emergency cooling, or the remainder of a full-scope plant. The comparison also does not validate cold startup. There is no physical acceptance band or automatic upgrade from `inconclusive` to `passed`.

## Reproduce the native comparison

Use the repository's Linux/WSL engineering environment with OpenModelica, Modelica Standard Library 4.0.0 and the existing FMPy dependencies:

```sh
npm run engineering:measured -- --build
```

The launcher selects the configured Linux/WSL engineering environment. Inside an activated engineering environment, the equivalent direct command and reference tests are:

```sh
python validation/krsko2005/compare.py --build
python -m unittest discover -s validation/krsko2005 -p test_reference.py
```

The build creates `artifacts/modelica/KrskoTransient.fmu` and its same-boundary `KrskoEquilibrium.fmu` ablation, each with a build manifest; comparison creates `artifacts/measured-validation.json`. The report compares the new model against both the released baseline and the equilibrium ablation with the same pump heat, geometry and boundaries. This isolates model form from changed inputs. Phase-relaxation sensitivities of 0.05/0.2 s accompany the declared 0.1 s default; none is selected to fit pressure.

Without `--build`, the script rejects mismatched model, reference data, metadata, source ledger, comparison code, shared runner, baseline or FMU hashes. Reports identify the package version, Git revision/dirty state, compiler, model and FMU. Source hashes are checked before and after compilation. Boundary integrals use each externally held input at both endpoints of its communication step. This fixes a v0.5 diagnostic error caused by treating cached FMI algebraic outputs after `setReal` as newly evaluated inputs; the frozen historical report is not silently rewritten.

Numerical acceptance requires absolute mass/energy closure within 0.05 kg/0.1 MJ for every completed nominal, refined, equilibrium-ablation and sensitivity run, and communication-step differences within 0.01 MPa or 0.05°C. These are numerical tolerances, not bounds on physical prediction error. Failed numerical runs prevent publication; physical discrepancies remain visible. If a sensitivity reaches the model's declared property domain, its terminal observation and failure time are retained and the full-window sensitivity spread is left unavailable. The parameter is not changed to avoid that result.

Normal comparisons require only Python's standard library and FMPy; they use the checked-in CSV without a network request. To independently reproduce the figure extraction, install `pdfplumber==0.11.9` in a separate environment and run:

```sh
python validation/krsko2005/extract.py --download
```

The downloaded PDF and extraction diagnostics stay under ignored `artifacts/measured-transients/`. The reference contract tests check units against the independently published initial-condition table, prohibit extrapolation, verify loop aggregation, and enforce separation of forcing channels from held-out predictions.

## Independent PACTEL ATWS-10 experiment

[NUREG/IA-0231](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS124697/pdf/GOVPUB-Y3_N88-PURL-LPS124697.pdf) reports a 1998 PACTEL pressurizer insurge/outsurge test, including measured pressure, vessel geometry, initial conditions, a reported pressure error bound, and the study's boundary-input approximation. The checked-in [reference package](https://github.com/ajayasai/OpenPWR/blob/main/validation/pactel1998/README.md) records sources, extraction and qualifications. Only the red measured path in Figure 5 is extracted; the black TRACE calculation is excluded.

The 491 positions from 5–495 s are correlated readings on a 1 s graphical grid, not 491 independent acquisition samples. The native model runs 0–500 s with the printed schedules unchanged. The conditional envelope combines the reported ±0.094 MPa instrument bound, ±0.014286 MPa graphical reading allowance, and separate ±1.20048 s graphical time allowance. It is not a statistical confidence interval or complete uncertainty budget. Boundary flow and inlet temperature use the published calculation's approximation, not raw measured histories.

The component uses the documented 8.8 m height, 139.7 mm inner diameter, 14.3 mm wall and published external heat-loss coefficient. Liquid and vapor inventories have separate temperatures; wall conduction and condensation are included. See [equations and closure assumptions](PRESSURIZER_MODEL.md). This is independent of the Krško event, but not a blind holdout: the report's mechanistic discussion informed model development. No pressure samples tune parameters, offsets, or event timing. PACTEL is a scaled VVER facility component experiment, not validation of a 1,000 MWe PWR plant.

```sh
npm run engineering:pressurizer -- --build
```

This creates `PactelPressurizer.fmu`, its manifest, three additional wall-mesh FMUs and `artifacts/pressurizer-validation.json`. It uses the same provenance-bound runner, independent boundary accounting and 0.1/0.05 s communication refinement. The 48×8 mesh was selected using numerical refinement during v0.7 and is retained for v0.8 development; the 12×4, 12×8 and 24×8 traces remain in the report. All spatial comparisons use the same 0.05 s communication step. Shrinking mesh differences do not establish an asymptotic error bound. The evidence page switches between cases and exposes raw metrics and numerical checks. Applicability remains inconclusive even if numerical checks pass. See [v0.8 pressure development](PRESSURE_V08.md) for the new film closure, discrepancies and comparisons with the immutable v0.7 baseline.

The immutable v0.6 baseline has pressure RMSE **0.180 MPa** and maximum same-time error **0.774 MPa**. Its modeled peak is **8.29 MPa at 220 s**, versus **7.56 MPa at 219 s** in the digitized measurement. Its conditional envelope covers 373 of 491 correlated positions; this fraction is descriptive, not a probability of accuracy. Its maximum communication-step difference is 0.00395 MPa, with all eight inventory checks passing. That small time-step difference does not explain the peak mismatch; spatial error was not assessed in that release. Both v0.6 measured reports are preserved byte-for-byte under `validation/baselines/`. The deployed JSON identifies the current release and exact source/binary hashes.

## PACTEL ATWS-11: historical holdout and current development

The [historical ATWS-11 method and protocol](https://github.com/ajayasai/OpenPWR/blob/main/validation/pactel1998/holdout-method.md) records selection of a second event before extracting its pressure response during v0.7. That release's candidate sources, shared runner and comparators were frozen before scoring it. No ATWS-11 response point selected the v0.7 wall properties, coefficients, mesh, timing, offsets or initialization. The immutable freeze and exact published v0.7 report are preserved. ATWS-11 has since been disclosed and cannot serve as a new holdout for v0.8.

The comparison ends at 295 s, before the 297 s draining event, because ATWS-11 outsurge flow is not tabulated. It uses the published 5.9 MPa initial pressure, 3.5 m liquid level and 0.217 kg/s insurge. Inlet/wall temperatures and one-second boundary ramps explicitly reuse ATWS-10 assumptions; their uncertainty is unresolved. The 291 graphical readings at 5–295 s are correlated curve positions, not independent instrument samples.

The current native candidate FMU is initialized with the unchanged protocol parameters and evaluated at both communication steps. Its result retains the compatibility key `holdoutComparison` in `pressurizer-validation.json`, but explicitly declares `comparisonRole: "post-unblinding-development"` and `heldOutFromCurrentDevelopment: false`. The evidence page labels that role. Publication requires matching current source/data/baseline hashes, preserved historical freeze metadata, full declared time grids and successful numerical checks. Physical disagreement is retained. This is a same-facility development comparison; it does not independently validate the coupled plant or auxiliary system.

To reproduce the historical reserved result, use the v0.7.0 source tag and its released FMU. To run the current development comparison, use `npm run engineering:pressurizer -- --build` from the current checkout; it invokes the [post-unblinding comparator](../validation/pactel1998/post-unblinding-method.md). The historical freeze is never overwritten or presented as a freeze of this new candidate. A future independent validation claim requires newly reserved response data and a prospective protocol.
