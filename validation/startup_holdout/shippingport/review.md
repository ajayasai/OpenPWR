# Independent reading of the Shippingport test record

Two separate AI-assisted readings used enlargements of the same archival scan. Each independently transcribed the reactor-pressure row on printed pages 11–13 and the average-coolant and pressurizer temperature rows on page 13. The readers then reconciled the timestamps, raw values and exclusions, and checked entries against the Table I event log. The source PDF has SHA-256 `8baeace24944da512f3ba5450e2d0db2ee4b9cf06640872ec6dc80c6d101ac5b`. [Duquesne Light Company, AECU-4028, archival scan](https://digital.library.unt.edu/ark:/67531/metadc1240466/m2/1/high_res_d/metadc1240466.pdf)

## Event clock

| Station time in 1958 | Evidence | Implication for comparison |
| --- | --- | --- |
| June 24, 13:00 | First event in Table I, printed p. 5 | Elapsed-time origin. The first explicit mean coolant temperature is 190 °F at 13:18. |
| June 24, 14:02 and 14:05 | Start of indicator logging in Table I, p. 5, and first reactor-pressure cell in Table II, p. 11 | The 400 psig measurement belongs at 14:05. |
| June 24, 20:55 to June 25, 11:17 | Table I, p. 6 | The log records test suspension and resumption 14 h 22 min apart. It includes an independent 09:30 observation during the suspension. |
| June 24, 21:35 to June 25, 11:15 | Figures 1 and 2, pp. 3–4, and Table II, p. 12 | The gap between these two Table II observations lasts 13 h 40 min. The continuous station clock includes it. |
| June 25, 11:32 | Table I, p. 6 | The station recorded criticality 22 h 32 min after the first event. |
| June 25, 17:59 | Table I, p. 10 | The turbine reached synchronization at 1,800 rpm after 28 h 59 min. The main generator breaker remained open. The report provides no subsequent rise to full electrical output. |
| June 25, 18:00 | Final Table II column, p. 13 | The reported 2,020 psig and 522.2 °F postdate synchronization by one minute. |

## Channel and legibility checks

- Table I gives average coolant temperatures of 190, 205 and 270 °F on June 24 at 13:18, 17:19 and 19:41. On June 25 it gives 270, 271 and 340 °F at 09:30, 11:17 and 12:25. Later entries explicitly identify the cold leg of loop 1A. All nine accepted loop 1A readings were checked on printed pages 8–10.
- Table II labels reactor pressure in psig. For an absolute-pressure comparison the gauge-to-absolute conversion needs an explicit reference atmosphere. Page 2 flags the 19:20 June 24 pressure as a probable logging error that the recorder chart could not substantiate.
- Both readers withheld reactor-pressure digits that the scan could not resolve confidently. These occur at 14:20 and 18:20 on June 24, and at 12:15, 13:15, 14:00, 15:30, 17:00, 17:30 and 17:45 on June 25. The pressure peak at 14:20 is visible in Figure 2. Its precise tabulated value remains uncertain.
- The last page of Table II has numeric entries for average coolant temperature beginning at 15:30 on June 25. Both readers withheld the blurred 16:00 value. The two readers agreed on 502.8 °F at 16:45 and 521.0 °F at 17:45. Dashes in earlier columns indicate unavailable readings.
- The first two directly timed pressurizer temperatures are 250 °F at 13:18 and 370 °F at 14:31 on June 24 (Table I, p. 5). The 14:40 statement describes the objective of maintaining 370 °F. Table II first supplies a numeric pressurizer temperature at 14:00 the following day. The 16:45 and 17:45 decimal readings on June 25 were too blurred to resolve.
- Figure 1 identifies hot- and cold-leg temperatures for loop 1A. The report attributes its hot-leg and pressurizer temperatures to recorders and its cold-leg measurements to a Mueller bridge (p. 2). Table II separately labels temperatures from the purification system. Table III, p. 14, reports pump differential pressure in psi from the daily log.
- The narrative on p. 1 gives 525 °F and 1,985 psig for completion conditions without an instrument timestamp. The separately timestamped Table II values at 18:00 remain the observations for that time. The report says the data needed to determine the rate of power change were unavailable (p. 2).

The second reading matched the released observation file on all 54 recorded pressures (including the flagged value), 16 average coolant temperatures, nine loop 1A cold-leg temperatures and 17 pressurizer temperatures. This comparison checked the station times and raw units for every entry, then recomputed each SI conversion. These counts include measurements outside the released simulation's time span.
