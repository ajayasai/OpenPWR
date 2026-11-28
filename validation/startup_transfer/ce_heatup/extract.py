# SPDX-License-Identifier: Apache-2.0
"""Read the hourly coordinates of EPRI MRP-393 Figure 3-1 from its public PDF."""
import argparse
import hashlib
import json
import math
from pathlib import Path

SOURCE = "https://restservice.epri.com/publicdownload/000000003002003085/0/Product"
PAGE_SHA256 = "f76907f715ee2eca4ac35775e61c99e276932efa04cf4c4f6d139e199b60d3a0"
SOURCE_PAGE = 41
# Coordinates in unrotated PDF page points, with origin at the upper left.
LEFT, RIGHT = 244.41, 473.25
TOP, BOTTOM = 84.33, 252.33
AXIS_HOURS, AXIS_F, AXIS_PSIG = 24, 600, 2500
PSI_TO_MPA = 0.006894757293168
ATMOSPHERIC_MPA = 0.101325


def ordinate(lines, x):
    """Interpolate the drawn centre line, including multi-valued vertical strokes."""
    hits = []
    for operator, a, b in lines:
        if operator != "l" or b.x < a.x:
            raise ValueError("Expected a left-to-right line segment")
        if a.x <= x <= b.x:
            if a.x == b.x:
                hits.extend([a.y, b.y])
            else:
                hits.append(a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x)))
    if not hits:
        raise ValueError(f"No measured path at x={x}")
    return (min(hits) + max(hits)) / 2


def extract(pdf_path):
    import pymupdf

    with pymupdf.open(pdf_path) as document:
        page = document[SOURCE_PAGE - 1]
        if hashlib.sha256(page.read_contents()).hexdigest() != PAGE_SHA256:
            raise ValueError("Incompatible edition or page stream for MRP-393 Figure 3-1")
        drawings = page.get_drawings()
        traces = {}
        for index, key, line_count in ((9, "cold", 386), (10, "hot", 387), (11, "pressure", 4461)):
            path = drawings[index]
            if path["type"] != "s" or len(path["items"]) != line_count:
                raise ValueError(f"Unexpected {key} path")
            traces[key] = path["items"]
        axis = drawings[8]["items"][0]
        if not (math.isclose(axis[1].x, LEFT, abs_tol=0.001)
                and math.isclose(axis[2].x, RIGHT, abs_tol=0.001)):
            raise ValueError("Unexpected horizontal axis")

        records = []
        for hour in range(1, AXIS_HOURS):
            x = LEFT + (RIGHT - LEFT) * hour / AXIS_HOURS
            y = {k: ordinate(lines, x) for k, lines in traces.items()}
            def scale(value, full_scale):
                return (BOTTOM - value) * full_scale / (BOTTOM - TOP)

            hot = round(scale(y["hot"], AXIS_F), 1)
            cold = round(scale(y["cold"], AXIS_F), 1)
            pressure = round(scale(y["pressure"], AXIS_PSIG))
            records.append({
                "elapsedS": hour * 3600, "hotF": hot, "coldF": cold, "pressurePsig": pressure,
                "averageCoolantTemperatureC": round(((hot + cold) / 2 - 32) * 5 / 9, 6),
                "primaryPressureMPa": round(ATMOSPHERIC_MPA + PSI_TO_MPA * pressure, 6),
            })
    return {
        "caseId": "epri-mrp393-ce-heatup", "source": SOURCE, "page": SOURCE_PAGE, "figure": "3-1",
        "pageContentSha256": PAGE_SHA256, "records": records,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="EPRI 3002003085 public report")
    parser.add_argument("--write", type=Path, help="write the numerical fixture to this path")
    parser.add_argument("--check", type=Path, help="compare with the expected fixture")
    args = parser.parse_args()
    records = extract(args.pdf)
    raw = (json.dumps(records, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    if args.check and raw != args.check.read_bytes():
        raise ValueError("Extraction differs from the saved measurement fixture")
    if args.write:
        args.write.write_bytes(raw)
    print(f"{len(records['records'])} hourly observations per target; SHA-256 {hashlib.sha256(raw).hexdigest()}")


if __name__ == "__main__":
    main()
