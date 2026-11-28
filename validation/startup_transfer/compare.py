# SPDX-License-Identifier: Apache-2.0
"""Score a fixed measurement-conditioned forecast against the last available reading."""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from statistics import fmean

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
from validation.shippingport_development import assess as historical
from validation.startup_transfer.model import forecast

CHANNELS = {
    "primaryPressure": ("Reactor pressure", "MPa absolute", "primaryPressureMPa"),
    "averageCoolantTemperature": ("Mean primary coolant temperature", "°C", "averageCoolantTemperatureC"),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rmse(errors):
    return math.sqrt(fmean(e * e for e in errors))


def summaries(errors):
    return {"rmse": rmse(errors), "mae": fmean(map(abs, errors)), "bias": fmean(errors),
            "maxAbs": max(map(abs, errors))}


def compare(key, points):
    if not points:
        raise ValueError("A declared evaluation window contains no observations.")
    candidate = [p["forecast"] - p["observed"] for p in points]
    baseline = [p["persistence"] - p["observed"] for p in points]
    new, old = summaries(candidate), summaries(baseline)
    differences = [abs(b) - abs(a) for a, b in zip(candidate, baseline)]
    leave_one = []
    if len(points) > 1:
        for i in range(len(points)):
            leave_one.append(rmse(baseline[:i] + baseline[i+1:]) - rmse(candidate[:i] + candidate[i+1:]))
    label, unit, _ = CHANNELS[key]
    return {"id": key, "label": label, "unit": unit, "n": len(points), "candidate": new,
            "persistence": old, "improved": new["rmse"] < old["rmse"],
            "rmseReductionPct": 100 * (1 - new["rmse"] / old["rmse"]) if old["rmse"] else None,
            "wins": sum(d > 0 for d in differences), "ties": differences.count(0),
            "losses": sum(d < 0 for d in differences),
            "deleteOneRmseAdvantageRange": [min(leave_one), max(leave_one)] if leave_one else None,
            "points": points}


def issued_point(key, history, target_s, observed, parameters):
    origin_s, last_value = history[-1]
    if not origin_s < target_s:
        raise ValueError("A forecast must precede its target.")
    value = forecast(key, history, target_s, parameters)
    if not all(map(math.isfinite, (observed, value, last_value))):
        raise ValueError("Missing or nonfinite observation or prediction.")
    return {"originS": origin_s, "targetS": target_s, "observed": observed,
            "forecast": value, "persistence": last_value}


def shippingport_points(key, samples, parameters):
    history = []
    blocks = {"withheldEarly": [], "withheldLate": []}
    for sample in samples:
        split = sample["split"]
        if split in ("initialization", "development"):
            history.append((sample["elapsedS"], sample["value"]))
        elif split in blocks:
            blocks[split].append(issued_point(key, history, sample["elapsedS"], sample["value"], parameters))
        elif split != "excluded":
            raise ValueError(f"Unexpected historical split {split}.")
    return blocks


def historical_event(parameters):
    protocol = json.loads(historical.PROTOCOL_FILE.read_bytes())
    records = historical.observations(protocol)
    splits = {ch["key"]: shippingport_points(ch["key"], ch["points"], parameters) for ch in records}
    groups = []
    for group, label, blocks in (
        ("reserved", "Both reserved windows", ("withheldEarly", "withheldLate")),
        ("reservedEarly", "Early reserved window", ("withheldEarly",)),
        ("reservedLate", "Terminal reserved window", ("withheldLate",)),
    ):
        channels = [compare(key, [p for b in blocks for p in splits[key][b]]) for key in CHANNELS]
        groups.append({"id": group, "label": label, "primary": group == "reserved", "channels": channels})
    if [ch["n"] for ch in groups[0]["channels"]] != [10, 9]:
        raise ValueError("The assessment lost original Shippingport test readings.")
    return {"id": "shippingport", "label": "Shippingport, June 1958",
            "sourceUrl": protocol["observations"]["source"],
            "description": "Previously published test windows. Both forecasts stop receiving readings before each window.",
            "groups": groups}


def external_points(key, samples, horizon, parameters):
    history = []
    points = []
    for index in range(len(samples) - horizon):
        history.append(samples[index])
        target_s, observed = samples[index + horizon]
        points.append(issued_point(key, history, target_s, observed, parameters))
    return points


def external_event(observations, protocol, parameters):
    rows = observations["records"]
    if [p["elapsedS"] for p in rows] != list(range(3600, 24*3600, 3600)):
        raise ValueError("The independent heatup must cover every registered hour.")
    for p in rows:
        pressure = 0.101325 + p["pressurePsig"] * 0.006894757293168
        temperature = ((p["hotF"] + p["coldF"]) / 2 - 32) * 5 / 9
        if abs(pressure-p["primaryPressureMPa"]) > 1e-5 or abs(temperature-p["averageCoolantTemperatureC"]) > 1e-4:
            raise ValueError("Converted readings disagree with source units.")
    groups = []
    for lead, group, label in [(1, "oneHour", "One-hour forecasts"), (4, "fourHour", "Four-hour forecasts")]:
        channels = []
        for key, (_, _, column) in CHANNELS.items():
            history = [(p["elapsedS"], p[column]) for p in rows]
            channels.append(compare(key, external_points(key, history, lead, parameters)))
        groups.append({"id": group, "label": label, "primary": lead == 1, "channels": channels})
    return {"id": "ce", "label": "Combustion Engineering PWR heatup",
            "sourceUrl": protocol["external"]["source"],
            "description": "Measured operating record from an unnamed unit. Forecasts use readings available through each issue time.",
            "groups": groups}


def rounded(value):
    # Stabilize portable JSON across libm implementations far below source-plot resolution.
    if isinstance(value, float):
        return round(value, 10) or 0.0
    if isinstance(value, list):
        return [rounded(v) for v in value]
    if isinstance(value, dict):
        return {k: rounded(v) for k, v in value.items()}
    return value


def report():
    lock = json.loads((HERE / "lock.json").read_bytes())
    for name, expected in lock["sha256"].items():
        if digest(ROOT / name) != expected:
            raise ValueError(f"Frozen input has changed: {name}")
    protocol = json.loads((HERE / "protocol.json").read_bytes())
    parameters = json.loads((HERE / "parameters.json").read_bytes())
    fixture = HERE / "ce_heatup/observations.json"
    events = [historical_event(parameters), external_event(json.loads(fixture.read_bytes()), protocol, parameters)]
    passed = all(c["improved"] for e in events for g in e["groups"] if g["primary"] for c in g["channels"])
    return rounded({"schema": "openpwr-startup-transfer-v1", "protocolRevision": lock["protocolRevision"],
                    "candidateRevision": lock["candidateRevision"], "candidateAndInputSha256": lock["sha256"],
                    "externalFixtureSha256": digest(fixture), "sourcePdfSha256": protocol["external"]["pdfSha256"],
                    "allPrimaryComparisonsPassed": passed, "scope": protocol["scoring"]["scope"],
                    "events": events})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    opts = parser.add_mutually_exclusive_group()
    opts.add_argument("--write", action="store_true")
    opts.add_argument("--check", action="store_true")
    args = parser.parse_args()
    result = report()
    data = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()
    out = HERE / "result.json"
    if args.write:
        out.write_bytes(data)
    elif out.read_bytes() != data:
        raise SystemExit("Published results differ from the frozen evaluation.")
    for event in result["events"]:
        for group in event["groups"]:
            for channel in group["channels"]:
                print(event["id"], group["id"], channel["id"], channel["n"],
                      channel["candidate"]["rmse"], channel["persistence"]["rmse"], channel["improved"])
