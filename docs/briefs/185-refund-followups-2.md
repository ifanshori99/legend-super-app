# Brief lanjutan G781b: sisa refund putaran 2

## Cabang
Cabang baru `ws/refund-followups-2` dari `ws/refund-payout-followups` d2f8c072, worktree `.worktrees/refund-followups-2`, `worktree:setup`. `ws/refund-payout-followups` tidak diubah lagi. Jangan push, jangan merge.

## Tujuan (tingkat K, paralel lewat subagent, file tidak bertumpuk)
1. `legend-x1i1h` (P2): void penjualan QRIS tidak mengkredit balik `customer_deposit`; refund intent lolos guard, payout parkir mismatch.
2. `legend-j0ag5` (P2): jurnal refund POS/sale yang di-reverse finance (ACC-01) masih dihitung terposting di atribusi dan guard.
3. `legend-leqj6` (P3): refund late payment POS dipotong refund pending; bila pending gagal, sisa uang tamu tertahan.
4. `legend-45bs9` (P3) bersama `legend-8v2yl` (P3): pesanan dua intent QRIS + refund POS sebagian menahan kedua intent; simpan tender id atau intent id per baris refund POS agar atribusi tepat.
Detail: `bd show <id>`.

## Scope
Sama dengan brief 181. Migrasi (bila perlu kolom baris refund): nomor + `when` di atas 1794220939622.

## Bukti selesai
Seperti brief 181: test reproduksi gagal dulu, `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob dengan jumlah file jalan, tsc lewat `heavy`, eslint, prettier, review K (reviewer Opus + architect paralel, perbaikan terakhir dibaca ulang reviewer segar). Brief Codex `docs/briefs/185b-second-opinion-refund-followups-2.md` di folder utama (tidak di-commit).

## Laporan
Sekali setelah keempatnya selesai. Hapus worktree subagent sementara milikmu sebelum lapor, setelah memastikan isinya sudah ada di cabang. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
