# SPDX-License-Identifier: Apache-2.0
"""Build a native FMI 2.0 co-simulation artifact from the tracked Modelica source."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from package_fmu import add_notices

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'models/OpenPWR/package.mo'
OUTPUT = ROOT / 'artifacts/modelica'
OUTPUT.mkdir(parents=True, exist_ok=True)
OMC = os.environ.get('OPENPWR_OMC', 'omc')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run():
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH', '')
    compiler = subprocess.check_output([OMC, '--version'], text=True).strip()
    # Build in a fresh directory so a failed compilation cannot pass on an old FMU.
    with tempfile.TemporaryDirectory(prefix='openpwr-modelica-') as work:
        script = Path(work) / 'build.mos'
        script.write_text('\n'.join([
            'installPackage(Modelica, "4.0.0", exactMatch=true);', 'getErrorString();',
            'loadModel(Modelica, {"4.0.0"}, requireExactVersion=true);', 'getErrorString();',
            f'loadFile({json.dumps(SOURCE.as_posix())});', 'getErrorString();',
            'setCommandLineOptions("--fmiFlags=s:cvode --fmuRuntimeDepends=modelica");',
            'buildModelFMU(OpenPWR.PrimaryLoop, version="2.0", fmuType="cs", fileNamePrefix="PrimaryLoop");',
            'getErrorString();',
        ]), encoding='utf-8')
        result = subprocess.run([OMC, str(script)], cwd=work, text=True, capture_output=True, timeout=600)
        log = result.stdout + '\n' + result.stderr
        for detail in sorted(Path(work).glob('*_FMU.log')):
            log += '\n' + detail.name + '\n' + detail.read_text(errors='replace')
        (OUTPUT / 'build.log').write_text(log, encoding='utf-8')
        built = Path(work) / 'PrimaryLoop.fmu'
        if result.returncode or not built.is_file():
            print(log)
            raise RuntimeError('FMU compilation failed; see artifacts/modelica/build.log')
        with zipfile.ZipFile(built) as archive:
            xml = ET.fromstring(archive.read('modelDescription.xml'))
            if xml.attrib.get('fmiVersion') != '2.0' or xml.find('CoSimulation') is None:
                raise RuntimeError('Compiler did not produce an FMI 2.0 CoSimulation model')
            platforms = sorted({p.split('/')[1] for p in archive.namelist() if p.startswith('binaries/') and len(p.split('/')) > 2})
        target = OUTPUT / 'PrimaryLoop.fmu'
        target.write_bytes(built.read_bytes())
        add_notices(target)
        try:
            revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
            dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
        except (OSError, subprocess.CalledProcessError):
            revision, dirty = None, None
        manifest = {'model': 'OpenPWR.PrimaryLoop', 'compiler': compiler, 'fmiVersion': '2.0',
                    'solver': 'CVODE', 'modelicaLibrary': '4.0.0', 'platforms': platforms,
                    'hostPlatform': platform.platform(), 'sourceSha256': sha(SOURCE),
                    'fmuSha256': sha(target), 'gitRevision': revision, 'dirty': dirty,
                    'version': json.loads((ROOT / 'package.json').read_text())['version']}
        (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(manifest, indent=2))
        print('FMU built. Next: npm run engineering:verify, then npm run engineering:start')

if __name__ == '__main__':
    run()
