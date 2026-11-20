# 1237 Diagnosa gagal 990 r8nas di full run (20 Nov) — engineer Opus

Gagal di full run batch104 (log `../legend-int-batch104/.batch104-fullrun-1.log`, baris ~20976 dan ~33353), lolos 3x sendirian:
`payroll-payout-990-recon-attest.test.ts` > `[legend-r8nas-resolve-withdrawn-propose]` A propose, withdraw, B propose lagi, A approve -> diharapkan tanpa flag, didapat flag recon `reason: attestation_count` kind `resolve`.

Ini area uang (recon payout). Flag palsu = payout beku (fail closed, tidak rugi), tapi bila recon bergantung urutan waktu yang tidak stabil, itu bug produksi.

Hipotesis utama: clock skew app vs DB (app ~40 ms di depan; lihat perbaikan 1230 `isReauthFresh` dan `readDbClock` di `platform-org.service.ts`). Cek apakah recon menghitung attestation dengan membandingkan timestamp dari dua sumber jam (mis. `created_at` default `now()` DB vs stamp app untuk withdraw/propose), atau `now()` transaksi (sama di satu transaksi) vs `clock_timestamp()`. Hipotesis lain: sisa state fixture tenant bersama dari file payout lain.

Kerja: read-only dulu, temukan jalur deterministik (buat test yang merah deterministik, mis. geser jam app +50 ms atau fixture). Bila akar di kode produksi: fix di kode (bukan masking test), fail-first. Bila murni test: perbaiki test tanpa melemahkan kontrol.

Worktree: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-1237" -b ws/1237-r8nas-flake int/batch104`, `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Bukti: `LEGEND_TEST_FILES="src/test/payroll-payout-990-recon-attest.test.ts" heavy pnpm test`, prettier + eslint, `heavy pnpm --filter @starter/api typecheck`. Commit (akhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), push. Budget 50 tool call; di 40 commit + lapor. Laporan: akar masalah file:baris, test merah->hijau, SHA.
