# Second opinion (Codex): failover otomatis "bayar di kasir" (legend-8vgid)

Repo: /Users/ifanshori99/Projects/legend super app/legend, cabang `ws/gateway-failover-cashier` (worktree `.worktrees/gateway-failover-cashier`), basis milestone/m1 4c818489; periksa `git diff 4c818489..3aa1cb6b` (2 commit: bba0bc13 + 3aa1cb6b). Read-only. Tingkat K (alur uang). Jangan ubah file.

## Yang dibangun
- `apps/api/src/services/payment-failover.service.ts` (baru): mengubah pembacaan `GatewayHealth` menjadi insiden per outlet. State di `audit_logs` (tanpa tabel): `payment.gateway_failover_started` / `payment.gateway_recovered`, nomor insiden di `maskedChanges.after.incident`. Satu advisory lock per outlet. `down` membuka insiden + SATU alert supervisor (kategori baru `payment_failover`); `available`/`degraded` menutup insiden terbuka. Cache `UP_TRUST_MS` 60 dtk per proses untuk jalur sehat.
- Penanda per bill per insiden: `payment.link_failover_to_cashier` (`markLinkFailedOverToCashier`).
- Hook di `payment.service.ts`: `getPaymentLinkView`, jalur down `createIntent`, `requestPayAtCashier` (kini idempoten: ack pertama dikembalikan, tanpa baris audit baru).
- `edge-sync-conflict-alert.ts`: `notifyOutletSupervisors` diekspor + parameter `category` (default lama).
- Test: `apps/api/src/test/payment-failover.test.ts`.

## Periksa
1. Uang ganda: adakah jalur di mana failover mengubah `paid_idr`, intent, atau payment? Intent online yang sudah pending lalu dibayar di gateway sesudah kasir menerima tunai: apakah jalur `confirmPayment`/unallocated menanganinya sekali?
2. Alert: bisa ganda (race, dua proses, retry transaksi) atau hilang (cache UP_TRUST_MS, marker 30 hari, insiden macet terbuka)?
3. Kebocoran lintas tenant/outlet lewat query `audit_logs` (kunci per tenant+outlet).
4. Efek samping di GET view: apakah kegagalan bookkeeping bisa menggagalkan layar tamu? Beban query di jalur sehat?
5. Pemilihan penerima ("supervisor on duty"): `supervisor`/`outlet_manager` dengan role assignment aktif, fallback owner. Cukup?
Keluaran: temuan nyata saja, file:line, skenario gagal, saran. Maks 400 kata.

## Tambahan (commit 3aa1cb6b)
- `apps/api/src/worker/payment-failover-probe.job.ts` (baru) + `worker-main.ts`: probe terjadwal hanya untuk outlet dengan insiden terbuka, dijalankan tanpa menunggu dari relay, satu sweep per tenant, throttle 5 menit.
- Heartbeat `payment.gateway_still_down` (HEARTBEAT_MS 3 jam, hanya saat ada pembacaan down), `STALE_OPEN_MS` 6 jam, `REOPEN_MS` 10 menit; `listOutletsWithOpenIncident`.
- Test dua tenant `payment-failover-tenants.test.ts`: periksa celahnya (kunci cache `tenant:outlet`, kunci lock, query audit tanpa filter tenant di jalur apa pun).
- Periksa juga: sweep yang tertinggal (probe lambat) vs jalur request yang mencatat state lebih baru; outlet `unconfigured` yang punya insiden terbuka (tidak ditutup, hanya hilang dari daftar probe setelah 6 jam).
