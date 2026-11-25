# Changelog

## 0.17.0

- Added a Shippingport historical case to the native whole-plant model. One instance evolves coolant temperature and absolute pressure for 29 hours with fitted heat and gas-removal inputs. The original generic startup remains available.
- Published the calibration code, the frozen candidate, the station readings, and separate development and reserved-window scores. At the times covered by the original run, the historical case reduced early pressure RMSE from 13.67 to 0.205 MPa (four readings) and coolant-temperature error from 154.10 to 19.65 °C (one reading).
- Across both reserved windows the revised model scored 0.470 MPa and 10.15 °C RMSE. Carrying forward the last available development reading scored 0.211 MPa and 8.56 °C. A half-step repeat changed the model predictions by less than 0.000058 MPa and 0.000022 °C on the shared minute grid. [Full results](validation/shippingport_development/README.md)

## 0.16.0

- Published an independent measured-event test of the released native whole-plant startup trajectory. The Shippingport archive contributes 96 numerical observations across four channels. Thirty can be scored on the model clock.
- Published the negative result, the two-read transcription, source exclusions, model and source fingerprints, a browser explorer, and a reproducible comparison. Release CI also checks a fresh whole-model execution against the original v0.15.0 trajectory.
- Historical turbine synchronism occurred with the main breaker open. Grid coupling, full-power loading and whole-plant predictive accuracy remain unvalidated.

## 0.15.0

- The browser engine uses IF97 compressed-liquid enthalpy at the steam-generator inlet in the feedwater, steam-cycle and thermal energy balances. Rated steam flow is 1,630.53 kg/s at 3,000 MWth and 1,000 MWe.
- Added 14 independent compressed-water reference points from NISTIR 5078, a state-by-state comparison against the previous model and a check on the energy entering the plant during a load change. The reference test covers feedwater enthalpy.
- The control room and CSV histories expose the inlet temperature, property pressure, enthalpy and active property model. New saves identify the pressure-dependent model. Historical saves and recipes continue on their original equations and flow calibration.

## 0.14.0

- The measured-response explorer covers all 18 case and channel combinations. Signed-error tables and CSV downloads use each report’s scoring grid, units, reference data fingerprint and model identity. PACTEL tables include the report’s conditional allowances and support jumps to a time window.
- The Krško pressure comparison and coupled-plant check list now load about 69 kB of evidence JSON. Previously the page loaded nearly 40 MB. The full reports are still downloadable and the compact files identify their sources by SHA-256.
- The startup player offers the current release’s verified native run and the historical v0.11 recording. It checks the selected recording against its published fingerprint. The engineering check list loads from a compact index.
- Release CI now runs the built site in Firefox, checks its downloads against the original reports and exercises recording selection and recovery.

## 0.13.0

- Run a matched load comparison in the public simulator. Both branches inherit the complete browser plant state, including controller settings and thermal history. Change demand in one branch and inspect the difference in generation, reactor heat, primary pressure and steam pressure at each sampled time.
- Capture a running control-room session in a separate comparison tab. Export the paired readings as CSV or download a versioned JSON recipe for replay in the browser or with Node.js.
- Published verification includes identical initial observations and deterministic replay. These experiments use the generic browser equations. Measured pressure and native startup evidence are available in their respective workbenches.
- The Krško pressure explorer shows both predictions, signed errors and overall scores at the eight acquired timestamps. The interpolated starting value is excluded. The released equilibrium model retains the lower overall pressure RMSE.

## 0.12.0

- The public continuous-startup workbench can play the archived native run and seek directly to a recorded observation. The named recording comes from the v0.11.0 release.
- Added an electrical output explorer with the two Sizewell B generator meters, complete half-hour observations around the December 2024 return, and separate simulated gross and net output. Users can inspect their own native CSV in the browser.
- Preserved signed energy, exact data sources and reproducible extraction. Model interval means use piecewise linear integration of recorded samples. These observations describe the electrical return to service. Reactor conditions and plant control histories are unavailable for validating the cold-to-power trajectory.

## 0.11.0

- Adds an experimental finite-phase pressurizer to the shared native startup thermal kernel, with separate liquid/headspace temperatures, steam/nitrogen inventories, conservative compression work and graded radial/axial wall heat storage.
- Freezes the Krško candidate configuration and paired improvement criteria before scoring; preserves exact released v0.10 evidence and identical measured forcing. Publishes equilibrium, candidate, no-wall and refined-wall comparisons and all adverse changes.
- Audits published Krško controls, MIT insurge experiments and Doel-4 wall input data. Analogue wall assumptions and missing measured spray history remain explicit. The shared model's experimental option does not establish full-startup or full-scope physical validation.
- Adds conservative native spray recirculation and a separately frozen conditional controller study. None of the tested candidates beats the released pressure error; the better-performing equilibrium default remains in place. Numerical pass counts are explicitly separate from the failed measured-accuracy guards.
- Fixes cold-phase solver sensitivity with exact state-coordinate translations, preserving the original phase law. Rejects non-writable or silently overwritten FMI parameter overrides.
- Extends executable/source provenance, independent vent-energy accounting, automated evidence publication and the measured-response viewer.

## 0.10.0

- Evaluates the actual continuous-startup thermal kernel against Krško 2005 plant measurements using a reference configuration with published initial states and disclosed generic parameters. Adds independent initial-state parameters while preserving the existing cold-start defaults.
- Freezes the comparison protocol before scoring; separates imposed power/flows from predicted pressure/temperatures; retains inventory closure, communication-step refinement, geometry sensitivity and all measured discrepancies.
- Publishes comparison charts, source/parameter ledgers, executable identity and reproducible reports. Source audit distinguishes real commissioning/startup records from calculated-only power curves and incomplete startup examples. The full cold-to-grid startup remains physically unvalidated.

## 0.9.0

- Added `ContinuousPlant`, a single native cold-to-power FMU with source-driven six-group kinetics, rod motion, finite decay heat, turbine shaft energy, generator phase/voltage dynamics and a latched synchronizing breaker.
- Added an animated native startup workbench with manual controls, timed experiments, source-range trends, CSV export and exact-FMU command replay.
- Added published CATS kinetics comparisons, independent kinetics and boundary-balance checks, synchronization rejection/acceptance, full-startup refinement and a same-instance trip experiment under a retained prospective protocol.
- Bound published evidence to model, verifier, host, profile, scenario, protocol, reference and build sources. Release packaging includes twelve FMUs and seven native reports.
- Retained the original cold and hot models and measured pressure comparisons. Numerical verification does not establish measured whole-plant startup fidelity or simulator qualification.

## 0.8.0 — 2026-11-13

Adds a native cold-to-hot-standby experiment with continuous water, steam and nitrogen inventories, pump heating, pressurizer controls, charging/letdown and shutdown cooling. Animated equipment, controls, trends, CSV export and replay use the compiled model. Fuel heat is prescribed; native criticality, synchronization and transition into the separate hot-plant model remain unimplemented.

Improves the experimental PACTEL pressure model with local condensate drainage and the published Chen film-condensation correlation. Same-trace pressure RMSE is about 9.8% lower for ATWS-10 and 9.6% lower for ATWS-11 than v0.7. Remaining discrepancies and immutable baseline reports stay visible. ATWS-11 is explicitly a post-unblinding development comparison, not a renewed independent holdout.

Repairs cold-purge communication-step sensitivity with continuous modulation and prevents spurious wall-solver roots using a monotone continuation outside the existing material domain. Acceptance limits are unchanged. Combined FMI exports omit unused output-derivative equations while retaining CVODE co-simulation. Release packaging binds eleven native FMUs and six evidence reports to the exact clean source revision and executable hashes.

## 0.6.0 — 2026-10-26

Adds an experimental native pressurizer with separate liquid/vapor temperatures, conservative phase inventories, and optional wall conduction/condensation. The Krško reference case applies the documented 6 MW pump heat and publishes a controlled equilibrium-model ablation alongside the immutable v0.5 baseline. The generic interactive native plant retains its existing equilibrium pressurizer pending broader validation.

Adds the independent PACTEL ATWS-10 component comparison with published geometry, fixed boundary schedules, digitized measured pressure, and explicitly conditional instrument/reading allowances. Neither case tunes parameters to the response trace or claims full-plant validation. The evidence page can switch cases and displays discrepancies and numerical diagnostics.

Audits Krško parameter availability, corrects the event date to 10 April 2005, and adds measured charging/letdown/level channels without inventing conversion conditions. Fixes independent boundary quadrature across held FMI inputs, adds conservation/refinement checks, and binds publication to comparison code, source ledgers, reference data and executable hashes. Missing historical geometry and controls remain explicit limitations.

## 0.5.0 — 2026-10-26

Adds a native coupled hot plant: six-group point kinetics, illustrative grouped decay heat, fuel-temperature feedback and reactor control, dynamic steam-generator mass/energy inventory, turbine expansion, rotor energy, generator connection permissive, condenser inventory/cooling, feedwater control and latched protection. All systems run within one OpenModelica FMU. The primary subsystem remains independently available.

Adds a native plant workbench with 14 controls, full-cycle 3D observations, thermal/electrical trends, six timed experiments, command replay, and model-specific API validation. Adds conservation, independent kinetics, refinement, trip, inventory and replay checks against the actual compiled models. Publication verifies source, data and FMU hashes before replacing the static build.

Adds reproducible extraction of measured Krško 2005 governor-closure traces from NRC NUREG/IA-0221 and a separate boundary-driven native comparison. Pressure and temperature are held out; measured power and steam/feed flows are inputs. Numerical results, discrepancies and geometry sensitivity are public. Missing plant geometry, controller details and instrument uncertainty leave validation inconclusive; no full-plant validation pass is claimed. Native cold startup, multi-loop/spatial response, containment and emergency systems remain future work.

## 0.4.0 — 2026-10-25

Adds an interactive Three.js cutaway to both simulation editions: camera presets, orbit/zoom, equipment selection, live observation inspector, flow markers, shaft/pump animation, cutaway and label controls, keyboard/touch support, reduced-motion handling, and an explicit WebGL fallback. Three.js is pinned, locally vendored with its MIT license, and requires no runtime CDN. The original process schematic remains selectable.

Adds timed native experiments and validated command-history replay, exact event boundaries, endpoint comparison, bounded history recovery on reconnection, JSON/CSV export, and a headless experiment runner. The public native evidence viewer shows source identity, saved transient plots, check tolerances, 24 published NIST/IAPWS property comparisons and 25 separate numerical derivative checks. Deployment requires current successful native evidence.

Uses direct pressure/temperature properties in native primary volumes, retaining the same physical balances and saturated pressurizer model. Same-workload comparisons show substantially smaller inventory accounting errors with closely matching trajectories. Timing improvements are modest and host-dependent; no large speedup or real-plant validation is claimed. Native scope remains the hot primary subsystem, separate from the browser whole-plant model.

## 0.3.0 — 2026-10-25

Adds an optional native OpenModelica engineering workbench. A coupled hot primary-loop/pressurizer Modelica model uses the Modelica Standard Library's IF97 properties, separate coolant volumes, saturated pressurizer phase inventories, hydraulic flow and pump lag, heaters/spray, and charging/letdown boundaries. It exports as an FMI 2.0 co-simulation FMU with CVODE and is operated through a local FMPy service and browser controls.

Adds reproducible setup/build commands, compiler/source/artifact provenance, eight native subsystem checks, twelve native water-property comparisons against published NIST values, service tests, an engineering CI job, model-driven diagrams and trends, and unavailable-backend instructions on static hosting. Native artifacts preserve original model source and upstream license notices. The original browser-only whole-plant model remains separate. This native slice does not yet include neutron kinetics, the secondary/electrical plant, cold startup, or 3D geometry, and is not validated against measured whole-plant transients.

## 0.2.1 — 2026-10-25

Makes the process diagram visibly animated: brighter flow tracers, rotating primary/feed pumps, turbine and generator rotors, steam-generator bubbles, and power-dependent core heat intensity. Motion follows engine observations on a bounded display clock; it freezes with pause, respects reduced-motion preferences, and can be disabled independently of the simulation. Rotor motion is illustrative, not literal RPM; feed-pump rotation is inferred from mass flow because no feed-pump rotor state is modeled.

Corrects the shared steam header to follow total steam flow even when the turbine is isolated and only the bypass carries steam. Generator-lead motion follows signed gross power and breaker state; pump coastdown and the model's natural-circulation floor remain distinct. Keeps the diagram available on mobile with horizontal scrolling. Adds eight mapping and animation-clock regression tests. Engineering model equations and benchmark tolerances are unchanged.

## 0.2.0 — 2026-10-25

Adds a continuous generic cold-start experiment: 25 °C subcritical initialization, source-driven kinetics, circulation and pressure support, reactor-assisted heatup, hot thermal hold, steam-driven turbine acceleration, conditional grid connection, and load pickup. Startup actions change controls without replacing thermal or nuclear inventories. Generator load rejection trips the reactor and closes the turbine stop valve.

Replaces fitted saturated enthalpy curves with original IAPWS-IF97 region 1/2 equations and a consistent interpolation/storage inverse. Adds reproducible comparisons against published CATS point-kinetics tables, official IF97 verification values, and NIST saturation tables. The evidence page separates these component comparisons from generic coupled-system checks; the startup verification report includes action timestamps and a one-minute trace.

Adds startup controls, up to 1,000× requested playback, an actual-speed indicator, 24-hour history, long-duration chart windows, and expanded CSV fields. Adds a headless cold-start director, v2 saved states with authentic v1 migration tests, stricter cross-field validation, and reloadable non-advancing terminal states. Fixes stale CSV samples at hot-scenario event boundaries. Builds reject failed or mismatched-version/commit evidence.

Scope: a generic reactor-assisted model experiment, not plant Mode 3 or a plant-specific startup procedure. Property and point-kinetics comparisons do not validate the entire plant. Resolved pressurizer physics, multi-loop hydraulics, spatial core physics, detailed accident systems, and measured plant-transient validation remain future work.

## 0.1.0 — 2026-10-25

Initial public research/education release. Adds the original coupled PWR engine, interactive control room, automatic/manual controls, selected disturbance experiments, deterministic state continuation, CSV export, a headless runner, numerical/reference verification, and optional GitHub Pages deployment.

Known scope limits: hot-power initialization, aggregated plant systems, simplified steam enthalpy and condenser/pressure models, generic calibration, and no independent plant-transient validation. See docs/MODEL.md and docs/VALIDATION.md.
