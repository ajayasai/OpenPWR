"""Frozen references and prospective paired pressure-development scoring.

This module has no candidate model, calibration search or native runner. Its
criteria were fixed before choosing/scoring a new production pressure closure.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROTOCOL = HERE / 'protocol-initial.json'
PROTOCOL_SHA256 = '1e1e4c21730c12b68b69a7628130e7365c6ff17851860612ef33c3b5347ac408'
CHANNELS = ('primaryPressureMPa', 'hotLegTemperatureC', 'coldLegTemperatureC', 'steamPressureMPa')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def protocol():
    if sha(PROTOCOL) != PROTOCOL_SHA256:
        raise ValueError('Initial prospective pressure-development criteria changed.')
    return json.loads(PROTOCOL.read_text(encoding='utf-8'))


def baseline():
    expected = protocol()['baseline']
    path = ROOT / expected['path']
    if sha(path) != expected['sha256'] or path.stat().st_size != expected['bytes']:
        raise ValueError('Immutable v0.10 released evidence changed.')
    report = json.loads(path.read_text(encoding='utf-8'))
    if (report.get('version') != expected['version'] or report.get('gitRevision') != expected['gitRevision']
            or report.get('gitDirty') is not False
            or report.get('runtime', {}).get('fmuSha256') != expected['fmuSha256']):
        raise ValueError('Released baseline identity does not match its frozen release.')
    return report


def reference_rows():
    metadata = protocol()['reference']
    path = ROOT / metadata['data']
    if sha(path) != metadata['dataSha256']:
        raise ValueError('Original acquired measured values changed.')
    with path.open(newline='', encoding='utf-8') as stream:
        rows = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(stream)]
    if [row['time'] for row in rows] != list(range(-49, 50, 2)):
        raise ValueError('Original measured acquisition grid changed.')
    if any(not math.isfinite(value) for row in rows for value in row.values()):
        raise ValueError('Nonfinite reference observation.')
    return rows


def at(points, time, key):
    if len(points) < 2 or not points[0]['time'] <= time <= points[-1]['time']:
        raise ValueError('Reference or native trace extrapolation is forbidden.')
    for left, right in zip(points, points[1:]):
        if left['time'] <= time <= right['time']:
            if not left['time'] < right['time']:
                raise ValueError('Trace times must be strictly increasing.')
            return left[key]+(time-left['time'])/(right['time']-left['time'])*(right[key]-left[key])
    raise ValueError('Missing comparison interval.')


def rms(values):
    return math.sqrt(sum(value*value for value in values)/len(values))


def score_trace(nominal, refined):
    """Score acquired times only; each input is a retained native point list."""
    rows = reference_rows()
    times = protocol()['reference']['metricSampleTimesSeconds']
    result = []
    for key in CHANNELS:
        points = [{'time': time, 'measured': at(rows, time, key),
                   'simulated': at(nominal, time, key), 'refined': at(refined, time, key)}
                  for time in [0, *times]]
        if any(not math.isfinite(value) for point in points for value in point.values()):
            raise ValueError('Nonfinite scored observation.')
        first, scored = points[0], points[1:]
        errors = [point['simulated']-point['measured'] for point in scored]
        metrics = {'samples': len(scored), 'rmse': rms(errors),
            'changeRmse': rms([(point['simulated']-first['simulated'])
                              -(point['measured']-first['measured']) for point in scored]),
            'maximumAbsoluteError': max(map(abs, errors)), 'meanError': sum(errors)/len(errors),
            'initialBias': first['simulated']-first['measured'], 'finalError': errors[-1],
            'maximumStepRefinementDifference': max(abs(point['simulated']-point['refined']) for point in points)}
        channel = {'key': key, 'metrics': metrics, 'points': points}
        if key == 'primaryPressureMPa':
            # Compare on the same acquired sample grid. This does not estimate a
            # continuous physical peak or invent sub-sample timing precision.
            measured_peak = max(scored, key=lambda point: point['measured'])
            simulated_peak = max(scored, key=lambda point: point['simulated'])
            channel['pressureDiagnostics'] = {
                'sampleGridSeconds': times,
                'measuredPeakMPa': measured_peak['measured'], 'simulatedPeakMPa': simulated_peak['simulated'],
                'measuredPeakTimeSeconds': measured_peak['time'], 'simulatedPeakTimeSeconds': simulated_peak['time'],
                'peakMagnitudeErrorMPa': simulated_peak['simulated']-measured_peak['measured'],
                'peakTimeDifferenceSeconds': simulated_peak['time']-measured_peak['time'],
                'measuredPeakRiseMPa': measured_peak['measured']-first['measured'],
                'simulatedPeakRiseMPa': simulated_peak['simulated']-first['simulated'],
                'measuredFinalRiseMPa': scored[-1]['measured']-first['measured'],
                'simulatedFinalRiseMPa': scored[-1]['simulated']-first['simulated'],
            }
        result.append(channel)
    return result


def paired_improvement(candidate_channels, equilibrium_channels):
    """Apply predeclared development guards; never return a physical pass."""
    frozen = baseline()
    p = protocol()
    policy = p['pairedImprovementCriteria']
    candidate = {channel['key']: channel['metrics'] for channel in candidate_channels}
    if set(candidate) != set(CHANNELS) or len(candidate_channels) != len(CHANNELS):
        raise ValueError('Candidate must disclose every held-out response exactly once.')
    references = [('immutable-v0.10-baseline', frozen['channels']),
                  ('same-boundary-equilibrium-ablation', equilibrium_channels)]
    checks = []
    for label, reference_channels in references:
        reference = {channel['key']: channel['metrics'] for channel in reference_channels}
        if set(reference) != set(CHANNELS) or len(reference_channels) != len(CHANNELS):
            raise ValueError('Reference must disclose every held-out response exactly once.')
        for key in CHANNELS:
            primary = key == policy['primaryChannel']
            metrics = policy['requiredPrimaryMetrics'] if primary else policy['nonDegradationMetrics']
            refinement_limit = p['numericalLimits']['pressureRefinementMPa'
                if key.endswith('PressureMPa') else 'temperatureRefinementK']
            if any(not math.isfinite(item[key]['maximumStepRefinementDifference'])
                   or not 0 <= item[key]['maximumStepRefinementDifference'] <= refinement_limit
                   for item in (candidate, reference)):
                raise ValueError('A failed refinement check cannot enlarge the non-degradation allowance.')
            allowance = candidate[key]['maximumStepRefinementDifference']+reference[key]['maximumStepRefinementDifference']
            if not math.isfinite(allowance) or allowance < 0:
                raise ValueError('Invalid communication-step allowance.')
            for metric in metrics:
                cv, rv = candidate[key][metric], reference[key][metric]
                if not math.isfinite(cv) or not math.isfinite(rv) or cv < 0 or rv < 0:
                    raise ValueError('Invalid paired error metric.')
                selected_allowance = (2 if metric == 'changeRmse' else 1)*allowance
                delta = cv-rv
                checks.append({'reference': label, 'channel': key, 'metric': metric,
                    'kind': 'pressure-improvement' if primary else 'other-channel-non-degradation',
                    'candidate': cv, 'referenceValue': rv, 'delta': delta,
                    'communicationAllowance': selected_allowance,
                    'pass': delta < -selected_allowance if primary else delta <= selected_allowance})
    return {'protocolSha256': PROTOCOL_SHA256,
            'baselineSha256': p['baseline']['sha256'],
            'caseImprovementPassed': all(check['pass'] for check in checks),
            'physicalValidationPassed': False, 'independentValidationPassed': False,
            'checks': checks,
            'meaning': policy['meaning']}
