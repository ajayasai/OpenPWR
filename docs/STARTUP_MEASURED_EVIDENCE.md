# Measured evidence for continuous startup

**The continuous cold-to-grid startup is not physically validated.** This release compares the thermal equations shared with `ContinuousPlant` against a short operating-plant transient. That extends measured coverage to production equations; it does not establish the accuracy of criticality, synchronization, or a complete startup. The [machine-readable coverage ledger](https://github.com/ajayasai/OpenPWR/blob/main/validation/continuous_measured/source-coverage.json) separates these claims. Numerical startup checks remain verification evidence.

The following source audit was completed on 13 November 2026. It is a bounded review of these publications, not a claim that suitable data do not exist elsewhere.

| Source | Evidence available | Applicable scope and unresolved inputs |
| --- | --- | --- |
| [NUREG/IA-0221, Krško, 2005](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf) | Measured operating-plant instrument curves, Figures 22–26, 29–34 and 37–40; initial conditions in Table 2. | The 0–15 s pre-trip comparison imposes power, steam flow and feedwater flow, and holds out pressure and temperatures. Unknown plant storage, control histories and instrument response limit the result. Imposed power cannot validate kinetics. See the [existing provenance and limitations](MEASURED_VALIDATION.md). |
| [OECD/NEA V1000CT-1, Volume 2](https://www.oecd.org/content/dam/oecd/en/publications/reports/2006/11/oecd-papers-volume-6-issue-7_g1gh677b/oecd_papers-v6-7-en.pdf) | Kozloduy-6 commissioning pump switch-on; published initial states, point-kinetics parameters, boundary tables and measured thermal/hydraulic responses. | A candidate for a future four-loop thermal model. **The report explicitly says transient reactor-power measurements are unavailable** (printed p. 33). It cannot supply a measured power holdout for the present kinetics model. |
| [EPRI MRP-393, 2014](https://restservice.epri.com/publicdownload/000000003002003085/0/Product) | Actual plant fatigue-monitoring records: Westinghouse heatup (Figure 2-1), low-power loading (Figure 2-9), and C-E heatup (Figure 3-1). | Relevant measured startup segments, presented as typical examples without an identified event/plant, synchronized actuator histories, plant inventories, or a complete measurement uncertainty budget. They are context, not an executable validation case. |

## Why the V1000CT-1 power curves are not measured validation

The accessible source is NEA/NSC/DOC(2006)5, reproduced in the linked OECD compilation. Printed pages 17–23 contain Tables 2.1–2.8; page 25 distinguishes 19 measured histories from nine calculated-only histories. Measured comparisons cover 129 s; calculated comparisons extend to 800 s (p. 30). Reactor/fission power, feedback reactivity, and core-average fuel/moderator temperatures in Figures 4.22–4.26 belong to the latter group. The original 883.5 MW initial power was revised to 824 MW using secondary-side information (p. 33).

Measured leg temperatures also include sensor dynamics (pp. 27–28). They are not interchangeable with instantaneous, spatially averaged feedback temperatures. Replaying those readings as core feedback and scoring against another code's power would be a conditional code comparison. It would not independently validate neutron kinetics. The [full-specification entry](https://oecd-nea.org/science/wprs/egrsltb/v1000ct/) identifies password-controlled material; a freely redistributable complete input/data package was not established in this audit.

## What is still needed

For a measured startup replay, obtain one identified plant/event with synchronized, time-stamped boundary and actuator records; plant geometry and thermal inventories; fuel/core state and kinetics parameters; initial precursor and decay-heat assumptions; neutron-instrument response; and measurement uncertainty. Rod/boron history and turbine admission, speed, voltage, breaker timing and load must be independent of the outputs being evaluated. Cold heatup also needs pump heat, pressurizer controls, charging/letdown enthalpy and secondary heat-removal histories.

EPRI's heatup figures are distinct from its low-power loading figure; they are not demonstrated segments of one continuous event. Their plots must not be stitched together, digitized at an invented acquisition frequency, or used to infer missing controls and then called validation. Public PDF access also does not make a publication or its data an open-source package: this repository links the sources and does not redistribute their artwork or claim to relicense them.

The next defensible improvement is a fully specified measured case with independent forcing and held-out responses. Until then, retain the current discrepancies, parameter assumptions and physical `inconclusive` status. A completed replay and successful numerical checks must not automatically promote the model to a physical pass.
