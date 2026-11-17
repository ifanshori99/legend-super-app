# Brief 974: POS laci + harga inklusif

Worktree: ini (`legend-9fa9b61e`), cabang dari `origin/milestone/m1`. Migrasi baru nomor 0520-0524 (nomor kerja). Dilarang menyentuh: `apps/web` (kecuali kontrak bersama wajib), panel POS 936, refund/recon provider (967), `services/ai-*`, Duitku, payroll.

## Kartu A: legend-4wu4 (celah tebak isi laci)
Masalah: setelah 2 penolakan kas keluar/setor, semua ditolak (788e32e), tapi kasir bisa menaikkan nominal sedikit demi sedikit dan menutup tiap percobaan dengan kas masuk. Keputusan CTO: opsi tuntas.
- `expected_idr` boleh negatif: ubah CHECK `expected_idr >= 0` (migrasi) dan kontrak `posShiftCountSchema.expectedIdr`.
- Kas keluar/setor TIDAK lagi memberi sinyal "isi laci kurang" (tidak ada penolakan/pesan yang bergantung pada isi laci).
- Selisih diserahkan ke persetujuan selisih saat tutup shift (supervisor); selisih tetap tercatat.
- Prinsip sama untuk refund/void tunai di `pos-cash-guard` bila kartu menyebutnya (kartu menyebut: lemah, tiap percobaan butuh override supervisor).

Bukti test: (1) kasir tidak bisa tahu isi laci lewat respons kas keluar/masuk/refund tunai; (2) selisih tetap tercatat dan butuh persetujuan saat tutup.

## Kartu B: legend-npnh (harga inklusif di kasir)
`computePosBill` (`pos-order-pricing.ts:365`) menolak aturan harga termasuk pajak. Dukung inclusive mengikuti model legend-zmc2: `orders.prices_include_tax`, subtotal gross, pajak/layanan dipisah. Pakai helper net subtotal yang sama di jurnal penjualan, refund split, payment link. Total yang dibayar tamu di kasir = total pesanan QR untuk item dan outlet yang sama. Komentar kartu: tambah cek mode harga satu sesi (`QR_ORDER_PRICING_MODE_MIXED`) di POS order create (`pos-order.service.ts` ~520).

Bukti test: (3) bill inclusive: pajak + layanan + net = total, tidak ada pajak dihitung dua kali, pembulatan tidak merugikan outlet; (4) jurnal penjualan dan refund inclusive seimbang, pajak terutang tidak lebih kecil; (5) outlet nett vs gross tidak bocor lintas tenant/outlet.

## Aturan
- Jangan sampai rugi: bila ragu pilih aturan yang membatasi pembayaran, lapor.
- Gate: eslint + prettier file berubah, typecheck API (+web bila shared berubah), test terarah (`LEGEND_TEST_FILES=... heavy pnpm test`), `db:generate` kosong. FK tabel baru inline di CREATE TABLE. Migrasi/tabel baru diakui di `data-import-registry.test.ts` bila perlu.
- Satu token heavy per thread: hanya satu subagent menjalankan tsc/vitest pada satu waktu.
