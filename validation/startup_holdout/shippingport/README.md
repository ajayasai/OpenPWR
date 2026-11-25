# Shippingport startup measurements

Duquesne Light Company logged this startup at Shippingport on June 24–25, 1958. The first recorded mean coolant temperature was 190 °F at 13:18 on June 24. The turbine reached synchronism at 17:59 the following day with the main generator breaker open. The final instrumentation column follows one minute later. The record covers heatup through turbine synchronism. [Event log, first page](https://digital.library.unt.edu/ark:/67531/metadc1240466/m1/6/) · [Event log, last page](https://digital.library.unt.edu/ark:/67531/metadc1240466/m1/11/)

## Measurements

Each entry in [observations.json](observations.json) contains the local station date and time, raw reading, converted value, one-based scan page and any exclusion. The station clock retains the overnight interruption. A question mark in `unreadable[].rawText` marks an unresolved digit on the microcard. The [transcription review](review.md) explains the exclusions.

| Channel | Source and selection | Numeric readings | Unresolved cells |
| --- | --- | ---: | ---: |
| Reactor pressure | Table II reactor-pressure row plus four event-log measurements explicitly labeled reactor pressure in psig | 54, including one source-flagged error | 9 |
| Average primary coolant temperature | Six dated Table I averages and ten legible entries in the Table II mean-temperature row | 16 | 1 |
| Loop 1A cold-leg temperature | Table I readings that explicitly identify the 1A cold leg at the stated time | 9 | 0 |
| Pressurizer temperature | Two dated Table I measurements and fifteen legible cells in Table II | 17 | 2 |

The pressure series has 59 periodic cells across three scan pages and four additional logged events at distinct times. The separate primary-loop pressure indicators can disagree with the reactor-pressure row. The transcription preserves the report's reactor-pressure channel throughout. The arithmetic mean of native hot- and cold-leg temperatures serves as a proxy for reported mean coolant temperature. The station's loop weighting is unknown. [Table II, first sheet](https://digital.library.unt.edu/ark:/67531/metadc1240466/m1/12/) · [Second sheet](https://digital.library.unt.edu/ark:/67531/metadc1240466/m1/13/) · [Third sheet](https://digital.library.unt.edu/ark:/67531/metadc1240466/m1/14/)

For each channel, the file stores the conversion formula and retains the instrument's original units. Reactor gauge pressure in psig converts to absolute MPa with an assumed atmospheric pressure of 0.101325 MPa. The site barometer and instrument uncertainty are unavailable. All temperatures convert from Fahrenheit to Celsius.

## Source and reuse

Gerald E. Eckenrode, Duquesne Light Company. *Station Start-up Test. Test Results DL-S-163 (T-554923). Section 1*, AECU-4028, January 31, 1959. U.S. Atomic Energy Commission, published by the U.S. Government Printing Office. The UNT Libraries Government Documents Department provides the TRAIL microcard scan through the UNT Digital Library. [Archival record](https://digital.library.unt.edu/ark:/67531/metadc1240466/) · [Original 16-page PDF](https://digital.library.unt.edu/ark:/67531/metadc1240466/m2/1/high_res_d/metadc1240466.pdf)

The reviewed PDF is 1,977,869 bytes. Its SHA-256 digest is `8baeace24944da512f3ba5450e2d0db2ee4b9cf06640872ec6dc80c6d101ac5b`. The printed page number is one less than the PDF scan page. UNT lists the digital object's copyright status as undetermined. OpenPWR publishes its own transcription of measured facts and links to the source images at UNT. [Archive rights statement](https://digital.library.unt.edu/ark:/67531/metadc1240466/citation/)
