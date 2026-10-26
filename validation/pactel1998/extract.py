"""Reproduce measured PACTEL ATWS-10 pressure from NRC Figure 5.

Only numerical facts are written. The source PDF and its figure remain in ignored
artifacts. The red Pactel curve is selected; black dashed TRACE results are excluded.
Extraction requires pypdf 6.10.0 and Pillow 12.3.0; normal comparisons use the CSV.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
from statistics import median
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
URL = 'https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS124697/pdf/GOVPUB-Y3_N88-PURL-LPS124697.pdf'
PDF_SHA256 = 'ee74a7b5315bed710d4a89dfe43347613b8fb85349640de253aa4c4d8c981369'
PAGE = 17  # One-based PDF page; printed page 14, Figure 5.
FRAME = (107, 940, 75, 635)  # Centers of the embedded image's black plot borders.
TIMES = tuple(range(5, 496))  # Resampling grid, not the unknown acquisition grid.


def pressure_points(image):
    """Extract only the reviewed red measurement path, without curve fitting."""
    if image.size != (1000, 720):
        raise ValueError('Figure dimensions changed; review extraction geometry.')
    image = image.convert('RGB')
    left, right, top, bottom = FRAME
    for x in (left, right):
        if sum(max(image.getpixel((x, y))) < 50 for y in range(top, bottom + 1)) < 550:
            raise ValueError('Reviewed vertical plot border was not found.')
    for y in (top, bottom):
        if sum(max(image.getpixel((x, y))) < 50 for x in range(left, right + 1)) < 825:
            raise ValueError('Reviewed horizontal plot border was not found.')
    columns = {}
    for x in range(left + 1, right + 1):
        # The legend is above y=130; all measured pressures lie below it.
        ys = []
        for y in range(130, bottom):
            red, green, blue = image.getpixel((x, y))
            if red >= 240 and red - green >= 50 and red - blue >= 50:
                ys.append(y)
        if ys:
            if max(ys) - min(ys) + 1 != len(ys):
                raise ValueError('Multiple red branches in one column; review extraction.')
            columns[x] = median(ys)
    if len(columns) < 750:
        raise ValueError('Measured red curve is incomplete or color identification changed.')
    rows = []
    maximum_gap = 0
    for time in TIMES:
        x = left + time / 500 * (right - left)
        before = max((column for column in columns if column <= x), default=None)
        after = min((column for column in columns if column >= x), default=None)
        if before is None or after is None:
            raise ValueError('Measured trace does not cover the requested time; no extrapolation.')
        gap = after - before
        if gap > 5:
            raise ValueError('Measured trace has an excessive pixel gap; no gap filling.')
        maximum_gap = max(maximum_gap, gap)
        y = columns[before] if before == after else (
            columns[before] + (columns[after] - columns[before]) * (x - before) / gap)
        pressure = 9 - (y - top) * 4 / (bottom - top)
        rows.append({'time': time, 'pressureMPa': round(pressure, 6)})
    return rows, {'measuredPixelColumns': len(columns), 'maximumInterpolationGapPixels': maximum_gap,
                  'framePixels': list(FRAME), 'sampleCount': len(rows),
                  'figureReadingAllowanceMPa': 2 * 4 / (bottom - top),
                  'figureTimeReadingAllowanceS': 2 * 500 / (right - left)}


def extract(pdf):
    from pypdf import PdfReader
    pdf = Path(pdf)
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != PDF_SHA256:
        raise ValueError('PDF bytes differ from the reviewed primary report.')
    document = PdfReader(pdf)
    if len(document.pages) != 43:
        raise ValueError('Report page count changed.')
    page = document.pages[PAGE - 1]
    text = page.extract_text()
    if 'Figure 5' not in text or 'ATWS-10' not in text or len(page.images) != 1:
        raise ValueError('The selected page is not the reviewed measured-pressure figure.')
    return pressure_points(page.images[0].image)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, default=ROOT / 'artifacts/measured-transients/nureg-ia-0231.pdf')
    parser.add_argument('--output', type=Path, default=HERE / 'measured.csv')
    args = parser.parse_args()
    if not args.pdf.exists():
        args.pdf.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(URL, timeout=60) as response:
            args.pdf.write_bytes(response.read())
    rows, diagnostics = extract(args.pdf)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=['time', 'pressureMPa'], lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps(diagnostics, indent=2))


if __name__ == '__main__':
    main()
