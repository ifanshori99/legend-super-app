# Brief: pc51h test merah (GET /bill 422 setelah swap)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/pc51h-bill-swap (cabang ws/pc51h-bill-swap). Hanya buat berkas baru `apps/api/src/test/order-recovery-swap-bill.test.ts`; jangan ubah berkas lain.

Tiru setup `apps/api/src/test/order-recovery-swap-kitchen.test.ts` (createWorld dari `order-recovery-helpers.ts`, `staffSwap`, `deliver`, `setCatalogPrice`, stations, PRICES). Baca bagian atas berkas itu (baris 1-260) untuk pola.

Tiga kasus, tiap kasus: staf swap lini roti (18.000) ke pengganti, `deliver(event)`, lalu `GET /api/qr-order/:sessionId/bill` dengan `Authorization: Bearer <guest.token>` (token dari `seat()` di helpers; sessionId dari order paid itu) dan harapkan status 200:
1. pengganti LEBIH MAHAL dari roti (butuh harga katalog item lain > 18.000 dan approval price_correction; lihat cara tes `order-recovery.test.ts` / swap tests menyiapkan `approvalRequestId` staf lebih mahal),
2. pengganti LEBIH MURAH (teh 12.000),
3. pengganti SAMA harga (rotiLain 18.000).
Tambah pada tiap kasus assertion: `totals.subtotalIdr/totalIdr` sama dengan sebelum swap (orderMoney) bila bill 200.

Jalankan: `heavy` dengan `LEGEND_TEST_FILES="src/test/order-recovery-swap-bill.test.ts" pnpm test` dari root worktree (cek `heavy` usage; Colima: `~/.claude/scripts/colima-up`). Jangan pkill. Laporkan: status tiap kasus, isi pesan error 422 persis (body response), dan path berkas. Jangan commit.
