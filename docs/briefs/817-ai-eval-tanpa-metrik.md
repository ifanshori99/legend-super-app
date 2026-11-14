# 817 Evaluasi numerik AI tidak boleh lolos diam-diam (Codex, test-writer)

## Peran
test-writer (baca ~/.agents/team/roles/test-writer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/traceability-strict` (berisi label AIG-04). Cabang akhir `ws/ai-eval-missing-metric` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-56tcm`. CTO memindah status; kamu tidak menjalankan `bd`.

## Tujuan
`apps/api/src/test/ai-eval.test.ts:533`: evaluasi numerik deterministik melewati perbandingan ketika metrik sumber tidak tersedia, sehingga skor >= 90% bisa tercapai tanpa membandingkan apa pun. Ubah supaya pertanyaan numerik tanpa metrik sumber dihitung GAGAL (atau dikeluarkan dari penyebut dengan jumlahnya dilaporkan dan dibatasi, mis. maks 5%), dan tambahkan test yang membuktikan skor turun saat metrik hilang. Bila perbaikan butuh kode produk di harness eval (`apps/api/src/**/eval*`), boleh, terbatas di harness itu.

## Scope
- Boleh: `ai-eval.test.ts`, harness eval AI dan fixturenya.
- Jangan: gateway AI produksi, masker PII (thread lain sedang di sana), MCP, migrasi.

## Bukti selesai
- `LEGEND_TEST_FILES="src/test/ai-eval.test.ts src/test/ai-eval-dataset.test.ts" heavy pnpm test` hijau; test baru merah di basis.
- prettier --check, eslint, `heavy pnpm --filter @starter/api typecheck` sekali.

## Laporan
SHA, cabang akhir, aturan baru, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor hanya saat selesai atau butuh keputusan.
