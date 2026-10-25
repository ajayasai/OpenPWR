# Open-source inventory

| Layer | Implementation | License / requirement |
| --- | --- | --- |
| Plant engine | Original JavaScript ES modules in this repository | Apache-2.0 |
| Numerical and property helpers | Original implementation of documented published equations | Apache-2.0; equations/data references in MODEL.md |
| Control room, SVG diagrams, charts | Original HTML/CSS/JavaScript | Apache-2.0 |
| Browser physics runtime dependencies | None | No package installation or paid license |
| 3D renderer and orbit controls | Locally vendored Three.js 0.186.1 | MIT; exact source, integrity and the small import patch are recorded in `src/vendor/three/README.md` |
| 3D equipment geometry and observation mapping | Original procedural JavaScript | Apache-2.0; no external CAD, texture, font or asset service |
| Optional native plant model | Original Modelica source in `models/OpenPWR` | Apache-2.0 |
| Modelica water properties | Modelica Standard Library 4.0.0 | BSD-3-Clause; upstream source and notices retained by its distribution |
| Native compiler | OpenModelica, installed separately | Upstream OSMC/GPL licenses and component notices; not relicensed by OpenPWR |
| FMI host | FMPy 0.3.32, installed in an isolated Python environment | BSD-2-Clause plus bundled third-party notices |
| Native solver/runtime | OpenModelica-generated FMU with CVODE and supporting runtime libraries | OpenModelica runtime's BSD-3-Clause option, SUNDIALS BSD-3-Clause, and supporting component licenses; generated artifact includes its license resources |
| Local engineering service | Python standard-library HTTP service + FMPy | Original service Apache-2.0; dependencies retain their licenses |
| Fonts | Operating-system font stack | No font files redistributed |
| Tests, build, CLI, local HTTP server | Node.js standard library | Project scripts Apache-2.0; Node.js and bundled components under their own open-source licenses |
| CI | Optional GitHub Actions; action commits pinned | Official actions have their own open-source licenses; not bundled into the application |
| Hosting | Optional GitHub Pages or any static HTTP server | No GitHub-specific runtime API |

No source code from ThermoSysPro, TRANSFORM, Reactor Dynamics, OpenMC, or Hartrusion is included. Original system equations are independently implemented. Engineering mode calls the Modelica Standard Library for water properties and executes the compiled model using FMI. It does not claim ownership of upstream property implementations or solvers.

No API keys, private plant data, analytics scripts, or third-party CDN assets are used. Browser-edition computation runs in the page. Engineering mode sends controls to a same-origin loopback service and receives actual native-model observations; it does not contact a remote simulation service. Downloads save files only when requested.

Original corresponding source is in this repository. Browser build outputs are copies of that source plus generated verification reports. Native artifacts additionally contain compiled OpenModelica/Modelica runtime code, with hashes and tool versions in their manifest. Upstream corresponding sources and license terms are available from [OpenModelica](https://github.com/OpenModelica/OpenModelica), [Modelica Standard Library](https://github.com/modelica/ModelicaStandardLibrary/tree/v4.0.0), [FMPy](https://github.com/CATIA-Systems/FMPy), and [SUNDIALS](https://github.com/LLNL/sundials). No publisher PDFs are bundled. The original JavaScript property implementation and benchmark references remain documented in [BENCHMARKS.md](BENCHMARKS.md).

Native redistribution notices, their provenance, and hashes are preserved in [models/licenses](../models/licenses/README.md) and embedded at `documentation/licenses/` in each packaged FMU. Original per-file headers remain in the FMU's `sources/` directory. This product includes software developed by the University of Chicago, as Operator of Argonne National Laboratory.
