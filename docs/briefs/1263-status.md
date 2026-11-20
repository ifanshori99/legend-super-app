# 1263 status (dihentikan 21 Nov, kuota Claude)

Sudah: worktree `../legend-1263` dari b2f0dc9c0, analisis kode selesai. Belum ada perubahan kode, test, atau migrasi.
Belum: semua butir kartu 1263 (service, kontrak, izin, migrasi, route, web, screenshot, test).
Langkah berikut (rencana hasil analisis):
- Kontrak: endpoint baru `POST /api/accounting/fiscal-periods/:id/close-override` di `packages/shared/src/accounting/endpoints.ts`, body strict `{expectedVersion, idempotencyKey, reason (trim, 20-1000), sourceIds (unik, min 1)}`.
- Izin: `["accounting.period.close_override", ["finance", "approve"]]` di `packages/shared/src/access/permissions.ts`; owner (semua kecuali platform/self) dan finance (`accounting.*`) otomatis dapat di `roles.ts`, peran lain tidak.
- Migrasi 0523 grant ke baris template owner + finance tenant lama, salin pola `apps/api/drizzle/0505_payout_gl_resolve_grants.sql`; daftarkan di `apps/api/src/test/data-import-registry.test.ts` dan `_journal.json`.
- Service `accounting-period-close.service.ts` `closeFiscalPeriod`: cek MFA dulu (`AccessError("MFA_REQUIRED")`, pola `accounting-cash-bank-entries.service.ts:899`); replay kunci tetap sebelum cek blok (idempoten); errorCode selain PRODUCTION_INCOMPLETE tetap 422; daftar sourceId beda atau sudah tidak terblok -> 409; audit kedua `accounting.period.close_overridden` lewat `auditAccountingChange` (reason + sources+errorCode). Naikkan `sources.slice(0, 20)` di detail 422 agar UI melihat daftar lengkap (batasi, mis. 200).
- Route `accounting.routes.ts`: `requireTenantPermission("accounting.period.close_override")` + `sessionMfaVerifiedAt(req)`.
- Test: perluas fixture `apps/api/src/test/inventory-gl-blocked-visible.test.ts` (sukses+audit, 422 kode lain, 409 basi, 403 tanpa izin/MFA, 400 alasan, batch terlambat -> periode buka dengan `lateAdjustmentFrom`, replay).
- Web layar tutup buku + text-contract + screenshot 390/1280 `docs/review/img/period-close-override-*.png`.
