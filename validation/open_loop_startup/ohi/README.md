# Ohi Unit 3 restart, June–July 2012

Kansai Electric published daily instrument readings during the restart of its 1,180 MWe, 3,423 MWt Ohi Unit 3 pressurized-water reactor in Japan. The readings cover one unit and one event, starting in cold shutdown and continuing to rated thermal operation. Each daily bulletin includes separate Unit 3 and Unit 4 instrument panels. The fixture uses the dated Unit 3 panel in Annex 2. [Operator archive](https://www.kepco.co.jp/corporate/pr/2012/index.html) · [Unit ratings](https://www.kepco.co.jp/corporate/pr/2012/0616-1j.html)

The time origin is June 26 at 13:00 Japan Standard Time (UTC+09:00), the last daily snapshot before the first primary-system inspection listed on the operator's startup timeline. At this origin the panel identifies operating mode 5 (cold shutdown). The 14 consecutive observations are 24 hours apart. The final panel is July 9 at 13:00, the first daily snapshot after rated thermal operation began. The 14:00 status and 15:00 bulletin timestamps that appear on some covers refer to later updates. The panel itself timestamps the readings. [Opening bulletin](https://www.kepco.co.jp/corporate/pr/2012/__icsFiles/afieldfile/2012/06/26/0626_1j_01_1.pdf) · [Closing bulletin and station timeline](https://www.kepco.co.jp/corporate/pr/2012/__icsFiles/afieldfile/2012/07/09/0709_3j_01.pdf)

The operator recorded grid connection on July 5 at 07:00 (+210 h) and the start of rated thermal operation on July 9 at 01:00 (+300 h). These event times come from station announcements. The concurrently observed pressure, temperature and power come from the daily panels. [Grid connection](https://www.kepco.co.jp/corporate/pr/2012/0705-2j.html) · [Rated thermal operation](https://www.kepco.co.jp/corporate/pr/2012/0709_1j.html)

## Measured channels

| JSON field | Station indication and comparison convention |
| --- | --- |
| `coolantTemperatureC` | Reported primary coolant temperature (°C). The bulletin gives no sensor location or averaging weights. The comparison uses the mean of the modeled hot and cold legs as a proxy. |
| `pressureMPaGauge` | Reported primary coolant pressure (MPa). The panel labels the units MPa. Unit 3/4 engineering documentation uses gauge pressure for this channel. The scorer adds one standard atmosphere (0.101325 MPa) for the absolute-pressure comparison and reports sensitivity to using the printed number directly. |
| `generatorMW` | Electrical output at the generator terminals in MW, normalized to 1,180 MWe only for the separate station load display. |
| `thermalMW` | Measured steam-generator thermal output in MWt. The operator indicates rated thermal operation separately from the daily instrument values. |
| `operatingMode` | Operating mode shown on the particular Unit 3 panel. |

Kansai defines Unit 3 average coolant temperature elsewhere as the mean of the coolant temperatures entering and leaving the reactor. The 2012 panels give a shorter channel label. IAEA lists the station's gross electrical rating as 1,180 MW. [Unit 3 average-temperature definition, note 2](https://www.kepco.co.jp/corporate/pr/2009/0114-1j.html) · [Unit 3/4 engineering documentation, Table 1](https://www.nra.go.jp/data/000466017.pdf) · [IAEA reactor data, entry JP-51](https://www-pub.iaea.org/MTCD/Publications/PDF/RDS-2-43_web.pdf)

The extractor reads the printed numerical indications. All four numerical channels are present on all 14 panels. The PDF headings, station operating mode, dates and times identify the event. Readings between snapshots are unobserved. The measured record includes primary-system inspection, preparation and operator holds. [Scoring protocol](../ohi-protocol.json)

## Reproduce the fixture

Each entry in [sources.json](sources.json) points to the operator's original bulletin and a dated Internet Archive capture of that same URL. The SHA-256 digest identifies the PDF bytes used for extraction. The fixture contains factual numerical readings, their timestamps, the one-based page numbers and source links. The original PDFs are linked at the publisher and archive.

With Python 3.10+ and the optional BSD-licensed `pypdf==6.10.0`, run from the repository root.

```sh
python -m pip install pypdf==6.10.0
python validation/open_loop_startup/ohi/extract.py --fetch
```

The command caches verified PDFs in `artifacts/ohi-pdfs/` and writes `artifacts/ohi-observations.json`. For offline extraction, put the verified PDFs in a directory under their ISO dates (for example, `2012-06-26.pdf`) and supply `--pdf-dir DIRECTORY` in place of `--fetch`. The extractor matches the unit, date and time before reading each channel. The expected fixture SHA-256 is `f4cecf0290f8a9bc56e8fad98317f9f49db8cd9da4b38e9c438a74ed7efe8e76`.
