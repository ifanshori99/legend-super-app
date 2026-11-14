# Brief: second-opinion (Codex, xhigh) — uang loyalty: poin, referral, refund

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Jangan jalankan `bd`. Tidak mengubah file.

## Repo dan diff
`/Users/ifanshori99/Projects/legend super app/legend`. Rentang: `git diff milestone/m1...origin/ws/loyalty-referral-followups` (memuat ws/loyalty-points-money 4bf7760b5). Sudah direview architect Claude xhigh per cabang.

Berkas (hanya ini, plus migrasi loyalty baru di `apps/api/drizzle/` dalam rentang itu):
- `apps/api/src/services/loyalty-earn-consumer.ts`
- `apps/api/src/services/referral.service.ts`
- `apps/api/src/services/loyalty-expiry.service.ts`
- `apps/api/src/services/reward-redemption.service.ts`
- service/route loyalty lain yang berubah di rentang itu (`git diff --stat` dulu)
Bagi ke subagent Codex maks 3: (1) earn + expiry, (2) referral, (3) redemption + route + migrasi.

## Invariant yang harus benar (outlet tidak boleh rugi)
- Poin earn dan bonus referral tidak pernah diberikan atau dipulihkan lebih dari sekali, termasuk retry, konkuren, replay.
- Order pertama yang dibayar penuh poin tidak memicu bonus referral (founder Q6).
- Refund yang ditolak memulihkan bonus tepat sekali (Q5), KECUALI: ada refund aktif lain di order, referrer tidak aktif, plafon bulanan referrer penuh, atau bonus hangus (founder W4 Q4: diterima). Refund parsial tidak membalik bonus.
- Plafon bulanan referrer tidak terlewati. Poin hangus tidak dihitung sebagai kekurangan.
- Isolasi tenant; saldo tidak bisa negatif kecuali aturan eksplisit.
- Diketahui dan sedang diperbaiki (jangan dilaporkan ulang): legend-vqft5 (refund A ditolak saat B aktif memulihkan poin earn terlalu banyak), legend-btdxg (ditunda).

## Laporan
Satu baris per temuan: `path:baris`, tingkat (P1/P2/P3), masalah, skenario gagal konkret, saran. Tanpa temuan: satu baris.
