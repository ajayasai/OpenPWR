# SPDX-License-Identifier: Apache-2.0
"""Build a native FMI 2.0 co-simulation artifact from the tracked Modelica source."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from package_fmu import prepare_fmu

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'models/OpenPWR/package.mo'
OUTPUT = ROOT / 'artifacts/modelica'
OUTPUT.mkdir(parents=True, exist_ok=True)
OMC = os.environ.get('OPENPWR_OMC', 'omc')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(model_key='primary'):
    model_name, file_prefix, manifest_name = {
        'primary': ('OpenPWR.PrimaryLoop', 'PrimaryLoop', 'manifest.json'),
        'plant': ('OpenPWR.CoupledPlant', 'CoupledPlant', 'plant-manifest.json'),
        'kinetics': ('OpenPWR.KineticsReference', 'KineticsReference', 'kinetics-manifest.json'),
        'cold': ('ColdStartPlant', 'ColdStartPlant', 'cold-manifest.json'),
        'continuous': ('ContinuousPlant', 'ContinuousPlant', 'continuous-manifest.json'),
    }[model_key]
    source_hash = sha(SOURCE)
    # Load the shared pressure component before the plant that instantiates it.
    # These sources are also hashed and included in the resulting FMU archive.
    model_sources = {
        'pressureSourceSha256': ROOT / 'models/FinitePhasePressurizer.mo',
        'coldSourceSha256': ROOT / 'models/ColdStartPlant.mo',
    } if model_key in ('cold', 'continuous') else {}
    if model_key == 'continuous':
        model_sources['continuousSourceSha256'] = ROOT / 'models/ContinuousPlant.mo'
    model_hashes = {key: sha(path) for key, path in model_sources.items()}
    bound_inputs = {key: ROOT / path for key, path in {
        'verificationScriptSha256': f'backend/verify_{model_key}.py',
        'sharedRunnerSha256': 'validation/native_fmi.py',
        'hostScriptSha256': 'backend/fmi_host.py',
        'profileScriptSha256': 'backend/profiles.py',
    }.items()} if model_sources else {}
    if model_key == 'continuous':
        bound_inputs.update({key: ROOT / path for key, path in {
            'protocolSha256': 'validation/continuous/protocol.json',
            'initialProtocolSha256': 'validation/continuous/protocol-initial.json',
            'kineticsOracleSha256': 'backend/verify_plant.py',
            'coldVerifierSha256': 'backend/verify_cold.py',
            'commonVerifierSha256': 'backend/verify.py',
            'kineticsReferenceSha256': 'validation/continuous/kinetics-reference.json',
            'experimentScriptSha256': 'backend/experiments.py',
            'buildScriptSha256': 'scripts/modelica/build.py',
            'packagingScriptSha256': 'scripts/modelica/package_fmu.py',
        }.items()})
    input_hashes = {key: sha(path) for key, path in bound_inputs.items()}
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH', '')
    compiler = subprocess.check_output([OMC, '--version'], text=True).strip()
    # Build in a fresh directory so a failed compilation cannot pass on an old FMU.
    with tempfile.TemporaryDirectory(prefix='openpwr-modelica-') as work:
        script = Path(work) / 'build.mos'
        script.write_text('\n'.join([
            'installPackage(Modelica, "4.0.0", exactMatch=true);', 'getErrorString();',
            'loadModel(Modelica, {"4.0.0"}, requireExactVersion=true);', 'getErrorString();',
            f'loadFile({json.dumps(SOURCE.as_posix())});', 'getErrorString();',
            *(line for path in model_sources.values() for line in (f'loadFile({json.dumps(path.as_posix())});', 'getErrorString();')),
            'setCommandLineOptions("--fmiFlags=s:cvode --fmuRuntimeDepends=modelica");',
            f'buildModelFMU({model_name}, version="2.0", fmuType="me_cs", fileNamePrefix="{file_prefix}");',
            'getErrorString();',
        ]), encoding='utf-8')
        result = subprocess.run([OMC, str(script)], cwd=work, text=True, capture_output=True, timeout=600)
        log = result.stdout + '\n' + result.stderr
        for detail in sorted(Path(work).glob('*_FMU.log')):
            log += '\n' + detail.name + '\n' + detail.read_text(errors='replace')
        log_name = 'build.log' if model_key == 'primary' else model_key + '-build.log'
        (OUTPUT / log_name).write_text(log, encoding='utf-8')
        built = Path(work) / (file_prefix + '.fmu')
        if sha(SOURCE) != source_hash:
            raise RuntimeError('Modelica source changed during compilation. Rebuild from a stable source tree.')
        if any(sha(model_sources[key]) != value for key, value in model_hashes.items()):
            raise RuntimeError('Native model source changed during compilation. Rebuild from a stable source tree.')
        if any(sha(bound_inputs[key]) != value for key, value in input_hashes.items()):
            raise RuntimeError('Native verification, protocol or host source changed during compilation. Rebuild.')
        if result.returncode or not built.is_file():
            print(log)
            raise RuntimeError(f'FMU compilation failed; see artifacts/modelica/{log_name}')
        with zipfile.ZipFile(built) as archive:
            xml = ET.fromstring(archive.read('modelDescription.xml'))
            if xml.attrib.get('fmiVersion') != '2.0' or xml.find('CoSimulation') is None:
                raise RuntimeError('Compiler did not produce an FMI 2.0 CoSimulation model')
            platforms = sorted({p.split('/')[1] for p in archive.namelist() if p.startswith('binaries/') and len(p.split('/')) > 2})
        target = OUTPUT / (file_prefix + '.fmu')
        target.write_bytes(built.read_bytes())
        export_metadata = prepare_fmu(target)
        if model_sources:
            with zipfile.ZipFile(target, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
                for path in model_sources.values():
                    archive.write(path, 'sources/' + path.name)
        try:
            revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
            dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
        except (OSError, subprocess.CalledProcessError):
            revision, dirty = None, None
        manifest = {**export_metadata, 'model': model_name, 'compiler': compiler, 'fmiVersion': '2.0',
                    'solver': 'CVODE', 'modelicaLibrary': '4.0.0', 'platforms': platforms,
                    'hostPlatform': platform.platform(), 'sourceSha256': source_hash,
                    'fmuSha256': sha(target), 'gitRevision': revision, 'dirty': dirty,
                    'version': json.loads((ROOT / 'package.json').read_text())['version']}
        manifest.update(model_hashes)
        manifest.update(input_hashes)
        (OUTPUT / manifest_name).write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(manifest, indent=2))
        print('FMU built. Next: npm run engineering:verify, then npm run engineering:start')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=('primary', 'plant', 'kinetics', 'cold', 'continuous'), default='primary')
    run(parser.parse_args().model)
