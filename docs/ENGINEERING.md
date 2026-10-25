# OpenModelica engineering workbench

The optional engineering workbench executes a compiled **OpenModelica FMI 2.0 co-simulation model**, hosted locally by FMPy. It models primary-loop and pressurizer dynamics. The existing JavaScript whole-plant laboratory remains a separate browser-only edition; readings are never silently blended between engines.

This is a native subsystem integration, not a complete replacement plant model. Reactor heat is a prescribed input; steam-generator secondary temperature is a boundary condition. Neutron kinetics, the secondary cycle, turbine, electrical system and cold startup are not part of this native model. Its 3D cutaway displays the same observations as the gauges and schematic; geometry does not add modeled systems. See [model equations and scope](MODELICA_MODEL.md).

![Native OpenModelica workbench with solver readings and primary circuit controls](engineering-workbench.jpg)

## Install and run

Install [OpenModelica](https://openmodelica.org/download/) with its Modelica Standard Library and compiler tools, Python 3.10 or newer, and Node.js 22 or newer. `omc` must be on PATH (or set `OPENPWR_OMC` to its executable). Linux instructions: [official minimal compiler installation](https://openmodelica.org/download/download-linux/). On Ubuntu also install `python3-venv`.

From the repository:

```sh
npm run engineering:setup
npm run engineering:build
npm run engineering:test
npm run engineering:verify
npm run engineering:start
```

Open **http://127.0.0.1:8001/engineering.html**. The workbench starts paused. Run advances the native solver; controls set its actual FMI inputs. Pause stops advancing simulation time. Reset creates a new nominal initial state. CSV contains native observations; the command log records applied control changes and their simulation times.

Setup creates an isolated `artifacts/engineering-venv` and installs `backend/requirements.txt`. No Python libraries are added to the browser-only edition. The compiler builds `artifacts/modelica/PrimaryLoop.fmu` in a fresh temporary directory, checks its FMI interface, then writes a manifest with source/artifact hashes, compiler version, platform and Git revision. Build logs remain alongside it.

### Windows with WSL

The launcher can use a compiler installed inside Ubuntu WSL:

```sh
npm run engineering:setup -- --wsl
```

Subsequent commands reuse that environment. The default distribution is `Ubuntu`; set `OPENPWR_WSL_DISTRO` before setup to choose another. Install the compiler and `python3-venv` in that distribution first. Windows localhost forwarding must be enabled for the browser to reach the WSL service. Native Windows setup is also supported when `omc` and Python are available, but this release's native FMU is tested on Linux/WSL; FMU binaries are platform-specific.

## Architecture and timing

```text
Browser engineering controls
         │ same-origin JSON requests / observations
Loopback Python service + FMPy
         │ FMI 2.0 input, doStep, output calls
OpenModelica PrimaryLoop FMU + CVODE
         │
Modelica Standard Library IF97 water properties
```

One coupled FMU owns the entire primary/pressurizer state. The host uses 50 ms communication steps; CVODE integrates internally. Browser display timing never changes the equations. Real-time performance is measured on the target machine, not guaranteed by FMI. Simulated time is explicitly displayed and is authoritative.

The service binds only to `127.0.0.1`. It serves the UI and API from one origin, checks Host and Origin on control requests, bounds inputs and request sizes, and stops advancement on nonfinite outputs, solver errors or the model's declared validity boundary. It is a local single-session service, not an authenticated multiuser cloud deployment.

FMI state serialization is not promised. Use reset plus the recorded commands for reproducible experiments; existing JavaScript save files cannot be loaded into this different model.

## Timed experiments and replay

Choose a heater, spray, pump or inventory experiment and select **Reset & prepare**. The service validates its schedule and initializes the model; **Run model** advances it. The host applies every control event at its exact 50 ms boundary, including when a browser request spans several events. Completion pauses the UI. Select **Return to manual** to continue from the final state.

**Save command history** records applied controls, times, FMU identity and final observations. **Replay saved commands** validates the entire file before resetting, rejects truncated or different-FMU logs, then replays it using ordinary solver steps. Completion compares the saved and replayed endpoint observations. Histories are bounded; reconnecting restores a sampled view of the native session. All browser tabs share one local session.

The same scheduler runs without the browser:

```sh
npm run engineering:experiment -- --scenario heater --output artifacts/heater
npm run engineering:experiment -- --replay artifacts/heater.commands.json --output artifacts/heater-replay
```

Each run writes a CSV, command history and report; a domain halt or failed comparison returns a nonzero exit status. Inputs remain generic model experiments, not plant operating procedures.

## Evidence

The [native evidence page](https://ajayasai.github.io/OpenPWR/engineering-evidence.html) presents source/binary identity, actual transient traces and per-check tolerances. GitHub's deployment build requires successful native reports from the current source. `npm run build -- --require-native` enforces the same requirement locally; ordinary browser-only builds omit missing or stale native reports.

`npm run engineering:verify` runs the actual compiled FMUs. The primary checks cover nominal equilibrium, analytical pump lag, heater and spray response directions, closed-system mass conservation, external mass accounting, independently integrated boundary energy, communication-step refinement, and deterministic reset/replay. A separate probe makes 24 published comparisons: twelve NISTIR 5078 saturation values and twelve official IAPWS-IF97 compressed-liquid verification values. It also reports 25 numerical derivative-consistency checks separately. The NIST 0.05% tolerance accounts for table precision and IF97/IAPWS-95 differences; exact inputs and tolerances are in the report and model guide.

These are separate from the browser engine's 71 published component comparisons. They do not establish agreement with measured plant transients. Parameters and component geometry remain generic. The generated reports are `artifacts/modelica-verification.json` and `artifacts/modelica/property-verification.json`. The local workbench links the native report and checks its FMU hash against the running model. The verifier rejects a stale source or modified FMU; manifests identify the source hash, compiler, platform and revision.

The public GitHub Pages workbench cannot run a native FMU. It presents local launch instructions and disables controls until the local service is available; it does not substitute sample numbers. Native FMUs and their evidence can be distributed as release artifacts with their platform, source revision and compiler identified.

## Open-source provenance

The original model, UI, host and build scripts are Apache-2.0. OpenModelica, the Modelica Standard Library, FMPy and their included runtimes have their own licenses and notices; original code is not a relicensing of those dependencies. This initial integration uses the Modelica Standard Library directly and includes no ThermoSysPro/TRANSFORM code or proprietary solver. See [dependency inventory](OPEN_SOURCE.md).

## Next model increments

After independent review and measured/published transient comparisons, add loop geometry and pump curves, a resolved steam generator, then integrate reactor feedback and the secondary/electrical systems. The existing 3D view must continue to distinguish modeled states from illustrative geometry. Each increment needs its own operating envelope and evidence before extending the model's claims.
