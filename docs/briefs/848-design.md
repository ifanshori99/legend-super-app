# 848 desain tmar2 (restore proof) — konteks bersama implementer/test-writer
Kartu: legend-tmar2 (utama), legend-g1799 (hanya bila kecil; kalau tidak, lapor usulan). Scope file: apps/api/src/edge/{protocol,link-peer,link-server,link-client,db-link-store}.ts, runtime.ts hanya bila wajib (opsi client), test baru di apps/api/src/test/edge-link-restore-*.test.ts, docs/deployment.md. DILARANG: master-sync.ts, edge/edc, cash-out, test/baseline e2e.

## Fakta kode
- hello = strictObject {type,version,inboundCursor} (protocol.ts:57). onHello di link-peer.ts:331: cursor<=head, lalu `ackOutbound(cursor)` bila cursor>acked (link-peer.ts:353-357). Celah: antrean edge direstore sampai head >= cursor tapi isi slot (acked, cursor] beda -> di-ack tanpa kirim (alarm panik hilang).
- Edge: edge_outbound_queue(link_seq, event_id uuid, status). ackOutbound hanya ubah status='acked' (baris tetap ada), jadi event_id rentang (A,N] bisa dibaca ulang dari antrean (readOutbound(afterSeq), db-link-store.ts:364). Ada peerNumbering offset (db-link-store.ts:258) — hitung dengan penomoran edge.
- Cloud: receipt edge_inbound_events(tenant_id, edge_node_id, direction, event_id uuid, link_seq) append-only, tidak di-prune; link_seq di sana = seq edge + peer_seq_offset (sync_cursors). Tidak ada index link_seq.
- Header upgrade edge: link-client.ts:128-134 (LINK_INSTANCE_HEADER); cloud baca link-server.ts:364-369 -> options db-link-store.ts:178. Connect sinkron: nilai A (= store.lastAckedOutbound()) harus dibaca sebelum connect / lewat opsi.

## Rancangan (keputusan CTO: proof seluruh rentang)
1. protocol.ts: konstanta `LINK_RESTORE_PROOF_HEADER = "x-edge-restore-proof"` (nilai: A, desimal = acked_out_seq edge, validasi linkCursorSchema). hello tambah field opsional `inboundProof: strictObject{count: int>=0, sha256: hex64}`.
2. Digest: SHA-256 atas string `eventIdUuidLowercase + "\n"` tiap event, urut link_seq naik, rentang (A, N] (penomoran edge). count = jumlah baris.
3. Edge (link-client): kirim header hanya bila store tersedia; A dibaca sebelum connect tiap kali (reconnect membaca ulang).
4. Cloud (link-server/db-link-store): bila header valid DAN N > A, hello cloud memuat inboundProof dihitung dari edge_inbound_events (link_seq di (A+offset, N+offset], urut). Header hilang/rusak: perilaku lama persis (edge lama tetap jalan). N <= A: tidak ada proof (tidak ada ack).
5. Edge (link-peer onHello): bila hello membawa inboundProof dan cursor > acked: hitung ulang dari antrean (acked, cursor]; count atau sha256 beda ATAU baris kurang -> throw LinkProtocolError("Restore proof mismatch ...") SEBELUM ackOutbound; tidak ada ack, tidak ada onAcked. Hello tanpa proof: perilaku lama (cloud lama).
6. LinkStore tambah method opsional `outboundProof?(fromSeq, toSeq)` (edge) dan `inboundProof?(fromSeq, toSeq)` (cloud) sehingga link-peer tetap generik.
7. Cloud boleh menambah index (tenant_id, edge_node_id, direction, link_seq) bila perlu performa -> migrasi 0389 (cek FK/registry aturan AGENTS.md). Bila ditambah: data-import-registry test.

## Test wajib (vitest apps/api/src/test/)
a. Restore instance sama tanpa trafik cloud_to_edge: edge DB punya event berbeda di slot (acked,N] -> LinkProtocolError, lastAckedOutbound tak berubah, event tidak berstatus acked.
b. Alarm panik belum terkirim di slot (acked,N] tidak pernah di-ack (assert status tetap pending, dan dikirim/diretensi sesuai jalur).
c. Edge lama (tanpa header): cloud hello tanpa inboundProof, tersambung & ack normal. Cloud lama (hello tanpa proof): edge tetap jalan.
d. Rentang cocok: ack normal, digest cocok.
e. Digest mencakup seluruh rentang: event tengah (bukan terakhir) beda -> ditolak (bukti merah prototipe: proof hanya ID terakhir lolos).
f. Hello strict: field tak dikenal tetap ditolak.
