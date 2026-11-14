# 662 review ronde 1 (architect, tingkat K)

Commit dasar 323131122. File kode: `apps/api/src/services/payroll-payout-{setup,overpaid.service,gl.service}.ts` (nama persis: `payroll-payout-setup.ts`, `payroll-payout-overpaid.service.ts`, `payroll-payout-gl.service.ts`).

## F1 (medium) posting ke rekening nonaktif
`payroll-payout-overpaid.service.ts` ~L209-221 hanya mengecek rekening KONFIGURASI; jurnal overpaid mengkredit rekening yang dipakai jurnal settle (tidak dicek). `payroll-payout-gl.service.ts` ~L507-517 (repost fee posting yang sudah settle) sama. Contoh: batch settle dari akun A, konfigurasi pindah ke B, A dinonaktifkan: kedua jalur tetap posting ke A.
Fix: helper di `payroll-payout-setup.ts` yang memastikan SEBUAH akun GL tertentu milik bank account aktif (tenant+PT sama), selain itu 409 `PAYOUT_SOURCE_ACCOUNT_MISSING`; panggil di kedua jalur. Perbaiki komentar yang menyebut kasus ini sudah ditolak.

## F2 (medium) fee overpaid hilang
`payroll-payout-overpaid.service.ts` ~L174-192, L224: fee hanya dijurnal bila run punya jurnal terkunci. Settle (`payroll-payout-gl.service.ts` ~L201) juga menjurnal fee bila tidak ada jurnal terkunci tapi akuntansi aktif. Overpaid menyimpan `feeIdr: 0` dengan `fee_posted` true: fee tak pernah muncul.
Fix: jurnalkan fee bila ada jurnal terkunci ATAU akuntansi aktif (sama dengan settle), kunci `payroll-payout-overpaid-fee:<itemId>`, 409 bila `bank_charges` tak termapping.

## F3 (medium) snapshot migrasi 0546
`apps/api/drizzle/meta/0546_snapshot.json` tidak ada; `db:generate` tidak kosong. Catatan: `pnpm db:generate` gagal dari awal karena `0534_snapshot.json` dan `0538_snapshot.json` berbagi parent (artefak gabung dua cabang). Buat snapshot 0546 yang mencerminkan skema gabungan (termasuk 0538, 0539, 0542, 0543, 0546); bila perlu perbaiki rantai prevId secara minimal dan jelaskan. Buktikan `pnpm db:generate` kosong.

## F4 (low) race
`payroll-payout-setup.ts` ~L95-106 baca bank account tanpa kunci: tambah `.for("share", { of: bankAccounts })` bila dalam transaksi.

## F5 (low) migrasi
`0546_edge_order_ingest_tax_flag.sql` L6: CHECK dengan `NOT VALID` lalu `VALIDATE CONSTRAINT` sebagai pernyataan terpisah (cek pola migrasi lain di repo).
