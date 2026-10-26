"""Extract the ATWS-11 measured pressure window selected in holdout-protocol.json.

Only the red measurement path is read; black TRACE predictions are excluded.
The source report/artwork remain under ignored artifacts and are not redistributed.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from statistics import median
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PDF_SHA256 = 'ee74a7b5315bed710d4a89dfe43347613b8fb85349640de253aa4c4d8c981369'
URL = 'https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS124697/pdf/GOVPUB-Y3_N88-PURL-LPS124697.pdf'
PAGE = 18
FRAME = (97, 930, 55, 615)
TIMES = tuple(range(5, 296))


def pressure_points(image):
    if image.size != (970, 690):
        raise ValueError('Figure dimensions changed; review the extraction geometry.')
    image = image.convert('RGB')
    left, right, top, bottom = FRAME
    for x in (left, right):
        if sum(max(image.getpixel((x, y))) < 50 for y in range(top, bottom + 1)) < 550:
            raise ValueError('Reviewed vertical plot border was not found.')
    for y in (top, bottom):
        if sum(max(image.getpixel((x, y))) < 50 for x in range(left, right + 1)) < 825:
            raise ValueError('Reviewed horizontal plot border was not found.')
    columns = {}
    # Read only the prespecified pre-drain window; later responses are unused.
    last_column = math.ceil(left + TIMES[-1] / 600 * (right - left))
    for x in range(left + 1, last_column + 1):
        ys = []
        for y in range(120, bottom):
            red, green, blue = image.getpixel((x, y))
            if red >= 240 and red - green >= 50 and red - blue >= 50:
                ys.append(y)
        if ys:
            if max(ys) - min(ys) + 1 != len(ys):
                raise ValueError('Multiple red branches in one column; review extraction.')
            columns[x] = median(ys)
    if len(columns) < 380:
        raise ValueError('The red measured path is incomplete or its color changed.')
    rows, maximum_gap = [], 0
    for time in TIMES:
        x = left + time / 600 * (right - left)
        before = max((column for column in columns if column <= x), default=None)
        after = min((column for column in columns if column >= x), default=None)
        if before is None or after is None:
            raise ValueError('The measured trace does not cover the selected window; no extrapolation.')
        gap = after - before
        if gap > 5:
            raise ValueError('The measured path has an excessive pixel gap; no gap filling.')
        maximum_gap = max(maximum_gap, gap)
        y = columns[before] if before == after else columns[before] + (columns[after] - columns[before]) * (x - before) / gap
        rows.append({'time': time, 'pressureMPa': round(9 - (y - top) * 4 / (bottom - top), 6)})
    return rows, {'framePixels': list(FRAME), 'measuredPixelColumns': len(columns),
        'maximumInterpolationGapPixels': maximum_gap, 'sampleCount': len(rows),
        'figureReadingAllowanceMPa': 2 * 4 / (bottom - top),
        'figureTimeReadingAllowanceS': 2 * 600 / (right - left)}


def extract(pdf):
    from pypdf import PdfReader
    pdf = Path(pdf)
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != PDF_SHA256:
        raise ValueError('PDF bytes differ from the reviewed primary report.')
    document = PdfReader(pdf)
    if len(document.pages) != 43:
        raise ValueError('Report page count changed.')
    page = document.pages[PAGE - 1]
    caption = page.extract_text()
    if 'Figure 6' not in caption or 'ATWS-11' not in caption or len(page.images) != 1:
        raise ValueError('Selected page is not the reviewed ATWS-11 measurement.')
    return pressure_points(page.images[0].image)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, default=ROOT / 'artifacts/measured-transients/nureg-ia-0231.pdf')
    parser.add_argument('--output', type=Path, default=HERE / 'holdout-measured.csv')
    args = parser.parse_args()
    if not args.pdf.exists():
        args.pdf.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(URL, timeout=60) as response:
            args.pdf.write_bytes(response.read())
    rows, diagnostics = extract(args.pdf)
    with args.output.open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=['time', 'pressureMPa'], lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps(diagnostics, indent=2))


if __name__ == '__main__':
    main()
