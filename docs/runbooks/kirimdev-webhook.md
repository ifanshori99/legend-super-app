# Kirimdev webhook WhatsApp: rotasi secret dan uji produksi (legend-s5rgo)

Berlaku untuk `POST /api/webhooks/whatsapp` (login WhatsApp dan reset PIN slip gaji). Setup awal: `docs/deployment.md`, bagian "Kirimdev inbound WhatsApp". Secret tidak pernah dicetak, dicatat, atau dikirim lewat chat; minta lewat `ghostex secret request`.

## Rotasi secret

`KIRIM_WEBHOOK_SECRET` boleh berisi beberapa secret dipisah koma. Webhook lolos bila salah satu cocok (jendela rotasi tanpa downtime).

1. Buat langganan baru (atau secret baru) di Kirimdev: `POST /v1/webhook_subscriptions`. Ambil secret baru lewat `ghostex secret request`.
2. Pasang kedua secret: `KIRIM_WEBHOOK_SECRET=<baru>,<lama>`. Deploy API. Kirimdev masih menandatangani dengan yang lama, jadi tidak ada pesan yang ditolak.
3. Arahkan Kirimdev ke secret baru (hapus langganan lama setelah yang baru aktif).
4. Tunggu sampai tidak ada kiriman bertanda tangan lama (minimal toleransi 5 menit, lebih aman satu jam).
5. Buang secret lama: `KIRIM_WEBHOOK_SECRET=<baru>`. Deploy.
6. Jalankan uji rotasi di bawah.

Simulator memakai secret pertama dari daftar, jadi urutan `<baru>,<lama>` menguji secret baru.

## Uji dengan simulator

Simulator: `node scripts/wa-simulate-inbound.mjs --help`. Membaca `KIRIM_WEBHOOK_SECRET` dari env shell (jangan `echo`), `--url` menunjuk API yang diuji, `--phone-number-id` nomor terdaftar tenant. Untuk produksi, ekspor secret lewat redirect shell, jangan cetak nilainya.

| Uji                   | Perintah (ringkas)                                                            | Hasil yang benar                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pemalsuan             | `--bad-signature --from 628... --text "RESET PIN K7Q4-M2XD"`                  | 401, tidak ada baris `wa_inbound_messages`, tidak ada sesi atau bukti                                                                                                                                 |
| Replay                | kirim dua kali dengan `--message-id uji-1` yang sama (teks dan pengirim sama) | kiriman kedua diterima (200) tetapi dicatat duplikat, tidak memproses ulang. Id yang sama dengan teks atau pengirim berbeda menghasilkan `CONFLICT`, bukan duplikat                                   |
| Rotasi                | dengan secret baru, lalu secret lama, saat keduanya terpasang                 | keduanya 200; secret yang sudah dibuang: 401                                                                                                                                                          |
| Nomor tidak terdaftar | `--phone-number-id <id yang bukan milik tenant>`                              | 200, pesan dicatat tak dikenal, tanpa efek                                                                                                                                                            |
| Beberapa pesan        | `--count 3`, atau `--from`/`--text` diulang dalam satu kiriman                | tiap pesan diproses sendiri. Toleransi `CONFLICT` per pesan datang dengan kartu A (`legend-lgfru`, cabang `ws/lgfru-wa-proof`); sebelum kartu itu digabung, satu `CONFLICT` menghentikan sisa kiriman |
| Secret kosong         | jalankan API tanpa `KIRIM_WEBHOOK_SECRET`                                     | webhook 503; membuat tantangan reset PIN 503                                                                                                                                                          |
| Salah tujuan          | kode login dikirim `RESET PIN ...`, atau kode reset dikirim `MASUK ...`       | ditolak, tantangan tetap `pending`                                                                                                                                                                    |

Tanda tangan salah memang harus 401; jangan anggap itu galat. Reset PIN lewat WhatsApp hanya lolos dari nomor yang terverifikasi dan tertaut minimal 3 hari (`WA_PROOF_IDENTITY_MIN_AGE_DAYS`); untuk uji di staging, geser `user_identities.linked_at` lewat SQL pada akun uji saja.

## Bila webhook berhenti

- 503 terus: `KIRIM_WEBHOOK_SECRET` kosong di proses API.
- 401 terus dari Kirimdev: secret di API tidak cocok dengan langganan (rotasi tidak lengkap). Pasang kedua secret lalu ulangi langkah rotasi.
- Login WhatsApp dan reset PIN mati bersama bila nomor diblokir Meta; login email dan Google serta reset PIN oleh HR tetap jalan.
