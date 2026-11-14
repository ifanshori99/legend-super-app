# 827 Dua kartu kecil Tanya AI: anomali eval dan tahun default bagi hasil (Codex, engineer kartu S)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/fix/ai-sources-tl07-08-12` (fb00a4c24). Cabang akhir `fix/ai-eval-anomaly-year` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-ttk8t`, `legend-ibtc8`. CTO memindah status; kamu tidak menjalankan `bd`.

## Tujuan
1. legend-ttk8t: di 817 dua pertanyaan anomali manager "refund" dan "cash_variance" diganti "discount" di dataset eval (`dataset.ts` sekitar :864-873) karena seed belum punya datanya. Tambah data seed eval untuk refund dan selisih kas (tenant uji, outlet A, `randomUUID`, lewat `asOwner`), lalu kembalikan kedua pertanyaan aslinya. Jangan melonggarkan checker.
2. legend-ibtc8: handler Tanya AI `get_my_profit_share` memakai `getUTCFullYear()` untuk tahun default; antara 00:00-07:00 WIB 1 Januari tahunnya salah. Pakai zona Asia/Jakarta (ikuti helper tanggal WIB yang sudah ada di repo). Test dengan jam palsu 1 Jan 03:00 WIB.
3. Tambahkan satu test kecil yang memastikan id kasus eval cocok dengan nama tool yang diharapkan (catatan reviewer 817), supaya penyisipan kasus tidak menggeser id diam-diam.

## Scope
- Boleh: `apps/api/src/test/ai-eval*`, dataset dan seed eval, handler tool `get_my_profit_share`, test.
- Jangan: migrasi, kode produk lain, payout/payroll tulis, MCP, edge.

## Paralel
Subagent bawaan Codex: satu per kartu (file tidak bertumpuk), test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="src/test/ai-eval.test.ts src/test/ai-tools-read-b.test.ts <test baru>" heavy pnpm test` hijau; gagal-dulu tercatat untuk ibtc8.
- Pra-gate AGENTS.md: prettier --check, eslint, `heavy pnpm --filter @starter/api typecheck` sekali.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, per kartu apa yang berubah, test, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
