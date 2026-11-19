# Second opinion refund ronde 17 — 1161

Tanggal: 19 November 2026. Hasil pemeriksaan statis: **1 temuan P2**; tidak ditemukan P0/P1/P3 baru pada delta yang diperiksa. Skenario asli P2 ronde 16 tertutup, tetapi penyatuan identitas alert belum mencakup laporan yang lebih dahulu diumumkan sebagai unmatched ketika saklar mati.

## Ruang pemeriksaan

- Sesudah `git fetch origin` berhasil, delta: `41b89605d..origin/ws/1144-refund-hold-echo`.
- Base: `41b89605d058001dcc5e40c513b39c563c0fc4d7`; head: `d217d439dba9b6e7030f27f6dce9076b3c432343`. Semua nomor baris sumber di bawah mengacu pada head ini, bukan checkout utama.
- Enam berkas, 782 penambahan dan 66 penghapusan; dua berkas layanan dan empat berkas test, tanpa migrasi. Konteks di luar delta dibaca hanya untuk membuktikan alur terkait.
- Tiga subagent read-only berjalan paralel, puncak tiga: finalitas hold/uang, dedup/isolasi alert, serta penutupan temuan ronde 16/cakupan test. Parent memeriksa silang bukti dan skenario temuan.
- Pengecualian CTO dalam brief diterapkan; perilaku yang sudah diterima tidak dilaporkan ulang.

## Temuan

### P2-1 — Alert lama masih terkirim sebelum jalur saklar mati memakai ID stabil

`apps/api/src/services/payment-webhook.service.ts:1782` — Announce ketika saklar mati memakai `stableRefund`, tetapi jalur unmatched langsung pada `:1326` masih mengirim tanpa identitas tersebut; laporan yang sudah diperingatkan melalui jalur itu lalu cocok dengan R mendapat alert kedua dari gate saklar mati. Terapkan identitas stabil yang sama pada pengiriman unmatched ketika saklar mati, sambil mempertahankan hold dan pengiriman alert pertama.

**Skenario konkret:** T dibayar Rp100.000; R Rp60.000 sudah dikirim dan masih `approved`, tetapi id penyedia X belum tersimpan pada R. Saklar DOIT dimatikan sebelum event pertama dan tetap mati sepanjang skenario.

1. Event bertanda tangan E1 bertipe `refund.succeeded` membawa refund id X dan payment id P milik T, tanpa idempotency key, tetapi nominal hilang/tidak terbaca. Refund id masih terbaca, sehingga pencocokan memakai X dan belum menemukan R. `payment-doit-refund-webhook.ts:213` menandai nominal invalid; `:318` membuat `readProviderInitiatedRefund` mengembalikan `null`.
2. Pada menit 0 dibuat hold conflict H untuk X/P senilai penuh Rp100.000 tanpa alert. Sesudah jendela 15 menit, X masih belum tersimpan. Karena `providerRefund` null, jalur unmatched tidak mencatat fakta dan memanggil `holdUnmatchedRefundSuccess` (`payment-webhook.service.ts:2815`). Payment P memetakan T; nominal hold memakai nilai penuh (`:1618`). Pemanggilan varian `unmatched` (`:1635`) mencapai `:1326`, mengirim alert unmatched dengan `dedupKey` lama dan tanpa `stableRefund`. E1 berakhir `ignored`; H tetap terbuka.
3. X kemudian tersimpan pada R. Penyedia mengirim event E2 dengan **event id berbeda**, tetapi refund id X dan payment P yang sama; nominal boleh tetap hilang. E2 sekarang cocok R dan mencapai gate saklar mati pada `:2950`, sebelum pemeriksaan fakta invalid di `:2991`. `alertRefundId: X` pada `:2968` membuat alert switched-off memakai ID stabil lewat `:1382`.
4. Announce pada `:1782` memakai ID stabil yang sama dengan alert switched-off, sehingga keduanya menyatu. Namun alert unmatched E1 sudah tersimpan dengan ID lama. `payment-provider-refunded-alert.ts:354` dan `:355` memakai input hash berbeda untuk mode stabil dan lama; dedup persistensi berdasarkan `sourceEventId` (`notification-consumer.ts:49`, `:55`) tidak menyatukan keduanya. Penerima yang sama memperoleh **dua identitas alert untuk X pada tenant/integrasi/intent yang sama**.

**Batas skenario:** Replay dengan event id E1 yang sama setelah `ignored` berhenti sebagai duplicate (`payment-webhook.service.ts:3821`); itu sendiri tidak mereproduksi temuan. E2 harus memakai event id baru untuk laporan refund X yang sama. Skenario ini juga bukan pengecualian CTO tentang jalur unmatched **tanpa** saklar mati: saklar mati pada kedua jalur pengiriman.

**Dampak:** Perbaikan P2-1 ronde 16 masih parsial untuk aturan satu alert per refund id lintas jalur. Tidak ditemukan pelepasan hold atau uang keluar berlebih pada skenario ini; gate saklar mati tetap menahan nilai penuh. Masalahnya adalah notifikasi ganda, bukan alert hilang.

**Usul test:** Perluas `refund-1144-e-switchoff-alert-dedup.test.ts:108`: pertahankan `R.providerRef` kosong sampai worker melewati jendela retry, kirim echo X/P tanpa nominal, dan pastikan alert pertama sudah ada. Baru pulihkan X, kirim event id baru dengan X/P yang sama, lalu jalankan worker/replay. Hitung kedua judul alert sekaligus seperti helper yang ada: tepat satu identitas dan satu baris per penerima. Pertahankan assertion hold terbuka, R tidak diselesaikan oleh gate saklar mati, tidak ada panggilan payout baru, dan refund manual ditolak. Fixture saat ini memulihkan X pada `:129` sebelum worker melewati jendela, sehingga tidak melewati pengiriman unmatched langsung setelah jendela tersebut.

## Status ronde 16 dan invariant yang diperiksa

- Skenario asli P2-1 ronde 16 tertutup secara statis: ketika X sudah tersimpan sebelum retry setelah jendela, gate saklar mati meneruskan X (`payment-webhook.service.ts:2968`); pengiriman switched-off (`:1382`) dan announce (`:1782`) memakai identitas tenant/integrasi/intent/refund id yang sama. Test `1144-e-01/02` menghitung kedua judul alert dan retry/replay; `1144-e-03` memisahkan dua refund id. Temuan di atas adalah variasi yang belum tercakup fixture tersebut.
- Penolakan echo kecil ketika R masih `approved` tidak lagi menutup hold: cabang 409 hanya mengumumkan hold (`payment-webhook.service.ts:3143`). Penutupan setelah updater berhasil tetap berada pada jalur `status === "succeeded"` (`:3166`). Updater memeriksa referensi, nominal, kontradiksi, dan status di bawah kunci sebelum `completeRefund` (`payment-refund.service.ts:4131`, `:4171`).
- Penutupan hold membatasi tenant, intent, payment, identitas refund/event, nominal hold tidak melebihi R, serta status hold terbuka (`payment-webhook.service.ts:1903`). Pada delta tidak ditemukan jalur baru yang menutup hold karena R masih approved atau karena event gagal, maupun jalur baru pembayaran melebihi pembayaran masuk. Ini pembacaan alur, bukan pembuktian invariant uang lewat eksekusi test.
- Tidak ditemukan alert hilang akibat dedup terlalu luas lintas tenant/intent: `reconHoldAlertId` memasukkan tenant, integrasi, intent, dan refund id (`payment-provider-refunded-alert.ts:354`); persistensi juga memakai kunci unik `(tenant_id, source_event_id)` (`db/schema/notification.ts:43`). Tidak ditemukan jalur lintas tenant baru dalam delta.
- Test baru `refund-1144-d-echo-closes-on-r-final.test.ts` mencakup approved, sukses, gagal, replay, saklar mati, dan batas sisa Rp40.000. Test `refund-1144-f-alert-key.test.ts:45` dan `:51` memisahkan tenant/integrasi/intent/refund pada fungsi hash. Sebagai tambahan verifikasi, uji dua tenant pada notifikasi aktual dan assertion tepat satu alert saat approved dengan saklar aktif akan memperkuat cakupan; assertion `1144-d-01/02` saat ini hanya membatasi jumlah maksimum satu.

## Verifikasi dan batas

- Dijalankan: fetch origin, pencocokan SHA, pembacaan diff/sumber/test pada head yang dipatok, dan pemeriksaan silang tiga subagent. Tidak checkout, membuat worktree, atau menjalankan layanan.
- Format diperiksa dengan binary Prettier 3.9.6 terpasang: `node node_modules/.pnpm/prettier@3.9.6/node_modules/prettier/bin/prettier.cjs --check docs/qa/second-opinion-refund-ronde17-1161.md`. Wrapper `pnpm exec prettier --check` gagal karena modul `node_modules/prettier/bin/prettier.cjs` tidak ditemukan; dependensi/symlink tidak diubah.
- Test database, reproduksi notifikasi ganda, konkurensi, suite regresi, typecheck, dan build tidak dijalankan. Tidak menyatakan test lulus atau invariant uang terbukti ulang secara runtime.
- Hanya laporan ini ditulis; tidak mengubah kode, dokumen lain, status Beads, commit, push, atau merge. Seluruh subagent pemeriksaan selesai dan tidak ada job latar yang tersisa.
