# 808 Test kriteria rilis pembayaran dan EDC (Codex, test-writer)

## Peran
test-writer (baca ~/.agents/team/roles/test-writer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset).

## Tujuan
Kriteria PAY-03, EDC-01, EDC-02, EDC-03, EDC-04, EDC-05 punya test otomatis. Area uang: test wajib menunjukkan tidak ada pelunasan ganda, tagihan tidak berubah, dan transaksi gagal tidak tercatat lunas (aturan founder: jangan sampai rugi). EDC-05 (internet putus) cukup di level edge store + sync test yang sudah ada polanya; jangan ubah kode edge.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/milestone/m1`. Cabang akhir `ws/criteria-pay-edc` (rename dari ghostex/..., push ke origin tanpa --force).

## Kartu
`legend-ei6eh` (bagian dari legend-ihf7: CI `pnpm traceability --strict`). CTO yang memindah status bd; kamu tidak menjalankan `bd`.

## Cara kerja
- Kriteria ada di `docs/PRD.md` (baris di `docs/plan/criteria-matrix.md` bagian "Missing criteria"). Skrip pengukur: `node scripts/ci/traceability.mjs` (baca dulu cara ia mengenali ID kriteria di nama/komentar test).
- Per kriteria: cari test yang SUDAH membuktikan perilakunya; bila benar membuktikan, tambahkan ID kriteria ke nama `it(...)`/`describe(...)` sesuai format skrip. Bila belum ada, tulis test baru yang menguji perilaku nyata (API vitest di `apps/api/src/test/`, lewat Express + DB seperti test lain).
- Jangan melabeli test yang tidak benar-benar membuktikan kriteria. Jangan ubah kode produk. Test baru yang merah karena perilaku belum ada atau bug: tandai `it.fails(...)` dengan komentar alasan (supaya suite tetap hijau dan bug terlihat), lalu tulis temuannya (berkas:baris, skenario) di laporan supaya CTO membuat kartu perbaikan.
- Paralel: subagent bawaan Codex (maks 6), satu per kriteria atau kelompok file, file tidak bertumpuk.
- Test terarah: `LEGEND_TEST_FILES="src/test/a.test.ts ..." heavy pnpm test` dari root worktree. Jangan suite penuh.
- Jangan sentuh: kode produk, migrasi, edge, alarm panik, pemindai, DOIT/payout. Jangan merge ke m1.

## Bukti selesai
- Test terarah file yang diubah/baru hijau (sebut jumlah).
- `node scripts/ci/traceability.mjs`: kriteria targetmu tidak lagi di "Missing" (tempel baris ringkasannya).
- Pra-gate AGENTS.md: prettier --check, eslint pada file berubah; `heavy pnpm --filter @starter/api typecheck` sekali.

## Laporan
Per kriteria: test mana (berkas:baris), baru atau dilabeli, dan kenapa membuktikan. Temuan bug/perilaku belum ada. SHA, cabang akhir. Baris wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
