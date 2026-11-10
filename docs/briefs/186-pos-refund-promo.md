# Brief: engineer — refund POS berpromo dan baris refund per tender

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/pos-refund-promo` dari ujung `milestone/m1` terbaru (9a2c1e86 atau lebih baru; sudah berisi ws/pos-refund-void legend-a0i7), worktree `.worktrees/pos-refund-promo`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Konteks bisnis (founder)
F&B: makanan/minuman umumnya tidak diretur; retur per menu yang habis/salah boleh. Q30 = A: kembalikan uang menu itu saja, selisih promo kecil diterima (legend-ob9o hanya dokumentasi). Item gratis yang dikembalikan tidak boleh menghasilkan uang.

## Tujuan (tingkat K, paralel lewat subagent, file tidak bertumpuk)
1. `legend-15by` (P1): retur item gratis BOGO/bundle menghasilkan uang. Keputusan CTO: pakai usulan architect, `keptDiscount = min(keptSubtotal, pro-rata, diskon hasil hitung ulang promo pada kept lines)`; contoh founder (40k/30k) tidak berubah.
2. `legend-wkl3` (P1): retur item gratis Rp0 harus tercatat (kini 422 `REFUND_NOTHING_DUE`) sehingga refund item berikut benar (contoh BOGO: kopi berikut 30k, bukan 5k). Pilih desain bersama subagent architect (baris refund amount 0 vs tabel retur item); jurnal otomatis tidak boleh memposting 0.
3. `legend-s7rx` (P2): refund pelunasan tanpa item untuk pesanan berpromo yang terkunci sebelum fix a0i7 (sebesar paid - refunded - keptPayable), dan perilaku DP (item berikut tidak boleh jadi `REFUND_NOTHING_DUE`).
4. `legend-45bs9` + `legend-8v2yl` (P3): simpan tender id atau intent id per baris refund POS agar refund sebagian pada pesanan dua intent QRIS tidak menahan kedua intent. Atribusi intent ada di `apps/api/src/services/pos-intent-attribution.ts` di cabang `ws/refund-payout-followups` (belum di m1; sedang masuk merge train): baca, jangan salin rumus; bila perlu, bangun di atas cabang itu setelah masuk m1 dan lapor.
Detail: `bd show <id>`. Keputusan lama: `docs/briefs/172-pos-refund-promo-void.md`, `docs/briefs/sub-178-refund-promo-guard.md`.

## Kartu
`ghostex board associate` semuanya, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `pos-order-corrections.ts`, `crm-promo-refund.ts`, skema/validator refund POS, migrasi `pos_order_refunds`, consumer auto-journal hanya untuk melewati amount 0, test. Jangan: `payment-admin.service.ts`, `accounting-auto-journal-guards.ts`, `pos-order-payment.ts` (milik agent refund lain), `pos-shift.service.ts`, open bill, payroll, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu dengan contoh angka di kartu. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && ...'` + nullglob dengan jumlah file jalan; test root lewat `pnpm test` (suite PostgreSQL butuh DB terisolasi). tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel, perbaikan terakhir dibaca ulang reviewer segar. Brief Codex `docs/briefs/186b-second-opinion-pos-refund-promo.md` di folder utama (tidak di-commit). Migrasi: nomor + `when` di atas 1794222890808.

## Laporan
Sekali setelah semuanya selesai: hasil, bukti, file berubah, SHA, keputusan desain wkl3 dan alasannya, migrasi, risiko tersisa. Jangan menunggu proses global (`pgrep vitest` milik agent lain). Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
