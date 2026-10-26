"""Build/run a native boundary replay and report held-out measured discrepancies.

This report deliberately remains inconclusive for plant validation. Unspecified
geometry and instrument uncertainties are not replaced by a numerical pass flag.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT/'scripts/modelica'))
from package_fmu import add_notices
COMMON = ROOT/'models/OpenPWR/package.mo'
MODEL = ROOT/'models/KrskoTransient.mo'
DATA = HERE/'measured.csv'
PROVENANCE = HERE/'provenance.json'
FMU = ROOT/'artifacts/modelica/KrskoTransient.fmu'
MANIFEST = ROOT/'artifacts/modelica/krsko-manifest.json'
OUTPUT = ROOT/'artifacts/measured-validation.json'
INPUTS = ('reactorPowerMW', 'steamFlowKgS', 'feedwaterFlowKgS')
CHANNELS = {'primaryPressureMPa': ('Primary pressure', 'MPa'),
            'hotLegTemperatureC': ('Mean hot-leg temperature', '°C'),
            'coldLegTemperatureC': ('Mean cold-leg temperature', '°C'),
            'steamPressureMPa': ('Mean secondary pressure', 'MPa')}
DIAGNOSTICS = ('thermalEnergyMJ', 'totalMassKg', 'boundaryMassFlowKgS',
               'boundaryPowerMW', 'energyResidualMW', 'massResidualKgS')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def identity():
    try:
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        revision, dirty = None, None
    return {'version': json.loads((ROOT/'package.json').read_text())['version'],
            'gitRevision': revision, 'gitDirty': dirty, 'sourceSha256': sha(COMMON),
            'benchmarkModelSha256': sha(MODEL), 'inputDataSha256': sha(DATA),
            'referenceMetadataSha256': sha(PROVENANCE)}

def build():
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH', '')
    compiler = os.environ.get('OPENPWR_OMC', 'omc')
    version = subprocess.check_output([compiler, '--version'], text=True).strip()
    build_identity = identity()
    FMU.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='openpwr-krsko-build-') as work:
        script = Path(work)/'build.mos'
        script.write_text('\n'.join([
            'installPackage(Modelica, "4.0.0", exactMatch=true);', 'getErrorString();',
            'loadModel(Modelica, {"4.0.0"}, requireExactVersion=true);',
            f'loadFile({json.dumps(COMMON.as_posix())});',
            f'loadFile({json.dumps(MODEL.as_posix())});', 'getErrorString();',
            'setCommandLineOptions("--fmiFlags=s:cvode --fmuRuntimeDepends=modelica");',
            'buildModelFMU(OpenPWR.KrskoTransient, version="2.0", fmuType="cs", fileNamePrefix="KrskoTransient");',
            'getErrorString();']), encoding='utf-8')
        result = subprocess.run([compiler, str(script)], cwd=work, capture_output=True, text=True, timeout=600)
        log = result.stdout+'\n'+result.stderr
        for detail in sorted(Path(work).glob('*_FMU.log')):
            log += '\n'+detail.name+'\n'+detail.read_text(errors='replace')
        (FMU.parent/'krsko-build.log').write_text(log)
        candidate = Path(work)/'KrskoTransient.fmu'
        if result.returncode or not candidate.is_file():
            print(log)
            raise RuntimeError('Measured-case model build failed; see artifacts/modelica/krsko-build.log')
        if identity() != build_identity:
            raise RuntimeError('Source or repository identity changed during compilation; rebuild before publishing evidence.')
        shutil.copyfile(candidate, FMU)
        add_notices(FMU)
        with zipfile.ZipFile(FMU, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(MODEL, 'sources/OpenPWR/KrskoTransient.mo')
            archive.write(DATA, 'documentation/reference/krsko2005-measured.csv')
            archive.write(PROVENANCE, 'documentation/reference/krsko2005-provenance.json')
        manifest = {**build_identity, 'model': 'OpenPWR.KrskoTransient',
            'compiler': version, 'fmuSha256': sha(FMU), 'fmiVersion': '2.0',
            'modelicaLibrary': '4.0.0', 'hostPlatform': platform.platform()}
        MANIFEST.write_text(json.dumps(manifest, indent=2)+'\n')
        print('Built native measured-case FMU', manifest['fmuSha256'])

def load_data():
    with DATA.open(newline='', encoding='utf-8') as stream:
        rows = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(stream)]
    if len(rows) != 50 or [row['time'] for row in rows] != list(range(-49, 50, 2)):
        raise ValueError('Reference must preserve the 50 original acquisition times.')
    if any(not math.isfinite(value) for row in rows for value in row.values()):
        raise ValueError('Non-finite reference data.')
    return rows

def at(rows, time, key):
    if not rows[0]['time'] <= time <= rows[-1]['time']:
        raise ValueError('Reference extrapolation is not allowed.')
    for a, b in zip(rows, rows[1:]):
        if a['time'] <= time <= b['time']:
            weight = (time-a['time'])/(b['time']-a['time'])
            return a[key]+weight*(b[key]-a[key])
    raise ValueError('Missing reference interval.')

def simulate(rows, step=.05, geometry_scale=1):
    from fmpy import extract, read_model_description
    from fmpy.fmi2 import FMU2Slave
    description = read_model_description(str(FMU), validate=True)
    variables = {v.name: v for v in description.modelVariables}
    names = tuple(CHANNELS)+DIAGNOSTICS
    refs = [variables[name].valueReference for name in names]
    input_refs = [variables[name].valueReference for name in INPUTS]
    valid_ref = variables['valid'].valueReference
    directory = extract(str(FMU))
    slave = None
    points = []
    mass_integral, energy_integral = 0.0, 0.0
    try:
        slave = FMU2Slave(guid=description.guid, unzipDirectory=directory,
                         modelIdentifier=description.coSimulation.modelIdentifier,
                         instanceName=f'krsko_{step}_{geometry_scale}'.replace('.', '_'))
        slave.instantiate(); slave.setupExperiment(startTime=0)
        slave.enterInitializationMode()
        slave.setReal([variables['geometryScale'].valueReference], [geometry_scale])
        slave.setReal(input_refs, [at(rows, 0, name) for name in INPUTS])
        slave.exitInitializationMode()
        def observation(time):
            values = slave.getReal(refs)
            if any(not math.isfinite(value) for value in values):
                raise RuntimeError('Native solver returned a non-finite observation.')
            if not slave.getBoolean([valid_ref])[0]:
                raise RuntimeError(f'Native measured-case domain exit at {time:g} s.')
            return {'time': time, **dict(zip(names, map(float, values)))}
        previous = observation(0)
        initial = dict(previous)
        points.append(previous)
        for tick in range(1, round(15/step)+1):
            time = (tick-1)*step
            # Piecewise-linear measured forcing sampled on the FMI grid;
            # each requested value is held only over this communication step.
            slave.setReal(input_refs, [at(rows, time, name) for name in INPUTS])
            before = observation(time)
            status = slave.doStep(currentCommunicationPoint=time, communicationStepSize=step)
            if status not in (None, 0, 1):
                raise RuntimeError(f'FMI step failed with status {status}')
            current = observation(tick*step)
            mass_integral += .5*step*(before['boundaryMassFlowKgS']+current['boundaryMassFlowKgS'])
            energy_integral += .5*step*(before['boundaryPowerMW']+current['boundaryPowerMW'])
            if abs(current['time']-round(current['time'])) < 1e-9:
                points.append(current)
            previous = current
        return {'stepSeconds': step, 'geometryScale': geometry_scale, 'points': points,
            'massIntegralErrorKg': previous['totalMassKg']-initial['totalMassKg']-mass_integral,
            'energyIntegralErrorMJ': previous['thermalEnergyMJ']-initial['thermalEnergyMJ']-energy_integral,
            'runtime': {'model': description.modelName, 'fmuSha256': sha(FMU),
                        'compiler': description.generationTool, 'fmiVersion': description.fmiVersion}}
    finally:
        if slave is not None:
            try: slave.terminate()
            except Exception: pass
            try: slave.freeInstance()
            except Exception: pass
        shutil.rmtree(directory, ignore_errors=True)

def compare():
    manifest = json.loads(MANIFEST.read_text())
    current_identity = identity()
    for key in ('sourceSha256', 'benchmarkModelSha256', 'inputDataSha256', 'referenceMetadataSha256'):
        if manifest.get(key) != current_identity[key]:
            raise ValueError(f'Stale native measured-case {key}; rebuild first.')
    if manifest['fmuSha256'] != sha(FMU):
        raise ValueError('Measured-case FMU bytes do not match the build manifest.')
    rows = load_data()
    provenance = json.loads(PROVENANCE.read_text(encoding='utf-8'))
    primary = simulate(rows)
    refined = simulate(rows, step=.025)
    sensitivity = [simulate(rows, geometry_scale=scale) for scale in (.5, 2)]
    measured_times = [0]+list(range(1, 16, 2))
    channels = []
    for key, (name, unit) in CHANNELS.items():
        initial_reference = at(rows, 0, key)
        initial_simulation = primary['points'][0][key]
        points = [{'time': time, 'measured': at(rows, time, key),
                   'simulated': at(primary['points'], time, key),
                   'refined': at(refined['points'], time, key)} for time in measured_times]
        # t=0 is interpolated and initialized from Table 2, so retain it on the
        # trace but calculate comparison errors only at the 8 acquired samples.
        errors = [point['simulated']-point['measured'] for point in points[1:]]
        change_errors = [(point['simulated']-initial_simulation)-(point['measured']-initial_reference) for point in points[1:]]
        metrics = {'samples': len(errors), 'rmse': math.sqrt(sum(error*error for error in errors)/len(errors)),
                   'maximumAbsoluteError': max(map(abs, errors)), 'meanError': sum(errors)/len(errors),
                   'initialBias': initial_simulation-initial_reference, 'finalError': errors[-1],
                   'changeRmse': math.sqrt(sum(error*error for error in change_errors)/len(change_errors)),
                   'maximumStepRefinementDifference': max(abs(point['simulated']-point['refined']) for point in points),
                   'maximumGeometrySensitivitySpread': max(abs(at(sensitivity[0]['points'], time, key)-at(sensitivity[1]['points'], time, key)) for time in measured_times),
                   'maximumReferenceTimingAllowance': max(abs(at(rows, time+offset, key)-at(rows, time, key)) for time in measured_times[1:] for offset in (-1, 1))}
        channels.append({'key': key, 'name': name, 'unit': unit, 'metrics': metrics, 'points': points})
    report = {'schema': 'openpwr-measured-validation-v1', **current_identity,
        'comparisonScriptSha256': sha(Path(__file__)),
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'executed': True,
        'status': 'inconclusive', 'validationPassed': False,
        'conclusion': 'The measured transient comparison ran successfully, but plant validation is not established. Geometry, thermal storage and instrument uncertainties remain incompletely specified; all measured-response discrepancies are retained.',
        'caseId': provenance['caseId'], 'title': provenance['title'],
        'source': provenance['source'], 'sourceURL': provenance['source']['url'],
        'dataURL': 'https://github.com/ajayasai/OpenPWR/blob/main/validation/krsko2005/measured.csv',
        'runtime': primary['runtime'], 'buildManifest': manifest,
        'metadata': provenance, 'comparisonWindowS': [0, 15],
        'inputs': [{'name': name, 'points': [{'time': time, 'value': at(rows, time, name)} for time in range(16)]} for name in INPUTS],
        'assumptions': provenance['limitations'], 'channels': channels,
        'numericalEvidence': {'massIntegralErrorKg': primary['massIntegralErrorKg'],
            'energyIntegralErrorMJ': primary['energyIntegralErrorMJ'],
            'refinedMassIntegralErrorKg': refined['massIntegralErrorKg'],
            'refinedEnergyIntegralErrorMJ': refined['energyIntegralErrorMJ'],
            'stepsComparedS': [.05, .025],
            'geometrySensitivityScales': [.5, 1, 2],
            'metricSampleTimesS': list(range(1, 16, 2)),
            'initialPoint': 't=0 is linearly interpolated from the figure; excluded from error statistics and retained to show initialization bias.',
            'scope': 'Independent boundary integrals, communication-step refinement and explicitly uncalibrated volume/capacity sensitivity. These are numerical diagnostics, not uncertainty propagation or physical acceptance tests.'},
        'sensitivity': [{'geometryScale': run['geometryScale'], 'points': run['points']} for run in sensitivity],
        'trace': primary['points']}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    for channel in channels:
        print(f"{channel['name']}: RMSE {channel['metrics']['rmse']:.6g} {channel['unit']}; maximum error {channel['metrics']['maximumAbsoluteError']:.6g}")
    print('Comparison executed; plant validation INCONCLUSIVE. See artifacts/measured-validation.json')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='Build the dedicated native case before comparison.')
    args = parser.parse_args()
    if args.build: build()
    compare()
