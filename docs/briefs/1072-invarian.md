# 1072 Invarian uang: hold konflik, echo refund, kredit DP

Architect, 18 Nov 2026. Basis 1c9e3fcaa plus working tree (diff Tugas B belum di-commit). Nomor baris = working tree saat ini.
Istilah: R = refund kita (`payment_refunds`), fact = baris `payment_provider_refunds`, T = transaksi penyedia (`provider_payment_ref`).

## I1. Kapan dana boleh dibuka (hold ditutup)

Invarian: dana intent terbuka hanya bila tidak ada hold terbuka, dan hold hanya ditutup oleh (a) finance `not_this_intent`, (b) finance `counted_against_intent` yang lebih dulu mencatat fact sehingga batas refund sudah memuat uangnya, atau (c) sistem menutup hold live-own setelah refund-nya tercatat dan tidak ada refund kita yang masih jalan; webhook, replay, dan poller tidak pernah menutup hold, dan laporan sukses yang ditolak tidak boleh hilang tanpa hold.

- Pelanggaran 1 (A1): `apps/api/src/services/payment-webhook.service.ts:1840-1856`. Updater menolak nominal (`payment-refund.service.ts:4096`), webhook hanya audit lalu `REJECTED_CONFLICT`, tanpa hold. Dana tidak pernah ditahan, jadi refund baru Rp70.000 lolos guard (`payment-provider-refunded-guard.ts:35-39`).
- Pelanggaran 2 (A3): `apps/api/src/services/refund-recon-hold.service.ts:848-857` memanggil `countHold` untuk hold konflik tanpa cek alasan; `:577-582` hanya cek `payment_provider_refunds`; `:603-644` mengikat fact anonim dan menutup hold.
- Fix: lihat I2 (A1) dan I4 (A3).

## I2. Kapan laporan penyedia dianggap echo refund kita (webhook matched DAN recorder, satu aturan)

Invarian: laporan sukses bertanda tangan adalah echo R hanya bila intent sama, T sama dengan transaksi sumber R (atau laporan tidak menyebut T), refund id sama dengan ref R (atau kunci `refund:<R>`), dan nominal <= nominal R; laporan sukses yang tidak memenuhi itu dicatat sebagai fact atau ditahan, tidak pernah diabaikan; laporan yang nominalnya lebih besar dari R selalu jadi hold `HOLD_TRANSACTION_CONFLICT` senilai laporan, dengan kunci dedup yang sama di kedua pintu.

- Recorder sudah benar: `apps/api/src/services/payment-provider-partial-refund.ts:629-682` (`echo && amountIdr <= echoedIdr`, selain itu `fileTransactionConflictHold` `:473-510`).
- Pelanggaran: jalur matched `payment-webhook.service.ts:1840-1856` (lihat I1).
- Fix minimum (I1): di blok `catch` 409 itu, sebelum `ignoredWith("REJECTED_CONFLICT")`, bila `status === "succeeded"`, `match.kind !== "payment_object"`, `facts.amountIdr !== undefined`, dan `facts.amountIdr > Number(refund.amountIdr)`, panggil fungsi ekspor BARU di akhir `payment-provider-partial-refund.ts`, misalnya `fileOwnRefundSurplusHoldInTx(tx, context, { intentId, providerRefundId, providerPaymentRef, amountIdr, outletId })`. Fungsi itu: kunci intent `FOR UPDATE`, lalu `lockDepositIntentsExclusive`, lalu insert hold alasan `HOLD_TRANSACTION_CONFLICT_REASON`, `providerRefundIdKind: "provider"`, amount = laporan, `webhookEventId` = hash yang PERSIS sama dengan `fileTransactionConflictHold` (`refund_recon_hold.transaction_conflict\0tenant\0intent\0T\0refundKey`), `onConflictDoNothing`, alert sekali. T = `facts.paymentId ?? facts.payment?.id ?? refundSourcePayment(...)?.providerRef ?? intent.providerRef`. R tetap ditolak (tidak diselesaikan dengan nominal salah). Nominal lebih kecil: tetap tolak tanpa hold (recorder juga menganggapnya echo).
- Test: `apps/api/src/test/refund-1072-a1-matched-echo-hold.test.ts` (sudah ada, a1-01..04). Tambah satu kasus: event matched X/T 80k lalu `payment.refunded` X/T 80k (dan urutan sebaliknya) menghasilkan TEPAT satu hold.

## I3. Kapan kredit DP boleh dikurangi atau dipulihkan

Invarian: hold terbuka mengurangi pool DP (kredit asli dan pindahan) sebesar nominalnya dikurangi bagian yang sudah tercakup fact terhitung (bukan echo R) dengan intent, jenis id, id, dan T yang sama; hold `HOLD_TRANSACTION_CONFLICT` selalu mengurangi penuh sampai di-resolve; kredit hanya pulih saat hold ditutup sesuai I1, tepat sekali.

- Pelanggaran (A2): `apps/api/src/services/reservation-deposit-credit.ts:160-177` (`openReconHoldIdrSql`). `NOT EXISTS` membuang hold bila ada fact dengan id dan T sama, tanpa cek nominal, alasan, atau echo. Fact 40k yang sudah jadi echo R menyembunyikan hold 100k, sehingga kredit 60k terbuka.
- Fix minimum (I2): ganti `sum(h.amount_idr) ... AND NOT EXISTS (...)` menjadi `sum(CASE WHEN h.reason = <CONFLICT> THEN h.amount_idr ELSE greatest(h.amount_idr - coalesce((SELECT sum(hr.amount_idr) FROM payment_provider_refunds hr WHERE <kunci sama seperti sekarang> AND NOT EXISTS (SELECT 1 FROM payment_refunds own WHERE own.status <> 'failed' AND ${ownRefundEchoesFactSql("own","hr")})),0),0) END)`. Kasus lama tetap sama: fact >= hold memberi 0. Satu fungsi ini dipakai `allocationCredits` (`:222`, `:226`) dan pool pindahan (`:293`), jadi keduanya ikut. Konstanta alasan: jangan impor dari `payment-provider-partial-refund.ts` (file itu mengimpor modul ini, jadi siklus). Pakai literal di SQL plus satu assertion test bahwa literal sama dengan `HOLD_TRANSACTION_CONFLICT_REASON`.
- Test: perluas `apps/api/src/test/refund-1063-b-conflict-hold-dp-credit.test.ts` dengan skenario A2 (DP T 100k, R 40k tanpa ref, fact X/T 40k force, R completed ref X, `payment.refunded` X/T 100k). Assert: kredit asli dan pindahan 0, pesanan tidak bisa memakai 60k, replay tidak membuka, `not_this_intent` memulihkan sekali, dua urutan hold-vs-apply dengan barrier. Kontrol: hold live-own dengan fact non-echo yang nominalnya sama tetap memberi 0 (tidak terhitung dua kali).

## I4. Kapan `same_as_counted` (dan counted apa pun) boleh

Invarian: `counted_against_intent` (identity apa pun) ditolak untuk hold `HOLD_TRANSACTION_CONFLICT` sebelum ada pembacaan fact, pemilihan, binding, atau pencatatan, sehingga hold konflik hanya bisa ditutup `not_this_intent`; untuk hold lain, `same_as_counted` mengikat tepat satu fact yang terbukti belum dipakai hold mana pun (lihat I5).

- Pelanggaran (A3): `refund-recon-hold.service.ts:848-857` (tanpa gerbang alasan), sehingga cabang `:603-644` bisa mengikat fact anonim T2.
- Fix minimum (I3): di `resolveRefundReconHold`, cabang `else` sebelum `countHold` (`:848`): `if (hold.reason === HOLD_TRANSACTION_CONFLICT_REASON) throw transactionConflict();` (409, tidak menulis apa pun). Konsisten dengan `holdNeedsIdentity` `:127` dan keputusan PROGRESS:7193.
- Test: `apps/api/src/test/refund-1072-a3-conflict-hold-no-counted.test.ts` (sudah ada). Cek test lama yang meng-count hold konflik: `refund-1055-a` G2-02 sudah mengharapkan 409.

## I5. Kapan fact legacy pra-0679 boleh dipilih

Invarian: picker hanya boleh memilih fact bila tidak ada hold `same_as_counted` tanpa binding (`matched_fact_id IS NULL`) pada intent dan T itu (atau dengan T NULL); bila ada, pemilihan ditolak (422, hold tetap terbuka) dan tidak ditebak.

- Pelanggaran (A4): `apps/api/src/services/payment-provider-partial-refund.ts:146-175` (`pickUnbound` hanya mengecualikan binding eksplisit), padahal `:185-219` mengurangi hitungan dengan hold legacy tanpa memberi tahu fact mana yang sudah dipakai.
- Fakta penting: 0649, 0658, dan 0679 belum ada di `main` (dicek `git merge-base`), dan setelah 0679 setiap jalur `same_as_counted` menulis `matchedFactId` (`refund-recon-hold.service.ts:640-644`, `:697-702`). Data legacy hanya mungkin ada di DB dev atau staging. Penolakan tidak berdampak ke production.
- Fix minimum (I3): di `pickUnbound` tambah gerbang `AND NOT EXISTS (SELECT 1 FROM refund_recon_holds d WHERE d.tenant_id=p.tenant_id AND d.payment_intent_id=p.payment_intent_id AND (d.provider_payment_ref = ${providerPaymentRef} OR d.provider_payment_ref IS NULL) AND d.resolution_identity='same_as_counted' AND d.matched_fact_id IS NULL)`. Hasil `null` menjadi `noAnonymousToMatch` (422). Gerbang ini menutup KEDUA picker (`pickUnboundAnonymousFact` dan `pickUnboundFact`).
- Test: file baru `apps/api/src/test/refund-1072-a4-legacy-pick.test.ts`. A 10k + B 20k anonim; P1=10 resolve `same_as_counted`, lalu `UPDATE matched_fact_id = NULL`; P2=30 `same_as_counted` ditolak 422, hold P2 terbuka, A dan B tidak terikat, total fact 30k (<= 40k), tanpa event jurnal baru; replay sama. Kontrol: tanpa legacy, P2=30 mengikat B dan top-up 10k. Kontrol jalur `named === null` (`pickUnboundFact`).

## Cek Tugas B (DOIT_REFUNDS_ENABLED mati) terhadap invarian

Tidak bertentangan. Rinciannya:

- B1: tanpa register, `paymentRefundGatewayFor` mengembalikan port `unconfigured` (`payment-refund-gateway.ts:127-130`). Legacy mode hanya diaktifkan `setPaymentRefundGateway` dari test. `runRefundPayout` dan retry berhenti sebelum klaim (`payment-refund.service.ts:2267`, `:3258`), dan sweep tidak klaim (`:3006`).
- I1: `settleRefundManually` tetap memanggil `assertNotProviderRefunded` (`:3809`, menolak saat ada hold terbuka). Cek cap baru (`:3810-3826`) menghitung fact penyedia. Settle manual tidak membuka dana yang ditahan.
- I2: refund approved yang belum pernah dikirim punya `payoutAttempts = 0` dan tanpa ref, jadi tidak "in flight" di recorder (`payment-provider-partial-refund.ts:686-700`). Laporan penyedia dihitung sebagai fact, sisi yang restriktif.
- Risiko B-1 (bukan kebocoran uang): finance memakai channel `provider_dashboard`, lalu webhook DOIT tiba SEBELUM settle di Legend. Fact X dicatat sebagai refund asing, lalu settle R berhasil bila 2x nominal <= dibayar. Akibatnya refund terbuku dua kali (kelas over-count, mirip legend-jw2xt, restriktif). Aturan ops: settle di Legend dulu, baru refund di dashboard. Bila webhook tiba setelah settle, jalur `findSettledOutsideTarget` mencatat konflik tanpa fact.
- Risiko B-2 (macet ops): `countHold` menolak selama ada refund `approved` (`refund-recon-hold.service.ts:483-500`), dan settle menolak selama hold terbuka. Saat flag mati, refund approved menunggu lama. Untuk count hold, finance harus membatalkan refund approved dulu. Ini perlu satu baris di runbook `docs/deployment.md`.

## Urutan kerja (file tidak bertumpuk)

1. I3: `refund-recon-hold.service.ts` (gerbang I4) dan `pickUnbound` di `payment-provider-partial-refund.ts` (I5), lalu test a3 dan a4.
2. I2: `reservation-deposit-credit.ts` (I3), lalu perluas 1063-b.
3. I1: `payment-webhook.service.ts` dan fungsi ekspor baru di AKHIR `payment-provider-partial-refund.ts` (I2), lalu test a1 + tambahan dua pintu. Langkah 1-3 boleh paralel.
4. I4: tambah dua baris runbook (B-1, B-2) di `docs/deployment.md`.
5. Gate: 1063-a..f, 1055-a, 1072-a1/a3/a4/b, dan test kredit DP 1033 lewat `heavy`.

## Risiko tersisa untuk CTO

- Hold surplus nominal di T yang sama (A1, A2, P2-2) memakai alasan `HOLD_TRANSACTION_CONFLICT`, jadi jalan keluarnya hanya `not_this_intent`. Bila laporan penyedia benar, finance tidak boleh memilih `not_this_intent` (dana akan terbuka tanpa surplus terbuku). Hold dibiarkan terbuka dan dana tetap tertahan. Ini sesuai keputusan, tetapi perlu catatan runbook.
- Di luar lingkup (usul bead P3): pada laporan matched dengan nominal tak terbaca (`:1779-1811`) atau ref berbeda di bawah kunci `refund:<R>`, laporan juga diabaikan tanpa hold. Hold di sini berisiko false positive (ref fallback payment id, legend-r7g2), jadi perlu keputusan terpisah.

## Ronde 7 (SO 1075): I6-I8

Architect, 18 Nov 2026. Basis 74172df44 (kode = 7c662f8d9). Laporan: `legend/docs/qa/second-opinion-refund-ronde7-1075.md`. Nomor baris = working tree saat ini.

### I6. Hold konflik atomik terhadap keputusan uang (R7-1)

Invarian: bila pemeriksaan di bawah kunci intent menemukan laporan sukses yang bukan echo, hold-nya di-commit di transaksi yang sama sebelum kunci intent (baris `payment_intents FOR UPDATE` lewat `lockRefundGraph`) dan kunci DP (advisory eksklusif `lockDepositIntentsExclusive`) lepas; penolakan baru dilempar sesudah commit, sehingga settle manual (kunci intent sama) dan apply kredit DP (kunci DP shared) selalu melihat hold itu.

- Pelanggar: `apps/api/src/services/payment-refund.service.ts:4100` dan `:4108` (`throw` di dalam tx, rollback, kunci lepas); `:4110` dan `:4115` (konflik/status, juga kembali tanpa hold). `apps/api/src/services/payment-webhook.service.ts:1877-1891` memasang hold di tx BARU; di antaranya ada tx audit `:1849` dan baca `refundSourcePayment` dengan koneksi lain.
- Fix minimum (bentuk API updater): parameter opsional ke-4, kompatibel ke belakang.
  `applyRefundProviderUpdate(context, update, now = new Date(), onRefusedInTx?: (tx: Tx, r: { kind: "reference_mismatch" | "amount_mismatch" | "contradiction" | "not_awaiting"; refund: Refund; intent: PaymentIntentRow }) => Promise<void>)`.
  Di tx `refused` (`:4091`), keempat titik tolak menjadi `{ await onRefusedInTx?.(tx, { kind, refund, intent: locked.intent }); return "<pesan lama>"; }`; `:4146` tetap `throw conflict(refused)` (409 sesudah commit). Tanpa callback tidak ada tulisan baru, jadi perilaku sama.
  Webhook (`:1824`): hitung `paymentRef` SEBELUM updater (`facts.paymentId ?? facts.payment?.id ?? (await refundSourcePayment(...))?.providerRef ?? intent.providerRef`), lalu kirim callback yang memanggil `fileOwnRefundSurplusHoldInTx(tx, ...)` memakai `tx` itu (callback tidak boleh membuka koneksi lain). Hapus tx hold `:1877-1891`. Aturan callback (satu aturan I2): hold bila `status === "succeeded"`, `match.kind !== "payment_object"`, dan BUKAN (`kind === "amount_mismatch"` dengan nominal < R). Nominal hold = `facts.amountIdr ?? Number(intent.amountIdr)`; id = `facts.refundId ?? refund.providerRef ?? "refund:<R>"`. Pakai `refund` dari callback (baris terkunci), bukan baris sebelum kunci.
  Urutan kunci: dokumen, intent, fund, refund, lalu DP. Sama dengan settle, jadi tidak ada siklus; apply DP tidak mengunci intent.
- Pemanggil updater: produksi hanya `payment-webhook.service.ts:1799` (cabang invalid settled-outside, tanpa callback, lihat I8) dan `:1824`. Tidak ada poller. 12 file test memanggil langsung, tanpa parameter ke-4: tetap 409, tanpa tulisan.
- Test `apps/api/src/test/refund-1075-r1-atomic-hold.test.ts` (harness 1072). Pakai `vi.mock("../services/payment-provider-partial-refund")` untuk membungkus `fileOwnRefundSurplusHoldInTx` dengan barrier sebelum fungsi asli. r1-01: T 100k, R 30k/X completed, R2 70k approved (flag mati). Kirim signed X/T 80k, tahan di barrier, jalankan `settleRefundManually(R2)` di koneksi kedua. Tunggu lewat `pg_stat_activity` sampai settle `wait_event_type='Lock'` (kode lama: settle selesai = gagal-dulu), lepas barrier. Settle wajib ditolak, hold 80k terbuka, total keluar <= 100k. r1-02: urutan terbalik (settle dulu): hold tetap tercatat. r1-03: apply kredit DP sesudah webhook kembali: kredit terpotong 80k. r1-04: replay: satu hold.

### I7. Generasi surplus dan "bukti sama" (R7-2)

Invarian: laporan sukses dengan kunci bukti (tenant, intent, T, jenis+id refund) yang nominalnya melebihi nominal terbesar yang pernah ditahan untuk kunci itu (hold utama dan semua generasi surplus, terbuka atau resolved) selalu meninggalkan hold terbuka. "Bukti sama" = kunci itu dengan nominal <= nominal terbesar tersebut; replay bukti sama tidak menambah atau membuka hold.

- Pelanggar: `apps/api/src/services/payment-provider-partial-refund.ts:1373` dan `:1407`. Id `holdEventId("\0surplus")` tunggal; bila generasi 1 resolved, insert bentrok, UPDATE `resolved_at IS NULL` gagal, lalu return tanpa hold.
- Fix minimum (hanya di `fileTransactionConflictHoldInTx`, tanpa migrasi): generasi g memakai id `gen(1) = holdEventId("\0surplus")` (data lama tetap cocok) dan `gen(g>=2) = holdEventId("\0surplus\0" + g)`. Di cabang `existing.resolvedAt !== null` (`:1358`), lakukan langkah ini:
  1. Baca `FOR UPDATE` hold intent itu dengan `provider_refund_id IS NULL`, alasan CONFLICT, dan T sama.
  2. Keluarga = baris yang `webhook_event_id`-nya ada di `{gen(1..n+1)}`.
  3. Hitung `maxHeld = max(existing, keluarga)`. Bila laporan <= `maxHeld`, no-op: bukti sama. Pertahankan audit "already resolved".
  4. Bila ada anggota terbuka, naikkan anggota itu (`greatest`) dan kirim alert. Perilaku a1-11 tetap.
  5. Bila tidak ada, insert `gen(g)` terkecil yang belum dipakai dengan nominal penuh laporan, `onConflictDoNothing`, alert sekali.
     Serialisasi oleh kunci intent dan DP yang sudah dipegang.
- Test `apps/api/src/test/refund-1075-r2-surplus-generation.test.ts`. T 100k, R 30k/X. Laporan X/T 50k lalu resolve; 80k lalu resolve surplus; 90k menghasilkan hold terbuka 90k (kode lama: tidak ada hold = gagal-dulu). Replay 90k dan 80k: tetap satu hold terbuka. Refund 70k, settle manual, dan kredit DP tertahan. Jalankan pintu matched (`refund.succeeded`) dan recorder (`payment.refunded`) dalam kedua urutan. Kontrol: generasi resolved lalu replay nominal sama, tanpa hold baru.

### I8. Ref berbeda, nominal tak terbaca, dan sukses atas R yang tidak menunggu (R7-3, legend-55up0)

Invarian: sukses bertanda tangan yang cocok ke R (bukan `payment_object`) tetapi tidak terbukti echo (ref Y != X, nominal tak terbaca atau hilang, atau R failed, ditolak, atau settled-outside) selalu menjadi hold `HOLD_TRANSACTION_CONFLICT`. Nominal hold = nominal laporan bila terbaca; bila tidak terbaca, nominal penuh intent (`intent.amountIdr`). Pengecualian fallback payment-object (legend-r7g2) tetap.

- Pelanggar: `payment-webhook.service.ts:1864-1869` (hanya > R atau failed); `:1782-1812` (invalid hanya diaudit); `payment-refund.service.ts:4110` (settled-outside + sukses = bayar dua kali, hanya audit `recordProviderConflict`).
- Fix minimum: ref berbeda dan settled-outside tertutup oleh aturan callback I6 (`reference_mismatch`, `contradiction`, `not_awaiting`). Blok invalid (`:1782`): bila `status === "succeeded"` dan `match.kind !== "payment_object"`, satu `withTenant` dengan `fileOwnRefundSurplusHoldInTx` (fungsi itu mengunci intent lalu DP sendiri, jadi atomik). T = `refundSourcePayment(...)?.providerRef ?? intent.providerRef`, sebab `payment_id` bisa tidak terbaca. Nominal = `Number(intent.amountIdr)`. Pasang hold sebelum audit dan `ignoredWith`.
- Test `apps/api/src/test/refund-1075-r3-unproven-success-hold.test.ts`, dengan kasus berikut:
  - Keyed `refund:<R>` dan `refund_id` Y, nominal 30k dan 20k: hold (provider, Y, T).
  - `amount: "80000.0"` dan amount hilang: hold 100k.
  - Settled-outside lalu sukses X: hold.
  - Lanjutan semua kasus di atas: refund 70k, settle R2, dan kredit DP tertahan; replay satu hold; tanpa event jurnal.
  - Kontrol: echo X/T 30k sah, `payment_object` fallback, dan status failed Y: tanpa hold.

### Risiko dan urutan

- Hold I8 beralasan CONFLICT, jadi hanya `not_this_intent` yang bisa menutupnya. Bila Y ternyata refund nyata, dana tertahan sampai keputusan finance (restriktif, sesuai CTO). Perlu satu baris di runbook.
- I8 untuk amount hilang bisa false positive bila payload DOIT asli kadang tanpa amount. Cek sampel event staging sebelum rilis.
- Settled-outside + sukses (I8) memperluas R7-3. CTO perlu konfirmasi; arahnya restriktif.
- Urutan: (1) updater dan webhook I6+I8 (dua file, satu engineer, berurutan); paralel (2) I7 di `payment-provider-partial-refund.ts`. File tidak bertumpuk, kecuali webhook yang hanya memanggil fungsi ekspor. Gate: 1072-a1/a2, 1045-d/e, 1055-a, 1075-r1/r2/r3.
- Review architect ronde 7 (P1, sudah diperbaiki): hold I8 dari cabang laporan tak terbaca memakai kunci sendiri `invalid:<id refund>`. Nominal pengganti (nominal penuh intent) tidak pernah dilaporkan, jadi tidak boleh ikut `maxHeld` kunci asli; tanpa ini laporan sah 80k sesudah hold 100k di-resolve tertelan (test r3-09). Replay laporan tak terbaca sesudah resolve tetap no-op (bukti sama).
- Review architect ronde 7 (P3, sudah diperbaiki): sukses matched tanpa id refund pada R approved tanpa `providerRef` kini lewat `refuse("not_awaiting")`, jadi hold tetap terpasang (test r3-10).
