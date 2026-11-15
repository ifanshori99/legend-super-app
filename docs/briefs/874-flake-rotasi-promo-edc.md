# Brief: engineer (Codex) — 4 test yang kadang gagal di run penuh

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit). Kamu Codex: jangan jalankan `bd`; CTO yang memindah kartu.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri dari `origin/milestone/m1` (479a99525). Cabang baru: `fix/flake-874`.

## Tujuan
Empat file test lulus sendiri tetapi gagal di run penuh (`heavy pnpm test`, 19k test, beban tinggi). Cari akar masalahnya (isolasi data antar file, sweep lintas tenant, seed yang dihapus file lain, timing), lalu perbaiki di test atau fixture. Jangan melonggarkan assertion: rotasi kunci data dan blind index adalah area keamanan, assertion versi/jumlah rebuild tetap ketat. Bila akar masalahnya bug produk (mis. job rotasi gagal bila ada tenant lain dalam keadaan tertentu), perbaiki produk dan jelaskan.
- `legend-ygty4` `blind-index-bank-rebuild`: versi tetap 1 (harap 2), rebuild count 0 (harap >=1).
- `legend-9jhvz` `data-key-rotation-job`: "Data key rotation failed for 1 tenant".
- `legend-ju62a` `edge-promo-stream-offline`: `source.syncTxid` dari promo undefined (seed promo hilang).
- `legend-mjh1y` `edc-agent.test.ts:616`.
Petunjuk merge train: rotasi menyapu semua tenant; tes baru `ai-module-auto-enable-migration.test.ts` (dari 864) dicurigai meninggalkan tenant aneh, belum terbukti. Run penuh batch66 (m1 479a99525) memperlihatkan ketiganya.

## Scope
- Boleh: file test di atas, helper/fixture test, dan kode produk hanya bila akar masalahnya bug produk.
- Jangan: migrasi, modul uang, menonaktifkan/skip test.

## Pembagian paralel
- 4 subagent bawaan, satu per file: reproduksi dengan menjalankan file itu bersama tetangga yang dicurigai (`LEGEND_TEST_FILES="a b c" heavy pnpm test`, jalur ringan), bukan run penuh.
- Satu subagent pemegang heavy.

## Bukti selesai
- Per file: reproduksi gagal (kombinasi file + perintah) sebelum fix, lalu lulus 3x dengan kombinasi yang sama setelah fix. Bila tidak bisa direproduksi, tulis yang dicoba dan perbaikan isolasi yang dibuat.
- Pra-gate AGENTS.md (prettier, eslint, typecheck API sekali lewat heavy).
- Commit, push tanpa force. Laporan sekali di akhir: cabang, SHA, akar masalah per kartu, angka subagent. Jangan merge.
