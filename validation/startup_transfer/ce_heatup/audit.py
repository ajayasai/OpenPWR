# SPDX-License-Identifier: Apache-2.0
"""Independently audit the C-E forecasts and bound the effect of vertical plot error."""
from math import expm1
from pathlib import Path
import json

import numpy as np


HERE = Path(__file__).resolve().parent
HOUR = 3600
# The scored fixture rounds SI readings to six decimals. This audit converts
# the original Fahrenheit and psig values without rounding.
SCORE_TOLERANCE = 3e-6


def channel_inputs(records, channel):
    # The plot is 168 points tall. Half the stroke width plus half the
    # tabulation rounding interval gives the assumed vertical error radius.
    if channel == "averageCoolantTemperature":
        values = [((p["hotF"] + p["coldF"]) / 2 - 32) * 5 / 9 for p in records]
        radius = (0.75 * 600 / 168 + 0.05) * 5 / 9
    elif channel == "primaryPressure":
        values = [0.101325 + p["pressurePsig"] * 0.006894757293168 for p in records]
        radius = (0.99 * 2500 / 168 + 0.5) * 0.006894757293168
    else:
        raise ValueError(f"Unknown measured channel: {channel}")
    return np.asarray(values), radius


def error_operators(n, lead_hours, parameters):
    """Error of persistence = A*y; error of the candidate = B*y + offset."""
    count = n - lead_hours
    origins = np.arange(count)
    persistence = np.zeros((count, n))
    persistence[origins, origins] = 1
    persistence[origins, origins + lead_hours] = -1
    candidate = persistence.copy()
    offset = np.zeros(count)
    tau = parameters["memoryS"]
    trend_s = -tau * expm1(-lead_hours * HOUR / tau) if tau else 0
    # At hour 1 the candidate has a transferred initial rate. Later origins
    # estimate their rate from exactly the last two hourly observations.
    offset[0] = parameters["initialRatePerS"] * trend_s
    subsequent = origins[1:]
    candidate[subsequent, subsequent] += trend_s / HOUR
    candidate[subsequent, subsequent - 1] -= trend_s / HOUR
    return persistence, candidate, offset


def check_scores(errors, expected):
    actual = {
        "rmse": np.sqrt(np.mean(errors ** 2)),
        "mae": np.mean(np.abs(errors)),
        "bias": np.mean(errors),
        "maxAbs": np.max(np.abs(errors)),
    }
    for metric, value in actual.items():
        np.testing.assert_allclose(value, expected[metric], rtol=0, atol=SCORE_TOLERANCE,
                                   err_msg=f"Mismatch in published {metric}")
    return actual["rmse"]


def audit(channel, hours, records, parameters, published):
    y, radius = channel_inputs(records, channel)
    a, b, offset = error_operators(len(y), hours, parameters)
    past_error = a @ y
    model_error = b @ y + offset
    n = len(past_error)
    points = published["points"]
    if published["n"] != n or len(points) != n:
        raise ValueError("Published horizon count differs from the complete hourly grid")
    for i, point in enumerate(points):
        if (point["originS"], point["targetS"]) != ((i + 1) * HOUR, (i + hours + 1) * HOUR):
            raise ValueError("Published forecast origin or target differs from the hourly grid")
    measured = y[hours:]
    np.testing.assert_allclose(
        [(p["observed"], p["forecast"], p["persistence"]) for p in points],
        np.column_stack((measured, measured + model_error, measured + past_error)),
        rtol=0, atol=SCORE_TOLERANCE,
    )
    model_rmse = check_scores(model_error, published["candidate"])
    past_rmse = check_scores(past_error, published["persistence"])

    # Expand G(y+d), the difference between the two mean squared errors.
    # Each reading is shared wherever it appears as an input or target.
    gain = (past_error @ past_error - model_error @ model_error) / n
    gradient = 2 * (a.T @ past_error - b.T @ model_error) / n
    quadratic = (a.T @ a - b.T @ b) / n
    lower_bound = gain - radius * np.abs(gradient).sum() - radius**2 * np.abs(quadratic).sum()
    if lower_bound <= 0:
        raise ValueError(f"Digitization interval does not establish positive MSE gain: {lower_bound}")
    return {
        "channel": channel, "leadHours": hours, "pairs": n,
        "candidateRmse": float(model_rmse), "persistenceRmse": float(past_rmse),
        "verticalErrorRadius": radius, "lowerBoundMseGain": float(lower_bound),
    }


def main():
    records = json.loads((HERE / "observations.json").read_bytes())["records"]
    parameters = json.loads((HERE.parent / "parameters.json").read_bytes())["channels"]
    report = json.loads((HERE.parent / "result.json").read_bytes())
    if [p["elapsedS"] for p in records] != list(range(HOUR, 24 * HOUR, HOUR)):
        raise ValueError("The source must include hours 1 through 23")
    event = next(event for event in report["events"] if event["id"] == "ce")
    for label, hours in (("oneHour", 1), ("fourHour", 4)):
        group = next(group for group in event["groups"] if group["id"] == label)
        for channel in ("primaryPressure", "averageCoolantTemperature"):
            published = next(item for item in group["channels"] if item["id"] == channel)
            print(json.dumps(audit(channel, hours, records, parameters[channel], published), allow_nan=False))


if __name__ == "__main__":
    main()
