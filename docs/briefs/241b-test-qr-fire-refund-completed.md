# Brief test-writer: tambah kasus ke qr-order-fire-refund-cap.test.ts (legend-9vzvs)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-qr-payfirst-guard. Hanya edit `apps/api/src/test/qr-order-fire-refund-cap.test.ts` (tambah kasus, jangan ubah F1-F5). Jangan commit. Jalankan HANYA berkas itu (`LEGEND_TEST_FILES=... pnpm test` dari root worktree). Dilarang suite penuh dan pkill.

Perubahan kode (sudah ada): handleQrOrderPaymentPaid menerima intent berstatus paid/partially_refunded/refunded (sebelumnya hanya paid -> order macet awaiting_payment); guard committed = reserved - pending memutuskan void atau fire.

Kasus baru:
- F6 refund 100% sudah `completed` (payment_refunds status completed, completed_at terisi; intent status `refunded`) sebelum payment.paid diproses: order voided (bukan awaiting_payment, bukan fired), tidak ada refund late-payment baru (sisa 0).
- F7 refund 10000 `completed` (intent `partially_refunded`): order voided, refund late-payment untuk sisa (total - 10000) diajukan.
- F8 replay: event payment.paid yang sama diproses dua kali setelah void pada F1/F7: refund late-payment tetap satu baris, order tetap voided.
- F9 order dengan DP (deposit_applied_idr > 0, intent = total - DP), refund approved sebagian membuat sisa < total - DP: void; tanpa refund: fire.
- F10 fired_at order yang fire sesudah refund completed lebih besar dari completed_at refund itu (urutan waktu) pada kasus yang memang fire (refund pending lalu fire; bandingkan dengan completed_at refund lain pada intent yang sama bila ada, atau cukup pastikan fired_at >= paid_at intent).
Lapor lulus/gagal per kasus dan asumsi.
