# Sub-brief: tes poller DOIT (legend-rfiof, tingkat K uang)

Worktree: `.worktrees/doit-pending-poller` (path absolut, jangan cd ke tempat lain). Jangan baca `.env*`, jangan push, jangan ubah kode produksi (hanya tes baru). Jangan sentuh `syncExpiredIntentPayment` dan perilakunya.

## Yang sudah diubah (jangan ulang)
`pollPendingGatewayIntents` (`apps/api/src/services/payment.service.ts`) kini mengklaim intent atomik: kolom baru `payment_intents.gateway_poll_lease_until` (migrasi 0190), `FOR UPDATE SKIP LOCKED`, lease `GATEWAY_POLL_LEASE_MS` (2 menit) diisi saat klaim, dilepas (null) di `finally` setelah putaran. Intent dengan lease > now dilewati.
Poller hanya memilih intent `pending` dan `expired` ber-`providerRef`. Status `failed`/`refunded`/`partially_refunded` tidak pernah dipilih.

## Pola tes
Contoh helper dan server DOIT/fake gateway: `apps/api/src/test/payment-supersede-doit.test.ts` (memanggil pollPendingGatewayIntents), `payment-webhook-api.test.ts` (webhook, baris ~1002 failed lalu paid, ~927 duplikat). Pakai helper yang sudah ada, jangan duplikat tes yang sudah ada (rujuk saja).
Jalankan: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/<file>" pnpm test'` (tanpa heavy; dianggap ringan).

## File A: `apps/api/src/test/payment-poll-lease.test.ts`
1. Dua `pollPendingGatewayIntents` bersamaan (Promise.all) atas N intent pending: tiap intent ditanya gateway tepat sekali (hitung panggilan getStatus per providerRef); jumlah `checked` kedua putaran berjumlah N.
2. Setelah putaran selesai, `gateway_poll_lease_until` null untuk semua intent (juga bila gateway melempar galat).
3. Intent dengan lease di masa depan (set langsung lewat DB) dilewati; dengan lease sudah lewat diambil lagi (worker mati).
4. Batas `limit` dihormati.

## File B: `apps/api/src/test/payment-terminal-paid.test.ts`
1. Webhook DOIT `paid` (tanda tangan sah) untuk intent `refunded`: status tetap `refunded`, tercatat `double_payment` (flag, `payment_unallocated_funds`, audit `payment.double_payment_flagged`), event webhook `processed`. Sama untuk `partially_refunded`. Cari assertion di `payment.service.ts` ~1574-1620.
2. Intent `failed`: poller tidak menyentuhnya (gateway tidak ditanya, status tetap `failed`); catat dalam komentar tes bahwa webhook `paid` untuk `failed` hari ini menyelesaikan sebagai late payment (tes yang ada di `payment-webhook-api.test.ts` ~1002) dan keputusan founder masih menunggu: JANGAN menulis tes yang mengunci atau membalik perilaku itu.
3. Poller untuk intent `refunded`/`partially_refunded`: gateway tidak ditanya, status tetap.
4. Poller: DOIT menjawab status tak dikenal ("settled", "cancelled") untuk intent pending: status tetap `pending`, bukan `paid`, `checked` naik, `settled` 0. Galat jaringan/timeout/HTTP 500: status tetap, putaran lanjut ke intent lain.
5. Webhook `paid` lalu poller (dan sebaliknya) untuk intent yang sama: hanya satu kali menyelesaikan (satu baris evidence, satu event payment settle), poller kedua tidak mengubah apa pun.
