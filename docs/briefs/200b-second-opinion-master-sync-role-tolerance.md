# Brief: second-opinion — toleransi role mapping master sync (legend-dhbt1)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/master-sync-role-tolerance`, cabang `ws/master-sync-role-tolerance`.
Rentang diff: `git diff 12c91f6b..ws/master-sync-role-tolerance` (base `milestone/m1` 12c91f6b; abaikan `docs/`). Jangan pakai `merge-base main`.

## Berkas berisiko
- `packages/shared/src/edge/master-sync.ts` (role wire `z.string().min(1).max(40)`, cek role duplikat di superRefine, helper `partitionEdgeMasterMappings`)
- `apps/api/src/edge/master-sync.ts` (`applyEdgeMasterSnapshotInTransaction`: buang role tak dikenal sebelum upsert, `keptRoles` untuk hapus mapping lokal, log warn, counter `droppedMappings`)
- `apps/api/src/services/edge-master-sync.service.ts` (builder cloud, tidak diubah: pastikan tetap benar dengan schema baru)

## Invariant (PRD §3 F5 "Server Lokal")
- Cloud yang lebih baru boleh mengirim role posting yang belum dikenal edge: snapshot tetap diterapkan (uom, lokasi, akun, mapping role dikenal), role asing dibuang, dicatat (log berisi nama role dan jumlah saja) dan dihitung.
- Role dikenal tetap ter-upsert; set mapping cloud (role dikenal) tetap menggantikan set lokal; role dikenal yang ada di snapshot tidak pernah terhapus.
- Tanda tangan HMAC tetap dicek atas snapshot persis seperti diterima, sebelum filter apa pun.
- Role kosong, lebih dari 40 karakter, atau duplikat tetap `BAD_SNAPSHOT`, tidak ada yang ditulis.
- Tanpa migrasi; kolom `account_mappings.role` varchar(40).

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
