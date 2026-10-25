# Native engineering service

This optional service runs the compiled **OpenPWR.PrimaryLoop FMI 2 co-simulation model** through FMPy. It serves the engineering workbench and the existing browser control room from the same loopback origin. It does not substitute JavaScript values when the native model is unavailable.

The engineering model is a hot primary-loop/pressurizer subsystem, with prescribed fuel heat input and secondary temperature. It is not the complete browser plant model and does not include neutron kinetics, a turbine, or the cold-start workflow.

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
| `GET /api/state` | `{time, controls, outputs, halted, haltReason, backend, model}` |
| `POST /api/control` with `{"pumpCommand":0.9}` | Validates all supplied controls before applying them; returns current state |
| `POST /api/step` with `{"seconds":0.25}` | Advances in 0.05 s communication steps, stops on a declared model-domain boundary |
| `POST /api/reset` with `{}` | Recreates the native instance at its declared initial condition |
| `GET /api/export` | One-second CSV observations plus the current observation; bounded to roughly 10 hours |
| `GET /api/commands` | Versioned command log with FMU identity; at most 10,000 commands, truncation explicitly reported |
| `GET /engineering-verification.json` | Saved native subsystem evidence, including the tested FMU hash, compiler and source revision |
| `GET /modelica-property-verification.json` | Saved native property-reference comparison report |

All API errors are JSON `{error,message}` with a corresponding HTTP status. An absent or unloadable FMU returns HTTP 503. A halted solver rejects additional control/step requests with HTTP 409 until reset. Native non-finite observations are never emitted as JSON numbers.

Evidence endpoints serve the actual saved reports without fabricating results or replacing their recorded provenance. A missing report returns HTTP 404. Compare its FMU identity and source revision with the running model before treating it as evidence for the current session.

## Tests and evidence

```sh
python -m unittest backend.test_backend -v
OPENPWR_FMU=artifacts/modelica/PrimaryLoop.fmu python -m unittest backend.test_backend -v
python backend/verify.py --fmu artifacts/modelica/PrimaryLoop.fmu
```

On PowerShell set `$env:OPENPWR_FMU` separately before running the tests. The protocol tests use a test-only fake slave to exercise input validation, time stepping, lifecycle, domain halts, CSV freshness, and HTTP origin/host boundaries. The fake is never an application backend. The optional native smoke test loads the actual FMU.

`verify.py` records actual FMU identity, compiler, source revision, numerical tolerances, and traces in `artifacts/modelica-verification.json`. It compares the pump state against its exact first-order ODE solution and tests mass/energy conservation from physical inventories and boundary fluxes, equilibrium, qualitative pressure response, communication-step refinement, and reset/replay. These are equation/subsystem checks, **not measured plant-transient validation**.

Native verification requires an adjacent `manifest.json` from the model build. It rejects a manifest whose source hash differs from the current `models/OpenPWR/package.mo`, or whose FMU hash differs from the compiled bytes. The report embeds that build manifest so a current repository revision cannot hide a stale compiled model. The interactive service can still load another compatible FMU explicitly; that does not give it verified status.

## Open-source dependencies

Original service code is Apache-2.0. FMPy 0.3.32 is an external Python dependency under the BSD-2-Clause license; its distribution includes additional third-party notices for FMI schemas, SUNDIALS, and optional UI assets. This service uses the FMI runtime API and the Python standard-library HTTP server, without the FMPy GUI/web extras. Preserve dependency notices when redistributing bundled runtimes.

- FMPy source and notices: <https://github.com/CATIA-Systems/FMPy>
- OpenModelica source and licensing: <https://openmodelica.org/>
- Modelica Standard Library source and BSD-3-Clause licensing: <https://github.com/modelica/ModelicaStandardLibrary>

The compiled FMU contains the Modelica model plus generated/runtime code under their respective licenses. Publishing the original model source does not relicense those runtimes. The full model source and build instructions remain necessary alongside any release binary.
