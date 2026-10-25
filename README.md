# OpenPWR

**A transparent 1,000 MWe PWR simulation laboratory.** An interactive control room and a deterministic engineering model, with inspectable equations, reproducible scenarios, and numerical evidence.

[Launch control room](https://ajayasai.github.io/OpenPWR/) · [Verification evidence](https://ajayasai.github.io/OpenPWR/verification.html) · [Model equations](docs/MODEL.md) · [Validation scope](docs/VALIDATION.md)

OpenPWR models a generic pressurized-water plant at system level. Reactor power emerges from neutron kinetics and feedback, while the coolant, steam system, turbine, condenser, and controllers respond together. The UI and command-line runner use the **same engine**.

![OpenPWR control room with measured plant state, process diagram, operator controls, and live trends](docs/control-room.jpg)

## What is included

- Six delayed-neutron groups, temperature reactivity feedback, iodine/xenon dynamics, and decay heat.
- Fuel, primary coolant, and steam-generator thermal storage; steam/feedwater inventory; water saturation properties; a turbine/generator and condenser model.
- Automatic load, feedwater, and turbine controls, with manual overrides and a latched reactor trip.
- Pump-trip, feedwater-loss, turbine-trip, and heat-sink-loss experiments.
- Live process diagram, unit-labeled trends, alarms/events, adjustable simulation speed, JSON snapshots, and CSV export.
- A headless runner, independent numerical tests, machine-readable verification results, and CI on Linux and Windows.

## Scope and accuracy

This is a **reduced-order engineering model**, not a validated replica of an operating facility. The initial operating domain is hot power operation and selected transients. The nominal point is 3,000 MW thermal and 1,000 MW net electrical; nominal calibration is an assumption, not validation data.

It does not yet provide a full cold-start sequence, spatial core physics, a resolved pressurizer, multi-loop hydraulics, full water/steam enthalpy tables, emergency core cooling, containment, fuel damage, severe-accident chemistry, or plant-specific procedures. The engine stops at declared model-domain boundaries. Read [MODEL.md](docs/MODEL.md) before interpreting results.

Tests establish numerical consistency, agreement with selected analytical/property references, and expected generic responses. They do not establish real-plant predictive accuracy or qualify the program for plant operation, safety analysis, or operator licensing. [The comparison](docs/COMPARISON.md) records the scope of alternatives without claiming an unsupported ranking.

## Run locally

Install [Node.js](https://nodejs.org/) 22 or newer, then:

```sh
git clone https://github.com/ajayasai/OpenPWR.git
cd OpenPWR
npm test
npm run verify
npm run build
npm start
```

Open `http://127.0.0.1:4173`. There are **no npm dependencies to install**. For development, `npm run dev` serves the source directly. The `dist/` directory is a portable static site; any HTTP server can host it. Native ES modules require HTTP, so opening `index.html` directly as a file is not supported.

## Reproducible experiments

```sh
npm run simulate -- --scenario=load-step --duration=600 --output=artifacts/load-step.csv
npm run simulate -- --scenario=scram --duration=90 --output=artifacts/scram.csv
npm run simulate -- --help
```

Scripted events occur at simulation time 60 seconds. The runner writes a CSV plus JSON metadata and final state. A model-domain exit returns status 2 rather than continuing extrapolation. The browser exports snapshots that preserve all internal dynamics for continuation; CSV histories are bounded to the visible session buffer.

## Architecture

```text
Browser controls → model API → deterministic engine → observations / plots
                                  ↑
                            headless runner
                                  ↑
                       independent tests / evidence
```

`src/physics.js` contains numerical/property helpers. `src/engine.js` couples states, controls, and protection. `src/app.js` renders the control room. `tests/` contains verification; `scripts/verify.mjs` produces the release's public evidence report.

## Fully open stack

Original source and documentation: **Apache-2.0**. No proprietary solver, licensed plant dataset, telemetry, API key, cloud computation, remote font, or runtime package is required. All computation runs on your device. GitHub Pages is optional hosting, and GitHub Actions is optional CI. Source availability does not imply physical-model completeness.

See [LICENSE](LICENSE), [NOTICE](NOTICE), and [dependency inventory](docs/OPEN_SOURCE.md).

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Useful contributions include independently sourced reference cases, uncertainty studies, richer thermodynamics, and accessible interface improvements. Each new model should document its equations, units, parameter provenance, domain, and verification evidence. Improvements to fidelity take priority over adding unverified gauges.
