# Sub-brief legend-pbwzq (Codex 422 fixes), cabang ws/pti5r-promo-refund @095b4099

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pti5r-promo-refund`. Konteks desain: `docs/briefs/sub-pti5r-promo-refund.md` (Round 3-4), `docs/runbooks/recovery-refund-final-failure-backfill.md`.

## Temuan (keputusan CTO: betulkan semua)

1. P1 `apps/api/src/services/order-recovery-refund.ts` ~392: replay (`findRecoveryRefundReplay`) hanya jalan bila order punya promo aktif (`livePromoApplicationOf`). Tanpa promo, laporan ulang item yang refund-nya gagal final menghitung split baru (Rp3 gagal bisa jadi Rp4 karena pembulatan pajak). HARUS: replay jumlah + split semula untuk SEMUA order (promo atau tidak, pay-first atau open bill). Promo recompute tetap hanya bila replay null dan promo aktif.
2. P1: tanpa promo, refund `rejected` bisa diajukan lagi lewat laporan baru. HARUS: laporan ulang item yang refund terakhir pendahulunya `failed` dengan reason `rejected` -> `blocked("nothing_left")` untuk SEMUA order (keputusan founder legend-h1dyy: uang tidak terutang). Promo order hasilnya tetap sama (T4 di test pti5r).
3. P1 ~766: pendahulu replay dipilih berdasar `order_issues.created_at`. Kasus: issue B dibuka sebelum A; A diproses (filing) dulu lalu gagal final; B lalu diproses -> A tidak ditemukan karena A dibuat setelah B. HARUS: pilih pendahulu berdasar urutan filing yang sudah diproses (issue lain item asli sama, resolved manual_refund, yang punya refund row; urut waktu filing pertamanya, mis. min(payment_refunds.created_at) per issue, terbaru menang; tie-break id). Rantai A->B->C tetap jalan (T10).
4. P2 `apps/api/scripts/recovery-refund-final-failure-check.sql`: FORCE RLS berlaku juga untuk pemilik tabel, jadi koneksi owner tanpa BYPASSRLS diam-diam memberi hasil kosong. HARUS: di awal skrip, gagal eksplisit (RAISE EXCEPTION di DO block, dalam transaksi READ ONLY) bila `current_user` bukan superuser dan tidak `rolbypassrls`. Test: peran tanpa bypass -> error jelas; peran dengan bypass -> hasil benar. Perbarui komentar skrip + runbook ("pemilik tabel" tidak cukup).
5. P2 runbook ~80: helper backfill `refileRecoveryRefundAfterFailure` menulis audit baru tiap panggilan (mis. `AUDIT_REJECTED` di `settleFinalFailure`, `AUDIT_REFILE_BLOCKED`). HARUS: panggilan berulang untuk refund gagal yang sama tidak menambah audit (pakai pola `auditOnce` per refund id / issue id), tidak menambah event, tidak mengubah stamp. Runbook menyebut ini.

## Pembagian

- implementer-svc: temuan 1, 2, 3, 5 di `order-recovery-refund.ts` (dan `order-recovery-refund-amount.ts` bila perlu). Hanya file itu.
- implementer-sql: temuan 4 (skrip SQL, `apps/api/src/test/recovery-refund-final-failure-check-db.test.ts`, runbook bagian cara menjalankan + catatan temuan 5).
- test-writer: file baru `apps/api/src/test/order-recovery-refund-codex422.test.ts`, test gagal-dulu temuan 1, 2, 3, 5. Contoh helper/seed: `apps/api/src/test/order-recovery-refund-promo-final-failure.test.ts` dan `order-recovery-refund-final-failure.test.ts`.

## Aturan

- Jangan jalankan `pnpm test` (DB test berbagi container per worktree; CTO-agent yang menjalankan). Typecheck: `heavy pnpm --filter @starter/api typecheck`. Prettier: `pnpm exec prettier --check <file>`.
- Jangan commit. Jangan sentuh file di luar bagianmu. Jangan baca `.env*`.
- Laporan: file yang diubah, ringkasan perubahan, hal yang ragu.
