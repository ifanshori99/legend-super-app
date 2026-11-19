# Second opinion akses #1194 — ronde 2

Tanggal: 19 November 2026. Hasil: **Tidak ada temuan P0–P3 baru pada delta 1183. Kedua skenario P1 laporan 1181 tertutup secara statis.** Race registry setelah re-check tetap terbuka sebagai risiko P3 yang sudah diterima CTO (`legend-qdmbp`), bukan temuan baru.

## Rentang dan metode

- `git fetch origin` berhasil. Base `origin/ws/1172-access-audit-guard` tersedia pada `1017da43123b5f1873f2935cb816686c8a402761`; fallback milestone tidak diperlukan.
- Head `origin/ghostex/1183-fix-so1181-akses`: `c3d5ca1bcd6c6dfa7bfff5bd6d853cf8db0ad491`.
- Rentang: `git diff origin/ws/1172-access-audit-guard...origin/ghostex/1183-fix-so1181-akses -- apps/api` (6 berkas; 1.057 penambahan, 22 penghapusan). Nomor baris di bawah mengacu pada head tersebut, bukan checkout utama.
- Konteks ronde 1 dibaca dari `docs/qa/second-opinion-akses-1181.md` di folder utama. Tiga subagent paralel memeriksa offboarding, pergantian Owner, dan cakupan regresi; pemeriksa utama memvalidasi alur serta referensi penting melalui `git show`.
- Fokus: eskalasi akses, izin yang dicabut saat antre, penunjukan Owner tanpa kewenangan, atribusi audit, batas tenant, dan MFA. Beads `legend-ig3dg`, `legend-2n5qj`, dan `legend-qdmbp` dibaca untuk memeriksa keputusan yang berlaku; statusnya tidak diubah.
- Tidak checkout, membuat worktree, mengubah kode, menjalankan layanan/test runtime, atau commit. Satu-satunya berkas yang ditulis adalah laporan ini.

## Status setiap temuan 1181

| Temuan ronde 1 | Status ronde 2 | Bukti pada head 1183 |
| --- | --- | --- |
| P1 — Offboarding memakai `access.role.assign` sebelum kunci (`legend-ig3dg`) | **Tertutup untuk skenario pencabutan saat antre advisory lock.** | `hris-offboarding.service.ts:685` mengambil kunci tenant; `:691` membaca jam DB; `:753` membatasi hasil snapshot awal dengan pembacaan izin terbaru di transaksi yang sama. `hris-access.ts:137` memuat ulang assignment/peran aktor dan memeriksa target tenant memakai waktu tersebut. |
| P1 — Penunjukan/penggantian Owner memakai registry Super Admin sebelum kunci (`legend-2n5qj`) | **Tertutup untuk pencabutan registry yang commit selama antre lock.** Penguncian baris registry sampai commit belum diterapkan; risiko sisanya diterima lewat `legend-qdmbp`. | `platform-tenant-owner.service.ts:542` mengambil lock, `:548` membaca jam DB, `:554` memeriksa `platform_admins.user_id` aktor dengan `revoked_at IS NULL`, dan `:566` memeriksa ulang umur MFA sebelum mutasi. |

## Temuan baru

Tidak ditemukan skenario gagal P0, P1, P2, atau P3 baru yang terkonfirmasi dari penelusuran statis delta ini.

## Bukti perbaikan dan test regresi

- **Offboarding:** `apps/api/src/routes/hris-offboarding.routes.ts:152` meneruskan status MFA dari snapshot server, bukan body klien. `apps/api/src/services/hris-offboarding.service.ts:753` memakai irisan izin awal dan izin terbaru; jalur system tidak dapat memperoleh izin tambahan. Helper memuat data tenant dan aktor yang diberikan server. Kunci tenant yang sama menserialkan perubahan peran/assignment; izin yang dicabut dan commit selama antre tidak dapat dipakai lagi.
- **Test offboarding:** `apps/api/src/test/hris-offboarding-role-assign-lock.test.ts:478` menahan advisory lock, membuktikan request sudah menunggu melalui `pg_locks`, lalu mencabut hanya assignment pemberi `access.role.assign`. Assertion `:501` mengharapkan `409 OFFBOARDING_ADMIN_ROLE`, tanpa perubahan assignment karyawan, sesi, push, status karyawan, audit, outbox, atau clearance. Kontrol izin tetap aktif ada pada `:534`. Shift belum diperiksa langsung oleh test baru.
- **Owner:** Pemeriksaan registry dan MFA yang baru mendahului resolusi akun, grant Owner, penghentian Owner lama, audit sukses, dan outbox. Guard impersonasi serta dukungan read-only tetap berlaku. `mfaFresh` pada `apps/api/src/services/platform-tenant-owner.service.ts:126` tetap menolak nilai tidak valid; pemeriksaan awal `:174` menolak waktu MFA di masa depan terhadap jam aplikasi, sedangkan pemeriksaan pasca-lock `:566` mengulang batas umur lima menit dengan jam DB. Stempel MFA berasal dari server aplikasi, sehingga pemeriksaan kedua sengaja hanya menguji umur.
- **Test Owner:** `apps/api/src/test/platform-tenant-owner-registry-lock.test.ts:287` menguji assign dan `:310` menguji replace setelah registry dicabut saat request terbukti mengantre. Keduanya mengharapkan `403`, tidak ada assignment Owner baru atau audit/outbox sukses; replace mempertahankan Owner lama. Kontrol sukses ada pada `:336` dan `:352`. Test baru tidak memeriksa pengiriman notifikasi eksternal secara langsung.
- **Aktor dan tenant:** Pembacaan ulang offboarding memakai aktor terverifikasi dan data tenant pada transaksi yang sama; audit/event tetap memakai `who`. Jalur Owner memakai `actorUserId` yang sama untuk registry, grant/end, audit (`platform-tenant-owner.service.ts:699`), dan event (`:477`). Delta tidak menambahkan owner ID atau tenant ID yang dapat menggantikan identitas aktor dari body. Tidak ditemukan regresi konkret salah aktor atau lintas tenant.

## Risiko diterima dan usul test lanjutan

- **P3 diterima, belum tertutup — `apps/api/src/services/platform-tenant-owner.service.ts:554`:** Registry dibaca tanpa `FOR SHARE`; akun aplikasi hanya mempunyai hak SELECT sebagaimana dijelaskan pada `:550`. Pencabutan registry melalui DB yang commit **setelah** re-check tetapi **sebelum** commit penunjukan masih dapat berpapasan dengan penunjukan Owner. Ini tepat risiko `legend-qdmbp`, bukan pembukaan ulang skenario antre lock yang sudah diperbaiki. **Usul test saat kartu itu dikerjakan:** Beri penghalang sesudah re-check, cabut registry lewat jalur yang akan berbagi lock, lalu pastikan urutan cabut/penunjukan konsisten dan tidak menghasilkan grant setelah pencabutan yang sudah lebih dahulu selesai.
- **Cakupan MFA belum lengkap — `apps/api/src/test/platform-tenant-owner-registry-lock.test.ts:23`:** Test sengaja melewati MFA kedaluwarsa selama antre. **Usul test:** Kendalikan hasil pembacaan jam DB pasca-lock secara deterministik menjadi lebih dari lima menit setelah verifikasi MFA, sementara pemeriksaan awal masih sah; uji assign dan replace menghasilkan `403`, Owner lama tetap aktif, tanpa assignment, audit sukses, atau event baru. Ini celah cakupan, bukan bypass yang ditemukan pada kode.
- **Rekomendasi waktu dari 1181 tetap belum terverifikasi — `apps/api/src/services/hris-offboarding.service.ts:691`:** Jam DB dibaca setelah advisory lock tetapi sebelum lock baris offboarding (`:698`) dan employee (`:728`); helper baru memakai waktu yang sama (`:761`). Jalur `updateOffboarding` (`:428`) dapat menahan baris tanpa advisory lock tersebut. **Usul test:** Tahan baris, beri assignment aktor `valid_until=T`, pastikan clearance sudah memperoleh advisory lock dan menunggu baris sebelum T, lalu lepaskan sesudah T. Periksa apakah kontrak freshness menuntut penolakan tanpa efek; kasus ini belum dibuktikan runtime dan tidak dihitung sebagai temuan baru. Skenario pencabutan assignment selama antre advisory dari P1 1181 tetap tertutup.

## Batas verifikasi

- Test baru dibaca sebagai bukti cakupan, bukan diklaim lulus pada sesi ini. Tidak menjalankan test, typecheck, build, setup, atau database untuk menjaga review read-only tanpa checkout.
- Penutupan kedua P1 adalah hasil penelusuran statis kode dan assertion regresi, dengan batas risiko registry yang disebutkan di atas; bukan bukti runtime baru.
- `pnpm exec prettier --check docs/qa/second-opinion-akses-1194.md` dan `pnpm exec eslint docs/qa/second-opinion-akses-1194.md` dicoba; keduanya berhenti dengan `MODULE_NOT_FOUND` karena executable pada `node_modules` checkout utama tidak tersedia. Dependensi tidak dipasang atau diubah. Pemeriksaan whitespace laporan melalui `git diff --no-index --check` serta pemeriksaan ulang referensi baris dilakukan terpisah dan lulus.
