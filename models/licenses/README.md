# Native FMU redistribution notices

OpenPWR's original Modelica models and host code are Apache-2.0. Generated FMUs also include upstream runtime code and libraries under their own licenses. This directory is copied into each release FMU at `documentation/licenses/`; the FMU retains the original per-file notices in `sources/` as well. Original project `LICENSE` and `NOTICE` are supplied separately by the packager.

The OpenModelica run-time offers a choice of BSD New, AGPLv3, or OSMC-PL 1.8. OpenPWR redistributes that runtime using the **BSD-3-Clause option**, as permitted by the upstream runtime notice. `OpenModelica-runtime-license.txt` is the unchanged upstream choice notice. `OpenModelica-BSD-3-Clause.txt` supplies the standard selected BSD terms with the runtime copyright copied from the generated source. This choice applies to the runtime, not to the separately installed compiler or unrelated third-party files.

## Provenance

| Files | Source and applicability |
| --- | --- |
| `OpenModelica-runtime-license.txt` | [OpenModelica commit 6db4671](https://github.com/OpenModelica/OpenModelica/blob/6db4671/OSMC-Runtime-License.txt), matching the compiler build used for this release (`1.27.1~2-g6db4671`). |
| `OpenModelica-BSD-3-Clause.txt` | Selected BSD New terms referenced by that notice, [BSD-3-Clause](https://opensource.org/license/bsd-3-clause); copyright from `sources/simulation/solver/cvode_solver.c`. |
| `MSL-4.0.0/*.txt` | Copied unchanged from the installed Modelica `4.0.0+maint.om/Resources/Licenses` directory. [Upstream MSL 4.0.0 license resources](https://github.com/modelica/ModelicaStandardLibrary/tree/v4.0.0/Modelica/Resources/Licenses). The complete small notice set is retained; its presence does not imply every optional helper is linked. IF97 property functions use the main MSL BSD-3-Clause license. |
| `SUNDIALS-5.4.0-LICENSE.txt`, `SUNDIALS-5.4.0-NOTICE.txt` | Unchanged [SUNDIALS v5.4.0 LICENSE](https://github.com/LLNL/sundials/blob/v5.4.0/LICENSE) and [NOTICE](https://github.com/LLNL/sundials/blob/v5.4.0/NOTICE), for the bundled `libsundials_cvode.so.5.4.0` and `libsundials_nvecserial.so.5.4.0`. |
| `MINPACK-license.txt` | Unchanged [CMinpack notice in the compiler's third-party submodule](https://github.com/OpenModelica/OMCompiler-3rdParty/blob/dfc66f9ee9ab081c79a33bcb208e3b307f48f16f/CMinpack/CopyrightMINPACK.txt). The FMU exports MINPACK support source. |
| `CLAPACK-3.2.1-license.txt`, `f2c-license.txt` | Netlib [CLAPACK 3.2.1 distribution](https://www.netlib.org/clapack/clapack-3.2.1-CMAKE.tgz) `COPYING` and [libf2c distribution](https://www.netlib.org/f2c/libf2c.zip) `Notice`, for corresponding numerical support sources. Original routine headers remain in the FMU. |
| `libcsv-notice-source.txt`, `LGPL-2.1.txt` | Unchanged license comment from [the compiler's libcsv 3.0.3 source](https://github.com/OpenModelica/OpenModelica/blob/6db4671/OMCompiler/SimulationRuntime/c/util/libcsv.c); full LGPL 2.1 copied from Ubuntu `/usr/share/common-licenses/LGPL-2.1`. The FMU includes `sources/util/libcsv.h`; this inventory does not assert that CSV implementation routines are linked. |
| `bundled-source-notices.txt` | Verbatim license comments extracted from actual FMU sources: FMI 1/2 headers, uthash, Modelica external-C helpers, CVODE wrapper, and build-support scripts. Source paths identify each excerpt. |
| `GPL-3.txt` | Full GPLv3 copied from Ubuntu `/usr/share/common-licenses/GPL-3`, for `config.guess`/`config.sub`; these scripts retain their Autoconf distribution exception in their original source and in the extracted notices. `install-sh` retains its X Consortium permission notice. |

This product includes software developed by the University of Chicago, as Operator of Argonne National Laboratory.

`SHA256SUMS` records the supplied notice files. Original source headers remain authoritative for the files to which they apply. The host's separately installed FMPy/Python packages retain their own distribution notices and are not inside these FMUs. No upstream software is relicensed as Apache-2.0 by this directory.
