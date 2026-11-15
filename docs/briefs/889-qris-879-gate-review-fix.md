# 889 QRIS 879: perbaikan temuan review architect atas perbaikan gerbang (606feb8a6)

Cabang: `fix/qris-hold-so-879` (lanjutkan, tanpa force). Tingkat K uang.

## Temuan (architect xhigh, 16 Nov 02:20)
1. P1 poll starvation (`payment.service.ts:2830/2887/2897/2901`, commit 6d57384f4). Split per kind hanya di seleksi; `claimed.sort` menaruh kode kedaluwarsa lama (jarang dipoll) di depan; budget error (3 beruntun) dan budget 20 s dipakai bersama, jadi kode pending hidup bisa terlewati. 0629 tanpa backfill, jadi semua intent lama ber-referensi provider ikut masuk poll.
   - Fix: proses semua baris pending sebelum expired; budget error per provider DAN per kind; budget waktu sendiri untuk pending.
   - Test gagal-dulu: 3 kode expired yang gateway-nya throw + 1 kode pending yang paid, poll sekali, kode pending harus settle. Betulkan juga judul/isi `qris-hold-so885-b-poll-fair.test.ts` supaya membuktikan urutan proses, bukan hanya seleksi.
2. P1 `assertSplitMutableTx` (`bill-split.service.ts:203-254`) tidak memeriksa kode gagal dengan dana belum teralokasi; `failedOrderCodeWithOpenFundTx` (`payment-failed-funds.ts:40`) mengabaikan kode part.
   - Skenario A: VA seluruh order 100k dibayar 90k, kode gagal, 90k diparkir, paidIdr 0, tamu split, part baru dibayar 100k lagi selagi 90k belum selesai.
   - Skenario B: kode part gagal dengan dana parkir, lalu bayar seluruh order atau split ulang membatalkan part, cek seluruh-order melewati kode part.
   - Fix: `assertSplitMutableTx` dan jalur bayar seluruh order melempar 409 `FUNDS_UNRESOLVED` bila kode mana pun dari order (seluruh-order atau part, termasuk part void) berstatus gagal dengan dana belum selesai.
   - Test gagal-dulu: satu per skenario A dan B, harapkan 409 dan tidak ada kode baru dibuat.
3. Commit 7d52eedb4 dan 3fc84db09 (selain payment.service.ts) belum direview: `pos-qris-release-recon.ts`, `qr-order-consumers.ts`, `payment-provider-proof.ts`, dll.

## Bukti selesai
- Test baru merah lalu hijau, plus suite QRIS/split/payment terarah (`LEGEND_TEST_FILES=... heavy pnpm test`).
- Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat heavy, `pnpm db:generate` kosong bila migrasi).
- Satu subagent architect effort xhigh atas SELURUH diff sejak review architect terakhir (6d57384f4^..HEAD, semua berkas produksi termasuk temuan 3), bukan hanya perbaikan baru. Temuan nyata dibetulkan sebelum lapor.
- Catatan merge: m1 sudah punya `0381_payout_pending_settle_return_claims.sql`; jangan renumber sendiri, merge train yang menomori.
- Push tanpa force. Lapor SHA, test merah→hijau, angka subagent. Jangan merge, jangan deploy.
