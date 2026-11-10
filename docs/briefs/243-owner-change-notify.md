# Brief: engineer (Sonnet) — kabari Owner lama dan semua Owner saat platform tunjuk/ganti Owner (legend-fmpgz)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/owner-change-notify` dari `ws/grant-role-lock-b33` 783e3bbf (rantai ktc4d + qr1uv + 8ajy4 + deny audit). Worktree `.worktrees/owner-change-notify`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-fmpgz` (P1, tingkat K: auth). Keputusan founder Q46: saat Super Admin menunjuk atau mengganti Owner lewat jalur platform (`platform-tenant-owner.service.ts`), kirim email dan notifikasi in-app segera ke Owner yang diganti dan semua Owner aktif tenant: siapa pelaku platform, kapan, akun Owner baru, alasan. Kegagalan kirim tidak membatalkan transaksi, tetapi tercatat. Pakai pola outbox/notifikasi yang sudah ada di proyek (cari dulu dengan `Explore`; jangan buat mekanisme baru bila ada).

## Kartu
Di awal: `bd update legend-fmpgz --status in_progress`. Saat melapor: `--status review` + `bd comment`.

## Scope
Boleh: `platform-tenant-owner.service.ts`, service notifikasi/email/outbox yang sudah ada, template pesan, test. Jangan: `access.service.ts` grant lock, middleware platform/support, Better Auth, migrasi (butuh tabel baru: berhenti dan lapor dulu), UI.

## Bukti selesai
- Test: tunjuk Owner pertama, ganti Owner: penerima benar (Owner lama + semua Owner aktif, tanpa duplikat, tidak ke Owner yang sudah berakhir), isi pesan lengkap, gagal kirim tidak membatalkan penunjukan dan tercatat, tidak ada kebocoran ke tenant lain.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file; sertakan test platform owner yang sudah ada.
- tsc lewat `heavy` sekali per perbaikan, eslint, prettier. Jangan `pnpm check` penuh.
- Review kuat (aturan baru Q48): satu subagent `architect` saja. Temuan nyata dibetulkan.
- Brief Codex `docs/briefs/243b-second-opinion-owner-change-notify.md` (tidak di-commit).

## Laporan
Sekali: penerima dan isi pesan, mekanisme kirim yang dipakai, bukti, file berubah, SHA, risiko, jumlah subagent. Butuh desain baru: berhenti dan lapor.
