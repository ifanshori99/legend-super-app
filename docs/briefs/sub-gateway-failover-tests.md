# Sub-brief: tests failover gateway (legend-8vgid)
Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/gateway-failover-cashier (cd explicit, print pwd).
Tulis `apps/api/src/test/payment-failover.test.ts`. Salin harness (fake gateway dengan `healthValue`, DB, openBill, contextFor, supervisor via role assignment) dari `apps/api/src/test/payment-api.test.ts` dan test notifikasi edge-sync (`grep -l notifyEdgeSyncConflictRecorded apps/api/src/test`). Jangan ubah file lain.
Kode yang diuji: `apps/api/src/services/payment-failover.service.ts` (syncGatewayHealth, probeGatewayHealth, resetGatewayHealthCache, markLinkFailedOverToCashier) dan hook di `payment.service.ts` (getPaymentLinkView, createIntent down-path, requestPayAtCashier idempotent). Panggil `resetGatewayHealthCache()` di beforeEach.
Kasus wajib:
1. Gateway sehat: view normal, metode enabled, tidak ada baris audit `payment.gateway_failover_started`/`payment.link_failover_to_cashier`, tidak ada notifikasi.
2. Gateway down: view `gateway.status=down`, metode `gateway_down`; 1 baris `payment.gateway_failover_started` (outlet), 1 baris `payment.link_failover_to_cashier` untuk bill itu; ulang view 3x + 2x pay-at-cashier + percobaan intent (503): tetap 1 baris tiap jenis, `payment_links.paid_idr` dan jumlah baris payment_intents/payments tidak berubah (tanpa uang ganda).
3. Supervisor (role supervisor di outlet) menerima tepat 1 notifikasi kategori `payment_failover` per kejadian walau 2 bill berbeda dan banyak request; non-supervisor tidak menerima. Tanpa supervisor: owner menerima.
4. Pulih: healthValue='available' + view -> 1 baris `payment.gateway_recovered`, metode enabled lagi, view normal. Down lagi -> kejadian baru nomor 2 -> notifikasi ke-2 (total 2), bukan sebelumnya.
5. `degraded` tidak membuka kejadian.
6. Paralel: `Promise.all` 5x syncGatewayHealth('down') -> 1 notifikasi/1 baris started.
7. requestPayAtCashier dua kali: `requestedAt` sama, 1 baris `payment.pay_at_cashier_requested`.
8. Isolasi tenant: tenant lain tidak melihat baris/notifikasi (jika harness mendukung dua tenant; kalau tidak, lewati dan katakan).
Bukti: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/payment-failover.test.ts src/test/payment-api.test.ts" pnpm test'`. Laporkan hasil + jumlah file. Bila service salah, JANGAN ubah service: laporkan bug-nya.
