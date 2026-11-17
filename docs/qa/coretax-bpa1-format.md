# Coretax BPA1 (PPh 21 A1) bulk XML: official format vs our code (legend-y6w4q)

Date: 2026-11-17. Code compared: `apps/api/src/lib/payroll-export/coretax-a1.ts` at `origin/ghostex/ba6c8a6b` (the card path `packages/shared/src/hris/payroll/coretax-a1.ts` does not exist on that ref; the real file is under `apps/api/src/lib/payroll-export/`).

## Sources

- DJP page (BPA1 row, converter + template): https://www.pajak.go.id/en/node/112031
- Official converter: https://pajak.go.id/sites/default/files/2024-12/BPA1%20Excel%20to%20XML.xlsx (last updated 7/11/2024, sheets DATA, BPA1, REF; embeds the XSD in xmlMaps.xml)
- Official XML template: https://pajak.go.id/sites/default/files/2024-12/bpa1.zip (contains `bpa1.xml`, two sample A1 rows)
- Both files were downloaded and unpacked; element list below comes from the embedded XSD and the REF sheet, not from secondary sources.
- Checked: DDTC 12 Sep 2025 converter update (https://news.ddtc.co.id/berita/nasional/1813503/perhatian-ada-update-format-converter-excel-xml-bupot) covers BPPU/BPSP/BPCY/DDBU only, not BPA1. No newer BPA1 file found on the DJP page.

## Official structure (XSD `xsd:sequence`, order is mandatory)

Root `A1Bulk` (xmlns:xsi) > `TIN` (string, 15-16 digits, must equal login NPWP) > `ListOfA1` > `A1` (1..n).

Inside each `A1`, in this order:
1. WorkForSecondEmployer (Yes|No)
2. TaxPeriodMonthStart (int; FullYear requires 1-12)
3. TaxPeriodMonthEnd (int)
4. TaxPeriodYear (int)
5. CounterpartOpt (Resident|Foreign)
6. CounterpartPassport (string, nillable, `xsi:nil="true"`)
7. CounterpartTin (NIK)
8. TaxExemptOpt (TK/0-3, K/0-3, HB/0-3)
9. StatusOfWithholding (FullYear|PartialYear|Annualized)
10. CounterpartPosition (string)
11. TaxObjectCode (21-100-01 pegawai tetap, 21-100-02 pensiunan, 21-100-32 daerah tertentu)
12. NumberOfMonths (int; 0 unless Annualized)
13. SalaryPensionJhtTht (decimal >= 0)
14. GrossUpOpt (Yes|No)
15. IncomeTaxBenefit (decimal >= 0; ignored when GrossUpOpt = Yes)
16. OtherBenefit
17. Honorarium
18. InsurancePaidByEmployer
19. Natura
20. TantiemBonusThr
21. PensionContributionJhtThtFee
22. Zakat
23. PrevWhTaxSlip (string, nillable)
24. TaxCertificate (N/A|DTP|ETC)
25. Article21IncomeTax (decimal >= 0; "PPh 21 yang telah dipotong pada BPMP")
26. IDPlaceOfBusinessActivity (22-digit NITKU, string)
27. WithholdingDate (xsd:date = YYYY-MM-DD; must not be earlier than the period)

Numbers: plain decimals, no separators, no currency (samples are integers). Dates: `YYYY-MM-DD`.

## Diff vs our code

Our code guessed the field list (its header says "Verify against the official A1 template"). Result:

| # | Difference | Severity |
|---|---|---|
| 1 | Missing required elements: WorkForSecondEmployer, TaxPeriodMonthStart, TaxPeriodMonthEnd, NumberOfMonths, GrossUpOpt, IncomeTaxBenefit, PrevWhTaxSlip, Article21IncomeTax. XSD has no minOccurs=0, so import will fail schema validation. | P1 |
| 2 | Wrong name `StatusTaxExemption`; official is `TaxExemptOpt`. | P1 |
| 3 | Wrong name `Position`; official is `CounterpartPosition`. | P1 |
| 4 | Order wrong: we emit Position before StatusOfWithholding (official: StatusOfWithholding, then CounterpartPosition) and TaxCertificate before TaxObjectCode and the amounts (official: TaxCertificate comes after Zakat/PrevWhTaxSlip). xsd:sequence requires the exact order above. | P1 |
| 5 | `Article21IncomeTax` (tax already withheld) absent. Needs the sealed PPh 21 withheld total from payslips (money field: needs founder/CTO sign-off on source of the number, never recomputed in the export). | P1 (money) |
| 6 | PTKP allow-list lacks HB/0-3 (official accepts them). Refusing is safe; note only. | P3 |
| 7 | `TaxObjectCode` hard-coded 21-100-01; pensioner (21-100-02) and daerah tertentu (21-100-32) unsupported. Fine for current scope, document it. | P3 |
| 8 | TIN: ours demands exactly 16 digits; official accepts 15-16. Stricter, safe. | none |
| 9 | Root/row names `A1Bulk`, `ListOfA1`, `A1`, `TIN`, `CounterpartOpt`, `CounterpartPassport` nil, `CounterpartTin`, the 8 shared amount names, `TaxCertificate` `N/A`, `IDPlaceOfBusinessActivity`, `WithholdingDate` and date/number formats are correct. | ok |
| 10 | We also model `Annualized` but never emit it; official then needs NumberOfMonths = months worked. OK while unused. | ok |

Also check the test `apps/api/src/test/payroll-coretax-a1-export.test.ts`: it pins the guessed layout and will need updating.

## Fix plan (for implementer)

1. Rewrite the row builder in `apps/api/src/lib/payroll-export/coretax-a1.ts` to the 27-element order above. Constants for engine output: WorkForSecondEmployer `No` (or from data if later modelled), GrossUpOpt `No`, IncomeTaxBenefit `0`, NumberOfMonths `0`, PrevWhTaxSlip `xsi:nil`.
2. Add `taxPeriodMonthStart/End` and `article21IncomeTaxIdr` to `A1Row`; fill from `apps/api/src/services/payroll-coretax-a1.service.ts` (sealed payslips only). Validate months 1-12, start <= end, FullYear = 1..12.
3. Replace guessed-assumption header comment with a pointer to this doc; add the official `bpa1.xml` as a golden fixture and a test that compares element names and order.
4. Re-run the money test: withheld total must equal the sum of sealed payslip PPh 21; no payer overpay.

## Confidence

High (about 95%) on names, order, enums, formats: taken directly from the official XSD and sample in DJP's own files. Medium on Coretax server-side rules beyond XSD (e.g. Article21IncomeTax cross-check, WithholdingDate vs period): REF sheet states them but only a real upload to Coretax proves them. DJP may revise the file; the DJP page lists it as 7/11/2024 and no newer version was found as of today.
