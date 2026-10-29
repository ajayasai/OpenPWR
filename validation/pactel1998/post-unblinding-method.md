# Pressure comparisons after v0.7 disclosure

ATWS-11's reserved compression response was published in v0.7.0. Its data can now inform development, so later model evaluations are explicitly **post-unblinding development comparisons**. Reusing the same case, changing a model hash, or freezing a new revision cannot renew the original holdout status.

## Preserved evidence

The exact published `pressurizer-validation.json` is archived as [pressurizer-v0.7.json](../baselines/pressurizer-v0.7.json). Its SHA-256 is `0fe9b928e9e60d6a180c8bc57bbd1caf0e3289afcc8365605a5b9945ce5d378e`; it records clean source revision `fb00e13f03c3f200e8acd8e8ff4a5b5b1316c523`. It includes every original measured/simulated point, conservation check, mesh result, compiled-model identity and the original scored candidate freeze. The [v0.7 release](https://github.com/ajayasai/OpenPWR/releases/tag/v0.7.0) also retains its native binaries and report.

The original `holdout_compare.py`, `holdout-protocol.json`, `holdout-freeze.json`, extractor, CSV and provenance are unchanged. `holdout_compare.py` still rejects changed candidate sources. To reproduce its original computation, use the v0.7.0 source tag and corresponding release binary; current code does not bypass that historical guard.

The exact v0.7 Krško report is separately archived as [krsko-v0.7.json](../baselines/krsko-v0.7.json), SHA-256 `37fd6ef7d5d19b667717fe1894e01eee65720c621d2bea20475ded148dcc3f82`. This supplements the already preserved v0.5 baseline.

## Current computation

```sh
npm run engineering:pressurizer -- --build
```

`post_unblinding_compare.py` runs ATWS-11 with the unchanged 0–295 s simulation interval, 5–295 s measured grid, initial values, imposed inputs, 0.1/0.05 s communication steps, compiled solver tolerance and numerical balance thresholds. No time alignment, pressure offset removal or inference of the unidentified later draining flow is introduced.

The existing JSON key `holdoutComparison` is retained for client compatibility, but current reports require `comparisonRole: "post-unblinding-development"` and `heldOutFromCurrentDevelopment: false`. The old freeze appears only as `historicalCandidateFreeze`; it is not described as a freeze of the current candidate. The original metadata is identified as `historicalReferenceMetadata` because its development-separation statements refer to v0.7.

Both current PACTEL cases retain their original measured values and times, add the exact prior simulated pressure as `baseline` at each point, and report the v0.7 RMSE, signed RMSE change and fractional reduction. A negative reduction means accuracy worsened. The comparator recomputes these from raw points. It does not infer physical validation from a reduction in development error.

Every new executable manifest binds the current model, wrapper, runner, comparator, original data/protocol/freeze and immutable v0.7 baseline report. The publication gate independently checks those files, executable hashes, result identities, baseline point values and discrepancy calculations. Numerically valid unfavorable comparisons remain publishable; missing provenance, altered historical evidence, a renewed holdout claim or forged numerical acceptance blocks publication.

No additional independent validation event is created by this release. A future claim of independent predictive improvement needs newly reserved response data, sufficient known boundaries and a prospective protocol.
