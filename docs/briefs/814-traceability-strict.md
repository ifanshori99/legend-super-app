# 814 Traceability strict siap dinyalakan (Codex, engineer kartu S, test saja)

## Peran
test-writer (baca ~/.agents/team/roles/test-writer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/milestone/m1`. Cabang akhir `ws/traceability-strict` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-4tle1` (bagian legend-ihf7). CTO memindah status; kamu tidak menjalankan `bd`.

## Tujuan
`node scripts/ci/traceability.mjs --strict` hanya gagal karena EDG-04 (uji failover fisik, tidak bisa otomatis). Betulkan sembilan referensi ID kriteria yang tidak dikenal (kata thread sebelumnya: di test loyalty dan payroll): cari ID yang benar di `docs/PRD.md` (bagian kriteria) dan ganti label test; bila tidak ada padanan, buang label palsunya (jangan mengarang ID). Tambahkan mekanisme pengecualian eksplisit untuk EDG-04 di skrip traceability (mis. daftar `manualCriteria` dengan alasan "uji fisik di outlet, gerbang rilis"), lalu ubah `.github/workflows/ci.yml` agar menjalankan `pnpm traceability --strict`. Perbarui `docs/plan/criteria-matrix.md` dengan keluaran skrip.

Catatan: cabang ws/criteria-pph21, ws/criteria-pay-edc, ws/criteria-ai-mcp belum di m1 tetapi menambah label PAYR-03, PAY-03, EDC-01..05, AIG-*, MCP-*. Gabungkan ketiganya ke worktree-mu lebih dulu (`git merge --no-edit origin/ws/criteria-pph21 origin/ws/criteria-pay-edc origin/ws/criteria-ai-mcp`; konflik test: hentikan dan lapor) supaya --strict diukur atas hasil akhir.

## Scope
- Boleh: label nama/komentar test, `scripts/ci/traceability.mjs` dan test-nya, `.github/workflows/ci.yml`, `docs/plan/criteria-matrix.md`.
- Jangan: kode produk, isi assertion test, migrasi.

## Bukti selesai
- `node scripts/ci/traceability.mjs --strict` exit 0 (tempel ringkasannya), `node --test` untuk test skrip traceability bila ada.
- Test yang labelnya diubah tetap hijau: `LEGEND_TEST_FILES="..." heavy pnpm test`.
- prettier --check, eslint pada file berubah.

## Laporan
Daftar ID lama -> baru (atau dibuang, dengan alasan), SHA, cabang akhir, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
