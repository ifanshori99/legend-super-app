# E3b: gerbang tulis cloud yang belum lengkap (26 Nov, CTO)

Sesudah E3 digabung (int/rc2 4f4354c2b), grep menemukan route tulis POS operasional di cloud tanpa gerbang edge (`requirePosWriteOnCloud*` / `assert*NotOnEdge`). Outlet beredge: satu penulis = edge, cloud tulis = kas/struk dobel. Path relatif `apps/api/src/routes/`.

Cek satu per satu (baca handler; gerbang sesudah cek izin, outlet dari order/shift/tiket bila perlu):
- `pos-order.routes.ts:347, 488, 507, 528, 549, 611, 632` (7 POST)
- `pos-shift.routes.ts:181, 212, 231, 292`, `/day/close` :328
- `pos-order-customer.routes.ts:36`
- `pos-receipt.routes.ts:95, 153, 176`, `pos-receipt-writeoff.routes.ts:83`
- `pos-acting-staff.routes.ts:52, 84`
- `kds.routes.ts:121, 261, 276, 291, 312, 333, 357` (bukan konfigurasi stasiun 462-571)
- `order-recovery.routes.ts:72, 91, 153`, `order-recovery-charge.routes.ts:111-234`
- `table-links.routes.ts:38, 46`
Ragu (putuskan + tulis alasan): `qr-order.routes.ts` (E5 menangani outlet edge), `delivery-orders.routes.ts`, `apology-voucher.routes.ts:170`.

Sah di cloud (jangan digerbang): webhook gateway, back office (laporan, konfigurasi, akuntansi), endpoint ingest edge.
Catatan failover (kartu 1271 F3): gerbang akan lolos saat jendela failover `active`; buat satu helper agar F3 cukup mengubah satu tempat.

Bukti selesai: `pos-write-on-edge-gate.test.ts` memuat semua route di atas (409 untuk outlet beredge, lolos tanpa edge); daftar keputusan route ragu di commit message; pra-gate AGENTS.md.
