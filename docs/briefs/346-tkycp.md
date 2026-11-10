# legend-tkycp (C3): penarik + penerapan people snapshot di edge

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (data pribadi, identitas staf edge): satu subagent architect review.
Basis: `git worktree add .worktrees/tkycp -b ws/tkycp-people-pull ws/ye4j1-people-snapshot` (35bf1300; berisi endpoint cloud C2). Jangan checkout folder utama. Jangan push.

## Kerja
Ikuti `bd show legend-tkycp` dan desain `docs/design/hris-edge-replication.md` §3.1, §3.3: scheduler 60 detik, `If-None-Match`, apply dalam satu transaksi (advisory lock `hashtextextended`), aturan detach/banned/cancel (dua tahap supaya kunci unik tidak bentrok), `last_checked_at`, people snapshot ditarik sebelum staff PIN pull, `applyStaffPinRecords` melewati user yang belum ada.
1. Harness test DB kedua untuk edge (DB edge terpisah dari cloud). Test gagal-dulu: `staff_pins` FK user gagal di DB edge terpisah sebelum fix (celah 1), lalu lulus.
2. Test: 304 tidak mengubah apa pun; karyawan keluar cakupan di-detach; snapshot gagal validasi tidak diterapkan sebagian.
3. Typecheck dan test lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Architect review, temuan nyata dibetulkan.
4. Commit lokal, `bd comment legend-tkycp`, update `docs/PROGRESS.md`.

Migrasi bila perlu: nomor sementara 0232, `when` 1794311000000, FK inline, migrator non-superuser. Edit pakai tool Edit, bukan sed. Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan architect.
