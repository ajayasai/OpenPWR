"""Reproduce the measured curves from the fixed NRC report, not its code results.

Requires pdfplumber==0.11.9 only for extraction; normal comparisons use measured.csv.
The publisher PDF is downloaded to ignored artifacts and is never redistributed.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations
import argparse
import csv
import hashlib
import json
from pathlib import Path
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
URL = 'https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf'
PDF_SHA256 = '0d9355cb4a04d3cfac6db671e54d1000df745606ed9af7f324ac650ece6c9665'
# PDF page (one based), figure, instrument label, printed axis minimum/maximum,
# multiplier, offset. Pressure axes are mislabeled MPa but have bar-valued ticks;
# the 0.1 correction is independently anchored by measured Table 2, page 13.
SERIES = {
    'nuclearPowerPercent': (42, 22, 'AN00846_NM41', 0, 100, 1, 0),
    'coldLeg1TemperatureC': (43, 23, 'AT00942_TE410B', 558, 570, 1, -273.15),
    'coldLeg2TemperatureC': (44, 24, 'AT01360_TE420B', 558, 570, 1, -273.15),
    'hotLeg1TemperatureC': (45, 25, 'AT05973_TE410A', 560, 600, 1, -273.15),
    'hotLeg2TemperatureC': (46, 26, 'AT05974_TE420A', 560, 600, 1, -273.15),
    'primaryPressureMPa': (49, 29, 'AP00874_PT455', 144, 162, .1, 0),
    'pressurizerLevelPercent': (50, 30, 'AL00818_LT465', 0, 70, 1, 0),
    # Preserve the instrument's volumetric unit. Reference temperature/pressure
    # and incoming charging-water enthalpy are not supplied; do not invent a
    # mass-flow conversion or treat indicated PRZ level as a volume fraction.
    'chargingFlowLS': (51, 31, 'AF00793_FT205', 0, 8, 1, 0),
    'letdownFlowLS': (52, 32, 'AF00795_FT132', 0, 8, 1, 0),
    'steam1PressureMPa': (53, 33, 'AP00871_PT514', 64, 80, .1, 0),
    'steam2PressureMPa': (54, 34, 'AP00872_PT524', 64, 80, .1, 0),
    'steam1FlowKgS': (57, 37, 'AF00799_FT512A', 0, 700, 1, 0),
    'steam2FlowKgS': (58, 38, 'AF00804_FT522A', 0, 700, 1, 0),
    'feedwater1FlowKgS': (59, 39, 'AF00798_FT510A', 0, 600, 1, 0),
    'feedwater2FlowKgS': (60, 40, 'AF00803_FT520A', 0, 600, 1, 0),
}

def extract(pdf: Path):
    import pdfplumber
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != PDF_SHA256:
        raise ValueError('PDF bytes differ from the reviewed NRC report. Re-review before extracting.')
    results, diagnostics = {}, {}
    with pdfplumber.open(pdf) as document:
        for name, (page_number, figure, instrument, low, high, scale, offset) in SERIES.items():
            page = document.pages[page_number - 1]
            if instrument not in page.extract_text() or f'Figure {figure}' not in page.extract_text():
                raise ValueError(f'Page/figure identity mismatch for {name}')
            axes = [c for c in page.curves if c['stroking_color'] == 0.0
                    and c['top'] < 100 and c['height'] > 100 and c['width'] < 3]
            if len(axes) != 1:
                raise ValueError(f'Expected one upper-panel axis for {name}')
            axis = axes[0]
            top, bottom, left = axis['top'], axis['bottom'], axis['x0']
            frame = [line for line in page.lines if line['width'] > 300
                     and abs(line['top'] - bottom) < .02 and abs(line['x0'] - left) < .02]
            if len(frame) != 1:
                raise ValueError(f'Expected one lower frame line for {name}')
            right = frame[0]['x1']
            # Figs 31–32 extend the vertical axis above the highest labelled
            # tick (8 L/s). Calibrate to its horizontal gridline, not the
            # unlabelled axis endpoint. Other selected figures have a labelled
            # top border, which this identical gridline rule preserves.
            grids = [line for line in page.lines if line['width'] > 300
                     and abs(line['x0'] - left) < .02
                     and abs(line['x1'] - right) < .02
                     and top-.02 <= line['top'] <= bottom+.02]
            top = min(line['top'] for line in grids)
            measured = [c for c in page.curves if c['stroking_color'] == (1.0, 0.0, 1.0)
                        and c['top'] < 240 and len(c['pts']) == 50]
            if len(measured) != 1:
                raise ValueError(f'Measured magenta path is ambiguous for {name}')
            series, maximum_time_rounding = {}, 0.0
            for x, y in measured[0]['pts']:
                raw_time = -50 + 100 * (x - left) / (right - left)
                # Report section 4 specifies a 2 s acquisition grid. The 50 upper
                # panel vertices correspond to -49,-47,...,49 s after the stated
                # t=0 convention. PDF coordinates are rounded to 0.06 pt.
                time = round((raw_time + 49) / 2) * 2 - 49
                maximum_time_rounding = max(maximum_time_rounding, abs(time - raw_time))
                if abs(time - raw_time) > .06 or time in series:
                    raise ValueError(f'Unexpected sample grid for {name}')
                series[time] = round((low + (bottom - y) / (bottom - top) * (high - low)) * scale + offset, 6)
            if sorted(series) != list(range(-49, 50, 2)):
                raise ValueError(f'Incomplete measurement series {name}')
            results[name] = series
            diagnostics[name] = {'pdfPage': page_number, 'figure': f'{figure}(a)',
                'instrument': instrument, 'vertices': 50,
                'axisBoxPoints': [left, top, right, bottom],
                'calibration': 'Lowest and highest labelled horizontal gridlines; the unlabelled axis extension is excluded.',
                'maximumTimeRoundingS': maximum_time_rounding,
                'halfPointReadingAllowance': .5 * (high-low) / (bottom-top) * abs(scale)}
    rows = []
    for time in range(-49, 50, 2):
        row = {'time': time, **{name: values[time] for name, values in results.items()}}
        row.update(reactorPowerMW=round(row['nuclearPowerPercent'] * 1994 / 100, 6),
                   coldLegTemperatureC=round((row['coldLeg1TemperatureC']+row['coldLeg2TemperatureC'])/2, 6),
                   hotLegTemperatureC=round((row['hotLeg1TemperatureC']+row['hotLeg2TemperatureC'])/2, 6),
                   steamPressureMPa=round((row['steam1PressureMPa']+row['steam2PressureMPa'])/2, 6),
                   steamFlowKgS=round(row['steam1FlowKgS']+row['steam2FlowKgS'], 6),
                   feedwaterFlowKgS=round(row['feedwater1FlowKgS']+row['feedwater2FlowKgS'], 6))
        rows.append(row)
    return rows, diagnostics

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, default=ROOT/'artifacts/measured-transients/nureg-ia-0221.pdf')
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--output', type=Path, default=HERE/'measured.csv')
    parser.add_argument('--diagnostics', type=Path, default=ROOT/'artifacts/measured-transients/extraction.json')
    args = parser.parse_args()
    if args.download:
        args.pdf.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(URL, args.pdf)
    rows, diagnostics = extract(args.pdf)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', newline='', encoding='utf-8') as stream:
        # Match the repository's LF policy on every host so committed/reference
        # hashes do not change when the same extraction runs on Windows or Linux.
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
    args.diagnostics.parent.mkdir(parents=True, exist_ok=True)
    args.diagnostics.write_text(json.dumps({'sourceSha256': PDF_SHA256, 'series': diagnostics}, indent=2)+'\n')
    print(f'Extracted {len(rows)} measured sample times and {len(SERIES)} instrument channels; no calculated curve selected.')

if __name__ == '__main__':
    main()
