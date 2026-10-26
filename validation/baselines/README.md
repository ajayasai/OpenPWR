# Frozen comparison baseline

`krsko-v0.5.json` is the unchanged measured-comparison report published with
[OpenPWR v0.5.0](https://github.com/ajayasai/OpenPWR/releases/tag/v0.5.0), from
commit `17ae3019e9241306db66a6c2b5ac3660280de5b5`.

Its SHA-256 is `90024ac524d87165761fae591493229b06552298a7f5df3121e6ede1dd8a9bab`.
The historical report retains the old event-date description and the original
generic geometry, omitted boundaries and equilibrium pressurizer assumptions.
Later reports correct source issues explicitly; this baseline is not rewritten.

Comparing a revised model with this report documents a development change. It
does not turn the Krško event into an independent validation event or establish
that every output improved. A separate experiment is required to test transfer
of the pressure model.
