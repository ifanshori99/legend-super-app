# Brief: engineer — perbaikan temuan Codex 405 profit share (legend-9t04v)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Dua temuan, berkas berbeda: Explore + test-writer + 2 implementer dalam satu giliran.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/ps-405`, cabang `ws/ps-405`, dari `ws/inbox-self-approve` (22198b5c, berisi m1 46352cd5 + owner tunggal). Lalu `pnpm worktree:setup`.

## Temuan dan keputusan CTO
1. P1 `apps/api/drizzle/0239_profit_share_recipient_versions.sql:58`: backfill menetapkan login saat migrasi sebagai penerima semua laporan lama; bila login berganti A ke B sebelum migrasi, B dapat akses permanen ke laporan lama A. Keputusan: pakai riwayat penerima tepercaya bila ada (snapshot penerima pada laporan/pembayaran); bila tidak ada, penerima dibiarkan tidak diketahui (NULL) dan laporan masuk daftar rekonsiliasi yang hanya bisa diselesaikan Owner. Tidak ada akses otomatis ke login saat ini. m1 belum pernah diterapkan ke DB bersama, jadi 0239 boleh diubah di tempat; catat di `docs/release-notes-m1-migrations.md` bahwa DB dev/test yang sudah menerapkan 0239 harus di-reset.
2. P2 `apps/api/src/services/core-audit-writer.ts:175`: audit `approval.decided` menyamarkan status dan level. Tambah `status`, `level`, `actionType` ke daftar field aman (bukan data pribadi).

## Kartu
`legend-9t04v`. Awal: `ghostex board associate legend-9t04v`, `bd update legend-9t04v --status in_progress`. Lapor: `--status review` + `bd comment`.

## Bukti selesai
Test gagal-dulu: login ganti sebelum migrasi -> B tidak dapat akses laporan lama, laporan masuk rekonsiliasi; snapshot tepercaya dipakai bila ada; audit memuat status/level/actionType tanpa data pribadi. Unit/integration, bukan e2e. Typecheck via `heavy`, prettier, `pnpm db:generate` kosong. Review tingkat K (migrasi + akses): satu `architect` effort xhigh.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis. Saat menunggu heavy, jalankan review/test paralel. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit, push. Hasil, bukti, file, subagent dan puncak, risiko.
