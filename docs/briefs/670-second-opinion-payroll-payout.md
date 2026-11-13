# Brief: second-opinion (Codex, xhigh) — jurnal dan uang payout gaji

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Jangan jalankan `bd`. Tidak mengubah file.

## Repo dan diff
`/Users/ifanshori99/Projects/legend super app/legend`. Rentang: `git diff milestone/m1...origin/ws/finance-exceptions` (cabang ini memuat ws/payroll-payout-gl, ws/payroll-payout-hardening, ws/edge-sync-resilience). Sudah direview architect Claude xhigh per cabang.

Berkas yang diperiksa (hanya ini):
- `apps/api/src/services/payroll-payout-gl.service.ts`
- `apps/api/src/services/payroll-payout-overpaid.service.ts`
- `apps/api/src/services/payroll-payout-setup.ts`
- `apps/api/src/services/payroll-payout-manual.service.ts`
- `apps/api/src/routes/payroll-payout.routes.ts`, `apps/api/src/routes/payroll-payout-return.routes.ts`
- `apps/api/src/db/schema/payroll-payout.ts` dan migrasi baru di `apps/api/drizzle/` untuk payout (0534-0546 di cabang ini)
Bagi ke subagent Codex maks 3: (1) GL + setup, (2) overpaid + manual, (3) routes + schema + migrasi.

## Invariant yang harus benar
- Tidak ada karyawan dibayar lebih; gaji bersih tidak berubah oleh biaya transfer. Biaya transfer Rp5.000 ditanggung PT, dijurnal Dr 8101 / Cr bank sumber, tepat sekali (termasuk saat replay/retry dan overpaid).
- `paid_by` = penyetuju terakhir; approve dan export ditolak tanpa mapping akun; rekening sumber tidak aktif ditolak 409 `PAYOUT_SOURCE_ACCOUNT_MISSING` di settle, repost, overpaid, approve, export.
- Jurnal seimbang, idempoten, terisolasi per tenant/PT/outlet; tidak ada jurnal ganda saat retry atau konkuren.
- Pembayaran manual butuh dua orang berbeda.
- Urutan migrasi: `_journal.json` idx 333/334 ganda dan `when` 0538/0539 lebih besar dari 0534-0543 sudah diketahui CTO; laporkan hanya bila ada masalah lain di migrasi.

## Laporan
Satu baris per temuan: `path:baris`, tingkat (P1/P2/P3), masalah, skenario gagal konkret, saran. Tanpa temuan: satu baris.
