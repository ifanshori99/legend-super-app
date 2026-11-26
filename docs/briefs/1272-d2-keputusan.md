# D2 laporan keuangan F6 (legend-qlirp): keputusan CTO 27 Nov

1. EBITDA = pendapatan dikurangi beban, tidak termasuk akun berperan depresiasi, amortisasi, bunga, dan pajak penghasilan. Tambah peran akun `amortization_expense`, `interest_expense`, `income_tax_expense` ke peta akun. Peran yang belum dipetakan outlet: laporan tetap jalan, tampilkan catatan "belum memisahkan <peran>" (tidak menebak).
2. Izin terbatas mengubah berkas kartu A (kartu A sudah selesai): `metrics-query.service.ts` boleh ditambah kemampuan "kecualikan akun berperan X" dari jumlah, perubahan minimal, test regresi untuk keluarga lain. `packages/shared/src/dashboard/*` boleh diubah untuk rumus `cash_balance`/`bank_balance` (saldo jurnal peran `cash_on_hand`, `petty_cash`, `bank`) dan dimensi `legal_entity` pada laporan finance.*.
3. Memindahkan `ai-metrics/finance.ts` ke mesin bukan F6: bead terpisah.
4. Angka uang wajib cocok dengan jurnal sumber (test rekonsiliasi), termasuk bulan fiskal tertutup.
