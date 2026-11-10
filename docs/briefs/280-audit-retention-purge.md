# Brief: engineer (Sonnet) — jadwal purge retensi audit dengan identitas maintenance

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/audit-retention-purge` dari `milestone/m1` (3517283b), worktree `.worktrees/audit-retention-purge`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Migrasi hanya bila perlu (peran/grant DB): nomor dipesan `0187`, `when` 1794266000000.

## Tujuan
`legend-usyi` (P2, tingkat K: audit + akses data). Keputusan CTO 9 Nov (komentar kartu): akun sistem maintenance khusus untuk purge audit, dan purge itu sendiri meninggalkan jejak audit.
1. `Explore` dulu: hook purge retensi yang sudah ada (dari legend-4sc), kelas retensi di `audit_logs`, pola job worker yang sudah jalan (`edge-wifi-retention` sebagai contoh), cara RLS/FORCE RLS dan peran DB dipakai worker, dan aturan retensi PRD v1.7 bagian 3.
2. Jadwalkan purge di worker produksi memakai identitas maintenance khusus (bukan superuser, bukan identitas user). Hapus hanya baris yang lewat masa retensi kelasnya, per tenant, dalam batch terbatas; idempoten dan aman bila dua worker jalan bersamaan (lease/advisory lock seperti job lain).
3. Tiap run menulis satu baris audit ringkas per tenant (jumlah baris, kelas, rentang tanggal), tanpa isi baris yang dihapus.
4. Keputusan desain (peran DB, grant, cara melewati FORCE RLS dengan aman) lewat satu subagent `architect`, dicatat di `docs/DECISIONS.md`.

## Kartu
Awal: `ghostex board associate legend-usyi`, `bd update legend-usyi --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: worker/job, service audit retensi, migrasi peran/grant 0187 bila perlu, test, `docs/DECISIONS.md`. Jangan: mengubah kelas retensi atau masa simpan yang ada, writer audit, tenant selection.

## Bukti selesai
- Test gagal-dulu: baris lewat retensi terhapus, yang belum tidak; kelas retensi berbeda dihormati; tenant A tidak menghapus tenant B; identitas maintenance tidak bisa menulis/membaca tabel lain di luar grant; dua run bersamaan tidak menghapus ganda atau macet; baris audit ringkas tertulis.
- Bila ada migrasi: `pnpm db:generate` lalu periksa SQL, generate kedua kosong, test migrasi RLS.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck api lewat `heavy` sekali; eslint + prettier. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K): satu `architect`.
- Tulis brief Codex `docs/briefs/280b-second-opinion-audit-purge.md`, jangan dijalankan.

## Laporan
Sekali di akhir: keputusan desain, SHA, migrasi (`when`, prevId), variabel env baru untuk deploy, bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
