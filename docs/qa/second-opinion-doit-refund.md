# Second opinion DOIT dan refund — 793

Tanggal: 14 November 2026. Pemeriksaan read-only atas `origin/milestone/m1...origin/ws/doit-refund-hardening`, head `ed32fc48e81e621ec8fa05cf868838022b45e5fe`, merge-base `9b8433f691f1d34533e9728ddf49f697112e174b`. Ref lokal `origin/milestone/m1` saat pemeriksaan: `b42619abce5d326d547c4ae17293adca970db99e`. Tidak melakukan fetch atau mengubah kode produk.

Hasil: **3 P2; tidak ada temuan konkret P0, P1, atau P3.** Dua temuan deploy direproduksi dengan konfigurasi sintetis; temuan webhook dibuktikan lewat alur kode, belum melalui test API.

## Temuan

- **P2 — `deploy/single-vm/check-refund-flag.sh:26` — Override path dari shell membuat pemeriksaan membandingkan file yang berbeda dari file yang dipakai Compose.** Skenario: `compose.env` menunjuk `api.env=false` dan `worker.env=false`, tetapi shell mengekspor `WORKER_ENV_FILE` ke file lain berisi `DOIT_REFUNDS_ENABLED=true`. `service_file()` membaca path mentah dari `compose.env`, sehingga checker keluar 0; Compose pada `deploy.sh:20` memakai override shell untuk `${WORKER_ENV_FILE}` di `compose.yaml:98`, sehingga API efektif `false` dan worker `true`. Sakelar pembayaran otomatis berbeda meski gerbang deploy lolos. **Perbaikan:** Bandingkan flag efektif dari konfigurasi Compose yang benar-benar akan dijalankan, tanpa mencetak konfigurasi/rahasia; atau samakan resolusi path dan environment secara ketat. **Usul test:** Ekspor override `WORKER_ENV_FILE` dan `API_ENV_FILE` secara terpisah; jika flag efektif berbeda, deploy harus berhenti sebelum `compose up`, migrasi, atau start layanan.

- **P2 — `deploy/single-vm/check-refund-flag.sh:34` — Deklarasi bare setelah deklarasi bernilai dapat menyembunyikan flag berbeda.** Skenario: shell tidak memiliki `DOIT_REFUNDS_ENABLED`; `api.env` berisi `DOIT_REFUNDS_ENABLED=true` lalu baris `DOIT_REFUNDS_ENABLED`, sedangkan `worker.env` berisi `DOIT_REFUNDS_ENABLED=false`. Checker memakai `printenv` untuk baris bare terakhir dan menganggap API `off`; Compose 5.6.0 mempertahankan nilai sebelumnya dalam file, sehingga API efektif `true`, worker `false`. Checker keluar 0 dan antrean refund otomatis dapat terbentuk tanpa worker pembayaran yang aktif. **Perbaikan:** Gunakan nilai efektif Compose; jika parser manual dipertahankan, tangani deklarasi sebelumnya dan sumber environment yang dipakai Compose. **Usul test:** Fixture dua deklarasi tersebut harus ditolak; tambahkan variasi kebalikannya dan variasi dengan nilai shell tersedia. Test deploy sekarang memakai stub Compose, sehingga tidak membuktikan kesamaan semantik parser ini.

- **P2 — `apps/api/src/services/payment-webhook.service.ts:358` — Jalur refund-only baru masih kehilangan secret jika provider dicabut dari paket ketika uang sedang berjalan.** Skenario: payout refund DOIT sudah diterima provider; integrasi dinonaktifkan, lalu `doit` dihapus dari `tenants.feature_flags.integrationProviders`; sesudah cache secret berakhir/dibersihkan, `refund.succeeded` bertanda tangan sah tiba tanpa `data.reference`. Lookup baru menemukan integrasi melalui refund, tetapi pemanggilan `loadIntegrationCredentialsById` pada `:365` tidak mengirim `{ forStoredIntent: true }`; pemeriksaan paket di `platform-integration.service.ts:947` mengembalikan `null`, lalu receipt ditolak 401 pada `payment-webhook.service.ts:1692`. Refund lokal tetap `approved` walau uang sudah keluar. Polling DOIT juga memakai loader tanpa opsi tersebut (`payment-doit.ts:133`, `:717`), sehingga tidak memulihkan rekonsiliasi. **Perbaikan:** Gunakan bypass pemeriksaan paket khusus pembayaran/refund tersimpan sambil mempertahankan binding tenant, provider, integrasi, dan verifikasi HMAC; penarikan paket tetap memblokir pembayaran baru. **Usul test:** Perluas test disabled-integration: cabut provider dari paket, kosongkan cache, kirim refund-only sah lewat key maupun provider refund ID, lalu pastikan refund selesai tepat sekali, replay tidak menambah payout, dan signature salah/lintas tenant tetap ditolak. Ini celah yang tersisa pada hardening baru; default loader yang menolak paket sudah ada sebelum diff ini, dan jalur dengan `data.reference` juga terdampak.

## Bukti eksekusi ringan

Menggunakan checker dan `deploy/single-vm/compose.yaml` asli dengan file environment sintetis sementara. `docker compose config --format json` versi **5.6.0** hanya meresolusi konfigurasi; tidak menyalakan container, mengakses rahasia, atau memanggil provider.

| Skenario | Exit checker | Exit Compose config | API efektif | Worker efektif |
| --- | --- | --- | --- | --- |
| Override shell `WORKER_ENV_FILE` | 0 | 0 | `false` | `true` |
| `true` lalu deklarasi bare; shell flag tidak ada | 0 | 0 | `true` | `false` |

Kedua mismatch direproduksi oleh subagent lalu diulang independen oleh pemeriksa utama. Tidak menjalankan deploy nyata.

## Cakupan yang tidak menghasilkan temuan konkret

- **Webhook:** Lookup refund mengikat tenant dan provider; secret integrasi asal tetap harus memverifikasi HMAC. Proses hasil mengikat integrasi/payment/amount, mencegah event ganda per integrasi, serta mengunci graph refund sebelum completion. Tidak ditemukan bypass signature, lintas tenant, atau refund ganda pada jalur baru.
- **Reopen/MFA:** Gate below-tier berada sebelum `applyApproval` (`payment-refund.service.ts:1475`); reopen dan approve memakai lock graph yang sama. Marker audit dibuat dalam transaksi reopen (`:3052`), dilindungi append-only selama dua tahun, dan fallback usia >700 hari menahan approval tanpa MFA setelah marker bisa dipurge. Replay idempotensi approval lama tidak membayar refund yang kembali `pending` (`:2067`). Tidak ditemukan jalan pintas MFA konkret.
- **VA lama:** Diff hanya menambah penjelasan dan test untuk window 24 jam. Lock bill/intent serta idempotensi refund sistem tidak menghasilkan skenario refund ganda konkret dari pembacaan kode. Test baru mengonfirmasi pembayaran secara langsung, sehingga belum membuktikan perjalanan penuh melalui poller.

## Usul test tambahan

- **VA/poller:** Bayar VA lama setelah ganti bank, buat `pollPendingGatewayIntents` membaca status `paid`, kirim webhook bersamaan, lalu buktikan satu fund/refund sistem, payout tidak melebihi penerimaan lama, dan intent baru tidak berubah.
- **MFA/retensi:** Replay kunci approval sebelum quarantine sesudah reopen; tanpa MFA refund harus tetap pending dan provider tidak dipanggil. Uji role aplikasi gagal menghapus marker serta batas tepat 700 hari dan >700 hari.

## Batas verifikasi

Tidak menjalankan suite API, `pnpm check`, build, e2e, atau `heavy`, sesuai brief. Test API baru dibaca, bukan dinyatakan lulus. Tidak mengklaim bukti dinamis bahwa semua race dan invariant uang aman. Tiga subagent read-only digunakan, puncak bersamaan tiga; hanya berkas laporan QA ini yang ditulis di worktree.
