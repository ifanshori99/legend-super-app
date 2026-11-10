# Antrean second-opinion Codex (dipetakan 10 Nov 19:40)
Urutan: uang/pajak -> auth/akses -> migrasi -> data pribadi/offline. Satu run per akun bergantian.

| Area | Rentang | Berkas berisiko | Status |
|---|---|---|---|
| Charge kasir i83ls-fix | 5558eca2..3b3e2be3 | order-recovery-charge-pos.ts dll | selesai 367 (2 temuan, 44g8n) |
| Pajak r3i8w | dd4db5d2..feb4f6bb | accounting-tax-*.ts | selesai 368 (3 temuan, powk0) |
| Kasir aktif POS | 29ddcbf7..f609a047 | pos-acting-staff*.ts, middleware/acting-staff.ts | selesai 371 (4 temuan, 5u03q) |
| Refund recovery | b6a38096..b78f169c (ws/94q2l-impl) | order-recovery-refund.ts, order-recovery-refund-amount.ts, accounting-auto-journal-recovery-refund.ts, accounting-auto-journal-guards.ts, payment-refund.service.ts | selesai 372 (3 temuan, h1dyy) |
| Profit share | 7d388b02..0033ea1d (ws/8s992-profit-rules) | profit-share-distribution.service.ts, profit-share-registry.service.ts, accounting-profit-share.ts, profit-share-registry.routes.ts, profit-share-statement.service.ts | selesai 377+379 (5 temuan, 33im6) |
| Gateway Duitku | 83074382^..e77bf057 | payment-duitku-webhook.service.ts, payment-duitku.ts, platform-payment-gateway.service.ts, payment-gateway-select.ts, payment-routing.service.ts | selesai 374 (4 temuan, rgddb); ulang 406 (3 P1 + 2 P2, legend-s0u8c) |
| WS-03 split bill/table move | c6916247^..c6916247, dcd99cbc, 1ead4c4d, e4efc823 | bill-split.service.ts, table-session-operations.service.ts | split selesai 380 (3 temuan -> brief 366 ec6fa); pindah/gabung meja antre |
| Identity/member WS-08 | b428e1bc^..e15950fe, c129293e..6fb77d06 | loyalty-earn-consumer.ts, point-ledger.service.ts, consent.service.ts, pos-order-customer.service.ts, crm-ledger.ts, loyalty-program.service.ts | A selesai 383 (1 P1 expiry FIFO, w5by9); B jalan 411 (Codex #3) |
| HRIS attendance cloud | 17fd0206^..704ecc3d | hris-attendance*.service.ts, hris-attendance.ts, attendance-selfie-purge.job.ts, hris-attendance.routes.ts | antre |
| HRIS edge + PIN proof | 62ef1e11..092643e6 + j6cyb + u7g9w | edge-hris.ts, hris-attendance-qr.ts, selfie-seal.ts | selesai 382 (1 P2, sp9vq) |
| Pepper | d07b6cf8..3150feeb + jmsdx | staff-pin-pepper-*.ts, device-pin-pepper.ts, edge/runtime.ts | selesai 382 |
| Wi-Fi edge | e79e86a0^1..e79e86a0^2 + 8b57852f..52c7c7ef | wifi-*.ts, edge/wifi-quota-applier.ts | antre (ws09 lama 110) |
| w5by9 expiry FIFO loyalty (8f0b4630, d735d8b7) | Codex ulang area loyalty sebelum rilis | jalan 411 |
| vfj7z slot device + window per user (ws/jmsdx-pepper) | Codex area PIN | antre |
| profit share 33im6 fix (ws/8s992-profit-rules 54b76963, migrasi 0252) | Codex ulang area profit share sebelum rilis | antre |
| 3sy9b approval versi porsi saham (ws/3sy9b-share-alloc-approval 360491fa, migrasi 0256) | gabung area profit share | antre |
| owner tunggal self-approve (ws/owner-self-approve be5163bc, migrasi 0270) | gabung area profit share + approval | antre |
