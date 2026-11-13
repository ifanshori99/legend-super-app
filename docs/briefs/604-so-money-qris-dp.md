# Brief: second-opinion — area uang: QRIS ber-DP + jurnal refund

Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (maks 3, per area berkas). Tidak mengubah file.

Repo: `/Users/ifanshori99/Projects/legend super app/legend` (read-only; `git fetch origin` dulu).

## Rentang diff
1. `git diff origin/milestone/m1...origin/ws/qris-dp-hold -- apps/api/src packages/shared/src apps/api/drizzle` (QRIS hold C1-C3, migrasi 0419-0421).
2. `git diff origin/milestone/m1...origin/fix/money-journal-refund -- apps/api/src/services` (28 baris).

Berkas berisiko: `services/*qris*`, `*hold*`, `*payment*`, `*unallocated*`, `*customer-display*`, `*pairing*`, `accounting-journal.service.ts`, migrasi 0419-0421.

## Invariant (PRD + founder)
- Satu QR aktif per tagihan; tagihan terkunci selama QR bisa dibayar; tidak ada pembayaran ganda (QR + tunai/split).
- Q92: QR QRIS berlaku 5 menit. Q93: buka kunci manajer dengan PIN hanya 30 menit setelah QR kedaluwarsa, tercatat audit; uang QR lama yang terbayar masuk dana tak teralokasi lalu dikembalikan manajer ke pembayar.
- Uang terlambat/nominal salah diparkir tepat sekali; tidak ada pihak dibayar lebih; outlet tidak rugi.
- Q81/Q82/Q83: DP dan sisa DP (saldo hanya bila profil terhubung dan tagihan sah; hanya di outlet tempat DP dibayar).
- Pairing layar pelanggan tidak bisa dipakai lintas tenant/outlet; token layar tidak membocorkan data tagihan lain.
- Refund tidak pernah dibukukan ke akun service charge/pajak.

## Laporan
Format peran: satu baris per temuan (`path:baris`, tingkat, masalah, skenario gagal, saran).
