# Brief: second-opinion — kunci intent DP lintas penulis dan batas refund DP hangus (legend-em6p, legend-fsl5)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/dp-intent-lock`, cabang `ws/dp-intent-lock` (commit di laporan engineer). Rentang: `git diff milestone/m1...ws/dp-intent-lock -- apps/api/src packages ':!apps/api/src/test'`. Test hanya dibaca bila perlu bukti.

## Latar

Desain auto-journal §10 (`git show ws/aj-fix142:docs/design/auto-journals.md`, bagian "Time bounds" dan "U4") mengurutkan tiga fakta uang per waktu: `payment_refunds.completed_at`, `pos_orders.completed_at`, `reservations.closed_at`. Dulu tiap penulis mengambil waktunya sebelum commit tanpa kunci bersama, sehingga fakta yang commit belakangan bisa bercap lebih awal. Perbaikan cabang ini:

- U4 (em6p): tiap penulis fakta mengunci baris `payment_intents` yang disentuh fakta (`FOR UPDATE`, urut naik), lalu mengambil waktu dari `lockIntentsForFact` (`apps/api/src/services/payment-refund-fact-time.ts`): `now` pemanggil, digeser ke 1 ms setelah fakta terakhir yang sudah commit pada intent itu.
- U1 (fsl5): `refundableBalance` mengurangi DP hangus; refund atas DP hangus dijawab 409 `REFUND_DEPOSIT_FORFEITED`, sebelum penahan e7zj `REFUND_DEPOSIT_IN_USE`.

## Berkas

- `apps/api/src/services/payment-refund-fact-time.ts` (baru)
- `apps/api/src/services/payment-refund.service.ts` (`completeRefund` dan pemanggilnya, `lockRefundGraph`)
- `apps/api/src/services/payment-admin.service.ts` (`refundableBalance`, `createRefund`)
- `apps/api/src/services/pos-order.service.ts` (`completePosOrder`)
- `apps/api/src/services/reservation-lifecycle.ts` (`closeReservation`), `reservation-public.ts` (`cancelGuestReservation`)
- Rujukan urutan kunci: `pos-order-late-payment.ts`, `pos-order-payment.ts` (`handlePosPaymentPaid`), `reservation-deposit-credit.ts` (kunci advisory e7zj), `qr-order-ports.ts` (urutan 94qt), `payment.service.ts` (`applyConfirmation`).
- Test: `apps/api/src/test/dp-intent-lock-race.test.ts`

## Fokus

- Untuk fakta pada satu intent: urutan commit sama dengan urutan waktu tersimpan, tanpa seri. Cari penulis fakta yang belum lewat `lockIntentsForFact` (penutupan reservasi lain, sweep, jalur QR, void, penyelesaian refund lain).
- Himpunan intent yang dikunci penjualan (alokasi DP sesi meja dan tender gateway tertangkap) sama dengan himpunan yang dibaca kueri "fakta terakhir"; alokasi yang ditambah setelah order dibuat.
- Deadlock: urutan kunci baru (orders -> pos_orders -> payment_intents; reservations -> payment_intents; refund: intent dulu) terhadap semua jalur yang sudah mengunci `payment_intents`, `orders`, `pos_orders`, `reservations`, dan kunci advisory e7zj/94qt.
- Batas refund: DP hangus dari reservasi yang ditutup, refund sebagian sebelum penutupan, refund otomatis bagian yang dikembalikan saat penutupan, refund dana tak teralokasi (dikecualikan), refund persetujuan (`applyApproval`) dan refund terlambat POS.
- Presisi waktu: mikrodetik PostgreSQL vs milidetik `Date`.

## Effort

xhigh (uang dan tingkat K).

## Laporan

Tulis ke `/Users/ifanshori99/Projects/legend super app/legend/docs/briefs/168b-second-opinion-dp-intent-lock.result.md` (main checkout, tidak di-commit). Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran. Tidak ada temuan: satu baris. Sebut test atau eksekusi yang dijalankan.

## Larangan

Jangan edit atau commit selain berkas hasil. Jangan baca `.env*` atau `~/.ssh`.
