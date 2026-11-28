# SPDX-License-Identifier: Apache-2.0
"""Check numerical reproducibility across independent OpenModelica builds."""
import json
import subprocess

from compare import ROOT, digest, grid, require


LIMITS = {"hotLegTemperatureC": 0.1, "coldLegTemperatureC": 0.1,
          "averageCoolantTemperatureC": 0.1, "primaryPressureMPa": 0.02,
          "reactorPowerMW": 15, "netPowerMW": 10, "neutronPowerFraction": 0.005}


def verify(reference, fresh):
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    version = json.loads((ROOT / "package.json").read_bytes())["version"]
    require(fresh["runRevision"] == fresh["modelBuildRevision"] == sha
            and fresh["packageVersion"] == fresh["modelBuildPackageVersion"] == version,
            "The repeat must run on a model built at the current revision and version")
    for report in (fresh, reference):
        require(report["numericalVerificationPassed"] and report["refinement"]["pass"], "Native numerical check failed")
        require(report["runDirty"] is False and report["modelBuildDirty"] is False, "Dirty native run or build")
        require(report["observationsUsed"] == report["stateResetsAfterInitialization"] == 0, "Unexpected input or reset")
        require([r["stepSeconds"] for r in report["nativeRuns"]] == [10, 5], "Incorrect refinement pair")
        for run in report["nativeRuns"]:
            require(all(run["checks"].values()) and run["singleFmuInstancesPerRun"] == 1
                    and run["nativeValidAtEveryCommunicationPoint"]
                    and run["terminalRatedDwellSeconds"] >= 600, "Native run did not pass")
    require(fresh["sourceSha256"] == reference["sourceSha256"], "Native prediction implementation changed")
    for name, expected in reference["sourceSha256"].items():
        require(digest(ROOT / name) == expected, f"Source differs from the candidate: {name}")
    fmu = ROOT / "artifacts/modelica/ContinuousPlant.fmu"
    require(digest(fmu) == fresh["nativeRuntime"]["fmuSha256"], "Repeat does not match available FMU")
    old, new = grid(reference), grid(fresh)
    require(all(old[t]["gridConnected"] == new[t]["gridConnected"] for t in old), "Breaker state changed")
    for run, previous in zip(fresh["nativeRuns"], reference["nativeRuns"]):
        require(abs(run["firstNativeGridConnectionS"] - previous["firstNativeGridConnectionS"]) <= run["stepSeconds"]
                and abs(run["terminalRatedDwellStartS"] - previous["terminalRatedDwellStartS"]) <= 300,
                "Grid or rated-power timing changed")
    maxima = {key: max(abs(new[t][key] - old[t][key]) for t in old) for key in LIMITS}
    for key, bound in LIMITS.items():
        require(maxima[key] <= bound, f"Repeat {key} differs by {maxima[key]}, exceeding {bound}")
    print(f"Verified {len(old)} native rows. Maximum cross-build differences: {maxima}")
