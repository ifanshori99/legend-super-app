# WS-07: official Coretax XSD and the current export contract

Inspected on 17 November 2026 for `legend-igclp`, against
`milestone/m1` commit `c17c60df7`. No tax calculations, journal entries,
permissions, or database schemas were changed during this investigation.

## Official source and reproducible evidence

The [DJP template and converter page](https://pajak.go.id/reformdjp/coretax/template-xml-dan-converter-excel-ke-xml)
publishes separate documents for monthly payroll withholding, unified
withholding, invoices, and other tax documents. Its monthly payroll and unified
withholding converters contain actual XSD definitions inside the XLSX ZIP
member `xl/xmlMaps.xml`:

| Document | Official converter                                                                                                            | Schema ID        | Root element    | Download SHA-256                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------- | ------------------------------------------------------------------ |
| BPMP     | [BPMP Excel to XML v.3, 17 April 2025](https://pajak.go.id/sites/default/files/2025-04/BPMP%20Excel%20to%20XML%20v.3.xlsx)    | `MONTHLYPAYROLL` | `MmPayrollBulk` | `2170302c6a210a98ef5edacf32c803d3b4c413a8a18a8abcc0c338e6fdd52b09` |
| BPPU     | [BPPU Excel to XML v.3, 4 September 2025](https://pajak.go.id/sites/default/files/2025-09/BPPU%20Excel%20to%20XML%20v.3.xlsx) | `BPU`            | `BpuBulk`       | `b59813365bccdf9d63a47051d4d2b0b58c53351b8c981a6f33144be05b429089` |

These are converter release labels and update dates, not invented standalone
XSD version numbers. The separate official template downloads `bpmp.zip` and
`bppu.zip` contain example XML only. Extracting a converter's XSD is necessary
to preserve the official constraints and provenance; deriving an XSD from a
sample would not establish official validation.

## Why the current export cannot be validated as a DJP document

`apps/api/src/services/accounting-coretax-xml.ts` currently emits a Legend
`TaxReport` root containing `Header` and `Lines`. That root is absent from the
official schemas above. Passing the current output directly to either schema
would reject every export, including reports that currently export successfully.

The snapshot contract in `packages/shared/src/accounting/tax.ts` retains subject
identity, masked NPWP, outlet, base amount, tax amount, references, warnings, and
PPN direction. It does not retain all legal fields needed by the official
document formats:

- BPMP requires counterpart residence/passport data, PTKP status, position,
  certificate type, tax object code, rate, NITKU, and withholding date.
- BPPU requires tax object code, rate, certificate type, document type/number/date,
  income recipient's NITKU, issuer's NITKU, and withholding date.
- PBJT is a regional tax recap; no corresponding generic Coretax `TaxReport`
  schema was established by these official sources.

Computing a rate from rounded recap amounts or filling legal fields with
defaults would fabricate filing data. Replacing or supplementing the export
with an official document mapper therefore needs a source-data and document
contract decision before validation can safely become a required export gate.

## Validator research

The candidate is [`xmllint-wasm`](https://github.com/noppa/xmllint-wasm), whose
official documentation describes libxml2 compiled to WebAssembly, bundled
TypeScript declarations, and Node worker isolation. The `validateXML` API accepts
XML, schema contents, and optional preloaded dependency files; it does not fetch
missing schema dependencies over the network. Validation failures resolve with
`valid: false`; invalid schema or execution failures reject the promise.

Context7 resolution was attempted with `xmllint-wasm` and
`noppa/xmllint-wasm`; the results were unrelated WASM libraries, so the official
repository documentation was consulted instead. No dependency or unused
production validator was added. A future implementation must pin a published
version and verify its own versioned documentation, package types, offline
behavior, and supported Node version.

## Scope decision

Keep `legend-igclp` open pending an approved mapping/source contract for each
supported official DJP document and an explicit treatment of PBJT. Do not label
Legend's generic XML as DJP-valid, author a substitute schema under DJP's name,
or install a validation gate that unconditionally disables all current exports.
The independent outbox and error-catalog work in `legend-0cnqt` can proceed.
