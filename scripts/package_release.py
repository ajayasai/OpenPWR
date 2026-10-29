"""Package a clean, verified native release and its portable web evidence.

Run after downloading the successful CI artifact for this exact commit. This
command reruns the strict publication gate, verifies source bytes against Git,
then packages source, 11 FMUs, their manifests and six evidence reports.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COMPILED = (
    ('PrimaryLoop', 'manifest.json'), ('PropertyReferenceChecks', 'property-manifest.json'),
    ('CoupledPlant', 'plant-manifest.json'), ('ColdStartPlant', 'cold-manifest.json'),
    ('KineticsReference', 'kinetics-manifest.json'), ('KrskoTransient', 'krsko-manifest.json'),
    ('KrskoEquilibrium', 'krsko-equilibrium-manifest.json'), ('PactelPressurizer', 'pactel-manifest.json'),
    ('PactelCoarse', 'pactel-coarse-manifest.json'), ('PactelRadialRefined', 'pactel-radial-manifest.json'),
    ('PactelSpatialRefined', 'pactel-spatial-manifest.json'))
REPORTS = (
    ('artifacts/modelica-verification.json', 'PrimaryLoop', 'engineering-verification.json'),
    ('artifacts/modelica/property-verification.json', 'PropertyReferenceChecks', 'modelica-property-verification.json'),
    ('artifacts/plant-verification.json', 'CoupledPlant', 'plant-verification.json'),
    ('artifacts/cold-verification.json', 'ColdStartPlant', 'cold-verification.json'),
    ('artifacts/measured-validation.json', 'KrskoTransient', 'measured-validation.json'),
    ('artifacts/pressurizer-validation.json', 'PactelPressurizer', 'pressurizer-validation.json'))
COLD_SOURCES = {'coldSourceSha256': 'models/ColdStartPlant.mo', 'verificationScriptSha256': 'backend/verify_cold.py',
    'sharedRunnerSha256': 'validation/native_fmi.py', 'hostScriptSha256': 'backend/fmi_host.py',
    'profileScriptSha256': 'backend/profiles.py'}
PACTEL_SOURCES = {key: 'validation/pactel1998/' + name for key, name in (
    ('holdoutDataSha256', 'holdout-measured.csv'), ('holdoutMetadataSha256', 'holdout-provenance.json'),
    ('holdoutComparatorSha256', 'holdout_compare.py'), ('holdoutExtractorSha256', 'holdout_extract.py'),
    ('holdoutProtocolSha256', 'holdout-protocol.json'), ('holdoutFreezeSha256', 'holdout-freeze.json'),
    ('developmentComparatorSha256', 'post_unblinding_compare.py'))}
PACTEL_SOURCES['v07BaselineSha256'] = 'validation/baselines/pressurizer-v0.7.json'


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def clean_identity():
    require(not git('status', '--porcelain').strip(), 'Release packaging requires a clean source checkout.')
    return read(ROOT / 'package.json')['version'], git('rev-parse', 'HEAD').decode().strip()


def check_identity(identity, version, revision, label):
    require(identity.get('version') == version and identity.get('gitRevision') == revision,
        f'{label}: different version or source revision')
    require(identity.get('dirty', identity.get('gitDirty')) is False, f'{label}: source was not clean at execution/build')


def bound_sources(manifest, sources, label):
    for key, name in sources.items():
        actual = sha(ROOT / name)
        require(manifest.get(key) == actual, f'{label}: stale {key}')
        committed = hashlib.sha256(git('show', f'HEAD:{name}')).hexdigest()
        require(committed == actual, f'{name}: working bytes differ from the archived Git source')


def comparison_sources(case, model):
    return {'sourceSha256': 'models/OpenPWR/package.mo', 'benchmarkModelSha256': f'models/{model}.mo',
        'inputDataSha256': f'validation/{case}/measured.csv', 'referenceMetadataSha256': f'validation/{case}/provenance.json',
        'comparisonScriptSha256': f'validation/{case}/compare.py', 'sharedRunnerSha256': 'validation/native_fmi.py'}


def verify(version, revision):
    subprocess.run(['node', 'scripts/build.mjs', '--require-native', '--require-plant', '--require-cold',
        '--require-measured', '--require-pressurizer'], cwd=ROOT, check=True)
    manifests = {}
    for model, manifest_name in COMPILED:
        manifest = read(ROOT / 'artifacts/modelica' / manifest_name)
        check_identity(manifest, version, revision, manifest_name)
        fmu = ROOT / 'artifacts/modelica' / f'{model}.fmu'
        require(manifest.get('fmuSha256') == sha(fmu), f'{model}: binary differs from its manifest')
        require(manifest.get('model') == ('ColdStartPlant' if model == 'ColdStartPlant' else f'OpenPWR.{model}'),
            f'{model}: wrong native model')
        with zipfile.ZipFile(fmu) as archive:
            require(any(name.startswith(('binaries/linux64/', 'binaries/x86_64-linux/')) and name.endswith('.so')
                for name in archive.namelist()), f'{model}: no Linux x86-64 executable in FMU')
        bound_sources(manifest, {'sourceSha256': 'models/OpenPWR/package.mo'}, model)
        manifests[model] = manifest
    bound_sources(manifests['ColdStartPlant'], COLD_SOURCES, 'ColdStartPlant')
    for model in ('KrskoTransient', 'KrskoEquilibrium'):
        sources = comparison_sources('krsko2005', 'KrskoTransient')
        sources.update(parameterSourcesSha256='validation/krsko2005/reference-plant.json', baselineSha256='validation/baselines/krsko-v0.5.json')
        bound_sources(manifests[model], sources, model)
    for model in ('PactelPressurizer', 'PactelCoarse', 'PactelRadialRefined', 'PactelSpatialRefined'):
        bound_sources(manifests[model], {**comparison_sources('pactel1998', 'PactelPressurizer'), **PACTEL_SOURCES}, model)
    reports = {}
    for path, model, web_name in REPORTS:
        report = read(ROOT / path)
        check_identity(report, version, revision, path)
        reported_fmu = report.get('fmuSha256', report.get('runtime', {}).get('fmuSha256'))
        require(reported_fmu == manifests[model]['fmuSha256'], f'{path}: wrong executed binary')
        require(sha(ROOT / path) == sha(ROOT / 'dist' / web_name), f'{path}: web evidence differs from release evidence')
        reports[model] = report
    require(reports['CoupledPlant']['kineticsManifest']['fmuSha256'] == manifests['KineticsReference']['fmuSha256'], 'Kinetics reference differs')
    require(reports['KrskoTransient']['equilibriumComparison']['runtime']['fmuSha256'] == manifests['KrskoEquilibrium']['fmuSha256'], 'Krško equilibrium runtime differs')
    held = reports['PactelPressurizer']['holdoutComparison']
    require(held['comparisonRole'] == 'post-unblinding-development' and held['heldOutFromCurrentDevelopment'] is False,
        'Disclosed ATWS-11 response was incorrectly presented as a renewed holdout')
    require(held['runtime']['fmuSha256'] == manifests['PactelPressurizer']['fmuSha256'], 'ATWS-11 runtime differs')
    for record in reports['PactelPressurizer']['spatialComparisons']:
        model = record['runtime']['model'].split('.')[-1]
        require(record['runtime']['fmuSha256'] == manifests[model]['fmuSha256'], f'{model}: mesh runtime differs')
    require(clean_identity() == (version, revision), 'Source changed during release verification')


def archive_bytes(archive, name, data, timestamp):
    info = zipfile.ZipInfo(name, timestamp)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    archive.writestr(info, data)


def native_readme(version, revision):
    return f'''# OpenPWR {version} native Linux release

Complete source at {revision}, eleven Linux x86-64 FMUs, source/binary manifests,
six evidence reports, measured comparison data and upstream notices.

The native cold model covers generic cold-to-hot-standby heatup and shutdown
cooling. It is a separate continuous thermodynamic experiment with prescribed
fuel heat. It does not simulate reactor criticality, synchronize a generator or
transfer its state into the hot coupled-plant FMU. The hot plant retains its
separate equilibrium pressurizer. The experimental two-temperature pressurizer
is used by the measured reference cases. None is a qualified full-scope plant
simulator. Measured discrepancies and the exact v0.7 baseline remain visible.
ATWS-11 is now a post-unblinding development comparison, not a renewed holdout.

Install the open-source toolchain in docs/ENGINEERING.md. Run:

    npm run engineering:setup
    npm run engineering:test
    npm run engineering:verify
    npm run engineering:plant:verify
    npm run engineering:cold:verify
    npm run engineering:measured
    npm run engineering:pressurizer
    npm run engineering:cold:start

Open http://127.0.0.1:8003/startup.html for the native cold model. For the hot
plant use npm run engineering:plant:start and http://127.0.0.1:8002/plant.html.
For the primary workbench use npm run engineering:start and port 8001.
On Windows use Ubuntu WSL and npm run engineering:setup -- --wsl. The prebuilt
FMUs run under Linux. To rebuild use npm run engineering:build followed by
npm run engineering:measured -- --build and npm run engineering:pressurizer -- --build.

Original source is Apache-2.0. Upstream notices are in models/licenses and
inside each FMU. The web archive contains the interface and portable evidence;
native interactive models require the local service.
'''


def package(version, revision):
    out = ROOT / f'artifacts/release-v{version}'
    out.mkdir(parents=True, exist_ok=True)
    prefix = f'OpenPWR-v{version}/'
    native = out / f'OpenPWR-v{version}-engineering-linux64.zip'
    web = out / f'OpenPWR-v{version}-web.zip'
    committed_time = datetime.fromtimestamp(int(git('show', '-s', '--format=%ct', 'HEAD')), timezone.utc)
    timestamp = committed_time.timetuple()[:6]
    require(timestamp[0] >= 1980, 'Commit timestamp is outside the ZIP time range')
    subprocess.run(['git', 'archive', '--format=zip', f'--prefix={prefix}', f'--output={native}', 'HEAD'], cwd=ROOT, check=True)
    with zipfile.ZipFile(native, 'a') as archive:
        for model, manifest_name in COMPILED:
            for name in (f'{model}.fmu', manifest_name):
                path = ROOT / 'artifacts/modelica' / name
                archive_bytes(archive, prefix + path.relative_to(ROOT).as_posix(), path.read_bytes(), timestamp)
        for path, _, _ in REPORTS:
            archive_bytes(archive, prefix + path, (ROOT / path).read_bytes(), timestamp)
        archive_bytes(archive, prefix + 'PREBUILT_NATIVE.md', native_readme(version, revision).encode(), timestamp)
    with zipfile.ZipFile(web, 'w') as archive:
        for path in sorted((ROOT / 'dist').rglob('*')):
            if path.is_file():
                archive_bytes(archive, path.relative_to(ROOT / 'dist').as_posix(), path.read_bytes(), timestamp)
    assets = [native, web]
    for path, _, _ in REPORTS:
        destination = out / Path(path).name
        shutil.copyfile(ROOT / path, destination)
        assets.append(destination)
    checksums = out / 'SHA256SUMS'
    checksums.write_text(''.join(f'{sha(path)}  {path.name}\n' for path in assets), encoding='utf-8', newline='\n')
    assets.append(checksums)
    return {'revision': revision, 'version': version,
        'assets': [{'name': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path)} for path in assets]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only', action='store_true', help='Verify all release inputs without creating archives.')
    args = parser.parse_args()
    version, revision = clean_identity()
    verify(version, revision)
    result = {'version': version, 'revision': revision, 'verified': True} if args.check_only else package(version, revision)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
