# Brief 1055: SO refund ronde 4 (tingkat K, uang)

Temuan: docs/qa/second-opinion-refund-ronde4-1055.md (baris mengacu 5882b0d6b). Cabang ghostex/1033-kredit-dp-pool-net-bersama. Aturan founder: bila ragu, pilih yang membatasi pembayaran; uang keluar <= dibayar; fact/jurnal tidak boleh dobel. Bead: legend-818ap (G1), legend-sccyj (G2).

## G1 (P1) hold anonim dihitung + laporan refund ID = dua fact
Masalah: hold tanpa provider_refund_id (mis. own_refund_failed_unverified dari R declined tanpa ref) di-resolve counted_against_intent -> fact synthetic_hold; laporan provider ber-ID P untuk refund nyata yang sama (nominal muat dalam sisa) -> fact provider kedua. Urutan terbalik (fact P dulu, lalu resolve counted hold anonim) juga dobel.

Desain (restriktif, wajib):
- a) Perekam jalur kind `provider` (payment-provider-partial-refund.ts ~567-580): bila transaksi yang sama (tenant + intent + provider_payment_ref) punya fact anonim (kind synthetic_hold yang berasal dari hold tanpa provider_refund_id) yang belum "diikat", laporan baru TIDAK jadi fact; pasang hold baru (reason baru, mis. `REFUND_MAY_DUPLICATE_ANONYMOUS`, id = refund ID laporan, kind provider, nominal laporan) + alert sekali, status duplicate/held. Finance resolve: `not_this_intent` = sama dengan fact anonim (tidak ada fact baru); `counted_against_intent` = refund terpisah terbukti -> fact provider dicatat sekali (dengan batas sisa A2).
- b) Resolve counted hold ANONIM (refund-recon-hold.service.ts ~437-460): bila transaksi yang sama sudah punya fact apa pun (provider/synthetic) -> tolak 409 (kode baru, mis. `HOLD_IDENTITY_AMBIGUOUS`) kecuali finance mengirim `providerRefundId` opsional:
  - `providerRefundId` cocok fact yang ada di transaksi sama -> hold ditutup counted TANPA fact baru (diikat).
  - `providerRefundId` baru -> fact kind provider dengan id itu (bukan synthetic_hold), sehingga echo P berikutnya jadi duplikat.
  - Tanpa fact lain di transaksi -> perilaku lama (synthetic_hold) boleh, TETAPI jalur (a) menahan laporan P berikutnya.
  - Validator shared (strict zod) untuk body resolve ditambah `providerRefundId` opsional (string pendek, trim). Hanya berlaku untuk hold anonim; untuk hold ber-id ditolak 422.
- Teks pesan UI/galat bahasa Indonesia sederhana mengikuti pola file.

## G2 (P2) fact transaksi lain menutup hold
Masalah: cek duplikat (payment-provider-partial-refund.ts ~629-643) dan `rowOf` (refund-recon-hold.service.ts ~330-345, dipakai ~440) mencocokkan tenant+intent+kind+refund id, tidak provider_payment_ref.
Desain: fact yang membenarkan penutupan otomatis maupun resolve counted harus cocok juga provider_payment_ref hold. Konflik transaksi: auto-close tidak terjadi; resolve counted ditolak 409 (`HOLD_TRANSACTION_CONFLICT`), hold tetap terbuka (menahan dana T2); finance hanya bisa not_this_intent sesudah cek. Fact T1 tidak berubah.

## Test (merah dulu, berkas baru `apps/api/src/test/refund-1055-a-anonymous-and-txn.test.ts`)
Invarian tiap test: fact total per transaksi <= dibayar; jumlah fact/journal event sesuai; payout gateway palsu tidak bertambah salah; refund baru ditolak selama hold terbuka.
- G1-01 bayar 100k; R 30k declined TANPA ref (pastikan R.provider_ref NULL sesudah gagal dan hold own_failed anonim: provider_refund_id NULL) -> finance counted -> fact synthetic_hold 30k -> webhook P 30k (lewat jendela retry / unmatched path) -> TIDAK ada fact kedua; hold baru REFUND_MAY_DUPLICATE_ANONYMOUS; total fact 30k; satu journal event; replay dengan event id baru tidak menambah apa pun.
- G1-02 urutan terbalik: webhook P 30k dulu (fact provider 30k), lalu finance counted hold anonim tanpa providerRefundId -> 409 HOLD_IDENTITY_AMBIGUOUS; dengan providerRefundId=P -> 200, tanpa fact baru; total 30k.
- G1-03 kontrol dua refund berbeda: hold anonim di-count dengan providerRefundId Q (baru) -> fact provider Q; laporan P (beda) -> hold REFUND_MAY_DUPLICATE_ANONYMOUS? (tidak: fact sudah terikat ber-id) -> catat P sebagai fact bila muat sisa; total 60k, dua fact.
- G1-04 hold REFUND_MAY_DUPLICATE_ANONYMOUS: not_this_intent -> tidak ada fact; counted -> satu fact; resolve ganda bersamaan -> satu fact.
- G1-05 providerRefundId pada hold ber-id -> 422.
- G2-01 intent I dengan T1 (bayar 100k) + T2 (evidence diparkir 100k). Fact X 30k di T1. Hold live-own untuk laporan X/T2. Replay X/T2 -> hold T2 tetap terbuka; fact T1 tidak berubah.
- G2-02 resolve counted hold X/T2 -> 409 HOLD_TRANSACTION_CONFLICT; pengajuan/approve refund dana T2 ditolak 409 tanpa panggilan payout; not_this_intent -> hold tertutup.
Pola fixture: refund-1045-f-architect.test.ts (A2-03, A4-01), refund-1045-e, refund-1025d-a-secondary-transaction.test.ts. Helper "tanpa referensi" harus benar-benar tanpa ref sesudah lookup gagal (SO catat helper lama memasok ref baru).

## Keputusan tambahan (engineer)
- Resolve counted oleh finance atas hold ber-ID = bukti refund terpisah: dicatat (batas sisa A2 + dedupe id tetap). Yang ditahan hanya jalur otomatis (webhook/poller/worker).
- `providerRefundId` pada not_this_intent atau pada hold ber-ID: 422.

## Temuan architect xhigh (ronde 1055) dan keputusan engineer
Prinsip: fact dobel mengurangi sisa (aman untuk payout, salah untuk jurnal); fact kurang menambah sisa (bisa bayar lebih). Jadi saat identitas ambigu: jangan pilih otomatis; tolak 409 sampai finance menyatakan identitas secara eksplisit. Hold tetap terbuka dan menahan dana.

- AP1-1 (label terbalik di hold REFUND_MAY_DUPLICATE_ANONYMOUS): server tidak boleh bergantung pada label UI. Body resolve diberi field opsional `identity: "same_as_counted" | "separate"` (strict zod, shared/payment/admin.ts).
  - Hold dup-anon + counted_against_intent: `identity` WAJIB, tanpa itu 409 HOLD_IDENTITY_AMBIGUOUS. `same_as_counted` = tutup tanpa fact baru dan fact anonim dianggap terikat. `separate` = catat fact provider (batas sisa A2, dedupe id).
  - Hold dup-anon + not_this_intent = laporan bukan uang pembayaran ini: tutup, tanpa fact, fact anonim TIDAK dianggap terikat.
  - Penghitung "fact anonim belum terikat" harus memakai penutupan `same_as_counted` (dan pengikatan providerRefundId G1-02), bukan not_this_intent. Simpan pengikatan tanpa menebak; bila butuh kolom, migrasi baru 0658 (FK di dalam CREATE TABLE, bukan ALTER).
- AP1-2 (hold ber-ID dibuat sebelum fact anonim, lalu di-count): hold ber-ID apa pun (live-own dll) + counted_against_intent, bila transaksi sama punya fact anonim belum terikat: `identity` WAJIB (409 tanpa itu), semantik sama seperti di atas. Ini menggantikan keputusan tambahan sebelumnya ("count finance = bukti") khusus saat ada fact anonim belum terikat. Juga: retry laporan P yang insert hold-nya bentrok dengan hold P yang sudah ada tetap harus mengirim alert/menandai hold itu ambigu bila fact anonim muncul kemudian (minimal: resolve-nya kena aturan identity).
- AP2-1: `closeLiveOwnHold` (payment-provider-partial-refund.ts ~194-211) cocokkan juga providerPaymentRef. Replay X/T1 tidak boleh menutup hold X/T2.
- AP2-2: laporan bentrok (insert fact ditolak karena fact id sama di transaksi/intent lain) tanpa refund kita berjalan: buat hold konflik (`HOLD_TRANSACTION_CONFLICT` sebagai reason, provider_refund_id = id laporan, kunci dedupe memuat ref transaksi) + alert sekali. Bukan "bound". Dana T2 diblokir sampai finance.
- UI: id.ts/en label + petunjuk khusus dup-anon dan pilihan identity di refund-holds-panel.tsx (dua tombol: "Sama dengan refund yang sudah dihitung", "Refund terpisah, catat juga"). Kecil, ikuti pola panel.
- `providerRefundId`/`identity` pada not_this_intent: 422.

Test tambahan (merah dulu, berkas sama refund-1055-a): G1-06 (hold LP(P) dulu, lalu R gagal anonim, H di-count, lalu count LP tanpa identity -> 409; dengan same_as_counted -> tanpa fact; total 30k), G1-07 (dup-anon counted tanpa identity -> 409; same_as_counted -> tanpa fact; separate -> satu fact; not_this_intent -> tanpa fact dan laporan P berikutnya masih ditahan), G2-03 (replay X/T1 tidak menutup hold X/T2), G2-04 (X/T2 tanpa refund berjalan -> hold konflik + alert; refund dana T2 ditolak tanpa payout). Ubah G1-04 bila semantiknya berubah (catat di komentar).

## Verifikasi architect (lanjutan) dan keputusan engineer
- AP1-1, AP1-2, AP2-1 tertutup.
- AV-P1 `same_as_counted` mencatat kurang: hold laporan P 100k, fact anonim A 30k, finance pilih same -> fact tetap 30k, sisa 70k terbuka. Keputusan: saat same_as_counted, catat selisih = min(nominal hold - nominal fact anonim belum terikat yang diikat, sisa transaksi) sebagai `synthetic_hold` ber-id hold ini (dedupe), lalu tutup hold. Selisih <= 0: perilaku sekarang. Test G1-08 (A 30k, P 100k on bill 100k): total fact 100k, sisa 0, satu event untuk selisih; replay resolve tidak menambah.
- AV-P2 hold konflik bisa bentrok dengan hold tertutup ber-id sama di transaksi lain (unique index tanpa ref). Keputusan: unique index hold memuat `provider_payment_ref` dengan `NULLS NOT DISTINCT`, di 0658 (belum diterapkan di mana pun). Semua `onConflict` pada refund_recon_holds wajib disesuaikan targetnya (grep semua). Test G2-05 (LP(X)/T1 terbentuk lalu tertutup karena X/T1 tercatat, lalu X/T2 tanpa refund kita berjalan -> hold konflik terbuka + alert, refund dana T2 ditolak tanpa payout).
- Catatan merge train: nomor migrasi 0658 (0657 dipakai cabang payout 911, 638549e25); journal perlu disusun ulang saat merge.

## Regresi 140 berkas: 6 gagal di refund-1025-d (409 HOLD_IDENTITY_AMBIGUOUS) dan keputusan engineer
- Hold ANONIM (tanpa provider_refund_id) yang di-count saat transaksinya sudah punya fact: 409 benar, tetapi finance yang tidak punya nomor refund tidak punya jalan keluar selain not_this_intent (fact kurang). Keputusan: `identity` juga diterima untuk hold anonim, sebagai pengganti `providerRefundId`:
  - `separate`: catat `synthetic_hold` ber-id hold, dibatasi sisa (perilaku 1025-d lama).
  - `same_as_counted`: aturan AV-P1, catat selisih max(0, nominal hold - nominal fact terkecil transaksi) dibatasi sisa; nominal 0 (synthetic_full) = sisa penuh dicatat seperti separate? TIDAK: synthetic_full 0 berarti "sisa penuh", jadi same_as_counted tidak bermakna -> 422 untuk synthetic_full.
  - `providerRefundId` dan `identity` bersamaan: 422.
- `needsIdentity` true juga untuk hold anonim yang transaksinya punya fact; false untuk HOLD_TRANSACTION_CONFLICT (architect P2-2).
- Test: 1025-d-30/39/40/42/43/44 diberi `identity: "separate"` dengan komentar "1055: identitas wajib saat transaksi sudah punya fact"; assert uang tidak diubah. Test baru G1-09 di refund-1055-a (merah dulu): hold anonim 30k pada transaksi dengan fact 40k, bill 100k: tanpa identity 409; separate -> +30k (total 70k); same_as_counted -> tanpa row baru (30k <= 40k); providerRefundId + identity -> 422; synthetic_full + same_as_counted -> 422. G1-10: hold konflik -> needsIdentity false di view.
