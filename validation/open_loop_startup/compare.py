# SPDX-License-Identifier: Apache-2.0
"""Score frozen native predictions at the station observation times."""
import argparse
from datetime import datetime, timedelta
import hashlib
import json
import math
from pathlib import Path
from statistics import fmean


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CHANNELS = ("primaryPressureMPa", "averageCoolantTemperatureC")
NATIVE_FIELDS = (*CHANNELS, "hotLegTemperatureC", "coldLegTemperatureC", "reactorPowerMW", "netPowerMW")
ATM_MPA = 0.101325


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    return json.loads(path.read_bytes())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode(value):
    return (json.dumps(value, indent=2, allow_nan=False) + "\n").encode()


def number(value):
    require(type(value) in (float, int) and math.isfinite(value), f"Invalid measurement {value!r}")
    return value


def stats(errors):
    return {
        "n": len(errors),
        "rmse": round(math.sqrt(fmean(e * e for e in errors)), 6),
        "mae": round(fmean(abs(e) for e in errors), 6),
        "bias": round(fmean(errors), 6),
        "maxAbsoluteError": round(max(abs(e) for e in errors), 6),
    }


def grid(report):
    rows = report["trajectory"]
    require([row["elapsedS"] for row in rows] == list(range(0, 500 * 3600 + 1, 300)),
            "Expected the entire 500-hour native trajectory on the registered grid")
    for row in rows:
        for key in NATIVE_FIELDS:
            number(row[key])
        require(row["gridConnected"] in (0, 1), "Invalid native breaker indication")
        require(abs((row["hotLegTemperatureC"] + row["coldLegTemperatureC"]) / 2
                    - row["averageCoolantTemperatureC"]) < 1e-5, "Native mean disagrees with legs")
    return {row["elapsedS"]: row for row in rows}


def summarize(rows, origin):
    result = {}
    for key in CHANNELS:
        native = [row["native"][key] - row["station"][key] for row in rows]
        persistence = [origin[key] - row["station"][key] for row in rows]
        # Compare the unrounded sums on precisely the same rows.
        result[key] = {"native": stats(native), "originPersistence": stats(persistence),
                       "beatsOriginPersistence": math.fsum(e*e for e in native) < math.fsum(e*e for e in persistence)}
    return result


def row_at(index, seconds, station):
    predicted = index[seconds]
    for key in CHANNELS:
        number(station[key])
    return {"elapsedHours": seconds // 3600, "station": station,
            "native": {key: predicted[key] for key in (*NATIVE_FIELDS, "gridConnected")}}


def residual(row):
    return {key: round(row["native"][key] - row["station"][key], 6) for key in CHANNELS}


def westinghouse(index, fixture):
    observations = fixture["records"]
    require([r["elapsedS"] for r in observations] == list(range(0, 61 * 3600, 3600)),
            "Expected Westinghouse hours 0 through 60")
    rows = []
    for obs in observations:
        pressure = round(ATM_MPA + number(obs["pressurePsig"]) * 0.006894757293168, 6)
        temperature = round(((number(obs["hotF"]) + number(obs["coldF"])) / 2 - 32) * 5 / 9, 6)
        require(pressure == obs[CHANNELS[0]] and temperature == obs[CHANNELS[1]], "Unit conversion mismatch")
        rows.append(row_at(index, obs["elapsedS"], {key: obs[key] for key in CHANNELS}))
    initial = rows[0]["station"]
    return {"id": fixture["caseId"], "sourceUrl": fixture["source"], "measuredScope": "Station heatup at zero reactor power",
            "clock": "Figure elapsed hours 0 through 60", "initialError": residual(rows[0]),
            "scores": summarize(rows[1:], initial),
            "blocks": [{"fromHourExclusive": h, "toHourInclusive": h + 20,
                        "scores": summarize(rows[h+1:h+21], initial)} for h in (0, 20, 40)],
            "rows": rows}


def ohi(index, fixture):
    origin = datetime.fromisoformat("2012-06-26T13:00:00+09:00")
    observations = fixture["records"]
    require(len(observations) == 14, "Expected all 14 Ohi daily observations")
    rows = []
    for day, obs in enumerate(observations):
        time = datetime.fromisoformat(obs["timestamp"])
        require(time == origin + timedelta(days=day) and time.utcoffset() == origin.utcoffset()
                and obs["elapsedHours"] == day * 24, "Unexpected Ohi station clock")
        station = {"primaryPressureMPa": round(number(obs["pressureMPaGauge"]) + ATM_MPA, 6),
                   "averageCoolantTemperatureC": number(obs["coolantTemperatureC"]),
                   "generatorGrossMW": obs["generatorMW"]}
        if station["generatorGrossMW"] is not None:
            number(station["generatorGrossMW"])
        row = row_at(index, day * 86400, station)
        row.update(timestamp=obs["timestamp"], sourceUrl=obs["sourceUrl"], page=obs["page"],
                   stationGrossLoadFraction=(None if obs["generatorMW"] is None else round(obs["generatorMW"]/1180, 6)),
                   nativeNetLoadFraction=round(row["native"]["netPowerMW"]/1000, 6))
        rows.append(row)
    errors_raw = [row["native"][CHANNELS[0]] - obs["pressureMPaGauge"] for row, obs in zip(rows[1:], observations[1:])]
    return {"id": "kepco-ohi3-2012", "measuredScope": "Daily snapshots from cold shutdown through rated thermal power",
            "clock": "13:00 JST each day, June 26 through July 9, 2012",
            "initialError": residual(rows[0]), "finalError": residual(rows[-1]),
            "scores": summarize(rows[1:], rows[0]["station"]),
            "pressureRawAsAbsoluteSensitivity": stats(errors_raw),
            "rows": rows}


def score():
    lock = load(HERE / "freeze.json")
    for relative, expected in lock["sha256"].items():
        require(digest(ROOT / relative) == expected, f"Changed frozen input: {relative}")
    index = grid(load(HERE / "native.json"))
    return {
        "schema": "openpwr-native-open-loop-validation-v1",
        "provenance": lock,
        "nativeSamples": len(index), "nativeDurationHours": 500,
        "pressureUnit": "MPa absolute", "temperatureUnit": "degrees Celsius",
        "reference": "Station hour-zero pressure and temperature carried forward through the event",
        "ohi": ohi(index, load(HERE / "ohi/observations.json")),
        "westinghouse": westinghouse(index, load(HERE / "measured/observations.json")),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--write", action="store_true")
    actions.add_argument("--check", action="store_true")
    actions.add_argument("--repeat", type=Path, help="verify a fresh native run against the frozen trajectory")
    args = parser.parse_args()
    result = score()
    output = HERE / "result.json"
    if args.write:
        output.write_bytes(encode(result))
    else:
        require(load(output) == result, "Published validation differs from recomputed results")
    if args.repeat:
        from verify_repeat import verify
        verify(load(HERE / "native.json"), load(args.repeat))
    for name in ("ohi", "westinghouse"):
        print(name, json.dumps(result[name]["scores"]))


if __name__ == "__main__":
    main()
