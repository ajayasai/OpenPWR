# Vendored Three.js 0.186.1

These files are distributed under the upstream [MIT license](LICENSE). They are third-party code, separate from OpenPWR's Apache-2.0 original code.

- Upstream: <https://github.com/mrdoob/three.js>, revision `9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8`.
- Official npm package: <https://registry.npmjs.org/three/0.186.1>.
- Download: <https://registry.npmjs.org/three/-/three-0.186.1.tgz>.
- npm archive integrity: `sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==`.
- Archive SHA-512 verified during vendoring: `6e515ea9be3dc110921941a3ee0b697e74861f2da5c0393de11854992d5cfe14dbcbbd24bc285b5a9909e0f9b5dfdd0bab3cef4e6ce05ca1cf11a7c9c026fc8c`.

Only the WebGL ES module, its core module, OrbitControls and the license are retained. The archive and unrelated examples are not shipped. `three.module.js` and `three.core.js` are unmodified upstream build files. In `examples/jsm/controls/OrbitControls.js`, the sole source change is `from 'three'` → `from './three.module.js'`, allowing direct local ES-module imports without an import map, package manager or CDN.

| Local file | Upstream archive member | SHA-256 of local file |
| --- | --- | --- |
| `three.module.js` | `package/build/three.module.js` | `9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea` |
| `three.core.js` | `package/build/three.core.js` | `9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6` |
| `OrbitControls.js` | `package/examples/jsm/controls/OrbitControls.js` | `30386f7141d5ce5d5e0a3ab643e4eb16265f4564466108105ce449857f62fdda` |

The application imports these modules only when mounting the spatial view. All plant geometry is original procedural geometry in `src/plant3d.js`; no proprietary CAD files, textures, fonts or models are required. The renderer receives observations through `src/plant3d-state.js` and cannot advance or alter either simulation engine.

WebGL 2 is required by this upstream renderer. If unavailable, OpenPWR displays an explicit message and keeps its process schematic available. See the official [WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html) and [OrbitControls](https://threejs.org/docs/pages/OrbitControls.html) documentation.

To reproduce vendoring, download the pinned archive, verify its SHA-512, extract the four named members, apply the one import replacement, and verify the local SHA-256 values above. Do not replace a pinned file with a newer release without reviewing its imports, license, browser requirements and behavior.
