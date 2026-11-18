# 1063 konteks bersama (engineer -> subagent)

Brief induk: `docs/briefs/1063-refund-so-ronde5-fix.md`. Temuan lengkap + usul test: `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-refund-ronde5-1062.md` (baca hanya temuan yang jadi tugasmu; dokumen ini belum di-commit di worktree ini, salinannya `docs/qa/second-opinion-refund-ronde5-1062.md`). Riwayat ronde 4: `docs/PROGRESS.md` entri "1055". Test ronde 4 sebagai pola fixture: `apps/api/src/test/refund-1055-a-anonymous-and-txn.test.ts`.

Aturan restriktif (keputusan CTO): saat ragu, tahan (hold) dan kurangi kredit DP; jangan pernah membuka dana selama konflik belum diselesaikan finance. Uang: tidak boleh ada pihak dibayar lebih; outlet tidak boleh rugi.

Tiga temuan:
- F1 legend-9dh7x (P1) `apps/api/src/services/payment-provider-partial-refund.ts` ~:556-570 (cari refund sendiri hanya tenant+providerRef+bukan failed), keluar `own` sebelum penanganan konflik ~:857-879. Echo refund sendiri wajib membuktikan intent + transaksi sumber (`payment_refunds` completed/approved juga, bukan hanya `payment_provider_refunds`); ID dikenal di transaksi lain = pasang hold konflik (`HOLD_TRANSACTION_CONFLICT`) sebelum keluar. Fund T2 tidak boleh bisa request/approve/payout selama konflik (guard `payment-provider-refunded-guard.ts`, `payment-admin-funds.service.ts`, `payment-refund.service.ts` ~:1462, :2073, :2310, :2533).
- F2 legend-awdwd (P1) `apps/api/src/services/reservation-deposit-credit.ts` ~:167-170: hold yang terwakili fact dikecualikan hanya bila `providerPaymentRef` sama; hold konflik tetap mengurangi kredit DP (kredit asli dan pindahan: `sessionDepositCredit` ~:446, `pos-order-support.ts` ~:1032). Resolve `not_this_intent` memulihkan kredit tepat sekali. Uji dua urutan lock (hold vs pemakaian) dengan barrier.
- F3 legend-flj83 (P2) `payment-provider-partial-refund.ts` ~:110-160 dan `refund-recon-hold.service.ts` ~:605-630: `same_as_counted` memilih `min(amount_idr)` fact anonim tanpa mengecualikan yang sudah terikat. Simpan ikatan `same_as_counted` ke fact anonim yang dipakai; pilih hanya fact belum terikat. Dua anonymous beda nominal (10.000 dan 20.000), dua laporan ber-ID diselesaikan same_as_counted dalam dua urutan + replay: total fact/jurnal tepat Rp30.000, saldo bersih Rp70.000, tidak ada event tambahan; kontrol G1-08 (laporan lebih besar dari satu fact anonim) tetap.

Migrasi baru (bila perlu): rentang 0679-0680. FK tabel baru inline di CREATE TABLE. Tabel baru wajib diakui di `data-import-registry.test.ts` dan tes cakupan tabel.

Shell: satu perintah sederhana per panggilan Bash. Test: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Tipe brand: helper bertipe, bukan `as`.

## Putaran architect (P2 tambahan, kode sudah diperbaiki, tinggal test)
Tulis `apps/api/src/test/refund-1063-d-architect.test.ts` (fixture dari refund-1063-a/c). Semua harus lulus di kode sekarang; buktikan gagal-dulu dengan `git stash`-free cara: baca kode sebelum fix dari `git diff` bila perlu, atau jelaskan di laporan bahwa fail-first tidak bisa tanpa revert (jangan revert kode).
- P2-1: dua hold ANONIM (tanpa refund id) Ha 10.000 dan Hb 20.000 pada transaksi dengan fact provider P1 10.000, P2 20.000; resolve keduanya `same_as_counted` dalam dua urutan: total fact tetap Rp30.000, tanpa event jurnal tambahan (jalur kedua di refund-recon-hold.service.ts, `pickUnboundFact`, binding `matched_fact_id`).
- P2-2: refund kita R Rp50.000 ref X di T1; laporan X/T1 Rp100.000 TIDAK dianggap echo: hold `HOLD_TRANSACTION_CONFLICT`, tidak ada fact. Kontrol: X/T1 Rp50.000 echo biasa, dan laporan <= nominal kita tetap echo.
- Celah F1: R berstatus `approved` (bukan completed) dengan ref X + laporan X/T2 => hold; refund level-intent (bukan fund) untuk T1 + laporan X/T2 => hold; ID X milik refund kita di intent LAIN + laporan X/T2 di intent ini => hold; kontrol refund fund dengan evidence T1 + laporan X/T1 => echo tanpa hold.
- Kontrol legacy: hold same_as_counted lama tanpa matched_fact_id tetap dihitung oleh unmatchedAnonymousFacts (satu test).
Jalankan hanya berkasmu: `LEGEND_TEST_FILES="src/test/refund-1063-d-architect.test.ts" heavy pnpm test`. Jangan ubah berkas non-test; lapor kegagalan yang tampak bug kode.
