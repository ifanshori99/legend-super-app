# WS-01 grant rules (cabang ws/brand-config, lanjutan)

Tingkat K (akses). Aturan acuan: packages/shared/src/access/grants.ts (assertCanEditCustomRole :279-293, topAuthority :211-240), server grant path apps/api/src/services/access.service.ts (~:1004-1081 end/grant, :571-588 update).

## Kartu legend-sjq5w
`createCustomRole` (access.service.ts:414) tidak memanggil assertCanEditCustomRole: manager tanpa izin X bisa membuat role berisi X lewat API langsung. Wajib: pencipta hanya boleh memasukkan izin yang ia pegang di scope tenant (atau semua izin tenant bila Owner/Admin Tenant re-auth segar), kode SELF_ELEVATION_FORBIDDEN 403 seperti update. FE create-role (role-editor-page, mode baru) sudah selaras. Test gagal-dulu lewat HTTP API (apps/api/src/test/): tanpa access.role.manage 403; tenant lain ditolak; izin melebihi milik 403 SELF_ELEVATION_FORBIDDEN; izin yang dipegang boleh 201.

## Kartu legend-wc69d
grant-role-dialog.tsx:277 menawarkan role Owner (dan role berisi izin yang tidak dipegang granter) ke non-Owner. Sembunyikan di UI (helper murni di lib.ts, selaras server). Server: pastikan non-Owner memberi Owner ditolak; test gagal-dulu via API (bila sudah ditolak, cukup test). Test FE node di tests/.

## Aturan
Jangan jalankan tsc/test kecuali pemegang heavy. eslint+prettier file berubah. Tanpa migrasi. Tanpa tampilan baru.
