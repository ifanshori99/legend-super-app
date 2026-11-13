# Brief: penguatan pembayaran (ws/payment-hardening)

Worktree: legend-3ac1a1ce, cabang kerja dari milestone/m1 (1202164d). Push ke origin sebagai ws/payment-hardening (hanya engineer-agent yang push).
Aturan: jangan merge ke m1, jangan deploy, jangan panggil DOIT/Brevo sungguhan. Jangan sentuh alur QRIS hold/DP (ws/qris-dp-hold) dan settlement recon. Jangan pkill.
Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree (path relatif ke apps/api). Hanya SATU subagent menjalankan tsc/vitest pada satu waktu.
Tipe brand (TenantId dst): pakai helper bertipe, bukan `as`.

## Kartu 1: legend-srf6 (K, uang+migrasi)

Indeks unik `gateway_webhook_events_event_key` sekarang (tenant, provider, eventId) -> pengirim pertama memiliki eventId. Keputusan CTO: sertakan identitas integrasi (`integration_id`) di indeks dedupe, tanpa menunggu DOIT. Butuh migrasi nomor 0482 (SQL; journal sesuai konvensi cabang lain, lihat catatan rentang). Dua integrasi dengan eventId sama tidak saling memblok; replay eventId sama pada integrasi sama tetap ditolak. Cek kode handler webhook yang memakai ON CONFLICT / pencarian dedupe agar targetnya ikut berubah.

## Kartu 2: legend-gjf1 (K, uang)

`voidUnpaidQrOrderTx` (apps/api/src/services/qr-order.service.ts ~1964-2490): saat pesanan belum lunas di-void (sweepUnpaidQrOrders / staf), intent QR parsial yang sudah settle (link.paidIdr < totalIdr; handler not_settled / amount_mismatch) tidak direfund. Fix: loop intent terbayar milik link, panggil `requestQrLatePaymentRefund` (qr-order-late-payment.ts) per intent. Tepat sekali, idempoten (void ulang tidak refund dobel). Bila perlu migrasi: 0483.

## Kartu 3: legend-j75w (S)

Alert berpembatas (throttled, mis. 1x/15 menit/tenant) untuk kegagalan auth Brevo berulang di apps/api/src/worker/notification-adapters.ts ke kanal ops (cari mekanisme alert ops yang sudah ada; jangan bikin kanal baru).

## Migrasi

Rentang 0482-0483 saja. `pnpm db:generate` harus kosong setelahnya (cek konvensi penomoran di worktree/cabang lain: apps/api/drizzle + meta/_journal.json).

## Test gagal-dulu (aturan uang founder)

- srf6: dua integrasi eventId sama tidak saling memblok; replay ditolak.
- gjf1: void pesanan dengan 2 intent QR terbayar -> 2 refund tepat sekali; void ulang tidak refund dobel; tidak ada pihak dibayar lebih, outlet tidak rugi.
- j75w: alert terkirim sekali dalam jendela, kegagalan berikut dalam jendela tidak mengirim ulang.

## Temuan architect (srf6 harus dibetulkan; gjf1 tanpa temuan)

1. NULL integration_id tidak dedupe di indeks baru. Tambah di 0482 SQL: `ALTER TABLE "gateway_webhook_events" ADD CONSTRAINT "gateway_webhook_events_verified_integration_check" CHECK (NOT "signature_valid" OR "integration_id" IS NOT NULL) NOT VALID;` + `check()` sama di schema payment-gateway-webhook.ts + snapshot 0482 (lihat cara snapshot lain mencatat checkConstraints). Aplikasi tidak pernah menulis NULL.
2. payment-webhook-rls.test.ts:48-50,228-236 menyimpan baris terverifikasi tanpa integration_id -> isi integration_id di insertSql.
3. payment-webhook-retry-integration.test.ts:478-669 (TEN-01) menguji perilaku lama (eventRow 1 baris, mismatchAudits 1, kasus pemilik-NULL :572-604). Tulis ulang: baris B tersimpan, intent tetap pending, paid_idr tak berubah, baris A utuh; kasus NULL -> database menolak baris terverifikasi tanpa integrasi.
4. payment-webhook.service.ts:1779-1796 (recordIntegrationMismatch) kini kode mati: hapus (atau jadikan assert) dan rapikan impor/test yang merujuknya.
