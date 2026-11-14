# 824 Tanya AI: sambungkan sumber data TL-07, TL-08, TL-12 (engineer, tingkat K data pribadi)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/ai-eval-missing-metric` (e7668d647, harness eval yang gagal bila metrik kosong). Cabang akhir `fix/ai-sources-tl07-08-12` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-yp2xj`. Di awal `bd update legend-yp2xj --status in_progress`; saat lapor `--status review` + `bd comment`.

## Masalah
Eval Tanya AI menemukan tiga pertanyaan yang sumbernya kosong: TL-07 segmen pelanggan, TL-08 jadwal shift, TL-12 bagi hasil. Kasusnya sekarang di daftar gagal-diketahui harness (merujuk legend-yp2xj). Tanya AI wajib ikut rilis (founder 12 Nov).

## Tujuan
Cari kenapa tool AI untuk ketiga topik itu mengembalikan kosong (tool belum ada, query salah, izin, atau fixture eval). Sambungkan ke data nyata lewat service yang sudah ada, dengan filter tenant dan izin peran pemanggil. Hapus ketiga entri dari daftar gagal-diketahui sehingga kasusnya lulus sebagai test biasa.

## Keputusan CTO
- Hasil tool tetap lewat masker PII bersama (`redactToolResults` di cabang `fix/ai-tool-result-pii`; bila belum ada di basis ini, jangan membuat masker kedua, cukup pastikan tidak ada field PII baru yang tidak tercakup pola email/telepon/NIK/rekening, dan catat di laporan).
- Bagi hasil menyangkut uang: angka dibaca dari service sumber yang sama dengan layar, tanpa hitung ulang di tool.
- Jangan memalsukan sumber atau melonggarkan checker.

## Scope
- Boleh: tool AI dan registry-nya di `apps/api/src`, service baca untuk ketiga topik, fixture eval, test AI.
- Jangan: migrasi (bila perlu: berhenti dan lapor, nomor 0382), payout/payroll tulis, MCP token/scope, edge, panik.

## Paralel
- Explore x3: satu per topik (tool, service sumber, kenapa kosong).
- test-writer: kasus eval ketiga topik sebagai test biasa (gagal di basis).
- implementer x3, satu per topik (file tidak bertumpuk; registry tool disunting satu implementer terakhir).
- Pemegang token heavy: test-runner.

## Bukti selesai
- Test terarah file `ai-*` yang tersentuh lewat `heavy`; gagal-dulu tercatat; daftar gagal-diketahui kosong untuk ketiga kasus.
- Pra-gate AGENTS.md (prettier, eslint, `heavy pnpm --filter @starter/api typecheck`).
- Satu subagent architect effort high atas diff; temuan nyata dibetulkan.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, akar masalah per topik, test, hasil architect, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
