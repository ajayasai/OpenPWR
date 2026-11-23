"""Extract the electrical channels of the published v0.11 OpenPWR startup run."""

# SPDX-License-Identifier: Apache-2.0
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[1]
REPORT_NAME = "continuous-verification.json"
REPORT_URL = f"https://github.com/ajayasai/OpenPWR/releases/download/v0.11.0/{REPORT_NAME}"
REPORT_SHA256 = "9952b17ef7718a4fcff5c219d4cee87921ebc9897e596e4767b429fd091589a2"
REPORT_BYTES = 18134399
REPLAY_CHANNELS = (
    "hotLegTemperatureC coldLegTemperatureC fuelTemperatureC primaryPressureMPa primarySubcoolingK "
    "pressurizerLevelPercent secondaryPressureMPa secondaryTemperatureC secondaryLevelPercent "
    "primaryFlowKgS pumpSpeed reactorPowerMW fissionPowerMW neutronPowerFraction reactivityPcm "
    "rodReactivityPcm externalSourceFractionPerSecond turbineRpm turbineFlowKgS turbineMechanicalPowerMW "
    "feedwaterFlowKgS grossPowerMW netPowerMW gridConnected phaseDifferenceDeg generatorVoltagePu "
    "frequencyDifferenceHz syncPermissive rotorEnergyMJ condenserPressureKPa coolingPowerMW "
    "plantEnergyResidualMW plantMassResidualKgS totalPlantStoredEnergyMJ totalPlantMassKg "
    "reactorTripped turbineTripped hotStandbyReady fullPowerReady loadReferenceMW synchronizationDwellS "
    "breakerClosingTimeS breakerClosingPhaseDeg breakerClosingFrequencyHz breakerClosingVoltagePu "
    "breakerClosingDwellS governorValveFraction stopValveFraction"
).split()


def extract(report_bytes):
    if len(report_bytes) != REPORT_BYTES or hashlib.sha256(report_bytes).hexdigest() != REPORT_SHA256:
        raise ValueError("The report differs from the official v0.11.0 release asset.")
    report = json.loads(report_bytes)
    scenario = next(s for s in report["scenarios"] if s["id"] == "full-startup")
    if not scenario["complete"] or not scenario["singleFmuInstance"] or scenario["resetCount"] != 0:
        raise ValueError("The source trajectory is incomplete or contains a reset.")
    trace = scenario["trace"]
    electrical = {
        "schema": "openpwr-startup-electrical-output-v1",
        "source": {
            "release": "v" + report["version"],
            "gitRevision": report["gitRevision"],
            "url": REPORT_URL,
            "reportSha256": REPORT_SHA256,
            "reportBytes": REPORT_BYTES,
            "scenarioId": scenario["id"],
            "fmuSha256": scenario["runtime"]["fmuSha256"],
        },
        "nominalNetPowerMW": 1000,
        "sampleIntervalSeconds": scenario["sampleIntervalSeconds"],
        "durationSeconds": scenario["durationSeconds"],
        "breakerClosingElapsedSeconds": trace[-1]["breakerClosingTimeS"],
        "points": [
            {
                "elapsedSeconds": sample["time"],
                "netPowerMW": sample["netPowerMW"],
                "grossPowerMW": sample["grossPowerMW"],
            }
            for sample in trace
        ],
    }
    replay = {
        "schema": "openpwr-native-startup-replay-v1",
        "source": electrical["source"],
        "durationSeconds": scenario["durationSeconds"],
        "sampleIntervalSeconds": scenario["sampleIntervalSeconds"],
        "columns": ["time", *REPLAY_CHANNELS],
        "rows": [[point["time"], *(point[key] for key in REPLAY_CHANNELS)] for point in trace],
    }
    return electrical, replay


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--report", type=Path, help="Local copy of the original release asset")
    source.add_argument("--download", action="store_true", help="Fetch the original release asset from GitHub")
    parser.add_argument("--check", action="store_true", help="Verify the committed export without writing it")
    args = parser.parse_args()
    if args.download:
        with urlopen(REPORT_URL, timeout=90) as response:
            report_bytes = response.read(REPORT_BYTES + 1)
    else:
        path = args.report or ROOT / "artifacts" / "release-v0.11.0" / REPORT_NAME
        if not path.is_file():
            parser.error(f"Missing release asset at {path}. Supply --report PATH or use --download.")
        report_bytes = path.read_bytes()

    electrical, replay = extract(report_bytes)
    for name, data, options in [
        ("model.json", electrical, {"indent": 2}),
        ("replay.json", replay, {"separators": (",", ":")}),
    ]:
        encoded = (json.dumps(data, allow_nan=False, **options) + "\n").encode("utf-8")
        path = DIRECTORY / name
        if args.check:
            if path.read_bytes() != encoded:
                raise SystemExit(f"{name} differs from the pinned native observations.")
        else:
            path.write_bytes(encoded)
        print(f"{name}: {len(electrical['points'])} samples, SHA-256 {hashlib.sha256(encoded).hexdigest()}")


if __name__ == "__main__":
    main()
