"""Compare a single native Shippingport run with the reserved station readings."""
# SPDX-License-Identifier: Apache-2.0
import argparse
from datetime import datetime
from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import Path
import re
from statistics import fmean
import subprocess
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROTOCOL_FILE = HERE / "protocol.json"
NATIVE_FILE = HERE / "native.json"
RESULT_FILE = HERE / "result.json"
TARGETS = ("primaryPressure", "averageCoolantTemperature")
RESERVED = {"withheldEarly", "withheldLate"}
DURATION = 104400
STEP = 60
PROTOCOL_REVISION = "b10094f85ca9fa3f8b474c5e336554cdc1377679"
PROTOCOL_SHA256 = "9013c39c1049b0ee972b8717436367dd8669c79879107429cd78f944472eafb1"
CANDIDATE_REVISION = "86dc3f20212182502ecfbe12eea9cf8da48131eb"
REFERENCE_SHA256 = "cce59a95823dd0502b55bad69980c7e0da1033bac83f77723dbbcc0a18fd5673"
FIT_SHA256 = "6aedcb84b511f7b7066c14bc3d89d599583d1cface37c94845cdc796163822c8"
ARCHIVE_SHA256 = "701d7d34235466adb80c4d588a6dabc4ca26057081a60d3c7bfd19b13aba96c6"
ARCHIVE_FILE = HERE / "frozen-runners-701d7d342354.zip"
ARCHIVED_RUNNERS = {"scripts/modelica/build.py", "validation/shippingport_development/run_native.py"}
ORIGINAL_BASE = "models/ContinuousPlant.mo"
HISTORICAL_BASE = "validation/shippingport_development/model/ContinuousPlant.mo"
REPEAT_ABSOLUTE_TOLERANCE = {"primaryPressure": 0.001, "averageCoolantTemperature": 0.01}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_pinned(spec):
    raw = (ROOT / spec["path"]).read_bytes()
    require(sha256(raw).hexdigest() == spec["sha256"], "Fingerprint mismatch: " + spec["path"])
    return json.loads(raw)


def seconds(at, origin):
    return int((datetime.fromisoformat(at) - datetime.fromisoformat(origin)).total_seconds())


def observations(protocol):
    source = load_pinned(protocol["observations"])
    require(source["origin"] == protocol["origin"] and seconds(protocol["end"], source["origin"]) == DURATION,
            "Unexpected clock or duration.")
    selected = []
    for channel in source["channels"]:
        if channel["key"] not in TARGETS:
            continue
        rows = []
        initialized = False
        for point in channel["points"]:
            at = point["at"]
            elapsed = seconds(at, source["origin"])
            require(0 <= elapsed <= DURATION and (not rows or elapsed > rows[-1]["elapsedS"]),
                    "Station readings must be ordered and distinct within a channel.")
            expected = (0.101325 + point["raw"] * 0.006894757293168 if channel["key"] == "primaryPressure"
                        else (point["raw"] - 32) * 5 / 9)
            require(math.isclose(point["value"], expected, rel_tol=0, abs_tol=5.01e-10),
                    "Raw instrument and normalized observations disagree.")
            if point["excluded"]:
                split = "excluded"
            elif not initialized:
                split = "initialization"
                initialized = True
            else:
                split = next((block["key"] for block in protocol["withheldBlocks"]
                              if block["start"] <= at <= block["end"]), "development")
            rows.append({**point, "elapsedS": elapsed, "split": split})
        selected.append({k: channel[k] for k in ("key", "label", "unit", "rawUnit")} | {"points": rows})
    require({channel["key"] for channel in selected} == set(TARGETS) and len(selected) == 2,
            "Expected both target channels.")
    return selected


def development_data():
    """Only the two initialization readings and eligible development inputs cross this boundary."""
    protocol = json.loads(PROTOCOL_FILE.read_bytes())
    channels = []
    for channel in observations(protocol):
        points = [{k: p[k] for k in ("at", "elapsedS", "value", "split")} for p in channel["points"]
                  if p["split"] in ("initialization", "development")]
        channels.append({k: channel[k] for k in ("key", "label", "unit")} | {"points": points})
    return {"origin": protocol["origin"], "end": protocol["end"], "channels": channels}


def encode(data):
    return (json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def generic_traces(protocol):
    raw = load_pinned(protocol["genericPrediction"])
    fields = raw["columns"]
    rows = raw["rows"]
    require([r[fields.index("time")] for r in rows] == list(range(0, 27001, 30)),
            "Wrong generic time support.")
    return {
        "primaryPressure": [r[fields.index("primaryPressureMPa")] for r in rows],
        "averageCoolantTemperature": [(r[fields.index("hotLegTemperatureC")] + r[fields.index("coldLegTemperatureC")]) / 2
                                      for r in rows],
    }


def frozen_runner_sources():
    raw = ARCHIVE_FILE.read_bytes()
    require(sha256(raw).hexdigest() == ARCHIVE_SHA256, "Frozen candidate runner archive fingerprint mismatch.")
    with ZipFile(BytesIO(raw)) as archive:
        require(sorted(archive.namelist()) == sorted(ARCHIVED_RUNNERS), "Unexpected archived runner source list.")
        return {name: archive.read(name) for name in archive.namelist()}


def checkout_source(relative):
    path = (ROOT / relative).resolve()
    require(path.is_relative_to(ROOT) and path.is_file(), "Missing native source: " + relative)
    return path.read_bytes()


def frozen_model(raw):
    require(sha256(raw).hexdigest() == REFERENCE_SHA256, "Frozen candidate trace fingerprint mismatch.")
    return json.loads(raw)["model"]


def validate_source_lineage(model, reference, fresh):
    frozen_hashes = reference["sourceHashes"]
    archived = frozen_runner_sources()
    require(sha256((HERE / "fit.py").read_bytes()).hexdigest() == FIT_SHA256, "Frozen fitting source mismatch.")
    require(reference["gitRevision"] == reference["buildGitRevision"] == CANDIDATE_REVISION
            and reference["gitDirty"] is False and reference["buildGitDirty"] is False,
            "Original native evidence must identify the clean candidate checkpoint.")
    for original, expected in frozen_hashes.items():
        if original in archived:
            actual = archived[original]
        else:
            path = HISTORICAL_BASE if original == ORIGINAL_BASE else original
            actual = checkout_source(path)
        require(sha256(actual).hexdigest() == expected, "Frozen input differs from candidate: " + original)
    if not fresh:
        require(model == reference, "Original evidence has unexpected native provenance.")
        return
    current = model["sourceHashes"]
    for original, expected in frozen_hashes.items():
        now = HISTORICAL_BASE if original == ORIGINAL_BASE else original
        require(now in current, "Current build is missing a candidate input: " + now)
        if original not in archived:
            require(current[now] == expected, "Fresh native case changed a frozen input: " + now)
    for name, expected in current.items():
        require(sha256(checkout_source(name)).hexdigest() == expected, "Current build source hash mismatch: " + name)


def verify_embedded_sources(fmu_path, frozen_hashes):
    with ZipFile(fmu_path) as fmu:
        for original in (ORIGINAL_BASE, "models/ShippingportStartup.mo"):
            member = "sources/" + Path(original).name
            require(fmu.namelist().count(member) == 1 and sha256(fmu.read(member)).hexdigest() == frozen_hashes[original],
                    "Compiled FMU does not contain the frozen historical Modelica source: " + member)


def validate_provenance(model, reference, fresh):
    require(model.get("class") == "ShippingportStartup" and model.get("extends") == "ContinuousPlant",
            "A native ShippingportStartup whole-plant run is required.")
    require(re.fullmatch("[a-f0-9]{64}", model.get("fmuSha256", "")) and
            re.fullmatch("[a-f0-9]{40}", model.get("gitRevision", "")), "Missing native image or source identity.")
    execution = model.get("execution", {})
    require(execution.get("durationSeconds") == DURATION and execution.get("sampleIntervalSeconds") == STEP and
            execution.get("samples") == 1 + DURATION // STEP and
            execution.get("instances") == 1 and execution.get("resets") == 0 and
            execution.get("allSamplesWithinNativeDomain") is True, "Incomplete native execution record.")
    validate_source_lineage(model, reference, fresh)
    require(json.loads((HERE / "thermal-boundaries.json").read_bytes()) == model.get("boundaries"),
            "Native report and frozen effective boundaries disagree.")
    if not fresh:
        return
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()
    require(not dirty and model["gitRevision"] == model.get("buildGitRevision") == head and
            model.get("gitDirty") is False and model.get("buildGitDirty") is False,
            "Fresh native report must come from the current clean revision.")
    require(model.get("fmuPath") == "artifacts/modelica/ShippingportStartup.fmu" and
            model.get("manifestPath") == "artifacts/modelica/shippingport-manifest.json",
            "Fresh native provenance must identify the registered Shippingport artifact.")
    manifest = json.loads((ROOT / model["manifestPath"]).read_bytes())
    require(manifest.get("model") == model["class"] and manifest.get("gitRevision") == head and
            manifest.get("dirty") is False and manifest.get("fmuSha256") == model["fmuSha256"] and
            manifest.get("continuousSourceSha256") == model["sourceHashes"][HISTORICAL_BASE] and
            manifest.get("shippingportSourceSha256") == model["sourceHashes"]["models/ShippingportStartup.mo"] and
            sha256((ROOT / model["fmuPath"]).read_bytes()).hexdigest() == model["fmuSha256"],
            "Fresh native FMU, build manifest or revision mismatch.")
    verify_embedded_sources(ROOT / model["fmuPath"], reference["sourceHashes"])


def native_traces(native):
    columns = ["elapsedS", "averageCoolantTemperature", "primaryPressure"]
    require(native.get("columns") == columns and isinstance(native.get("rows"), list),
            "Unexpected native trace columns or rows.")
    require(isinstance(native.get("model"), dict) and native["model"], "Native run provenance is missing.")
    rows = native["rows"]
    require(len(rows) == DURATION // STEP + 1, "Incomplete native trace.")
    for i, row in enumerate(rows):
        require(len(row) == 3 and row[0] == STEP * i and
                all(type(v) in (float, int) and math.isfinite(v) for v in row),
                "Incomplete, irregular or nonfinite native sample grid.")
    return {key: [r[columns.index(key)] for r in rows] for key in TARGETS}


def interpolate(values, step, t):
    if t < 0 or t > step * (len(values) - 1):
        return None
    i, offset = divmod(t, step)
    if offset == 0:
        return values[i]
    return values[i] + (values[i + 1] - values[i]) * offset / step


def scored(rows, predictor):
    pairs = [(p["elapsedS"], p[predictor] - p["observed"]) for p in rows if p[predictor] is not None]
    if not pairs:
        return dict(n=0, bias=None, mae=None, rmse=None, maxAbs=None, firstElapsedS=None, lastElapsedS=None)
    errors = [e for _, e in pairs]
    return {"n": len(errors), "bias": fmean(errors), "mae": fmean(abs(e) for e in errors),
            "rmse": math.sqrt(fmean(e * e for e in errors)), "maxAbs": max(map(abs, errors)),
            "firstElapsedS": pairs[0][0], "lastElapsedS": pairs[-1][0]}


def scores(rows):
    common = [p for p in rows if all(p[k] is not None for k in ("predicted", "persistence", "generic"))]
    return {"candidate": scored(rows, "predicted"), "persistence": scored(rows, "persistence"),
            "commonGeneric": {"candidate": scored(common, "predicted"), "generic": scored(common, "generic"),
                              "persistence": scored(common, "persistence")}}


def improved(candidate, other):
    require(candidate["n"] == other["n"], "Comparison sample counts differ.")
    return candidate["rmse"] < other["rmse"] if candidate["n"] else None


def compare_channel(channel, native, generic):
    rows = []
    previous = None
    for p in channel["points"]:
        row = {k: p[k] for k in ("at", "elapsedS", "split", "excluded", "page", "raw")}
        row.update(observed=p["value"], predicted=interpolate(native, STEP, p["elapsedS"]),
                   generic=interpolate(generic, 30, p["elapsedS"]), persistence=previous)
        require(row["predicted"] is not None, "Native run lacks a station acquisition time.")
        rows.append(row)
        if p["split"] in ("initialization", "development"):
            previous = p["value"]
    groups = {"development": {"development"}, "withheldEarly": {"withheldEarly"}, "withheldLate": {"withheldLate"},
              "withheld": RESERVED, "allEligible": RESERVED | {"development"}}
    metrics = {k: scores([p for p in rows if p["split"] in split]) for k, split in groups.items()}
    held = metrics["withheld"]
    common = held["commonGeneric"]
    verdict = {"improvedVsPersistence": improved(held["candidate"], held["persistence"]),
               "improvedVsGeneric": improved(common["candidate"], common["generic"])}
    coverage = {"readings": len(rows), "initialization": sum(r["split"] == "initialization" for r in rows),
                "sourceExcluded": sum(r["split"] == "excluded" for r in rows),
                "development": metrics["development"]["candidate"]["n"], "withheld": held["candidate"]["n"],
                "withheldOutsideGenericWindow": held["candidate"]["n"] - common["generic"]["n"]}
    return {k: v for k, v in channel.items() if k != "points"} | {
        "points": rows, "modelTrace": [{"elapsedS": STEP * i, "value": v} for i, v in enumerate(native)],
        "genericTrace": [{"elapsedS": 30 * i, "value": v} for i, v in enumerate(generic)],
        "scores": metrics, "verdict": verdict, "coverage": coverage,
    }


def make_report(raw, *, fresh=False):
    protocol_bytes = PROTOCOL_FILE.read_bytes()
    require(sha256(protocol_bytes).hexdigest() == PROTOCOL_SHA256, "Assessment differs from the published split protocol.")
    protocol = json.loads(protocol_bytes)
    native = json.loads(raw)
    conditioned = native_traces(native)
    reference = frozen_model(NATIVE_FILE.read_bytes() if fresh else raw)
    validate_provenance(native["model"], reference, fresh)
    generic = generic_traces(protocol)
    channels = [compare_channel(c, conditioned[c["key"]], generic[c["key"]]) for c in observations(protocol)]
    blocks = [{**b, "startS": seconds(b["start"], protocol["origin"]), "endS": seconds(b["end"], protocol["origin"])}
              for b in protocol["withheldBlocks"]]
    return {
        "schema": "openpwr-shippingport-development-v1", "caseId": protocol["caseId"],
        "source": {"url": protocol["observations"]["source"], "pdfSha256": protocol["observations"]["pdfSha256"],
                   "observationSha256": protocol["observations"]["sha256"]},
        "protocol": {"revision": PROTOCOL_REVISION, "sha256": sha256(protocol_bytes).hexdigest()},
        "nativeTraceSha256": sha256(raw).hexdigest(), "genericTraceSha256": protocol["genericPrediction"]["sha256"],
        "model": native["model"], "origin": protocol["origin"], "durationS": DURATION, "genericDurationS": 27000,
        "withheldBlocks": blocks, "scope": protocol["scope"],
        "limitations": [
            "Both reserved windows belong to the same previously published startup. Model development uses other readings from this event.",
            "A developer had seen some early reserved readings while inspecting the public inventory before receiving the split. Those values supplied no inputs to calibration or selection of boundary times and magnitudes. This was a retrospective comparison.",
            "The interior block is bracketed by development measurements. The terminal block follows the final development reading.",
            "The generic prediction ends at 7.5 hours. Its comparison uses only matched readings from the first day.",
            "The station averaging method, instrument error bounds and continuous reactor power history are unavailable. Its generator breaker remained open.",
        ],
        "overallImprovement": all(v is True for c in channels for v in c["verdict"].values()),
        "channels": channels,
    }


def compare_repeat(reference, repeat):
    reference_series = native_traces(reference)
    repeat_series = native_traces(repeat)
    differences = {}
    for key in TARGETS:
        maximum = max(abs(a - b) for a, b in zip(reference_series[key], repeat_series[key]))
        require(maximum <= REPEAT_ABSOLUTE_TOLERANCE[key], "Fresh native run diverges in " + key)
        differences[key] = maximum
    return differences


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--development", action="store_true", help="emit only the permitted model-development data")
    action.add_argument("--write", action="store_true", help="retain a native reference trace and score it")
    action.add_argument("--check", action="store_true", help="regenerate the published assessment in memory")
    action.add_argument("--repeat", metavar="FRESH_NATIVE", type=Path, help="check a complete rebuild against the reference")
    parser.add_argument("--trace", type=Path, help="newly executed native JSON for --write")
    args = parser.parse_args()
    if bool(args.trace) != args.write:
        parser.error("use --trace and --write together")
    if args.development:
        print(json.dumps(development_data(), ensure_ascii=True, allow_nan=False))
        return
    raw = (args.trace or NATIVE_FILE).read_bytes()
    result = make_report(raw)
    if args.write:
        NATIVE_FILE.write_bytes(raw)
        RESULT_FILE.write_bytes(encode(result))
    else:
        require(RESULT_FILE.read_bytes() == encode(result), "Published result disagrees with measured and simulated data.")
    if args.repeat:
        repeat_raw = args.repeat.read_bytes()
        repeat = json.loads(repeat_raw)
        print("Maximum absolute differences on the repeated native grid:", compare_repeat(json.loads(raw), repeat))
        new_scores = make_report(repeat_raw, fresh=True)
        for frozen, fresh in zip(result["channels"], new_scores["channels"]):
            key = frozen["key"]
            require(key == fresh["key"] and frozen["verdict"] == fresh["verdict"],
                    "Fresh run changes the reserved-block outcome.")
            for group, expected in frozen["scores"].items():
                actual = fresh["scores"][group]["candidate"]
                require(expected["candidate"]["n"] == actual["n"] and
                        abs(expected["candidate"]["rmse"] - actual["rmse"]) <= REPEAT_ABSOLUTE_TOLERANCE[key],
                        "Fresh run changes the score for " + key + " / " + group)
            print("Repeated reserved measurements", key, fresh["scores"]["withheld"]["candidate"])
    for c in result["channels"]:
        print(c["key"], "withheld", json.dumps(c["scores"]["withheld"]), "verdict", c["verdict"])


if __name__ == "__main__":
    main()
