# Sub-brief 1203: backend tukar poin member alur A

Cabang `ws/1203-tukar-poin-backend` (base `ws/1165-member-tukar-poin-ui` 748364714). Kartu legend-0ne0z (+ legend-93f0m bila kunci per entitas menyentuh jalur redeem). Tingkat K (uang). Migrasi baru hanya nomor 0733-0735 (hindari bila bisa).

## Kontrak (sudah ada, ubah hanya aditif)

`packages/shared/src/crm/member-points-redeem.ts`:

- `GET /api/member/open-bills` -> `{data: MemberOpenBill[]}`: tagihan terbuka milik member sesi (attachedVia `member_qr|pwa_session`), dalam PT program member.
- `GET /api/member/open-bills/:orderId/points-quote` -> saldo, pointValueIdr, minPoints, maxPoints = min(saldo, floor(remainingIdr/pointValueIdr)) (0 bila refusal), remainingIdr, refusal (`program_inactive|membership_inactive|bill_settled|order_not_eligible|outlet_offline`), quotedAt.
- `POST /api/member/points-redeem/status` body `{orderId, token}` -> state `pending|consumed|expired|invalid`, points, discountIdr, remainingIdr, balancePoints, checkedAt. Juga mencerminkan tagihan `pwa_session` yang ditukar kasir tanpa QR.
- Mint: `POST /api/member/qr-token` yang sudah ada, body `{orderId, points}`. Tambah cek: order milik member sesi dan tenant yang sama, order masih terbuka/eligible, points <= maxPoints quote. Tolak token hidup kedua untuk satu tagihan (bila desain memungkinkan tanpa migrasi).

## Aturan uang (wajib terbukti test, fail-first: merah di base, hijau sesudah)

1. Nilai poin dipakai <= sisa tagihan; saldo tidak negatif.
2. Redeem idempoten: retry dengan token/kunci sama tidak memotong dua kali.
3. Quote kedaluwarsa atau saldo berubah sesudah mint: redeem ditolak, bukan disesuaikan diam-diam.
4. Batal/void bill sesudah redeem: poin kembali tepat sekali (void dua kali tidak mengembalikan dua kali).
5. Isolasi tenant dan outlet di SQL: member A tidak melihat/mint/cek order member B atau PT lain.
6. Mint menolak order milik member lain, order PT lain, order sudah lunas/void, points > batas.

## Lokasi relevan (awal)

- Server redeem POS: `apps/api/src/services/pos-points.service.ts` (~baris 219), nonce sekali pakai `member_qr_redeem_nonces` (migrasi 0490).
- Mint: `issueMemberQrToken`; test `apps/api/src/test/member-qr-mint.test.ts`, `pos-1059-points.test.ts`, helper `member-qr-redeem-helper.ts`.
- Web mock: skenario `VITE_API_MOCK` (`points-consumed`, `points-redeemed`, `points-mint-fail`, `points-multi-bill`); UI brief `docs/briefs/sub-1165-member-tukar-poin-ui.md`.

## Aturan kerja

- Test API: `apps/api/src/test/member-points-redeem-1203.test.ts` (baru). Jalankan: `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` dari root worktree. Satu token heavy per thread: hanya satu subagent menjalankan test/tsc pada satu waktu.
- Tipe brand pakai helper bertipe, bukan `as`. Lempar `HttpError`, jangan `res.status(500)`.
- Rute member: pola guard rute member yang sudah ada (requireAuth + requireTrustedOrigin untuk POST + jsonBody).
- Jangan sentuh `e2e/acceptance/`, `e2e/visual/`.

## Status 19 Nov (handoff: kerja pindah ke Claude Code langsung)

Belum ada kode produksi diubah. Yang selesai: brief ini, peta kode (di bawah), test fail-first (lihat bagian test bila ada).

### Peta jalur redeem (Explore A)

- Mint: `apps/api/src/lib/member-qr-token.ts:44` `issueMemberQrToken({tenantId, customerProfileId, orderId?, points?}, now)`; token `b64url(payload).b64url(HMAC)`, payload `{t,p,e,n,o?,a?}`, nonce 12 byte, TTL 120 s; verify `verifyMemberQrRedeemToken` (:117). Rute `routes/member.routes.ts:~146`: TIDAK ada cek order/kepemilikan/status/maxPoints/token hidup.
- Redeem: `services/pos-points.service.ts` `posPointsTenderSettlement` (:155): kunci order, tolak edge (:163), attachedVia `member_qr|pwa_session` (:202), `checkMemberQr` (:217), `checkLoyaltyOutletEntity` -> 409 `POINTS_ENTITY_BUSY` (:231, legend-93f0m), `withProfileLock` (`db/member-scope.ts:70`), expiry ulang `clock_timestamp()` (:247), nonce insert `member_qr_redeem_nonces` onConflictDoNothing (:264), `expirePointsForProfile`, `priceRedemption` (:~100, points<=balance, nilai<=sisa), `postLedgerEntry` type redeem points -N sourceType `pos_tender` sourceId tenderId. Diskon = tender `pos_order_tenders` method `points`. Saldo `customer_profiles.pointsBalance`.
- Void: `services/pos-points-restore.ts:41` `restorePointsTenders`, dipanggil `pos-order.service.ts:1747` hanya bila `pointsOnly` (:1694); adjust `reversesEntryId`, dedupe (tenant, adjust, adjustment, tender id) -> tepat sekali.

### Peta rute member dan order (Explore B)

- `routes/member.routes.ts:45` `base = [requireTenantContext, requireAuth, requireTrustedOrigin]`; `requireMember()` (`middleware/member.ts:49`) -> `getMemberScope(req)` {tenantId, userId, customerProfileId, status}. DB: `withMemberScope(db, scope, tx=>…)` (`db/member-scope.ts:~58`, set GUC `app.customer_profile_id`). Mint pakai `optionalJsonBody`. Router dipasang `routes/index.ts:168`.
- `orders` (`db/schema/qr-order.ts:185`): `customerProfileId`, `customerAttachedVia` (:201), `customerAttachedAt` (:202), `number` (:191), `tableSessionId`, `outletId`, `status` (`draft|awaiting_payment|sent|completed|voided`), `totalIdr`, `depositAppliedIdr`, `voidedAt`. Attach ditulis di `services/pos-order-customer.service.ts:229`.
- Sisa: `max(0, total − depositApplied − Σ tender captured)` (`services/pos-order-support.ts:364`); tender `posOrderTenders` (`db/schema/pos-order.ts:232`) `method, amountIdr, pointsUsed, status`.
- Meja: `tableSessions.tableId` -> `tables.code` (`floor.ts:118,190`) -> `floor_zones.name`. `outlets.name` (`platform-org.ts:227`); tidak ada kolom area (pakai nama zona atau region).
- Offline: hanya `getEdgeRuntimeState().edgeMode`/`EDGE_MODE` (proses, bukan per outlet); kandidat `outlets.edgeNodeId` + `edge_nodes.status` (belum dipastikan).
- Program: `loyaltyPrograms` (`db/schema/crm-member.ts:58`) `isActive`, `pointValueIdr`, satu per tenant; minPoints = `POS_MIN_REDEEM_POINTS = 1` (`pos-points.service.ts:58`). Pakai ulang `maxPointsFor`, `priceRedemption`.
- Bentuk query open-bills: dalam `withMemberScope`, orders join outlets, left join tableSessions/tables/floor_zones; filter tenant, customerProfileId sesi, attachedVia IN (member_qr, pwa_session), status NOT IN (voided, completed); tender captured dijumlah dalam satu query grouped.

### Web dan registry (Explore C)

- `apps/web/src/features/member-tukar-poin/api.ts:11-45` sudah memanggil endpoint shared lewat `callEndpoint` (mint lewat `requestMemberQrToken` dari `ws08-member/api`): web tidak perlu diubah bila kontrak aditif. Mock `member-tukar-poin/mock.ts` (dipasang dari `ws08-member/mock.ts:39`), skenario `lib/mock/control.ts:31-40`. Test web: `apps/web/test/member-tukar-poin-view-model.test.ts`.
- Registry dicek: `packages/shared/src/crm/endpoints.ts:30,240`, `apps/api/src/test/data-import-registry.test.ts`, `apps/api/src/config/data-import.ts`, `member-isolation.test.ts`, `member-qr-mint.test.ts`.
- Migrasi: worktree ini berakhir di 0492 (journal idx 492); nomor 0733-0735 dari brief CTO perlu dicek ulang terhadap main.

### Celah vs aturan uang (yang harus dibangun)

1. Mint tanpa cek apa pun (aturan 5, 6, token hidup tunggal).
2. Aturan 3: token mengikat points, bukan quote/saldo; saldo berubah tapi masih cukup -> redeem tetap lolos. Keputusan perlu: ikat saldo-saat-mint (atau versi ledger) di payload token, tolak bila beda.
3. Aturan 4: restore hanya bila semua tender points; bill campuran points+tunai yang di-void, atau jalur refund, tidak mengembalikan poin. Perlu verifikasi + perbaikan.
4. Order `pwa_session` tanpa token -> tanpa nonce idempotensi; retry bisa memotong dua kali kecuali dijaga di tempat lain (cek idempotensi tender POS).

### Test fail-first (test-writer, sudah dijalankan di base)

`apps/api/src/test/member-points-redeem-1203.test.ts`, 39 test (1203-01..61): 01-06 open-bills, 10-18 quote, 20-27 status, 30-37 mint, 40-42 idempotensi, 50-52 quote basi, 60-61 void. Di base: 38 merah, 1 hijau (1203-37 mint tanpa sesi 401, penjaga regresi). Sebab merah: 32 test 404 "Route not found" (endpoint belum ada); 1203-31/33/34/35/36 mint menjawab 200 padahal harus ditolak (poin > saldo, bill member lain, tenant lain/tidak dikenal, bill lunas/void, PT lain); 1203-30/32/52 baru jalan setelah quote ada. Tanpa 422 atau error setup.
Asumsi test: mint/quote ditolak = 4xx tanpa `data`; bill terlihat tapi tak bisa dipakai = 200 + `refusal` + maxPoints 0; token rusak/asing = 200 state `invalid`; tender captured points/tunai dihitung terbayar; `order_not_eligible` longgar (disembunyikan, atau ditolak dengan max 0).
Putaran 2 (20 Nov): 1203-70..82 ditambah (51 test: 48 merah, 3 hijau = 37, 76, 77). 70 token hidup kedua; 71 outlet_offline (node edge + alert edge_offline terbuka); 72-73 token mengikat saldo saat mint (saldo naik/turun tetap ditolak); 75 void dengan tender tunai batal; 76-77 penjaga void/refund campuran; 78-79 retry pwa_session; 80-82 invarian uang. Detail dan asumsi: `docs/briefs/.1203-tests-ready`. Bill campuran dengan tunai captured tetap ditolak (SO-R-09), butuh konfirmasi CTO.
(Dulu belum tercakup: token hidup kedua per bill, refusal `outlet_offline`, void bill campuran points+tunai (celah 3), retry `pwa_session` (celah 4). Tambahkan sebelum implementasi.)

### Langkah berikut

1. Peta Explore A/B/C sudah di atas; tidak perlu diulang.
2. Tambah test yang belum tercakup (di atas), lalu jalankan `LEGEND_TEST_FILES="src/test/member-points-redeem-1203.test.ts" heavy pnpm test` sekali untuk memastikan merah karena sebab benar.
3. Implementer per potongan (file tidak bertumpuk): (a) `member-points-redeem.service.ts` + rute open-bills/quote/status; (b) cek mint di `member.routes.ts` + payload token (saldo/versi); (c) restore poin untuk void campuran/refund di `pos-points-restore.ts`/`pos-order.service.ts`; (d) web `features/.../api.ts` ganti mock; registry (endpoints, data-import-registry bila ada migrasi 0733-0735).
4. Architect xhigh atas diff, test terarah, typecheck api+web lewat heavy, `db:generate` kosong, prettier+eslint, commit, push, tutup legend-0ne0z (dan 93f0m bila disentuh).

## Status 20 Nov (implementasi)

Selesai (commit af4548552 + fix tipe):
- (b) Token QR mengikat versi ledger poin member (`v` = max posting_seq); POS menolak redeem bila ledger bergerak sesudah mint (naik/turun), token tanpa `v` tidak pernah redeem. Mint memeriksa: tagihan milik member sesi (SQL), tenant, PT program, status terbuka, bukti member (member_qr/pwa_session), outlet tidak offline (edge node aktif + alert `edge_offline` terbuka, atau proses edge), points <= maxPoints; menolak token hidup kedua per tagihan lewat tabel baru `member_qr_redeem_mints` (migrasi 0733, journal idx 733, RLS tenant+outlet; `db:generate` kosong).
- (a) `services/member-points-redeem.service.ts` + rute `GET /api/member/open-bills`, `GET .../:orderId/points-quote`, `POST /api/member/points-redeem/status` (allow pending: suspended melihat `membership_inactive`).
- (c) Tidak ada kode baru (keputusan CTO 20 Nov): void bill poin+tunai captured tetap ditolak (SO-R-09), refund bill berpoin tetap ditolak (REFUND_POINTS_TENDER_UNSUPPORTED); void points-only mengembalikan tepat sekali (sudah ada; 1203-60/61/75 hijau).
- (d) Web tidak berubah: kontrak tidak berubah, `features/member-tukar-poin/api.ts` sudah memanggil endpoint nyata.
- Helper test: `member-qr-redeem-helper.ts` (`ledgerVersionOf`), `pos-1059-points.test.ts` `mintRedeemQr` async dengan versi; `member-qr-mint.test.ts` test 1 kini: order bukan milik member -> 404.

Test: 1203 (51/51), member-qr-mint + pos-1059 (74/74 bersama 1203), migration-fk-force-rls, migration-force-rls-guard, data-import-registry, member-isolation, pos-936-points/so-points/so-refund/ticket (165/165). Typecheck api lolos. Web/shared tidak disentuh.

Sisa / risiko untuk CTO:
- Quote (GET) tidak menjalankan expiry poin (read-only); mint menjalankannya, jadi saldo di quote bisa lebih tinggi dari saldo saat mint bila ada poin kedaluwarsa yang belum dibukukan.
- Binding versi ledger: earn apa pun dalam 120 s jendela QR membuat QR ditolak (member harus buat QR baru). Dua QR untuk dua tagihan berbeda: hanya yang pertama ditukar yang lolos.
- Status `invalid` dipakai juga untuk QR basi (versi berubah, sisa tagihan turun di bawah nilai token).
- Migrasi 0733 perlu dicek merge train terhadap nomor di cabang integrasi.
- Belum: review architect xhigh atas diff, second-opinion Codex, `pnpm check` penuh.
