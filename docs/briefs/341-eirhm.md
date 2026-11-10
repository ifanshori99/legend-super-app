# legend-eirhm: cetak ulang menu tidak menghapus PDF lama

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat S: satu reviewer sonnet.
Basis: `git worktree add .worktrees/eirhm -b ws/eirhm-menu-print-cleanup ws/0w2wy-docs-storage` (80f5c4d1). Jangan checkout folder utama. Jangan push.

## Kerja (test gagal-dulu)
1. Render ulang cetak menu yang sukses menghapus atau mengganti objek PDF lama di storage. Hapus baru dilakukan setelah render baru tersimpan dan tercatat (render gagal = PDF lama tetap).
2. Hapus gagal tidak menggagalkan render; tercatat di log/audit yang ada supaya bisa dibersihkan.
3. Typecheck dan test terkait lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Reviewer sonnet, temuan nyata dibetulkan.
4. Commit lokal, `bd comment legend-eirhm`, update `docs/PROGRESS.md`.

Tanpa migrasi kecuali perlu. Edit berkas pakai tool Edit, bukan sed. Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan reviewer.
