# C4b progres (legend-osqou.8)

## Sudah

- Kontrak `listSettlements` (GET `/reconciliation/settlements`, outletId wajib, filter source/provider/periodFrom/periodTo, cursor) + DTO `settlementListItemSchema` di `packages/shared/src/payment/admin.ts`.
- Test gagal-dulu `apps/api/src/test/payment-settlement-list.test.ts` (7 gagal: route belum ada). Commit 0a091dce8.
- Langkah 1 selesai: service `listSettlements` (`payment-settlement-import.service.ts`) + route GET (`payment-admin.routes.ts`, `reconcileQuery`). Test terarah 7/7 lulus, prettier/eslint bersih, typecheck api hijau.

- Keputusan CTO: (a) endpoint CSV server `legend_template_v1`, (b) MFA nyata di kedua impor, (c) pemilih outlet di panel rekonsiliasi.
- Langkah 2a server selesai: POST `/reconciliation/settlements/csv` (`importGatewaySettlementCsv`), parser `payment-settlement-csv-parse.ts`, `MFA_REQUIRED` di impor JSON dan CSV (cek outlet+izin+MFA sebelum membaca berkas), registry `payment-settlement.csv-import`, dokumen `docs/design/settlement-csv-template.md`, bead legend-osqou.53 (format asli Duitku). Test: csv 7, list 7, import, emit, registry = 183 lulus. Typecheck api hijau.

- Langkah 2b-4 web selesai: layar `/kelola/pembayaran/settlement-duitku` (outlet, nomor laporan, periode, berkas CSV, Unduh template, step-up MFA lalu kirim ulang dengan kunci idempotensi sama, galat per baris, hasil dari server: hitungan + kotor/MDR/bersih, Sudah ada bila replay), daftar "Settlement terakhir" (`settlement-list.tsx`), panel rekonsiliasi: pemilih outlet (bawaan outlet pertama akun), tombol impor, daftar settlement, cabang 503 dihapus. Katalog `gatewaySettlement` (`ws05-settlement-import.ts`). Mock `settlement-mock.ts`. Screenshot `docs/review/img/c4b-{kosong,galat,mfa,hasil,rekonsiliasi}-{390,1280}.png` (`scripts/shot-c4b.mjs`).
- Pra-gate: prettier, eslint, text-contract 12/12, test web 14 lulus, test API 183 lulus, typecheck api+web.

## Putaran perbaikan (audit UI + review K)

- P1-1: 422 tanpa rowErrors kini teks Indonesia (`invalid`), pesan server tidak tampil. P3-9: 401 "Sesi habis", 429 dengan/tanpa detik.
- P1-2: panel step-up MFA di luar form unggah (Duitku dan EDC). Bukti browser `e2e/legend-1272-c4b-mfa.mock.spec.ts`: kode lama gagal 6/6, kode baru lulus 6/6 (kode salah Enter/klik tidak mengirim, kode benar sekali kirim).
- P2-3 fieldset beku saat MFA; P2-4 nominal 390 satu baris per angka; P2-5 `?outletId=` di tautan impor; P2-6 periode `Intl` id-ID; P3-7 tombol aktif, fokus ke galat pertama; P3-8 pesan MFA diminta lagi, fokus kembali ke tombol; P3-10 teks .csv/.txt dan 90 kB; P3-11 breadcrumb; P3-12 urutan pemilih lalu tautan, state tanpa outlet.
- Review P3-2 komentar MFA sesi (sama X2); P3-3 kasus + ringkasan kembali tingkat tenant, pemilih outlet hanya daftar settlement (test `ws05-reconciliation-scope.test.ts`); P3-5 cek ukuran byte (Blob). P3-1 -> legend-osqou.54, P3-4 -> legend-osqou.55.

## Batasan

- Web tidak tahu izin per outlet: pemilih memakai outlet akun (`access.outlets`), outlet pertama bawaan; API menolak 403 bila tanpa `payment.reconcile` di outlet itu (teks galat jelas).
- Pemegang izin rekonsiliasi per outlet: kasus + ringkasan tingkat tenant dijawab 403, panel beralih ke outlet terpilih dengan catatan "Menampilkan outlet terpilih" (test `ws05-reconciliation-scope.test.ts`). Gabungan beberapa outlet sekaligus belum ada di API.
- Format asli Duitku belum didukung (bead legend-osqou.53).
- Review K architect (uang) + ui-auditor belum dijalankan.
