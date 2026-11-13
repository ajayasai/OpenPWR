"""Verify native export capabilities without changing executable payloads."""
# SPDX-License-Identifier: Apache-2.0
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/modelica'))
from package_fmu import normalize_combined_export


class CombinedExportTests(unittest.TestCase):
    def test_declares_no_output_derivatives_and_preserves_other_payloads(self):
        xml = b'''<?xml version="1.0"?><fmiModelDescription fmiVersion="2.0" modelName="Fixture">
          <ModelExchange modelIdentifier="fixture"/>
          <CoSimulation modelIdentifier="fixture" maxOutputDerivativeOrder="1" canHandleVariableCommunicationStepSize="true"/>
          <ModelVariables/><ModelStructure/>
        </fmiModelDescription>'''
        payloads = {'binaries/linux64/fixture.so': b'unchanged native binary\x00\xff',
                    'sources/model.c': b'unchanged generated source', 'resources/table.txt': b'1 2 3'}
        with TemporaryDirectory() as directory:
            fmu = Path(directory) / 'fixture.fmu'
            with zipfile.ZipFile(fmu, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('modelDescription.xml', xml)
                for name, contents in payloads.items(): archive.writestr(name, contents)
            metadata = normalize_combined_export(fmu)
            with zipfile.ZipFile(fmu) as archive:
                self.assertEqual(set(archive.namelist()), {'modelDescription.xml', *payloads})
                for name, contents in payloads.items(): self.assertEqual(archive.read(name), contents)
                description = ET.fromstring(archive.read('modelDescription.xml'))
                simulation = description.find('CoSimulation')
                self.assertEqual(simulation.get('maxOutputDerivativeOrder'), '0')
                self.assertEqual(simulation.get('canHandleVariableCommunicationStepSize'), 'true')
                self.assertIsNotNone(description.find('ModelExchange'))
            self.assertEqual(metadata, {'exportInterfaces': ['ModelExchange', 'CoSimulation'], 'maximumOutputDerivativeOrder': 0})
            first = fmu.read_bytes()
            normalize_combined_export(fmu)
            self.assertEqual(fmu.read_bytes(), first)

    def test_does_not_relabel_an_unexpected_export(self):
        for content in ('<CoSimulation modelIdentifier="fixture"/>',
                        '<ModelExchange modelIdentifier="other"/><CoSimulation modelIdentifier="fixture"/>'):
            with self.subTest(content=content), TemporaryDirectory() as directory:
                fmu = Path(directory) / 'unexpected.fmu'
                with zipfile.ZipFile(fmu, 'w') as archive:
                    archive.writestr('modelDescription.xml', f'<fmiModelDescription fmiVersion="2.0">{content}</fmiModelDescription>')
                before = fmu.read_bytes()
                with self.assertRaises(ValueError): normalize_combined_export(fmu)
                self.assertEqual(fmu.read_bytes(), before)


if __name__ == '__main__': unittest.main()
