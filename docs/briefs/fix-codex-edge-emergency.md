# Brief: fix temuan Codex alarm darurat edge (legend-w5u1a)

Branch: ghostex/b5ac36e8 (dari ws/edge-emergency-impl a68680f4). Tingkat K. Keputusan sudah diambil CTO/founder; jangan ditanyakan.

## Butir
1. P1 `apps/api/src/routes/emergency-cloud.routes.ts:72`: ACK di cloud tanpa `refuseWhenEdgeServesOutlet`. Tambahkan penolakan yang sama seperti mutasi edge lain (lihat pola di route lain / `panic-edge-ownership.ts`).
2. P1 `apps/api/src/services/panic-alert-outbox.ts:195`: resolve dikirim ke node aktif tertua. Benar: targetkan node pemilik alert, plus salinan ke node aktif saat failover.
3. P1 `apps/api/src/services/panic-relay.service.ts:465`: cek sesi gagal saat kirim pertama membuat alert tidak masuk retry. Pulihkan dari alert terbuka di DB (bukan hanya RAM), termasuk setelah restart.
4. P2 `panic-relay.service.ts:703`: event delivery menunggu timer RAM. Simpan transaksional, pulih setelah restart.
5. Q94: fallback alarm ke semua layar POS outlet tetap muncul bila 15 detik tanpa ACK manusia. Receipt otomatis ponsel TIDAK menghentikan fallback.

Founder: owner = manajer (terima alarm saat on duty, boleh tutup insiden di cloud); tutup insiden hanya OM/GM/owner di cloud.

## Aturan
- Hanya sentuh file panic/emergency terkait + test baru. Jangan ubah migrasi kecuali terpaksa (nomor baru 0403+, `db:generate` harus kosong setelahnya).
- Test gagal-dulu satu per butir, di `apps/api/src/test/panic-codex-fix.test.ts` (helper: `panic-test-helpers.ts`, pola: `panic-review-*.test.ts`, `panic-relay*.test.ts`).
- Jalankan test via `heavy env LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test` dari root worktree. HANYA test-runner/pemegang token heavy yang menjalankan vitest/tsc.

## Peta kode (hasil Explore, path relatif apps/api/src)
- Butir 1: `routes/emergency-cloud.routes.ts` ack handler :72-87 (route staf; test receiver ack di panic-review-c.test.ts:297 itu route LAIN). `refuseWhenEdgeServesOutlet(tenant, outletId)` di `services/panic-edge-ownership.ts:29` (409 EDGE_NODE_ACTIVE, dipanggil `await` paling awal). Resolve di route yang sama juga cloud-only; ack dan resolve keduanya wajib (cek: resolve di cloud untuk outlet ber-edge BOLEH, karena itu jalur tutup insiden cloud -> edge via outbox; jangan tolak resolve. Hanya ack).
- Butir 2: `services/panic-alert-outbox.ts` `activePanicEdgeNodeId` :47-65 (tertua), `queuePanicAlertResolvedToEdge` :195; dipanggil `panic-alert-cloud.service.ts` resolveEmergencyAlert ~:183 tanpa `row.originEdgeNodeId` (kolom `panic_alerts.origin_edge_node_id`, nullable). Target: origin node (bila ada) + node aktif tertua bila beda (failover); origin null: perilaku lama. Sequence per (edge_node_id, cloud_to_edge, aggregate).
- Butir 3: `services/panic-relay.service.ts` `fanOutAlert` :454, `sendFrame` :421, `sessionStillLive` :408, catch :465 return false -> `sub.alerts` tak terisi -> `resendDue` :549 (tiap 3 dtk lewat tick 500 ms di `edge/panic-relay-realtime.ts`, maks 10 menit) tak melihat. `sendOpenAlertsTo` :508 hanya saat socket baru. Perbaikan: resendDue juga memindai alert terbuka dari DB untuk sesi live (ack/resolved belum), tidak hanya `sub.alerts`.
- Butir 4: `scheduleDeliveredFlush` :703-722 (setTimeout 5 dtk, Map RAM `flushTimers`) -> `queueDelivered` -> `queuePanicAlertEvent` (outbox :110). Perbaikan: event delivered ditulis ke outbox dalam transaksi yang sama dengan `recordReceipt` :616 (dedupe/koalesen di DB), tanpa bergantung timer RAM.
- Butir 5: `scheduleFallback` :812, `markFallbackShown` :785, `readPanicFallback` :833, `recordReceipt` ~:698; tiga tempat memakai `isNull(firstDeliveredAt)` yang menekan fallback saat receipt otomatis ponsel. Ubah: satu-satunya penekan = ACK manusia (`acknowledgedAt`) atau resolved; buang kondisi `firstDeliveredAt` dari penekan fallback. Perbarui test lama yang mengasumsikan sebaliknya (EM-14 :1314 dll) sesuai Q94, dengan catatan di commit.
- Test helper: `test/panic-test-helpers.ts` (PANIC_FALLBACK_AFTER_MS :46, PANIC_FALLBACK_ROUTE :110, PANIC_RESEND_INTERVAL_MS :33, PANIC_FRAME_*, pressBody, sessionBody).
