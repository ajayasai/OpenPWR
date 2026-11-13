"""Boundary oracle tests: discontinuous commands and stale aggregate outputs."""
# SPDX-License-Identifier: Apache-2.0
import unittest

from backend.verify_continuous import boundary_flux, constant_inputs, declared_schedule, startup_inputs
from backend.profiles import CONTINUOUS_CONTROL_LIMITS
from validation.tests.test_cold_quadrature import physical_state


def continuous_state():
    return {**physical_state(), 'neutronPowerFraction':0, 'decayHeatMW':0,
        'feedwaterFlowKgS':0, 'feedwaterEnthalpyJkg':180_000,
        'condenserLiquidEnthalpyJkg':170_000, 'condenserTemperatureC':15,
        'turbineRpm':0, 'generatorVoltagePu':0, 'phaseDifferenceDeg':0,
        'gridConnected':0, 'reactorTripped':0, 'condenserDisplacementPowerMW':0,
        'feedPumpPowerMW':-123456, 'coolingPowerMW':-123456,
        'shaftFrictionMW':-123456, 'grossPowerMW':123456, 'generatorLossMW':123456}


class ContinuousBoundaryTests(unittest.TestCase):
    def test_demand_does_not_prescribe_heat_or_reset_physical_states(self):
        point=continuous_state()
        self.assertEqual(boundary_flux(constant_inputs()(0),point),(0,0))
        controls=constant_inputs(reactorDemandPercent=100,automaticReactorEnable=1,turbineEnable=1,loadDemandMW=1000)(0)
        self.assertEqual(boundary_flux(controls,point),(0,0))
        point.update(neutronPowerFraction=.1,decayHeatMW=2)
        self.assertAlmostEqual(boundary_flux(controls,point)[0],282.2)

    def test_pump_work_and_heat_rejection_use_primitives_and_current_cooling_command(self):
        point=continuous_state()
        point.update(feedwaterFlowKgS=100,condenserTemperatureC=25)
        controls=constant_inputs(coolingFraction=0)(0)
        self.assertEqual(boundary_flux(controls,point),(1,0))
        controls['coolingFraction']=1
        self.assertEqual(boundary_flux(controls,point),(-1999,0))

    def test_breaker_opening_does_not_integrate_stale_electrical_work(self):
        point=continuous_state()
        point.update(turbineRpm=3000,generatorVoltagePu=1,phaseDifferenceDeg=30,gridConnected=1)
        connected=constant_inputs(gridBreakerCommand=1)(0)
        self.assertAlmostEqual(boundary_flux(connected,point)[0],-1502)
        for changes in ({'tripCommand':1},{'turbineTripCommand':1},{'gridBreakerCommand':0}):
            self.assertEqual(boundary_flux({**connected,**changes},point),(-2,0))

    def test_independent_forcing_matches_declared_schedule_and_input_domain(self):
        self.assertEqual(len(declared_schedule()),7)
        self.assertEqual(len(declared_schedule(trip=True)),8)
        for seconds in (0,3599.75,3600,7199.75,7200,17999.75,18000,20000,22000,24000,27000):
            controls=startup_inputs(seconds)
            self.assertEqual(set(controls),set(CONTINUOUS_CONTROL_LIMITS))
            for name,value in controls.items():
                lower,upper=CONTINUOUS_CONTROL_LIMITS[name]
                self.assertTrue(lower<=value<=upper,(name,seconds))
        self.assertEqual(startup_inputs(18000)['sourceEnable'],0)


if __name__ == '__main__': unittest.main()
