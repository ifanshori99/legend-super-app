# 782 — Bukti perbaikan jalur alarm panik

Basis: `origin/ui/panic-copy-subnav` (`2c60a4bc8`). Kartu: `legend-mm029`,
`legend-oi7ub`, `legend-po3fe`, `legend-ewmfd`, `legend-aagpf`.

## Bukti gagal-dulu

Semua pengujian menggunakan `heavy`; test API dan root menggunakan
`LEGEND_TEST_FILES=... heavy pnpm test` dan PostgreSQL uji terisolasi.

| Temuan           | Bukti sebelum perbaikan                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| PIN pemulihan    | Hook memanggil `verifyStaffPinCall`, bukan pembukaan sesi darurat.             |
| Gate OM/GM       | Kedua template bawaan tidak memasang layer; kontrol cashier lulus.             |
| Factory push     | `web_push` ditolak konfigurasi; provider disabled tidak melaporkan kegagalan.  |
| Press cloud-only | Press biasa dan test menghasilkan 0 outbox notifikasi, seharusnya 1.           |
| Sesi tercabut    | Objek sesi tersimpan masih menghasilkan `ok: true`; race socket tidak ditutup. |

Log lokal: `/tmp/panic-782-red-api.log` (4 gagal, 89 lulus),
`/tmp/panic-782-red-web.log` (3 gagal, 1 lulus), dan
`/tmp/panic-782-red-push.log` (2 gagal, 15 lulus).

## Batas operasional

Tidak ada kunci produksi yang dibuat. Factory push memerlukan
`NOTIFICATION_PUSH_PROVIDER=web_push`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
dan `VAPID_SUBJECT`, sebagaimana dicatat pada `.env.example`.
Subscription tersegel juga memakai `DATA_ENCRYPTION_KEY` atau ring
`DATA_ENCRYPTION_KEYS` beserta `DATA_ENCRYPTION_ACTIVE_KEY_VERSION` yang sudah
didukung aplikasi.

Pembuktian factory menggunakan subscription valid tersimpan dan transport
terkendali. Router registrasi subscription HTTP masih default-deny; endpoint
public push-key belum tersambung. Browser belum mempunyai penyedia header
`X-Device-Token`; dialog registrasi perangkat memang tidak menyimpan token.
Kedua integrasi ini harus diselesaikan sebelum menyatakan pemulihan PIN dan
push siap dipakai pada perangkat produksi. Mock tidak menerbitkan cookie
darurat dan tidak membuktikan ponsel nyata menerima alarm.

Tidak ada perubahan template peran atau migrasi database.

## Berkas yang berubah

| Area           | Berkas                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pemulihan PIN  | `apps/web/src/features/ws01-device-pin/api.ts`, `use-pin-session.ts`, `mock.ts`, `components/switch-user-screen.tsx`; `apps/web/src/routes/_ops/pos.ganti-pengguna.tsx`; `packages/shared/src/i18n/messages/ws01-device-pin.ts` |
| Layer dan gate | `apps/web/src/features/facility-staff/components/panic-alert-layer.tsx`, `apps/web/src/features/facility-staff/nav.ts`, `apps/web/src/routes/_ops/fasilitas.tsx`, `fasilitas.darurat.tsx`                                       |
| Relay dan sesi | `apps/api/src/services/panic-relay.service.ts`, `apps/api/src/services/panic-receiver-session.ts`                                                                                                                               |
| Push produksi  | `apps/api/src/worker/notification-adapters.ts`, `apps/api/src/worker/web-push-provider.ts`, `apps/api/src/lib/push-subscription.ts`, `apps/web/public/sw.js`, `.env.example`, `apps/api/package.json`, `pnpm-lock.yaml`         |
| Regresi API    | `apps/api/src/test/panic-relay.test.ts`, `panic-receiver-session.test.ts`, `panic-push-fallback.test.ts`                                                                                                                        |
| Regresi root   | `tests/panic-alert-screen.test.mjs`, `tests/panic-recovery-gate.test.mjs`, `tests/panic-push-service-worker.test.mjs`                                                                                                           |
| Handoff        | Dokumen ini, `docs/briefs/782-panic-delivery.md`, `docs/PROGRESS.md`                                                                                                                                                            |

## Review

Sebelas subagent Codex, puncak enam bersamaan: lima implementer, satu
test-writer/test-runner pemegang token heavy, dan lima reviewer area dengan
konteks segar. Temuan review dibetulkan: field tenant bertingkat, mode boot
edge yang dapat mengantrekan dua jalur, pemeriksaan ulang kelayakan penerima
saat delivery, serta tujuan notifikasi selain panic. Kegagalan telemetry
setelah transport menerima push tidak mengubah hasil pengiriman menjadi gagal.

Regresi susulan mencakup izin/cakupan outlet/duty/status karyawan yang berubah
setelah enqueue, alert yang sudah dijawab/ditutup/usang, race upgrade dan ACK
tanpa membocorkan lokasi/nama, serta pembukaan tautan internal yang aman.

## Verifikasi akhir

Run gabungan test terarah berikut lulus: **187 test root dan 176 test API**
(5 berkas API), exit 0. Log: `/tmp/panic-782-green.log`.

`LEGEND_MOCK_PORT=3282 heavy pnpm test:e2e:mock e2e/legend-jztb7.mock.spec.ts`
lulus **4/4**, exit 0. Mencakup satu dialog lintas halaman, nama penanggap,
pemulihan setelah reload, dan tab Darurat pada 390 px. Log:
`/tmp/panic-782-e2e.log`. Warmup bawaan menampilkan peringatan hydration dari
halaman pengaturan payroll yang tidak diubah; keempat test panic tetap lulus.

`heavy pnpm --filter @starter/web typecheck` lulus pada satu run, exit 0.
`heavy pnpm --filter @starter/api typecheck` lulus pada run akhir setelah
memperbaiki TS2322: teks alasan pencabutan dari database dibatasi ke daftar
alasan bersama, nilai tidak dikenal tetap ditolak sebagai logout. Log:
`/tmp/panic-782-typecheck-web.log`, `/tmp/panic-782-typecheck-api.log`
(kegagalan awal), `/tmp/panic-782-typecheck-api-final.log` (lulus).

Setelah normalisasi alasan pencabutan terakhir,
`LEGEND_TEST_FILES="src/test/panic-relay.test.ts src/test/panic-receiver-session.test.ts" heavy pnpm test`
diulang dan lulus **95/95**, exit 0. Bukti ini mencakup race socket, ACK tanpa
kebocoran nama, cloud replay/folding tepat sekali, dan nol notifikasi lokal
pada boot edge. Log: `/tmp/panic-782-receiver-final.log`.

`heavy pnpm build` lulus, exit 0: **2/2 task berhasil, 0 cache**, durasi build
9,717 detik. Log: `/tmp/panic-782-build.log`. Antrean wrapper lama sejak 19:47
dihentikan sebelum bundler mulai setelah kebijakan resmi host diperbarui;
proses dan tiket milik thread ini dibersihkan sebelum satu relaunch melalui
wrapper resmi terbaru. Tidak mengubah batas atau proses thread lain. Semua
job milik thread ini selesai pada 20:48 WIB.

Gate penuh `pnpm check` tetap milik merge train; cabang ini menjalankan gate
terarah di atas. Pengiriman ke ponsel produksi belum diuji.

```sh
LEGEND_TEST_FILES="tests/panic-recovery-gate.test.mjs tests/panic-push-service-worker.test.mjs tests/panic-alert-screen.test.mjs tests/panic-realtime-client.test.mjs tests/panic-alert-queue.test.mjs tests/text-contract.test.mjs tests/notification-contract.test.mjs src/test/panic-relay.test.ts src/test/panic-receiver-session.test.ts src/test/panic-push-fallback.test.ts src/test/panic-push-trigger.test.ts src/test/worker-notification-adapters.test.ts" heavy pnpm test
```

Perintah ESLint dan Prettier berikut lulus, exit 0, setelah perubahan kode
terakhir. `git diff --check` juga lulus. Penyiapan worktree,
`pnpm dev:prepare`, dan `pnpm run doctor` lulus.

```sh
pnpm exec eslint apps/api/src/lib/push-subscription.ts apps/api/src/services/panic-receiver-session.ts apps/api/src/services/panic-relay.service.ts apps/api/src/worker/notification-adapters.ts apps/api/src/worker/web-push-provider.ts apps/api/src/test/panic-push-fallback.test.ts apps/api/src/test/panic-receiver-session.test.ts apps/api/src/test/panic-relay.test.ts apps/web/public/sw.js apps/web/src/features/facility-staff/components/panic-alert-layer.tsx apps/web/src/features/facility-staff/nav.ts apps/web/src/features/ws01-device-pin/api.ts apps/web/src/features/ws01-device-pin/components/switch-user-screen.tsx apps/web/src/features/ws01-device-pin/mock.ts apps/web/src/features/ws01-device-pin/use-pin-session.ts apps/web/src/routes/_ops/fasilitas.darurat.tsx apps/web/src/routes/_ops/fasilitas.tsx apps/web/src/routes/_ops/pos.ganti-pengguna.tsx packages/shared/src/i18n/messages/ws01-device-pin.ts tests/panic-alert-screen.test.mjs tests/panic-push-service-worker.test.mjs tests/panic-recovery-gate.test.mjs
pnpm exec prettier --check apps/api/package.json apps/api/src/lib/push-subscription.ts apps/api/src/services/panic-receiver-session.ts apps/api/src/services/panic-relay.service.ts apps/api/src/worker/notification-adapters.ts apps/api/src/worker/web-push-provider.ts apps/api/src/test/panic-push-fallback.test.ts apps/api/src/test/panic-receiver-session.test.ts apps/api/src/test/panic-relay.test.ts apps/web/public/sw.js apps/web/src/features/facility-staff/components/panic-alert-layer.tsx apps/web/src/features/facility-staff/nav.ts apps/web/src/features/ws01-device-pin/api.ts apps/web/src/features/ws01-device-pin/components/switch-user-screen.tsx apps/web/src/features/ws01-device-pin/mock.ts apps/web/src/features/ws01-device-pin/use-pin-session.ts apps/web/src/routes/_ops/fasilitas.darurat.tsx apps/web/src/routes/_ops/fasilitas.tsx apps/web/src/routes/_ops/pos.ganti-pengguna.tsx packages/shared/src/i18n/messages/ws01-device-pin.ts tests/panic-alert-screen.test.mjs tests/panic-push-service-worker.test.mjs tests/panic-recovery-gate.test.mjs pnpm-lock.yaml
```
