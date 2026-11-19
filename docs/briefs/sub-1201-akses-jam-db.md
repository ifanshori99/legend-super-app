# sub-1201: baca izin pakai jam DB (tingkat K, akses)

Base c3d5ca1bc. Tanpa migrasi. Tulis `valid_from`/`valid_until` sudah jam DB (`readDbClock` = `clock_timestamp()` di `services/access.service.ts:595`). Baca izin masih jam app (`new Date()`): jam DB di depan app => role baru belum aktif, akses dicabut masih aktif.

## Desain (keputusan CTO + agent)
- Satu sumber jam: DB. Tanpa query jam tambahan per request.
- `loadTenantAccessInTransaction` (`services/permission-resolver.ts` ~115-150): query `role_assignments` memuat kolom jam `statement_timestamp()` (konstan satu statement) dan membatasi baris di SQL: `valid_from <= statement_timestamp()` DAN (`valid_until IS NULL` ATAU `valid_until > statement_timestamp()`). Baris tak aktif tidak dikembalikan. `TenantAccessData` dapat field `clock: Date` (jam DB; bila tak ada baris/`requestMayUseStaffRoles` false: `new Date()` boleh, tak berpengaruh).
- `resolveAccessSnapshot` (`AccessSnapshotInput`): field baru opsional `clock?: Date`; pakai `input.clock ?? input.now` untuk SEMUA pemakaian `now` di resolver. Banyak pemanggil sudah `...data` jadi `clock` ikut otomatis. Pemanggil yang tidak spread `data`: teruskan `clock: data.clock`.
- Pembaca lain yang membandingkan validitas pakai jam app: ganti ke SQL `statement_timestamp()` atau `data.clock`: `lib/auth.ts:208-223`, `services/hris-employee.service.ts` (~892), `services/platform-support.service.ts` (~865, ~1640), `services/platform-tenant-directory.service.ts` (~135, ~210), `services/identity-access.service.ts:45`, `services/notification-push-ports.ts:53`, `services/device-pin-support.ts:63`, `services/me-outlets.service.ts:60`, `db/backfill-employee-managers.ts:380` (skrip, jam app boleh dibiarkan bila bukan jalur izin; sebut di laporan), `routes/me.routes.ts:72,143`, `middleware/permissions.ts:108,195,241,256`, route lain yang memanggil `resolveAccessSnapshot` dengan `now: new Date()`.
- Dilarang toleransi skew di tes.

## Bukti selesai
Tes gagal-dulu: app clock dipalsukan 60 dtk di BELAKANG DB (pola `platform-tenant-owner-db-clock.test.ts`): (a) grant `valid_from = DB now` lalu langsung request => harus aktif; (b) cabut (`valid_until = DB now`) lalu request => harus tak aktif seketika; (c) grant `valid_until` 1 dtk di depan DB lalu lewat. Merah di c3d5ca1bc, hijau sesudah. `platform-tenant-owner`, `platform-access-api`, dan berkas akses 1172/1183 (`*-db-clock*`, `*-lock*`, `platform-org-api`) hijau.

## Putaran 2 (temuan architect)
Pola A: pemanggil `outletReachOf`/`stationReachOf`/helper persetujuan yang memegang `data` dari loader tetapi memberi `now: new Date()` => ganti `now: data.clock ?? <now sekarang>` (nama variabel bisa `caller.data`/`access`). JANGAN ubah bila `now` itu waktu as-of-past (keputusan tersimpan); lapor.
- A-routes: hris-leave.routes.ts:130, hris-payslip.routes.ts:105, payroll-reimbursements.routes.ts:98, hris-attendance-admin.routes.ts:84, hris-kpi.routes.ts:97, hris-attendance-correction.routes.ts:93, report-viewer.ts:54, hris.routes.ts:115, hris-sop-gate.ts:90, payroll-loans.routes.ts:99, hris-scheduling.routes.ts:111, hris-attendance.routes.ts:108
- A-services: edc-reconciliation.service.ts:538, menu-internals.ts:211, pos-shift.service.ts:1240, payment-refund.service.ts:3300 (cek as-of-past dulu), platform-approval.service.ts:1500
- B: open-bill-control.service.ts ~611-636: query ulang semua assignment tanpa filter; tambah filter SQL `statement_timestamp()` (valid_from <= dan valid_until null/ >) sama seperti loader, jangan pakai `shared.clock` dari kandidat pertama.
- C: profit-share-recipient-reconcile.service.ts:39,56-59 dan :154,180-183 (assertTenantOwner, uang); edge-people-snapshot.ts:180,354-357: bandingkan di SQL dengan `sql\`statement_timestamp()\`` bukan `new Date()`.
- Tunda (bead lanjutan, jangan ubah): accounting-bank-recon-cases, operations-checklist(+scheduler), inventory-staff-read-model, identity-invitation, platform-usage, order-issues, ai-insights-notify, report-schedule-recipients.
