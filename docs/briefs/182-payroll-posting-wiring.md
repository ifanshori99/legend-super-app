# Brief lanjutan G3bi8: pasang posting jurnal payroll (legend-4n3r) dan pisah refund PPh21 perusahaan (legend-w6vah)

## Cabang
Cabang baru `ws/payroll-posting` dari `ws/payroll-journal` 0705f12f, worktree `.worktrees/payroll-posting`, `worktree:setup`. `ws/payroll-journal` tidak diubah lagi (masuk merge train). Jangan push, jangan merge.

## Tujuan
1. `legend-4n3r` (P1, K): emitter `payroll.locked` dari layanan payroll run, handler di dispatch worker yang memanggil `postJournalFromRuleInTransaction` dengan `payrollJournalAmounts(payload.totals)`, `payroll.reversed` lewat `reversalOf`/`reverseJournal` (bukan rule per role) agar `journal_entries_reversal_once_key` berlaku, rule `payroll.paid` yang melunasi Utang Gaji, dan `reimbursement.paid` dengan payout=payroll dilewati (tidak dobel). Detail: `bd show legend-4n3r`.
2. `legend-w6vah` (P1, K): keputusan CTO (a). `computePayslipTax` memisah refund perusahaan menjadi bagian tunjangan gross-up (lawan 6101) dan bagian PPh ditanggung (lawan 6111); totals dan `payrollJournalAmounts` mengikutinya, jurnal tetap seimbang. Detail: `bd show legend-w6vah`.

## Scope
Boleh: `worker-main.ts` (hanya baris dispatch payroll), layanan payroll run, engine PPh21, `payroll-journal.ts`, posting rules payroll, events catalog payroll, test. Jangan: `pos-shift.service.ts`, modul refund, `accounting-auto-journal-guards.ts`, `pos-order-payment.ts`, open bill, `app.ts`, `routes/index.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu: lock run menghasilkan jurnal posted seimbang; reverse sekali saja (dua kali ditolak oleh kunci unik); paid melunasi 2103; contoh w6vah (gross-up saja, refund Desember 150.000) mengkredit 6101, bukan 6111. Fuzz harness `174-dfuzz.mts` diulang dengan pemisahan baru. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob dengan jumlah file jalan, `node --test tests/*.test.mjs`, tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/182b-second-opinion-payroll-posting.md` di folder utama (tidak di-commit). Migrasi baru: `when` di atas 1794220000000.

## Laporan
Sekali setelah keduanya selesai. Jangan menunggu proses global (`pgrep vitest` milik agent lain). Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
