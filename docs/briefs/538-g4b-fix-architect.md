# 538-G4b Fix temuan architect HRIS (ws/hris-misc)
Worktree .worktrees/hris-misc. Test gagal-dulu, commit per temuan, jangan merge.
- P2 `hris-attendance-admin.service.ts:617-646, :717`: review-queue?logId= melewati aturan antrean (log tidak tersampel/ditolak/koreksi manual tanpa flag tetap keluar + URL selfie bertanda tangan). Fix: by-id filter `or(inArray(reviewStatus,["accepted","rejected"]), openItems)`, loop `reviewed || (byId && decided(row)) || queued(row, samplingOf)`. Test: log valid tak tersampel lewat id -> halaman kosong.
- P3 `drizzle/0276_leave_flag_closed_payroll.sql:27-34`, `:526`: log dibuka ulang tetap membawa decision_action, leave_snapshot, case_kind lama. Fix: migrasi 0361 mendefinisikan ulang fungsi, set ketiganya NULL; test.
- P3 `hris-attendance.service.ts:1823-1854`: keputusan CTO: tetap boleh untuk kode supervisor, tapi tolak 403 bila target = karyawan pemanggil sendiri.
- P3 `hris-attendance-admin.service.ts:418`: canCancelLeave false untuk log milik reviewer sendiri.
Bukti: test terarah via heavy, tsc api, eslint/prettier. Lapor dengan angka subagent.
