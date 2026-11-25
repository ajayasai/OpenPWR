# SPDX-License-Identifier: Apache-2.0
"""Build or run the native Shippingport thermal-boundary case on its station clock."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend.profiles import CONTINUOUS_DEFAULT_CONTROLS
from validation.native_fmi import run_case, sha

HERE = Path(__file__).resolve().parent
MODEL = 'ShippingportStartup'
FMU = ROOT / 'artifacts/modelica/ShippingportStartup.fmu'
MANIFEST = ROOT / 'artifacts/modelica/shippingport-manifest.json'
OUT = ROOT / 'artifacts/shippingport-conditioned-native.json'
CASE = HERE / 'thermal-boundaries.json'
DURATION = 104400
SAMPLE_INTERVAL = 60
SOURCES = {
    'sourceSha256': 'models/OpenPWR/package.mo',
    'coldSourceSha256': 'models/ColdStartPlant.mo',
    'pressureSourceSha256': 'models/FinitePhasePressurizer.mo',
    'continuousSourceSha256': 'validation/shippingport_development/model/ContinuousPlant.mo',
    'shippingportSourceSha256': 'models/ShippingportStartup.mo',
    'sharedRunnerSha256': 'validation/native_fmi.py',
    'protocolSha256': 'validation/shippingport_development/protocol.json',
    'conservationProtocolSha256': 'validation/continuous/protocol.json',
    'verificationScriptSha256': 'validation/shippingport_development/run_native.py',
    'boundaryProfileSha256': 'validation/shippingport_development/thermal-boundaries.json',
    'profileScriptSha256': 'backend/profiles.py',
    'buildScriptSha256': 'scripts/modelica/build.py',
    'packagingScriptSha256': 'scripts/modelica/package_fmu.py',
}
OUTPUTS = ('averageCoolantTemperature', 'primaryPressureMPa', 'pressurizerTemperatureC',
           'totalPlantStoredEnergyMJ', 'totalPlantMassKg', 'integratedPlantBoundaryEnergyMJ',
           'integratedPlantBoundaryMassKg', 'plantEnergyResidualMW', 'plantMassResidualKgS',
           'gridConnected', 'reactorTripped', 'thermal.primarySubcoolingK')


def execute(case, step=SAMPLE_INTERVAL):
    controls = {**CONTINUOUS_DEFAULT_CONTROLS, 'effectiveHeatMW': 0., 'pumpCommand': .5,
                'coolingFraction': 0., 'feedwaterFraction': 0., 'shutdownCoolingFraction': 0.}
    # The detector, turbine, generator and the rest of the complete model remain
    # active. The station supplied no usable reactor heat or electrical-load history.
    # Hold the circulation and supply estimated net heat through the energy port.
    intervals = case['intervals']
    known = {'effectiveHeatMW', 'heaterPowerMW', 'ventFraction'}
    for item in intervals:
        selected = set(item)-{'startS', 'endS'}
        if not (0 <= item['startS'] < item['endS'] <= DURATION and len(selected) == 1 and selected <= known):
            raise ValueError('Invalid thermal boundary interval.')
        field = next(iter(selected))
        if not 0 <= item[field] <= {'effectiveHeatMW': 100, 'heaterPowerMW': 3, 'ventFraction': 1}[field]:
            raise ValueError('Thermal boundary magnitude outside the declared range.')
    for field in known:
        selected = sorted((item['startS'], item['endS']) for item in intervals if field in item)
        if any(end > later_start for (_, end), (later_start, _) in zip(selected, selected[1:])):
            raise ValueError(f'Overlapping boundary intervals for {field}.')
    def forcing(time):
        values = dict(controls)
        for item in intervals:
            if item['startS'] <= time < item['endS']:
                for key in known.intersection(item):
                    values[key] = item[key]
        return values
    edges = sorted({item[k] for item in intervals for k in ('startS', 'endS')})
    return run_case(FMU, MODEL, OUTPUTS, tuple(controls), forcing, DURATION, step,
                    sample_interval=SAMPLE_INTERVAL, event_times=edges)


def make_trace(run, refined, manifest, case):
    points = run['points']
    grid = list(range(0, DURATION+1, SAMPLE_INTERVAL))
    if [p['time'] for p in points] != grid or [p['time'] for p in refined['points']] != grid:
        raise ValueError('Incomplete historical trajectory.')
    first = points[0]
    def max_balance_error(stored, integrated):
        return max(abs((p[stored]-first[stored])-(p[integrated]-first[integrated])) for p in points)
    audit = {
        'durationSeconds': DURATION, 'stepSeconds': run['stepSeconds'],
        'sampleIntervalSeconds': SAMPLE_INTERVAL, 'samples': len(points), 'steps': run['steps'],
        'instances': 1, 'resets': 0, 'allSamplesWithinNativeDomain': True,
        'maxEnergyBalanceErrorMJ': max_balance_error('totalPlantStoredEnergyMJ', 'integratedPlantBoundaryEnergyMJ'),
        'maxMassBalanceErrorKg': max_balance_error('totalPlantMassKg', 'integratedPlantBoundaryMassKg'),
        'maxEnergyResidualMW': max(abs(p['plantEnergyResidualMW']) for p in points),
        'maxMassResidualKgS': max(abs(p['plantMassResidualKgS']) for p in points),
        'minimumPrimarySubcoolingK': min(p['thermal.primarySubcoolingK'] for p in points),
        'everGridConnected': any(p['gridConnected'] > .5 for p in points),
        'everReactorTripped': any(p['reactorTripped'] > .5 for p in points),
    }
    # Reuse the inventory and residual bounds of the default native verification.
    limits = json.loads((ROOT/'validation/continuous/protocol.json').read_text())['fullTrajectory']
    tolerances = {'maxEnergyBalanceErrorMJ': limits['nativeEnergyInventoryAbsoluteToleranceMJ'],
                  'maxMassBalanceErrorKg': limits['nativeMassInventoryAbsoluteToleranceKg'],
                  'maxEnergyResidualMW': limits['instantaneousEnergyResidualAbsoluteToleranceMW'],
                  'maxMassResidualKgS': limits['instantaneousMassResidualAbsoluteToleranceKgS']}
    audit['conservationLimits'] = tolerances
    differences = {name: max(abs(p[name]-q[name]) for p, q in zip(points, refined['points']))
                   for name in ('averageCoolantTemperature', 'primaryPressureMPa')}
    refinement_limits = {'averageCoolantTemperature': 0.01, 'primaryPressureMPa': 0.001}
    audit['refinement'] = {'stepSeconds': refined['stepSeconds'], 'samples': len(points),
                           'maxAbsoluteDifferences': differences, 'limits': refinement_limits}
    if (any(audit[k] > v for k, v in tolerances.items())
            or any(differences[k] > v for k, v in refinement_limits.items())):
        raise RuntimeError(f'Historical case exceeds its numerical verification bounds: {audit}')
    provenance = {p: manifest[key] for key, p in SOURCES.items()}
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    return {'columns': ['elapsedS', 'averageCoolantTemperature', 'primaryPressure'],
            'rows': [[p['time'], p['averageCoolantTemperature'], p['primaryPressureMPa']] for p in points],
            'model': {'class': MODEL, 'extends': 'ContinuousPlant', 'fmuPath': FMU.relative_to(ROOT).as_posix(),
                      'manifestPath': MANIFEST.relative_to(ROOT).as_posix(), 'fmuSha256': run['runtime']['fmuSha256'],
                      'gitRevision': revision, 'gitDirty': dirty, 'buildGitRevision': manifest['gitRevision'],
                      'buildGitDirty': manifest['dirty'], 'sourceHashes': provenance,
                      'compiler': run['runtime']['compiler'], 'fmiVersion': run['runtime']['fmiVersion'],
                      'relativeTolerance': run['solverRelativeTolerance'], 'boundaries': case,
                      'initialConditions': {'averageCoolantTemperatureC': first['averageCoolantTemperature'],
                                            'pressurizerTemperatureC': first['pressurizerTemperatureC'],
                                            'primaryPressureMPaAbsolute': first['primaryPressureMPa']},
                      'execution': audit}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='Compile a fresh historical whole-plant FMU first.')
    args = parser.parse_args()
    if args.build:
        subprocess.run([sys.executable, str(ROOT/'scripts/modelica/build.py'), '--model', 'shippingport'], check=True)
    manifest = json.loads(MANIFEST.read_text())
    if manifest['model'] != MODEL or manifest['fmuSha256'] != sha(FMU):
        raise RuntimeError('Historical native model or binary fingerprint differs from its manifest.')
    for key, path in SOURCES.items():
        if manifest[key] != sha(ROOT/path):
            raise RuntimeError(f'Stale Shippingport native build input: {path}')
    case = json.loads(CASE.read_text())
    trace = make_trace(execute(case), execute(case, SAMPLE_INTERVAL/2), manifest, case)
    OUT.write_text(json.dumps(trace, separators=(',', ':'), allow_nan=False)+'\n', encoding='utf-8')
    print(json.dumps(trace['model']['execution'], indent=2))


if __name__ == '__main__':
    main()
