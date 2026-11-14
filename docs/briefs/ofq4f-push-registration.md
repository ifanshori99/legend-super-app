# Brief legend-ofq4f — registrasi web push + X-Device-Token browser (P0, alarm panik)

Basis `10a196bc1` (cabang `ws/panic-push-registration`). Bukti basis: `docs/qa/782-panic-delivery.md`.

## Tujuan

1. Perangkat/browser petugas berwenang mendaftarkan subscription web push. Public key VAPID diambil dari API (endpoint baru, bukan `VITE_*`).
2. Header `X-Device-Token` dikirim browser (token perangkat tersimpan di perangkat setelah registrasi perangkat) dan diverifikasi server.
3. Subscription terikat user + tenant + outlet (+ perangkat bila ada). Dicabut saat logout / ganti akun / ganti PIN user.
4. Env baru: `NOTIFICATION_PUSH_PROVIDER`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` divalidasi di `apps/api/src/config/env.ts`, tertulis di `.env.example` + `docs/deployment.md`. Setup lokal boleh membuat kunci dev; jangan kunci produksi; jangan log kunci.
5. Migrasi bila perlu: nomor `0375`. FK tabel baru inline di CREATE TABLE. Tabel/migrasi baru diakui di `apps/api/src/test/data-import-registry.test.ts` dan tes cakupan schema.

## Keadaan basis (dari QA 782)

- Factory push produksi (`apps/api/src/worker/notification-adapters.ts`, `web-push-provider.ts`, `apps/api/src/lib/push-subscription.ts`) sudah bisa kirim dengan subscription tersegel (DATA_ENCRYPTION_KEY).
- Router registrasi subscription HTTP masih default-deny; endpoint public push-key belum ada.
- Browser belum punya penyedia header `X-Device-Token`; dialog registrasi perangkat tidak menyimpan token.
- Service worker: `apps/web/public/sw.js`.

## Aturan

- Router: `requireAuth`, `requireTrustedOrigin`, `jsonBody`, `requireTenantPermission`/`requireOutletPermission`. Service menerima userId terverifikasi; filter kepemilikan di SQL.
- Zod strict di `packages/shared/src/validators/`, DTO di `packages/shared/src/types/api.ts`. Teks UI lewat katalog i18n `packages/shared/src/i18n/messages/`.
- Tipe brand pakai helper konstruktor, bukan `as`.
- Jangan log endpoint/keys subscription, token perangkat, atau kunci VAPID.
- Test: API vitest di `apps/api/src/test/`, root di `tests/*.test.mjs`. Jalankan hanya `LEGEND_TEST_FILES="..." heavy pnpm test`.

## Peta (hasil Explore)

- Kontrak sudah ada: `packages/shared/src/notification/endpoints.ts` (`registerPushSubscription` POST `/api/notifications/push-subscriptions`, `getPushPublicKey` GET `/api/notifications/push-key` → `{vapidPublicKey|null}`, `removePushSubscription` DELETE `/:subscriptionId`), schemas `notification/schemas.ts:508`.
- API router `apps/api/src/routes/notification.routes.ts:84` `createNotificationRouter(ports?)` — dipasang tanpa ports di `routes/index.ts:254` → 403. Ports: `resolveScope`, `authorize`, `service` (`:51-62`). Service `services/notification-center.ts:393` registerPush (seal + upsert ON CONFLICT tenant,user,endpoint_hash), `:426` removePush.
- Tabel `push_subscriptions` `db/schema/notification.ts:182` (migrasi 0010, RLS). Tidak ada outlet/device/session.
- Seal: `lib/push-subscription.ts` (`seal(input, tenantId, userId)`, `openPushSubscription`, `pushEndpointHash`).
- Worker: `worker/notification-adapters.ts:196-205`, `:1295-1305` pilih by tenant+user, urut createdAt ASC, ambil `subscriptions[0]` (yang TERTUA). `worker/web-push-provider.ts:53-75`. Validasi env push di worker `notification-adapters.ts:1536-1562`.
- Device token: `lib/device-token.ts` (`verifyDeviceToken`), `routes/device-id.ts` (`registeredDeviceIdOf` null bila invalid; `currentDeviceIdOf` null bila header absen, 401 bila invalid), `services/device-registry-check.ts:38`. `devices` (`db/schema/device.ts:47`) punya tenantId, outletId, status, revokedAt, tokenIssuedAt. CORS sudah izinkan header (`app.ts:285`).
- Session Better Auth: tabel `session` (`db/schema/session.ts:35`, id text PK), tanpa secondaryStorage → signOut menghapus baris.
- Penerima panik: izin `facility.emergency.respond` (`packages/shared/src/facility/emergency.ts:48`) di scope outlet; cek di `services/panic-receiver-session.ts:290-316`.
- Web: `features/ws05-notifications/{api,push,mock}.ts`, `components/push-panel.tsx` (opt-in, simpan id hanya di mock). `lib/api/client.ts:55-110` apiFetch (header per-call di-allowlist; tambah helper seperti `bearerHeaderFor`). Dialog token `features/ws02-devices/components/device-token-dialog.tsx` (token tampil sekali, tak disimpan). Sign-out `components/sign-out-button.tsx:13-20`. Layer panik dipasang `routes/_ops/fasilitas.tsx:34-38`.
- Env: `config/env.ts` belum punya NOTIFICATION_*/VAPID. `.env.example:76-87`. `docs/deployment.md:564-566`. Secret lokal dibuat di `scripts/lib.mjs:76-80` (`prepareEnvironment`).
- Migrasi terakhir 0356 (journal idx 356). Kita pakai nama file `0375_push_subscription_scope.sql` (idx journal berikutnya; tag `0375_push_subscription_scope`). Migrasi tanpa INSERT/UPDATE/DELETE tidak perlu entri data-import-registry.

## Desain (keputusan engineer)

### D1 Skema (migrasi 0375, ALTER tabel lama)

`push_subscriptions` tambah: `outlet_id uuid NULL` (FK ke outlets, ikuti pola PK outlets), `device_id uuid NULL` (FK devices, pola PK devices), `session_id text NULL` FK `session(id) ON DELETE CASCADE`, `registered_at timestamptz NOT NULL DEFAULT now()` (diperbarui tiap upsert). Index (tenant_id, user_id, outlet_id). Baris lama (session_id NULL) TIDAK dipakai worker.

### D2 API registrasi

- Pasang ports produksi di `routes/index.ts`; route push hanya untuk user anggota tenant aktif.
- `GET /push-key`: `VAPID_PUBLIC_KEY` hanya bila `NOTIFICATION_PUSH_PROVIDER=web_push` dan policy tenant `webPushEnabled`; selain itu `null`.
- `POST /push-subscriptions`: bind `user_id`=session user, `tenant_id`=konteks, `session_id`=id sesi saat ini. Outlet: (a) header `X-Device-Token` → `currentDeviceIdOf` (invalid → 401); device harus aktif, tenant sama → `device_id`, `outlet_id`=device.outletId; body.outletId bila ada harus sama (beda → 403). (b) tanpa device: body `outletId` opsional baru; bila diisi, user wajib punya `facility.emergency.respond` di outlet itu (tidak → 403). (c) tanpa keduanya: outlet null (hanya notifikasi non-panik).
- Upsert memperbarui session_id/device_id/outlet_id/registered_at. Endpoint yang sama milik user LAIN di tenant yang sama dihapus (browser berganti akun).
- `DELETE /:id`: hanya milik user sendiri (lainnya 404).
- Jangan log endpoint/keys/token.

### D3 Worker

- Pilih subscription: tenant+user, `session_id` NOT NULL dan sesi masih ada & `expires_at > now()` & session.user_id = user; bila device_id tidak null, device aktif & tidak revoked. Untuk notifikasi panik (payload punya outlet), hanya `outlet_id` = outlet alarm. Kirim ke SEMUA subscription yang lolos bila model delivery memungkinkan; bila tidak, ambil `registered_at` TERBARU (bukan tertua).

### D4 Env

- `config/env.ts`: `NOTIFICATION_PUSH_PROVIDER` enum `disabled|web_push` default `disabled`; `VAPID_PUBLIC_KEY` (base64url, 65 byte, awal 0x04), `VAPID_PRIVATE_KEY` (base64url, 32 byte), `VAPID_SUBJECT` (`mailto:` atau `https:`). Wajib ketiganya bila web_push. Pesan error tidak memuat nilai kunci.
- `.env.example` + `docs/deployment.md`: cara buat kunci produksi di server (`npx web-push generate-vapid-keys`), jangan commit, rotasi = semua browser daftar ulang.
- `scripts/lib.mjs` setup lokal: bila VAPID belum ada, buat pasangan dev via `node:crypto` (ECDH prime256v1), `VAPID_SUBJECT=mailto:dev@localhost.invalid`? (pakai nilai yang lolos validasi web-push), `NOTIFICATION_PUSH_PROVIDER=web_push`. Pertahankan nilai yang sudah ada. Jangan cetak nilai.

### D5 Web

- `apps/web/src/lib/device-token-store.ts`: get/set/clear localStorage `legend.device.token` (try/catch, browser-only).
- apiFetch: browser kirim `X-Device-Token` bila tersimpan (bukan SSR).
- Dialog token perangkat: tombol "Pakai di perangkat ini" → simpan token (teks lewat katalog i18n).
- `pushSubscriptionInputSchema` tambah `outletId: outletIdSchema.optional()` (shared). Mock ws05 ikut.
- Simpan id subscription di localStorage `legend.push.subscriptionId` (bukan rahasia) saat daftar.
- Sign-out (`sign-out-button.tsx`): sebelum `authClient.signOut()`, best-effort DELETE subscription tersimpan + `unsubscribeThisBrowser()`, abaikan gagal, jangan tahan logout.
- `/fasilitas` (`routes/_ops/fasilitas.tsx`): kontrol ringkas "Aktifkan notifikasi alarm" bila push state `inactive` (pakai fungsi push.ts, kirim outletId outlet aktif); state lain tampil hint singkat. 44 px touch target.

## Pembagian (file tidak bertumpuk)

- **T test-writer**: `apps/api/src/test/push-registration.test.ts` (D2+D3: push-key null/terisi, 401/403 origin, bind user+tenant+session, X-Device-Token valid→device+outlet, invalid→401, device tenant lain ditolak, outletId tanpa `facility.emergency.respond`→403, endpoint sama user lain dihapus, hapus sesi→baris hilang via cascade, DELETE milik orang lain 404, worker hanya pilih subscription outlet alarm & sesi hidup & device aktif & yang terbaru), `apps/api/src/test/push-env.test.ts` (D4 env.ts), `tests/push-registration-web.test.mjs` (D5: apiFetch kirim X-Device-Token, dialog simpan token, sign-out cabut subscription sebelum signOut, kontrol fasilitas). Pakai helper/factory test yang ada, ID sesuai skema, brand pakai konstruktor. Gagal-dulu karena sebab benar (bukan setup/422). Hanya test-writer yang menjalankan vitest/tsc (pemegang token heavy) sampai engineer bilang lain.
- **A1 API registrasi** (D1+D2): `db/schema/notification.ts`, `apps/api/drizzle/0375_*` + `drizzle/meta/*`, `routes/notification.routes.ts`, `routes/index.ts`, `services/notification-center.ts` (+ file service baru bila perlu), `packages/shared/src/notification/schemas.ts` (outletId opsional). Pakai `env.NOTIFICATION_PUSH_PROVIDER`/`env.VAPID_PUBLIC_KEY` dari `config/env.ts` (ditambah A3).
- **A2 Worker** (D3): `worker/notification-adapters.ts`, `worker/web-push-provider.ts`. Asumsikan kolom Drizzle `outletId`, `deviceId`, `sessionId`, `registeredAt` di `pushSubscriptions` (A1 menambah).
- **A3 Env/setup/docs** (D4): `config/env.ts`, `.env.example`, `docs/deployment.md`, `scripts/lib.mjs` (+ `scripts/doctor.mjs` bila perlu). Nama key tetap persis.
- **A4 Web** (D5): `apps/web/src/lib/device-token-store.ts` (baru), `lib/api/client.ts`, `features/ws02-devices/components/device-token-dialog.tsx`, `features/ws05-notifications/*`, `components/sign-out-button.tsx`, `routes/_ops/fasilitas.tsx` (+ komponen baru di `features/facility-staff/components/`), katalog i18n `packages/shared/src/i18n/messages/*`.
- Implementer: JANGAN jalankan tsc/vitest/build (token heavy dipegang test-writer). Boleh `pnpm exec prettier --write` dan `pnpm exec eslint` pada file sendiri. Lapor: file berubah + keputusan + yang belum pasti.

## Tambahan: temuan architect 791 (`docs/briefs/791-panic-architect-findings.md`)

- Butir 1-2 = D2+D5 (sudah). Butir 1 juga: `startEmergencySessionCall` (`ws01-device-pin/api.ts:67`) harus membawa `X-Device-Token` lewat apiFetch (A4 pastikan jalur itu memakai apiFetch/helper header).
- **A2** juga butir 3 (kirim ke semua subscription lolos, batas 5, urut terbaru), 4 (tanpa konfigurasi push: in-app tetap dibuat, push dilewati + log error operator tanpa rahasia; event tidak ke dead-letter), 5 (gagal buka satu subscription: lewati, lanjut).
- **A5 Web gate** butir 6 (`apps/web/src/lib/areas/definitions.ts:100` pintu area ops memuat `facility.emergency.respond`), 7 (`ws01-device-pin/components/switch-user-screen.tsx:71`: setelah PIN kembali ke rute asal dengan search params asal, mis. `facilityId`; aman: hanya path internal).
- **T** tambah test gagal-dulu butir 3-7 (API worker di `apps/api/src/test/panic-push-fallback.test.ts` atau berkas baru `panic-push-fanout.test.ts`; web di `tests/panic-recovery-gate.test.mjs` atau berkas baru `tests/panic-architect-791.test.mjs`).

## Putaran architect xhigh atas diff (desain v2, wajib)

Temuan: P0 sesi staf idle 30 menit kedaluwarsa (`packages/shared/src/identity/limits.ts:61`) → worker (`expires_at > now`) berhenti kirim, dan FK CASCADE menghapus subscription saat baris sesi kedaluwarsa dihapus. Ponsel terkunci 30 menit = alarm tidak sampai.

### V1 Skema (edit 0375 di tempat, belum di-merge; regenerate snapshot)

- `session_id` FK `ON DELETE SET NULL` (bukan cascade).
- `registered_at timestamptz NULL` tanpa default: diisi registrasi v2 (`now()` tiap upsert). Baris lama tetap NULL = penanda legacy, tidak pernah dipakai worker.
- FK komposit pola proyek: `(tenant_id, outlet_id) → outlets(tenant_id, id)`; device: `(tenant_id, outlet_id, device_id) → devices(tenant_id, outlet_id, id)` (lihat `db/schema/device.ts:84-93`). Kolom lain tetap.

### V2 Pencabutan eksplisit (bukan lewat kedaluwarsa)

- `lib/auth.ts` databaseHooks `session.delete.before`: bila sebab BUKAN kedaluwarsa (pakai `endCause(ctx?.path, session.expiresAt, now)` yang sudah ada: `signed_out`/`revoked`), hapus `push_subscriptions WHERE session_id = session.id`. Gagal hapus → lempar (sign-out gagal, user ulang) — jangan sampai subscription selamat dari sign-out.
- `services/identity-session.service.ts` cabut sesi (set `revoked_at`): hapus push rows sesi itu dalam tx yang sama.

### V3 Worker (`worker/web-push-provider.ts` `deliverablePushSubscription` + lookup)

- Syarat: `registered_at IS NOT NULL AND registered_at > now() - interval '30 days'`; bila `session_id` tidak null, sesi itu `revoked_at IS NULL` (TANPA cek `expires_at`); bila session_id null (sesi kedaluwarsa & dihapus) tetap boleh. Device aktif tetap. Kelayakan penerima (izin, duty, aktif) tetap dicek `panicRecipientStillEligible`.
- Kirim paralel `Promise.allSettled` (bukan berurutan; satu endpoint hang tidak menahan lainnya).

### V4 Registrasi (`services/notification-center.ts`)

- Upsert: `outlet_id = COALESCE(EXCLUDED.outlet_id, push_subscriptions.outlet_id)`, sama untuk `device_id`; panel notifikasi tanpa outlet tidak menghapus outlet. Cek sesi registrasi tetap `expires_at > now AND revoked_at IS NULL` (sesi saat daftar harus hidup).

### V5 Kode error device (`routes/device-id.ts`, `lib/api/client.ts`)

- `DEVICE_TOKEN_INVALID` hanya bila token salah tanda tangan / kedaluwarsa / device dicabut atau tak dikenal. Tenant nonaktif atau edge tanpa identitas (`platform-tenant.service.ts:48-57`) tetap `UNAUTHORIZED` (token tidak dihapus).

### V6 Dokumen

- `docs/deployment.md` checklist rilis: `NOTIFICATION_PUSH_PROVIDER=web_push` + VAPID wajib sebelum alarm dinyatakan siap; default `disabled` hanya log error di worker.
- Catat: pencabutan saat ganti PIN tidak berlaku (push terikat sesi login, bukan PIN). Sisa risiko: sesi idle kedaluwarsa tanpa sign-out lalu user lain login di browser yang sama dan tidak membuka /fasilitas → alarm user lama (bila masih on duty & berwenang) tetap tampil sampai 30 hari / user baru mendaftar.

### Pembagian v2

- **F1 implementer opus**: V1+V2+V3+V4 (drizzle 0375 + meta snapshot via `pnpm db:generate` setelah hapus 0375 lama ATAU edit manual lalu `pnpm db:generate` harus kosong; schema/notification.ts; lib/auth.ts; identity-session.service.ts; web-push-provider.ts; notification-adapters.ts lookup bila ikut; notification-center.ts).
- **F2 implementer**: V5 + V6.
- **T2 test-writer**: gagal-dulu di pohon sekarang: sesi kedaluwarsa (tidak dicabut) tetap terkirim; sesi dicabut (revoked_at) dikecualikan; sign-out hapus push rows; revoke-sessions hapus; registered_at > 30 hari dikecualikan; legacy registered_at NULL dikecualikan; upsert tanpa outlet mempertahankan outlet; outlet tenant lain ditolak; pasangan VAPID tak cocok ditolak (push-env); web: client hapus token hanya pada `DEVICE_TOKEN_INVALID`; parallel send (satu endpoint hang tidak memblok, pakai fake send).

## Putaran 3 (reviewer v2 + test root)

- B1: revoke lewat UPDATE (`hris-offboarding.service.ts:747`, `identity-events.ts:130`, `control-plane-events.ts:186`) meninggalkan push rows; saat baris sesi kedaluwarsa dihapus, trigger melewatkannya → SET NULL → hidup lagi. Fix: trigger `IF OLD.revoked_at IS NOT NULL OR OLD.expires_at > now()`.
- B2: sesi impersonasi (support) bisa mendaftarkan push untuk user target. Fix: registerPush cek sesi `impersonated_by IS NULL`, selain itu 403.
- R1: `tests/panic-recovery-gate.test.mjs:190` butuh stub `@/features/facility-staff/components/panic-push-control`.
- R2: `tests/setup.test.mjs:68` "setup preserves an existing external database and credentials": setup sekarang menambah NOTIFICATION_PUSH_PROVIDER + VAPID (perilaku disengaja). Sesuaikan ekspektasi: nilai lama tetap sama persis, baris push baru ada dan valid.
