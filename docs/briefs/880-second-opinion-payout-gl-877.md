# 880 Second opinion payout GL 877 (gerbang rilis uang)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Uang dan migrasi: effort xhigh. Read-only, tanpa edit kode produk.
Repo: /Users/ifanshori99/Projects/legend super app/legend. Jangan checkout di folder utama; pakai `git show`/`git diff` atau worktree sendiri.
Cakupan: `git diff 0173623ed origin/fix/payout-gl-877` (tip d1e259ed4): biaya bank pada batch pending (`fee_posted`, `resolvePendingSettles`, `repostSkippedFees`), urutan lock bukti di `confirmManualItems`, perubahan `settle_skipped`→`settle` di consumer `payroll.locked`, migrasi 0620 (guard trigger `payroll_payout_gl_postings_guard`). Konteks: `docs/qa/second-opinion-payout.md`, `docs/qa/second-opinion-payout-870.md`, `docs/briefs/877-payout-p3-gl.md`.
Cari: jurnal ganda atau hilang (biaya, settle), GL tidak cocok dengan uang yang benar-benar bergerak, akun beku yang dilewati, consumer outbox yang bisa macet, deadlock baru, trigger yang bisa dilewati, idempotensi resolve berulang/paralel.
Tanpa heavy kecuali benar perlu satu test terarah (LEGEND_TEST_FILES=... heavy pnpm test).
Hasil: `docs/qa/second-opinion-payout-gl-877.md` (P0-P3, berkas:baris, skenario, usul test), commit ke cabang baru `qa/second-opinion-payout-gl-877`, push tanpa force. Lapor sekali saat selesai: ringkasan, path, cabang/commit.
