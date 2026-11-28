# SPDX-License-Identifier: Apache-2.0
"""Causal damped-trend observation model for startup pressure and temperature."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import fmean, median
import subprocess
import sys


HERE = Path(__file__).resolve().parent
TRAINING = HERE.parent / "shippingport_development"
PARAMETERS = HERE / "parameters.json"
CHANNELS = ("primaryPressure", "averageCoolantTemperature")
UNITS = {"primaryPressure": "MPa absolute", "averageCoolantTemperature": "°C"}
MEMORY_MULTIPLIERS = (0.0, 0.25, 0.5, 1.0, 2.0, 4.0)
PRIOR_INTERVAL_S = 3600
NATIVE_SHA256 = "cce59a95823dd0502b55bad69980c7e0da1033bac83f77723dbbcc0a18fd5673"


def forecast(channel, allowed_history, target_elapsed_s, parameters):
    """Return a conditional forecast in MPa absolute or °C, without updating history."""
    if channel not in CHANNELS:
        raise ValueError("Unknown observation channel.")
    if not allowed_history:
        raise ValueError("A conditional forecast needs at least one observed value.")
    if not math.isfinite(target_elapsed_s):
        raise ValueError("Forecast time must be finite.")
    previous_time = -math.inf
    for time, value in allowed_history:
        if not (math.isfinite(time) and math.isfinite(value) and previous_time < time < target_elapsed_s):
            raise ValueError("Observations must be finite, ordered and strictly earlier than the target.")
        previous_time = time
    params = parameters["channels"][channel]
    tau = params["memoryS"]
    if not math.isfinite(tau) or tau < 0:
        raise ValueError("Trend memory must be finite and nonnegative.")
    time, value = allowed_history[-1]
    if tau == 0:
        return value
    if len(allowed_history) == 1:
        rate = params["initialRatePerS"]
    else:
        earlier_time, earlier_value = allowed_history[-2]
        rate = (value - earlier_value) / (time - earlier_time)
    if not math.isfinite(rate):
        raise ValueError("Forecast rate must be finite.")
    lead = target_elapsed_s - time
    return value + rate * tau * -math.expm1(-lead / tau)


def fit_parameters(development, native):
    """Select a memory time per channel from chronological development-only forecasts."""
    readings = {}
    for channel in development["channels"]:
        points = channel["points"]
        if any(p["split"] not in ("initialization", "development") for p in points):
            raise ValueError("Only initializer and development observations may be supplied.")
        readings[channel["key"]] = [(p["elapsedS"], p["value"]) for p in points]
    if set(readings) != set(CHANNELS):
        raise ValueError("Expected primary pressure and average coolant temperature.")
    steps = [b[0] - a[0] for points in readings.values() for a, b in zip(points, points[1:])]
    if not steps or min(steps) <= 0:
        raise ValueError("Development observations must have increasing times.")
    cadence = median(steps)
    native_rows = {row[0]: row for row in native["rows"]}
    parameters = {
        "schema": "openpwr-startup-damped-trend-v1",
        "nativeSha256": NATIVE_SHA256,
        "developmentSha256": hashlib.sha256(
            json.dumps(development, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        ).hexdigest(),
        "medianReportingIntervalS": cadence,
        "initialNativeRateIntervalS": PRIOR_INTERVAL_S,
        "channels": {},
    }
    for channel in CHANNELS:
        points = readings[channel]
        origin = points[0][0]
        index = native["columns"].index(channel)
        prior = (native_rows[origin + PRIOR_INTERVAL_S][index] - native_rows[origin][index]) / PRIOR_INTERVAL_S
        params = {"initialRatePerS": prior, "nativeRateOriginS": origin, "developmentForecasts": len(points) - 1}
        parameters["channels"][channel] = params
        losses = []
        for multiplier in MEMORY_MULTIPLIERS:
            params["memoryS"] = multiplier * cadence
            squared_errors = [
                (forecast(channel, points[:i], time, parameters) - value) ** 2
                for i, (time, value) in enumerate(points) if i
            ]
            losses.append((fmean(squared_errors), params["memoryS"]))
        params["memoryS"] = min(losses)[1]
        params["developmentRmseByMemory"] = [
            {"memoryS": tau, "rmse": round(math.sqrt(loss), 10)} for loss, tau in losses
        ]
    return parameters


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--write", action="store_true", help="write fitted parameters from development observations")
    action.add_argument("--check", action="store_true", help="recreate and compare the frozen parameters")
    action.add_argument("--forecast", metavar="JSON", type=Path,
                        help="forecast from a JSON file containing channel, history and targetElapsedS")
    args = parser.parse_args()
    if args.forecast:
        request = json.loads(args.forecast.read_bytes())
        channel, history, target = request["channel"], request["history"], request["targetElapsedS"]
        params = json.loads(PARAMETERS.read_bytes())
        estimate = forecast(channel, history, target, params)
        print(json.dumps({"channel": channel, "unit": UNITS[channel], "originElapsedS": history[-1][0],
                          "targetElapsedS": target, "prediction": estimate, "lastReading": history[-1][1]},
                         allow_nan=False))
        return
    native_raw = (TRAINING / "native.json").read_bytes()
    if hashlib.sha256(native_raw).hexdigest() != NATIVE_SHA256:
        raise ValueError("The archived whole-plant trajectory differs from the registered model.")
    allowed = subprocess.check_output([sys.executable, str(TRAINING / "assess.py"), "--development"])
    result = fit_parameters(json.loads(allowed), json.loads(native_raw))
    payload = (json.dumps(result, indent=2, allow_nan=False) + "\n").encode("utf-8")
    if args.write:
        PARAMETERS.write_bytes(payload)
    elif PARAMETERS.read_bytes() != payload:
        raise ValueError("Frozen parameters differ from the training-only fit.")
    for channel, params in result["channels"].items():
        print(channel, "memory", params["memoryS"], "seconds; initial rate", params["initialRatePerS"], "per second")


if __name__ == "__main__":
    main()
