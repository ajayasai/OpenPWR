# Scope and comparison

Reviewed 25 October 2026. This is a comparison of documented scope, not a measured ranking. We have not run the other projects through a common benchmark suite. OpenPWR does not claim to be the most accurate nuclear simulator or a replacement for an established analysis code.

| Project | Documented strengths | Different scope or constraints |
| --- | --- | --- |
| **OpenPWR** | Generic 1,000 MWe plant, coupled equations, browser controls, headless engine, reproducible saved states, numerical verification, no runtime package dependencies. | New reduced-order model. Generic calibration, no independent plant transient validation, spatial core model, severe-accident model, or operator-training qualification. |
| [Hartrusion RBMK Simulator](https://github.com/hartrusion/RbmkSimulator) | GPLv3 desktop simulator with plant systems, turbine operation, control-room displays, and downloadable Java/Windows builds. | RBMK rather than PWR. Its README explicitly states that neutron behavior and systems are simplified, with emphasis on plant-system interactions. |
| [Reactor Dynamics](https://github.com/TH462/Reactor-Dynamics) | AGPLv3 browser simulator with six-group point kinetics, feedback, coupled balance of plant, guided campaigns, and manuals. | Its playable PWR is a compact approximately 100 MWe design and is described as a functional alpha. BWR/RBMK interfaces are still being developed. |
| [ThermoSysPro](https://www.edf.fr/en/the-edf-group/innovating-for-the-future/rd-global-expertise/our-offers/our-software-and-calculation-codes/thermosyspro) | EDF engineering component library: thermal hydraulics, 0D neutronics, controls, electromechanics; supports OpenModelica. | A modeling library, not an assembled control room. Exact package licenses and model/tool compatibility must be checked; its published license lists exceptions for some packages. OpenPWR does not incorporate this library. |
| [ORNL TRANSFORM](https://github.com/ORNL-Modelica/TRANSFORM-Library) | Apache-2.0 Modelica library with nuclear and process components and PWR examples. | Its documented setup uses commercial Dymola. Component examples should not be confused with a turnkey fully open plant simulator. OpenPWR does not incorporate this library. |
| [Cardinal](https://cardinal.cels.anl.gov/) / [OpenMC](https://docs.openmc.org/en/stable/) | Detailed transport and multiphysics research capabilities, including coupling to CFD. | Much greater spatial physics detail than OpenPWR; these are not complete real-time control-room applications. OpenPWR does not run or replace these codes. |

## What “better” should mean

Evaluate competitors and future OpenPWR releases on a shared set of tasks before making comparative claims:

1. **Physical fidelity:** published equations, reference data, known uncertainty, applicable operating envelope, and independent transient comparisons.
2. **Numerical reliability:** analytical checks, conservation diagnostics, time-step refinement, deterministic replay, clear domain failures, and regression tests.
3. **Plant coverage:** explicitly modeled equipment, controllers, protection, and scenarios; identify aggregations and omitted systems.
4. **Usability:** legible system diagrams, meaningful trends and units, accessible controls, clear alarms, exportable results, and understandable cause and effect.
5. **Openness:** source and licenses for the model, interface, build, test, and deployment stack; ability to run locally without an account or proprietary service.
6. **Reproducibility:** versioned parameters, saved initial conditions and input histories, repeatable outputs, and benchmark results tied to a commit.

For this release, the most significant gap is independent physical validation. A polished interface and a passing software test suite cannot close that gap. A future comparison should supply identical disturbance definitions, initial conditions, time horizons, error measures, and reference traces wherever models share a common domain.

## Source and license notes

The project descriptions above come from their maintainers' documentation. No source code, artwork, or manuals from those projects are bundled in OpenPWR. The references establish context, not endorsement. ThermoSysPro's package caveat is visible in its [published license](https://build.openmodelica.org/Documentation/ThermoSysPro.UsersGuide.ThermoSysProLicense.html). Reactor Dynamics' approximate plant size appears on its [project site](https://reactordynamics.com/).
