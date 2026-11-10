# Perbaikan temuan architect legend-3zd1 (putaran 1)

Worktree `.worktrees/3zd1-tiers-expiry`. Rujukan: `docs/briefs/sub-3zd1-slices.md`. Tulis tes gagal-dulu untuk tiap temuan (jalankan merah, lalu perbaiki, lalu hijau): `LEGEND_TEST_FILES="src/test/crm-tiers.test.ts src/test/crm-expiry.test.ts" pnpm test` dari root worktree. Jangan commit, jangan typecheck, hanya berkas potonganmu.

## Potongan A (referral): berkas `services/consent.service.ts`, `services/referral.service.ts`, `routes/member.routes.ts` (hanya GET /profile), `test/crm-tiers.test.ts`

1. Referral lewat signup asli tidak pernah tercatat: `consent.service.ts` `createMemberProfile` memasang GUC member ke id profil baru (`setMemberProfileGuc`) SEBELUM `applyReferralAtSignup`; policy `member_self` pada `customer_profiles` menyaring pencarian kode referrer. Perbaikan: cari id referrer berdasarkan kode SEBELUM GUC diset (atau ubah `applyReferralAtSignup` menerima `referrerProfileId` terselesaikan; fungsi pencari `findReferrerByCode(tx, tenantId, code)` diekspor dan dipanggil sebelum GUC). Insert baris `referrals` sesudah GUC (policy referrals mengizinkan referee = profil sendiri). Tes baru lewat `POST /api/member/consents` dengan `referralCode` (HTTP asli, tanpa memanggil service langsung).
2. `qualifyReferral` membayar bonus pada order self-serve yang diblokir: keluar bila `context.record.state` bukan `booked` atau `capped` (lihat `POINT_EARN_STATES` di `db/schema/crm-ledger.ts`). Tes: order diblokir self-serve tidak mengkualifikasi referral.
3. Member lama tidak pernah dapat kode referral: `GET /api/member/profile` memanggil `ensureReferralCode` (di dalam transaksi member yang sama) bila program referral aktif dan kode kosong, lalu mengembalikan kode di DTO. Tes.

## Potongan B (kedaluwarsa dan tier): berkas `worker/loyalty-tier.job.ts`, `worker/loyalty-expiry.job.ts`, `services/loyalty-expiry.service.ts`, `services/loyalty-tier.service.ts`, `worker-main.ts` (hanya urutan), `test/crm-expiry.test.ts`

3. Tenant di atas 10.000 profil tidak tersapu (`MAX_BATCHES` x `BATCH_SIZE`, selalu mulai `afterId=null`). Perbaikan: kursor per tenant disimpan antar tick (Map seperti `lastDayByTenant`); tandai hari selesai hanya bila batch terakhir tidak penuh; hari baru reset kursor.
4. Profil gagal permanen memicu sapuan penuh tiap menit: pada tick berikut ulangi hanya id yang gagal (pola daftar `failed` di `worker/redemption-expiry.job.ts`), bukan seluruh daftar; hari tetap ditandai selesai bila hanya sisa id gagal yang diulang dengan batas percobaan (3 tick, lalu menyerah sampai besok).
5. Reversal sesudah grant kedaluwarsa: `net = max(points - rev - exp, 0)` membuang kelebihan (rev+exp > points), jadi poin "belum terpakai" melebihi saldo. Skenario: grant A 100 sudah hangus, order A di-refund dan reversal memotong 50 dari grant B. Perbaikan: kelebihan `max(rev_i + exp_i - points_i, 0)` dijumlahkan ke `used` sebelum alokasi FIFO. Tes gagal-dulu dengan skenario itu (grant C ikut hangus terlalu cepat).
6. Bonus ulang tahun memakai tier nonaktif: periksa `tier.isActive` di `grantBirthdayBonus`; dan di `worker-main.ts` jalankan sapuan tier SEBELUM sapuan kedaluwarsa/ulang tahun. Tes nonaktif.
