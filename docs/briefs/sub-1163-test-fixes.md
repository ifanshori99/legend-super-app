# Sub-brief 1163: perbaikan test (temuan reviewer)

File milik: `apps/api/src/test/reservation-1163-proof-db.test.ts` saja. Jangan ubah file produksi. Jangan jalankan test/tsc (agent utama yang menjalankan). Setelah selesai: `pnpm exec prettier --write` lalu `pnpm exec eslint` pada file itu (dari apps/api), satu perintah per panggilan.

Temuan:
1. Tes DP terlambat (~:518, :552, helper `settleAt` ~:281-300): panggilan pertama `settleAt` melempar `PaymentConfirmationRejected("BILL_CLOSED")` setelah commit (payment.service.ts ~:3046 dan ~:3302) sehingga tes mati sebelum assert. Bungkus dengan `await expect(...).rejects` dan assert kode `BILL_CLOSED`; uang tetap terparkir (baris `payment_unallocated_funds` sebesar DP) dan tagihan tak berkurang.
2. Jam tes: `settleAt` memakai `at = t0+90mnt` (2027) tetapi `now` jam asli (2026-11-19); `confirmedAt = min(at, receivedAt ?? now)` (payment.service.ts ~:2999-3007) sehingga "terlambat" tak pernah tercapai dan tes tepat-waktu (~:579, :599) lulus karena alasan salah. Perbaikan: kirim `receivedAt: at` pada konfirmasi dan `now = at` sebagai argumen ke-4 `confirmPayment`; `settleAt` menerima `now`. Tes tepat-waktu kedua (setelah batas tautan, sebelum `expiresAt` intent) harus benar-benar membuktikan "tepat waktu".
3. Hapus blok try/catch debug `console.error("DBG", ...)` di `settleAt`.
4. Tes resend (~:443): assert `res.body.error.code === "RESERVATION_DEPOSIT_PAYMENT_PENDING"`, bukan hanya 409. Tes ~:489-514: pilih SATU hasil yang diharapkan (200 + tautan baru, atau 4xx dengan kode bernama) dan assert status + kode; hilangkan cabang `else` longgar. Tes ~:470 dan ~:489 harus gagal pada kode lama (jadikan kontras nyata, mis. intent berpenyedia belum final vs sudah final), bukan sekadar kontrol.
5. Ganti replay ~:546 agar menegaskan hasil: tidak ada outbox `payment.paid` untuk intent itu.
