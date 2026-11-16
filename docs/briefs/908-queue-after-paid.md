# 908 QR/VA: antrean rekonsiliasi tetap memantau setelah paid_recorded (legend-xzu4l)

Cabang: fix/qr-va-queue-after-paid-xzu4l (dari 73eb73dc3 + merge 785b3b453).

## Aturan (keputusan CTO, tidak membuat uang hilang, tidak membayar lebih)
- Antrean (VA 906 dan QR Q93) terus bertanya ke penyedia sampai kode tertutup di penyedia (jawaban final atau kedaluwarsa penyedia), dengan backoff dan batas waktu. Paid_recorded BUKAN penutup.
- Tiap transaksi penyedia tambahan (selain yang sudah melunasi) diparkir sebagai dana belum teralokasi tepat sekali per transaksi penyedia (identitas evidence seperti 896). Tidak pernah melunasi order. Dana terparkir memblokir tender baru (aturan 896).
- Poll + webhook bersamaan tidak dobel (idempoten lewat identitas yang sama).

## Test wajib (gagal-dulu lalu hijau), VA dan QR
1. Paid pertama tercatat.
2. Paid kedua ke kode sama tanpa webhook: diparkir tepat sekali lewat antrean; order tidak dilunasi dua kali.
3. Poll + webhook bersamaan: satu catatan parkir, bukan dua.
4. Antrean berhenti setelah kode tertutup (final/kedaluwarsa penyedia) dan setelah batas waktu.
5. Dana terparkir memblokir tender baru.

## Batas
Migrasi bila perlu: nomor sementara 0632+. Tidak merge ke m1, tidak deploy. Satu token heavy: hanya satu subagent menjalankan vitest/tsc.

## Desain (engineer, 16 Nov)
Fakta kode: `decide()` di apps/api/src/services/pos-qris-release-recon.ts (dipakai bersama antrean VA payment-va-release-recon.ts) mengembalikan `resolved/paid_recorded` begitu `recordedMoney` true; baris lalu `status=resolved` dan tak ditanya lagi. Identitas parkir: `payment_evidence` UNIQUE(tenant, provider, provider_ref) + `payment_unallocated_funds` UNIQUE(tenant, evidence_id); fungsi `recordUnsettledGatewayFunds(context, intent, {provider, providerRef, source:"gateway_status", paidAmountIdr, receivedAt, method?}, now)` di payment.service.ts (~1219) mengembalikan false bila nominal <= 0.

1. Port: `GatewayPaymentStatus` (payment-gateway.ts ~82) dapat field opsional `extraPayments?: ReadonlyArray<{providerRef: string; amountIdr: number; paidAt?: string|null}>` = transaksi penyedia yang sudah dibayar pada kode yang sama selain `providerRef` kode ini. Adapter Duitku (payment-duitku.ts getStatus ~446): jawaban dengan `reference` lain dan status paid TIDAK lagi `continue` (jadi error); jadi `status:"pending"`, amountIdr null, extraPayments [{answer.reference, amount}]. DOIT: tidak ada endpoint daftar, tak berubah (catat batas).
2. `decide()`: (a) jawaban primer paid + recorded tetap seperti sekarang, tapi hasil `open` dengan seen "paid" (bukan resolved) sampai kode tertutup; (b) tiap `extraPayments` dengan nominal > 0 diparkir lewat `recordUnsettledGatewayFunds` (source gateway_status, identitas providerRef-nya) — tepat sekali, tidak pernah `confirmPayment`; (c) `other_reference` tanpa extraPayments tetap open; (d) penutup: kode tertutup bila now >= intent.expiresAt + CLOSE_MARGIN_MS (ditanya sekali setelah itu) ATAU jawaban final penyedia (expired/failed seperti sekarang) ATAU batas waktu keras (baris dibuat + 7 hari) -> resolved dengan resolution `paid_recorded` bila uang tercatat. Backoff `nextReconCheckAt` tetap.
3. Konsumen status `open`/resolution `paid_recorded` (sweep void order, UI staf, notifikasi) harus tetap benar: baris paid yang masih open tidak boleh dianggap "uang belum tercatat" (PAID_UNRECORDED tidak berisi "paid").

## Tahap 2 (16 Nov): bukti gagal-dulu + regresi merge
A. Fail-first: buat worktree sementara `git worktree add ../legend-908-base 4e0d93f32` (merge langkah 0, belum ada perubahan 908), `pnpm worktree:setup` di sana, salin HANYA `apps/api/src/test/qr-va-queue-after-paid-xzu4l.test.ts` ke sana, jalankan `LEGEND_TEST_FILES=src/test/qr-va-queue-after-paid-xzu4l.test.ts heavy pnpm test`; catat jumlah gagal/lulus per nama. Lalu hapus worktree sementara (`git worktree remove --force`, `git worktree prune`).
B. Regresi: `va-staff-release-5wn1e.test.ts` "queue poll first, then the webhook" gagal (BILL_CLOSED, bukan null). Tentukan apakah gagal juga di 73eb73dc3 (sebelum merge 879) atau hanya sesudah merge 785b3b453 atau karena perubahan 908. Bila akibat merge 879 (webhook park path sekarang mengembalikan reject BILL_CLOSED untuk replay?), lapor penyebab + usul perbaikan paling membatasi uang; perbaiki bila jelas tidak mengubah aturan uang.

## Tahap 3 (16 Nov): temuan architect xhigh, perbaiki semua
Fakta: baris rekon baru dibuat >= 30 menit SETELAH kode kedaluwarsa (payment-va-release.ts:156; pos-qris-hold.ts:1104), jadi `expired` selalu true di produksi. Aturan tutup baru (keputusan engineer, paling membatasi uang):
1. paid tercatat tidak menutup baris. Tutup `paid_recorded` hanya bila `now >= row.createdAt + PAID_WATCH_MS (72 jam)` DAN `row.lastProviderStatus === 'paid'` (jadi minimal satu tanya lagi setelah paid pertama terlihat). Jawaban final penyedia nyata (expired/failed dengan margin) tetap menutup (resolution provider_expired/failed, atau paid_recorded bila uang tercatat). Batas keras 7 hari: tutup (paid_recorded bila uang tercatat, selain itu provider_expired) TANPA dianggap jawaban final.
2. `Outcome` dapat flag `final: boolean` (true hanya untuk jawaban final penyedia nyata). Antrean VA (payment-va-release-recon.ts ~107-127) hanya mengisi `provider_final_at` bila `outcome.final`. decide() menerima `lastProviderStatus` di row.
3. Duitku getStatus (payment-duitku.ts ~471-488): `answer.reference` bisa null (wire optionalString) -> TS2322 + salah. Hitung extra HANYA bila reference tidak kosong dan beda dari providerRef; reference null/kosong = `continue` seperti dulu. Jangan berhenti di credentials pertama yang menjawab "reference lain": kumpulkan extras lalu lanjut loop credentials; bila credentials lain menjawab untuk providerRef sendiri, pakai itu + extras.
4. `recordedMoney` cocok juga `providerRef = intent.providerRef` (extras terparkir tidak boleh dianggap uang primer tercatat).
5. `parkExtraPayments`: log ID saja (intentId, providerRef, bukan body) saat gagal; tambah `extra_funds_not_parked` ke PAID_UNRECORDED supaya staf dapat peringatan.
6. Tes: baris dibuka SESUDAH kode kedaluwarsa (realistis, >= 30 menit); tutup 72 jam; batas 7 hari tanpa provider_final_at; reference null tidak diparkir; recordedMoney tidak tertipu extra. Tambah test regresi Duitku (reference null).

## Tahap 4 (16 Nov): architect ronde 2
P1: `payment-duitku.ts` getStatus kini mengembalikan pending + extraPayments untuk jawaban "referensi lain dibayar"; `askProviderAboutLink` (payment-provider-proof.ts ~190-258) dulu menolak batal link lewat throw, kini lolos ("unpaid") dan uang referensi lain tak terlihat. Perbaiki: tepat setelah cek referensi (~:204) `if (answer.extraPayments?.length) throw unconfirmed();` (refuse). Cek SEMUA pemanggil getStatus lain (grep `.getStatus(` di services) yang bisa memberi verdict "unpaid"/membatalkan/mengabaikan: pasangkan perilaku sama (anggap tidak terkonfirmasi) atau catat mengapa aman. Tes: pembatalan link ditolak saat Duitku menjawab referensi lain dibayar.
P3: pos-qris-release-recon.ts ~:360-363 jawaban final nyata (expired/failed) dengan uang tercatat: tutup `paid_recorded` tapi `final: true`; assert `providerFinal` di tes VA "a final provider answer after the paid one closes the row".
