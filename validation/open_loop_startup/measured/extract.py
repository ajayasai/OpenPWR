# SPDX-License-Identifier: Apache-2.0
"""Sample the visible vector traces in EPRI MRP-393, Westinghouse Figure 2-1."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from validation.startup_transfer.ce_heatup.extract import ATMOSPHERIC_MPA, PSI_TO_MPA, ordinate

SOURCE = "https://restservice.epri.com/publicdownload/000000003002003085/0/Product"
PAGE_SHA256 = "35ab24494549dd7482533d5b55bdab12286d47f505514d8e3085f4bda3791684"
PAGE = 19
LAST_HOUR = 60
# Axis centre lines in unrotated PDF points, measured from the upper-left corner.
LEFT, RIGHT = 244.41, 470.25
TOP, BOTTOM = 251.31, 416.97
TRACES = (
    ("hot", 140, 400, (1.0, 0.0, 0.0)),
    ("cold", 139, 345, (0.0, 0.439, 0.753)),
    ("pressure", 141, 668, (0.0, 0.0, 0.0)),
)


def extract(pdf):
    import pymupdf

    with pymupdf.open(pdf) as report:
        page = report[PAGE - 1]
        if hashlib.sha256(page.read_contents()).hexdigest() != PAGE_SHA256:
            raise ValueError("Unexpected Figure 2-1 page stream")
        drawings = page.get_drawings()
        for index, expected in ((137, (LEFT, BOTTOM, LEFT, TOP)), (138, (LEFT, BOTTOM, RIGHT, BOTTOM))):
            op, a, b = drawings[index]["items"][0]
            if op != "l" or math.dist((*a, *b), expected) > 0.001:
                raise ValueError("Unexpected Figure 2-1 axes")

        traces = {}
        for name, index, count, color in TRACES:
            path = drawings[index]
            if path["type"] != "s" or len(path["items"]) != count or math.dist(path["color"], color) > 0.001:
                raise ValueError(f"Unexpected {name} trace")
            traces[name] = path["items"]

        rows = []
        for hour in range(LAST_HOUR + 1):
            x = LEFT + (RIGHT - LEFT) * hour / LAST_HOUR
            fraction = {name: (BOTTOM - ordinate(lines, x)) / (BOTTOM - TOP) for name, lines in traces.items()}
            hot = round(fraction["hot"] * 700, 1)
            cold = round(fraction["cold"] * 700, 1)
            pressure = round(fraction["pressure"] * 2500)
            rows.append({
                "elapsedS": hour * 3600,
                "hotF": hot,
                "coldF": cold,
                "pressurePsig": pressure,
                "averageCoolantTemperatureC": round(((hot + cold) / 2 - 32) * 5 / 9, 6),
                "primaryPressureMPa": round(ATMOSPHERIC_MPA + PSI_TO_MPA * pressure, 6),
            })
    return {
        "caseId": "epri-mrp393-westinghouse-heatup",
        "source": SOURCE, "page": PAGE, "figure": "2-1",
        "pageContentSha256": PAGE_SHA256,
        "records": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="public EPRI report 3002003085")
    parser.add_argument("--write", type=Path, help="destination for the numerical fixture")
    parser.add_argument("--check", type=Path, help="verify a saved fixture byte for byte")
    args = parser.parse_args()
    data = extract(args.pdf)
    raw = (json.dumps(data, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    if args.check and raw != args.check.read_bytes():
        raise ValueError("Measurements differ from the saved fixture")
    if args.write:
        args.write.write_bytes(raw)
    print(f"{len(data['records'])} observations per channel, SHA-256 {hashlib.sha256(raw).hexdigest()}")


if __name__ == "__main__":
    main()
