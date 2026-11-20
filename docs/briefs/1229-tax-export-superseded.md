# 1229 Ekspor pajak ditandai basi sesudah run dibalik/dikunci ulang (SO 1227 item 1, P2)

Peran: engineer Opus (pajak + migrasi, tingkat K). Base `int/batch102`. Worktree: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-1229" -b ws/1229-tax-export-superseded int/batch102`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Laporan: `docs/qa/second-opinion-1227.md` checkout utama.

## Kerja
1. Migrasi nomor **0521** (0519/0520 dipakai 1223 di batch103): kolom `superseded_at timestamptz null` + `superseded_reason text null` di `payroll_tax_exports`. `heavy pnpm db:generate` harus "No schema changes" sesudahnya; cek `node scripts/check-migration-redefinitions.mjs --base int/batch102`.
2. Set `superseded_at` (dalam transaksi yang sama, di bawah lock yang ada) saat: (a) keputusan reversal run (`payroll-run-reversal.service.ts` ~825) untuk ekspor bulan/tahun yang mencakup run itu; (b) lock run regular/koreksi/rapel yang tanggal bayarnya jatuh di bulan/tahun ekspor `ready` yang ada. Audit row `payroll.tax_export.superseded`.
3. Replay idempotency (`payroll-export.service.ts` ~1348-1364): tolak bila ekspor `superseded_at` tidak null (bukan berdasarkan "ada run dibalik"), sehingga ekspor benar sesudah reversal tetap bisa direplay.
4. Respons reversal/lock dan list ekspor memuat penanda basi + pesan Bahasa Indonesia "Ekspor pajak bulan X sudah tidak sesuai. Buat ekspor baru dan lakukan pembetulan SPT bila sudah dilaporkan." (daftar di katalog teks). Unduh ekspor basi tetap boleh (arsip) tapi DTO memuat `supersededAt`. UI: badge "Basi, perlu pembetulan" di daftar ekspor bila ada halaman ekspor pajak.

## Bukti
Fail-first test (merah di base): ekspor ready -> reversal -> ekspor ditandai basi + audit; ekspor ready -> lock run baru di bulan sama -> basi; replay ekspor basi ditolak; ekspor baru sesudah reversal bisa direplay. `LEGEND_TEST_FILES=... heavy pnpm test` untuk test baru + area payroll export/reversal. prettier + eslint, typecheck api (+web bila berubah), text-contract. Commit, push. Budget 60 tool call; di 50 commit + lapor.
