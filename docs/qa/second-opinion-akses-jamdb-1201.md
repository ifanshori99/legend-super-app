# Second opinion akses #1201: baca izin pakai jam DB

Tanggal: 20 November 2026. Rentang: `git diff c3d5ca1bc...b15c3ac85` (1 commit, 40 berkas). Nomor baris mengacu ke `b15c3ac85`. Review statis read-only: tanpa checkout, tanpa menjalankan test.

## Ringkasan

Inti perbaikan benar. `loadTenantAccessInTransaction` (`permission-resolver.ts:156-180`) sekarang menyaring `role_assignments` di SQL dengan `statement_timestamp()`. Akibatnya assignment yang sudah dicabut atau kedaluwarsa menurut jam DB tidak pernah sampai ke resolver, apa pun jam aplikasinya. Jam app yang masih tersisa di pemanggil hanya bisa menolak lebih banyak, tidak bisa memberi akses lebih. Pengecekan ulang di JS terpotong ke milidetik, dan itu hanya bisa gagal tertutup. Jalur as-of-past pembayaran (`payment-refund.service.ts:339` heldAt dan `payment-refund-approval-limits.ts:542` historical) memakai `includeInactive` dengan benar. Test PAY-04 (`payment-refund-codex-fix.test.ts:1007`) tetap menjaga kasus approver yang perannya berakhir setelah keputusan.

Tidak ada P0, P1, atau P2. Ada lima temuan P3.

## Temuan

### P3-1: Edge, jam tepercaya diganti jam dinding DB lokal
- `apps/api/src/routes/edge.routes.ts:136-150` (`sessionSnapshot`, dipakai `ownerReader` :178 dan `sessionReader` :154), lewat `permission-resolver.ts:372` (`input.clock ?? input.now`).
- Sebelumnya gerbang Owner untuk catalog override memakai `edgeRequestNow` (jam tepercaya monoton dengan high water, legend-10nex). Sekarang `...data` membawa `clock` = `statement_timestamp()` Postgres edge, yaitu jam dinding OS box edge. Nilai ini menimpa jam tepercaya, dan filter SQL juga memakai jam dinding itu.
- Skenario: Owner sementara (`valid_until` = besok) sudah tersalin ke edge. Edge offline, lalu `valid_until` terlewati. Seseorang dengan akses OS memundurkan jam (atau RTC mundur). Owner yang sudah kedaluwarsa masih lolos `ownerReader` dan bisa memberi catalog override. Sebaliknya, kalau RTC mati (1970), Owner sah ditolak di jalur darurat. Middleware umum di edge memang sudah memakai jam dinding sebelum diff ini, jadi dampaknya terbatas pada rute edge.
- Saran: di edge, jangan biarkan `clock` menimpa jam tepercaya. Contohnya `loadTenantAccess(..., { includeInactive: true })` plus `now: edgeRequestNow(req)`, atau opsi `clockOverride`.
- Test: mode edge, jam tepercaya > `valid_until` > jam DB lokal (jam DB dipalsukan mundur). `GET /edge/catalog-override` harus 403.

### P3-2: Umur re-auth createCustomRole dibandingkan lintas jam
- `apps/api/src/services/access.service.ts:530` (`now: data.clock ?? now`) masuk ke `packages/shared/src/access/grants.ts:279-282` (umur `grantorReauthenticatedAt`).
- `session.mfa_verified_at` dicap jam app (`identity-mfa.service.ts:306/334`, `identity-passkey.service.ts:394`), sedangkan `now` sekarang jam DB. Kalau DB di belakang app sejauh d, jendela re-auth 5 menit memanjang sejauh d (bypass umur MFA sebesar skew), dan re-auth yang baru saja dilakukan tertolak (umur negatif) selama d. `updateCustomRole` dan `grantRoleAssignment` sudah memakai jam DB sebelum diff ini, dan pola yang sama diterima di 1194 (Owner). Jadi ini konsistensi, bukan regresi besar.
- Saran: hitung umur re-auth dengan jam yang sama dengan pencapnya (jam app), atau cap `mfa_verified_at` dengan jam DB. Putuskan satu aturan untuk semua jalur re-auth.
- Test: jam app 60 dtk di depan DB, re-auth 5 m 30 dtk lalu (jam app), `POST` custom role berisi izin tambahan harus `REAUTH_REQUIRED`.

### P3-3 (sudah ada sebelum diff, di luar 1201): keputusan approval memakai snapshot sebelum kunci
- `apps/api/src/services/platform-approval.service.ts:1359` (`loadCaller` di transaksi terpisah, sebelum `lockChain` :1408 dan advisory lock :1451) dipakai lagi di `:1492-1500` dan `:1503`.
- Skenario: approver A menunggu kunci chain. Owner mencabut peran A dan commit. A tetap menyetujui dengan peran yang sudah dicabut. Untuk refund, batas di `:1510` memuat ulang data segar, jadi refund aman. Tipe approval lain tidak aman. Diff hanya mengganti `now` menjadi `caller.data.clock` (instan yang kira-kira sama), jadi tidak memperburuk.
- Saran: buat bead terpisah untuk memuat ulang akses caller di `tx` setelah semua kunci (pola offboarding 1183).
- Test: tahan kunci chain, cabut assignment approver, lepaskan. Hasil yang diharapkan 403, tanpa perubahan status.

### P3-4: Pembaca jam app yang masih tersisa
- Tidak ada di daftar tunda brief: `apps/api/src/services/expo.service.ts:352-353` (`liveStaffOfOutlet`, validasi runner, `now` dari `routes/expo.routes.ts:67` `new Date()`). Runner yang baru dicabut masih bisa ditugaskan selama skew. Ini bukan jalur izin aktor, dampaknya rendah.
- Daftar tunda brief (masih jam app, sudah dicatat): `accounting-bank-recon-cases.service.ts:107`, `operations-checklist.service.ts:312-315`, `operations-checklist-scheduler.service.ts:183-184` dan `:271-274`, `inventory-staff-read-model.service.ts:70` dan `:94`, `ai-insights-notify.ts:52-55`, `order-issues.service.ts:313`, `platform-usage.service.ts:134`. Untuk `identity-invitation` dan `report-schedule-recipients`, baris pastinya belum diperiksa.
- Disengaja (as-of tersimpan): `worker/notification-adapters.ts:1255` (`changedAt`), `platform-support.service.ts:1607` (`input.at`).
- Sudah memakai jam DB (OK): `access.service.ts:1030/1167/1528` (readDbClock), `sole-owner-self-approval.ts:43`, `hris-manager-rules.ts:84-85` lewat `hris-employee-manager.service.ts:253`. `canChangeAnyEmployeeManager` (`:76`) masih jam app, tetapi hanya untuk petunjuk UI, dan `loadHrisAccess` tetap memakai `data.clock`.
- Grant support akses (`platform-support.service.ts:1624-1628`) dicap dan dibandingkan sama-sama dengan jam app, jadi konsisten.

### P3-5: Celah cakupan test
- `apps/api/src/test/access-read-db-clock.test.ts:186-597` hanya menguji jam app di BELAKANG DB. Belum ada test untuk (i) jam app di DEPAN DB (grant `valid_from` = DB now harus aktif, dan app tidak boleh mengaktifkan grant yang `valid_from`-nya di masa depan menurut DB), (ii) jalur edge dengan jam tepercaya (P3-1), dan (iii) `open-bill-control.service.ts:627-664` (approver yang dicabut tidak boleh muncul di daftar).
- Saran: tambahkan tiga kasus itu.

## Belum diperiksa
- Pemanggil `loadTenantAccessInTransaction` yang tidak tersentuh diff (staff-override `:809`, device-pin `:231` targetData, pos-acting-staff `:381`) hanya diperiksa lewat pola spread `...data`, belum dibaca satu per satu.
- Isi lengkap test baru belum dibaca dan tidak dijalankan.

## Verdict

**LOLOS** (tidak ada P0/P1/P2; lima temuan P3, P3-1 dan P3-2 disarankan dijadikan bead lanjutan).
