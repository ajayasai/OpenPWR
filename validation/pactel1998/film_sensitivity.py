"""Reproduce bounded numerical-regularization checks for the PACTEL film closure.

This is a development sensitivity study, not a pressure-fit procedure or a new
validation event. The main comparator remains the release evidence gate.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'validation'))
sys.path.insert(0, str(HERE))
from native_fmi import run_case, sha
import compare as shared

CASES = {
    'atws10': (500, {}),
    'wide-transition': (221, {'filmTransitionLower': 10, 'filmTransitionUpper': 50}),
    'narrow-transition': (221, {'filmTransitionLower': 25, 'filmTransitionUpper': 35}),
    'low-floor': (221, {'filmReynoldsFloor': .1}),
    'high-floor': (221, {'filmReynoldsFloor': 10}),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fmu', type=Path, default=shared.FMU)
    parser.add_argument('--source', type=Path, default=shared.COMMON)
    parser.add_argument('--wrapper', type=Path, default=shared.MODEL)
    parser.add_argument('--run-dir', type=Path, default=ROOT / 'artifacts/film-sensitivity-runs')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/film-regularization.json')
    parser.add_argument('--note', help='An explicit qualification for this development compilation snapshot.')
    parser.add_argument('--summarize-existing', action='store_true',
        help='Read explicitly supplied development runs instead of executing them again.')
    args = parser.parse_args()
    metadata = json.loads(shared.PROVENANCE.read_text())
    forcing, event_times = shared.make_forcing(metadata)
    args.run_dir.mkdir(parents=True, exist_ok=True)
    runs = {}
    identities = {}
    fmu_hash = sha(args.fmu)
    for name, (duration, parameters) in CASES.items():
        path = args.run_dir / f'{name}-run.json'
        if args.summarize_existing:
            run = json.loads(path.read_text())
        else:
            run = run_case(args.fmu, shared.MODEL_NAME, shared.OUTPUTS, shared.INPUTS,
                forcing, duration, .1, parameters=parameters,
                event_times=[time for time in event_times if time <= duration],
                boundary_integrals=(('massKg', shared.mass_flux), ('energyMJ', shared.energy_flux)))
            path.write_text(json.dumps(run, indent=2) + '\n')
        if run['runtime']['model'] != shared.MODEL_NAME or run['runtime']['fmuSha256'] != fmu_hash:
            raise ValueError(f'{name}: model/binary identity mismatch.')
        if run['parameters'] != parameters or run['stepSeconds'] != .1 or run['solverRelativeTolerance'] != 1e-9:
            raise ValueError(f'{name}: parameter, communication-step or solver-tolerance mismatch.')
        if [point['time'] for point in run['points']] != list(range(duration + 1)):
            raise ValueError(f'{name}: incomplete retained observation grid.')
        if any(not math.isfinite(value) for point in run['points'] for value in point.values()):
            raise ValueError(f'{name}: nonfinite observation.')
        runs[name] = run
        identities[name] = sha(path)

    reference = runs['atws10']['points'][:222]
    cases = []
    for name, (duration, parameters) in CASES.items():
        balance = shared.balance_evidence(runs[name])
        result = {'case': name, 'durationS': duration, 'parameters': parameters,
            'runSha256': identities[name], 'balance': balance}
        if name != 'atws10':
            differences = [b['pressureMPa'] - a['pressureMPa']
                for a, b in zip(reference, runs[name]['points'])]
            result.update({'maximumPressureDifferenceMPa': max(map(abs, differences)),
                'rmsPressureDifferenceMPa': math.sqrt(sum(d*d for d in differences) / len(differences)),
                'terminalPressureDifferenceMPa': differences[-1]})
        cases.append(result)
    report = {
        'schema': 'openpwr-film-regularization-development-v1',
        'scriptVersion': 1,
        'generatedAtUTC': datetime.now(timezone.utc).isoformat(),
        'scope': 'Bounded ATWS-10 numerical-regularization sensitivity over 0-221 s; no fitted parameters, no new validation event. The nominal conservation run covers 0-500 s.',
        'comparisonWindowS': [0, 221], 'communicationStepS': .1,
        'fmuSha256': fmu_hash, 'sourceSha256': sha(args.source),
        'benchmarkModelSha256': sha(args.wrapper),
        'scriptSha256': sha(Path(__file__)), 'sharedRunnerSha256': sha(ROOT / 'validation/native_fmi.py'),
        'comparisonHelperSha256': sha(Path(shared.__file__)),
        'referenceMetadataSha256': sha(shared.PROVENANCE),
        'summarizedExistingRuns': args.summarize_existing,
        'identityQualification': 'Supplied development compilation snapshot and binary hashes; this record is not a clean release build manifest or a source-freeze claim.',
        'compilationSnapshotNote': args.note,
        'numericalPassed': all(check['pass'] for case in cases for check in case['balance']['checks']),
        'cases': cases,
        'pressureTraceColumns': ['time', *CASES],
        'pressureTraceMPa': [[i, *[runs[name]['points'][i]['pressureMPa'] for name in CASES]] for i in range(222)],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'numericalPassed': report['numericalPassed'],
        'maximumDifferencesMPa': {case['case']: case['maximumPressureDifferenceMPa']
            for case in cases if 'maximumPressureDifferenceMPa' in case}}, indent=2))
    return 0 if report['numericalPassed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
