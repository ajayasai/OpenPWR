# SPDX-License-Identifier: Apache-2.0
"""Build and compare the native MSL property probe against published NIST data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/modelica'))
from package_fmu import add_notices
SOURCE = ROOT / 'models/OpenPWR/package.mo'
OUTPUT = ROOT / 'artifacts/modelica'
FMU = OUTPUT / 'PropertyReferenceChecks.fmu'
MANIFEST = OUTPUT / 'property-manifest.json'
NIST_SOURCE = {
    'title': 'NISTIR 5078, Table 1: Saturation (Temperature)',
    'url': 'https://www.nist.gov/document/nistir5078-tab1pdf',
}
# Printed NIST table data, not values computed by either simulator.
# T in degC, p in MPa, h in kJ/kg; 0.05% allows IF97/IAPWS-95 differences
# and the precision of the published table.
REFERENCES = [
    (20, .0023393, 83.91, 2537.4),
    (100, .10142, 419.17, 2675.6),
    (200, 1.5549, 852.27, 2792.0),
    (300, 8.5879, 1345.0, 2749.6),
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata():
    try:
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        revision, dirty = None, None
    return {'version': json.loads((ROOT / 'package.json').read_text())['version'],
            'gitRevision': revision, 'dirty': dirty, 'sourceSha256': sha(SOURCE)}


def build():
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH', '')
    omc = os.environ.get('OPENPWR_OMC', 'omc')
    compiler = subprocess.check_output([omc, '--version'], text=True).strip()
    with tempfile.TemporaryDirectory(prefix='openpwr-property-build-') as work:
        script = Path(work) / 'build.mos'
        script.write_text('\n'.join([
            'installPackage(Modelica, "4.0.0", exactMatch=true);', 'getErrorString();',
            'loadModel(Modelica, {"4.0.0"}, requireExactVersion=true);', 'getErrorString();',
            f'loadFile({json.dumps(SOURCE.as_posix())});', 'getErrorString();',
            'setCommandLineOptions("--fmiFlags=s:cvode --fmuRuntimeDepends=modelica");',
            'buildModelFMU(OpenPWR.PropertyReferenceChecks, version="2.0", fmuType="cs", fileNamePrefix="PropertyReferenceChecks");',
            'getErrorString();',
        ]), encoding='utf-8')
        result = subprocess.run([omc, str(script)], cwd=work, text=True, capture_output=True, timeout=600)
        log = result.stdout + '\n' + result.stderr
        (OUTPUT / 'property-build.log').write_text(log, encoding='utf-8')
        built = Path(work) / FMU.name
        if result.returncode or not built.is_file():
            raise RuntimeError('Property FMU compilation failed; see artifacts/modelica/property-build.log\n' + log)
        FMU.write_bytes(built.read_bytes())
        add_notices(FMU)
    with zipfile.ZipFile(FMU) as archive:
        platforms = sorted({name.split('/')[1] for name in archive.namelist()
                            if name.startswith('binaries/') and len(name.split('/')) > 2})
    manifest = {**metadata(), 'model': 'OpenPWR.PropertyReferenceChecks',
                'compiler': compiler, 'modelicaLibrary': '4.0.0', 'fmiVersion': '2.0',
                'fmuSha256': sha(FMU), 'platforms': platforms}
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')


def verify():
    from fmpy import extract, read_model_description
    from fmpy.fmi2 import FMU2Slave
    manifest = json.loads(MANIFEST.read_text())
    if manifest.get('sourceSha256') != sha(SOURCE) or manifest.get('fmuSha256') != sha(FMU):
        raise RuntimeError('Property FMU is stale or modified. Rebuild with --build.')
    description = read_model_description(str(FMU), validate=True)
    refs = {item.name: item.valueReference for item in description.modelVariables}
    values = {}
    with tempfile.TemporaryDirectory(prefix='openpwr-property-run-') as work:
        extract(str(FMU), unzipdir=work)
        unit = FMU2Slave(guid=description.guid, unzipDirectory=work,
                        modelIdentifier=description.coSimulation.modelIdentifier,
                        instanceName='published-property-checks')
        unit.instantiate()
        try:
            unit.setupExperiment(startTime=0)
            unit.enterInitializationMode()
            unit.exitInitializationMode()
            for temperature, _, _, _ in REFERENCES:
                names = [f'pressure{temperature}MPa', f'liquidEnthalpy{temperature}KJkg', f'vaporEnthalpy{temperature}KJkg']
                values[temperature] = unit.getReal([refs[name] for name in names])
            unit.terminate()
        finally:
            unit.freeInstance()
    checks = []
    for temperature, pressure, liquid, vapor in REFERENCES:
        for index, (name, expected, units) in enumerate([
                ('pressure', pressure, 'MPa'), ('liquid enthalpy', liquid, 'kJ/kg'), ('vapor enthalpy', vapor, 'kJ/kg')]):
            measured = values[temperature][index]
            error = abs(measured - expected)
            tolerance = abs(expected) * .0005
            checks.append({'name': f'Native MSL {name} at {temperature} C',
                           'category': 'published-water-property', 'measured': measured, 'reference': expected,
                           'absoluteError': error, 'relativeError': error / abs(expected),
                           'tolerance': tolerance, 'units': units, 'pass': error <= tolerance,
                           'source': {**NIST_SOURCE, 'table': f'Table 1, {temperature} C row'}})
    passed = sum(item['pass'] for item in checks)
    report = {**metadata(), 'model': manifest['model'], 'compiler': manifest['compiler'],
              'modelicaLibrary': manifest['modelicaLibrary'], 'fmuSha256': sha(FMU),
              'scope': 'Published pure-water property comparisons through a compiled native Modelica Standard Library IF97 FMU. These do not validate the primary-loop/pressurizer transients or the whole plant.',
              'passed': passed, 'total': len(checks), 'checks': checks}
    (OUTPUT / 'property-verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    for item in checks:
        print(('PASS' if item['pass'] else 'FAIL') + ' ' + item['name'] + f": {item['measured']:.9g} {item['units']}; reference {item['reference']}")
    print(f'{passed}/{len(checks)} published native property checks passed.')
    if passed != len(checks):
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='Compile a fresh property-check FMU first')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.build:
        build()
    verify()
