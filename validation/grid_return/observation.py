"""Reproduce Sizewell B generator-meter observations using the Python standard library."""
# SPDX-License-Identifier: Apache-2.0
import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "sizewell-b-2024.json"
START = datetime(2024, 11, 30, tzinfo=timezone.utc)
STOP = datetime(2024, 12, 7, tzinfo=timezone.utc)
INTERVAL = timedelta(minutes=30)
COUNT = (STOP - START) // INTERVAL
DIGESTS = {
    "T_SIZB-1": "db85d752ede723f32c10806bee10c779460f7b72c034afff17a170899f2678e1",
    "T_SIZB-2": "2a99a92d2c766fc2be1bdce2dccd9e6b9459b6e0f2ab69401e1004563c979bc2",
}
LICENCE = ("https://www.elexon.co.uk/bsc/data/balancing-mechanism-reporting-agent/"
           "copyright-licence-bmrs-data/")


def source_url(unit):
    query = urlencode({
        "settlementDateFrom": START.date().isoformat(),
        "settlementPeriodFrom": 1,
        "settlementDateTo": (STOP - INTERVAL).date().isoformat(),
        "settlementPeriodTo": 48,
        "bmUnit": unit,
    })
    return "https://data.elexon.co.uk/bmrs/api/v1/datasets/B1610/stream?" + query


def utc_label(time):
    return time.isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_meter(raw, unit):
    rows = json.loads(raw, parse_float=Decimal, parse_int=Decimal)
    if not isinstance(rows, list) or len(rows) != COUNT:
        raise ValueError(f"{unit} requires exactly {COUNT} settlement periods")
    energy = {}
    for row in rows:
        if (row["dataset"], row["psrType"], row["bmUnit"], row["nationalGridBmUnitId"],
                row["settlementRunType"]) != ("B1610", "Generation", unit, unit[2:], "RF"):
            raise ValueError(f"Unexpected dataset, unit identity or settlement run for {unit}")
        period, quantity = row["settlementPeriod"], row["quantity"]
        if not isinstance(period, Decimal) or period != int(period) or not 1 <= period <= 48:
            raise ValueError(f"{unit} invalid winter settlement period {period}")
        if not isinstance(quantity, Decimal) or not quantity.is_finite():
            raise ValueError(f"{unit} invalid settlement energy")
        # Britain was on GMT for this fixed historical window. Settlement period
        # 1 spans 00:00 to 00:30 on the supplied settlement date.
        day = datetime.strptime(row["settlementDate"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        start = day + (int(period) - 1) * INTERVAL
        end_label = datetime.fromisoformat(row["halfHourEndTime"].replace("Z", "+00:00"))
        if end_label.tzinfo is None:
            end_label = end_label.replace(tzinfo=timezone.utc)
        if end_label != start + INTERVAL or not START <= start < STOP or start in energy:
            raise ValueError(f"{unit} invalid or duplicate slot {row['halfHourEndTime']}")
        energy[start] = quantity
    return energy


def load_archives():
    meters = {}
    for unit, digest in DIGESTS.items():
        raw = (ROOT / "raw" / f"{unit}.json").read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError(f"Archived source digest mismatch for {unit}")
        meters[unit] = parse_meter(raw, unit)
    return meters


def observation(meters):
    points = []
    for index in range(COUNT):
        start = START + index * INTERVAL
        first = meters["T_SIZB-1"][start]
        second = meters["T_SIZB-2"][start]
        points.append({
            "startUtc": utc_label(start), "endUtc": utc_label(start + INTERVAL),
            "unit1MWh": float(first), "unit2MWh": float(second),
            "unit1MW": float(2 * first), "unit2MW": float(2 * second),
            "combinedMW": float(2 * (first + second)),
        })
    return {
        "schema": "openpwr-grid-return-observation-v1",
        "title": "Sizewell B return to generation, December 2024",
        "startUtc": utc_label(START), "endUtc": utc_label(STOP), "intervalMinutes": 30,
        "attribution": "Contains BMRS data © Elexon Limited copyright and database right 2024.",
        "licenceUrl": LICENCE,
        "sources": {
            "provider": "Elexon Insights Solution",
            "dataset": "B1610",
            "retrievedUtcDate": "2026-11-23",
            "meterGuideUrl": ("https://www.elexon.co.uk/bsc/article/"
                              "bsc-insight-how-to-get-more-detailed-metered-volume-data-from-our-insights-solution/"),
            "unitReferenceUrl": "https://data.elexon.co.uk/bmrs/api/v1/reference/bmunits/all",
            "eventUrl": "https://www.edfenergy.com/media-centre/sizewell-b-back-delivering-reliable-zero-carbon-power",
            "meterResponses": [{"bmUnit": unit, "url": source_url(unit),
                                "path": f"raw/{unit}.json", "sha256": digest}
                               for unit, digest in DIGESTS.items()],
        },
        "measurement": "Signed generator-meter settlement energy per half hour, converted to interval mean MW.",
        "boundary": "Sum of the two Sizewell B turbine generator meters. Other settlement meters are excluded.",
        "points": points,
    }


def verify_upstream(meters):
    for unit, frozen in meters.items():
        with urlopen(source_url(unit), timeout=60) as response:
            raw = response.read()
        if parse_meter(raw, unit) != frozen:
            raise ValueError(f"Current provider readings differ from the frozen evidence for {unit}")
        state = "match" if hashlib.sha256(raw).hexdigest() == DIGESTS[unit] else "differ"
        print(f"{unit}: all readings match, response bytes {state}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="Check normalized observations offline")
    action.add_argument("--write", action="store_true", help="Rebuild the normalized JSON from the archived responses")
    action.add_argument("--verify-upstream", action="store_true", help="Compare archived observations with Elexon")
    args = parser.parse_args()
    meters = load_archives()
    if args.verify_upstream:
        verify_upstream(meters)
        return
    expected = (json.dumps(observation(meters), indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    if args.write:
        OUTPUT.write_bytes(expected)
    elif OUTPUT.read_bytes() != expected:
        raise ValueError("Normalized JSON differs from the offline source reconstruction")
    print(f"{COUNT} consecutive half hours from each of two Sizewell B meters, {utc_label(START)} to {utc_label(STOP)}")


if __name__ == "__main__":
    main()
