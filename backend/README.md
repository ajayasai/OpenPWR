# Native engineering service

This optional service runs the compiled **OpenPWR.PrimaryLoop** or **OpenPWR.CoupledPlant FMI 2 co-simulation model** through FMPy. It serves the selected engineering workbench and the existing browser control room from the same loopback origin. It does not substitute JavaScript values when the native model is unavailable.

The default primary profile is a hot primary-loop/pressurizer subsystem, with prescribed fuel heat input and secondary temperature. The optional plant profile adds coupled native kinetics and balance-of-plant systems. Both start from a hot operating equilibrium; neither includes the browser model's cold-start workflow.

## Runtime

Install `backend/requirements.txt` into an isolated Python 3.10+ environment. Compile the Modelica package as an FMI 2 **co-simulation** FMU for the same operating system/architecture as Python. A Linux `.so` FMU must run under Linux; a Windows `.dll` FMU must run under Windows.

```sh
python backend/server.py --fmu artifacts/modelica/PrimaryLoop.fmu --port 8001
```

Open `http://127.0.0.1:8001/engineering.html`. The service binds to loopback only. It accepts control requests only from its own origin and does not enable CORS. If using an HTTP client, supply `Origin: http://127.0.0.1:8001` and `Content-Type: application/json`.

The backend owns one shared session. Multiple tabs control the same experiment; this is not a multi-user simulation server. The UI advances simulation time explicitly. There is no background wall-clock advance, and no native state checkpoint/restore support in this release. Reset and timestamped command logs support reproducible reruns with the same FMU.

## API

| Request | Result |
| --- | --- |
| `GET /api/health` | Native backend availability, compiler identity, FMU SHA-256, and communication step |
| `GET /api/state` | `{time, controls, outputs, halted, haltReason, backend, model, experiment}` |
| `POST /api/control` with `{"pumpCommand":0.9}` | Validates all supplied controls before applying them; returns current state |
| `POST /api/step` with `{"seconds":0.25}` | Advances in 0.05 s communication steps, stops on a declared model-domain boundary |
| `POST /api/reset` with `{}` | Recreates the native instance at its declared initial condition |
| `GET /api/export` | CSV observations at one-second intervals, command boundaries, and the current time; retains at most 36,001 stored observations |
| `GET /api/history?maxPoints=600` | Bounded display history and current state for reconnect; accepts 2–2,000 points, uniformly downsamples while preserving the first/current observations |
| `GET /api/scenarios` | Scenario catalog with identifiers, descriptions, durations, and timestamped control schedules |
| `POST /api/experiment` with `{"scenario":"heater"}` | Resets and prepares a built-in `heater`, `spray`, `pump`, or `inventory` experiment; returns state |
| `POST /api/experiment/stop` with `{}` | Releases scripted controls at the current time, allowing manual continuation |
| `GET /api/commands` | Downloadable versioned command log with FMU identity and final observations; at most 10,000 commands, truncation explicitly reported |
| `POST /api/replay` with the exported log | Validates the entire log, then resets and prepares exact communication-step replay |
| `GET /api/report` | Downloadable experiment report containing runtime identity, current/final state, command log, and any replay comparison |
| `GET /engineering-verification.json` | Saved native subsystem evidence, including the tested FMU hash, compiler and source revision |
| `GET /modelica-property-verification.json` | Saved native property-reference comparison report |
| `GET /plant-verification.json` | Saved coupled native equation and conservation checks |
| `GET /measured-validation.json` | Saved measured-transient comparison, including its limitations and assessment status |

All API errors are JSON `{error,message}` with a corresponding HTTP status. An absent or unloadable FMU returns HTTP 503. A halted solver rejects additional control/step requests with HTTP 409 until reset. Native non-finite observations are never emitted as JSON numbers.

`experiment` is `null` for a manual session; a prepared script reports `{id,label,status,duration,appliedEvents,eventCount,nextEventTime,comparison}`. Status is `ready`, `running`, `complete`, `halted`, or `stopped`. Preparation leaves simulation time paused. Call the usual `/api/step` endpoint to run, and stop requesting steps to pause. Scheduled commands occur on their exact native communication boundary, even when a step request spans several events. The service stops at the script's duration without overshooting. Manual controls are locked while a script is ready/running; Reset cancels it. Stop preserves the current physical state and releases the schedule.

Replay accepts `openpwr-fmi-command-log-v1` and `v2`. Version 2 adds complete final observations. Validation rejects truncated logs, a different FMU hash, different communication step or initial controls, malformed/out-of-order events, off-grid timestamps, and out-of-range/non-finite controls **before resetting the existing session**. Scripts are limited to 10,000 commands and 36,000 simulated seconds. Only the replay route accepts bodies up to 4 MiB; ordinary control requests remain limited to 8 KiB. Initializing a validated plan can still fail in the native runtime; the service then reports that failure and requires a successful reset.

At completion, a version-2 replay compares every real output against its recorded final value, using an absolute tolerance of `1e-8 + 1e-10 × abs(reference)`, and checks time, validity and halt status. The report lists each difference and pass/fail result. This checks same-FMU reproducibility, not agreement with a physical plant. Version-1 logs have no recorded output comparison. Commands at the same timestamp preserve their order. CSV/history retain the last observation after commands at a given time; the command log retains every command.

History returns `{schema,fmuSha256,samplePeriod,storageIncludesCommandBoundaries,includesCommandBoundaries,retainedSamples,returnedSamples,downsampled,truncated,points,current}`. Each point contains `{time,controls,outputs,halted}`. `samplePeriod:1` describes regular storage, and `storageIncludesCommandBoundaries` indicates that storage also captures command observations. Display downsampling may omit intermediate boundaries; `includesCommandBoundaries` describes the returned points and is conservatively false whenever downsampling occurs. The complete retained CSV and command log remain available. `truncated` explicitly identifies loss of old observations. History is memory-bounded and cleared on reset/replay; it is not a persistent archival database.

Evidence endpoints serve the actual saved reports without fabricating results or replacing their recorded provenance. A missing report returns HTTP 404. Compare its FMU identity and source revision with the running model before treating it as evidence for the current session.

## Explicit native model selection

The default `primary` profile retains the standalone hot primary-loop/pressurizer experiment. The separate `plant` profile loads `OpenPWR.CoupledPlant`, coupling native kinetics, decay heat, secondary water/steam inventory, turbine/generator, condenser/feedwater and generic protection to the primary model. Both use the same bounded HTTP and command-replay protocol. Model choice is explicit at service startup; a model-name or variable-contract mismatch is rejected before the FMU is instantiated. There is no fallback to another model.

```sh
npm run engineering:build
npm run engineering:start
npm run engineering:plant:start
npm run engineering:plant:verify
npm run engineering:plant:experiment -- --scenario load-following --output artifacts/native-load
```

Primary mode serves `http://127.0.0.1:8001/engineering.html`; plant mode serves `http://127.0.0.1:8002/plant.html`. Use `--port` to override either address. The Python equivalents are `python backend/server.py --model plant` and `python backend/experiments.py --model plant --scenario reactor-trip`. `--fmu` may select another compiled artifact, but that artifact must satisfy the selected model profile. `engineering:plant:build` rebuilds only the coupled plant; the full build also compiles the primary, isolated kinetics and property-reference FMUs.

Health includes `profile`, `controlLimits`, `defaultControls`, `realOutputs`, `booleanOutputs` and `discreteControls`. State includes `profile`; the scenario catalogue includes both `profile` and `model`. Plant command inputs are `reactorDemandPercent`, `loadDemandMW`, `reactivityCommandPcm`, turbine/feedwater/cooling fractions, pump command, reactor/turbine trip commands, grid breaker command, and the four existing pressurizer/inventory controls. Trip and breaker commands accept exactly numeric `0` or `1`; all controls are validated before mutation. Clearing a trip command does not clear the model's trip latch; resetting starts a new initialized experiment.

Plant scenarios are `load-following`, `reactor-trip`, `turbine-trip`, `feedwater`, `cooling`, and `pump`. The catalogue supplies exact schedules. Primary-only schedules are not offered by the plant service. These are generic model experiments, not real plant operating procedures. A model-domain halt remains visible and stops the sequence; a completed script alone does not establish fidelity.

The primary outputs `thermalEnergyMJ`, `totalMassKg` and `boundaryPowerMW` retain their primary-subsystem meaning in both profiles. Plant-wide totals and boundary fluxes have the `Plant`/`plant` prefix. This distinction prevents a partial thermal balance from being presented as whole-plant conservation. `plant-verification.json` and `measured-validation.json` expose their corresponding saved reports; the measured-data report can contain failed or incomplete assessments and is never relabeled as a passing verification report.

## Tests and evidence

```sh
python -m unittest backend.test_backend backend.test_experiments -v
OPENPWR_FMU=artifacts/modelica/PrimaryLoop.fmu python -m unittest backend.test_backend backend.test_experiments -v
python backend/verify.py --fmu artifacts/modelica/PrimaryLoop.fmu
OPENPWR_PLANT_FMU=artifacts/modelica/CoupledPlant.fmu python -m unittest backend.test_plant -v
python backend/verify_plant.py
```

On PowerShell set `$env:OPENPWR_FMU` separately before running the tests. The protocol tests use a test-only fake slave to exercise input validation, time stepping, lifecycle, domain halts, CSV freshness, and HTTP origin/host boundaries. The fake is never an application backend. The optional native smoke test loads the actual FMU.

`verify.py` records actual FMU identity, compiler, source revision, numerical tolerances, and traces in `artifacts/modelica-verification.json`. It compares the pump state against its exact first-order ODE solution and tests mass/energy conservation from physical inventories and boundary fluxes, equilibrium, qualitative pressure response, communication-step refinement, and reset/replay. A separate closed-inventory regression requires less than `1e-4 kg` total mass drift during the first five seconds of pump, heater, and internal-spray transients. These are equation/subsystem checks, **not measured plant-transient validation**.

Native verification requires an adjacent `manifest.json` from the model build. It rejects a manifest whose source hash differs from the current `models/OpenPWR/package.mo`, or whose FMU hash differs from the compiled bytes. The report embeds that build manifest so a current repository revision cannot hide a stale compiled model. The interactive service can still load another compatible FMU explicitly; that does not give it verified status.

`verify_plant.py` separately binds the coupled model to `plant-manifest.json` and the isolated reusable kinetics component to `kinetics-manifest.json`. Its independent matrix exponential checks six-group kinetics under two constant reactivity inputs; other checks cover equilibrium, causality, trip latching/decay heat, secondary and condenser responses, physical inventory/energy accounting, communication-step refinement and complete-output command replay. These checks are numerical or analytical equation verification; they do not use measured plant transients. A failed native integration records a failed check rather than counting an unexecuted case as passed.

The turbine-trip energy check handles the breaker event explicitly. An input update can leave the FMI observation at the event's left limit until the first positive step. The report preserves that raw observation and its uncorrected trapezoid error, then checks the wholly observed post-event interval and a separate full-interval integral using zero electrical extraction at the commanded opening's right limit. Neither error is hidden by increasing the tolerance. The grid closing check covers the model's speed permissive only; it does not validate a phase/voltage synchronizer.

## Reproducible command-line experiments

Run this with the same native Python/FMPy environment used by the service:

```sh
python backend/experiments.py --scenario heater --output artifacts/heater
python backend/experiments.py --replay artifacts/heater.commands.json --output artifacts/heater-replay
```

Both accept `--fmu path/to/PrimaryLoop.fmu`. Scenario choices are `heater`, `spray`, `pump`, and `inventory`. The output prefix produces `.csv`, `.commands.json`, and `.report.json` files. A browser-exported command log can be replayed by this CLI, and a CLI-exported log can be imported by the browser workbench. The CLI advances synchronously to completion or a model-domain halt, with the same validation and event scheduler as HTTP. It exits `0` only for completion with a passing comparison when one exists, or `2` for a halt, failed comparison, invalid import, or unavailable native runtime. Native failure reports preserve the last confirmed time and observations.

## Open-source dependencies

Original service code is Apache-2.0. FMPy 0.3.32 is an external Python dependency under the BSD-2-Clause license; its distribution includes additional third-party notices for FMI schemas, SUNDIALS, and optional UI assets. This service uses the FMI runtime API and the Python standard-library HTTP server, without the FMPy GUI/web extras. Preserve dependency notices when redistributing bundled runtimes.

- FMPy source and notices: <https://github.com/CATIA-Systems/FMPy>
- OpenModelica source and licensing: <https://openmodelica.org/>
- Modelica Standard Library source and BSD-3-Clause licensing: <https://github.com/modelica/ModelicaStandardLibrary>

The compiled FMU contains the Modelica model plus generated/runtime code under their respective licenses. Publishing the original model source does not relicense those runtimes. The full model source and build instructions remain necessary alongside any release binary.
