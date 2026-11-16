# 905 fixer log (putaran 3-5, 16 Nov). Untuk fixer berikutnya

Perintah uji penuh (dari root, ~4 menit; 47 berkas):
`LEGEND_TEST_FILES="$(cat $S/files.txt)" heavy pnpm test > $S/rN.log 2>&1`
dengan `S=/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-2e31f421/3ee34dd7-a818-4770-a5ac-91286fe60c45/scratchpad`. `$S/files.txt` = `src/test/payroll-payout*.test.ts` + `migrator-role` + `data-import-registry` (path relatif apps/api). Berkas vitest berjalan serial (`fileParallelism: false`).

Hitungan: putaran 2 = 172 gagal / 446 lulus. Putaran 3 (r3) sama. r4 (setelah 0650 grant batch + 2 perbaikan test) = 76 gagal. r5 (setelah 0650 bagian 2 + 881-guard) = **46 gagal / 572 lulus** (log `$S/r5.log`). Setelah r5 saya mengubah lagi (lihat "Belum diuji"), belum ada putaran uji sesudahnya. Fail-first followups BELUM dijalankan.

## Perubahan SQL / service (semua belum di-commit)
1. `apps/api/drizzle/0650_payout_trusted_batch_lock.sql` + entri journal `idx 408 / 0650` (`when 1795000000650`):
   - (a) `GRANT UPDATE (updated_at) ON public.payroll_disbursement_batches TO legend_payout`. Sebab: semua fungsi tepercaya memakai `SELECT ... FOR UPDATE` pada batch; PostgreSQL minta hak UPDATE minimal satu kolom. Tanpa ini 54x `permission denied for table payroll_disbursement_batches` (42501). Tidak ada fungsi yang meng-UPDATE batch; kolom lain tetap tertutup.
   - (b) `CREATE OR REPLACE app.payroll_payout_gl_postings_insert_commit_check()` (milik 0643): cabang fee kini hanya untuk kind `settle`/`settle_pending`/`settle_skipped`. Sebab: posting `overpaid`/`return`/`correction` dimasukkan TS dengan `fee_posted` default true dan `fee_idr > 0`, sedangkan `payout_fee_journal_ok` hanya mengenal jurnal `payroll-payout-fee:<item_set_hash>`; COMMIT gagal PAYOUT-37 (22 tes). Cabang `settle` tidak diubah. CATATAN untuk architect: ini melonggarkan 0643 untuk kind non-settle; fee overpaid tetap dicek jurnalnya oleh `payout_item_journal_ok` di commit check item (0648). Laporkan ke CTO.
2. Tidak ada perubahan service (debug sementara di `payroll-payout.service.ts` sudah dihapus; berkas itu bersih).

## Tes yang disesuaikan (alasan)
- `src/test/payroll-payout-905-posting-source.test.ts`: `lockedEnvelope(..., aggregateId = runId)` dan `queueLocked` memakai agregat acak bila agregat run sudah punya event outbox (setelah handover ada `payroll.paid` sequence 1). Sebab: 7x `domain_event_outbox_aggregate_sequence_key`. Meniru 881-source.
- `payroll-payout-881-source.test.ts`, `888-stepup.test.ts`, `payroll-payout-evidence.test.ts`: query premis `SELECT ... FROM "session" WHERE revoked_at IS NULL AND user_id=$1` ditambah `AND id NOT LIKE 'payout-fixture-session-%'`. Sebab: `signedInClient` kini membuat sesi fixture per user (tanpa `mfa_challenge_verified_at`), `rows[0]` mengambil sesi itu (3 tes "premise: a real challenge stamped the session").
- `payroll-payout-fixtures.ts`: import `recordOverpaidItems` dan helper baru `W.proposeOverpaid(batchId, itemId, evidenceKey, note, recorder)` = langkah satu (usulan) lewat service rute, proposer = APP2/APP3/APP pertama yang bukan `recorder`. Sebab: `app.payout_overpaid_record` kini menolak item tanpa proposal orang lain (PAYOUT-63 "no overpaid proposal").
- Pembungkus `recordOverpaidItem`/`recordOverpaid` di `hardening`, `so-fixes`, `source-active`, `870-gl-pending`, `888-guards`: jadi `async`, memanggil `W.proposeOverpaid` dulu lalu langkah dua langsung. Komentar `// 905:`.
- `payroll-payout-881-guard.test.ts`: (1) `seedPosting` memakai `W.asTenant(..., true)` (replica, trigger mati) karena insert guard PAYOUT-70 dan insert commit check 0643 menolak baris awal tes (sumber tercatat / settle tanpa jurnal); (2) tes "accepts NULL -> account on settle_skipped/settle_pending" diganti "refuses ... by the app role (905: payout role only)": harapan jadi `GUARD_CODE` dan sumber tetap NULL (0646 menutup pengisian sumber untuk legend_app; jalur sah dibuktikan di `905-posting-source`).
- `payroll-payout-897-proof-binding.test.ts` tes `[897-claim-null-hash-refused-by-db]`: `insert(content, stored, asApp=false)`; cek NOT NULL-hash memakai owner (`W.asTenant`), ditambah satu asersi baru: app role INSERT claim = `42501` (0648 mencabut INSERT). Intinya tidak melemah: CHECK 23514 tetap dibuktikan.

## Belum diuji setelah r5 (perubahan terakhir: 897-proof-binding dan wrapper overpaid, fixture)
Wrapper overpaid + `proposeOverpaid` ditulis setelah r5 selesai, jadi 13 tes overpaid (hardening x4, so-fixes x2, source-active x4, 870-gl-pending, 888-guards x2) belum terbukti hijau. Mungkin perlu: proposer sama dengan recorder pada tes konkuren; `bindProofToOperation` di langkah dua langsung (`operationItemIds` tak diberikan); tes yang mengharapkan penolakan di langkah dua tetapi langkah satu sudah menolak dengan kode lain.

## Sisa gagal di r5 (46), kelompok, pesan pertama, dugaan penyebab
1. **Backfill gagal diikat (897-backfill-fair x3: sweeps-reach-valid-targets, hash-conflict-listed, resolved-clears-stuck; 900-backfill-lock x1: phase2-fair "50 valid ops bound: expected 0")**. Dugaan: `insertLegacyClaims` (897) dan fixture 900 menyimpan `item_set_hash` acak (`sha256("897-set-"+key)`) dan klaim tanpa item; `historicalItemIds` (`payroll-payout-proof-backfill.service.ts:~592`) melempar "historical operation item set not found" karena `itemSetHashOf(ids) !== operation.itemSetHash`, lalu `payout_backfill_bind` menghitung ulang hash (desain: SQL cocokkan dengan `app.payout_proof_operations()`). Perbaikan tes: isi klaim legacy dengan `return_evidence_key` pada item nyata dan `item_set_hash` = hash item itu (cara baca `historicalItemIds`). Cek juga `resolveStuck` (UPDATE `resolved_at` oleh legend_app): lihat apakah gagal karena hak/trigger (resolved-clears-stuck). Mungkin 897-proof-binding/900 lain ikut.
2. **900-global-gate x2** (`gate-other-tenant-history-holds`, `half-finished-cross-tenant`): harap `PAYOUT_PROOF_REUSED`, dapat `PAYOUT_PROOF_FINGERPRINT_PENDING` setelah sweep B. Dugaan sama dengan 1 (operasi legacy tidak bisa diikat, gerbang tetap menahan). Juga kemungkinan kebocoran gerbang global dari tes 897/900 yang gagal ke berkas serial sesudahnya (905-recon: banyak `PAYOUT_PROOF_FINGERPRINT_PENDING`). Perbaiki 1 dulu, lalu ukur ulang.
3. **881-recovery x2**: `la22h-held-batch-with-over-500-postings` PAYOUT-70 (insert 501 posting held dengan sumber; seed perlu replica seperti 881-guard atau sumber NULL); `qq68t-historical-fee-flag-without-journal` "the sweep journals nothing: expected 40 to be 38" (belum diselidiki; mungkin akibat 0650(b) atau seed).
4. **905-followups x3**: `fu-correction-two-items-control` 422 `itemIds` maks 1 (batas satu item di kontrak shared; tes harus memakai satu item per koreksi atau dua operasi); `fu-closed-key-resolve-failed` dan `-not_sent`: "the call must be refused: expected Error: Failed query: update payroll_disb… to be an instance of HttpError". Itu 0649(c) menolak dengan 23514 mentah dari UPDATE langsung; tes mengharapkan HttpError (pemetaan 23514 -> 409 ada di mapper rute, bukan di service). Putuskan: tes memanggil lewat rute/mapper, atau cek `code === "23514"`.
5. **905-posting-source x3**: `direct-fill-other-account-refused` ("no journal appeared: expected 1 to be 0"), `direct-fill-and-settle-refused` ("expected 3 to be 2"), `function-forged-actor-refused` ("the app role may call it; the actor check refuses: expected '42501' not to be '42501'"). Dugaan: fungsi `payout_posting_record_source` belum GRANT EXECUTE ke legend_app, atau tes menghitung jurnal yang dibuat setup; baca 0646 (GRANT EXECUTE) dan `heldCashWithoutSource`.
6. **905-proof-closure x7** (`two-person-gate-false`, `same-person`, `requester`, `password-stepup`: "expected false to be true"; `tenant-scope`: stage tidak `closed`; `money-correct-overpaid`: 200 bukan 409; `money-return`: `PAYOUT_GUARD_REFUSED`). Belum diselidiki; kemungkinan bergantung pada gerbang global (kelompok 1-2) dan pada kunci yang tidak "stuck" karena backfill tidak membuat baris stuck. Selidiki setelah 1-2.
7. **905-recon x9**: `TypeError: Cannot read properties of undefined (reading 'tenantId')` x3 (kemungkinan memanggil `actorOf(...)`/`payoutActorSession` dengan argumen salah atau memakai `W.xxx` yang tidak ada); `PAYOUT_ITEM_NOT_OVERPAYABLE` (skenario overpaid tidak punya pembayaran lain yang sukses); `PAYOUT_PROOF_FINGERPRINT_PENDING` x5 (kebocoran gerbang global, lihat 2).
8. **core.test.ts `l4-succeeded-frozen`**: harap null, dapat error `PAYOUT-60: item ... ` dari guard item (A1: perubahan keluar dari status final sekarang hanya legend_payout). Tes lama yang sengaja diubah 905: sesuaikan harapan ke 23514 PAYOUT-60 dengan komentar `905:`.
9. **hardening.test.ts `db-return-two-people`**: kode 23514 `payroll_disbursement_items_guard() line 128` (succeeded->returned lewat SQL biasa kini hanya legend_payout). Sama: sesuaikan ke 23514 (A1/guard) dengan komentar `905:`.
10. **897-proof-binding x1 lain / 891-correction**: 891-not-overpaid dan 888-overpaid-route lulus setelah 0650; tidak ada sisa.

## Sebelum selesai
- Jalankan fail-first `src/test/payroll-payout-905-followups.test.ts` dua kali: sekali dengan entri journal 0649 dan 0650 dihapus sementara (salin `drizzle/meta/_journal.json` dulu, pulihkan, pastikan `git diff` journal hanya menambah 0650), sekali penuh. Catat hasil.
- Jangan commit. Laporkan pelonggaran 0650(b) ke CTO/architect.
- `docs/PROGRESS.md` berstatus modified tetapi bukan dari saya.

---
# Putaran 6-7 (fixer lanjutan, 16 Nov). Hitungan terkini

**r7 (suite penuh 47 berkas): 32 gagal / 586 lulus / 13 todo** (log `$S/r7.log`). Sebelumnya r5 = 46 gagal / 572 lulus. Tidak ada perubahan SQL/service baru. Tidak commit.
Catatan: jalankan suite dari root repo (bukan `apps/api`; dari `apps/api` vitest berjalan tanpa env dan menjalankan semua tes).

## Perubahan tes baru (semua `905:`)
- `payroll-payout-fixtures.ts`: helper baru `W.legacyReturnItem(itemId, key)`: klon item sebagai `returned` (replica, trigger mati; `attempt_no` acak >= 1000, `idempotency_key` mengikuti CHECK, `return_note` terisi) dengan `return_evidence_key = key`; mengembalikan hash set satu item. Sebab: `app.payout_backfill_bind` menghitung ulang hash dari item nyata, klaim legacy dengan hash acak tidak pernah bisa diikat.
- `897-backfill-fair.test.ts`: `insertLegacyClaims(..., realItems = true)` memakai helper di atas (kunci yang memang harus gagal/hilang diberi `false`).
- `900-backfill-lock.test.ts` (`900-phase2-fair`): kunci `ok` memakai item nyata. LULUS sekarang.
- `900-global-gate.test.ts`: `historicalClaimOfB` menyisipkan item `returned` untuk tenant B (klon dari batch A, replica) dan klaim memakai hash item itu; `tenantB` mengembalikan `sourceBatch`; cleanup menghapus `payroll_disbursement_items` B.
- `881-recovery.test.ts`: `clonePosting` berjalan dengan `asTenant(..., true)` (replica; PAYOUT-70). Kedua tes 881-recovery (la22h, qq68t) LULUS (qq68t adalah efek berantai la22h).

## Sisa gagal r7 (32), menurut berkas
- 897-backfill-fair `897-log-no-keys` (1): kunci hilang; setelah saya beri `realItems=false` masih gagal di r7 (belum diselidiki; mungkin dua klaim lintas tes/`stuck 1` tidak muncul).
- 900-global-gate (2): `gate-other-tenant-history-holds`, `half-finished-cross-tenant`: setelah sapuan B masih `PAYOUT_PROOF_FINGERPRINT_PENDING`, bukan REUSED. Item B kini ada; dugaan: sapuan B tidak memfingerprint/mengikat (hak B pada `payroll_disbursement_items`? atau klaim B tanpa baris `evidence_files` + objek storage di scope B). Perlu diselidiki.
- 888-guards (2) `overpaid-accounting-off-*`, hardening `overpaid-slip-not-open`, so-fixes `overpaid-frozen-source-inactive`, source-active `overpaid-inactive-source` (5): wrapper overpaid dua langkah (lihat "Belum diuji" di atas); sekarang terbukti sebagian gagal.
- 905-followups (3 dari 7): `fu-correction-two-items-control` (batas itemIds maks 1), `fu-closed-key-resolve-failed`/`-not_sent` (23514 mentah vs HttpError). Keputusan belum diambil.
- 905-posting-source (3), 905-proof-closure (7), 905-recon (9): tidak disentuh. Catatan: `payroll-payout-recon.service.ts` dan `payroll-payout-proof-closure.routes.ts` sedang diedit implementer lain (perintah CTO), tidak saya sentuh; kegagalan recon/closure kemungkinan butuh perubahan di sana.
- core `l4-succeeded-frozen`, hardening `db-return-two-people` (2): harapan lama; sesuaikan ke 23514 PAYOUT-60 (belum dikerjakan).

## Fail-first followups (`905-followups.test.ts`)
- Tanpa entri journal 0649 dan 0650 (sementara dihapus, journal dipulihkan, `git diff` journal bersih): **6 gagal / 1 lulus** (insert-cash-foreign-source-held, -settled, correction-needs-own-posting, correction-two-items-control, closed-key-resolve-failed x2).
- Penuh (dengan 0649+0650, di r7): **3 gagal / 4 lulus** (tiga yang tercantum di atas, semua butuh keputusan, bukan bug SQL).

## Pelonggaran 0650(b) tetap harus dilaporkan ke CTO/architect (lihat atas).

## Keputusan engineer untuk fixer 3 (16 Nov)
- `[905-fu-correction-two-items-control]`: kontrak = 1 item per koreksi → ubah kontrol jadi satu item (komentar `905:`), asersi P2-2 tetap.
- `[905-fu-closed-key-resolve-*]`: `W.resolve` memanggil service langsung, mapper Express tidak ikut; di HTTP 23514 → 409 lewat `payoutGuardErrorMapper`. Test terima HttpError 4xx ATAU error PG `23514` (penolakan), item tetap `exported`. Jangan longgarkan asersi status.
- 905-recon / 905-proof-closure / 905-posting-source: boleh ubah `services/payroll-payout-recon.service.ts`, `routes/payroll-payout-proof-closure.routes.ts`, service closure, bila akar ada di implementasi. Bila test salah asumsi (nama fungsi, bentuk data), sesuaikan test dengan komentar `905:` tanpa melemahkan aturan uang.
- `l4-succeeded-frozen`, `db-return-two-people`: sesuaikan kode error yang diharapkan ke perilaku 905.
- Overpaid two-step wrappers, 900-global-gate (2), `897-log-no-keys`: cari akar.

# Putaran fixer 3 (16 Nov)

**r8 (suite penuh, sebelum perubahan fixer 3): 32 gagal / 586 lulus / 13 todo** (log `$S/r8.log`), sama dengan r7. Tidak ada perubahan SQL/service. Tidak commit.

## Tes yang disesuaikan (semua `905:`)
- `payroll-payout-core.test.ts` `[l4-succeeded-frozen]`: kontrol succeeded -> returned (dua returner) lewat SQL app role kini diharapkan 23514 PAYOUT-60, status tetap `succeeded` (A1). Jalur return dua orang dibuktikan lewat service (proposal tests).
- `payroll-payout-hardening.test.ts` `[db-return-two-people]`: sama, kontrol diharapkan 23514 PAYOUT-60, status tetap `succeeded`.
- `payroll-payout-hardening.test.ts` `[overpaid-slip-not-open]`: return saudara (setup, bukan aturan yang diuji) ditulis sebagai histori (`W.asTenant(..., true)`, replica).
- `payroll-payout-fixtures.ts` `W.proposeOverpaid`: dilewati bila proposal terbuka dari proposer yang sama dengan bukti yang sama sudah ada. Sebab: tes 888-guards/so-fixes/source-active memanggil wrapper dua kali (ditolak dulu, lalu diterima), panggilan kedua kena `PAYOUT_OVERPAID_SAME_PERSON`.
- `payroll-payout-905-followups.test.ts`: `[905-fu-correction-two-items-control]` jadi satu item (Budi), asersi: Budi succeeded + 1 posting + jurnal bertambah, Siti tetap failed tanpa posting, posting Andi tidak berubah. `[905-fu-closed-key-resolve-*]`: terima HttpError 4xx ATAU PG 23514; asersi status `exported` dan `gl_posting_id` NULL tetap.
- `payroll-payout-905-posting-source.test.ts`: (1) `journalCount()` "before" diambil SETELAH `heldCashWithoutSource()` (setup memposting jurnal lock sendiri) di tiga tes; (2) `[905-source-function-forged-actor-refused]`: `payout_assert_actor` sendiri memakai 42501 (PAYOUT-39/40), jadi asersi "bukan 42501" diganti `message` cocok `/PAYOUT-(39|40):/` (lebih ketat: membuktikan pemeriksaan aktor, bukan grant yang hilang).

## Hasil terarah
- core, hardening, followups, posting-source, 888-guards, so-fixes, source-active: semua lulus (t4 + t5: 127 + 7 lulus).

- `payroll-payout-905-recon.test.ts`: (1) `runRecon` memanggil `reconcileTrustedPayouts(W.scope(), { storage, after })` per halaman sampai habis (header berkas sendiri bilang hanya `runRecon` yang diubah bila signature beda); sebab 3x `TypeError 'tenantId'`. (2) `overpaidWorld`: batch susulan membayar slip dulu (overpaid butuh percobaan lain yang sukses, `PAYOUT_ITEM_NOT_OVERPAYABLE`). (3) `afterEach` tidak lagi menghapus binding/claim/proposal/correction/hash/contest kunci yang dilacak, hanya baris exception recon. Akar 5x PENDING: menghapus claim/binding sementara item tetap membawa `return_evidence_key` meninggalkan operasi tak terikat di `app.payout_proof_operations()`, jadi gerbang global tertahan untuk semua tes sesudahnya (juga lintas berkas).

## Hasil terarah
- core, hardening, followups, posting-source, 888-guards, so-fixes, source-active: semua lulus (t4 + t5: 127 + 7 lulus).
- 905-recon sendiri (t9): **8 lulus / 2 gagal**.

## Sisa, butuh keputusan (perubahan service recon di area uang, tidak saya tebak)
- `[905-recon-pre-boundary-skipped]`: item `overpaid` sesudah batas tanpa attestation tidak di-flag. `listOperations` (`payroll-payout-recon.service.ts:119-203`) hanya membaca operasi dari corrections / overpaid_proposals / return_claims / postings; item yang dipindah langsung tanpa baris operasi tidak pernah terlihat. Perlu sumber operasi baru "item final sesudah `payout_trusted_since()` tanpa operasi" + alasan flag. Keputusan desain: architect.
- `[905-recon-tampered-proof]`: tes mengubah `payroll_payout_proof_hashes.sha256`; recon tidak mendeteksinya (kemungkinan membandingkan `bindings.content_sha256` dengan file, bukan `proof_hashes`). Belum diselidiki lebih jauh.
- 905-proof-closure (7): belum diselidiki. Saat berjalan bersama recon lama, gagal juga sendiri-sendiri (t6); sebagian mungkin akibat kebocoran gerbang dari cleanup recon yang sekarang diperbaiki. Ukur ulang dulu.
- 900-global-gate (2), 897 `[897-log-no-keys]` (1): belum disentuh.
- Suite penuh belum dijalankan ulang setelah perubahan fixer 3.
