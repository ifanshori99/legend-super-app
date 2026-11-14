# 806 Perbaikan second opinion alarm panik (tingkat K)

Sumber temuan: `docs/qa/second-opinion-alarm-panik.md` (P0-1..P0-4, P1-1..P1-3). Basis `e241e9476` (cabang `ws/panic-push-registration`, migrasi 0375). Desain sebelumnya: `docs/briefs/ofq4f-push-registration.md` (V1-V6, B1-B2).

Prinsip: alarm lebih baik terkirim dua kali daripada tidak sampai; tidak boleh sampai ke akun/tenant/outlet yang salah. Batas langganan tidak boleh menyingkirkan HP petugas yang jaga. Migrasi baru bila perlu: `0379_*`.

Jangan sentuh: edge, DOIT, payout, HRIS, pemindai. Jangan jalankan test/tsc/vitest kecuali brief bagianmu meminta (satu token heavy per thread; engineer yang menjalankan).

## Area

- A dispatch/retry (P0-1, P0-2): `apps/api/src/worker/web-push-provider.ts`, `apps/api/src/services/notification-delivery.ts`, `apps/api/src/worker/notification-adapters.ts` (lookup ~1300-1330). Test: `apps/api/src/test/panic-push-fanout.test.ts`.
- B registrasi/auth/migrasi (P1-1, P1-2, P1-3): `apps/api/src/services/notification-center.ts` (~470-500), `apps/api/src/db/schema/notification.ts` (~190-225), `apps/api/drizzle/0375_push_subscription_scope.sql`, `apps/api/src/lib/auth.ts` (~553), `apps/api/src/services/identity-session.service.ts`, `apps/api/src/services/device.service.ts` (~355), `apps/api/src/services/device-registry-check.ts`. Test: `apps/api/src/test/push-registration.test.ts`.
- C web (P0-3, P0-4): `apps/web/src/features/ws05-notifications/{revoke,push}.ts`, `apps/web/src/components/sign-out-button.tsx`, `apps/web/src/features/facility-staff/components/panic-push-control.tsx`. Test: `tests/push-registration-web.test.mjs`.

## Desain (diputuskan engineer, ikuti persis)

Migrasi `apps/api/drizzle/0379_panic_push_second_opinion.sql` (pemilik: I2). Isi:

- `delivery_attempts.delivered_push_subscription_ids uuid[] NOT NULL DEFAULT '{}'` (P0-1).
- `push_subscriptions.device_token_issued_at timestamptz NULL` (P1-2).
- `app.claim_push_endpoint(p_tenant uuid, p_user uuid, p_endpoint_hash text)` SECURITY DEFINER (pola `app.delete_session_push_subscriptions` di 0375, grant sama): `pg_advisory_xact_lock(hashtextextended('push-endpoint:'||p_endpoint_hash,0))`, lalu `DELETE FROM push_subscriptions WHERE endpoint_hash=p_endpoint_hash AND NOT (tenant_id=p_tenant AND user_id=p_user)` (lintas tenant, sempit: hanya endpoint yang pemanggil buktikan punya) (P1-3).
- `app.delete_user_push_subscriptions(p_user uuid, p_keep_session text)` SECURITY DEFINER: `DELETE FROM push_subscriptions WHERE user_id=p_user AND (p_keep_session IS NULL OR session_id IS DISTINCT FROM p_keep_session)` (P1-1).
- Schema Drizzle di `db/schema/notification.ts` ikut; `pnpm db:generate` lalu tempel function SQL ke migrasi yang dibuat, ubah nama berkas+journal ke 0379; `pnpm db:generate` kedua harus kosong. Akui migrasi di `apps/api/src/test/data-import-registry.test.ts` bila test itu mendaftar migrasi/kolom.

### P0-1 (I1, `worker/web-push-provider.ts`)

Provider: setelah memilih target, buang target yang id-nya ada di `delivery_attempts.delivered_push_subscription_ids` attempt ini (cek rencana basi tetap atas semua target sebelum dibuang). Kirim sisanya. Simpan id yang sukses ke kolom itu (`array(select distinct unnest(col || $ids))`, attempt `status='sending'` + idempotency_key) SEBELUM memutuskan hasil; gagal simpan → log warn, tetap lanjut (kirim dobel lebih baik daripada hilang). Ada kegagalan sementara (non-404/410) → lempar walau sebagian sukses (attempt di-retry, hanya target gagal yang dikirim lagi). Semua target tersisa sudah terkirim → `accepted: true`. Pastikan retry panik berhenti bila alarm sudah ditangani/selesai (cek apakah `panicRecipientStillEligible`/planning sudah melakukannya; bila belum, tambahkan dan beri test).

### P0-2 (I1, `worker/web-push-provider.ts` + `worker/notification-adapters.ts` ~1300-1340)

Hapus `LIMIT 5` sebelum dekripsi. Lookup planning: urut `registered_at desc`, loop sampai satu terbuka, tanpa limit. Provider: dekripsi semua baris layak, lalu batas aman `MAX_PUSH_TARGETS_PER_RECIPIENT = 30` SETELAH dekripsi (log error bila terpotong), kirim semua paralel (allSettled). Ganti nama/komentar konstanta lama; update test lama `panic-push-fanout.test.ts:530` (cap 5) agar sesuai batas baru.

### P1-2 dispatch (I1, `deliverablePushSubscription`)

Bila `device_id` tidak null: syarat tambahan `ps_device.token_issued_at IS NOT NULL AND push_subscriptions.device_token_issued_at = ps_device.token_issued_at`.

### P1-2 registrasi + P1-3 server (I2, `services/notification-center.ts` registerPush, `services/device.service.ts`, routes/device-id bila perlu)

- Registrasi dengan device: `SELECT outlet_id, token_issued_at FROM devices ... FOR SHARE`, wajib `floor(epoch(token_issued_at)) <= iat token pemanggil` (bawa iat token terverifikasi lewat caller; lihat `device-registry-check.ts:59` dan tipe caller di routes notification), selain itu 401 `DEVICE_TOKEN_INVALID`. Simpan `device_token_issued_at = token_issued_at` (insert + upsert; upsert tanpa device mengikuti aturan device_id yang ada: bila device_id jadi NULL, kolom ini NULL juga).
- `issueDeviceToken`: dalam tx yang sama (sudah `FOR UPDATE`), `DELETE FROM push_subscriptions WHERE tenant_id=.. AND device_id=..`.
- Ganti DELETE same-tenant (`:477`) dengan `SELECT app.claim_push_endpoint(tenant,user,hash)` sebelum INSERT (serial lewat advisory lock).

### P1-1 (I3, `lib/auth.ts`, `services/identity-session.service.ts`)

Baca dulu `better-auth/dist/db/internal-adapter.mjs` (deleteSession/deleteSessions + hooks) di node_modules. Aturan: penghapusan sesi lewat endpoint eksplisit (path selain `/get-session`/tanpa ctx, mis. `/sign-out`, `/revoke-session(s)`, `/revoke-other-sessions`, reset/ganti password, admin revoke/ban) menghapus push sesi itu WALAU sesi sudah expired (`session.delete.before` → `SELECT app.delete_session_push_subscriptions(id)`; gagal → lempar). Pencabutan seluruh sesi user (revoke-sessions, reset password, admin revoke-user-sessions/ban, revoke-all di identity-session.service bila ada) juga menghapus subscription yatim user (`app.delete_user_push_subscriptions(user, keep)`; revoke-other mempertahankan sesi sekarang). Kedaluwarsa murni (cleanup `/get-session` atau SQL) tetap SET NULL dan tetap menerima. `endCause` audit impersonasi jangan berubah perilakunya.

### P0-3 + P1-3 web (I4, `features/ws05-notifications/{revoke,push}.ts`, `components/sign-out-button.tsx`, satu guard global)

- `revoke.ts`: bila timeout menang, tandai run `abandoned`; lanjutan run setelah itu TIDAK boleh `unsubscribeThisBrowser` atau `forgetSubscriptionId`. Tambah generasi pemilik (localStorage `legend.push.ownerGen`, naik tiap simpan registrasi): run menangkap generasi di awal, membatalkan sisa langkah bila berubah.
- Simpan pemilik browser `legend.push.owner` = userId saat registrasi tersimpan. `subscribeThisBrowser` menerima userId: bila subscription browser ada tapi pemilik tersimpan beda/tak ada, `unsubscribe()` lalu buat baru (endpoint baru) — jangan pakai ulang endpoint akun lain.
- Guard global (komponen kecil di layout yang dirender untuk user login, mis. `routes/__root.tsx`): saat user sesi berbeda dari `legend.push.owner`, unsubscribe subscription browser dan hapus id/owner tersimpan. Tanpa sesi: jangan sentuh (HP idle tetap menerima).

### P0-4 (I5, `features/facility-staff/components/panic-push-control.tsx`, `packages/shared/src/i18n/messages/facility-staff.ts`)

State baru `unbound` (atau `pending`/`failed`): label aktif hanya setelah server mengonfirmasi simpan untuk `outletId` sekarang (simpan outlet terkonfirmasi di ref). Gagal re-save → `unbound`: teks peringatan (role=status/alert) + tombol "Coba lagi"; retry otomatis pada event `online` dan `visibilitychange` visible. Teks lewat katalog i18n (bukan literal). Panggil `subscribeThisBrowser` sesuai signature baru I4 (tambahan argumen userId; koordinasi: ambil userId dari session context yang sudah ada di komponen/route). Ikuti `~/.agents/team/ui-standard.md` (target sentuh 44 px).

## Test gagal-dulu (test-writer; file baru, jangan ubah test lama kecuali disebut)

- T1 `apps/api/src/test/panic-push-806-dispatch.test.ts`: P0-1 (laptop 201, HP 503 sekali lalu 201; majukan `now` ke `deliverNotificationAttempt`; HP dipanggil lagi, laptop sekali), P0-2 (6 subs satu user/outlet, HP tertua tetap dikirim; variasi 5 ciphertext rusak + HP valid), P1-2 dispatch (enroll, register, reissue token → alarm tidak ke endpoint lama; register token baru → terkirim). Pakai helper dari `panic-push-fanout.test.ts`/`panic-test-helpers.ts`.
- T2 `apps/api/src/test/push-registration-806.test.ts`: P1-1 (register, expire sesi, sign-out HTTP → push hilang; orphan + revoke-sessions dari login baru → hilang; expiry murni tetap ada; revoked_at lalu DELETE tidak hidup lagi), P1-2 registrasi (token lama setelah reissue ditolak 401 DEVICE_TOKEN_INVALID; token baru jalan), P1-3 (user tenant A dan B daftar endpoint sama → hanya pemilik terakhir punya baris; dua user satu tenant paralel → satu baris tersisa).
- T3 `tests/push-registration-806-web.test.mjs` (pola loader `tests/push-registration-web.test.mjs`): P0-3 (DELETE ditahan deferred, timeout lewat, B registrasi, lepas A → subscription B tidak di-unsubscribe, id B tetap; endpoint sama), P1-3 web (subscribe dengan owner beda → unsubscribe + subscribe baru), P0-4 (render kontrol / logika state: gagal re-save → bukan aktif, ada retry; event online → retry → aktif). Ekspor/pola yang belum ada: tulis test terhadap perilaku publik modul sesuai Desain di atas.
- Bukti gagal-dulu dijalankan engineer di worktree basis `.worktrees/806-base` (e241e9476). Test-writer JANGAN menjalankan test; cukup tulis dan pastikan sintaks.
