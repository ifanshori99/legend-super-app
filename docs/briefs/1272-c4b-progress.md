# C4b progres (legend-osqou.8)

## Sudah

- Kontrak `listSettlements` (GET `/reconciliation/settlements`, outletId wajib, filter source/provider/periodFrom/periodTo, cursor) + DTO `settlementListItemSchema` di `packages/shared/src/payment/admin.ts`.
- Test gagal-dulu `apps/api/src/test/payment-settlement-list.test.ts` (7 gagal: route belum ada). Commit 0a091dce8.
- Langkah 1 selesai: service `listSettlements` (`payment-settlement-import.service.ts`) + route GET (`payment-admin.routes.ts`, `reconcileQuery`). Test terarah 7/7 lulus, prettier/eslint bersih, typecheck api hijau.

- Keputusan CTO: (a) endpoint CSV server `legend_template_v1`, (b) MFA nyata di kedua impor, (c) pemilih outlet di panel rekonsiliasi.
- Langkah 2a server selesai: POST `/reconciliation/settlements/csv` (`importGatewaySettlementCsv`), parser `payment-settlement-csv-parse.ts`, `MFA_REQUIRED` di impor JSON dan CSV (cek outlet+izin+MFA sebelum membaca berkas), registry `payment-settlement.csv-import`, dokumen `docs/design/settlement-csv-template.md`, bead legend-osqou.53 (format asli Duitku). Test: csv 7, list 7, import, emit, registry = 183 lulus. Typecheck api hijau.

## Sedang

- Langkah 2b web: layar impor Duitku, lalu langkah 3 (panel + pemilih outlet), langkah 4 (katalog teks, screenshot).
