# SPDX-License-Identifier: Apache-2.0
"""Retain source and dependency notices in each redistributable native FMU."""
from pathlib import Path
import tempfile
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]


def normalize_combined_export(fmu_path):
    """Declare the actual capabilities of our OpenModelica me_cs export.

    Combined export omits optional real-output derivative equations. OpenModelica
    1.27.1 nevertheless advertises derivative order one; consumers must see zero.
    Native binaries and all other archive members are retained byte-for-byte.
    """
    fmu_path = Path(fmu_path)
    temporary = None
    try:
        with zipfile.ZipFile(fmu_path) as source:
            members = source.infolist()
            if len({member.filename for member in members}) != len(members):
                raise ValueError('FMU contains duplicate archive members.')
            description = ET.fromstring(source.read('modelDescription.xml'))
            exchange, simulation = description.find('ModelExchange'), description.find('CoSimulation')
            if description.get('fmiVersion') != '2.0' or exchange is None or simulation is None:
                raise ValueError('Expected an FMI 2.0 combined ModelExchange/CoSimulation export.')
            if exchange.get('modelIdentifier') != simulation.get('modelIdentifier'):
                raise ValueError('Combined FMI interfaces identify different native models.')
            simulation.set('maxOutputDerivativeOrder', '0')
            xml = ET.tostring(description, encoding='utf-8', xml_declaration=True)
            with tempfile.NamedTemporaryFile(prefix=fmu_path.stem+'-', suffix='.fmu', dir=fmu_path.parent, delete=False) as stream:
                temporary = Path(stream.name)
            with zipfile.ZipFile(temporary, 'w') as destination:
                for member in members:
                    destination.writestr(member, xml if member.filename == 'modelDescription.xml' else source.read(member))
        temporary.replace(fmu_path)
        return {'exportInterfaces': ['ModelExchange', 'CoSimulation'], 'maximumOutputDerivativeOrder': 0}
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def prepare_fmu(fmu_path):
    metadata = normalize_combined_export(fmu_path)
    add_notices(fmu_path)
    return metadata


def add_notices(fmu_path):
    notice_root = ROOT / 'models/licenses'
    notices = sorted(path for path in notice_root.rglob('*') if path.is_file())
    if not notices:
        raise RuntimeError('Native dependency notices are missing; refusing to package the FMU.')
    with zipfile.ZipFile(fmu_path, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
        for notice in notices:
            archive.write(notice, 'documentation/licenses/' + notice.relative_to(notice_root).as_posix())
        archive.write(ROOT / 'LICENSE', 'documentation/licenses/OpenPWR-Apache-2.0.txt')
        archive.write(ROOT / 'NOTICE', 'documentation/licenses/OpenPWR-NOTICE.txt')
        archive.write(ROOT / 'models/OpenPWR/package.mo', 'sources/OpenPWR/package.mo')
