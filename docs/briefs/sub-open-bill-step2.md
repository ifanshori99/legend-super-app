# Sub-brief: open bill langkah 2 (legend-8cm4, legend-2zb5)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/open-bill-r1` (cabang `ws/open-bill-r1`, UI langkah 1 di `8c39264d`). Kerja HANYA di worktree ini. Jangan commit/push.
Baca: `AGENTS.md` (API/Web/Security), `docs/briefs/sub-open-bill-ui.md` (langkah 1).
Jangan sentuh: `pos-shift.service.ts`, modul refund, auto-journal, payroll, `edge/runtime.ts`, `worker-main.ts`. `routes/index.ts`: hanya satu baris pendaftaran router baru.

## Keputusan (final)
- Founder Q33/Q34 = A: tombol "Jadikan open bill" terlihat semua staf panel meja; hanya jalan dengan PIN supervisor ke atas. Tolak bila sisa tagihan (exposure) >= batas outlet. Field SLO minta tagihan disambungkan.
- PIN dicek per orang (pola `createPosOverride` di `services/staff-override.service.ts`): body membawa `approverUserId` + `pin`; `attemptStaffPin` (`services/device-pin.service.ts:357`) + `assertPinAttemptOk`, deviceId opsional (header device token bila valid, seperti override). Cek permission penyetuju SEBELUM PIN disentuh (percobaan tidak dihitung untuk yang tidak berhak).
- Penyetuju boleh sama dengan peminta (supervisor yang sedang login memasukkan PIN sendiri = step-up). Beda dengan AUTH-06 override; catat di komentar.
- Permission baru (`packages/shared/src/access/permissions.ts`):
  - `floor.session.open_bill`, tag `["approve"]`: penyetuju konversi. Diberikan ke template `owner`, `general_manager`, `outlet_manager`, `supervisor`. Tidak ke tenant_admin (tanpa wewenang keuangan), kasir, waiter.
  - `floor.open_bill_policy.manage`, tanpa tag: ubah kebijakan outlet. `owner`, `general_manager`, `outlet_manager`.
- Kontrak (`packages/shared/src/qr-order/open-bill.ts` + `endpoints.ts`, draf langkah 1 sudah ada):
  - `convertSessionToOpenBillInputSchema` = strictObject `{ reason: trim 3..300, approverUserId: userIdSchema, pin: <skema PIN staf yang ada> }`.
  - `openBillApproverSchema` = `{ userId, displayName }`; endpoint `listOpenBillApprovers`: GET `/api/outlets/:outletId/open-bill/approvers` → `{ data: OpenBillApprover[] }` (staf yang memegang `floor.session.open_bill` di outlet itu DAN punya PIN staf aktif; urut nama).
  - `getOpenBillPolicy` GET `/api/outlets/:outletId/open-bill-policy`: boleh untuk pemegang `floor.table.operate` ATAU `floor.open_bill_policy.manage` di outlet itu.
  - `updateOpenBillPolicy` PUT sama path: `floor.open_bill_policy.manage`; memanggil `upsertOpenBillPolicy`.
  - `convertSessionToOpenBill` POST `/api/table-sessions/:sessionId/open-bill`: peminta butuh `floor.table.operate` di outlet sesi (pola `resolveFloorContext` di `routes/table-sessions.routes.ts`).
  - Error: `OPEN_BILL_CONVERT_LIMIT` 409, `OPEN_BILL_NOT_ELIGIBLE` 409, `OPEN_BILL_APPROVER_DENIED` 403 (penyetuju tidak memegang permission di outlet). PIN salah/terkunci memakai kode PIN yang sudah ada dari `assertPinAttemptOk`. Hapus `OPEN_BILL_PIN_REJECTED` draf.
- Konversi (service `convertSessionToOpenBill` di `services/open-bill-control.service.ts`):
  1. Cek penyetuju memegang `floor.session.open_bill` di outlet sesi (tanpa sentuh PIN) → `OPEN_BILL_APPROVER_DENIED`.
  2. `attemptStaffPin` → `assertPinAttemptOk`.
  3. Dalam `withTenant` tx: kunci sesi `FOR UPDATE`; harus berjalan (bukan pending/closed) dan `payment_mode = 'pay_first'` → selain itu `OPEN_BILL_NOT_ELIGIBLE`. Exposure dihitung sama seperti `assertOpenBillWithinLimit` (`unpaidExposureOfSession` dkk.); exposure >= `maxBillValueIdr` → `OPEN_BILL_CONVERT_LIMIT`. Update `payment_mode = 'open_bill'` (dan `last_activity_at` bila pola sesi lain melakukannya).
  4. `recordAudit` action `open_bill.session_converted`, actor = penyetuju, berisi requester, approver, reason, deviceId, before/after paymentMode, exposureIdr, limitIdr. Tanpa PIN di log/audit.
  - Tidak perlu migrasi (CHECK `payment_mode` sudah mengizinkan keduanya). Bila ternyata perlu, hentikan dan lapor.
- SLO: `sweepOverdueServiceRequests` (`services/service-request.service.ts:689`) memakai `billRequestSloSeconds` kebijakan outlet (default 180 bila tidak ada baris) untuk `type = 'request_bill'`; tipe lain tetap `thresholdSeconds`. Satu query (left join `outlet_open_bill_policies`), tanpa N+1. Perbarui komentar di `open-bill.ts` yang bilang sweep belum membacanya.

## Potongan (satu subagent per potongan, file tidak bertumpuk)
- **S1 shared (implementer):** `open-bill.ts`, `endpoints.ts`, `access/permissions.ts`, `access/roles.ts`, label permission di i18n bila test mewajibkan (`tests/access-i18n.test.mjs`, `tests/access-contract.test.mjs`), dan perbaikan test root yang wajib berubah karena katalog. Bukti: `node --test tests/access-*.test.mjs` lulus.
- **S2 API konversi + kebijakan (implementer):** `services/open-bill-control.service.ts` (`convertSessionToOpenBill`, `listOpenBillApprovers`), `routes/open-bill.routes.ts` baru (policy GET/PUT, approvers GET, convert POST; atau convert di `table-sessions.routes.ts` bila lebih rapi), satu baris di `routes/index.ts`, pemetaan kode error ke HTTP (ikuti pola `openBillErrorHttpStatus`). Middleware: `requireAuth`, `requireTrustedOrigin`, `requireTenantContext`, `jsonBody` untuk POST/PUT, cek permission per outlet.
- **S3 API SLO (implementer):** hanya `services/service-request.service.ts` sweep.
- **S4 web (implementer):** `apps/web/src/features/open-bill/*` (api/queries/hooks/mock/lib: approvers + body baru + pemetaan kode PIN yang ada ke `openBillConvert.error.pin`, kode terkunci ke pesan terkunci), `convert-open-bill-dialog.tsx` (select "Supervisor penyetuju" di `details`, pilihan pertama terpilih; daftar kosong → pesan "Belum ada supervisor dengan PIN di outlet ini. Minta manajer mengatur PIN supervisor." tanpa PIN pad), teks di `open-bill-convert.ts`, guard route `kelola.pengaturan_.open-bill.tsx` dan kartu hub (`settings-hub-page.tsx`) ke `floor.open_bill_policy.manage`, spec `e2e/legend-8cm4-open-bill.mock.spec.ts` bila alur berubah (pilih penyetuju). Mock: penyetuju contoh 2 orang, PIN `123456` benar.
- **T1 test API konversi/kebijakan (test-writer):** `apps/api/src/test/open-bill-convert.test.ts` baru. Pola: `ws03-open-bill.test.ts`, helper `floor-test-helpers.ts` (`staffWithRole`, `createIsolatedTenant`, `staffOfIsolatedTenant`), seed PIN seperti `edge-access-applier.test.ts:262`, isolasi seperti `service-request-api.test.ts:407-440`. Kasus minimal: kasir peminta + supervisor penyetuju PIN benar → 200 dan sesi open_bill + audit; penyetuju kasir → 403 `OPEN_BILL_APPROVER_DENIED` tanpa percobaan PIN terhitung; PIN salah → ditolak dan dihitung; exposure >= batas → 409; sudah open_bill / pending / closed → 409; staf outlet lain → 403; tenant lain → 404; approvers hanya pemegang permission + PIN di outlet itu; policy PUT outlet_manager 200, supervisor 403, kasir 403; policy GET kasir (operate) 200, outlet lain 403; validasi body (alasan pendek) 400.
- **T2 test SLO (test-writer):** tambah ke `apps/api/src/test/service-request-api.test.ts` atau file baru `service-request-open-bill-slo.test.ts`: request_bill dengan kebijakan 60 s terlambat setelah 60 s; call_waiter tetap 180 s; outlet tanpa kebijakan pakai 180 s; outlet lain tidak saling memengaruhi.

## Bukti per potongan
- eslint + prettier bersih untuk file berubah. Test terarah: `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` dari root worktree (hanya file potonganmu). Jangan jalankan tsc/build/e2e/suite penuh (agent induk lewat `heavy`).
- Lapor: file berubah, keputusan kecil, yang belum.

## Potongan S5: migrasi backfill permission (implementer)
Role per tenant disimpan di DB, jadi tenant lama butuh backfill untuk `floor.session.open_bill` (owner, general_manager, outlet_manager, supervisor) dan `floor.open_bill_policy.manage` (owner, general_manager, outlet_manager). Ikuti persis pola `apps/api/drizzle/0120_ws03_roles_zone_manage.sql` (cara dibuat: lihat journal `apps/api/drizzle/meta/_journal.json` dan cara migrasi custom lain dibuat; nomor berikutnya setelah migrasi terakhir di cabang). Idempoten, hanya baris role template yang relevan, tidak mengubah role kustom kecuali pola 0120 melakukannya. Bukti: `pnpm db:generate` setelahnya kosong (tanpa diff skema), dan test terarah migrasi/role bila ada (cari test yang menyebut 0120). Lapor nomor migrasi + `when` di journal.
