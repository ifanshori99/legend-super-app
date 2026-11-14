# Urutan rilis sync katalog edge: cloud dulu, edge kemudian (legend-dciax)

Runbook ini untuk operator rilis. Dipakai setiap kali rilis membawa perubahan sync katalog edge (`GET /api/edge-sync/catalog`) yang menyangkut `syncTxid` dan kursor `cat2` (commit 88419ea8, desain di `docs/briefs/24318-design.md`).

Latar belakang singkat: setiap record katalog dari cloud membawa `syncTxid` (id transaksi cloud, dari `pg_snapshot_xmin`), dan kursor edge bertag `cat2`. Edge yang baru mem-parse `syncTxid` di tiap record dan menolak record tanpa field itu. Cloud lama tidak mengirim `syncTxid`.

## Urutan wajib

1. **Cloud dulu.** Rilis dan pastikan cloud baru sudah melayani semua instance (tidak ada instance lama yang tersisa di belakang load balancer). Jalankan migrasi bila rilis membawanya (`pnpm db:migrate`).
2. **Cek cloud sudah mengirim `syncTxid`** (lihat bagian cek di bawah).
3. **Baru edge.** Naikkan versi edge outlet satu per satu, mulai dari satu outlet percobaan. Lanjut ke outlet lain setelah sync katalog outlet percobaan berjalan.

Jangan pernah membalik urutan ini, dan jangan menaikkan edge sambil cloud masih setengah rilis.

Pengecualian yang disengaja: rilis yang mengganti baris katalog basi di antrean edge dengan placeholder `edge_link.dead_lettered` (legend-3k41y) menuntut edge dulu. Aturan dan cara menggabungkannya dengan urutan di atas ada di `docs/deployment.md`, bagian "Edge host".

## Gejala bila terbalik (edge baru, cloud lama)

- Pull katalog di edge gagal untuk semua stream. Edge menolak dengan pesan `Cloud belum mendukung syncTxid katalog`, bukan gagal parse mentah.
- Data katalog dan harga di edge berhenti bergerak. Yang sudah ada tetap dipakai dan tidak rusak. Checkpoint tidak maju, jadi tidak ada data yang hilang atau dilewati.
- Edge memakai katalog terakhir yang sudah tersinkron (belum diuji end to end saat cloud lama). Risikonya harga lama bertahan sampai sync pulih.

Catatan: guard dengan pesan di atas dibuat di kartu yang sama (legend-dciax). Pada edge yang belum membawa guard itu, gejalanya berupa kegagalan parse `syncTxid` pada record. Penanganannya sama.

Pulihkan dengan menaikkan cloud ke versi baru. Tidak perlu menyentuh edge atau data lokal: pull berikutnya berjalan sendiri dari checkpoint terakhir.

## Cara cek cloud sudah mengirim `syncTxid`

1. Cek versi: commit yang berjalan di cloud harus memuat 88419ea8.

   ```
   git merge-base --is-ancestor 88419ea8 <sha-cloud-yang-berjalan> && echo ok
   ```

2. Cek langsung dari respons. Pakai kredensial edge node outlet percobaan, simpan di variabel shell dan jangan dicetak. Satu halaman kecil saja:

   ```
   curl -s -H "Authorization: Bearer $EDGE_CREDENTIAL" \
     "https://<host-cloud>/api/edge-sync/catalog?stream=stations&limit=1" \
     | jq '.records[0].syncTxid'
   ```

   Hasil harus string angka (mis. `"4821937"`). `null` berarti cloud belum mengirim `syncTxid`: cloud masih versi lama, atau instance lama masih melayani. Bila stream `stations` kosong di tenant itu, ulangi dengan `stream=menu_items`.

3. Setelah edge dinaikkan: pull katalog di edge tidak lagi melaporkan error, dan checkpoint `catalog:<stream>` di `edge_pull_checkpoints` bergerak maju.

## Rollback

- **Cloud perlu dikembalikan sementara edge sudah baru:** jangan biarkan begitu. Kembalikan edge ke versi sebelumnya dulu, atau terima bahwa sync katalog berhenti (gejala di atas) sampai cloud naik lagi. Data lokal aman.
- **Edge dikembalikan, cloud tetap baru:** tidak ada data cloud yang berubah. Perilaku edge versi lama terhadap kursor `cat2` yang tersimpan dan terhadap record ber-`syncTxid` belum diverifikasi, jadi coba di satu outlet dulu.
- **Cloud dikembalikan:** hanya bila edge semua sudah dikembalikan ke versi lama. Urutan rollback adalah kebalikan rilis: edge dulu, cloud kemudian.
- Migrasi tidak ikut dibatalkan pada rollback kode. Jangan menurunkan skema (lihat `AGENTS.md`: jangan menulis ulang migrasi yang sudah terpakai).

## Rollback 0288 dan 0289 (stream promosi dan voucher, brief 533)

Migrasi 0288 (dulu 0333; `sync_txid` di `promotions`, `vouchers`, `promo_settings`, trigger) dan 0289 (dulu 0334; tabel `edge_voucher_catalog`) tidak ikut dibatalkan saat kode dikembalikan. Bila skema memang harus dikembalikan, pakai skrip `apps/api/scripts/rollback-0288-0289-edge-promo-streams.sql` (bukan migrasi, dijalankan manual lewat `psql`, satu transaksi).

1. Edge semua outlet dikembalikan dulu, lalu kode cloud. Skrip dijalankan paling akhir, setelah tidak ada kode yang membaca kolom `sync_txid` promosi atau `edge_voucher_catalog`.
2. Data yang hilang memang disengaja: stempel `sync_txid` dan isi `edge_voucher_catalog`. Aturan promosi, voucher, dan counter (`uses_total`, `spent_idr`) tidak tersentuh.
3. Skrip juga menghapus baris migrasi 0288 dan 0289 dari `drizzle.__drizzle_migrations` supaya roll-forward berikutnya menerapkannya lagi.
4. Stream voucher mengirim semua voucher tenant (belum hanya yang aktif); membatasi ke voucher aktif belum dikerjakan.

## Catatan rilis: tidak perlu scrub `code_hash` lama (brief 533, keputusan CTO)

Commit 528 (stream promosi dan voucher dengan `codeHash`) belum pernah sampai ke edge nyata, jadi tidak ada baris `promotions.code_hash` atau `edge_voucher_catalog.payload` berisi hash asli di edge produksi. Rilis pertama sudah membawa stream tanpa `codeHash` (promo berkode memakai `codeRef`); scrub satu kali tidak diperlukan. Bila ada edge uji yang pernah menyinkron dari commit 528, bangun ulang basis datanya.
