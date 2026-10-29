"""Check cold-source discontinuities without relying on cached FMI fluxes."""
# SPDX-License-Identifier: Apache-2.0
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.verify_cold import boundary_flux, constant_inputs


def physical_state():
    # Synthetic endpoint, deliberately carrying nonsensical stale derived
    # outputs. Only physical state and thermodynamic primitives may be used.
    return {'primaryPressureMPa': .301325, 'pressurizerLevelPercent': 50,
        'pressurizerGasMassKg': 9, 'pressurizerVaporMassKg': 1,
        'pressurizerSteamEnthalpyJkg': 2_500_000, 'pressurizerTemperatureC': 40,
        'secondaryPressureMPa': .101325, 'secondaryGasMassKg': 9, 'secondaryVaporMassKg': 1,
        'secondarySteamEnthalpyJkg': 2_500_000, 'secondaryTemperatureC': 40,
        'pumpSpeed': 0, 'coldLegTemperatureC': 40, 'chargingEnthalpyJkg': 170_000,
        'coldLegEnthalpyJkg': 190_000, 'plantBoundaryPowerMW': 123456,
        'plantBoundaryMassFlowKgS': -98765, 'actualHeaterPowerMW': -100,
        'actualChargingFlowKgS': 1000, 'actualLetdownFlowKgS': 1000,
        'ventSteamFlowKgS': 1000, 'ventGasFlowKgS': 1000, 'shutdownCoolingMW': -1000}


class HeldColdBoundary(unittest.TestCase):
    def test_heat_and_cooling_jump_use_current_command_at_both_endpoints(self):
        point = physical_state()
        closed = constant_inputs()(0)
        self.assertEqual(boundary_flux(closed, point), (0, 0))
        new = {**closed, 'startupHeatMW': 15, 'heaterPowerMW': 3, 'shutdownCoolingFraction': 1,
            'pumpCommand': 1}
        # Commanding the pump does not instantaneously change its state/work.
        # 15 MW fuel + 3 MW heater - .5 MW/K * (40-30) K cooling = 13 MW.
        self.assertEqual(boundary_flux(new, point), (13, 0))
        held_integral = .5 * 5 * (boundary_flux(new, point)[0] + boundary_flux(new, point)[0])
        self.assertEqual(held_integral, 65)

    def test_vent_jump_removes_mixture_mass_and_flow_enthalpy(self):
        point = physical_state()
        controls = constant_inputs(ventFraction=1)(0)
        # At exactly .2 MPa differential this fixture vents .5 kg/s;
        # 90% nitrogen and 10% steam by mass, with each flow enthalpy.
        energy, mass = boundary_flux(controls, point)
        expected_power = -(.45 * 1040 * 313.15 + .05 * 2_500_000) / 1e6
        self.assertAlmostEqual(mass, -.5)
        self.assertAlmostEqual(energy, expected_power)
        self.assertEqual(boundary_flux({**controls, 'ventFraction': 0}, point), (0, 0))

    def test_upstream_enthalpy_of_charging_and_letdown_is_kept_distinct(self):
        energy, mass = boundary_flux(constant_inputs(chargingFlowKgS=5, letdownFlowKgS=3)(0), physical_state())
        self.assertEqual(mass, 2)
        self.assertAlmostEqual(energy, (5 * 170_000 - 3 * 190_000) / 1e6)


if __name__ == '__main__':
    unittest.main()
