"""Reproduce the dated Ohi Unit 3 observations from publisher PDFs or archived copies."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import unicodedata
from urllib.request import urlopen

from pypdf import PdfReader


HERE = Path(__file__).resolve().parent
ARTIFACTS = HERE.parents[2] / "artifacts"
ORIGIN = datetime.fromisoformat("2012-06-26T13:00:00+09:00")
JST = timezone(timedelta(hours=9))
NUMBER = r"(?<![-.\d])([0-9]+(?:\.[0-9]+)?)"
CHANNELS = {
    "coolantTemperatureC": r"°C",
    "pressureMPaGauge": r"MPa",
    "generatorMW": r"MW",
    "thermalMW": r"MWt",
}


def read_pdf(source, directory, fetch):
    path = directory / (source["date"] + ".pdf")
    if path.exists():
        data = path.read_bytes()
        if sha256(data).hexdigest() != source["sha256"]:
            raise ValueError(f"{path}: wrong SHA-256")
        return data
    if not fetch:
        raise FileNotFoundError(f"{path}: supply the PDF or pass --fetch")
    errors = []
    for url in (source["sourceUrl"], source["archiveUrl"]):
        try:
            with urlopen(url, timeout=45) as response:
                data = response.read()
            if sha256(data).hexdigest() != source["sha256"]:
                errors.append(f"{url}: wrong SHA-256")
                continue
            directory.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return data
        except OSError as exc:
            errors.append(f"{url}: {exc}")
    raise OSError("\n".join(errors))


def read_snapshot(source, data):
    day = date.fromisoformat(source["date"])
    timestamp = datetime.combine(day, time(13, tzinfo=JST))
    header = f"大飯発電所3号機運転パラメータ(平成24年{day.month}月{day.day}日13:00時点)"
    matches = []
    for page_number, page in enumerate(PdfReader(BytesIO(data)).pages, start=1):
        text = unicodedata.normalize("NFKC", page.extract_text())
        if header in "".join(text.split()):
            matches.append((page_number, text))
    if len(matches) != 1:
        raise ValueError(f"{day}: expected one dated Unit 3 instrument panel, found {len(matches)}")
    page_number, text = matches[0]

    record = {
        "timestamp": timestamp.isoformat(),
        "elapsedHours": (timestamp - ORIGIN) // timedelta(hours=1),
    }
    for channel, unit in CHANNELS.items():
        values = re.findall(NUMBER + rf"\s*{unit}(?![a-zA-Z])", text)
        if len(values) != 1:
            raise ValueError(f"{day}: expected one numerical {unit} indication, found {values}")
        record[channel] = float(values[0])
    mode = re.search(r"原子炉運転モード\s*([1-6])", text)
    if not mode:
        raise ValueError(f"{day}: missing station operating mode")
    record.update(operatingMode=int(mode[1]), sourceUrl=source["sourceUrl"], page=page_number)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf-dir", type=Path, default=ARTIFACTS / "ohi-pdfs")
    parser.add_argument("--fetch", action="store_true", help="fetch missing PDFs and verify each digest")
    parser.add_argument("--output", type=Path, default=ARTIFACTS / "ohi-observations.json")
    args = parser.parse_args()
    sources = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))["sources"]
    expected = [(ORIGIN.date() + timedelta(days=i)).isoformat() for i in range(14)]
    if [source["date"] for source in sources] != expected:
        raise ValueError("The source manifest must cover every registered day exactly once, in order")
    records = [read_snapshot(s, read_pdf(s, args.pdf_dir, args.fetch)) for s in sources]
    fixture = {"schema": "openpwr-ohi3-2012-observations-v1", "records": records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8", newline="\n")
    print(f"Extracted {len(records)} dated Unit 3 snapshots to {args.output}")


if __name__ == "__main__":
    main()
