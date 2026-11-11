# Design putaran 4 (legend-6c6) — keputusan engineer, kontrak antar subagent

Sumber tugas: `docs/briefs/480-doit-recurring-round4.md`. Cabang `ws/6c6-recurring-billing` @ b41cadd5. Tanpa migrasi (tidak ada perubahan skema). Jangan merge/deploy.

## Kepemilikan berkas (tidak boleh bertumpuk)

- S1: `apps/api/src/services/payment-recurring.service.ts` (butir 1, 2, 5, 7)
- S2: `apps/api/src/services/payment-webhook.service.ts`, `apps/api/src/routes/payment-webhook.routes.ts`, `apps/api/src/worker/payment-gateway-poll.job.ts` (butir 3, 4, 6 + panggil worker past_due)
- T (test-writer): hanya MENAMBAH test baru di `apps/api/src/test/payment-recurring-round4.test.ts` (berkas baru; fixture sendiri, integrasi sendiri, jangan ubah berkas test lain). ID REC-35..REC-4x.

## Kontrak ekspor baru (S1 menyediakan, S2 dan T memakai)

- `RECURRING_GRACE_DAYS = 3` (export const).
- `markOverdueSubscriptionsPastDue(context, now): Promise<number>` — ubah `active` -> `past_due` untuk langganan DOIT yang tagihan periodenya belum dibayar melewati tenggang. Idempoten (jalan dua kali = hasil sama, tanpa efek ganda). Mengembalikan jumlah baris berubah.
- `subscriptionHasAccess(sub, now)` sadar tenggang: akses hanya bila status `active` dan `current_period_start <= hari <= current_period_end` (batas akhir eksklusif seperti sebelumnya); `past_due`, `paused`, `cancelled`, `needs_reconcile`, `pending_first_payment`, `provisioning` = tanpa akses.
- Webhook: `WebhookResultStatus` mendapat nilai `"parked"`; route memetakan `"parked"` -> HTTP 200 `{received:true,status:"parked"}`; `"failed"` tetap 500.

## Butir 1 (P2) needs_reconcile bisa pause/resume/cancel bila `providerSubscriptionId` ada

- `changeSubscription`: dari `needs_reconcile` dengan provider id: pause/resume/cancel boleh. Jawaban DOIT tervalidasi (id + status) memakai aturan status normal (paused/active/cancelled) dan mengosongkan `reconcile_reason`. Jawaban tak cocok/ambigu = tetap `needs_reconcile`.
- Tanpa provider id: hanya cancel lokal seperti sekarang.
- Cek kunci-baru (CONFLICT bila ada baris belum selesai untuk tenant+plan+customer) tambah `isNull(providerSubscriptionId)`: baris mismatch yang punya id DOIT tidak memblokir kunci baru.

## Butir 2 (P3) start PLAN_MISMATCH menyimpan id langganan DOIT

- Simpan `providerSubscriptionId` bersama `status='needs_reconcile'`, `reconcile_reason='PLAN_MISMATCH'`. Event invoice untuk langganan itu masuk `needs_review` (SUBSCRIPTION_NEEDS_RECONCILE) — sudah jalur yang ada.

## Butir 5 (P3) retry start > 24 jam

- Retry otomatis intent `provisioning` yang lebih tua dari 24 jam (dihitung dari `created_at`) DITOLAK: baris -> `needs_reconcile` (reason `INTENT_EXPIRED`), tanpa panggilan DOIT, error ke pemanggil (CONFLICT/konflik status). Verifikasi reuse `reference` di sandbox = legend-s5c, di luar putaran.

## Butir 7 (legend-rsrcb, P1) active -> past_due setelah tenggang 3 hari

- Definisi final (PRD baris 861): tagihan `open` jatuh tempo = `period_start` periode berikutnya (`next_period_start` bila ada, else `current_period_end` karena akhir eksklusif). Tenggang berakhir `due + 3 hari`. Langganan `active` dengan tagihan `open` untuk periode yang `period_start <= hari` dan `hari > period_start + 3 hari` -> `past_due`. Hari ke-4 = past_due. Hari ke-3 = masih active. (Konkret: due D, D+3 masih active, D+4 past_due.)
- Pembayaran terlambat (`invoice.paid` untuk tagihan open/di-past_due): langganan -> `active` lagi, periode digeser sesuai tagihan, TANPA periode ganda (indeks unik parsial tetap), `grant` hanya bila period_end > hari.
- Akses: `subscriptionHasAccess` membaca `current_period_end` + status; status `past_due` = tanpa akses.
- Worker: poll job memanggil `markOverdueSubscriptionsPastDue` setelah `promoteDueSubscriptionPeriods` (best effort, try/catch; hasil dicatat di `PaymentGatewayPollResult.pastDue` — field baru).
- Keamanan uang: tidak pernah memberi akses lebih lama dari periode terbayar; tidak membuat tagihan/periode tambahan; ragu = batasi akses.

## Butir 3 (P3) created-before-paid lintas sweep

- `reprocessParkedRecurringEvents`: event parked (failed UNKNOWN_SUBSCRIPTION) yang langganannya kini ada di DB dilewati dari jeda backoff (diproses segera), urutan created sebelum paid dipertahankan.

## Butir 4 (P3) `received` tersangkut

- `reprocessStoredWebhookEvents` juga mengambil event `received` lebih tua dari ~5 menit, tanpa batas 24 jam (event recurring/invoice tersangkut tetap dicoba). Idempoten via dedupe yang ada.

## Butir 6 (legend-05am0) event subscription tak dikenal -> 200

- Event invoice dengan `subscription_id` tak dikenal: simpan durable (baris `failed`/UNKNOWN_SUBSCRIPTION seperti sekarang), hasil `"parked"` -> 200. Sweep memproses saat langganan lokal muncul. Test: event tak dikenal -> 200 + tersimpan + diproses setelah langganan ada.

## Bukti (lead)

Test gagal-dulu per butir, 7 berkas recurring + berkas baru hijau, eslint+prettier, typecheck api heap 6144, `db:generate` kosong, architect xhigh hanya diff butir 1 dan 7, commit+push.

## Putaran 4b: tenggang per outlet (keputusan founder W5, menggantikan konstanta akses)

Founder: ikuti PRD. Selama tenggang pelanggan tetap boleh memakai kuota langganan; lama tenggang per outlet (default 3 hari, boleh 0). `RECURRING_ACCESS_DURING_GRACE` DIHAPUS, diganti pengaturan outlet. Kuota langganan (`entitlement_ledger`, sourceType 'subscription') belum punya konsumen yang memanggil `subscriptionHasAccess` di cabang ini; kontrak di bawah menyediakan keputusan akses + periode kuota yang akan dipakai konsumen itu (FAC-07).

### Skema (migrasi sementara 0290 DIUBAH, bukan berkas baru; snapshot 0290 diadopsi ulang; `db:generate` harus kosong sesudahnya)
- Tabel `payment_recurring_outlet_settings` di `db/schema/payment-recurring.ts`: `tenant_id`, `outlet_id` (PK gabungan), `grace_days integer NOT NULL DEFAULT 3 CHECK (grace_days BETWEEN 0 AND 30)`, `created_at`, `updated_at`. FK gabungan ke outlet seperti tabel recurring lain; RLS/force RLS/kebijakan tenant seperti tabel recurring lain di migrasi 0285.

### Service (`payment-recurring.service.ts`, milik satu implementer)
- `RECURRING_GRACE_DAYS = 3` tetap sebagai default; hapus `RECURRING_ACCESS_DURING_GRACE`.
- `getRecurringGraceDays(context, outletId): Promise<number>` (tanpa baris = default 3). `setRecurringGraceDays(context, outletId, graceDays): Promise<number>` (bilangan bulat 0..30, selain itu CoreError validasi; upsert).
- `subscriptionHasAccess(sub, now, graceDays = RECURRING_GRACE_DAYS)`: status `active` DAN (hari di dalam periode berjalan, ATAU di dalam periode berikutnya yang terbayar, ATAU `graceDays > 0` dan `current_period_end <= hari < current_period_end + graceDays` dengan periode berikutnya belum menutup hari itu). Tenggang 0 = akses berhenti di akhir periode terbayar. `past_due`/`paused`/`cancelled`/lainnya = tanpa akses.
- `subscriptionAccessPeriod(sub, now, graceDays): { start: string; end: string | null; inGrace: boolean } | null` : null bila tanpa akses; di dalam periode terbayar = periode itu; di dalam tenggang = periode BERIKUTNYA `{start: current_period_end, end: next_period_end ?? null, inGrace: true}` (pemakaian tenggang dihitung ke kuota periode baru, tidak pernah ke periode lama dan tidak pernah membuka kuota tambahan).
- `markOverdueSubscriptionsPastDue`: ambang `grace_days` dibaca per outlet (subquery ke `payment_recurring_outlet_settings` pada tenant+outlet langganan, `COALESCE(..., 3)`), bukan konstanta. Tetap idempoten dan aman terhadap balapan.
- Semua pemanggil `subscriptionHasAccess` di service/DTO (mis. `getSubscription`) membaca grace outlet dan meneruskannya; DTO langganan ikut membawa `inGrace` bila sudah ada field akses.
- Bayar terlambat (sudah benar): `invoice.paid` periode yang mulai tepat di akhir periode lama -> `active`, tanpa periode ganda; `subscriptionAccessPeriod` untuk hari tenggang sebelum bayar dan hari sesudah bayar menunjuk periode baru yang sama (tidak ada kuota ganda).

### Rute + kontrak bersama
- `GET /payments/recurring/outlets/:outletId/grace` -> `{ graceDays }`; `PUT` body `{ graceDays }` strict zod (int 0..30) di `packages/shared` (ikuti pola validator + export subpath yang ada); izin sama dengan pengelolaan paket recurring di `payment-recurring.routes.ts` (requireTenantPermission/Outlet seperti rute plan).

### Test wajib (REC-44.., berkas `payment-recurring-round4.test.ts`, test-writer)
(a) tenggang 0: akses berhenti di akhir periode terbayar dan past_due hari D+1; (b) lewat tenggang tanpa bayar: `markOverdue...` -> past_due, `subscriptionHasAccess` false dan `subscriptionAccessPeriod` null (FAC-07); (c) pemakaian di hari tenggang menunjuk periode baru; setelah bayar terlambat tetap periode yang sama, hanya satu periode/tagihan, tidak ada kuota ganda; (d) dibatalkan atau tidak bayar: hari-hari sesudahnya `subscriptionAccessPeriod` null, tidak membuka periode berikut; plus: default 3 tanpa baris, set/get lewat service dan rute, nilai di luar 0..30 ditolak, isolasi tenant/outlet, per outlet berbeda memberi hasil berbeda untuk worker. Update REC-42 dan test akses lama yang memakai konstanta lama.
