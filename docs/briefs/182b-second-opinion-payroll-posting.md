# Brief 182b: second opinion — payroll posting wiring + employer refund split (legend-4n3r, legend-w6vah, tingkat K)

Peran: `second-opinion` (Codex, `gpt-6.1-sol`, effort xhigh: uang). Baca `~/.agents/team/roles/second-opinion.md`. Read only. Jangan mengubah kode, commit, atau push.

Repo: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payroll-posting`, cabang `ws/payroll-posting`. Diff: `git diff 0705f12f..ws/payroll-posting` (dasar = `ws/payroll-journal`, sudah ditinjau di brief 174b). Konteks: `docs/briefs/sub-182-payroll-posting.md`.

## Yang diubah

- Engine PPh21 (`packages/shared/src/hris/payroll/pph21.ts`, `payslip-tax.ts`, `payslips.ts`): refund PPh21 perusahaan dipisah menjadi bagian tunjangan gross-up (`pph21EmployerAllowanceRefundIdr`, lawan 6101 Beban Gaji) dan sisanya bagian PPh ditanggung (lawan 6111), proporsional terhadap tunjangan dan PPh ditanggung periode sebelumnya.
- Jurnal (`payroll-journal.ts`, `posting-rules.ts`): dua baris kredit menggantikan satu; rule baru `payroll.paid` (Dr 2103 Utang Gaji, Cr 1103 Bank dan 1102 Kas Kecil); payload `payroll.paid` membawa `bankTransferIdr`/`cashIdr`.
- Consumer `apps/api/src/services/payroll-gl-consumer.ts` dipasang di `worker-main.ts`: `payroll.locked` diposting dari totals, `payroll.paid` melunasi Utang Gaji, `payroll.reversed` membalik entri lock lewat `reverseJournalInTransaction` (kunci unik `journal_entries_reversal_once_key`), kasbon dan reimbursement tunai diposting, reimbursement payout payroll dilewati.
- `reverseJournal` di `accounting-journal.service.ts` dipecah agar bisa dipanggil di dalam transaksi worker dengan aktor sistem.
- Helper emit `apps/api/src/services/payroll-events.ts` untuk layanan payroll run (legend-07eg, belum ada).
- Perbaikan review K internal: paid/reversed mengikuti entri lock walau flag akuntansi dimatikan; run nol `skipped`; tanggal = tanggal kalender Jakarta (cutoff 00:00); entri lock bertanggal min(periodEnd, tanggal lock); reversal tidak sebelum entri lock; reversal manual yang sudah ada = `skipped`; reversal run yang sudah dibayar ditolak; cross-check per baris; engine melempar `RangeError` bila bagian ditanggung melebihi PPh ditanggung sebelumnya.

## Periksa

1. Rumus pemisahan refund: benar terhadap cara engine menghitung saldo pajak perusahaan (`employerBalance`, cabang proporsional dan gross_first), pembulatan, dan kasus campuran. Cari kasus 6101 atau 6111 jadi saldo terbalik sepanjang tahun.
2. Jurnal tetap seimbang untuk semua totals yang lolos schema.
3. Consumer: idempoten pada replay outbox, jurnal balik hanya sekali, `payroll.paid` sebelum/tanpa lock, reversal setelah paid, periode tutup atau mapping hilang (retry dan dead letter), RLS dan tenant.
4. `reverseJournalInTransaction` dengan `postedBy` null: tidak melemahkan pemeriksaan izin di jalur HTTP.
5. Perubahan kontrak `payroll.paid` dan field tax/totals baru terhadap fixture dan data tersimpan.

## Laporan

Temuan berurut dari paling parah: file:baris, skenario gagal dengan angka Rupiah, saran perbaikan. Tidak ada temuan: tulis itu.
