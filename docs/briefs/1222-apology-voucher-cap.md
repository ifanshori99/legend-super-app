# 1222 Voucher permintaan maaf tanpa laporan item gagal wajib approval (SO 1221 B1)

Temuan: `docs/qa/second-opinion-1221-b.md` B1. Base `int/batch101`. Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-1222" -b ws/1222-apology-voucher-cap int/batch101`, lalu di worktree `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Aturan umum (test, commit, push, pra-gate): `docs/briefs/1217-1220-fix-so1216.md`.

Keputusan CTO (aturan membatasi, founder boleh melonggarkan nanti): voucher permintaan maaf yang TIDAK terikat laporan item gagal selalu masuk alur approval yang sudah ada (tier terendah), berapa pun nilainya. Dengan laporan: perilaku sekarang (cap sisa uang order) tetap. Idempotency key baru tidak boleh melewati approval. Teks UI baru masuk katalog.

Test fail-first: supervisor terbit 99.000 tanpa laporan -> status menunggu approval, voucher belum bisa dipakai; dengan laporan di bawah cap -> langsung terbit seperti sebelumnya; approve -> bisa dipakai. Budget 45 tool call, commit di 35. Lapor SHA, merah->hijau, yang belum.
