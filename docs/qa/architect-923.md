# Review architect 923: payout deadlock catch-up dan bukti historis

Kartu: `legend-ijaxi` (review atas `legend-yd9u2`). Tanggal: 17 November 2026. Reviewer: architect Claude (Opus 5.5, effort xhigh, karena menyangkut uang).

Lingkup:

- Diff `d06e5a269..d289f5255` (923, dikerjakan Codex).
- Diperiksa pada `origin/milestone/m1` `c17c60df7`. Migrasi `0663_payout_backfill_unfreeze_lock_order` sekarang bernama `0430_payout_backfill_unfreeze_lock_order`. Isi SQL-nya identik byte demi byte dengan versi di cabang 923.
- Tidak ada migrasi sesudah 0430 yang mendefinisikan ulang `app.payout_batch_unfreeze`.
- Konteks: `origin/qa/second-opinion-payout-920:docs/qa/second-opinion-payout-920.md`.

Semua nomor baris di bawah merujuk ke m1, kecuali bila disebut lain.

Cara kerja:

- Baca-saja, tanpa worktree baru.
- 7 subagent: 6 Explore (peta kunci per jalur) dan 1 reviewer (determinisme test). Puncak 6 bersamaan.
- Graf tunggu (wait-for graph) ditelusuri sendiri dari sumber.
- Tidak menjalankan test, build, atau migrasi. Tidak mengubah kode atau data.

## Ringkasan

**P0: 0. P1: 0. P2: 1. P3: 3.** Keempat temuan ada di test. Tidak ada temuan pada kode produk.

- Perbaikan 923 menutup siklus dari SO 920. Worker kini antre di kunci run sebelum memegang batch apa pun. SQL unfreeze memegang run dan semua batch run itu (urut id) sebelum catch-up.
- Di jalur yang ditelusuri tidak ditemukan urutan kunci yang masih terbalik: catch-up unfreeze, worker bukti historis (fase 1 dan 2), consumer `payroll.locked`, recon, retry, reversal, settle, confirm/resolve/return/tunai, correction/overpaid, disown, dan `recordPostingSource`.
- Tidak ditemukan langkah uang yang lolos saat batch beku, GL ganda atau hilang, maupun celah lintas tenant akibat diff ini. Aturan grant, freeze, dan uang di fungsi unfreeze tidak berubah. Diff 0429 ke 0430 hanya menambah satu `PERFORM ... ORDER BY b.id FOR UPDATE`.
- **Keputusan:** kode 923 aman dibawa ke gerbang rilis. P2 hanya menyangkut test, tetapi wajib dibetulkan sebelum gerbang rilis. Sesuai aturan "jangan sampai rugi", test konkurensi harus membuktikan catch-up GL yang asli, bukan simulasi. Perbaikannya tidak mengubah kode produk dan tidak menahan slice lain.

## Peta urutan kunci (m1)

Urutan resmi: run (`payroll_runs`) → batch (urut id) → item → advisory (GL per batch, hash bukti).

| Jalur                                                                                                                                                          | Urutan kunci                                                                                                                                                                                                                                                                                                                                      | Run lebih dulu?    | Cek beku                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL unfreeze (`0430`)                                                                                                                                          | `payout_grant_consume` hanya UPDATE baris grant, tanpa assert untuk jenis `unfreeze` (`0428:203-250`). Lalu `payout_lock_run_of_batch`: run FOR UPDATE (`0429:32-51`). Lalu semua batch run itu, urut id, FOR UPDATE. Lalu batch target. Lalu INSERT unfreezes (KEY SHARE pada batch yang sudah dipegang).                                        | ya                 | Tidak relevan (jalur ini membuka beku)                                                                                                                                                       |
| Catch-up (`payroll-payout-dispute.service.ts:229-268`)                                                                                                         | Per batch saudara, urut id, di savepoint: `recoverPayoutGlOfBatch` (`payroll-payout-gl.service.ts:1658`). Fungsi itu memanggil `loadBatchRunFirst` (run sudah dipegang, re-entrant), advisory GL (`:1362`), `resolvePendingSettles` (`:899`), lalu postings. Setelah itu `settleRunAndAnnounce` dan `payout_run_settle` (assert_open re-entrant). | ya                 | Batch saudara yang masih beku disaring oleh `batchIsNotFrozenSql`. Error DB dilempar ulang, sehingga seluruh unfreeze rollback. Error HttpError/AccountingError diserahkan ke job pemulihan. |
| Worker fase 1 `completeKey` (`payroll-payout-proof-backfill.service.ts:405-416`)                                                                               | `lockBatchesBeforeHashes([batch])`: run FOR UPDATE urut id, lalu batch FOR UPDATE urut id (`:373-401`). Lalu hash bukti (advisory). Lalu baris.                                                                                                                                                                                                   | ya (baru dari 923) | Tidak ada cek. Backfill memang diizinkan saat beku (0428) dan bukan langkah uang.                                                                                                            |
| Worker fase 2 `bindKey` (`:752-779`) dan `bindHistoricalOperation` (`:612-630`)                                                                                | Semua run dari grup key (urut id), lalu semua batch (urut id), lalu hash bukti, lalu `payout_backfill_bind` (INSERT binding, FK ke batch yang sudah dipegang). Satu transaksi per key. `markStuck` berjalan di transaksi terpisah setelah rollback.                                                                                               | ya (baru dari 923) | Sama dengan fase 1                                                                                                                                                                           |
| Confirm, resolve, return, tunai, export (`payroll-payout-manual.service.ts`)                                                                                   | `loadBatchRunFirst` (`payroll-payout.service.ts:582`): run FOR UPDATE, lalu batch. Lalu item FOR UPDATE. Lalu hash bukti. Lalu fungsi SQL (assert_open re-entrant).                                                                                                                                                                               | ya                 | PAYOUT-79 di SQL (`payout_grant_consume` / `assert_open`)                                                                                                                                    |
| Correction dan overpaid (`payroll-payout-correction.service.ts:434`, `payroll-payout-overpaid-route.service.ts:248`, `payroll-payout-overpaid.service.ts:162`) | `loadBatchRunFirst`, lalu item, lalu `bindProofToOperation` (hash bukti)                                                                                                                                                                                                                                                                          | ya                 | Di SQL                                                                                                                                                                                       |
| Submit dan approve (`payroll-payout.service.ts:1443`, `:1560`)                                                                                                 | Run FOR SHARE, lalu batch FOR UPDATE, lalu item. Tidak ada upgrade ke FOR UPDATE.                                                                                                                                                                                                                                                                 | ya                 | Sebelum kunci, lalu diulang di bawah kunci run                                                                                                                                               |
| Consumer `payroll.locked` (`payroll-gl-consumer.ts:298`, `:321`)                                                                                               | Run FOR UPDATE, lalu postJournal, lalu `resolvePendingSettles` (advisory GL per batch, urut id)                                                                                                                                                                                                                                                   | ya, satu run       | `batchIsFrozen` setelah advisory                                                                                                                                                             |
| `recordPostingSource` (`payroll-payout-source.service.ts:100-215`)                                                                                             | Grant di koneksi lain, sudah commit sebelum kunci apa pun. Lalu run, batch, advisory GL, posting, lalu savepoint recover.                                                                                                                                                                                                                         | ya                 | Di SQL lewat `payout_grant_consume`, dengan `p_batch` terisi                                                                                                                                 |
| Job pemulihan GL (`worker/payout-gl-recovery.job.ts:94`)                                                                                                       | Satu transaksi per batch: `recoverPayoutGlOfBatch`                                                                                                                                                                                                                                                                                                | ya                 | Setelah kunci                                                                                                                                                                                |
| Recon (`payroll-payout-recon.service.ts:1139`)                                                                                                                 | Hanya baca dan `payout_recon_flag`. Tidak mengunci run atau batch.                                                                                                                                                                                                                                                                                | tidak berlaku      | tidak berlaku                                                                                                                                                                                |
| Reversal run (`payroll-run-reversal.service.ts`)                                                                                                               | Advisory bulan pajak, lalu PPh21, lalu run FOR UPDATE. Run yang punya batch payout ditolak.                                                                                                                                                                                                                                                       | ya, satu run       | Baca saja                                                                                                                                                                                    |
| Lock run payroll (`payroll-run-lock.service.ts:385-404`, `payroll-run-pph21.service.ts:302-351`)                                                               | Advisory bulan, lalu run baru FOR UPDATE, lalu run prior FOR SHARE `ORDER BY id`. Lalu INSERT `payroll_run_month_priors` (KEY SHARE, urut id).                                                                                                                                                                                                    | tidak berlaku      | tidak berlaku                                                                                                                                                                                |
| Trigger beku 0428 (batches, items, bank_transfer_files, gl_postings, payroll_runs)                                                                             | Hanya membaca `payout_batch_frozen`. Tidak ada FOR UPDATE, advisory, atau kunci run.                                                                                                                                                                                                                                                              | tidak berlaku      | ya                                                                                                                                                                                           |

Analisis siklus:

- Semua jalur mengunci run lebih dulu. Karena itu jalur yang menyentuh satu run diserialkan di baris run itu.
- Jalur yang memegang lebih dari satu run hanya dua: worker `bindKey` (FOR UPDATE, urut id) dan lock run payroll (prior FOR SHARE, urut id). Keduanya memakai urutan id yang sama, jadi tidak ada siklus antar-run.
- Hash bukti dikunci lintas tenant (`payout-proof:<sha>`), tetapi selalu paling akhir dan terurut. Tidak ada transaksi yang memegang hash lalu meminta run atau batch.
- Kunci tambahan di 0430 (semua batch run) praktis berlebih, karena run FOR UPDATE sudah menyerialkan semuanya. Tetap layak dipertahankan sebagai pertahanan berlapis.

## Temuan

### P2-1: Test `[923-unfreeze-first]` hanya menyimulasikan catch-up, jadi pemulihan GL asli tidak diuji saat berpapasan dengan worker

Berkas: `apps/api/src/test/payroll-payout-923-backfill-unfreeze.test.ts:271-312`, khususnya `:288-293`.

**Masalah:**

- Setelah SQL unfreeze, test menjalankan satu `SELECT ... FROM payroll_disbursement_batches WHERE id = A FOR UPDATE` sebagai pengganti catch-up. Komentarnya: "The first operation recoverPayoutGlOfBatch performs on sibling A".
- Komentar itu tidak lagi benar. `recoverPayoutGlOfBatch` mengambil run dulu lewat `loadBatchRunFirst`, lalu advisory GL, `resolvePendingSettles`, postings, `repostFeesSoft`, `settleRunAndAnnounce`, dan `payout_run_settle`.
- `catchUpAfterUnfreeze` (`payroll-payout-dispute.service.ts:229`) tidak diekspor, dan test juga tidak memanggil `unfreezeDisbursementBatch`.

**Skenario risiko:**

- Kalau kelak catch-up atau `recoverPayoutGlOfBatch` mengambil kunci baru sebelum run, siklus SO 920 bisa kembali dan test ini tetap hijau. Contohnya advisory GL dipindah sebelum `loadBatchRunFirst`, atau batch saudara dikunci tanpa urutan.
- Test ini juga hijau bila hanya salah satu perbaikan yang ada: SQL 0430 saja, atau run-first di TS saja. Test lain (`[923-unfreeze-sorted-batches]`, `[923-worker-run-before-batch]`) menutup tiap lapisan secara terpisah. Kombinasi dengan GL asli tidak pernah diuji.
- Asersi `expectReleasedOnce` (net/fee tidak berubah) berjalan tanpa posting GL catch-up sama sekali. Jadi bukti "jurnal net dan fee tepat setelah catch-up di bawah konkurensi" yang diminta SO 920 belum ada.
- Bukti merah-dulu hanya ada di log `/tmp/payout923-red.log`, di luar repo.

**Usul test:**

1. Ekspor `catchUpAfterUnfreeze`, khusus untuk test. Alternatifnya, beri `unfreezeDisbursementBatch` hook opsional `afterSql` yang hanya dipakai test.
2. Di test 1, jalankan SQL unfreeze dan `catchUpAfterUnfreeze` asli pada transaksi drizzle yang sama. Koneksi `c` dibungkus `drizzle(c)` dan diberi `deadlock_timeout = 100ms`.
3. Siapkan fixture dengan posting GL A yang tertahan selama beku, sehingga catch-up benar-benar memosting.
4. Barrier: worker antre (`pg_blocking_pids`), lalu catch-up asli dijalankan.
5. Asersi: tanpa `40P01`, unfreeze tercatat sekali, posting GL A terbentuk tepat sekali, total net dan fee jurnal sama dengan nilai yang diharapkan, dan tidak ada item atau batch yang berubah jumlahnya.
6. Bukti merah: kembalikan `lockBatchesBeforeHashes` dan 0430 ke versi 0429 sekaligus, lalu pastikan test merah karena `40P01`.
7. Tambahkan varian dengan hanya salah satu perbaikan dikembalikan. Catat hasilnya di PROGRESS.

### P3-1: Test `[923-other-tenant]` tidak membuktikan predikat tenant

Berkas: `payroll-payout-923-backfill-unfreeze.test.ts:513-573`.

- `lockBatchesBeforeHashes` dijalankan lewat `withTenant` tenant B. RLS sudah menyembunyikan baris tenant A, sehingga test tetap hijau walau `r.tenant_id = ${tenantId}` atau `tenant_id = ${tenantId}` di `payroll-payout-proof-backfill.service.ts:380-400` dihapus.
- Test juga tidak memastikan run dan batch milik tenant B benar-benar terkunci.

**Usul:**

- Jalankan helper di koneksi owner tanpa RLS, dengan `app.tenant_id` = B dan id batch milik A ikut dikirim.
- Pastikan lewat `FOR UPDATE NOWAIT` dari koneksi lain bahwa baris A tidak terkunci, sedangkan run dan batch B terkunci.

### P3-2: Test `[923-worker-first]` juga hijau di basis, jadi bukan bukti urutan kunci

Berkas: `payroll-payout-923-backfill-unfreeze.test.ts:314-357`.

- Di basis 0429, unfreeze antre di batch B karena worker lama memegang A dan B. Antrean itu bukan di run. Worker lalu commit tanpa butuh apa pun dari unfreeze.
- Akibatnya `blockedBy(workerPid)` dan semua asersi tetap lulus. Test ini hanya menguji keaktifan (liveness).

**Usul:**

- Ubah namanya, atau tambahkan asersi bahwa unfreeze menunggu di relasi `payroll_runs`, misalnya dari `pg_locks` / `pg_stat_activity.wait_event`.
- `blockedBy` di test 1 dan 2 juga hanya membuktikan "diblokir oleh pid", bukan kunci mana yang memblokir.

### P3-3: Test bisa menggantung atau bocor koneksi bila gagal di tengah

Berkas: `payroll-payout-923-backfill-unfreeze.test.ts:337`, `:380-390`; `apps/api/src/test/payroll-payout-fixtures.ts:350`.

- `:386`: `await opening` dipanggil sebelum `opener.query("ROLLBACK")` dan `release()`. Bila `opening` reject, klien bocor.
- Pool owner `max: 3` dipakai penuh oleh test 3 (holder, opener, dan polling). Satu klien yang bocor membuat test berikutnya menggantung sampai timeout 120 detik.
- `:337`: `await ready` tanpa batas waktu. Bila worker gagal sebelum binder dipanggil, test menunggu 120 detik dan `worker` menghasilkan unhandled rejection.

**Usul:**

- Pindahkan `await opening` ke `try/catch` setelah `release()`.
- Gunakan `Promise.race(ready, worker.then(throw))`.

## Diperiksa tanpa temuan

- **Kunci run FOR UPDATE di worker vs INSERT ber-FK.** `payslips`, `bank_transfer_files`, `payroll_run_month_priors`, dan `payroll_rapel_items` mengambil KEY SHARE ke run. Satu-satunya jalur multi-run yang berpapasan adalah lock run payroll. Jalur itu mengunci prior FOR SHARE `ORDER BY id` (`payroll-run-pph21.service.ts:351`) dan menyisipkan prior terurut (`payroll-run-lock.service.ts:633`, `:712`), sama dengan urutan worker. Hasilnya hanya antrean, bukan siklus. `FOR NO KEY UPDATE` hanya akan mengurangi antrean FK. Tidak wajib.
- **Langkah uang saat beku.** 923 tidak mengubah logika beku. Worker hanya menulis binding atau fingerprint, yang diizinkan 0428 dan bukan pembayaran. Catch-up melewati batch yang masih beku karena sengketa saudara.
- **GL ganda atau hilang.** Catch-up per batch berjalan di savepoint. Error DB membuat seluruh unfreeze rollback (`payroll-payout-dispute.service.ts:258`). Posting yang belum siap diambil job pemulihan. 923 tidak mengubah idempotensi posting.
- **Livelock.** Worker 40P01 dicatat `bind_failed` dengan jeda yang membesar. Setelah 923 tidak ada lagi siklus yang bisa memicunya. Antrean kasar per run adalah risiko yang sudah diterima CTO (SO 920).
- **Lintas tenant.** Ada filter tenant di 0430 (subquery target dan batch run) dan di `lockBatchesBeforeHashes`, ditambah RLS. Hash bukti lintas tenant memang disengaja (gerbang global) dan dikunci paling akhir.
- **Determinisme 40P01 di basis (test 1).** `deadlock_timeout = 100ms` hanya diset di sesi `c`, sedangkan worker memakai 1 detik. Karena itu korbannya selalu `c`, dan barrier memakai `pg_blocking_pids`, bukan sleep. `FOR UPDATE NOWAIT` di test 3 sampai 6 deterministik karena LockRows berada di atas Sort.
- **Migrasi.** Fungsi diganti oleh `legend_payout` (pemilik tetap). `CREATE OR REPLACE` mempertahankan grant EXECUTE. Registry `data-import-registry.test.ts` sudah mencatat 0663 (sekarang 0430) dan 0662.

## Rencana kerja (untuk CTO)

1. Satu kartu test-only P2-1 dan P3-1 sampai P3-3, dikerjakan engineer Sonnet. Berkas: `apps/api/src/test/payroll-payout-923-backfill-unfreeze.test.ts`, plus ekspor khusus test di `payroll-payout-dispute.service.ts`.
2. Bukti selesai:
   - Test baru merah di basis 0429 (log disimpan di repo atau di komentar kartu) dan hijau di m1.
   - `LEGEND_TEST_FILES` untuk berkas 923 dan 920 hijau.
3. Tidak perlu review architect ulang bila kode produk tidak berubah, kecuali satu ekspor. Cukup satu reviewer sonnet.
