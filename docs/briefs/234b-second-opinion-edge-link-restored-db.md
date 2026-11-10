# Brief: second-opinion — tolak DB edge hasil restore/clone yang mundur waktu (legend-a9iby, tier K)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-link-restored-db`, cabang `ws/edge-link-restored-db`.
Rentang diff: `git diff d7a95d0c..ws/edge-link-restored-db` (base `integ/m1-batch31` d7a95d0c, sudah memuat legend-nd3cu e7dad52d). Tanpa migrasi.
Temuan asal: `docs/briefs/215b-second-opinion-edge-link-instance-resume.result-architect.md` (P2 legend-a9iby) dan `.result-architect2.md` (P3 outlet tanpa QR) di folder utama repo.

## Berkas berisiko
- `apps/api/src/edge/db-link-store.ts` (`bindPeer`: cek baru `peerCursor < acked_out_seq - peer_seq_offset` untuk arah outbound cloud_to_edge, instance tersimpan sama atau null, tolak `LinkProtocolError` sebelum menulis)
- `apps/api/src/edge/link-peer.ts` (`onHello`: ack dari cursor hello, cabang "cursor below our ack → resend" yang kini hanya tersisa untuk edge tanpa header instance)
- `apps/api/src/test/edge-link-instance-resume.test.ts` (describe `legend-a9iby`, 3 test J)
- `docs/deployment.md` butir 5

## Invariant
- Tidak ada event yang di-ack tanpa dikirim dan diterapkan, di kedua arah. DB edge hasil restore/clone (instance sama) yang terdeteksi ditolak 1008 tanpa menulis apa pun di cloud dan tanpa ack di edge.
- Tidak ada false positive: DB edge hidup yang tidak mundur waktu tidak pernah punya received cloud_to_edge di bawah acked_out_seq cloud dikurangi offset (ack edge dikirim hanya sesudah commit `applyInbound`; cloud `onHello` hanya menaikkan ack ke cursor hello). Periksa juga rebase (offset), baris tanpa instance (adopsi), edge lama tanpa header (tidak lewat `bindPeer`), pruning antrean, reconnect ganda.
- Rebuild (instance baru, cursor 0) tetap di-rebase; instance lain dengan cursor > 0 tetap ditolak; perilaku legend-nd3cu lain tidak berubah.
- Batas yang diketahui dan ditulis di runbook: deteksi hanya bila edge sudah meng-ack event cloud_to_edge (QR order) yang lebih baru dari backup. Outlet tanpa QR tidak terdeteksi, event baru hasil restore bisa di-ack tanpa dikirim. Nilai apakah batas ini dan teks runbook jujur, dan usulkan perbaikan lanjutan terkecil (misal hello cloud membawa event id di cursor inbound-nya).

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
