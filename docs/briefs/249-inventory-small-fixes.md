# Brief: engineer (Sonnet) — empat perbaikan kecil inventori

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/inventory-small-fixes` dari `milestone/m1` terbaru (4c818489 atau lebih baru). Worktree `.worktrees/inventory-small-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Berurutan, satu commit per kartu. Sebelum tiap kartu: `bd show` + komentar, cek ulang ke basis (triase 9 Nov memakai grep ringan; sudah ada: komentari kartu dan lewati). Ringkasan: `docs/briefs/245-triage-result.md`.
1. `legend-0jfi` (K): API stock-count menyembunyikan `systemQty`/`varianceIdr` selama hitung buta.
2. `legend-r2zv` (K): notifikasi `stock.critical` tidak membawa quantity saat hitung buta berjalan.
3. `legend-1ozj` (K): kode izin master-data inventori + master data berlingkup outlet (kontrak shared).
4. `legend-tk7i` (K): sambungkan sumber resep ke produksi/waste (`setInventoryRecipeSource`). Butuh migrasi: berhenti untuk kartu ini dan lapor (CTO memberi nomor).

## Kartu
Di awal tiap kartu: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: service/route inventori dan stock-count, notifikasi stok, kontrak shared inventori dan `permissions.ts` (hanya kode izin inventori), test. Jangan: goods receipt (`legend-o1o4s`), migrasi, akses umum, payroll, payment, UI.

## Bukti selesai
- Per kartu: test gagal-dulu, lalu lulus. Test inventori lama tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file; contract root `node --test` bila menyentuh `packages/shared`.
- tsc lewat `heavy` sekali di akhir, eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu subagent `architect` untuk diff gabungan. Maks 2 subagent bersamaan.
- Brief Codex `docs/briefs/249b-second-opinion-inventory-small-fixes.md` (tidak di-commit).

## Laporan
Sekali di akhir: per kartu (hasil, SHA atau "sudah ada"), bukti, file berubah, risiko, jumlah subagent.
