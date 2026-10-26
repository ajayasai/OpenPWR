# Changelog

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
