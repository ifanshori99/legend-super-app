# Brief: engineer (Sonnet) — lima perbaikan kecil akses dan identitas

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/access-small-fixes` dari `ws/grant-role-lock-b33` 783e3bbf (rantai akses terbaru, belum di m1). Worktree `.worktrees/access-small-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Kerjakan berurutan, satu commit per kartu. Sebelum tiap kartu: `bd show` + komentar, lalu cek ulang ke basis (triase 9 Nov memakai grep ringan; bila sudah ada, komentari kartu dan lewati). Ringkasan triase: `docs/briefs/245-triage-result.md`.
1. `legend-tegsk` (K): `updateCustomRole` membaca `now` sebelum kunci baris role; ikuti pola 8ajy4 (kunci dulu, `now` sesudahnya).
2. `legend-o0pp` (K): `returnPathSchema` (`packages/shared/src/identity/schemas.ts` ~136) menerima backslash sesudah slash pertama (open redirect).
3. `legend-e3k9` (K): izin `self.loan.request` untuk kasbon self-service.
4. `legend-poxk` (K): izin `hr.announcement.manage`.
5. `legend-iiqx` (S): verifikasi kepemilikan `logoMediaId` di draft tema (tenant yang sama).

## Kartu
Di awal tiap kartu: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: berkas yang disebut kartu (`access.service.ts` hanya untuk `updateCustomRole`, `permissions.ts`, `identity/schemas.ts`, `platform-theme.service.ts`) dan test. Jangan: middleware platform/support, Better Auth, `platform-tenant-owner.service.ts`, notifikasi, migrasi, payroll service (thread lain), UI.

## Bukti selesai
- Per kartu: test gagal-dulu, lalu lulus. Test akses lama tetap lulus (access-hardening, access-owner-grant, platform-access-api).
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file; contract root `node --test` bila menyentuh `packages/shared`.
- tsc lewat `heavy` sekali di akhir, eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu subagent `architect` untuk diff gabungan. Maks 2 subagent bersamaan.
- Brief Codex `docs/briefs/248b-second-opinion-access-small-fixes.md` (tidak di-commit).

## Laporan
Sekali di akhir: per kartu (hasil, SHA atau "sudah ada"), bukti, file berubah, risiko, jumlah subagent.
