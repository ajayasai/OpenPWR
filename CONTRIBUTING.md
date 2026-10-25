# Contributing

OpenPWR accepts improvements under Apache-2.0. Submit focused pull requests and describe the physical or usability problem addressed. Include sources for model changes and do not import proprietary plant data, code, or diagrams.

## Development

Use Node.js 22 or newer. No dependencies need installing. `npm run dev` serves the source at localhost:4173; `npm test`, `npm run verify`, and `npm run build` run the required checks. The browser and headless runner must continue to share one engine.

For a model change, provide equations, dimensions, parameter origins, validity limits, and a reference solution or independent benchmark where possible. Keep numerical verification separate from empirical validation. A passing test that repeats the implementation is not sufficient evidence of physical accuracy.

For UI changes, exercise keyboard controls and narrow/mobile layouts. Keep all displayed values linked to actual model state. Do not introduce telemetry, external runtime requests, or proprietary packages.

Version saved-state schemas whenever state semantics change. Reject invalid state atomically and test deterministic continuation. Maintain a bounded event log and history. Preserve attribution and existing public interfaces unless a documented migration is necessary.
