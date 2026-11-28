# Westinghouse plant heatup observations

EPRI report 3002003085 (MRP-393, October 2014) uses U.S. plant fatigue-monitoring data. Section 2.1.1 and Figure 2-1 describe an actual Westinghouse-designed PWR heatup from cold shutdown to no load. Table 2-2 reports zero minimum and maximum reactor power during this event. The later loading examples have their own clocks. The report does not identify the site or date for Figure 2-1. The earlier OpenPWR transfer test used a different event from a Combustion Engineering design in Figure 3-1 of the same report. [EPRI report, PDF page 19 (printed page 2-3)](https://restservice.epri.com/publicdownload/000000003002003085/0/Product#page=19)

## Clock and channels

The sampling grid comprises every whole hour on the visible time axis, including 0 and 60 hours. The figure's left axis defines time zero, with no event alignment, rescaling, or extrapolation. The black pressure path uses the right axis (0–2500 psig). The red hot-leg and blue cold-leg temperature paths use the left axis (0–700 °F). The figure supplies no loop identifier, acquisition cadence, or instrument accuracy.

The extractor samples the centre of each vector path by linear interpolation. When a vertical stroke admits several ordinates at the same timestamp, it uses the midpoint of the extremes. It samples only the visible plot. Raw PDF drawing commands extend outside the displayed axes. Pressure is rounded to whole psig and converted to absolute MPa using a standard atmospheric offset of 0.101325 MPa. Each leg temperature is rounded to 0.1 °F before taking the arithmetic mean and converting to °C. The mean is a derived comparison channel. The digits in the JSON support reproduction. The publication does not supply this precision as a measurement uncertainty.

## Reproduction

Download EPRI report 3002003085 from the source link above. The source PDF used here has SHA-256 `bc7f19ec848215301f958a39c0854d862c8dccecf1f96f6b60d66085ff734c10`. The extractor verifies decoded page content SHA-256 `35ab24494549dd7482533d5b55bdab12286d47f505514d8e3085f4bda3791684`, axes, path colors, and path lengths. This allows independently downloaded copies with different wrapper metadata. From the repository root, with Python and PyMuPDF installed, run

```sh
python validation/open_loop_startup/measured/extract.py MRP-393.pdf --check validation/open_loop_startup/measured/observations.json
```

The source report and graphics are copyright © 2014 Electric Power Research Institute. This repository provides the extraction code and numerical readings derived from the published chart.
