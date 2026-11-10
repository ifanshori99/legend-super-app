# 388 Pilot review buta: perbaikan Codex profit share

Peran: architect, review saja (baca ~/.agents/team/roles/architect.md bagian review). Tingkat K (uang, akses, migrasi).

## Tugas
Review perubahan satu commit untuk bug correctness, keamanan data poin, dan edge case.

- Repo: `/Users/ifanshori99/Projects/legend super app/legend`
- Buat worktree terpisah, detached: `git worktree add --detach .worktrees/pilot-388-$RANDOM 6ddd5d74` (tanpa `pnpm worktree:setup` kecuali kamu butuh menjalankan test).
- Diff yang direview: `git diff 6ddd5d74^2 6ddd5d74` (perubahan cabang terhadap milestone/m1, 18 berkas).
- Konteks fitur: profit share. Distribusi dividen harus lewat matriks approval; koreksi minus mengembalikan pajak (clawback); login penerima pemegang saham bisa diganti dan statement/email harus ke penerima yang benar; migrasi 0217 harus aman untuk data dokumen lama.

## Aturan pilot (wajib)
- Buta: jangan baca commit lain di cabang `ws/8s992-profit-rules` sesudah 6ddd5d74, jangan baca komentar bd `legend-33im6`, brief 377/378/379, `docs/PROGRESS.md`, atau laporan thread lain soal kartu ini.
- Kerjakan sendiri tanpa subagent supaya biaya bisa dibandingkan.
- Hanya baca. Boleh menjalankan test terarah atau script coba di scratchpad untuk membuktikan temuan. Jangan edit kode, jangan commit, jangan ubah bd.
- Catat jam mulai dan jam selesai (`date +%H:%M`).
- Selesai: hapus worktree pilot (`git worktree remove --force <path>`).

## Laporan
1. Jam mulai, jam selesai.
2. Daftar temuan, urut paling berat: severity (HIGH/MEDIUM/LOW), `file:line`, skenario konkret (urutan ledger -> hasil salah vs hasil benar), seberapa yakin (terbukti test/script atau dari baca kode).
3. Hal yang kamu periksa dan nyatakan aman.
