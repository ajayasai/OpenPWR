# SPDX-License-Identifier: Apache-2.0
"""Compare native MSL IF97 with published NIST/IAPWS tables and differential identities."""
import argparse
import hashlib
import json
import math
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
IAPWS_SOURCE = {
    'title': 'IAPWS R7-97(2012), Revised Release on IAPWS-IF97',
    'url': 'https://iapws.org/technical-guidance/release/IF97-Rev.download',
    'table': 'Table 5, page 9: Region 1 computer-program verification',
}
# Literal Table 5 values, independently transcribed from the IAPWS release.
# p/MPa, T/K, v/(m3/kg), h/(kJ/kg), u/(kJ/kg), cp/(kJ/(kg K)).
REGION1_REFERENCES = [
    (3, 300, .00100215168, 115.331273, 112.324818, 4.17301218),
    (80, 300, .000971180894, 184.142828, 106.448356, 4.01008987),
    (3, 500, .00120241800, 975.542239, 971.934985, 4.65580682),
]
PROBE_OUTPUTS = ('probeDensityKgM3', 'probeSpecificVolumeM3Kg', 'probeEnthalpyKJkg',
                 'probeInternalEnergyKJkg', 'probeCpKJkgK', 'probeExpansionPerK',
                 'probeCompressibilityPerPa')
WALL_OUTPUTS = ('wallSteelCpJKgK', 'wallSteelEnthalpyJKg', 'wallSteelConductivityPotentialWM',
                'wallConstantCpJKgK', 'wallConstantEnthalpyJKg', 'wallConstantConductivityPotentialWM')
STEEL_SOURCE = {'title': 'NISTIR 7401, section 3.1.1 and Figure 1, printed page 7',
                'url': 'https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=860705',
                'scope': 'Published AISI 304 material correlations; consistency checks are not independent material measurements.'}


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
    checks = []
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

            def probe(pressure, temperature):
                unit.setReal([refs['probePressurePa'], refs['probeTemperatureK']], [pressure, temperature])
                return dict(zip(PROBE_OUTPUTS, unit.getReal([refs[name] for name in PROBE_OUTPUTS])))

            for pressure, temperature, volume, enthalpy, internal, cp in REGION1_REFERENCES:
                actual = probe(pressure * 1e6, temperature)
                for output, label, reference, units in [
                        ('probeSpecificVolumeM3Kg', 'specific volume', volume, 'm3/kg'),
                        ('probeEnthalpyKJkg', 'enthalpy', enthalpy, 'kJ/kg'),
                        ('probeInternalEnergyKJkg', 'internal energy', internal, 'kJ/kg'),
                        ('probeCpKJkgK', 'isobaric heat capacity', cp, 'kJ/(kg K)')]:
                    measured = actual[output]
                    error = abs(measured - reference)
                    # 1e-8 relative allows the last printed digit of the nine-digit table.
                    tolerance = abs(reference) * 1e-8
                    checks.append({'name': f'Native IF97 region 1 {label}, {pressure} MPa / {temperature} K',
                                   'category': 'published-water-property', 'measured': measured,
                                   'reference': reference, 'absoluteError': error,
                                   'relativeError': error / abs(reference), 'tolerance': tolerance,
                                   'units': units, 'pass': error <= tolerance, 'source': IAPWS_SOURCE})

            # These are consistency checks, explicitly separate from published comparisons.
            # Central differences observe independent nearby property calls through FMI.
            # The analytical expressions are the exact thermodynamic identities used by
            # PrimaryLoop and DynamicPressurizer's inventory derivatives. The
            # p,T medium automatically selects IF97 region 2 for the three
            # superheated-steam states, including the high-pressure B23 side.
            states = [(p * 1e6, t) for p, t, *_ in REGION1_REFERENCES] + [
                (15.5e6, 563.15), (15.5e6, 598.15),
                (6e6, 552), (15.5e6, 625), (18e6, 650)]
            for pressure, temperature in states:
                center = probe(pressure, temperature)
                dp, dt = 100.0, .002
                pplus, pminus = probe(pressure + dp, temperature), probe(pressure - dp, temperature)
                tplus, tminus = probe(pressure, temperature + dt), probe(pressure, temperature - dt)
                rho, alpha, kappa = center['probeDensityKgM3'], center['probeExpansionPerK'], center['probeCompressibilityPerPa']
                cp = 1000 * center['probeCpKJkgK']
                comparisons = [
                    ('density pressure derivative', (pplus['probeDensityKgM3'] - pminus['probeDensityKgM3']) / (2 * dp), rho * kappa, 'kg/(m3 Pa)'),
                    ('density temperature derivative', (tplus['probeDensityKgM3'] - tminus['probeDensityKgM3']) / (2 * dt), -rho * alpha, 'kg/(m3 K)'),
                    ('enthalpy temperature derivative', 1000 * (tplus['probeEnthalpyKJkg'] - tminus['probeEnthalpyKJkg']) / (2 * dt), cp, 'J/(kg K)'),
                    ('internal-energy pressure derivative', 1000 * (pplus['probeInternalEnergyKJkg'] - pminus['probeInternalEnergyKJkg']) / (2 * dp), (pressure * kappa - temperature * alpha) / rho, 'J/(kg Pa)'),
                    ('internal-energy temperature derivative', 1000 * (tplus['probeInternalEnergyKJkg'] - tminus['probeInternalEnergyKJkg']) / (2 * dt), cp - pressure * alpha / rho, 'J/(kg K)'),
                ]
                for label, measured, reference, units in comparisons:
                    error = abs(measured - reference)
                    tolerance = abs(reference) * 2e-6
                    checks.append({'name': f'Native {label}, {pressure / 1e6:g} MPa / {temperature:g} K',
                                   'category': 'thermodynamic-derivative-consistency', 'measured': measured,
                                   'reference': reference, 'absoluteError': error,
                                   'relativeError': error / abs(reference), 'tolerance': tolerance,
                                   'units': units, 'pass': error <= tolerance,
                                   'method': {'pressureDifferencePa': dp, 'temperatureDifferenceK': dt,
                                              'scheme': 'Central difference vs thermodynamic identity; not published validation'}})
            def wall_probe(temperature):
                unit.setReal([refs['probeWallTemperatureK']], [temperature])
                return dict(zip(WALL_OUTPUTS, unit.getReal([refs[name] for name in WALL_OUTPUTS])))

            def wall_check(label, actual, expected, units, method):
                error = abs(actual - expected)
                tolerance = max(1e-8, abs(expected) * 2e-7)
                checks.append({'name': label, 'category': 'wall-material-consistency',
                               'measured': actual, 'reference': expected, 'absoluteError': error,
                               'relativeError': error / max(abs(expected), 1e-12), 'tolerance': tolerance,
                               'units': units, 'pass': error <= tolerance, 'method': method,
                               'source': STEEL_SOURCE})

            for temperature in (300.0, 550.0, 1000.0):
                center = wall_probe(temperature)
                dt = .002
                plus, minus = wall_probe(temperature + dt), wall_probe(temperature - dt)
                for material, conductivity in [('Steel', 9.705 + .0176 * temperature - 1.60e-6 * temperature**2), ('Constant', 15.0)]:
                    wall_check(f'{material} wall enthalpy derivative at {temperature:g} K',
                               (plus[f'wall{material}EnthalpyJKg'] - minus[f'wall{material}EnthalpyJKg']) / (2 * dt),
                               center[f'wall{material}CpJKgK'], 'J/(kg K)',
                               'Central difference of compiled enthalpy vs compiled cp; not measured validation.')
                    wall_check(f'{material} wall conductivity-potential derivative at {temperature:g} K',
                               (plus[f'wall{material}ConductivityPotentialWM'] - minus[f'wall{material}ConductivityPotentialWM']) / (2 * dt),
                               conductivity, 'W/(m K)',
                               'Central difference of compiled Kirchhoff potential vs separately evaluated k(T).')

            # Composite Simpson quadrature checks the complete integral over useful
            # temperature intervals, independently of the closed-form primitive.
            for low, high in ((273.15, 300.0), (300.0, 550.0), (550.0, 1000.0)):
                count = 200
                width = (high - low) / count
                def integrate(function):
                    return width / 3 * sum((1 if i in (0, count) else 4 if i % 2 else 2) * function(low + i * width) for i in range(count + 1))
                left, right = wall_probe(low), wall_probe(high)
                wall_check(f'Steel wall enthalpy integral over {low:g}–{high:g} K',
                           right['wallSteelEnthalpyJKg'] - left['wallSteelEnthalpyJKg'],
                           integrate(lambda t: 6.683 + .04906 * t + 80.74 * math.log(t)), 'J/kg',
                           'Compiled primitive vs 200-panel Simpson quadrature of the published cp correlation.')
                wall_check(f'Steel wall conductivity integral over {low:g}–{high:g} K',
                           right['wallSteelConductivityPotentialWM'] - left['wallSteelConductivityPotentialWM'],
                           integrate(lambda t: 9.705 + .0176 * t - 1.60e-6 * t**2), 'W/m',
                           'Compiled Kirchhoff potential vs 200-panel Simpson quadrature of the published k correlation.')
            unit.terminate()
        finally:
            unit.freeInstance()
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
              'scope': 'Published pure-water property comparisons, separately labeled thermodynamic-derivative checks, and wall-material integral/derivative consistency through a compiled native FMU. These do not validate primary-loop/pressurizer transients, facility-specific steel properties or the whole plant.',
              'publishedComparisons': sum(c['category'] == 'published-water-property' for c in checks),
              'derivativeConsistencyChecks': sum(c['category'] == 'thermodynamic-derivative-consistency' for c in checks),
              'wallMaterialConsistencyChecks': sum(c['category'] == 'wall-material-consistency' for c in checks),
              'passed': passed, 'total': len(checks), 'checks': checks}
    (OUTPUT / 'property-verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    for item in checks:
        print(('PASS' if item['pass'] else 'FAIL') + ' ' + item['name'] + f": {item['measured']:.9g} {item['units']}; reference {item['reference']}")
    print(f'{passed}/{len(checks)} native property/derivative checks passed; '
          f"{report['publishedComparisons']} published water comparisons, {report['derivativeConsistencyChecks']} thermodynamic and {report['wallMaterialConsistencyChecks']} wall-material consistency checks.")
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
