# Brief legend-kmd3: mesin kuota Wi-Fi (WS-09)

Worktree: `.worktrees/wifi-quota` (cabang `ws/wifi-quota`). Jalankan semua dari root worktree. Jangan commit, jangan push, jangan `pkill`. Tes terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test` (dari root; ringan). Typecheck/eslint: lewat `heavy`. Aturan PRD v1.7 §3 F25, FAC-12/13/14.

## Sudah ada (jangan dibuat ulang)

- Kontrak `packages/shared/src/facility/*`: `wifiPolicySchema` (kini + `spendMode?`), `wifiSessionSchema`, `wifiQuotaViewSchema`, `startWifiSessionSchema` (kini + `controllerDeviceId?`), `refreshWifiQuotaSchema` (body kosong ketat, legend-8vd3: jangan terima `sameDaySpendIdr`), endpoint `getWifiPolicyForZone`, `startWifiSession`, `getCurrentWifiSession`, `refreshWifiQuota`, `endWifiSession` di `endpoints.ts` ~310-346, event `wifiQuotaUpdatedEvent` (`events.ts:167`), error `WIFI_DEVICE_LIMIT` (409), `WIFI_POLICY_INVALID` (422).
- Helper murni `packages/shared/src/facility/wifi.ts`: `isPeakAt`, `wifiFreeMinutes`, `wifiExtraMinutesForOrders` + `wifiQuotaMinutesForOrders` (baru, mendukung `spendMode`), `wifiSpeedTier`, `wifiRemainingMinutes`, `assertWifiDeviceAllowed`, `WIFI_MAX_DAILY_MINUTES`. Pakai ini, jangan menulis ulang matematika.
- Tabel baru (migrasi `0218_wifi_quota_engine`, sudah dibuat, jangan ubah kecuali butuh kolom: lapor): `apps/api/src/db/schema/wifi-quota.ts` = `wifiSessions`, `wifiSpendEntries`; `wifi_policies.spend_mode` (null = `per_day_multiple`). Baca header file itu.
- Agen edge: `apps/api/src/edge/wifi/port.ts` `wifiEnforcement().applySession(ctx, ApplyWifiSessionInput)` / `.endSession(ctx, {outletId, wifiSessionId, reason})`; input di `packages/shared/src/edge/wifi.ts`. Di cloud belum terpasang: melempar `HttpError 503 WIFI_AGENT_NOT_READY` (fail closed). `controllerDeviceId` mentah hanya ada di `wifi_device_grants` (edge-lokal, kolom `controller_device_id` selagi grant hidup), TIDAK boleh disimpan di `wifi_sessions`.
- Policy: `apps/api/src/services/wifi-policy.service.ts` (satu policy per zona, `wifi_policies.zone_id`). Outlet dari baris policy; zona tanpa policy = 404/`WIFI_POLICY_INVALID`.
- Pola: outbox `services/core-outbox.ts` `appendOutbox`; audit `facility-shared.ts` `auditFacility`; konsumer `services/loyalty-earn-consumer.ts` (+ pemasangan di `worker-main.ts` ~205-235, digerbang `postsInventoryGl`); training `services/device-training.ts` `isTrainingOrder`; hari bisnis `businessDateFor(outlet, now)` di `services/pos-order-support.ts:160`; rute member `routes/member.routes.ts:44-60` (`requireTenantContext, requireAuth, requireTrustedOrigin` + `requireMember()`, `profileIdOf`); tes `src/test/facility-customer-api.test.ts` + `floor-test-helpers`.

## Keputusan desain

1. Belanja = uang sungguhan: `paidCashIdr + paidGatewayIdr + paidEdcIdr` dari payload `order.paid` (bukan poin/deposit). Refund = `refundCashIdr + refundGatewayIdr + refundEdcIdr` dari `order.refunded` (cek nama field persis di `pos-order.service.ts:1243-1265` dan `pos-order-corrections.ts:884-912`). Pelanggan = `orders.customer_profile_id` (baca dari baris `orders`, bukan payload); tanpa pelanggan = abaikan. Pesanan latihan (`isTrainingOrder`) = abaikan, tidak ada baris ledger.
2. Ledger `wifi_spend_entries`: satu `paid` per pesanan (`source_id` = orderId), satu `refund` per refund (`source_id` = refundId); `unique(tenant, kind, source_id)` + `onConflictDoNothing` = replay aman. `business_date` dari payload.
3. Net per pesanan = paid − sum(refund pesanan itu), min 0. Kuota hari = `wifiQuotaMinutesForOrders(policy, {isPeak: isPeakAt(policy, now, outlet.timezone), tierKey, orderNetSpendIdr: nets})`. `tierKey` = `lower(loyalty_tiers.name)` dari `customer_profiles.tier_id` (join `(tenant_id, tier_id)`), null = tanpa tier. Kunci panjang > 30 = abaikan bonus.
4. Kuota per AKUN per hari-bisnis outlet. Sesi: satu per (akun, perangkat) terbuka (unik parsial). Sesi baru di hari yang sama mewarisi `used_minutes` = max `used_minutes` sesi akun itu di `business_date` yang sama. Pemakaian dihitung lazy: `used += floor((now - accrued_at)/60s)` sebelum tiap baca/refresh/end (hanya sesi terbuka), maks 1440, geser `accrued_at` sebesar menit yang dihitung. `speed_tier = wifiSpeedTier(used, quota)`.
5. Maks perangkat: hitung sesi terbuka akun (di bawah kunci akun, mis. `pg_advisory_xact_lock(hashtext(tenant||profile))` atau `SELECT … FOR UPDATE` pada baris pelanggan), `assertWifiDeviceAllowed(count, policy, {deviceAlreadyActive})`; perangkat ke-3 ditolak `WIFI_DEVICE_LIMIT` 409. Start di perangkat yang sudah punya sesi terbuka = pakai ulang sesi itu (hitung ulang kuota).
6. Hari bisnis berganti: sesi terbuka dengan `business_date` lama diakhiri (`endSession(reason: "day_closed")` bila ada agen) saat start/refresh berikut; sesi baru mulai dari kuota hari baru.
7. Penegakan: setiap kali kuota/tier berubah (start, refresh, konsumer), bila `controllerDeviceId` diketahui (start: dari input; ulang: dari grant hidup edge-lokal lewat `withTenant` select `wifi_device_grants.controller_device_id` where `wifi_session_id`) panggil `wifiEnforcement().applySession` dengan `remainingSeconds = remaining*60`, `speedTier`, `fullSpeedKbps/baseSpeedKbps` dari policy, `sessionEndsAt` = akhir hari bisnis (atau `startedAt + 24h`). Kuota habis = throttle (`speedTier: base`), tidak pernah putus (FAC-13). `WIFI_AGENT_NOT_READY` (cloud) = tangkap, catat, jangan gagalkan; event `wifi_quota.updated` tetap ditulis ke outbox (tujuan sesuai pola fasilitas) supaya penerap edge memanggil `applyWifiQuotaToEdge`.
8. Konsumer `order.paid`/`order.refunded` memperbarui ledger lalu menghitung ulang semua sesi terbuka akun itu di `business_date` tersebut (target ≤ 1 menit setelah lunas = berjalan di relay outbox). Refund yang menurunkan kuota di bawah pemakaian = throttle, bukan putus.
9. `refresh` (body kosong) = hitung ulang dari ledger + waktu sekarang (peak, tier) untuk sesi terbuka milik pemanggil. Tanpa sesi terbuka: 404 yang konsisten dengan pola fasilitas.
10. Isolasi: semua query via `withTenant`/context tenant; RLS tenant+outlet aktif; pemanggil hanya mengakses sesinya sendiri (profil dari `getMemberScope`). Tes lintas tenant dan lintas outlet wajib.

## Potongan (berkas tidak bertumpuk)

### S1 policy + helper tes

Berkas: `apps/api/src/services/wifi-policy.service.ts`, `apps/api/src/services/facility-shared.ts` (allowlist audit `spendMode`), `apps/api/src/test/facility-config-api.test.ts` (tambah kasus), `tests/legend-kmd3-wifi-quota-rules.test.mjs` (baru).

- `spendMode` ikut di mapper `toWifiPolicy`, parse, insert/update `values`, `policyAuditValues`, audit allowlist (null di DB → kembalikan `undefined`/tidak ada, atau `per_day_multiple`: pilih satu dan konsisten; PUT menerima kedua nilai).
- Tes node murni untuk `wifiExtraMinutesForOrders`/`wifiQuotaMinutesForOrders`: dua mode (mis. Rp20k+Rp20k: day_multiple 1 jam, per_order 0; Rp45k satu pesanan keduanya 1 jam), tier Gold/Platinum, jam ramai (11.30-14.00, 18.00-21.00 hari kerja, akhir pekan penuh) via `isPeakAt`, batas 1440, pola import seperti `tests/facility-contract.test.mjs`.

### S2 ledger + kuota + konsumer

Berkas: `apps/api/src/services/wifi-quota.service.ts` (baru), `apps/api/src/services/wifi-quota-consumer.ts` (baru), `apps/api/src/worker-main.ts` (satu pemanggilan di samping loyalty), `apps/api/src/test/wifi-quota-consumer.test.ts` (baru).
Ekspor `wifi-quota.service.ts` (S3 memanggilnya; jaga nama/tanda tangan ini):

```ts
type Tx = ...; // sama dengan loyalty-earn-consumer
computeAccountQuota(tx, ctx, { policy: WifiPolicy; outletTimeZone: string; customerProfileId: string; businessDate: string; now: Date }): Promise<{ quotaMinutes: number; isPeak: boolean; tierKey: string | undefined; reason: "session_started"|"spend"|"tier_bonus"|"peak_window"|"quota_spent" -> tidak perlu; kembalikan angka saja }>
recomputeOpenSessions(tx, ctx, { customerProfileId; businessDate; now; reason: "spend" | "tier_bonus" | "peak_window" }): Promise<void> // update baris sesi terbuka (accrue dulu), tulis wifi_quota.updated, applyWifiQuotaToEdge best-effort
applyWifiQuotaToEdge(ctx, session: WifiSessionRow, policy: WifiPolicy, controllerDeviceId?: string): Promise<void> // 503 WIFI_AGENT_NOT_READY ditangkap
accrueUsage(row: WifiSessionRow, now: Date): { usedMinutes: number; accruedAt: Date } // murni
```

Konsumer: `deliverWifiQuotaEvent(context, event, tx, now?)` (pola `deliverLoyaltyEarnEvent`: filter nama, cek tenant, savepoint, payload buruk = abaikan, error lain propagasi).

### S3 sesi tamu + rute

Berkas: `apps/api/src/services/wifi-session.service.ts` (baru), `apps/api/src/routes/wifi-guest.routes.ts` (baru), `apps/api/src/routes/index.ts` (impor + mount `/wifi` SEBELUM `wifiConfigRouter`, dengan middleware member), `apps/api/src/test/wifi-session-api.test.ts` (baru), `apps/api/src/middleware/public-rate-limit.ts` hanya bila `/api/wifi/policy` dijadikan publik (cek `getWifiPolicyForZone` di kontrak: auth atau publik; ikuti kontrak).
Rute: `GET /policy`, `POST /sessions`, `GET /sessions/current`, `POST /sessions/current/refresh`, `POST /sessions/:sessionId/end` sesuai `endpoints.ts`; validasi strict via `endpoint.body/params/query.parse`; respons `wifiQuotaViewSchema` (`serverTime` dari server). `startWifiSession` mengirim `controllerDeviceId` ke `applyWifiQuotaToEdge`; hash perangkat = sha256 hex dari `${tenantId}:${deviceFingerprint}`.
Tes (gagal-dulu) wajib: 2 jam gratis sekali per hari (sesi ke-2 hari sama tidak mengulang jatah), perangkat ke-3 ditolak 409 `WIFI_DEVICE_LIMIT` dan perangkat yang sama tidak dihitung, refresh body `{sameDaySpendIdr}` ditolak, throttle saat habis (`speedTier: base`, bukan putus), isolasi lintas tenant (sesi tenant A tak terlihat B), outlet lain, tanpa login 401. Enforcement di tes: pasang agen palsu via `installWifiEnforcement` dan pastikan tidak ada pemanggilan `endSession` saat kuota habis.

## Selesai bila

`heavy pnpm --filter api typecheck` bersih; `pnpm exec eslint` dan `pnpm exec prettier --check` pada berkas berubah; tes terarah milik potongan lulus; jangan menyentuh berkas potongan lain. Laporkan berkas, hasil tes, dan hal yang belum terverifikasi.
