# 828 Batas scan per tenant untuk jalur gambar lain (Codex, engineer kartu S)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/fix/clamd-scan-limit` (5e19187b1). Cabang akhir `fix/clamd-scan-tenant-images` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-p8k3b`. CTO memindah status; kamu tidak menjalankan `bd`.

## Tujuan
Di 823, batas scan per tenant (`CLAMD_MAX_PER_TENANT`, lewat `withScanTenant`) hanya terpasang di upload core-storage, bukti payout, dokumen pemegang saham, dan selfie. Jalur `processImage*` lain (selfie edge, logo, dan pemanggil lain yang ditemukan) hanya kena batas global. Teruskan `tenantKey` ke semua pemanggil scan yang tersisa supaya satu tenant tidak bisa menghabiskan kuota global. Perilaku overload tetap 503 `SCANNER_OVERLOADED`, tidak fail-open.

## Scope
- Boleh: pemanggil `processImage*` dan scanner, test pemindai.
- Jangan: migrasi, kebijakan NoopMalwareScanner selfie edge (kartu lain legend-xn214), payout/batch, edge sync.

## Paralel
Subagent bawaan Codex: (a) daftar semua pemanggil scan tanpa tenantKey, (b) implementer, (c) test-runner.

## Bukti selesai
- Test gagal-dulu: dua tenant, tenant A memenuhi batas per tenant lewat jalur logo, tenant B tetap bisa scan.
- `LEGEND_TEST_FILES="<file test pemindai yang tersentuh>" heavy pnpm test` hijau.
- Pra-gate AGENTS.md: prettier --check, eslint, `heavy pnpm --filter @starter/api typecheck` sekali.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, daftar jalur yang ditambah, test, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
