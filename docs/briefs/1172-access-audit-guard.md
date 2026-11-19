# 1172 Akses: audit status outlet, kunci peran kustom, jam DB, kunci IP

Cabang `ws/1172-access-audit-guard` (base `milestone/m1`). Tingkat K (akses). Tanpa migrasi. Path relatif ke `apps/api/` kecuali disebut lain.

## Aturan bersama

- Jangan sentuh: `payment-webhook*`, `platform-approval.service.ts`, `edge-order-redrive.job.ts`, `pos-receipt*`, `order-given.ts`, `reservation-*`, `accounting-journal*`.
- Jangan commit, jangan jalankan vitest/tsc (token heavy dipegang agent utama). Cukup tulis/ubah file. Boleh baca apa saja.
- Tipe brand (`TenantId`, `OutletId`, dst.): pakai helper bertipe proyek, bukan `as`.
- Gaya: ikuti pola file sekitar. Prettier/eslint dijalankan agent utama.

## Kartu

1. `legend-hb1u9` `src/services/org.service.ts` `setOutletStatus` (~:982): tambah `recordAudit` (dari `./core-audit`) action `outlet.status_changed` (aktor, tenant, outlet, status lama dan baru, reason bila ada, safe field saja) DALAM transaksi yang sama dengan update status. Gagal -> tanpa baris audit.
2. `legend-v8dfx` `src/services/access.service.ts` `updateCustomRole` (~~:588): ambil `pg_advisory_xact_lock(hashtextextended('legend:role-assignment-end:<tenant>', 0))` di awal transaksi, pola sama seperti `grantRoleAssignment` (~~:919) dan `endRoleAssignment` (~:1199).
3. `legend-hzdy5` SESUDAH v8dfx (file sama): jalur grant (~~:903), end (~~:1183), `src/services/platform-tenant-owner.service.ts` pakai waktu DB `SELECT clock_timestamp()` (dibaca SESUDAH kunci advisory), bukan `new Date()` aplikasi atau `now()` transaksi, untuk cek dan `valid_until`/`valid_from`. Parameter `now` yang sudah ada untuk test boleh tetap sebagai override bila ada, tapi default produksi dari jam DB.
4. `legend-z2kaf` kunci rate limit pakai `clientIpKey` (`src/lib/client-ip-key.ts`) di `src/edge/link-server.ts`, `src/routes/staff-pin-sync.routes.ts`, `src/routes/edge-bootstrap.routes.ts`, `src/routes/mcp.routes.ts`. Jangan sentuh `payment-webhook`. Dua IP berbeda tidak berbagi kuota; header proxy palsu tidak menggeser kunci (TRUST_PROXY tetap ditolak).

## Bukti

Test gagal-dulu per kartu di `src/test/...`. Test-writer menulis; agent utama menjalankan.
