# Brief 121: second opinion untuk hari usaha tertutup di POS dan QR (legend-mf0.1, legend-2o1b, POS-05)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran.
- Satu run (diff non-test 197 baris: 152 tambah, 45 hapus; di bawah batas 800).

## Repo

- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-closed-day`, cabang `ws/pos-closed-day`, HEAD `2658750c` (dua commit: `13aed29b` POS, `2658750c` QR).
- Basis diff `0f7e4ff6` (`milestone/m1` saat cabang dibuat).
- Konteks fitur: PRD `docs/PRD.md` baris 652 (POS-05); kontrak `docs/plan/contracts.md` baris 165 (rekap Tutup Hari, identitas `Σ net = sales − refunds − paid voids`); keputusan CTO 2026-11-08 di `bd show legend-mf0.1`.
- Guard hari tertutup untuk create, submit, tender, complete, void, dan refund sudah ada sebelum diff ini (legend-6c0). Diff ini menambah pemeriksaan di jalur webhook QRIS, di pembuatan pesanan QR tamu, dan test.
- Keputusan founder Q20 (9 Nov 2026): pesanan QR setelah Tutup Hari ditolak (`BUSINESS_DAY_ALREADY_CLOSED`, 409) dan tamu melihat pesan bahwa outlet sudah tutup; tidak dipindah ke hari berikut.

## Run: guard hari tertutup, webhook QRIS, dan pesanan QR

Perintah:

```
git diff 0f7e4ff6 2658750c -- apps/api/src/services/pos-cash-guard.ts apps/api/src/services/pos-order-payment.ts apps/api/src/services/qr-order.service.ts packages/shared/src/qr-order/errors.ts packages/shared/src/i18n/messages/qr-cart.ts apps/web/src/features/ws03-qr-order/components/cart/checkout-page.tsx
```

Berkas berisiko:

- `apps/api/src/services/pos-cash-guard.ts`: `isBusinessDayClosed` dan `assertBusinessDayOpen` (advisory lock shared `hashtext('pos-day:<tenant>:<outlet>:<date>')`, baca `pos_daily_closes`).
- `apps/api/src/services/pos-order-payment.ts`: `handlePosPaymentPaid` (urutan kunci orders, pos_orders, tender, lalu kunci hari), helper `voidTendersAndRefundPaidQris`, cabang `bill_below_tender` yang dipindah ke helper.
- `apps/api/src/services/qr-order.service.ts`: guard di `checkout()` (dipanggil `placeQrOrder`) setelah `businessDateFor` dan sebelum harga, reservasi stok, promo, deposit, dan insert `orders`; urutan kunci baris sesi, kunci idempotensi, baris cart, lalu kunci hari; replay idempotensi sebelum guard.
- `apps/web/src/features/ws03-qr-order/components/cart/checkout-page.tsx` dan `packages/shared/src/i18n/messages/qr-cart.ts`: pemetaan kode ke pesan tamu.
- Untuk konteks (tidak diubah): `closePosDay` dan `computeRecap` di `apps/api/src/services/pos-day.service.ts`, `mutatePosOrder` dan `createPosOrder` di `pos-order.service.ts`, `voidPosOrderCorrection` dan `refundPosOrder` di `pos-order-corrections.ts`, `requestPosLatePaymentRefund` di `pos-order-late-payment.ts`, konsumen di `order-payment-consumers.ts`.

Test terkait (boleh dibaca dan dijalankan, `LEGEND_TEST_FILES="src/test/<file>" pnpm test` dari root worktree): `src/test/qr-order-closed-day.test.ts`, `src/test/qr-order-api.test.ts`, `src/test/pos-cash-guard.test.ts`, `src/test/pos-order-qris-lifecycle.test.ts`, `src/test/pos-day.test.ts`, `src/test/pos-order-qris-round2.test.ts`, `src/test/qr-order-late-payment.test.ts`.

## Invariant (tingkat K)

1. POS-05: setelah Tutup Hari, rekap beku di `pos_daily_closes` selalu sama dengan data POS untuk hari itu. Tidak ada pesanan, tender tertangkap, refund, atau void baru yang tercatat pada hari usaha yang sudah ditutup.
2. Tulisan POS online bertanggal hari tertutup ditolak dengan `BUSINESS_DAY_ALREADY_CLOSED` (409), tanpa efek samping.
3. Balapan Tutup Hari vs tulisan POS: tulisan itu selesai sebelum rekap dibaca (dan masuk rekap), atau menunggu lalu ditolak. Tidak pernah diterima tetapi hilang dari rekap.
4. Tidak ada deadlock: semua penulis mengambil kunci baris lebih dulu, lalu kunci hari shared; `closePosDay` mengambil kunci hari exclusive tanpa kunci baris.
5. Uang pelanggan tidak terdampar: pembayaran QRIS yang tidak bisa ditangkap (hari tertutup, tender batal, pesanan final, tagihan menyusut) dikembalikan penuh, satu kali per intent, dan konsumen outbox tidak melempar error untuk kasus ini (tidak retry tanpa akhir).
6. Idempotensi: event `payment.paid` yang diulang, berurutan atau bersamaan, tidak menambah void, audit, atau refund kedua.
7. Isolasi tenant: semua query memfilter `tenant_id` di samping RLS.
8. Pesanan QR tamu pada hari tertutup ditolak tanpa efek samping: tidak ada baris `orders`, reservasi stok, pemakaian promo, atau pemakaian deposit; cart tetap utuh; balapan dengan Tutup Hari berakhir sama (menunggu lalu ditolak, atau selesai sebelum tutup).
9. Pesan error untuk tamu tidak membocorkan detail internal.
