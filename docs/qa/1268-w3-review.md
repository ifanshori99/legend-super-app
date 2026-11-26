# Review K uang 1268 W3 (ws/1268-w3 2e2ac5473 vs d058b37f4)

Reviewer: architect subagent, konteks segar, read-only, 26 Nov 2026. Test tidak dijalankan (baca statis).

## Hasil: GAGAL (1 temuan sedang di web, perbaikan kecil). Backend lulus.

## Yang lulus
- Kas tidak dobel/hilang: tender non-tunai pesanan captain (shiftId null) dicatat di shift kasir penerima
  (`pos-order-payment.ts:442-455`, kunci FOR SHARE sebelum QR/terminal; tutup shift memegang FOR UPDATE, jadi berurutan).
  Laporan shift (`pos-shift-print.ts:105-112`) memakai tender.shiftId lebih dulu, lalu order.shiftId bila null: dihitung sekali.
  Kas yang diharapkan hanya dari tender tunai (`pos-shift-support.ts:291`), tidak berubah. Tanpa shift terbuka: SHIFT_NOT_OPEN sebelum QR dibuat (fail closed).
- Selisih tidak bisa disembunyikan: varians dihitung server, terkunci ke hitungan (`pos-shift.service.ts:1350-1396`),
  hitungan append-only, hitungan terbaru wajib (SUPERSEDED), kas bergerak = STALE, batas hitung ulang dari server.
- Hitung buta tidak bocor: respons kasir tanpa expected/variance; nilai override `cash_shift_close` disembunyikan dari peminta
  (`staff-override.service.ts:103-120`) dan nilainya diturunkan server dari hitungan (`:341-396`), web mengirim 0 tanpa efek.
  sessionStorage hanya menyimpan isi tanda terima buta.
- PIN tidak bisa diputar ulang: override terikat ke hitungan, kasir peminta, approver, perangkat, jendela waktu PIN, nilai varians,
  dan `approval_override_id` unik; shift tutup sekali (closeKey + fingerprint).
- QRIS menunggu memblokir tutup (`pos-shift.service.ts:1299-1311`, openedBy = kasir penerima, jadi QRIS captain ikut terblokir).
- 10 pecahan (100.000 s.d. 100) mencakup semua uang kertas dan koin rupiah yang beredar umum. Jumlah lump sum ditolak di web.

## Temuan
1. SEDANG - badan permintaan tutup tidak dibekukan saat retry. `shift-hooks.ts:165-174` memakai ulang overrideId dan kunci,
   tapi `shift-api.ts:447-448` membangun ulang `varianceNote` dan `approvedBy` dari isian dialog yang baru.
   Akibat: (a) jawaban hilang lalu retry dengan alasan atau supervisor berbeda = IDEMPOTENCY_KEY_REUSED / approval ditolak,
   ditampilkan "PIN ditolak", persetujuan dihapus, layar kasir macet padahal shift mungkin sudah tertutup;
   (b) PIN yang diketik saat retry tidak diperiksa sama sekali (override lama dipakai), menyesatkan.
   Perbaikan: simpan `{countId, overrideId, approverUserId, reason, noteRequired}` di ref saat override disetujui, kirim ulang persis itu;
   saat retry jangan minta PIN (tombol "Coba lagi" saja). Pada 409 SHIFT_ALREADY_CLOSED/IDEMPOTENCY_KEY_REUSED, refetch shift aktif.
   Tambah test hook: retry dengan input dialog berbeda tetap mengirim badan pertama.
2. RENDAH - `shift-waiting.tsx:142-148`: pesan `retryHint` ("Persetujuan sudah diterima") juga muncul bila 5xx/jaringan terjadi
   di langkah override (sebelum disetujui). Bedakan dua kasus.
3. RENDAH (keputusan CTO) - supervisor menyetujui tanpa melihat selisih, dan alasan yang ia ketik menjadi catatan selisih bila
   `noteRequired` (`shift-api.ts:447`) tanpa ia tahu catatan itu wajib menjelaskan selisih. Selisih tetap tercatat, tapi penjelasannya
   bisa generik. Usul: setelah tutup, supervisor melihat laporan selisih di perangkatnya sendiri.
4. RENDAH - `shift-count-store.ts:22` sessionStorage per tab: tab baru atau restart browser = hitungan hilang di perangkat,
   kasir harus hitung ulang (memakai batas 3). Tidak rugi uang.
5. RENDAH - `pos-receipt-document.ts:93-114` mengubah nama kasir di struk semua pesanan (bukan hanya captain) menjadi pemilik shift
   tender tertangkap terakhir. Wajar, tapi perilaku berubah untuk pesanan biasa yang dibayar kasir lain; pastikan disengaja.
6. RENDAH - tender poin/EDC pesanan captain kini wajib shift terbuka di perangkat pemanggil; jalur pembukuan ECR edge
   (`edge/edc/agent.ts`) tidak lewat perubahan ini, jadi kartu ECR pesanan captain tetap tanpa shift (ECR terkunci di RC1; catat untuk 1269).

## Langkah perbaikan (implementer, berurutan)
1. `apps/web/src/features/ws04-pos-kasir/shift-hooks.ts`: ref beku berisi seluruh input close + overrideId; retry memakai ref itu.
2. `apps/web/src/features/ws04-pos-kasir/shift-api.ts`: `closeShiftWithApproval` menerima input beku untuk close saat `existing` ada.
3. `apps/web/src/features/ws04-pos-kasir/components/shift/shift-waiting.tsx`: retry tanpa dialog PIN; pesan dibedakan; refetch shift pada SHIFT_ALREADY_CLOSED.
4. `apps/web/test/pos-shift-close-wire.test.ts`: test retry dengan isian berbeda = badan sama, satu override.

## Keputusan CTO 26 Nov
- No. 1, 2, 4: perbaiki (no. 4: simpan per perangkat + id shift, bukan per tab).
- No. 3: hitung buta tetap. Layar kasir tidak menampilkan selisih. Label alasan diganti "Catatan selisih (wajib bila ada selisih)". Supervisor melihat selisih di laporan shift back office.
- No. 5: nama di struk = kasir yang menerima bayar (standar). Pastikan tidak mengubah struk lama yang sudah terbit.
- No. 6: catat ke kartu ECR 1269.

## Re-review 26 Nov (9875d4744)

Delta 2e2ac5473..9875d4744, baca statis, test tidak dijalankan. **Hasil: LULUS.**

- No. 1 selesai. `shift-close-flow.ts:269-303` membekukan `{overrideId, key, input}` (PIN dikosongkan) saat PIN diterima; retry
  mengirim isi beku persis, isi dialog diabaikan. Hanya jawaban hilang/5xx yang mempertahankan; 4xx membuang. 409
  SHIFT_ALREADY_CLOSED / IDEMPOTENCY_KEY_REUSED memuat ulang shift (`shift-hooks.ts:415-418`). Retry tanpa dialog PIN
  (`shift-waiting.tsx:164-168, 249-260`). Test: retry isi sama + satu override, gagal sebelum persetujuan minta PIN lagi, stale membuang.
- No. 2 selesai: `overrideFailed` (belum disetujui, minta PIN lagi) dibedakan dari `retryHint` (sudah disetujui, tekan Coba lagi).
- No. 3 sesuai keputusan CTO: label "Catatan selisih (wajib bila ada selisih)", layar kasir tetap buta.
- No. 4 selesai: localStorage per outlet + id shift, dihapus saat tutup berhasil.
- No. 5 sesuai keputusan CTO: nama kasir penerima hanya bila pesanan tanpa shift sendiri dan struk terbit >= 2026-11-26T00:00Z
  (`pos-receipt-document.ts:65-79`); struk lama dan pesanan kasir biasa tidak berubah saat dicetak ulang. Ada test untuk keduanya.
- No. 6: di luar delta, dicatat ke kartu ECR 1269 (keputusan CTO).

Sisa rendah (tidak menahan):
- a. Status beku hidup di memori komponen (`useMemo`): pindah layar setelah jawaban hilang = minta PIN baru. Shift yang sudah tertutup
  terlihat dari refetch; tidak ada tutup ganda (shift tutup sekali di server).
- b. Retry yang ditolak (mis. jendela PIN habis) menutup alur tanpa pesan di luar dialog; kasir menekan tutup lagi lalu PIN baru.
- c. `PAYER_CASHIER_FROM` tanggal tetap. Aman selama pesanan captain belum jalan di production sebelum rilis ini.
- d. Entri localStorage tidak dihapus bila shift ditutup paksa di perangkat lain (isinya hanya tanda terima buta).
