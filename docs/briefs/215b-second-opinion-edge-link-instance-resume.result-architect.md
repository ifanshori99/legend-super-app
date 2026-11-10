# 215b hasil architect 1 (review ganda Claude, brief 225)

Rentang: `e1100258..e7dad52d` (ws/edge-link-instance-resume), termasuk migrasi 0162. Cabang belum masuk `milestone/m1` (m1 = 94d769c6); temuan berlaku untuk cabang.

Hasil: temuan (1 P2, 2 P3). Kartu baru: legend-a9iby (P2).

## Invariant yang terbukti
- Rebuild (instance baru, cursor 0): `bindPeer` mengunci kedua baris dalam satu transaksi. Offset inbound = `received_in_seq`, outbound = `acked_out_seq`. Event baru edge diterima dari 1. Event cloud yang pending dikirim. Yang sudah di-ack instance lama tidak diputar ulang. Tidak ada 1008 berulang.
- Link basi: `peerNumbering` dibaca sesudah `lockSyncCursor` di `applyInbound`/`ackOutbound`. Baris yang terikat instance lain ditolak, termasuk link tanpa instance. Urutan kunci sama dengan `bindPeer`, jadi tidak ada deadlock.
- Reconnect di tengah rebase: bind atomik. Hello cloud dikirim hanya sesudah bind. Edge baru mengirim event hanya sesudah menerima hello cloud.
- Edge lama tanpa header dan baris milik edge sendiri tidak memakai hook, offset 0, dan perilakunya sama.
- Trigger dan check: offset tidak turun, offset hanya berubah saat instance berganti dari non-null ke non-null lain, dan instance tidak bisa kembali null. Badan fungsi 0162 sama dengan `edge-node.custom.sql`. FORCE RLS diangkat lalu dipasang lagi. Baris lama valid (offset 0).
- TEN-01/02: node dan tenant berasal dari kredensial dan RLS. Header hanya memilih perilaku, bukan dasar akses.

## Temuan
- P2 legend-a9iby, `apps/api/src/edge/db-link-store.ts` (`bindPeer`, `if (stored === instance) continue`) dengan `apps/api/src/edge/link-peer.ts:285-293` dan `docs/deployment.md` butir 5. Restore/clone menyimpan `instance_id` (yd0h8; legend-g1799 masih open), jadi tidak pernah masuk cabang "instance lain + cursor > 0". Skenario: cloud menerima edge_to_cloud sampai R=10. DB edge di-restore ke head 6, lalu membuat event 7..12. Sisi edge menolak 1008 selama head < 10. Sesudah itu edge memanggil `ackOutbound(10)` dan mengirim mulai 11. Event 7..10 di-ack tanpa pernah dikirim. Hal yang sama terjadi pada rebuild bersamaan upgrade pertama (adopsi tanpa rebase). Masalah ini sudah ada sebelum cabang ini, tetapi runbook baru menyatakan cloud menolak DB restore/clone dengan 1008 dan tidak meng-ack apa pun; itu salah untuk instance yang sama. Saran: untuk stored = instance atau null, tolak tanpa menulis bila `peerCursor < acked_out_seq - offset` (cloud_to_edge). Di sisi edge, jangan pernah meng-ack cursor peer yang pernah di depan head. Perbaiki teks runbook. Tambah test restore dengan instance sama.
- P3 `db-link-store.ts` `bindPeer`: pemegang kredensial node dapat mengirim instance acak dengan cursor 0. Rebase itu permanen, dan DB sah (cursor > 0) ditolak selamanya sampai daftar ulang. Butuh kredensial, jadi risiko rendah. Saran: catat alarm/audit saat rebase dan tampilkan di status node.
- P3 `link-peer.ts` (`onPeerHello`): cloud menunggu hello edge tanpa batas waktu sendiri. Ini aman bila heartbeat/idle timeout server menutup socket. Pastikan ada test yang menahan hello edge dan memeriksa bahwa socket ditutup.
