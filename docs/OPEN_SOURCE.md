# Open-source inventory

| Layer | Implementation | License / requirement |
| --- | --- | --- |
| Plant engine | Original JavaScript ES modules in this repository | Apache-2.0 |
| Numerical and property helpers | Original implementation of documented published equations | Apache-2.0; equations/data references in MODEL.md |
| Control room, SVG diagrams, charts | Original HTML/CSS/JavaScript | Apache-2.0 |
| Runtime dependencies | None | No package installation or paid license |
| Fonts | Operating-system font stack | No font files redistributed |
| Tests, build, CLI, local HTTP server | Node.js standard library | Project scripts Apache-2.0; Node.js and bundled components under their own open-source licenses |
| CI | Optional GitHub Actions; action commits pinned | Official actions have their own open-source licenses; not bundled into the application |
| Hosting | Optional GitHub Pages or any static HTTP server | No GitHub-specific runtime API |

No source code from ThermoSysPro, TRANSFORM, Reactor Dynamics, OpenMC, or Hartrusion is included. Mathematical models are independently implemented. This avoids uncertain component licensing and proprietary tooling while leaving a documented path for future model interchange.

No API keys, private plant data, analytics scripts, third-party CDN assets, or network-backed simulation services are used. After the static assets load, the simulator's numerical work is local; export and import remain on the device. Native browser download behavior saves files only when requested.

The complete corresponding source is in this repository. Build outputs are straightforward copies of that source, plus generated numerical verification and published benchmark comparison reports. The property implementation and benchmark runner are original code. Reference values and equations are attributed to their publications in [BENCHMARKS.md](BENCHMARKS.md); no publisher PDFs or third-party solver implementations are bundled.
