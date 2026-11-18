# Second opinion refund ronde 14 — 1134

Tanggal: 19 November 2026. Hasil: **2 temuan P1**. Perbaikan 1126 belum memenuhi invariant bahwa sukses refund terpetakan menahan pembayaran lanjutan sebelum uang dapat keluar lagi.

## Ruang pemeriksaan

- Diff sesudah `git fetch origin`: `origin/ws/1072-refund-ronde6-q45...origin/ws/1126-refund-unmatched-hold`, dengan snapshot JSON dikecualikan.
- Base: `ccd688e114cf68e369a5d354a6a2c3cad74ea7f7`; head: `f73faddb9d532729c27da73f022f9a8b4f0a336d`.
- Sepuluh file, 1.269 penambahan dan 48 penghapusan; tidak ada migrasi baru. Semua nomor baris di bawah mengacu pada head tersebut.
- Tiga subagent paralel: webhook/pemetaan, fact–hold/penguncian, dan test/kontrak. Pemeriksaan kode sekitar dibatasi untuk membuktikan dampak uang. Risiko yang telah diterima CTO dalam brief 1134 tidak dilaporkan ulang.

## Temuan

### P1-1 — Jendela retry membiarkan refund manual berjalan tanpa hold

**Lokasi:** `apps/api/src/services/payment-webhook.service.ts:2332`.

Panggilan baru ke `holdUnmatchedRefundSuccess` berada di dalam `if (!retryable && status === "succeeded")`. Selama 15 menit pertama, sukses yang tidak cocok hanya disimpan sebagai `failed / REFUND_UNMATCHED` (`:2349`), tanpa hold, fact, atau alert finance. Mengulang pencocokan tidak menahan pembayaran lain.

**Skenario gagal:** Intent T menerima Rp100.000, belum mempunyai refund Legend dan tidak terikat dokumen lain. Penyedia mengembalikan Rp60.000 dari dashboard lalu mengirim webhook bertanda tangan `refund.succeeded` dengan `data = { payment_id: P, amount: 60000 }`; P adalah pembayaran T yang bisa dipetakan. Segera sesudah webhook disimpan, sebelum 15 menit berlalu, finance membuat, menyetujui, dan mencatat refund manual Rp100.000. Total keluar menjadi **Rp160.000 untuk pembayaran Rp100.000**. Sakelar refund otomatis mati tidak menutup jalur manual ini.

**Bukti dampak:** `payment-admin.service.ts:94` menghitung batas dari evidence, dana, refund Legend, dan fact penyedia; `:564` memanggil guard. `payment-provider-refunded-guard.ts:103` hanya memeriksa flag, hold terbuka, serta total fact; tidak memeriksa event webhook yang menunggu retry. `payment-refund.service.ts:3811` dan `:3822` mengulang guard dan batas yang sama saat settlement manual. Tanpa hold/fact, seluruh Rp100.000 masih tersedia.

**Usul perbaikan:** Buat hold untuk sukses terpetakan pada pemrosesan pertama, sebelum mengembalikan status retry. Pencocokan tetap boleh diulang dengan kunci hold stabil dan aturan rekonsiliasi yang tidak menghitung uang dua kali.

**Usul test:** Kirim webhook melalui `h.deliver()` tanpa mengubah `received_at`, lalu jalankan jalur request–approve–settle manual dengan `tryManualOut`. Pastikan hold sudah ada, tambahan Rp100.000 ditolak, dan total keluar tidak melampaui Rp100.000. Uji pada menit 0 dan 14, sakelar mati/hidup, serta retry sesudah menit 15. Test baru saat ini melewati celah ini: `refund-1126-unmatched-hold.test.ts:32` secara eksplisit tidak mengunci perilaku dalam jendela, dan helper `:138` memundurkan waktu sebelum memeriksa hasil.

### P1-2 — Reference intent yang dapat dipetakan diperlakukan sebagai pembayaran tidak dikenal

**Lokasi:** `apps/api/src/services/payment-webhook.service.ts:1463`.

Mapper unmatched hanya mencari kandidat lewat `facts.paymentId`, `facts.payment?.id`, atau `facts.namedPaymentId`. Ia tidak memakai `facts.reference`, meskipun keputusan 1 brief 1126 mewajibkan pemetaan lewat payment id/reference. Ketika reference adalah satu-satunya penunjuk pembayaran, `candidate` tetap `null` dan jalur `:1503` hanya mengirim alert `unmatched_unmapped_payment`, tanpa hold.

**Skenario gagal:** T dibayar Rp100.000, tanpa refund Legend. Integrasi T mengirim signed `refund.succeeded` dengan data berikut setelah refund dashboard Rp60.000:

```json
{
  "object": "refund",
  "id": "rf_external",
  "reference": "<UUID intent T>",
  "status": "succeeded",
  "amount": 60000
}
```

Reference menunjuk T secara unik di tenant penerima dan signature adalah milik integrasi T. Setelah jendela retry pun, event menjadi `REFUND_UNMATCHED`, hanya alert dikirim, dan T tidak ditahan. Finance masih dapat membayar manual Rp100.000; total keluar menjadi **Rp160.000**.

**Bukti alur:** `payment-doit-refund-webhook.ts:213` membaca reference dan `:246` menyimpannya kembali untuk retry. `findRefundTarget` (`payment-webhook.service.ts:1951`) mencari refund berdasarkan id/key, sehingga id eksternal ini tidak cocok refund Legend. `readProviderInitiatedRefund` (`payment-doit-refund-webhook.ts:313`) mensyaratkan payment id, sehingga tidak membukukan fact untuk payload ini. Helper hold kemudian mengabaikan reference yang masih tersedia. Alert saja tidak mengubah guard atau batas manual yang dijelaskan pada P1-1.

**Usul perbaikan:** Tambahkan pemetaan reference ke intent/pembayaran yang sah dalam tenant penerima, periksa integrasi yang menandatangani, dan periksa ulang kepemilikan serta status di bawah kunci intent sebelum membuat hold. Jangan memakai reference untuk mengalahkan payment id yang bertentangan.

**Usul test:** Uji reference-only pada bentuk `object: "refund"` dan nested `refund.reference`, termasuk pemrosesan ulang payload tersimpan. Wajib terbentuk hold Rp60.000 dan refund manual Rp100.000 ditolak. Tambahkan reference tenant lain, integrasi berbeda, dan reference yang bertentangan dengan payment id; intent lain tidak boleh ikut diubah.

## Hasil area fact–hold

Tidak ditemukan temuan baru pada delta pengikatan fact–hold. `assertFactUnclaimed` berjalan di bawah kunci intent; pencarian fact membatasi tenant, intent, dan transaksi; index unik `matched_fact_id` menjadi penjagaan tambahan. `pickUnbound` mengecualikan fact yang terikat atau dimiliki named hold. Coverage mengecualikan fact milik hold lain dan tetap menolak fact parsial yang kurang dari nominal hold. Kesimpulan ini berasal dari review statis, bukan uji dua koneksi yang dijalankan ulang.

## Verifikasi dan batas

- Selesai: Fetch remote, pencocokan SHA, pembacaan diff dan sumber di head, pemeriksaan silang tiga subagent, serta penelusuran guard request/settlement manual.
- Format laporan: Prettier 3.9.6 lulus melalui binary terpasang `node node_modules/.pnpm/prettier@3.9.6/node_modules/prettier/bin/prettier.cjs --check docs/qa/second-opinion-refund-ronde14-1134.md`. Wrapper `pnpm exec prettier` gagal menemukan `node_modules/prettier/bin/prettier.cjs`; tidak ada dependensi atau symlink yang diubah.
- Belum dijalankan: Test database, reproduksi dua koneksi, suite regresi, typecheck, dan build. Review ini tidak menyatakan test lulus atau bug telah direproduksi melalui API/database.
- Harness fungsi dari blob head diajukan melalui `heavy`, tetapi dibatalkan sebelum eksekusi karena kedua jalur berat sedang dipakai dan tiga job sudah mengantre lebih dahulu. Pembatalan mengembalikan exit 143; antrean sesudahnya tidak lagi memuat harness ini. Tidak ada job milik review ini yang masih berjalan.
- Hanya laporan ini yang ditulis. Tidak checkout, membuat worktree, mengubah kode, commit, push, atau merge. Tindak lanjut: CTO menugaskan perbaikan kedua P1 dan test invariant uang sebelum gerbang rilis.
