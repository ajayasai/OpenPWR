"""Score the prespecified ATWS-11 response only against a frozen candidate.

This module reuses the ATWS-10 numerical accounting and envelope routines through
an isolated module name. It does not use ATWS-11 pressure to select a model.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations
import argparse
import csv
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'validation'))
from native_fmi import run_case, sha

DATA = HERE / 'holdout-measured.csv'
METADATA = HERE / 'holdout-provenance.json'
PROTOCOL = HERE / 'holdout-protocol.json'
FREEZE = HERE / 'holdout-freeze.json'
EXTRACTOR = HERE / 'holdout_extract.py'
MAIN_COMPARATOR = HERE / 'compare.py'
COMMON = ROOT / 'models/OpenPWR/package.mo'
MODEL = ROOT / 'models/PactelPressurizer.mo'
RUNNER = ROOT / 'validation/native_fmi.py'
FMU = ROOT / 'artifacts/modelica/PactelPressurizer.fmu'
OUTPUT = ROOT / 'artifacts/pressurizer-holdout-validation.json'
MODEL_NAME = 'OpenPWR.PactelPressurizer'


def _main_comparator():
    specification = importlib.util.spec_from_file_location('openpwr_pactel_shared_comparison', MAIN_COMPARATOR)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def source_identity():
    return {'sourceSha256': sha(COMMON), 'benchmarkModelSha256': sha(MODEL),
        'sharedRunnerSha256': sha(RUNNER), 'holdoutComparatorSha256': sha(Path(__file__)),
        'case10ComparatorSha256': sha(MAIN_COMPARATOR), 'holdoutDataSha256': sha(DATA),
        'holdoutMetadataSha256': sha(METADATA), 'holdoutProtocolSha256': sha(PROTOCOL),
        'holdoutExtractorSha256': sha(EXTRACTOR)}


def freeze_candidate():
    """Record exact sources before the first held-out calculation; never overwrite."""
    if FREEZE.exists():
        raise FileExistsError('A candidate freeze already exists. Preserve it; do not reset a holdout after seeing its result.')
    protocol = json.loads(PROTOCOL.read_text(encoding='utf-8'))
    metadata = json.loads(METADATA.read_text(encoding='utf-8'))
    if metadata['extraction']['csvSha256'] != sha(DATA):
        raise ValueError('Held-out measured bytes differ from their extraction provenance.')
    try:
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        revision, dirty = None, None
    freeze = {'schema': 'openpwr-heldout-freeze-v1', 'caseId': protocol['caseId'],
        'frozenAtUTC': datetime.now(timezone.utc).isoformat(), 'selectedAtUTC': protocol['selectedAtUTC'],
        'sourceRevisionAtFreeze': revision, 'sourceDirtyAtFreeze': dirty,
        'candidate': source_identity(), 'responseUsedForModelSelection': False,
        'scope': 'The ATWS-11 pressure response was withheld from this model-development cycle. The source report general discussion was already available. This is not historically blind external validation.'}
    # Exclusive creation prevents concurrent writers from resetting the record;
    # LF bytes keep its identity stable across Windows and Linux checkouts.
    with FREEZE.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(freeze, indent=2) + '\n')
    return freeze


def checked_freeze():
    if not FREEZE.exists():
        raise ValueError('Freeze the complete candidate before computing any ATWS-11 response discrepancy.')
    freeze = json.loads(FREEZE.read_text(encoding='utf-8'))
    if freeze.get('schema') != 'openpwr-heldout-freeze-v1' or freeze.get('responseUsedForModelSelection') is not False:
        raise ValueError('The held-out candidate freeze is missing its development-separation contract.')
    for key, value in source_identity().items():
        if freeze.get('candidate', {}).get(key) != value:
            raise ValueError(f'Candidate changed after the holdout freeze: {key}. Preserve prior results; do not silently reclassify the new evaluation as held out.')
    return freeze


def load_data():
    metadata = json.loads(METADATA.read_text(encoding='utf-8'))
    if sha(DATA) != metadata['extraction']['csvSha256']:
        raise ValueError('Held-out measured CSV does not match its extraction provenance.')
    with DATA.open(newline='', encoding='utf-8') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ['time', 'pressureMPa']:
            raise ValueError('Held-out data must contain only time and measured pressure.')
        rows = [{key: float(value) for key, value in row.items()} for row in reader]
    if [row['time'] for row in rows] != list(range(5, 296)):
        raise ValueError('Held-out data must preserve the prespecified 5–295 s reading grid.')
    if any(not math.isfinite(value) for row in rows for value in row.values()):
        raise ValueError('Nonfinite held-out measurement.')
    return rows


def make_forcing(protocol, shared):
    boundary = protocol['forcing']
    end = protocol['simulationWindowS'][1]
    for table in (boundary['surgeMassFlowKgS'], boundary['heaterPowerW']):
        if not table or table[0][0] != 0 or any(len(point) != 2 or any(not math.isfinite(v) for v in point) for point in table):
            raise ValueError('Invalid held-out boundary table.')
        if any(a[0] >= b[0] for a, b in zip(table, table[1:])) or table[-1][0] > end:
            raise ValueError('Held-out boundary knots must be ordered and inside the selected window.')
    def forcing(time):
        if not math.isfinite(time) or not 0 <= time <= end:
            raise ValueError('The held-out forcing must not be extrapolated beyond the prespecified window.')
        return {'surgeFlowKgS': shared.table_value(boundary['surgeMassFlowKgS'], time),
            'surgeTemperatureK': boundary['inletTemperatureK'],
            'heaterPowerMW': shared.table_value(boundary['heaterPowerW'], time) / 1e6}
    events = sorted({time for table in (boundary['surgeMassFlowKgS'], boundary['heaterPowerW']) for time, _ in table})
    return forcing, events


def pressure_channel(rows, primary, refined, metadata, shared):
    vertical = metadata['measurementUncertainty']['conditionalPressureEnvelopeMPa']
    timing = metadata['extraction']['figureTimeReadingAllowanceS']
    points = []
    for row in rows:
        time = row['time']
        lower, upper = shared.pressure_envelope(rows, time, vertical, timing)
        points.append({'time': time, 'measured': row['pressureMPa'],
            'simulated': shared.interpolate(primary['points'], time, 'pressureMPa'),
            'refined': shared.interpolate(refined['points'], time, 'pressureMPa'),
            'lowerAllowance': lower, 'upperAllowance': upper})
    errors = [point['simulated'] - point['measured'] for point in points]
    exceedances = [max(point['lowerAllowance'] - point['simulated'], point['simulated'] - point['upperAllowance'], 0) for point in points]
    metrics = {'samples': len(points), 'rmse': math.sqrt(sum(e * e for e in errors) / len(errors)),
        'maximumAbsoluteError': max(map(abs, errors)), 'meanError': sum(errors) / len(errors),
        'initialBias': errors[0], 'initialBiasTimeS': rows[0]['time'], 'finalError': errors[-1],
        'maximumStepRefinementDifference': max(abs(point['simulated'] - point['refined']) for point in points),
        'conditionalEnvelopeCoveredPositions': sum(value == 0 for value in exceedances),
        'conditionalEnvelopeCoverageFraction': sum(value == 0 for value in exceedances) / len(points),
        'maximumEnvelopeExceedance': max(exceedances)}
    return {'key': 'pressureMPa', 'name': 'Held-out pressurizer pressure', 'unit': 'MPa',
        'description': 'ATWS-11 response withheld from this model-development cycle; 5–295 s compression window. Correlated graphical positions, not independent raw acquisitions. No full-event peak or expansion-response claim.',
        'metrics': metrics, 'points': points}


def check_runs(runs, build_manifest):
    """Fail closed on incomplete, nonfinite or incorrectly identified native traces."""
    for run in runs:
        if [point['time'] for point in run['points']] != list(range(296)):
            raise ValueError('Held-out run did not retain the complete prespecified observation grid.')
        if any(not math.isfinite(value) for point in run['points'] for value in point.values()):
            raise ValueError('Held-out native trace contains a nonfinite value.')
        if any(not math.isfinite(run['integrals'][name]) for name in ('massKg', 'energyMJ')):
            raise ValueError('Held-out native quadrature contains a nonfinite value.')
        if run['runtime']['model'] != MODEL_NAME or run['runtime']['fmuSha256'] != build_manifest['fmuSha256']:
            raise ValueError('The held-out runtime differs from the bound native model.')


def run_holdout(build_manifest, *, fmu_path=None):
    """Return a nested UI-compatible report; refuse a changed or unfrozen candidate."""
    freeze = checked_freeze()
    identity = source_identity()
    protocol = json.loads(PROTOCOL.read_text(encoding='utf-8'))
    metadata = json.loads(METADATA.read_text(encoding='utf-8'))
    fmu_path = Path(fmu_path) if fmu_path else FMU
    if build_manifest.get('model') != MODEL_NAME or build_manifest.get('fmuSha256') != sha(fmu_path):
        raise ValueError('Held-out execution must use the bound PactelPressurizer FMU.')
    for key in ('sourceSha256', 'benchmarkModelSha256', 'sharedRunnerSha256'):
        if build_manifest.get(key) != identity[key]:
            raise ValueError(f'Held-out executable source does not match the candidate: {key}')
    if build_manifest.get('comparisonScriptSha256') != identity['case10ComparatorSha256']:
        raise ValueError('The shared comparison routines were not bound by the build manifest.')
    for key in ('holdoutDataSha256', 'holdoutMetadataSha256', 'holdoutComparatorSha256', 'holdoutProtocolSha256', 'holdoutExtractorSha256'):
        if build_manifest.get(key) != identity[key]:
            raise ValueError(f'Held-out source was not bound when the executable was packaged: {key}')
    if build_manifest.get('holdoutFreezeSha256') != sha(FREEZE):
        raise ValueError('Held-out freeze record was not bound by the build manifest.')
    rows, shared = load_data(), _main_comparator()
    numerical = protocol['numericalProtocol']
    if shared.MASS_TOLERANCE_KG != numerical['massBalanceAbsoluteToleranceKg'] or shared.ENERGY_TOLERANCE_MJ != numerical['energyBalanceAbsoluteToleranceMJ']:
        raise ValueError('Numerical acceptance differs from the prespecified held-out protocol.')
    forcing, events = make_forcing(protocol, shared)
    runs = [run_case(fmu_path, MODEL_NAME, shared.OUTPUTS, shared.INPUTS, forcing,
        protocol['simulationWindowS'][1], step, parameters=protocol['modelParameters'],
        event_times=events, sample_interval=numerical['retainedObservationIntervalS'],
        solver_tolerance=numerical['solverRelativeTolerance'],
        boundary_integrals=(('massKg', shared.mass_flux), ('energyMJ', shared.energy_flux)))
        for step in numerical['communicationStepsS']]
    checked_freeze()
    if sha(fmu_path) != build_manifest['fmuSha256']:
        raise RuntimeError('Held-out executable changed during the run.')
    check_runs(runs, build_manifest)
    channel = pressure_channel(rows, runs[0], runs[1], metadata, shared)
    balances = [shared.balance_evidence(run) for run in runs]
    checks = [{'name': f"{balance['stepSeconds']:g} s: {check['name']}", 'value': check['error'],
        'absoluteTolerance': check['tolerance'], 'pass': check['pass'], 'unit': check['unit']}
        for balance in balances for check in balance['checks']]
    passed = all(check['pass'] for check in checks)
    return {'schema': 'openpwr-measured-validation-v1', 'version': build_manifest['version'],
        'gitRevision': build_manifest.get('gitRevision'), 'gitDirty': build_manifest.get('gitDirty', build_manifest.get('dirty')),
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'caseId': metadata['caseId'], 'title': metadata['title'],
        'executed': True, 'status': 'inconclusive', 'validationPassed': False,
        'conclusion': 'The prespecified ATWS-11 compression response was scored after the candidate source freeze. Numerical acceptance and measured discrepancies are reported separately; this component holdout does not establish full-plant validation.',
        'scope': 'Development-separated pressure response in a conditional 5–295 s compression replay; later outsurge forcing is unidentified and excluded.',
        'source': metadata['source'], 'sourceURL': metadata['source']['url'],
        'dataURL': 'https://github.com/ajayasai/OpenPWR/blob/main/validation/pactel1998/holdout-measured.csv',
        'sourceSha256': identity['sourceSha256'], 'benchmarkModelSha256': identity['benchmarkModelSha256'],
        'inputDataSha256': identity['holdoutDataSha256'], 'referenceMetadataSha256': identity['holdoutMetadataSha256'],
        'comparisonScriptSha256': identity['holdoutComparatorSha256'], 'sharedRunnerSha256': identity['sharedRunnerSha256'],
        'holdoutProtocolSha256': identity['holdoutProtocolSha256'], 'holdoutFreezeSha256': sha(FREEZE),
        'holdoutExtractorSha256': identity['holdoutExtractorSha256'],
        'runtime': runs[0]['runtime'], 'buildManifest': build_manifest, 'metadata': metadata,
        'candidateFreeze': freeze, 'protocol': protocol,
        'comparisonWindowS': protocol['comparisonWindowS'], 'simulationWindowS': protocol['simulationWindowS'],
        'appliedParameters': protocol['modelParameters'], 'assumptions': metadata['limitations'],
        'channels': [channel], 'numericalPassed': passed, 'numericalChecks': checks,
        'numericalEvidence': {'pass': passed, 'balances': balances, 'stepsComparedS': numerical['communicationStepsS'],
            'solverRelativeTolerance': runs[0]['solverRelativeTolerance'], 'solverToleranceBasis': runs[0]['solverToleranceBasis'],
            'exactEventTimesS': events, 'freezeSha256': sha(FREEZE),
            'noResponseFitting': True, 'noTimeAlignment': True,
            'selectionScope': 'Case/window/inputs were selected before response extraction; candidate sources were frozen before computing response discrepancies.'},
        'inputs': [{'name': name, 'points': [{'time': time, 'value': forcing(time)[name]} for time in range(296)]} for name in shared.INPUTS],
        'trace': runs[0]['points'], 'refinedTrace': runs[1]['points']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true', help='Freeze final candidate sources before any ATWS-11 scoring. Never overwrites an existing freeze.')
    args = parser.parse_args()
    if args.freeze:
        result = freeze_candidate()
        print('Candidate frozen at', result['frozenAtUTC'], '; no held-out comparison executed.')
    else:
        manifest = json.loads((ROOT / 'artifacts/modelica/pactel-manifest.json').read_text())
        report = run_holdout(manifest)
        OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
        print('Held-out comparison completed; physical validation remains inconclusive.')
        if not report['numericalPassed']:
            raise SystemExit(1)
