# 974 POS: tutup celah tebak isi laci + harga termasuk pajak di kasir
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang, migrasi).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (1c185edc0). Langkah pertama `heavy pnpm worktree:setup` (antrean heavy bisa padat: selama antre, baca kode dan tulis test). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0520-0524 (nomor kerja).

Kartu (`bd show <id>`; claim dulu):
- legend-4wu4: kasir masih bisa menebak isi laci dengan menaikkan kas keluar sedikit demi sedikit lalu menutup tiap percobaan dengan kas masuk. Keputusan CTO: pakai opsi tuntas di kartu. Expected boleh negatif (ubah CHECK `expected_idr >= 0` dan kontrak `posShiftCountSchema.expectedIdr`); kas keluar/setor tidak lagi memberi sinyal "isi laci kurang". Selisih diserahkan ke persetujuan selisih saat tutup shift (supervisor). Terapkan prinsip yang sama ke refund/void tunai di `pos-cash-guard` bila kartu menyebutnya.
- legend-npnh: `computePosBill` (`pos-order-pricing.ts:365`) menolak aturan harga termasuk pajak. Dukung inclusive mengikuti model legend-zmc2 (`orders.prices_include_tax`, subtotal gross, pajak/layanan dipisah) dan pakai helper net subtotal yang sama di jurnal penjualan, refund split, dan payment link. Total yang dibayar tamu di kasir = total pesanan QR untuk item dan outlet yang sama.

Jangan sampai rugi: test bukti (1) kasir tidak bisa mengetahui isi laci lewat respons kas keluar/masuk/refund tunai, (2) selisih kas tetap tercatat dan butuh persetujuan saat tutup, (3) bill inclusive: pajak + layanan + net = total, tidak ada pajak dihitung dua kali, pembulatan tidak merugikan outlet, (4) jurnal penjualan dan refund inclusive seimbang dan pajak terutang tidak lebih kecil, (5) outlet nett vs gross tidak bocor lintas tenant/outlet.

Jangan sentuh: `apps/web` kecuali kontrak bersama yang wajib (catat di laporan), panel POS 936 (cabang `ghostex/pos-panel-bayar-sisa-5w6` ditahan Q19), refund/recon provider (967), `services/ai-*` (964), Duitku (969), payroll (972).

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh bersamaan. Gate (TEAM #9, bukan pnpm check penuh): lint, typecheck API (+web bila shared berubah), test terarah grup pos/shift/cash/pricing/sales-journal/refund, `db:generate` kosong, prettier. Satu token heavy per thread (#14).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
