# Brief: engineer (Opus) — sesi impersonate mati saat grant berakhir + akses storage per membership (legend-w1due, legend-tiie)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/support-storage-access` dari `ws/access-perm-backfill` 0fecec89 (rantai akses terbaru: ktc4d, 8ajy4, deny audit, izin baru; belum di m1). Worktree `.worktrees/support-storage-access`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Satu commit per kartu (tingkat K auth). Baca `bd show` + komentar tiap kartu, cek ulang ke basis dulu.
1. `legend-w1due` (P2 bug): sesi impersonate Better Auth harus mati (atau ditolak di tiap request) begitu grant support berakhir/dicabut, termasuk dampak aturan independensi owner (c9kbk). Reproduksi dulu: grant berakhir → request berikut dari sesi impersonate masih lolos.
2. `legend-tiie` (P2): sambungkan rute storage ke resolusi membership tenant dan izin outlet (memblokir `legend-7nv1`).

## Kartu
Di awal tiap kartu: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: `middleware/support-session.ts`, service support access, rute/service storage, `lib/auth.ts` hanya bila wajib (sebut alasannya), test. Jangan: `platform-tenant-owner.service.ts`, notifikasi, grant lock `access.service.ts`, migrasi (butuh: berhenti dan lapor), UI.

## Bukti selesai
- Test gagal-dulu per kartu, lalu lulus. Test lama tetap lulus: support-session-readonly, platform-support-access, platform-access-denied, better-auth-admin-lockdown, storage terkait.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- Typecheck via `heavy` sekali per perbaikan, eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu subagent `architect` untuk diff gabungan. Maks 3 subagent bersamaan; test-writer hanya menjalankan file yang ia tulis.
- Brief Codex `docs/briefs/253b-second-opinion-support-storage.md` (tidak di-commit).

## Laporan
Sekali di akhir: per kartu (hasil, SHA), bukti, file berubah, risiko, jumlah subagent.
