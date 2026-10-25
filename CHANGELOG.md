# Changelog

## 0.2.0 — 2026-10-25

Adds a continuous generic cold-start experiment: 25 °C subcritical initialization, source-driven kinetics, circulation and pressure support, reactor-assisted heatup, hot thermal hold, steam-driven turbine acceleration, conditional grid connection, and load pickup. Startup actions change controls without replacing thermal or nuclear inventories. Generator load rejection trips the reactor and closes the turbine stop valve.

Replaces fitted saturated enthalpy curves with original IAPWS-IF97 region 1/2 equations and a consistent interpolation/storage inverse. Adds reproducible comparisons against published CATS point-kinetics tables, official IF97 verification values, and NIST saturation tables. The evidence page separates these component comparisons from generic coupled-system checks; the startup verification report includes action timestamps and a one-minute trace.

Adds startup controls, up to 1,000× requested playback, an actual-speed indicator, 24-hour history, long-duration chart windows, and expanded CSV fields. Adds a headless cold-start director, v2 saved states with authentic v1 migration tests, stricter cross-field validation, and reloadable non-advancing terminal states. Fixes stale CSV samples at hot-scenario event boundaries. Builds reject failed or mismatched-version/commit evidence.

Scope: a generic reactor-assisted model experiment, not plant Mode 3 or a plant-specific startup procedure. Property and point-kinetics comparisons do not validate the entire plant. Resolved pressurizer physics, multi-loop hydraulics, spatial core physics, detailed accident systems, and measured plant-transient validation remain future work.

## 0.1.0 — 2026-10-25

Initial public research/education release. Adds the original coupled PWR engine, interactive control room, automatic/manual controls, selected disturbance experiments, deterministic state continuation, CSV export, a headless runner, numerical/reference verification, and optional GitHub Pages deployment.

Known scope limits: hot-power initialization, aggregated plant systems, simplified steam enthalpy and condenser/pressure models, generic calibration, and no independent plant-transient validation. See docs/MODEL.md and docs/VALIDATION.md.
