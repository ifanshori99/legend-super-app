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
