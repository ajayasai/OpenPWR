"""Compare already disclosed ATWS-11 data without renewing its holdout claim.

The v0.7 executable, protocol, freeze and published report remain historical
evidence. New model revisions are development comparisons, even if no numerical
parameter optimization is performed. Identical forcing and scoring retain the
unfavorable baseline and make changes in measured error visible.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from pathlib import Path

import holdout_compare as original
from native_fmi import run_case, sha

ROOT = original.ROOT
BASELINE = ROOT / 'validation/baselines/pressurizer-v0.7.json'
BASELINE_SHA256 = '0fe9b928e9e60d6a180c8bc57bbd1caf0e3289afcc8365605a5b9945ce5d378e'
BASELINE_REVISION = 'fb00e13f03c3f200e8acd8e8ff4a5b5b1316c523'
ROLE = 'post-unblinding-development'


def historical_evidence():
    """Require the exact released report, including its original frozen result."""
    if sha(BASELINE) != BASELINE_SHA256:
        raise ValueError('The immutable v0.7 pressure report changed.')
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
    held = baseline['holdoutComparison']
    freeze = json.loads(original.FREEZE.read_text(encoding='utf-8'))
    if baseline['version'] != '0.7.0' or baseline['gitRevision'] != BASELINE_REVISION or baseline['gitDirty'] is not False:
        raise ValueError('The historical pressure report has the wrong release identity.')
    if held['candidateFreeze'] != freeze or held['holdoutFreezeSha256'] != sha(original.FREEZE):
        raise ValueError('The original scored candidate freeze changed.')
    # These are historical facts, not files to regenerate for a new candidate.
    preserved = {'holdoutDataSha256': original.DATA, 'holdoutMetadataSha256': original.METADATA,
        'holdoutProtocolSha256': original.PROTOCOL, 'holdoutExtractorSha256': original.EXTRACTOR,
        'holdoutComparatorSha256': Path(original.__file__)}
    for key, path in preserved.items():
        if freeze['candidate'].get(key) != sha(path):
            raise ValueError(f'Historical holdout artifact changed: {key}')
    return baseline


def attach_baseline(channel, old_channel):
    """Compare errors on the same measured grid without alignment or offsets."""
    points, old = channel['points'], old_channel['points']
    if len(points) != len(old) or any(a['time'] != b['time'] or a['measured'] != b['measured'] for a, b in zip(points, old)):
        raise ValueError('The v0.7 comparison must retain identical measured values and times.')
    prior_rmse = math.sqrt(sum((point['simulated'] - point['measured']) ** 2 for point in old) / len(old))
    current_rmse = math.sqrt(sum((point['simulated'] - point['measured']) ** 2 for point in points) / len(points))
    for point, previous in zip(points, old):
        point['baseline'] = previous['simulated']
    channel['metrics'].update({'v07BaselineRmse': prior_rmse,
        'rmseChangeFromV07': current_rmse - prior_rmse,
        'rmseReductionFractionFromV07': 1 - current_rmse / prior_rmse,
        'v07BaselineMaximumAbsoluteError': max(abs(point['simulated'] - point['measured']) for point in old)})


def baseline_identity(baseline):
    return {'version': baseline['version'], 'gitRevision': baseline['gitRevision'],
        'reportSha256': BASELINE_SHA256,
        'releaseURL': 'https://github.com/ajayasai/OpenPWR/releases/tag/v0.7.0',
        'reportURL': 'https://github.com/ajayasai/OpenPWR/releases/download/v0.7.0/pressurizer-validation.json',
        'qualification': 'Exact prior release report. Current comparisons use disclosed data and are not a renewed holdout.'}


def run_development(build_manifest, *, fmu_path=None):
    """Run the fixed original inputs with a fully bound current executable."""
    baseline = historical_evidence()
    identity = original.source_identity()
    identity['developmentComparatorSha256'] = sha(Path(__file__))
    identity['v07BaselineSha256'] = sha(BASELINE)
    protocol = json.loads(original.PROTOCOL.read_text(encoding='utf-8'))
    metadata = json.loads(original.METADATA.read_text(encoding='utf-8'))
    fmu_path = Path(fmu_path) if fmu_path else original.FMU
    if build_manifest.get('model') != original.MODEL_NAME or build_manifest.get('fmuSha256') != sha(fmu_path):
        raise ValueError('Development execution must use the bound PactelPressurizer FMU.')
    for key, value in identity.items():
        manifest_key = 'comparisonScriptSha256' if key == 'case10ComparatorSha256' else key
        if build_manifest.get(manifest_key) != value:
            raise ValueError(f'Current source was not bound by the executable manifest: {manifest_key}')
    if build_manifest.get('holdoutFreezeSha256') != sha(original.FREEZE):
        raise ValueError('The historical freeze record was not bound by the current manifest.')
    rows, shared = original.load_data(), original._main_comparator()
    numerical = protocol['numericalProtocol']
    if shared.MASS_TOLERANCE_KG != numerical['massBalanceAbsoluteToleranceKg'] or shared.ENERGY_TOLERANCE_MJ != numerical['energyBalanceAbsoluteToleranceMJ']:
        raise ValueError('Numerical acceptance differs from the original comparison protocol.')
    forcing, events = original.make_forcing(protocol, shared)
    runs = [run_case(fmu_path, original.MODEL_NAME, shared.OUTPUTS, shared.INPUTS, forcing,
        protocol['simulationWindowS'][1], step, parameters=protocol['modelParameters'],
        event_times=events, sample_interval=numerical['retainedObservationIntervalS'],
        solver_tolerance=numerical['solverRelativeTolerance'],
        boundary_integrals=(('massKg', shared.mass_flux), ('energyMJ', shared.energy_flux)))
        for step in numerical['communicationStepsS']]
    if original.source_identity() != {key: value for key, value in identity.items() if key not in ('developmentComparatorSha256', 'v07BaselineSha256')}:
        raise RuntimeError('Source changed during the post-unblinding comparison.')
    if sha(fmu_path) != build_manifest['fmuSha256'] or sha(Path(__file__)) != identity['developmentComparatorSha256']:
        raise RuntimeError('Executable or comparator changed during the post-unblinding comparison.')
    historical_evidence()
    original.check_runs(runs, build_manifest)
    channel = original.pressure_channel(rows, runs[0], runs[1], metadata, shared)
    channel.update({'name': 'Post-unblinding pressurizer pressure',
        'description': 'ATWS-11 pressure was disclosed in v0.7. This is a development comparison on the unchanged 5–295 s compression window; it is not held out from current model selection.'})
    attach_baseline(channel, baseline['holdoutComparison']['channels'][0])
    balances = [shared.balance_evidence(run) for run in runs]
    checks = [{'name': f"{balance['stepSeconds']:g} s: {check['name']}", 'value': check['error'],
        'absoluteTolerance': check['tolerance'], 'pass': check['pass'], 'unit': check['unit']}
        for balance in balances for check in balance['checks']]
    passed = all(check['pass'] for check in checks)
    return {'schema': 'openpwr-measured-validation-v1', 'version': build_manifest['version'],
        'gitRevision': build_manifest.get('gitRevision'), 'gitDirty': build_manifest.get('gitDirty', build_manifest.get('dirty')),
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'caseId': metadata['caseId'],
        'title': 'PACTEL ATWS-11 compression: post-unblinding development comparison',
        'executed': True, 'status': 'inconclusive', 'validationPassed': False,
        'comparisonRole': ROLE, 'heldOutFromCurrentDevelopment': False,
        'conclusion': 'ATWS-11 was scored and disclosed in v0.7. This new candidate is a post-unblinding development comparison, not independent validation. The original result, freeze, boundaries and measured times are retained.',
        'scope': 'Conditional 5–295 s compression replay with disclosed response; later outsurge forcing remains unidentified and excluded.',
        'source': metadata['source'], 'sourceURL': metadata['source']['url'],
        'dataURL': 'https://github.com/ajayasai/OpenPWR/blob/main/validation/pactel1998/holdout-measured.csv',
        'sourceSha256': identity['sourceSha256'], 'benchmarkModelSha256': identity['benchmarkModelSha256'],
        'inputDataSha256': identity['holdoutDataSha256'], 'referenceMetadataSha256': identity['holdoutMetadataSha256'],
        'comparisonScriptSha256': identity['developmentComparatorSha256'], 'sharedRunnerSha256': identity['sharedRunnerSha256'],
        'developmentComparatorSha256': identity['developmentComparatorSha256'], 'v07BaselineSha256': identity['v07BaselineSha256'],
        'holdoutProtocolSha256': identity['holdoutProtocolSha256'], 'holdoutFreezeSha256': sha(original.FREEZE),
        'holdoutExtractorSha256': identity['holdoutExtractorSha256'],
        'runtime': runs[0]['runtime'], 'buildManifest': build_manifest,
        'historicalReferenceMetadata': metadata, 'historicalCandidateFreeze': baseline['holdoutComparison']['candidateFreeze'],
        'releasedBaseline': baseline_identity(baseline), 'protocol': protocol,
        'comparisonWindowS': protocol['comparisonWindowS'], 'simulationWindowS': protocol['simulationWindowS'],
        'appliedParameters': protocol['modelParameters'],
        'assumptions': ['ATWS-11 is no longer held out from model development; historical reference metadata describes the v0.7 experiment.'] + metadata['limitations'],
        'channels': [channel], 'numericalPassed': passed, 'numericalChecks': checks,
        'numericalEvidence': {'pass': passed, 'balances': balances, 'stepsComparedS': numerical['communicationStepsS'],
            'solverRelativeTolerance': runs[0]['solverRelativeTolerance'], 'solverToleranceBasis': runs[0]['solverToleranceBasis'],
            'exactEventTimesS': events, 'historicalFreezeSha256': sha(original.FREEZE), 'noTimeAlignment': True,
            'selectionScope': 'Measured ATWS-11 response was already disclosed. Current model revisions can be assessed against it only as post-unblinding development.'},
        'inputs': [{'name': name, 'points': [{'time': time, 'value': forcing(time)[name]} for time in range(296)]} for name in shared.INPUTS],
        'trace': runs[0]['points'], 'refinedTrace': runs[1]['points']}
