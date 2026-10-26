# Measured plant transient: what this comparison does and does not establish

**Plant validation is inconclusive.** OpenPWR now executes a native thermal/inventory replay against published operating-plant measurements. The discrepancies are retained in the evidence report. A completed calculation is not a validation pass, and this case does not establish full-scope simulator accuracy.

## Primary source and reproducible reference

The reference is [NUREG/IA-0221, *Reactor Trip Analysis at Krško Nuclear Power Plant*](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf), by Andrej Prošek and Borut Mavko, published by the U.S. NRC in February 2010 (ADAMS ML100680300). It describes the 5 April 2005 governor-valve closure at the two-loop Krško PWR. The report identifies a 1,994 MW core thermal rating and 6 MW pump heat after the uprate; this is a distinct plant from OpenPWR's generic 1,000 MWe plant.

The [checked-in CSV](https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/measured.csv) contains 50 acquisition times, at 2 s intervals from −49 to 49 s, for 12 measured instrument channels and derived loop aggregates. The [extractor](https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/extract.py) reads the magenta measured vector paths in Figures 22–26, 29, 33–34 and 37–40, panel (a). It rejects the blue curves labeled `cal`, which are RELAP5 calculations. It checks the source PDF's SHA-256, page and instrument identities, curve count and acquisition grid.

The [provenance record](https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/provenance.json) gives page/figure mappings, transformations, source hash and qualifications. The PDF, artwork and report prose are not distributed with OpenPWR. Numeric facts and original extraction/comparison code are distributed without asserting a new license over the source publication.

### Units and reading uncertainty

The source pressure axes are labeled MPa but their ticks are bar-valued: 144–162 for primary pressure and 64–80 for secondary pressure. The extractor applies a factor of 0.1. Table 2 independently confirms 15.48 MPa primary and 6.42/6.40 MPa secondary initial pressures. Temperature curves are converted from kelvin to Celsius.

Six decimal places preserve the reproducible vector transform; they do not imply measurement precision. The extractor records a half-PDF-point vertical allowance: approximately 0.006 MPa primary pressure, 0.005 MPa secondary pressure, 0.04 K cold-leg temperature and 0.13 K hot-leg temperature. A ±1 s acquisition-time allowance is also reported. Neither allowance quantifies instrument calibration, sensor delay, or the complete measurement uncertainty.

The published pre-event flow curves also disagree with Table 2: aggregate steam flow is around 1,003 kg/s and feedwater around 996 kg/s in the curves, while the table gives roughly the reverse. Instrument identifiers and captions are followed; the curves are not swapped, offset, or fitted to improve agreement.

## Experiment and separation of inputs from predictions

The comparison covers **0–15 s**, ending before the reported operator reopening at about 16 s and inferred SI/reactor trip at about 17 s. The source cautions that post-trip neutron power is not total decay heat and that the immediate post-trip steam/feedwater indications are unreliable. Those intervals are excluded.

The native [KrskoTransient model](https://github.com/ajayasai/OpenPWR/blob/main/models/KrskoTransient.mo) couples the existing Modelica primary loop to the equilibrium steam-generator component. Three measured channels are imposed as boundaries: pre-trip neutron-power percent multiplied by 1,994 MW, aggregate steam flow, and aggregate feedwater flow. Four response channels are held out: primary pressure, mean hot-leg temperature, mean cold-leg temperature, and mean secondary pressure.

Table 2 initial conditions determine initial states, nominal heat-transfer conductances, and a constant feedwater enthalpy from an initial secondary energy balance. No post-initialization response is used to fit geometry, heat capacity, control gain, or time constant. The initial mass-flow imbalance remains present. The unknown volumes and heat capacities are the declared generic OpenPWR values, scaled by initial core thermal power divided by 3,000 MW. The additional 0.5× and 2× geometry/capacity runs show sensitivity; neither is selected as a fitted plant representation.

Errors are evaluated at the eight acquired samples at 1, 3, …, 15 s. The t=0 point is interpolated and shown only to expose initialization bias. The machine-readable report includes absolute and change-from-initial RMSE, maximum error, signed bias, communication-step refinement, acquisition-time allowance, and geometry sensitivity. It also integrates the external mass/energy boundaries independently of the model's algebraic residuals.

## Observed discrepancies

The native run on 26 October 2026 produced these results. RMSE and maximum errors use the eight acquired samples; the refinement column is the largest difference between 0.05 s and 0.025 s communication steps at the plotted times.

| Held-out response | RMSE | Maximum absolute error | Maximum step-refinement difference |
| --- | ---: | ---: | ---: |
| Primary pressure | 0.35744 MPa | 0.52200 MPa | 0.000197 MPa |
| Mean hot-leg temperature | 0.91368 °C | 1.48639 °C | 0.00401 °C |
| Mean cold-leg temperature | 1.24096 °C | 2.25018 °C | 0.01009 °C |
| Mean secondary pressure | 0.17843 MPa | 0.36287 MPa | 0.001747 MPa |

The measurement discrepancies substantially exceed the figure-reading allowances. The much smaller communication-step differences do not explain them. Changing assumed volumes and heat capacities from 0.5× to 2× changes the predicted curves by as much as 0.214 MPa primary pressure, 4.98 °C hot-leg temperature, 6.63 °C cold-leg temperature, and 0.682 MPa secondary pressure. These sensitivities reinforce the need for identified plant parameters. **This generic configuration does not demonstrate plant agreement.** The evidence remains available even though it does not support a validation pass.

## Limitations that govern the conclusion

The report does not supply the complete plant input deck, geometry, thermal-storage data, or instrument uncertainty needed to qualify this reduced model. Generic pressure-volume response, omitted wall heat storage and transport delays, and homogeneous secondary mixing can materially change predictions. The 6 MW pump heat is omitted. Pressurizer control and inventory histories are not replayed in this scoped case, further limiting primary-pressure interpretation.

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

The build creates `artifacts/modelica/KrskoTransient.fmu` and `artifacts/modelica/krsko-manifest.json`; comparison creates `artifacts/measured-validation.json`. Without `--build`, the script reruns the existing FMU and rejects mismatched model, reference data, metadata, or FMU hashes. Reports identify the package version, Git revision/dirty state, compiler, model and FMU. Source identity is checked before and after compilation.

Normal comparisons require only Python's standard library and FMPy; they use the checked-in CSV without a network request. To independently reproduce the figure extraction, install `pdfplumber==0.11.9` in a separate environment and run:

```sh
python validation/krsko2005/extract.py --download
```

The downloaded PDF and extraction diagnostics stay under ignored `artifacts/measured-transients/`. The reference contract tests check units against the independently published initial-condition table, prohibit extrapolation, verify loop aggregation, and enforce separation of forcing channels from held-out predictions.
