# Brief: second-opinion — cursor link per instance edge (legend-nd3cu, tier K)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-link-instance-resume`, cabang `ws/edge-link-instance-resume`.
Rentang diff: `git diff e1100258..ws/edge-link-instance-resume` (HEAD e7dad52d) (base = `ws/edge-pin-instance` e1100258, sudah diperiksa di 203b; abaikan `apps/api/drizzle/meta/*.json`). Jangan pakai `merge-base main`. Migrasi `0162_sync_cursor_peer_instance` (when 1794241000000).
Desain: `docs/briefs/sub-edge-link-instance-resume.md` bagian "Final design" di worktree itu.

## Berkas berisiko
- `apps/api/src/edge/db-link-store.ts` (`peerNumbering`, `bindPeer` lewat `onPeerHello`, terjemahan offset di `readOutbound`, `ackOutbound`, `applyInbound`)
- `apps/api/src/edge/link-peer.ts` (hook opsional `onPeerHello`: bila ada, hello sisi ini menunggu hello peer; settle sebelum cursor peer dipakai sebagai ack)
- `apps/api/drizzle/0162_sync_cursor_peer_instance.sql`, `apps/api/src/db/schema/edge-node.custom.sql` (`app.guard_sync_cursor_update`), `apps/api/src/db/schema/edge-node.ts` (check `sync_cursors_peer_offset_check`)
- `docs/deployment.md` butir 5 runbook

## Invariant
- Tidak ada event yang di-ack tanpa diterapkan, di kedua arah, termasuk saat rebase, link basi (koneksi instance lama yang masih berjalan), reconnect di tengah rebase, dan DB edge restore/clone yang cursor-nya tidak 0.
- DB edge dibangun ulang (node sama, instance baru, cursor 0): event baru edge→cloud sampai ke applier tepat sekali; event cloud→edge yang masih pending dikirim; yang sudah di-ack instance lama tidak diputar ulang; tidak ada 1008 berulang.
- Edge lama tanpa header instance: offset 0 dan perilaku persis seperti sebelumnya. Edge sendiri (baris tanpa instance) selalu offset 0, dijaga oleh check.
- Forward-only per instance: cursor tersimpan tidak pernah turun; offset hanya naik dan hanya saat instance berganti dari non-null ke non-null lain; instance tidak bisa kembali null.
- TEN-01/TEN-02: header instance tidak pernah menjadi dasar akses; tenant/node lain tidak tersentuh (cursor dibaca per node di bawah RLS).
- Migrasi lulus sebagai owner non-superuser (FORCE RLS diangkat lalu dipasang lagi, `docs/plan/contracts.md`); trigger sama persis dengan custom.sql.
- Instance lain dengan cursor di atas 0 (restore/clone) ditolak 1008 tanpa perubahan. Adopsi baris tanpa instance tidak terjadi untuk link yang cursornya di depan antrean (ditolak tanpa menulis). Baris yang terikat instance menolak link basi dan link tanpa instance (rilis edge lama).
- Batas yang diketahui: dua DB hidup dengan kredensial sama dan keduanya cursor 0 bisa saling me-rebase (melanggar runbook satu mesin per node; dedupe event id mencegah apply ganda). Rebuild bersamaan dengan upgrade pertama (instance tersimpan null) di-adopt tanpa rebase. Event agregat lama dari DB baru dengan sequence agregat lebih rendah menjadi konflik untuk ditinjau supervisor, bukan hilang diam-diam.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
