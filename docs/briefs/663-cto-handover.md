# Serah terima CTO (S30:P6b2j:G2cll -> CTO baru), 14 Nov 2026

Baca `~/.agents/team/roles/cto.md` dulu, lalu ini. Riwayat lengkap: ekor `docs/PROGRESS.md`.

## Langkah pertama
1. Buat ulang cron (hilang saat sesi berganti): push cadangan `17 * * * *` (`git push origin --all`, tanpa force, lapor founder hanya bila gagal) dan retro 3 jam `43 1,4,7,10,13,16,19,22 * * *` (cto.md langkah 2). Retro terakhir: Retro 26, 14 Nov 02:13.
2. Adopsi thread aktif: `ghostex coordinator link S30:P6b2j:G2r4f --task "Batch61 ke milestone m1"` dan `ghostex coordinator link S30:P6b2j:G5fxr --task "Daftar hal yang perlu dicek finance"`.

## Kuota (penghalang utama)
Hanya akun Claude #2 (7d 57%, reset 20 Nov) dipakai. #1/#3 93-96% reset 17 Nov (founder bilang akan reset #1 manual). Codex 89-95%, founder menambah akun Codex. Jaga maks ~3 thread Sonnet di #2.

## Sedang jalan
- W26 batch61 (G2r4f): ws/edge-contract-followups (berisi edge-sales-gl) + ws/payroll-payout-gl, migr dari 0348. Run penuh pertama mati SIGTERM 04:48; rerun. AS-2 `accounting-cash-limit-antisplit` merah: diminta cek terarah 3x, bila konsisten merah = logika uang, putuskan sebelum diubah.
- W28 662 (G5fxr): API pengecualian finance (4oclu) + helper rekening payout (s7roi).

## Antre batch62 (setelah batch61)
`ws/edge-sync-resilience` ebc8a271e (migr 0538-0539), `ws/payroll-payout-hardening` 28ef0a347 (migr 0542-0543, di atas payroll-payout-gl), lalu `ws/finance-exceptions` bila selesai. Merge train: cek urutan `when` journal.

## Menunggu founder
- Q25 contoh berkas BCA Multi Auto Transaksi (W9). Layout BCA belum terkonfirmasi.
- Volume Docker: founder 14 Nov "jangan, tanya tiap kali" (coordinator memory note 1).

## Gerbang UI tertahan (butuh Codex designer)
legend-nnufz (halaman provider Tanya AI, penghalang rilis), wnkep.6/.7 UI disbursement, UI daftar pengecualian finance (4oclu).

## Keputusan CTO hari ini (sudah di bead)
Edge: GL+PBJT wajib, void/refund edge dari cloud diblok, tax_missing tetap masuk ke PBJT, QR bayar-dulu tidak dilunasi kasir edge (dy7pc ditutup), struk order ditolak dilewati+konflik, dead-letter frame. Rilis: cloud dulu baru edge (bd memory release-order-edge). Payroll: paid_by penyetuju terakhir, fee auto-jurnal 8101, approve/export ditolak tanpa mapping, fee overpaid dijurnal. Q18 lanjutan founder: hanya entri yang lewat batas ditahan.

## Kartu lanjutan terbuka
legend-9zuo5 (fixture opening_hours), legend-cqehx selesai, legend-132mw/vje21 selesai di batch61; second-opinion Codex per area sebelum gerbang rilis (setelah reset 17-18 Nov).
