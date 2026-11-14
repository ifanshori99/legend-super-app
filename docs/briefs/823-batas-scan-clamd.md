# 823 Batasi scan clamd bersamaan + backpressure (engineer, tingkat S keandalan)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/storage-scanner-pdf` (53b0db393). Cabang akhir `fix/clamd-scan-limit` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-1rtm1`. Di awal `bd update legend-1rtm1 --status in_progress`; saat lapor `--status review` + `bd comment`.

## Masalah
Second opinion 821 P2 (`docs/qa/second-opinion-pemindai-m4-m6.md` di folder utama): `apps/api/src/services/clamd-scanner.ts:45` dan `:90` membuka koneksi per scan dan mengantre seluruh isi ke socket tanpa batas jumlah atau backpressure. Banyak unggahan saat clamd lambat menumpuk koneksi/buffer sampai timeout 15 detik, menjenuhkan memori atau clamd sehingga PDF tenant lain ditolak dan fail-open gambar aktif. Slot worker PDF (`pdf-safety.ts:154`, `core-image.ts:100`) dilepas sebelum scan.

## Keputusan CTO
- Batas scan bersamaan global (mis. 4) dan per tenant (mis. 2), dengan antrean kecil berbatas; kelebihan ditolak cepat 503 dengan kode jelas (bukan menunggu timeout). Angka jadi konstanta yang mudah diubah lewat env tervalidasi di `config/env.ts`.
- Tulis ke socket menghormati backpressure (`write()` false -> tunggu `drain`).
- Slot selalu kembali setelah selesai, galat, atau timeout.
- PDF yang tidak selesai dipindai tidak pernah tersimpan. Aturan fail-open gambar tidak dilonggarkan: kelebihan beban dihitung "pemindai tidak tersedia" hanya bila itu sudah perilaku sekarang; bila ragu, tolak.

## Scope
- Boleh: `clamd-scanner.ts`, titik panggil scan, `config/env.ts`, test pemindai.
- Jangan: migrasi, logika payout/batch, edge, panik, EDC.

## Paralel
- Explore x1: semua pemanggil scanner dan alur slot worker.
- test-writer: fake clamd lambat + banyak scan bersamaan (koneksi berbatas, kelebihan ditolak, slot kembali setelah timeout/galat, PDF tak terpindai tidak tersimpan); gagal-dulu di basis.
- implementer x1.
- Pemegang token heavy: test-runner.

## Bukti selesai
- Test terarah file pemindai/storage/payout-evidence yang tersentuh lewat `heavy`; gagal-dulu tercatat.
- Pra-gate AGENTS.md (prettier, eslint, `heavy pnpm --filter @starter/api typecheck`).
- Satu subagent reviewer atas diff; temuan nyata dibetulkan.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, batas yang dipilih, test, hasil reviewer, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
