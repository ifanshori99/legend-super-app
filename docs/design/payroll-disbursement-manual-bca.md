# Payroll disbursement: BCA manual file format

Status: first bank file format (founder Q17). Written 13 Nov 2026 for bead legend-648.
Code: `apps/api/src/lib/payroll-export/bank-formats.ts` (formatter `bca`).

## What this file is

BCA's own file specification is not public. Source used:
HReasily help article "How to upload GIRO File to Bank BCA portal"
(https://hreasily-help.freshdesk.com/en/support/solutions/articles/72000646425).

KlikBCA Bisnis Multi Payroll takes an Excel or CSV file that BCA's "Multi Auto
Transaksi" converter maps into a `.txt` file plus a checksum file (Checksum
Application, type Payroll). The user uploads both under Multi Transaction >
File Upload > Multi Payroll.

The `bca` formatter renders the converter SOURCE sheet, not the final `.txt`.

## Columns

Header (field names as listed by the guide):

`Transaction ID,Transfer Type,Credited Account,Receiver Name,Amount,Employee ID,Remark,Email`

| Column           | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Transaction ID   | `<YYYYMM><4-digit sequence>`, sequence starts at 0001 |
| Transfer Type    | fixed `BCA` (in-bank)                                 |
| Credited Account | digits only, quoted                                   |
| Receiver Name    | account holder name, else employee name               |
| Amount           | whole rupiah, no separators                           |
| Employee ID      | employee code                                         |
| Remark           | `GAJI <periodLabel>`                                  |
| Email            | empty                                                 |

Line ends are CRLF, no trailing line break, UTF-8 without BOM.

Not in the file (typed in the converter Transfer Info tab): debited account,
effective date, Corporate ID, Company Code, Header ID.

## Rules that limit payment

- Only rows with bank code `014` are rendered. Any other row, or a row without
  a bank code, fails the whole file with `422 PAYROLL_BANK_FILE_BANK_UNSUPPORTED`.
  The batch builder blocks such items earlier (`bank_format_unsupported`).
- Amount must be a positive whole rupiah, else `PAYROLL_BANK_FILE_AMOUNT_INVALID`.
- An account without digits fails with `PAYROLL_BANK_FILE_ACCOUNT_INVALID`.
- More than 9999 rows fail with `PAYROLL_BANK_FILE_TOO_MANY_ROWS`.
- The bank fee is borne by the company: the amount is never reduced by it.

## UNCONFIRMED: the bank must confirm before first live use

Listed in code as `BCA_UNCONFIRMED_FIELDS`.

1. Transfer Type literal values (we use `BCA`).
2. Transaction ID length and character set.
3. Receiver Name length and character set.
4. Credited Account format (digits only, quoting, leading zeros).
5. Amount format.

Until confirmed, finance must run the first file through the converter and the
BCA portal with a small test batch and check the converter accepts it before a
real payroll release.
