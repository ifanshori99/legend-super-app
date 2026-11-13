# Brief WS-03 QR order dan menu (engineer, cabang ws/qr-menu dari origin/milestone/m1)

Kartu: `bd show <id>` (jangan `bd update`).
1. legend-iuvq: consumer outbox cetak menu + sweep 30 detik di worker-main (`services/menu-print.service.ts`, MenuPdfRenderer 503 sampai mesin PDF dipilih; cek apakah mesin sudah dipilih di DECISIONS.md/PRD).
2. legend-arp35: `apps/web/src/features/ws03-qr-order` split-panel.tsx + mock-engine.ts masih mock; sambungkan ke POST /api/table-sessions/:sessionId/splits, POST /payments target split, GET /splits/:splitId/claim. Galat: SPLIT_LOCKED, NOTHING_TO_SPLIT. Q75: kode klaim di struk, bisa dibuka dari HP tamu 24 jam (backend legend-ia54l, jangan dobel).
3. legend-tct6: foto menu dari media library di kartu menu + item sheet QR. Foto kosong: bingkai netral, TANPA monogram/letter tile (DESIGN.md; abaikan monogram di mockup 25a434f3).
4. legend-8qri: tema tenant (D43), logo, zona waktu outlet di perjalanan QR (TableCustomerFrame) dari tenant config.

Batas: tanpa migrasi (butuh tabel: berhenti, lapor). Jangan sentuh alur QRIS hold/DP dan pembayaran. UI baru di luar mockup disetujui: lewati, laporkan.
Uang (split bill): jumlah semua bagian == total tagihan persis (tanpa lebih/kurang sepeser), test gagal-dulu.
Jangan menjalankan tsc/vitest/build kecuali token heavy (hanya test-runner). Lint+prettier file berubah di akhir.

## Hasil Explore (jangan jelajah ulang)
- iuvq: `services/menu-print.service.ts` (consumer :373, runDueMenuPrints :623, renderer null -> 503), `worker/menu-print.job.ts` (menuPrintOutboxDeliver :18, runMenuPrintSweepJob :24, interval 30s :14). worker-main.ts tak menyebut menu-print. Pola consumer: cabang else event ~worker-main.ts:283-330; sweep loop 30s pola refund ~805-830; storageRuntime :870 bisa null. Mesin PDF BELUM dipilih: renderer tetap null (503), JANGAN tambah dependency. Hanya sambungkan consumer + sweep (sweep hanya bila storageRuntime ada).
- tct6: DTO sudah punya photoUrl, tapi `routes/qr.routes.ts:42,59` memanggil `readQrMenu` tanpa resolver -> `noMediaUrls` (guest-menu.service.ts:668) -> photoUrl selalu null. Pasang `createMenuMediaUrls(storage)` (menu-media.service.ts:155, contoh menu.routes.ts:161); cek `public-site.routes.ts:15`. Web MediaPlate (components/ui/media-plate.tsx) sudah tanpa monogram.
- 8qri: menu QR sudah bawa outlet.timeZone; tema/logo belum. Tambah `theme: {tokens, fontFamily, corners, logoUrl} | null` (opsional) ke respons menu publik QR (isi dari tenant_themes aktif brand outlet; logoMediaId -> URL). Web: `components/table-frame.tsx` Frame/ThemeScope hardcode (theme-scope.tsx menerima prop tenant; contoh logo customer-shell.tsx:91-133). 4 fallback `?? "Asia/Jakarta"`: cart/checkout-page.tsx:420, item-card.tsx:72, item-sheet.tsx:167, menu/table-nota.tsx:52, plus DEFAULT_TIME_ZONE di bill-page.tsx:272, orders-page.tsx:4 -> satu helper `outletTimeZone(menu)`.
- arp35: klien web SUDAH pakai endpoint nyata (api.ts:118,163,177; hooks.ts:246,313; split-panel.tsx, split-claim.tsx); mock hanya bila VITE_API_MOCK=true (mock.ts, mock-engine.ts). Q75 backend sudah ada (GET /api/table-sessions/split-claims/current). Tugas: verifikasi apa yang benar-benar masih mock / salah kontrak (mis. galat SPLIT_LOCKED/NOTHING_TO_SPLIT dipetakan, payment target split + payerSecret + idempotencyKey, claim), betulkan celahnya; kalau sudah lengkap, laporkan.

## Pembagian file (tanpa tumpang tindih)
- A (iuvq): apps/api/src/worker/*, services/menu-print.service.ts (bila perlu), test baru.
- B (tct6 + 8qri API): routes/qr.routes.ts, routes/public-site.routes.ts, services/guest-menu.service.ts, packages/shared/src/qr-order/guest.ts (+ tipe), test baru.
- C (8qri web): apps/web/src/features/ws03-qr-order/components/{table-frame,item-card,item-sheet}.tsx, cart/checkout-page.tsx, menu/table-nota.tsx, bill-page.tsx, orders-page.tsx, helper baru lib/outlet-time-zone.ts. Bagian tema Frame: tunggu B (pakai `menu.theme` setelah B selesai; sebelum itu hanya zona waktu).
- D (arp35): split-panel.tsx, split-claim.tsx, api.ts, hooks.ts, mock*.ts di ws03-qr-order.
