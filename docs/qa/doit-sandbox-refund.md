# QA sandbox DOIT: refund (legend-0yd1)

Tujuan: membuktikan di sandbox DOIT apa yang sebenarnya dijawab API refund, webhook refund, dan status payment. Kode saat ini menebak bentuk jawaban itu (dokumen DOIT tidak memuatnya). Hasil tes menentukan apakah kode perlu diubah.

Catatan: nama menu di portal DOIT belum diketahui dari kode. Tulisan "nama menu persis dikonfirmasi saat founder membuka portal" berarti kode tidak bisa memastikannya.

Sumber kode yang dipakai:

- `apps/api/src/services/payment-doit.ts`: loader kredensial (:313-320), POST pembayaran (:534), POST refund (:612-643), status payment (:646+).
- `apps/api/src/services/payment-doit-wire.ts`: `DOIT_BASE_URL` (:35), header `PayBridge-Signature` (:37), toleransi (:45), `parseDoitRefundAnswer` (:404), `doitRefundDeclineCode` (:386).
- `apps/api/src/services/payment-doit-refund-webhook.ts`: parser event refund dan pencocokan (`matchDoitRefundEvent`).
- `apps/api/src/routes/payment-webhook.routes.ts:122`: `POST /api/webhooks/payments/doit/:tenantId`.
- `apps/api/src/config/env.ts:142`: `DOIT_REFUNDS_ENABLED`.

## 1. Yang harus dipelajari

| #   | Yang dicek                                                                                               | Cara mengamati                                                                                                         | Kode yang bergantung                                                                                                          | Lulus                                                         | Gagal                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Respons `POST /v1/payments/{id}/refunds`: kode HTTP, sinkron atau async, field objek refund, prefix `id` | Capture request dan respons mentah (kunci disensor)                                                                    | `parseDoitRefundAnswer` (:404), `REFUND_SUCCEEDED/PENDING_STATUSES`                                                           | Bentuk jawaban cocok dengan parser, `id` dan `status` terbaca | Bentuk tidak dikenal: kode mengembalikan `DOIT_REFUND_UNRECOGNIZED` (hasil unknown, uang dianggap belum pasti) |
| 2   | Header `Idempotency-Key: refund:<uuid>` diterima; replay mengembalikan body yang sama                    | Kirim request yang sama dua kali dengan kunci sama, bandingkan body dan kode HTTP                                      | `idempotencyKey` (:359), `refundIdFromKey`                                                                                    | Replay sama, tidak ada refund ganda di dashboard sandbox      | Replay membuat refund kedua, atau menolak kunci                                                                |
| 3   | Field `amount` vs `total_amount` pada refund                                                             | Bandingkan angka pada refund dan payment setelah refund parsial dan penuh                                              | `parseDoitRefundAnswer` menolak `amount` yang tidak sama dengan `amountIdr`; `total_amount` dipakai di create path (:553-567) | Angka refund sama dengan yang dikirim                         | Refund memakai `total_amount` atau angka berbeda                                                               |
| 4   | GET payment: status dan amount setelah refund parsial dan penuh                                          | `GET /v1/payments/{id}` (lewat portal atau curl dengan header kunci sandbox dari berkas, lihat bagian 2)               | `payment.status === "refunded"` dan `payment.amount === amountIdr` (:672-683)                                                 | Status `refunded` dan `amount` sesuai aturan kode             | Status atau `amount` berbeda untuk refund parsial                                                              |
| 5   | Data webhook `refund.succeeded` (ada `idempotency_key`? `refund.id`? `object`?)                          | Trigger refund, catat body webhook mentah (tanpa rahasia) dari sisi DOIT atau dari baris event yang tersimpan aplikasi | `readDoitRefundFacts`, `matchDoitRefundEvent` (jalur a: kunci, b: refund id, c: payment `refunded`)                           | Salah satu dari jalur a atau b terbaca                        | Hanya jalur c yang bisa, atau tidak ada jalur yang cocok (event jadi "unmatched")                              |
| 6   | Data webhook `refund.failed` (sama seperti 5)                                                            | Trigger refund yang gagal (lihat langkah 6.5)                                                                          | `failureCode`, `matchDoitRefundEvent` (`refund.failed` tidak pernah masuk jalur c)                                            | `failure_code` atau refund id terbaca                         | Tidak ada refund id atau kunci: refund gagal tidak bisa dicocokkan                                             |
| 7   | Finalitas `refund.failed`                                                                                | Tanyakan ke DOIT tertulis; cek apakah refund bisa berubah dari failed ke succeeded                                     | Status `failed` dianggap final oleh kode                                                                                      | DOIT tertulis: failed final, atau ada aturan retry yang jelas | Failed bisa berubah: kode harus menunda keputusan                                                              |
| 8   | Konfirmasi tertulis bahwa `502 provider_refund_failed` berarti uang belum bergerak                       | Surat atau email resmi dari DOIT (simpan di luar repo, lihat bagian 6)                                                 | `doitRefundDeclineCode` memetakan 502 ke `DOIT_PROVIDER_REFUND_FAILED` (status failed, bukan unknown)                         | DOIT tertulis: uang belum keluar                              | DOIT tidak memastikan: kode 502 harus diperlakukan sebagai unknown                                             |
| 9   | Masa retensi idempotency key                                                                             | Tanyakan ke DOIT tertulis                                                                                              | Retry aman hanya selama kunci masih disimpan DOIT                                                                             | Ada angka jam atau hari                                       | Tidak ada jawaban: retry lama harus memakai kunci baru (perubahan desain)                                      |

Catatan untuk item 1 dan 8: `doitRefundDeclineCode` hanya memetakan kode `409 payment_not_refundable`, `400 invalid_refund_amount`, dan `502 provider_refund_failed`. Kode lain tetap unknown.

## 2. Secret yang dibutuhkan dan di mana

Kunci disimpan sebagai kredensial integrasi DOIT, bukan di `.env`.

| Secret                 | Dipakai untuk                                        | Di mana di portal DOIT                                                                | Di mana di aplikasi                                   |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| API key sandbox        | `Authorization: Bearer` pada semua panggilan ke DOIT | Menu **Developer**, buat aplikasi; kunci tampil sekali saat dibuat, awalan `pb_test_` | Settings > Integrations > DOIT, field `apiKey`        |
| Webhook signing secret | Verifikasi header `PayBridge-Signature`              | Menu **Developer** (signing secret aplikasi yang sama)                                | Settings > Integrations > DOIT, field `webhookSecret` |

Aturan:

- Tanpa `apiKey` atau `webhookSecret`, loader mengembalikan null dan panggilan DOIT tidak dibuat.
- Pilih environment `sandbox` di form integrasi (default). Kode membaca `config.baseUrl` untuk override host. Field `environment` ada di form UI, tetapi kode `payment-doit.ts` tidak membacanya. Dari kode, host tetap `https://pay.doit.id` kecuali `config.baseUrl` diisi.
- Kunci sandbox dan live dibedakan oleh prefix kunci (catatan di `payment-doit-wire.ts:33`). Pastikan kunci yang dipakai adalah kunci sandbox.
- Jangan cetak nilai kunci di log, chat, atau dokumen. Jangan tulis ke `.env` atau `.env.local`.
- Jangan taruh kunci sandbox di baris perintah curl (masuk riwayat shell dan `ps`). Pakai berkas header dengan izin `chmod 600`, isinya `Authorization: Bearer ...`, disimpan di luar repo, dan dihapus setelah dipakai. Contoh: `curl -H @"$KEYFILE" ...`.

### Host sandbox (hasil cek dokumentasi publik DOIT, 9 Nov 2026)

Sumber: <https://doit.id/docs/en/>.

- Sandbox dan live memakai host yang sama: `https://pay.doit.id`. Dokumentasi: "The environment is determined by the key prefix, not the base URL". Jadi `DOIT_BASE_URL` di kode sudah benar dan `config.baseUrl` tidak perlu diisi untuk sandbox.
- Kunci sandbox berawalan `pb_test_`, kunci live berawalan `pb_live_`. Sebelum menyimpan, cek awalannya saja (jangan cetak sisanya).
- Akun baru mulai dalam mode sandbox. Perilaku sandbox sama dengan production (endpoint, format, error), kecuali tidak ada uang nyata dan pelunasan dipicu manual lewat tombol simulasi di portal (buka payment di portal, tekan "Simulate paid"). Tombol itu ada di portal, bukan di halaman checkout.
- API key dibuat per aplikasi di menu **Developer** portal dan hanya ditampilkan **sekali** saat dibuat. Signing secret webhook juga ada di menu **Developer**. URL webhook diatur per aplikasi.
- Dokumentasi tidak menjelaskan perilaku refund khusus sandbox. Yang tertulis umum: `POST /v1/payments/{id}/refunds`, `amount` opsional (default penuh), hanya payment `paid` yang bisa direfund, refund parsial boleh berulang sampai total sama dengan jumlah awal. Butir checklist bagian 1 tetap harus dibuktikan di sandbox.
- Mode compat (Duitku/Xendit) memakai host yang sama. Legend memakai API native, jadi isi field webhook native, jangan aktifkan compat.

## 3. Langkah portal untuk founder

Dilakukan founder sendiri di portal DOIT (akun masih mode sandbox). Semua pengaturan ada di menu **Developer**.

1. Login ke portal DOIT sandbox dengan akun merchant sandbox.
2. Buka menu **Developer**, buat aplikasi (misalnya `Legend sandbox`). Salin API key yang tampil (hanya tampil sekali, awalan `pb_test_`). Simpan di password manager.
3. Di aplikasi yang sama (menu **Developer**), isi URL webhook native:
   `https://<tunnel-host>/api/webhooks/payments/doit/<tenantId>`
   Ganti `<tunnel-host>` dengan host tunnel (bagian 5) dan `<tenantId>` dengan ID tenant sandbox.
4. Pilih event: `payment.paid`, `payment.expired`, `refund.succeeded`, `refund.failed`. Tambahkan `webhook.test` bila ada.
5. Salin signing secret webhook dari menu **Developer**. Simpan di password manager.
6. Kirim kedua nilai ke tim lewat `ghostex secret request`, bukan lewat chat.

## 4. Setup lokal di worktree ini

Worktree: `.worktrees/doit-sandbox`. Gunakan port dan nama database sendiri.

Uji sandbox hanya di database lokal worktree ini. Jangan menyalakan `DOIT_REFUNDS_ENABLED` terhadap database bersama (staging) sebelum reset legend-d21p (`pnpm db:reset-preswitch-refunds`) selesai di sana: setelah ada jejak kiriman DOIT, script reset menolak `--apply` untuk selamanya.

1. Dari root worktree: `pnpm run setup` (sekali) atau `pnpm dev:prepare` dan `pnpm run doctor`. Setup memilih port database yang bebas dan nama database sendiri. Cek port dengan `pnpm run doctor` atau `pnpm db:status`. Jangan buka `.env.local`: isinya password.
2. `pnpm dev:prepare` sudah menjalankan `pnpm db:up`, `pnpm db:migrate`, provisi role aplikasi, dan seed tenant dev (`apps/api/src/db/seed-dev-tenant.ts`). Tidak perlu langkah seed atau migrate terpisah. Jalankan ulang hanya bila perlu.
3. Jalankan API dan worker dengan `DOIT_REFUNDS_ENABLED=true`. Hanya lokal. Jangan set di staging atau production. Gunakan redirect atau env inline saat menjalankan, bukan file `.env`.
4. Buka Settings > Integrations, isi provider DOIT dengan environment `sandbox`, `merchantName` (wajib), `apiKey`, dan `webhookSecret`. Simpan, lalu tekan Activate (`integrations-page.tsx:336`). Hanya integrasi berstatus `active` yang memuat kredensial dan webhook secret. Tanpa Activate: panggilan DOIT gagal tertutup, webhook dijawab 401, dan 401 itu ikut dihitung ke limiter 429.
5. Override host: kode hanya menerima `https://pay.doit.id` tanpa override. Override `config.baseUrl` harus https publik, tanpa port, tanpa kredensial, tanpa IP literal, dan bukan localhost (`parseDoitBaseUrl`, :178). UI tidak punya field `baseUrl`. Jika DOIT sandbox memakai host lain, isi `config.baseUrl` lewat database dev dengan persetujuan CTO, dan catat di `docs/PROGRESS.md`. Jika host sandbox sama dengan live, tidak perlu override.
6. Verifikasi: `curl http://localhost:<API_PORT>/api/health` harus merespons.

Catatan: `DOIT_REFUNDS_ENABLED=true` hanya mengizinkan worker mengirim refund. Tes bisa dijalankan tanpa flag ini untuk langkah 1-6 bila hanya memanggil API DOIT langsung.

## 5. Tunnel untuk webhook

Default: cloudflared quick tunnel.

```
cloudflared tunnel --url http://localhost:<API_PORT>
```

Alternatif: ngrok (`ngrok http <API_PORT>`).

Catatan:

- Host tunnel berubah setiap kali quick tunnel dijalankan ulang. Daftarkan ulang URL webhook di portal setiap kali berubah.
- Verifikasi tanda tangan memakai body mentah (raw bytes). Proxy atau middleware yang mengubah body (misalnya JSON re-serialize) akan membuat tanda tangan gagal.
- Toleransi timestamp: lebih tua dari 25 jam atau lebih dari 5 menit di depan server ditolak (`DOIT_SIGNATURE_TOLERANCE`).
- Webhook yang tanda tangannya gagal dijawab 401 dan dihitung. Tanda tangan benar tidak menghabiskan jatah 401.

## 6. Langkah tes per item checklist

Simpan bukti di `docs/qa/evidence/doit-sandbox/`. Aturan:

- Folder ini punya `.gitignore` sendiri: semua berkas diabaikan git kecuali yang bernama `*.redacted.*`. Berkas mentah tidak di-commit.
- Hanya versi yang sudah disensor, diberi nama `<item>.redacted.json` atau `.redacted.txt`, (tanpa `Authorization`, tanpa `webhookSecret`, tanpa signature hex lengkap, tanpa data pembeli) yang boleh di-commit.

Persiapan: buat payment sandbox (QRIS atau VA) untuk tenant dev, lalu bayar lewat simulasi sandbox DOIT sampai status `paid`.

6.1 Respons refund (item 1)

- Kirim refund parsial lewat alur refund aplikasi (approve lalu worker) atau langsung ke `POST /v1/payments/{id}/refunds` dengan `Idempotency-Key: refund:<uuid>`.
- Catat kode HTTP, header, dan body. Catat apakah respons langsung `succeeded`, `pending`, atau lainnya.
- Catat prefix `id` refund dan `id` payment.

6.2 Idempotency (item 2)

- Ulangi request di 6.1 dengan kunci dan body yang sama. Bandingkan body dan kode HTTP.
- Ulangi dengan body berbeda dan kunci sama. Catat jawaban DOIT (diharapkan ditolak, catat kodenya).

6.3 Amount (item 3)

- Refund parsial, catat `amount` dan `total_amount` pada refund dan payment.
- Refund penuh, lakukan hal yang sama.

6.4 Status payment (item 4)

- `GET /v1/payments/{id}` setelah refund parsial dan setelah refund penuh. Catat `status` dan `amount`.

6.5 Webhook refund (item 5 dan 6)

- Trigger `refund.succeeded` dari refund parsial. Catat body webhook mentah (tanpa signature).
- Trigger `refund.failed` lewat cara yang disediakan sandbox (nama skenario dikonfirmasi saat membuka portal). Catat body dan `failure_code`.
- Cek hasil parser: baca baris `gateway_webhook_events` yang tersimpan. Kolom `status` berisi `failed` (akan dicoba ulang) lalu `ignored`, dan `last_error_code` berisi `REFUND_UNMATCHED` bila refund tidak cocok. Hasil cocok atau tidak cocok tidak dicatat di log aplikasi. Jangan cetak body lengkap.

6.6 Finalitas failed (item 7)

- Tanyakan ke DOIT tertulis (bagian 8).

6.7 502 provider_refund_failed (item 8)

- Pastikan skenario sandbox menghasilkan 502. Tanyakan ke DOIT tertulis apakah uang belum keluar. Simpan jawaban tertulis.

6.8 Retensi idempotency key (item 9)

- Tanyakan ke DOIT tertulis. Catat angkanya.

Setelah tiap langkah, tulis hasil ke `docs/PROGRESS.md`: sudah apa, sedang apa, dan hasil lulus atau gagal.

## 7. Perubahan kode per hasil

| Hasil                              | Perubahan                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| 6.1 bentuk jawaban cocok           | Tidak ada. Catat contoh tersensor di `docs/qa/evidence/doit-sandbox/`.                      |
| 6.1 bentuk tidak cocok             | Ubah `parseDoitRefundAnswer` (:404) sesuai bentuk nyata. Tambah tes parser.                 |
| 6.2 replay beda                    | Tahan refund baru sampai kunci dipahami. Jangan kirim retry dengan kunci baru.              |
| 6.3 `total_amount` dipakai         | Ubah `amountIdr` yang dikirim atau pemetaan di `parseDoitRefundAnswer`. Perlu review uang.  |
| 6.4 status payment berbeda         | Ubah `payment.status === "refunded"` di `getRefundStatus` (:672-683).                       |
| 6.5 tidak ada kunci atau refund id | Ubah `readDoitRefundFacts` dan `matchDoitRefundEvent`. Pertimbangkan jalur c dengan review. |
| 6.6 failed bisa berubah            | Ubah perlakuan `refund.failed` di payout service. Jangan anggap final.                      |
| 6.7 502 bukan "uang belum keluar"  | Hapus pemetaan 502 di `DOIT_REFUND_DECLINES` (:378-382). Status jadi unknown.               |
| 6.8 retensi pendek                 | Refund retry memakai kunci baru hanya setelah konfirmasi operasional. Review uang wajib.    |

Semua perubahan di area uang masuk review architect dan second opinion (aturan diff tingkat K). Dokumen ini tidak mengubah kode.

## 8. Pembersihan

1. Hentikan `cloudflared` (Ctrl+C) atau ngrok.
2. Hapus URL webhook di portal DOIT sandbox.
3. Hapus atau revoke API key sandbox yang tidak dipakai lagi.
4. Hapus kredensial sandbox dari Settings > Integrations di database dev, atau reset tenant dev.
5. Hapus `DOIT_REFUNDS_ENABLED=true` dari perintah atau env yang dipakai.
6. Hentikan API dan worker. Jalankan `pnpm db:down` bila database tidak dipakai lagi (volume tetap disimpan).
7. Pastikan `docs/qa/evidence/doit-sandbox/` hanya berisi versi tersensor yang akan di-commit.
