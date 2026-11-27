# C4b progres (legend-osqou.8)

## Sudah

- Kontrak `listSettlements` (GET `/reconciliation/settlements`, outletId wajib, filter source/provider/periodFrom/periodTo, cursor) + DTO `settlementListItemSchema` di `packages/shared/src/payment/admin.ts`.
- Test gagal-dulu `apps/api/src/test/payment-settlement-list.test.ts` (7 gagal: route belum ada). Commit 0a091dce8.
- Langkah 1 selesai: service `listSettlements` (`payment-settlement-import.service.ts`) + route GET (`payment-admin.routes.ts`, `reconcileQuery`). Test terarah 7/7 lulus, prettier/eslint bersih, typecheck api hijau.

- Keputusan CTO: (a) endpoint CSV server `legend_template_v1`, (b) MFA nyata di kedua impor, (c) pemilih outlet di panel rekonsiliasi.
- Langkah 2a server selesai: POST `/reconciliation/settlements/csv` (`importGatewaySettlementCsv`), parser `payment-settlement-csv-parse.ts`, `MFA_REQUIRED` di impor JSON dan CSV (cek outlet+izin+MFA sebelum membaca berkas), registry `payment-settlement.csv-import`, dokumen `docs/design/settlement-csv-template.md`, bead legend-osqou.53 (format asli Duitku). Test: csv 7, list 7, import, emit, registry = 183 lulus. Typecheck api hijau.

- Langkah 2b-4 web selesai: layar `/kelola/pembayaran/settlement-duitku` (outlet, nomor laporan, periode, berkas CSV, Unduh template, step-up MFA lalu kirim ulang dengan kunci idempotensi sama, galat per baris, hasil dari server: hitungan + kotor/MDR/bersih, Sudah ada bila replay), daftar "Settlement terakhir" (`settlement-list.tsx`), panel rekonsiliasi: pemilih outlet (bawaan outlet pertama akun), tombol impor, daftar settlement, cabang 503 dihapus. Katalog `gatewaySettlement` (`ws05-settlement-import.ts`). Mock `settlement-mock.ts`. Screenshot `docs/review/img/c4b-{kosong,galat,mfa,hasil,rekonsiliasi}-{390,1280}.png` (`scripts/shot-c4b.mjs`).
- Pra-gate: prettier, eslint, text-contract 12/12, test web 14 lulus, test API 183 lulus, typecheck api+web.

## Batasan

- Web tidak tahu izin per outlet: pemilih memakai outlet akun (`access.outlets`), outlet pertama bawaan; API menolak 403 bila tanpa `payment.reconcile` di outlet itu (teks galat jelas).
- Format asli Duitku belum didukung (bead legend-osqou.53).
- Review K architect (uang) + ui-auditor belum dijalankan.
