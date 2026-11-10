# Brief: pc51h fix, tes tambahan (option A)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/pc51h-bill-swap.
Kode sudah diubah (jangan ubah): `packages/shared/src/qr-order/schemas.ts` (field baru `swapReplacementIdr` default 0 di `qrOrderSchema`; refine: subtotal == jumlah SEMUA line - swapReplacementIdr; swapReplacementIdr <= jumlah line) dan `apps/api/src/services/qr-order.service.ts` (`swapReplacementIdsOf`, `orderDto` hitung swapReplacementIdr dari order_issues.replacement_order_item_id).

Tugas test-writer:
1. Edit `apps/api/src/test/order-recovery-swap-bill.test.ts`: tiga kasus (lebih mahal, lebih murah, sama) harus hijau: bill 200, `totals.subtotalIdr`/`totalIdr` sama dengan sebelum swap, `orders[0].swapReplacementIdr` == line_total lini pengganti, dan jumlah (semua lini) - swapReplacementIdr == subtotal. Tambah satu kasus: order TANPA swap, ubah `orders.subtotal_idr` lewat `owner` jadi salah (+1) -> GET bill TIDAK 200 (422 seperti sebelumnya).
2. Tes unit skema di berkas tes shared yang sudah ada untuk `qrOrderSchema` (cari dengan Grep `qrOrderSchema` di packages/shared dan root test): order tanpa swap subtotal salah ditolak; dengan swapReplacementIdr benar diterima; swapReplacementIdr > jumlah line ditolak; swapReplacementIdr tidak menyelamatkan subtotal yang salah.
Jalankan: `LEGEND_TEST_FILES="src/test/order-recovery-swap-bill.test.ts src/test/order-recovery-swap-kitchen.test.ts" pnpm test` via heavy (swap-kitchen = regresi), plus tes shared terarah. Jangan commit. Laporkan hasil.
