# Brief subagent: legend-u7g9w bukti PIN absen outlet_device

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/u7g9w-pin-proof` (cabang `ws/u7g9w-pin-proof`, basis j6cyb d0376c66).
Keputusan lengkap: `bd show legend-u7g9w` dan scratchpad `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/6a8e6daa-2971-43d1-b254-b9a971dcda14/scratchpad/DECISIONS.md` baris 6-137. Baca keduanya dulu.

Aturan umum: hanya file di potonganmu. Jangan jalankan test/typecheck/build (engineer yang menggabungkan menjalankannya lewat `heavy`). Jangan commit. Edit pakai tool Edit/Write. Kode dan komentar bahasa Inggris, pesan error untuk user bahasa Indonesia seperti kode sekitar. Laporan akhir: file berubah, fungsi yang diekspor, keputusan kecil yang kamu ambil, hal yang belum yakin.

## Kontrak bersama (semua potongan memakai nama ini persis)

`apps/api/src/services/staff-pin-proof.service.ts` (potongan A) mengekspor:

```ts
export const PIN_PROOF_HEADER = "X-Pin-Proof";
export const PIN_PROOF_TTL_MS = 120_000;
export const PIN_PROOF_PURPOSE = "attendance_clock";
export type StaffPinProofRow = {
  id: string;
  tenantId: string;
  outletId: string;
  deviceId: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};
/** Any state (used, expired, superseded). Lookup by sha256(token) AND device_id. null = unknown. */
export function findPinProof(
  tx: Tx,
  input: { tenantId: string; deviceId: string; token: string },
): Promise<StaffPinProofRow | null>;
/** UPDATE staff_pin_proofs SET consumed_at = now WHERE token_hash=$h AND device_id=$d AND consumed_at IS NULL AND expires_at > now RETURNING *. null = not consumable. */
export function consumePinProof(
  tx: Tx,
  input: { tenantId: string; deviceId: string; token: string; now: Date },
): Promise<StaffPinProofRow | null>;
/** Same conditions as consume but read-only. Throws HttpError 401 PIN_PROOF_INVALID when unknown/expired/superseded/other device, HttpError 401 PIN_PROOF_INVALID also when already consumed (upload with used proof -> 401). */
export function assertLivePinProof(
  tx: Tx,
  input: { tenantId: string; deviceId: string; token: string; now: Date },
): Promise<StaffPinProofRow>;
```

`apps/api/src/services/hris-attendance-eligibility.ts` (potongan B, file baru) mengekspor:

```ts
/** Active (or onboarding) employee holding self.attendance.clock (loadHrisAccess) for an outlet-scoped context. Throws HttpError 403 ATTENDANCE_NOT_ALLOWED otherwise. Runs inside the caller's tx. */
export function assertAttendanceClockAllowed(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  now: Date,
): Promise<{ employeeId: string }>;
```

Logika = fase 1 `clockAttendance` di `hris-attendance.service.ts` (~baris 930-945).

Kode error baru (status HTTP): `PIN_PROOF_INVALID` 401, `PIN_PROOF_USED` 409, `PIN_DEVICE_THROTTLED` 429 (+ header `Retry-After` detik), `ATTENDANCE_NOT_ALLOWED` 403, `SELFIE_NOT_FROM_PROOF` 400, `ATTENDANCE_METHOD_USE_OUTLET_CLOCK` 400. Dilempar sebagai `HttpError(status, code, message)` (lihat `EDGE_SELFIE_ERROR_CODES` untuk pola). Kode bukti/throttle didaftarkan di `packages/shared/src/identity/errors.ts` (A); kode absen di `packages/shared/src/hris/` (B, ikuti tempat `EDGE_SELFIE_ERROR_CODES`).

Header: `X-Device-Token` (konstanta `DEVICE_TOKEN_HEADER` yang ada) dan `X-Pin-Proof`.

## Potongan A: migrasi, bukti, throttle, verify (implementer A)

File: `apps/api/drizzle/0241_staff_pin_proofs.sql`, `apps/api/drizzle/meta/_journal.json` (entri idx 241, tag `0241_staff_pin_proofs`, when > 1794320000000), `apps/api/drizzle/meta/0241_snapshot.json` (salin 0233 lalu tambah; atau `pnpm --filter @starter/api exec drizzle-kit generate` bila jalan tanpa DB, lalu ganti nama ke 0241), `apps/api/src/db/schema/staff-pin-proof.ts` (baru, daftarkan di `schema/index.ts`), `apps/api/src/db/schema/core-storage.ts` (kolom `pinProofId`), `apps/api/src/services/staff-pin-proof.service.ts` (baru), `apps/api/src/routes/device-pin.routes.ts` (hanya handler `/verify`), `packages/shared/src/access/override.ts` (`verifyStaffPinForUserSchema` + `purpose` opsional `"attendance_clock"`), `packages/shared/src/identity/schemas.ts` (`staffPinSwitchSchema` + `proof?: {token, expiresAt}`), `packages/shared/src/identity/errors.ts`, housekeeping edge (hapus bukti > 1 hari) bila ada job housekeeping edge yang jelas tempatnya (grep `housekeeping` di `apps/api/src/edge`), bila tidak ada: lapor saja.

- Migrasi 0241: `staff_pin_proofs` (id uuid pk default gen, tenant_id, outlet_id, device_id, user_id, purpose varchar CHECK = 'attendance_clock', token_hash bytea NOT NULL UNIQUE, expires_at, consumed_at null, created_at default now). FK inline ke outlets(tenant_id,id), devices (cek nama tabel + kunci device di `src/db/schema`), user. `device_pin_throttle` (tenant_id, device_id, window_started_at, failures int, PK (tenant_id, device_id), FK device ON DELETE CASCADE). `core_storage_objects.pin_proof_id` uuid nullable FK -> staff_pin_proofs(id) ON DELETE SET NULL. Index (tenant_id, device_id) di proofs. RLS: `SELECT app.enforce_tenant_rls(...)` + `app.enforce_outlet_rls(...)` untuk proofs, tenant saja untuk throttle (pola `0227_hris_edge_replication.sql:84`). Migrator non-superuser: bila ALTER `core_storage_objects` butuh validasi FK lintas tabel FORCE RLS, pakai pola NO FORCE/FORCE (lihat `0159_notification_policy_permission.sql`). Schema Drizzle cocok dengan SQL.
- Bukti: 32 byte acak `randomBytes`, base64url, prefix `pp_`; simpan `sha256(token)` bytea. TTL 120 s. Terbit baru: dalam tx yang sama `UPDATE staff_pin_proofs SET expires_at = now WHERE tenant_id, device_id, consumed_at IS NULL AND expires_at > now` lalu insert.
- Throttle (semua `/api/staff-pins/verify`, dengan atau tanpa purpose): sebelum apa pun, baca baris device; bila jendela (window_started_at + 5 menit) masih berjalan dan failures >= 10 -> 429 `PIN_DEVICE_THROTTLED` + `Retry-After` = ceil(sisa detik); tidak memanggil verify (tidak menambah failed_attempts staf). PIN salah (verify melempar `IdentityError` `PIN_INVALID`): upsert atomik `INSERT ... ON CONFLICT (tenant_id, device_id) DO UPDATE SET failures = CASE WHEN window habis THEN 1 ELSE failures+1 END, window_started_at = CASE WHEN window habis THEN now ELSE lama END RETURNING failures`; tx terpisah dari verify (verify sudah commit). Tepat saat failures menjadi 10: satu `recordAudit` action `staff_pin.device_throttled` (actorType device, pola `device-pin.service.ts` ~447) + satu `notifyOutletSupervisors` (`services/edge-sync-conflict-alert.ts:150`; tambah jenis alert bila perlu, file itu boleh disentuh minimal). Permintaan ke-10 sendiri tetap 401 PIN_INVALID; mulai permintaan ke-11 dalam jendela: 429. Hanya device itu.
- `/verify` dengan `purpose: "attendance_clock"`: setelah cek throttle, SEBELUM PIN dicek: `assertAttendanceClockAllowed` (dari potongan B) dengan context outlet device (`deviceOutletResolver` / `outletContext`) -> 403. PIN benar -> terbitkan bukti, respons `{data: {...switchLama, proof: {token, expiresAt}}}`. Tanpa purpose: respons persis seperti sekarang. Jangan mengubah `verifyStaffPinOnDevice` atau `attemptStaffPin` di `device-pin.service.ts` (kartu lain menyentuhnya); bungkus dari service baru.

## Potongan B: route outlet-clock, /clock 400, eligibility, edge allowlist, CORS, kontrak hris (implementer B)

File: `apps/api/src/services/hris-attendance-eligibility.ts` (baru), `apps/api/src/services/hris-attendance.service.ts`, `apps/api/src/routes/hris-attendance.routes.ts` (atau router baru `routes/hris-outlet-clock.routes.ts`), `apps/api/src/app.ts` (CORS `allowedHeaders` + `X-Device-Token`, `X-Pin-Proof` di ~242; mount router tanpa sesi bila perlu), `apps/api/src/edge/mode.ts` (`EDGE_API_EXACT_ROUTES` + `POST /api/hris/attendance/outlet-clock`), `packages/shared/src/hris/endpoints.ts` (+ file kode error hris), dan `apps/api/src/test/edge-attendance-clock.test.ts` (pindahkan test outlet_device lama ke route baru: tiap test sekarang ambil bukti lewat `/api/staff-pins/verify` purpose attendance_clock dulu; tambah satu test `/clock` method outlet_device -> 400 ATTENDANCE_METHOD_USE_OUTLET_CLOCK).

- `POST /api/hris/attendance/clock` method `outlet_device` -> 400 `ATTENDANCE_METHOD_USE_OUTLET_CLOCK` (cloud dan edge). Edge dengan method lain tetap 400 `ATTENDANCE_METHOD_NOT_ON_EDGE`.
- `POST /api/hris/attendance/outlet-clock`: TANPA requireAuth/sesi, tanpa `requireBackOfficeSurface`; tetap `requireTenantContext` (device token memberi tenant, lihat `device-pin.routes.ts` `deviceIdOf`) dan `jsonBody`. Body strict `{type, occurredAt, photoUploadRef, idempotencyKey}` (tanpa userId/method). Cloud (bukan edge mode) -> 400 seperti sekarang ("belum tersedia"). Header `X-Pin-Proof` kosong -> 401 PIN_PROOF_INVALID.
- Service baru `outletClockAttendance(context, deviceToken, proofToken, body, now, signer)` di `hris-attendance.service.ts`, menggunakan ulang `resolveEdgeClockDevice`, `storeAttendanceLog`, `linkStorageObjectSource`, `enqueueEdgeSelfieUpload`, method `outlet_device`. Urutan dalam SATU `withTenant(outletScoped(device.outletId))`:
  1. `findPinProof` (device dari token) -> null: 401 PIN_PROOF_INVALID. userId = proof.userId.
  2. `assertAttendanceClockAllowed(tx, scoped, proof.userId, now)` -> employeeId.
  3. Log dengan `clientEventId = idempotencyKey`: bila ada dan employeeId sama dan type sama dan `edge device` sama -> 200 log lama (tanpa konsumsi). Bila ada tapi milik staf lain/type lain -> `IDEMPOTENCY_KEY_REUSED` seperti sekarang (tidak membuka log).
  4. `consumePinProof` -> null: bila `proof.consumedAt !== null` -> 409 PIN_PROOF_USED, selain itu 401 PIN_PROOF_INVALID.
  5. Selfie: `photoUploadRef` null + policy requireSelfie -> `EdgeSelfieMissingError` (422 seperti sekarang). Ada: baca `core_storage_objects.pin_proof_id`; bukan `proof.id` -> 400 SELFIE_NOT_FROM_PROOF; lalu `assertSelfieUsable(..., proof.userId, ...)`.
  6. Insert log + link selfie + enqueue, sama seperti cabang edge `clockAttendance` sekarang. Respons + 422 rejected sama dengan route `/clock`.
     Logika edge `outlet_device` lama di `clockAttendance` dihapus (sudah 400).
- Staf `mfa_required` tidak dicek MFA di route ini (tidak ada sesi).

## Potongan C: unggah selfie dengan bukti (implementer C)

File: `apps/api/src/routes/storage-api.routes.ts`, `apps/api/src/services/edge-selfie.service.ts`, `apps/api/src/services/core-storage.ts` (hanya bila perlu meneruskan `pinProofId`), `apps/api/src/app.ts` HANYA bila mount storage harus berubah (koordinasi: B juga menyentuh app.ts, jadi tulis perubahan app.ts-mu sebagai saran di laporan, jangan edit), `apps/api/src/test/edge-storage-upload-http.test.ts` (test lama tetap jalan; tambah test jalur bukti).

- `POST /api/storage/uploads` di edge: bila header `X-Pin-Proof` ada -> jalur bukti TANPA sesi: device dari `X-Device-Token` (tenant cocok, device aktif di registry seperti `resolveEdgeClockDevice`; boleh ekspor helper dari `hris-attendance.service.ts`? JANGAN edit file itu, B memilikinya; tulis helper verifikasi device sendiri atau pakai `findActiveDeviceForToken` langsung), `assertLivePinProof` (tidak dikonsumsi), `owner_user_id = proof.userId` (abaikan apa pun dari klien), `pin_proof_id = proof.id`, outlet = outlet device, purpose hanya `selfie`. Tanpa header bukti: perilaku lama (sesi).
- Bukti terpakai/kedaluwarsa/diakhiri/device lain -> 401 PIN_PROOF_INVALID.

## Potongan T: test penerimaan (test-writer)

File baru saja: `apps/api/src/test/edge-pin-proof.test.ts` (dan bila perlu `apps/api/src/test/pin-proof-cors.test.ts`). Pola seed: `apps/api/src/test/edge-attendance-clock.test.ts` (`beforeAll` ~425, edge mode, `enrollDevice`, `edge_people_sync_state`) dan `apps/api/src/test/device-pin-service.test.ts` (`enrolledDeviceToken` :73, `staffWithPin`). Satu `it` per kriteria kartu (a)-(k) + (i) CORS, nama test diawali ID kriteria, mis. `"(c) proof used twice -> 409 PIN_PROOF_USED; same idempotencyKey -> 200 old log"`. Pakai kontrak di atas (route, header, kode, 429 setelah 10 salah mulai permintaan ke-11, `Retry-After`). (a): sesi cookie kasir A dikirim bersama + bukti PIN staf B -> log `employeeId` milik B. (e) bukti pertama setelah terbit kedua -> 401. (f) audit `staff_pin.device_throttled` satu baris, notifikasi satu, `staff_pins.failed_attempts` tidak bertambah oleh permintaan 429, device lain di outlet sama tetap 200/401 biasa. (g) staf peran mfa_required: verify + upload + outlet-clock sukses; GET `/api/hris/attendance/logs` dengan header bukti saja -> 401. (h) selfie dari bukti lain -> 400 SELFIE_NOT_FROM_PROOF; unggah dengan bukti terpakai -> 401; `owner_user_id` = staf bukti. (j) user tanpa izin/bukan karyawan aktif + PIN apa pun -> 403 ATTENDANCE_NOT_ALLOWED dan `failed_attempts` tidak bertambah. (k) bukti staf A + idempotencyKey log staf B -> bukan 200 log B. (i) `OPTIONS` preflight dengan `Access-Control-Request-Headers: x-device-token,x-pin-proof` dari origin terpercaya -> header diizinkan. Kedaluwarsa: pakai `vi.setSystemTime`/`now` injeksi atau update `expires_at` langsung di DB. Test harus gagal di basis (route belum ada) dan lulus setelah implementasi.
