# 204b hasil architect (legend-hfq3z), 9 Nov 2026

Catatan: 996cc889 BELUM ada di `milestone/m1` (94d769c6). Kode ini masuk di `integ/m1-batch28` (0ae0a76b) dan diperiksa di sana (1f83d4aa).

**Bersih.** Tidak ada temuan P1/P2.

Jawaban:
1. Nomor ganda, lompat tanpa jejak, atau pensiun run yang sudah menomori:
   - Heal hanya menyentuh baris yang terikat tepat ke binding ini, dengan lastNumber cloud 0. Run baru memakai prefix yang belum pernah ada di cloud. Edge menolak prefix yang bentrok secara lokal.
   - Pensiun `prefix_used` pada baris dengan edge_reported_number > 0 aman. Satu database yang melaporkan `prefix_used` untuk id X tidak memegang X sebagai run sekarang: bila id dan prefix sama, hasilnya `kept`. Jadi X di database itu tidak sedang menomori, dan memensiunkan tidak pernah menerbitkan ulang nomor.
   - Clone: database A bisa sedang menomori X ketika database B melaporkan `prefix_used`. X dipensiunkan, lalu A ikut pindah ke run baru. Keduanya kemudian menomori run baru itu. Ini batas clone yang sudah diketahui; deteksinya lewat regresi berikutnya. Lihat P3.
2. Idempoten: sudah. Id yang sudah pensiun diabaikan. Lock outlet menserialkan request bersamaan. Request lama tertahan oleh cek token stale. Request yang timeout sesudah commit dilaporkan ulang, lalu diabaikan. Indeks `device_current_key` mencegah run ganda.
3. Isolasi: sudah. Refusal hanya dicocokkan ke `current` yang di-scope tenant, outlet, dan binding (pos-receipt.service.ts:1022-1046, 1056-1067). Id asing diabaikan.
4. Kompatibilitas: sudah. Rantai 400 bertahap (cloud-http.ts:185-228): tanpa `receiptRefused`, lalu tanpa `receiptRuns`, lalu tanpa urutan struk. Edge lama tidak mengirim refusal. Validasi query menolak sebelum ada efek samping.
5. Interaksi dengan yd0h8 dan sduiq: baris yang di-heal langsung `continue`. `prefix_used` yang tidak di-heal melewati cek regresi (:1119). `id_used` yang tidak eligible jatuh ke cek regresi, dan itu benar. sduiq memensiunkan run lokal lama di pull yang sama, lalu pull berikutnya memasang run baru (`inserted`).
6. Penanda 0 / 1 ms: `edge_regressed` dan `cloud_takeover` tidak cocok karena difilter reason. Rotasi klaim biasa (`retired_at = now()` jam DB, `edge_reported_at` = tau lama jam app) hanya cocok bila kedua jam kebetulan sama sampai mikrodetik. Dampaknya paling jauh satu hitungan throttle atau alarm clone palsu. Dapat diabaikan; diganti oleh legend-p7gb6.

P3 (catatan, tanpa kartu):
- pos-receipt.service.ts:1097-1102: floor hanya dari prefix di laporan, yaitu run lokal yang SEKARANG. Prefix lokal yang sudah pensiun dan tidak dimiliki cloud (sesudah restore cloud) dilewati satu per pull, dan setiap langkah memakan 1 dari 10 heal per 24 jam. Saran: edge mengirim nomor prefix lokal tertinggi (termasuk yang pensiun), atau cloud menaikkan floor dari prefix yang ditolak berulang.
- pos-receipt.service.ts:1001-1012: heal `prefix_used` dikeluarkan dari cek clone dan mengabaikan edge_reported_number. Pada clone hidup, rotasi pertama tidak memicu alarm; alarm baru muncul lewat regresi berikutnya. Ini cukup diaudit lewat legend-p7gb6.
