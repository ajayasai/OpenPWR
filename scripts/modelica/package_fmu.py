# SPDX-License-Identifier: Apache-2.0
"""Retain source and dependency notices in each redistributable native FMU."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]


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
