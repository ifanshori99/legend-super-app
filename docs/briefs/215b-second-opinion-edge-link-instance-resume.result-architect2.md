# 215b result (architect 2, claude-double) — legend-nd3cu

Reviewed: `git diff e1100258..e7dad52d` (ws/edge-link-instance-resume, migration 0162; meta json ignored). Not in milestone/m1 yet (already in integ/m1-batch31; no later commit touches the reviewed files up to integ/m1-batch32). Read-only.

| id brief | kartu | hasil | kartu baru | catatan |
|---|---|---|---|---|
| 215b | legend-nd3cu | Bersih (tidak ada P1/P2) | - | 2 catatan P3 di bawah |

## Invariant yang dicek

- **Tidak ada ack tanpa apply, termasuk rebase dan link basi.** `bindPeer` (`apps/api/src/edge/db-link-store.ts:214-257`) mengunci kedua baris cursor (`lockSyncCursor`, urutan tetap, jadi tidak ada deadlock) dan menghitung offset dari nilai terkunci terbaru. `applyInbound`, `ackOutbound`, dan `readOutbound` membaca `peerNumbering` sesudah lock. Link I1 yang masih berjalan sesudah rebase ke I2 kena `LinkProtocolError` dan tidak memajukan cursor. Ack I1 untuk event yang juga akan dikirim ke I2 tidak tercatat, jadi aman. Reconnect di tengah rebase: satu transaksi. Galat sementara: close 1013, lalu edge mengulang.
- **Rebuild (instance baru, cursor 0).** Inbound offset = `received_in_seq`, outbound offset = `acked_out_seq`. Event baru edge→cloud diterapkan sekali. Event cloud→edge yang pending (A+1..H) dikirim, dan yang ≤ A tidak diputar ulang. Reconnect dengan instance yang sama tidak di-rebase lagi.
- **Edge lama / sisi edge.** Tanpa hook, offset 0. Baris yang terikat menolak link tanpa instance lewat `peerNumbering`, termasuk hello cloud di `start`. Tidak ada deadlock hello: sisi edge selalu mengirim hello saat `start` (`link-peer.ts:376-378`).
- **Forward-only.** Trigger `0162` sama persis dengan `edge-node.custom.sql` (sudah dicek dengan diff isi fungsi). CHECK terpenuhi oleh offset rebase. Offset hanya naik karena cursor juga hanya naik.
- **TEN-01/02.** Header `x-edge-instance` hanya memilih penomoran di dalam scope node yang sudah diautentikasi (RLS + `edge_node_id`). Node atau tenant lain tidak tersentuh.
- **Migrasi.** FORCE RLS diangkat lalu dipasang lagi dalam satu migrasi. Urutan journal konsisten (0157 lalu 0162; 0158/0161 tidak dipakai cabang mana pun).

## Catatan P3 (tidak dibuat kartu)

- **P3: sinyal "cursor 0 = DB kosong" lemah untuk outlet tanpa QR order.**
  - Lokasi: `db-link-store.ts:228-231`, serta `docs/deployment.md` butir 5 kasus ketiga.
  - Penyebab: stream cloud→edge hanya membawa QR order (`apps/api/src/edge/qr-order-forwarding.ts:189`). Di outlet tanpa QR, cursor inbound setiap edge selalu 0.
  - Skenario gagal: mesin lama I1 hidup lagi sesudah rebuild ke I2. Cloud me-rebase ke I1, bukan menolak dengan 1008, lalu kedua mesin saling me-rebase setiap kali reconnect. Tiap mesin juga mengirim ulang seluruh antreannya dari link_seq 1.
  - Dampak: tidak ada data hilang, karena dedupe event id mencegah apply ganda. Kalimat runbook "restored or cloned database still carries link cursors → 1008" tidak berlaku di kasus ini.
  - Saran: tolak rebase ke instance yang pernah terikat sebelumnya (simpan riwayat instance per node), atau kirim head outbound edge di hello. Minimal, betulkan teks runbook.
- **P3: rebuild bersamaan upgrade pertama mengikat baris permanen.** Lokasi: `db-link-store.ts:233-240`. Baris `stored null` di-adopt ke I2 dengan offset 0, lalu edge menolak hello cloud (R > head) di setiap reconnect sampai node didaftarkan ulang. Ini sudah tercatat sebagai batas di brief dan runbook. Status edge sebaiknya menampilkan alasan penolakan ini supaya operator tahu harus mendaftarkan ulang node.
