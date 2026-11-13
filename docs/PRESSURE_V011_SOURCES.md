# Pressure-model source audit for v0.11

This audit supports mechanism selection and explicit reference parameters. It is not an accuracy certificate. Krško's measured pressure remains a comparison output; it must not become a forcing signal or an undisclosed parameter-fitting target. Numerical conservation and convergence are separate from agreement with plant measurements. The machine-readable record, including source-file SHA-256 hashes, is [source-audit.json](../validation/krsko_pressure/source-audit.json).

## Krško event evidence

[NUREG/IA-0221](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf), printed p27/PDF39, describes pressure rising until spray action and the subsequent reduction in the pretrip rise. This supports including spray condensation, but supplies neither an event spray-flow history nor numerical spray-controller settings. Table 2, printed p13/PDF25, supplies initial pressure, temperature, power and indicated level. Figures 30(a), 31(a) and 32(a), PDF50–52, show indicated level and charging/letdown in L/s. Their meter reference conditions and injection enthalpies are not established here. The existing pretrip window and digitized measurements retain their provenance in [krsko2005](../validation/krsko2005/).

The prior experimental two-temperature replay matches the initial rise more closely than its aggregate error suggests: at 5 s, 15.689820 MPa predicted versus 15.696355 MPa measured; by 15 s, 17.140239 versus 15.939636 MPa. These are existing v0.6 results, not new validation. Missing heat removal is a plausible explanation for the late excess; the pressure trace alone cannot identify spray, wall, mixing and geometry effects separately.

## Event-era control model

[NUREG/IA-0227](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS124574/pdf/GOVPUB-Y3_N88-PURL-LPS124574.pdf), printed p3/PDF17, identifies the uprated master-deck configuration after September 2004. Figure 16, printed p24/PDF38, gives reference pressure 15.51 MPa and heater capacities 230 kW proportional plus 770 kW backup. It shows PI compensation and a spray-valve relation without numerical gains or breakpoints. These are published model specifications, not recorded April 2005 commands.

Printed p25/PDF39 explains that indicated level comes from differential pressure with temperature-dependent calibration. Therefore the initial 52.95% indication is not sufficient to establish liquid volume fraction. The [current operator description](https://www.nek.si/kako-deluje-nek/primarni-krog/tlacnik) independently reports 1 MW total heater capacity; it does not establish the event's heater history.

## Doel-4: independent generic wall reference

[NUREG/IA-0020](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-gpo72991/pdf/GOVPUB-Y3_N88-PURL-gpo72991.pdf) contains explicit RELAP5 wall inputs. They can anchor an unfitted **Doel-derived generic reference**, not a claim about Krško construction.

| Quantity | Published value | Locator |
| --- | --- | --- |
| Actual pressurizer volume | 46.5 m³ | Table 4.6, PDF41 |
| Sum of modeled hydrodynamic volumes | 45.12397 m³ | Table 4.6, PDF41 |
| Barrel flow area | 3.535 m² | Table 4.6, PDF41 |
| Barrel wall radii | 1.063825, 1.102225, 1.140625, 1.179025 m | Heat structure 4102, listing p93/PDF177 |
| Derived barrel thickness | 0.1152 m | Outer minus inner radius |
| Barrel axial sections | 0.7, 1.464, 3, 3, 3, 0.7 m | Listing p94/PDF178 |
| Wall conductivity | 46.05 W/(m K) | Composition 5, listing p97/PDF181 |
| Wall volumetric heat capacity | 3,877,500 J/(m³ K) | Composition 5, listing p97/PDF181 |

Do not relabel volumetric heat capacity as specific heat. No separate density, specific heat, alloy identification or specimen measurement is asserted from these entries. The wall radius implies a slightly different area from the hydrodynamic table; the two representations must not be silently forced to agree. Transferring the geometry, scaling dimensions, replacing the heads by a cylinder, choosing initial wall temperatures or suppressing ambient losses are additional model assumptions and belong in the implementation ledger.

The Doel spray test is only a candidate conditional comparison. Initial conditions appear on printed p12/PDF24; measured pressures 152.49 and 147.27 bar at 60 and 120 s appear on printed p26/PDF48. That page separately gives a **calculated** spray flow of 20.67 kg/s at 732.32 kg/m³, corresponding to about 101.5 m³/h, versus nominal design flow 102 m³/h. Converting 102 m³/h at that density instead gives 20.7491 kg/s. Adopting the calculated operating flow as a generic maximum is an additional assumption. Actual spray flow was unobserved, charging/letdown were unrecorded, and the test procedure's approximately 30 s valve opening differs from the simulation's 10 s opening. Its 3% recorder uncertainty is not defined here as an absolute-pressure confidence interval. Do not promote the code-calculated spray flow or efficiency to measurements.

## Independent insurge physics and future component data

[Kim's 1984 MIT thesis](https://dspace.mit.edu/entities/publication/724f0207-2255-4f6f-9134-cc744248b62a), printed pp52–55, supports wall conduction/film condensation and stratification during partly filled insurge. It does not establish a universal bulk-equilibration time. Figure 3.2/p24 gives ID 7⅝ in, OD 8⅝ in and height 45 in; p22 rounds the ID to 8 in.

Appendix A/p97 gives initial 101.0 psia, water level 13.9 in, final level 34.0 in and inlet 75°F. Figure A.1/p98 is a measured flow history; A.2/p99 is measured pressure. Before using them, resolve the negative flow indication outside insurge, map the initial thermal state and heat-loss boundary, and document digitization and instrument uncertainty. The source flags double spikes from a data-acquisition error. This audit adds no fabricated actuator series and claims no completed MIT comparison. The copyrighted thesis is referenced, not redistributed.

## Interpretation required for release

Use independent material/geometry values without selecting them by Krško pressure error. Any sensitivity chosen after inspecting that error must be described as calibration or exploratory analysis. A lower error on the existing event establishes case-specific improvement under the declared boundaries; it does not validate unknown spray actuation, startup criticality, turbine synchronization or full plant scope. The missing Krško records remain event-era pressurizer geometry and level calibration, spray/heater histories, charging/letdown reference states, wall construction and initial temperature distribution.
