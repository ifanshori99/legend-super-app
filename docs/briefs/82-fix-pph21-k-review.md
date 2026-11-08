# Brief: engineer — perbaikan review K ws/payroll-pph21-tests (6722212)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/payroll-pph21-tests` (cek `git worktree list`), cabang `ws/payroll-pph21-tests`. Jangan baca `.env*`, jangan `pkill`.

Reviewer Opus: LOLOS (72.800 kombinasi engine lolos invariant). Architect: PERLU FIX.

## Temuan architect
1. Tinggi — `apps/api/drizzle/0063_payroll_pph21_policy.sql`, `0064_payroll_pph21_policy_rls.sql`: nomor bentrok dengan main dan `when` (1794141358043) < 0067 main (1794142693714) → DB yang sudah di 0067 melewati diam-diam, tabel `payroll_pph21_policies` tidak ada, endpoint 500. Fix: merge main, hapus 0063/0064 + snapshot, `drizzle-kit generate` ulang jadi 0068+, salin RLS + REVOKE ke migration custom baru. Uji fresh DB dan DB yang sudah di 0067.
2. Sedang — `packages/shared/src/hris/payroll/pph21.ts:313-322,329-333`: `gross_first` dengan `priorTax = 0` → `employerHistory = 0`, seluruh kekurangan Jan–Nov dipotong dari karyawan skema net (contoh TK/0 net ≤ Rp5,4 jt TER 0%). Fix: bila `priorTax = 0`, bagi `history` menurut campuran skema Jan–Nov (base per skema di `prior`) atau G/X bulan ini. Test di samping R64.
3. Sedang — `apps/api/src/services/payroll-run-pph21.service.ts:66-71,92-96`: `capturePph21PolicyForLock` baca kebijakan di transaksi sendiri → v2 terbit antara approve dan lock → pin v2, padahal payslip dihitung v1. Fix: terima `tx`, pin `pph21Policy` dari perhitungan yang sama dalam transaksi lock; tolak lock (`PAYROLL_SNAPSHOT_MISMATCH`) bila ref beda dari yang disetujui.
4. Rendah — `packages/shared/src/hris/payroll/run.ts:341-347`: `pph21PolicyForRun` tidak membandingkan `parameters`. Fix: simpan hash `parameters` di `Pph21PolicyRef` dan bandingkan.

## Catatan (jangan diubah tanpa keputusan founder)
Iuran BPJS pemberi kerja masuk gross (`pph21.ts:34`, `:215`) → karyawan gross-up/net tetap terpotong pajak atas bagian itu. Tunggu konfirmasi founder/konsultan pajak.

## Bukti selesai
Test regresi per temuan; gerbang penuh (`heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`); reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru.
