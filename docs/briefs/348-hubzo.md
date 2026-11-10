# legend-hubzo (C7): worker upload selfie edge + retensi lokal edge

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (data pribadi): satu subagent architect review.
Basis: `git worktree add .worktrees/hubzo -b ws/hubzo-selfie-worker ws/we0yc-selfie-seal` (7b9a526f). Jangan checkout folder utama. Jangan push.

## Kerja
Ikuti `bd show legend-hubzo` dan desain `docs/design/hris-edge-replication.md` §5 (tabel jawaban cloud, retensi lokal) dan T7 di §9.
- Worker edge: interval 30 s, backoff dengan jitter, kirim file segel `edge_selfie_uploads` ke cloud, commit status uploaded lalu hapus file.
- Retensi: pending 30 hari jadi expired, rejected 7 hari jadi expired dan filenya dihapus, file `.lss`/`.tmp` tanpa baris DB lebih tua 24 jam dihapus, log edge acked lebih dari 35 hari (bersama legend-gzwhg; cek kartunya, jangan dobel).
- Alarm kesehatan saat upload lokal menjawab 507 (disk penuh) — temuan architect C5.
- Rute cloud penerima dikerjakan C6 (legend-0wvoz, thread lain, belum digabung). Pakai kontrak di desain §5 dan `packages/shared`; jangan sentuh file C6. Test pakai server tiruan.
1. Test gagal-dulu tiap butir (T7).
2. Tidak ada log isi selfie atau meta.
3. Typecheck dan test target lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Architect review, temuan nyata dibetulkan.
4. Commit lokal, `bd comment legend-hubzo`, update `docs/PROGRESS.md`.

Migrasi bila perlu: nomor sementara 0233, `when` 1794320000000, FK inline, migrator non-superuser. Edit pakai tool Edit, bukan sed. Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan architect.
