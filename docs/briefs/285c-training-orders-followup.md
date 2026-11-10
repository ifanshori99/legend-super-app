# Lanjutan brief 285 (G77qt): shift kas dan stok untuk pesanan latihan

Cabang baru `ws/training-orders-followup` dari `ws/training-orders-no-journal` (1a21d857), worktree `.worktrees/training-orders-followup`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Tanpa migrasi kecuali terbukti perlu (nomor `0192`, `when` 1794271000000).

1. `legend-0v3b3` (P1, K): tutup shift (`cashier_shift.closed`) tidak menghitung tender tunai pesanan latihan ke kas yang diharapkan (`pos-shift-support.ts` sekitar :259-272). Shift campuran latihan dan nyata tidak boleh mencatat selisih palsu.
2. `legend-13avp` (P1, K), keputusan founder Q63: pesanan latihan tidak memotong stok. `recipe-deduction` melewati `is_training`; tidak ada pergerakan stok ledger untuk pesanan latihan. Pesanan biasa tidak berubah.

Pakai helper `isTrainingOrder` yang sudah ada. Dua potongan di berkas terpisah: boleh lewat `implementer` paralel.
Awal: `ghostex board associate <id>` + `bd update <id> --status in_progress` untuk kedua kartu. Selesai: `--status review` + `bd comment`.

Bukti: tes gagal-dulu per kartu, `LEGEND_TEST_FILES` terarah (sertakan tes shift, recipe-deduction, stok ledger yang ada), `tsc` api lewat `heavy`, eslint + prettier, satu `architect` (tingkat K).
Lapor sekali: SHA, bukti, file berubah, risiko.
