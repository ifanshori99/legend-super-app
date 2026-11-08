# Brief: engineer kecil — tes flaky dan tes bergantung tanggal

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md`, lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/flaky-tests`, cabang `fix/flaky-tests` (dari `main`). Jangan pindah cabang.

## Tujuan
Gate tim sering merah tanpa alasan. Betulkan akar masalahnya (bukan melemahkan assertion):
1. `legend-utcs`: `GET /api/platform/tenants` → 422 sesekali di `apps/api/src/test/identity-surface-api*` dan `platform-org-api.test.ts:148`. Lulus saat dijalankan sendiri: kemungkinan state bersama atau urutan.
2. `legend-63nv`: mock e2e gagal di `main` karena bergantung tanggal hari ini: `e2e/legend-oye8.mock.spec.ts:28` (mengharap "Minggu, 8 November 2026") dan `e2e/legend-uq2.mock.spec.ts:60` ("12 mnt"). Pin jam (Playwright `page.clock`) atau fixture tanggal.

## Kartu
`legend-utcs`, `legend-63nv` (jalankan tiap perintah untuk keduanya). Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`.

## Scope
Hanya file test/fixture terkait dan helper test. Jangan ubah kode produk kecuali akar masalah memang di sana (sebut di laporan).

## Bukti selesai
- Test vitest terkait lulus 5x berturut-turut dalam suite penuh (`heavy pnpm check` minimal sekali penuh).
- Kedua spec e2e lulus (`LEGEND_MOCK_PORT=3229 heavy pnpm ...`, cek script `test:e2e:mock`).
- `pnpm format:check` lulus, `git status` bersih. Commit lokal merujuk kedua bead. Jangan push/merge.

## Laporan
Akar masalah tiap bead, fix, bukti.
